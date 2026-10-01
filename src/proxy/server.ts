import crypto from 'node:crypto'
import http from 'node:http'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { LogStream } from '../logging/log-stream.js'
import type { AppLogger } from '../logging/logger.js'
import { NtfyNotifier } from '../notification/ntfy.js'
import {
  CircuitState,
  RoutingStrategy,
  normalizeRoutingStrategy,
  type ApiKey,
  type FailoverTuning,
  type KeySelection,
  type QuotaErrorSignal,
} from '../router/types.js'
import { buildUpstreamHeaders, extractCacheHeaders } from './header-passthrough.js'
import { isChatCompletionsPath, toResponsesPath, toResponsesRequestBody, toChatCompletion, SseTranslator, type TranslatorStats } from './zen-responses.js'
import { isLocalNetworkOutage, isQuota429, parseRetryAfterHeaderMs, resolveCooldownMs } from './quota-detector.js'
import { parseUsageData } from './response-parser.js'
import { estimateCost } from './rate-card.js'
import { SessionAffinityStore } from './session-affinity.js'

export interface ProxyServerConfig {
  port: number
  upstreamUrl: string
  upstreamUrlZen: string
  requestTimeoutMs: number
  upstreamHungTimeoutMs: number
  sseIdleTimeoutMs: number
  fallbackCooldownMs: number
  keepAliveTimeoutMs: number
  headersTimeoutMs: number
}

interface RequestPreparation {
  body: string | undefined
  model: string | null
  stream: boolean
}

interface RoutingDecision {
  key: ApiKey
  reason: string
  strategy: RoutingStrategy
  selectedBySession: boolean
}

interface StreamPipeStats {
  ttfbMs: number | null
  maxIdleGapMs: number
  chunks: number
  bytes: number
  idleAborted: boolean
  translate?: TranslatorStats
}

// Node setTimeout delays overflow past 2^31-1ms to ~1ms. The dashboard caps
// this value, but the env fallback is unbounded, so clamp before arming.
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647

function buildUpstreamUrl(upstreamUrl: string, requestUrl?: string): string {
  const upstream = new URL(upstreamUrl)
  const incomingPath = requestUrl?.split('?')[0] || '/'
  const basePath = upstream.pathname.replace(/\/+$/, '')
  const needsVersionPrefix = !incomingPath.startsWith('/v1/') && incomingPath !== '/v1'
  const normalizedPath = needsVersionPrefix ? `/v1${incomingPath}` : incomingPath
  const withoutDuplicateVersion = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1')
    ? normalizedPath.slice(3) || '/'
    : normalizedPath
  const upstreamPath = `${basePath}${withoutDuplicateVersion}`
  const search = requestUrl?.includes('?') ? `?${requestUrl.split('?').slice(1).join('?')}` : ''

  return `${upstream.origin}${upstreamPath}${search}`
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (!value) return undefined
  return Array.isArray(value) ? value[0] : value
}

function createProxySessionId(seed: string): string {
  return `router-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

// Encrypted reasoning blobs are bound to the API key that issued them: the
// upstream rejects them with `reasoning encrypted_content was not issued to
// this caller` when they arrive on a different key. After a quota/cooldown
// failover the session history still carries the old key's blobs, which
// wedges the conversation until the user nudges it. Stripping just the
// opaque blobs (text reasoning/summaries are kept) lets the new key continue.
function stripEncryptedContent(body: string | undefined): { body: string | undefined; removed: number } {
  if (!body) return { body, removed: 0 }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { body, removed: 0 }
  }
  let removed = 0
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (Object.hasOwn(record, 'encrypted_content')) {
        delete record.encrypted_content
        removed++
      }
      for (const value of Object.values(record)) walk(value)
    }
  }
  walk(json)
  if (removed === 0) return { body, removed: 0 }
  return { body: JSON.stringify(json), removed }
}

// No request body size limit. The proxy runs on the same machine as
// OpenCode and mirrors its behaviour: OpenCode imposes no limit on
// the request body either. The upstream provider still applies its
// own hard cap (100 MB for the Anthropic Messages API), so anything
// larger than that will be rejected upstream regardless.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

export class ProxyServer {
  private server?: http.Server
  private readonly config: ProxyServerConfig
  private readonly sessionAffinity: SessionAffinityStore
  // Models whose native zen chat/completions route 500s and that therefore
  // must use the Responses API. Learned on the first 500 per model per
  // process; a restart forgets it and re-learns if Zen ever fixes the route.
  private readonly zenResponsesModelMemo = new Map<string, boolean>()

  constructor(
    config: ProxyServerConfig,
    private keyManager: KeyManager,
    private circuitBreaker: CircuitBreaker,
    private quotaTracker: QuotaTracker,
    private logStream: LogStream,
    private logger: AppLogger,
    private getStrategy: () => RoutingStrategy,
    private getTuning: () => FailoverTuning,
    private notifier: NtfyNotifier = new NtfyNotifier(),
    private onAffinityChange?: () => void,
  ) {
    this.config = config
    this.sessionAffinity = new SessionAffinityStore()
  }

  clearSessionAffinity(): void {
    this.sessionAffinity.clear()
    this.onAffinityChange?.()
  }

  loadPersistedAffinity(entries: Array<{ sessionKey: unknown; keyId: unknown; createdAt: unknown }>): void {
    this.sessionAffinity.loadPersisted(entries)
  }

  exportAffinity(): Array<{ sessionKey: string; keyId: string; createdAt: number }> {
    return this.sessionAffinity.exportPersisted()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.keepAliveTimeout = this.config.keepAliveTimeoutMs
      this.server.headersTimeout = this.config.headersTimeoutMs
      this.server.requestTimeout = this.config.requestTimeoutMs > 0
        ? this.config.requestTimeoutMs
        : 0
      this.server.on('error', (err) => reject(err))
      this.server.listen(this.config.port, () => resolve())
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const targetPath = req.url?.split('?')[0] || '/'
    const isZenRequest = targetPath === '/zen' || targetPath.startsWith('/zen/')
    const upstreamUrl = isZenRequest ? this.config.upstreamUrlZen : this.config.upstreamUrl
    const upstream = new URL(upstreamUrl)
    if (isZenRequest && req.url) {
      req.url = req.url.replace(/^\/zen(\/|$)/, '/')
    }
    // Zen's free models are split: some serve only chat/completions (laguna,
    // nemotron), others only the Responses API (the muse contributor models).
    // Unknown models start native and are switched to /responses only when the
    // upstream proves their chat/completions route is dead; a model remembered
    // here is translated up front so it pays no second round trip.
    let translateZenResponses: boolean = false
    let includeUsage: boolean = false
    const headers = req.headers as Record<string, string | string[] | undefined>
    const body = await this.readBody(req)
    if (body === null) {
      // readBody returns null only when the client disconnected or the
      // request stream errored before the body was received. The
      // proxy no longer rejects oversized bodies; the upstream
      // provider's own hard cap (e.g. 100 MB for Anthropic) is the
      // de-facto ceiling.
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Client closed request before body was received' }))
      return
    }

    let requestBody = body
    const isZenChatCompletions = isZenRequest && req.method === 'POST' && req.url && isChatCompletionsPath(req.url.split('?')[0])
    const requestModel = this.extractModelName(body)
    if (isZenChatCompletions && requestModel && req.url && this.zenResponsesModelMemo.has(requestModel)) {
      const translatedBody = toResponsesRequestBody(body)
      if (translatedBody) {
        requestBody = translatedBody
        req.url = toResponsesPath(req.url)
        translateZenResponses = true
        includeUsage = this.bodyRequestsUsage(body)
      }
    }

    let prepared = this.prepareRequest(requestBody, targetPath)
    const cacheHeaders = extractCacheHeaders(headers)
    const sessionKey = this.sessionAffinity.extractSessionKey(headers)
    const upstreamSessionId = getHeader(headers, 'x-session-id')
      ?? (getHeader(headers, 'prompt-cache-key') ? createProxySessionId(getHeader(headers, 'prompt-cache-key')!) : undefined)

    const attemptedKeyIds = new Set<string>()
    // A 5xx that repeats on a second key is a property of the request or the
    // upstream, not of the key: the same body failed the same way with
    // different credentials. Only the first 5xx of a request counts against a
    // key's circuit breaker, so one unroutable model cannot open every breaker
    // in the pool and take healthy keys out of rotation for unrelated traffic.
    let upstreamServerErrorSeen = false
    const totalKeys = this.keyManager.getActiveKeys().length
    const maxAttempts = totalKeys || 1
    let lastError = 'All API keys exhausted'

    const upstreamAbortController = new AbortController()
    let upstreamClientCloseHandler: (() => void) | null = null
    const onClientClose = () => {
      if (!upstreamAbortController.signal.aborted) {
        upstreamAbortController.abort(new Error('client disconnected'))
      }
    }
    if (!res.closed) {
      res.once('close', onClientClose)
      upstreamClientCloseHandler = onClientClose
    } else {
      onClientClose()
    }
    if (this.config.requestTimeoutMs > 0) {
      const requestTimeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
      requestTimeoutSignal.addEventListener('abort', () => {
        if (!upstreamAbortController.signal.aborted) {
          upstreamAbortController.abort(requestTimeoutSignal.reason)
        }
      })
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (upstreamAbortController.signal.aborted) {
        return
      }
      const decision = this.selectKey(sessionKey, attemptedKeyIds)

      if (!decision) {
        if (this.keyManager.getKeys().some((key) => key.enabled)) {
          await this.notifier.allKeysExhausted(this.keyManager.getKeys().filter((key) => key.enabled).length)
        }
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'No active API keys available' }))
        return
      }

      const { key, reason, strategy, selectedBySession } = decision

      // Failover to a different key than the session's warm one: sanitize
      // key-bound encrypted reasoning so the new key can continue the
      // conversation instead of rejecting the whole turn.
      const warmKeyId = sessionKey ? this.sessionAffinity.getPreferredKey(sessionKey) : undefined
      const keySwitched = !!warmKeyId && warmKeyId !== key.id
      if (keySwitched && prepared.body) {
        const stripped = stripEncryptedContent(prepared.body)
        if (stripped.removed > 0) {
          prepared = { ...prepared, body: stripped.body }
          this.logStream.emit(this.logger, 'warn',
            `Key switch to "${key.alias}": stripped ${stripped.removed} encrypted_content block(s) so the new key can continue the session`, {
              method: req.method,
              path: targetPath,
              keyAlias: key.alias,
              keyId: key.id,
              model: prepared.model,
              strategy,
              routeReason: reason,
              sessionId: upstreamSessionId ?? sessionKey ?? null,
            })
        }
      }

      if (!this.circuitBreaker.isAvailable(key.id)) {
        attemptedKeyIds.add(key.id)
        continue
      }

      const upstreamHeaders = buildUpstreamHeaders(headers, key.key, upstream.host)
      Object.assign(upstreamHeaders, cacheHeaders)
      if (upstreamSessionId) {
        upstreamHeaders['x-session-id'] = upstreamSessionId
      }

      const startTime = Date.now()
      let upstreamHungTimer = this.config.upstreamHungTimeoutMs > 0
        ? setTimeout(() => {
            if (!upstreamAbortController.signal.aborted) {
              upstreamAbortController.abort(new Error('upstream hung (no response within UPSTREAM_HUNG_TIMEOUT_MS)'))
            }
          }, this.config.upstreamHungTimeoutMs)
        : undefined

      try {
        const fetchUrl = buildUpstreamUrl(upstreamUrl, req.url)
        let upstreamRes = await fetch(fetchUrl, {
          method: req.method ?? 'GET',
          headers: upstreamHeaders,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? prepared.body : undefined,
          signal: upstreamAbortController.signal,
        })
        if (upstreamHungTimer) clearTimeout(upstreamHungTimer)

        let duration = Date.now() - startTime
        let responseTextPromise = upstreamRes.clone().text().catch(() => '')

        // A zen chat/completions request that fails on its native endpoint may
        // belong to a model only the Responses API can serve (the free
        // contributor models). Retry ONCE in translated form on the SAME key:
        // a protocol switch is not a key failure, so it must not consume a
        // key-failover attempt. The per-model memo makes this a one-time cost
        // per model per process. Two failure modes trigger this: an exact 500
        // (native route dead), or a 400 whose body says the model does not
        // support the protocol (upstream now rejects wrong-protocol calls
        // with 400 instead of 500). 502/503/504 are transient infra failures
        // that fail over to the next key; other 400s pass through verbatim.
        // The message match keeps genuine bad-request 400s (bad params) from
        // paying for a doomed second round trip.
        let zenProtocolMismatch = upstreamRes.status === 500
        if (!zenProtocolMismatch && upstreamRes.status === 400) {
          const errorText = await responseTextPromise
          zenProtocolMismatch = /does not support this protocol/i.test(errorText)
        }
        if (zenProtocolMismatch && isZenChatCompletions && !translateZenResponses && requestModel && req.url) {
          // When this attempt already sanitized for a key switch, translate
          // from the sanitized body so encrypted blobs cannot re-enter via
          // the raw buffer.
          const translationSource = keySwitched && prepared.body ? Buffer.from(prepared.body, 'utf8') : body
          const translatedBody = toResponsesRequestBody(translationSource)
          if (translatedBody) {
            // Per-attempt snapshot: if the translated attempt also fails, the
            // next key must start native again, not inherit the /responses URL.
            const attemptUrl: string = req.url
            const attemptBody: Buffer = requestBody
            const attemptPrepared: RequestPreparation = prepared
            const attemptTranslated: boolean = translateZenResponses
            const attemptIncludeUsage: boolean = includeUsage
            requestBody = translatedBody
            req.url = toResponsesPath(req.url)
            translateZenResponses = true
            includeUsage = this.bodyRequestsUsage(body)
            prepared = this.prepareRequest(requestBody, targetPath)
            upstreamRes.body?.cancel().catch(() => {})
            this.logStream.emit(this.logger, 'info',
              `Zen chat/completions ${upstreamRes.status} for "${requestModel}" - wrong-protocol suspect, translating via /responses on "${key.alias}" (one-time per model per boot)`, {
                method: req.method,
                path: targetPath,
                statusCode: upstreamRes.status,
                keyAlias: key.alias,
                keyId: key.id,
                model: requestModel,
                strategy,
                routeReason: reason,
                upstream: 'zen',
              })
            if (this.config.upstreamHungTimeoutMs > 0) {
              upstreamHungTimer = setTimeout(() => {
                if (!upstreamAbortController.signal.aborted) {
                  upstreamAbortController.abort(new Error('upstream hung (no response within UPSTREAM_HUNG_TIMEOUT_MS)'))
                }
              }, this.config.upstreamHungTimeoutMs)
            }
            const translatedFetchUrl = buildUpstreamUrl(upstreamUrl, req.url)
            const translatedRes = await fetch(translatedFetchUrl, {
              method: req.method ?? 'GET',
              headers: upstreamHeaders,
              body: req.method !== 'GET' && req.method !== 'HEAD' ? prepared.body : undefined,
              signal: upstreamAbortController.signal,
            })
            if (upstreamHungTimer) clearTimeout(upstreamHungTimer)
            // Only a translated 2xx proves the model needs the Responses
            // endpoint. A 4xx (translation bug, bad key, quota) or a further
            // 5xx must not pin the model: the next request starts native
            // again. On a 5xx the per-attempt state is restored so the next
            // key is tried natively, not forced down the translated path.
            if (translatedRes.ok) {
              this.zenResponsesModelMemo.set(requestModel, true)
            } else if (translatedRes.status >= 500) {
              req.url = attemptUrl
              requestBody = attemptBody
              prepared = attemptPrepared
              translateZenResponses = attemptTranslated
              includeUsage = attemptIncludeUsage
            }
            upstreamRes = translatedRes
            duration = Date.now() - startTime
            responseTextPromise = translatedRes.clone().text().catch(() => '')
          }
        }

        if (upstreamRes.status === 402 || upstreamRes.status === 429) {
          const responseBody = await responseTextPromise
          const isQuota = isQuota429(upstreamRes.status, Object.fromEntries(upstreamRes.headers), responseBody)
          if (isQuota) {
            const remainingKeys = this.keyManager.getActiveKeys().filter((entry) => entry.id !== key.id && !attemptedKeyIds.has(entry.id)).length
            const now = Date.now()
            const headerCooldownMs = resolveCooldownMs(Object.fromEntries(upstreamRes.headers), responseBody, now, this.config.fallbackCooldownMs)
            const resetAt = now + headerCooldownMs
            const signal: QuotaErrorSignal = {
              statusCode: upstreamRes.status,
              occurredAt: now,
              cooldownMs: headerCooldownMs,
              resetAt,
              message: this.extractQuotaMessage(responseBody, upstreamRes.status),
            }
            this.keyManager.markExhausted(key.id, headerCooldownMs, signal)
            this.circuitBreaker.recordFailure(key.id)
            this.keyManager.markError(key.id)
            this.keyManager.recordRequest(key.id, {
              statusCode: upstreamRes.status,
              durationMs: duration,
              model: prepared.model,
              sessionId: upstreamSessionId ?? sessionKey ?? null,
              successful: false,
            })
            attemptedKeyIds.add(key.id)

            const cooldownHours = (headerCooldownMs / 3_600_000).toFixed(1)
            await this.notifier.keyExhausted(key.alias, upstreamRes.status, remainingKeys)
            this.logStream.emit(
              this.logger,
              'warn',
              `Key "${key.alias}" quota exhausted (HTTP ${upstreamRes.status}), cooldown ${cooldownHours}h, failing over`,
              {
                method: req.method,
                path: targetPath,
                statusCode: upstreamRes.status,
                keyAlias: key.alias,
                keyId: key.id,
                duration,
                model: prepared.model,
                strategy,
                routeReason: reason,
                selectedBySession,
                sessionId: upstreamSessionId ?? sessionKey ?? null,
                cooldownMs: headerCooldownMs,
                quotaError: signal,
                attempt: attempt + 1,
                upstream: isZenRequest ? 'zen' : 'go',
              },
            )

            if (remainingKeys === 0) {
              await this.notifier.allKeysExhausted(this.keyManager.getKeys().filter((entry) => entry.enabled).length)
            }
            continue
          }
        }

        if (upstreamRes.status >= 500) {
          const repeatedServerError = upstreamServerErrorSeen
          upstreamServerErrorSeen = true
          const circuitState = repeatedServerError
            ? this.circuitBreaker.getState(key.id)
            : this.circuitBreaker.recordFailure(key.id)
          if (!repeatedServerError) {
            this.keyManager.markError(key.id)
          }
          this.keyManager.recordRequest(key.id, {
            statusCode: upstreamRes.status,
            durationMs: duration,
            model: prepared.model,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            successful: false,
          })
          attemptedKeyIds.add(key.id)

          if (circuitState === CircuitState.OPEN) {
            await this.emitCircuitOpen(key, req.method, upstreamRes.status, targetPath, prepared.model, strategy, reason, isZenRequest)
          }

          if (attempt < maxAttempts - 1) {
            continue
          }
        } else if (upstreamRes.status === 429 || upstreamRes.status === 402) {
          // Non-quota 429/402 (quota positives `continue` above): burst or
          // transient rate limiting. The 429 is still returned verbatim —
          // no same-request key-burning — but with burst-failover on the key
          // feeds the breaker so the NEXT request fails over.
          if (this.getTuning().burstFailoverEnabled) {
            const recoveryOverride = this.resolveBurstRecoveryMs(upstreamRes.headers)
            const circuitState = this.circuitBreaker.recordFailure(key.id, recoveryOverride)
            this.keyManager.markError(key.id)
            if (circuitState === CircuitState.OPEN) {
              await this.emitCircuitOpen(key, req.method, upstreamRes.status, targetPath, prepared.model, strategy, reason, isZenRequest)
            }
          }
        } else if (upstreamRes.status < 400) {
          const recovered = this.circuitBreaker.recordSuccess(key.id)
          key.consecutiveErrors = 0
          if (recovered) {
            await this.notifier.circuitRecovered(key.alias)
            this.logStream.emit(this.logger, 'info', `Circuit breaker CLOSED for key "${key.alias}" (probe succeeded)`, {
              method: req.method,
              path: targetPath,
              keyAlias: key.alias,
              keyId: key.id,
              statusCode: upstreamRes.status,
              model: prepared.model,
              strategy,
              routeReason: reason,
              upstream: isZenRequest ? 'zen' : 'go',
            })
          }
        }
        // Other 4xx (400, 403, 404 probes, …) are count-only via the tail
        // recordRequest below: they say nothing about key health, so they
        // neither feed nor reset the breaker.

        const responseHeaders = this.buildResponseHeaders(upstreamRes)
        let streamStats: StreamPipeStats | null = null
        const tuning = this.getTuning()
        const idleTimeoutMs = tuning.sseIdleTimeoutMs > 0
          ? tuning.sseIdleTimeoutMs
          : this.config.sseIdleTimeoutMs
        const abortStream = (reason: Error) => {
          if (!upstreamAbortController.signal.aborted) upstreamAbortController.abort(reason)
        }
        if (translateZenResponses && upstreamRes.status < 400 && upstreamRes.body) {
          res.writeHead(upstreamRes.status, responseHeaders)
          if (prepared.stream) {
            streamStats = await this.pipeTranslatedZenStream(upstreamRes.body, res, includeUsage, idleTimeoutMs, abortStream)
          } else {
            const translatedBody = await responseTextPromise
            res.end(toChatCompletion(translatedBody))
            responseTextPromise = Promise.resolve(translatedBody)
          }
        } else {
          res.writeHead(upstreamRes.status, responseHeaders)
          if (upstreamRes.body) {
            streamStats = await this.pipeResponseBody(
              upstreamRes.body,
              res,
              idleTimeoutMs,
              abortStream,
            )
          } else {
            res.end()
          }
        }

        if (streamStats?.idleAborted) {
          // The 200 headers and partial body are already committed to the
          // client, so unlike a pre-response 5xx this must not fail over to
          // the next key — a second response cannot follow the first on the
          // same stream. Fail this turn loudly instead.
          this.circuitBreaker.recordFailure(key.id)
          this.keyManager.markError(key.id)
          this.keyManager.recordRequest(key.id, {
            statusCode: upstreamRes.status,
            durationMs: Date.now() - startTime,
            model: prepared.model,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            successful: false,
          })
          attemptedKeyIds.add(key.id)
          this.logStream.emit(this.logger, 'warn', `${req.method} ${targetPath} -> stream stalled (${streamStats.maxIdleGapMs}ms silence), aborted`, {
            method: req.method,
            path: targetPath,
            statusCode: upstreamRes.status,
            keyAlias: key.alias,
            keyId: key.id,
            duration: Date.now() - startTime,
            ttfbMs: streamStats.ttfbMs,
            maxIdleGapMs: streamStats.maxIdleGapMs,
            streamChunks: streamStats.chunks,
            model: prepared.model,
            strategy,
            routeReason: reason,
            selectedBySession,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            upstream: isZenRequest ? 'zen' : 'go',
          })
          return
        }

        const tr = streamStats?.translate
        if (tr && (tr.unknownEvents > 0 || tr.parseErrors > 0 || !tr.sawTerminal || tr.terminalKind === 'response.incomplete')) {
          const anomalyReason = !tr.sawTerminal
            ? `no terminal event (${tr.eventsIn} in, ${tr.framesOut} out)`
            : tr.terminalKind === 'response.incomplete'
              ? `truncated turn (${tr.toolFramesOut} tool frames in flight)`
              : `unknown=${tr.unknownEvents} parseErrors=${tr.parseErrors}`
          this.logStream.emit(this.logger, 'warn', `${req.method} ${targetPath} -> translation anomaly (${anomalyReason})`, {
            method: req.method,
            path: targetPath,
            statusCode: upstreamRes.status,
            keyAlias: key.alias,
            keyId: key.id,
            model: prepared.model,
            strategy,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            upstream: isZenRequest ? 'zen' : 'go',
            translatedIn: tr.eventsIn,
            translatedOut: tr.framesOut,
            translatedTools: tr.toolFramesOut,
          })
        }

        const responseBody = await responseTextPromise
        const usageData = parseUsageData(responseBody, prepared.model ?? undefined)
        const tokens = usageData?.tokens ?? null
        let cost: number | null = tokens ? (usageData?.cost ?? null) : null
        let costEstimated = false
        if (tokens && cost == null) {
          const estimated = estimateCost(prepared.model, tokens)
          if (estimated != null) {
            cost = estimated
            costEstimated = true
          }
        }
        if (tokens) {
          this.quotaTracker.recordUsage(key.id, tokens, cost)
        }

        this.keyManager.recordRequest(key.id, {
          statusCode: upstreamRes.status,
          durationMs: duration,
          model: prepared.model,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          successful: upstreamRes.status < 400,
        })

        if (sessionKey && upstreamRes.status < 400) {
          this.sessionAffinity.setPreferredKey(sessionKey, key.id)
          this.onAffinityChange?.()
        }

        const level = upstreamRes.status >= 500 ? 'error' : upstreamRes.status >= 400 ? 'warn' : 'info'
        this.logStream.emit(this.logger, level, `${req.method} ${targetPath} -> ${upstreamRes.status}`, {
          method: req.method,
          path: targetPath,
          statusCode: upstreamRes.status,
          keyAlias: key.alias,
          keyId: key.id,
          duration,
          model: prepared.model,
          strategy,
          routeReason: reason,
          selectedBySession,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          tokens: tokens || null,
          cost,
          costEstimated,
          ttfbMs: streamStats?.ttfbMs ?? null,
          maxIdleGapMs: streamStats?.maxIdleGapMs ?? null,
          streamChunks: streamStats?.chunks ?? null,
          translatedIn: streamStats?.translate?.eventsIn ?? null,
          translatedOut: streamStats?.translate?.framesOut ?? null,
          translatedTools: streamStats?.translate?.toolFramesOut ?? null,
          upstream: isZenRequest ? 'zen' : 'go',
        })
        return
      } catch (err) {
        if (upstreamHungTimer) clearTimeout(upstreamHungTimer)
        lastError = err instanceof Error ? err.message : String(err)
        // Local network outage (DNS down, no route, Wi-Fi off): the fetch
        // never left the machine, so this says nothing about the key or the
        // upstream. Count it (honest REQ/ERR) but burn NOTHING — no breaker
        // feed, no window entry, no failover consumption — and fail fast with
        // a distinct message instead of cycling all keys against a dead NIC.
        if (isLocalNetworkOutage(err)) {
          this.keyManager.recordRequest(key.id, {
            statusCode: 0,
            durationMs: Date.now() - startTime,
            model: prepared.model,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            successful: false,
          })
          lastError = `local network unreachable (${lastError}) — check Wi-Fi/VPN, keys untouched`
          this.logStream.emit(this.logger, 'warn', `Local network unreachable, key "${key.alias}" untouched`, {
            method: req.method,
            path: targetPath,
            keyAlias: key.alias,
            keyId: key.id,
            model: prepared.model,
            strategy,
            routeReason: reason,
            upstream: isZenRequest ? 'zen' : 'go',
            localOutage: true,
          })
          if (upstreamClientCloseHandler) {
            res.removeListener('close', upstreamClientCloseHandler)
          }
          if (!upstreamAbortController.signal.aborted) {
            upstreamAbortController.abort()
          }
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'Local network unreachable — check Wi-Fi/VPN. No keys were burned.', detail: lastError }))
          return
        }
        this.keyManager.recordRequest(key.id, {
          statusCode: 0,
          durationMs: Date.now() - startTime,
          model: prepared.model,
          sessionId: upstreamSessionId ?? sessionKey ?? null,
          successful: false,
        })
        attemptedKeyIds.add(key.id)
        this.logStream.emit(this.logger, 'error', `Upstream error for key "${key.alias}": ${lastError}`, {
          method: req.method,
          path: targetPath,
          keyAlias: key.alias,
          keyId: key.id,
          model: prepared.model,
          strategy,
          routeReason: reason,
          upstream: isZenRequest ? 'zen' : 'go',
        })
      }
    }

    if (upstreamClientCloseHandler) {
      res.removeListener('close', upstreamClientCloseHandler)
    }
    if (!upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort()
    }

    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'All API keys failed', detail: lastError }))
  }

  private async emitCircuitOpen(
    key: ApiKey,
    method: string | undefined,
    statusCode: number,
    targetPath: string,
    model: string | null,
    strategy: RoutingStrategy,
    reason: string,
    isZenRequest: boolean,
  ): Promise<void> {
    const failures = Math.max(
      this.circuitBreaker.getConsecutiveErrors(key.id),
      this.circuitBreaker.getWindowFailureCount(key.id),
    )
    await this.notifier.circuitTripped(key.alias, failures)
    this.logStream.emit(this.logger, 'error', `Circuit breaker OPEN for key "${key.alias}"`, {
      method,
      path: targetPath,
      keyAlias: key.alias,
      keyId: key.id,
      statusCode,
      model,
      strategy,
      routeReason: reason,
      upstream: isZenRequest ? 'zen' : 'go',
    })
  }

  private resolveBurstRecoveryMs(headers: Headers): number | null {
    const tuning = this.getTuning()
    if (!tuning.honorRetryAfter) return null
    const headerMs = parseRetryAfterHeaderMs(Object.fromEntries(headers), Date.now())
    if (headerMs === null) return null
    return Math.min(Math.max(headerMs, tuning.circuitBreakerRecoveryMs), tuning.retryAfterCapMs)
  }

  private selectKey(sessionKey: string | undefined, attemptedKeyIds: Set<string>): RoutingDecision | null {
    const strategy = normalizeRoutingStrategy(this.getStrategy())

    if (sessionKey) {
      const preferredId = this.sessionAffinity.getPreferredKey(sessionKey)
      if (preferredId && !attemptedKeyIds.has(preferredId)) {
        const preferredKey = this.keyManager.getKeyById(preferredId)
        if (preferredKey && preferredKey.enabled && preferredKey.status === 'active' && this.circuitBreaker.isAvailable(preferredId)) {
          return {
            key: preferredKey,
            reason: `Sticky session reused warm account ${preferredKey.alias}.`,
            strategy,
            selectedBySession: true,
          }
        }
      }
    }

    const selection = this.keyManager.getNextKey(strategy, {
      excludeKeyIds: attemptedKeyIds,
    })
    if (!selection) return null

    return {
      key: selection.key,
      reason: selection.reason,
      strategy,
      selectedBySession: false,
    }
  }

  private extractQuotaMessage(bodyText: string, statusCode: number): string {
    try {
      const json = JSON.parse(bodyText)
      const error = (json && typeof json === 'object' ? json.error : null) ?? json
      if (error && typeof error === 'object') {
        const code = typeof error.code === 'string' ? error.code : ''
        const type = typeof error.type === 'string' ? error.type : ''
        const message = typeof error.message === 'string' ? error.message : ''
        const parts = [code, type, message].filter(Boolean)
        if (parts.length > 0) return parts.join(' · ')
      }
    } catch {
      // fall through
    }
    return `HTTP ${statusCode}`
  }

  private prepareRequest(body: Buffer, targetPath: string): RequestPreparation {
    if (!body.length) {
      return { body: undefined, model: null, stream: false }
    }

    const raw = body.toString('utf8')
    try {
      const json = JSON.parse(raw)
      const model = typeof json?.model === 'string' ? json.model : null
      const stream = Boolean(json?.stream)

      if ((targetPath === '/chat/completions' || targetPath === '/v1/chat/completions') && stream && json && typeof json === 'object') {
        const streamOptions = typeof json.stream_options === 'object' && json.stream_options !== null
          ? json.stream_options as Record<string, unknown>
          : {}
        json.stream_options = { ...streamOptions, include_usage: true }
        return {
          body: JSON.stringify(json),
          model,
          stream,
        }
      }

      return { body: raw, model, stream }
    } catch {
      return { body: raw, model: null, stream: false }
    }
  }

  // Whether the caller opted into usage reporting on a streaming request.
  // The translated Responses request does not carry stream_options, so the
  // original chat/completions body is the only place this signal survives.
  private bodyRequestsUsage(body: Buffer): boolean {
    try {
      const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      return Boolean(typeof json.stream_options === 'object' && json.stream_options && (json.stream_options as Record<string, unknown>).include_usage)
    } catch {
      return false
    }
  }

  private extractModelName(body: Buffer): string | null {
    try {
      const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      return typeof json.model === 'string' && json.model.length > 0 ? json.model : null
    } catch {
      return null
    }
  }

  private buildResponseHeaders(upstreamRes: Response): Record<string, string> {
    const responseHeaders: Record<string, string> = {}
    upstreamRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (
        !HOP_BY_HOP.has(lower) &&
        lower !== 'transfer-encoding' &&
        lower !== 'content-encoding' &&
        lower !== 'content-length'
      ) {
        responseHeaders[key] = value
      }
    })
    return responseHeaders
  }

  /** Pipe a Zen Responses SSE stream to the client as chat.completion.chunk frames. */
  private async pipeTranslatedZenStream(
    body: ReadableStream<Uint8Array>,
    res: http.ServerResponse,
    includeUsage = false,
    idleTimeoutMs = 0,
    abortUpstream?: (reason: Error) => void,
  ): Promise<StreamPipeStats> {
    const stats: StreamPipeStats = { ttfbMs: null, maxIdleGapMs: 0, chunks: 0, bytes: 0, idleAborted: false }
    const reader = body.getReader()
    const translator = new SseTranslator(includeUsage)
    const decoder = new TextDecoder()
    const startedAt = Date.now()
    let lastChunkAt = startedAt
    let buffered = ''

    const processEvent = (rawEvent: string) => {
      let eventName = ''
      const dataLines: string[] = []
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      // Multiple data: lines in one event are concatenated with '\n' per the
      // SSE spec; a JSON payload split across lines reconstructs correctly.
      const data = dataLines.join('\n')
      if (eventName && data) {
        const out = translator.translate(eventName, data)
        if (out) res.write(out)
      }
    }

    const processBuffer = () => {
      let boundary = buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        processEvent(rawEvent)
        boundary = buffered.indexOf('\n\n')
      }
    }

    try {
      while (true) {
        const chunk = await this.readStreamChunk(reader, idleTimeoutMs)
        if (chunk.timedOut) {
          stats.idleAborted = true
          stats.maxIdleGapMs = Date.now() - lastChunkAt
          await reader.cancel().catch(() => {})
          abortUpstream?.(new Error(`SSE stream idle for ${idleTimeoutMs}ms`))
          res.destroy()
          stats.translate = translator.stats()
          return stats
        }
        if (chunk.done) break
        const now = Date.now()
        if (stats.chunks === 0) stats.ttfbMs = now - startedAt
        stats.maxIdleGapMs = Math.max(stats.maxIdleGapMs, now - lastChunkAt)
        lastChunkAt = now
        stats.chunks += 1
        stats.bytes += chunk.value?.byteLength ?? 0
        // Normalise CRLF before splitting on \n\n so a \r\n-stream frames the
        // same way as an \n-stream.
        buffered += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true }).replace(/\r\n/g, '\n')
        processBuffer()
      }
      // Flush any remaining multi-byte sequence from the decoder, then treat
      // whatever is still in the buffer (no trailing blank line) as a final
      // event. A response.completed that arrives at stream end without \n\n
      // would otherwise be silently dropped, leaving the client without
      // finish_reason or [DONE].
      buffered += decoder.decode()
      processBuffer()
      if (buffered.trim()) processEvent(buffered)
      res.end()
      stats.translate = translator.stats()
      return stats
    } catch {
      res.end()
      stats.translate = translator.stats()
      return stats
    }
  }

  // A locked reader allows only one pending read, so an idle timeout must
  // cancel the in-flight read before returning rather than racing past it.
  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    idleTimeoutMs: number,
  ): Promise<{ timedOut: true } | { timedOut: false; done: boolean; value?: Uint8Array }> {
    if (idleTimeoutMs <= 0) {
      const result = await reader.read()
      return result.done
        ? { timedOut: false, done: true }
        : { timedOut: false, done: false, value: result.value }
    }
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        reader.read().then((result): { timedOut: false; done: boolean; value?: Uint8Array } => result.done
          ? { timedOut: false, done: true }
          : { timedOut: false, done: false, value: result.value }),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), Math.min(idleTimeoutMs, MAX_TIMEOUT_DELAY_MS))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async pipeResponseBody(
    body: ReadableStream<Uint8Array>,
    res: http.ServerResponse,
    idleTimeoutMs = 0,
    abortUpstream?: (reason: Error) => void,
  ): Promise<StreamPipeStats> {
    const stats: StreamPipeStats = { ttfbMs: null, maxIdleGapMs: 0, chunks: 0, bytes: 0, idleAborted: false }
    const reader = body.getReader()
    const startedAt = Date.now()
    let lastChunkAt = startedAt

    try {
      while (true) {
        const chunk = await this.readStreamChunk(reader, idleTimeoutMs)
        if (chunk.timedOut) {
          stats.idleAborted = true
          stats.maxIdleGapMs = Date.now() - lastChunkAt
          await reader.cancel().catch(() => {})
          abortUpstream?.(new Error(`SSE stream idle for ${idleTimeoutMs}ms`))
          res.destroy()
          return stats
        }
        if (chunk.done) {
          res.end()
          return stats
        }
        const now = Date.now()
        if (stats.chunks === 0) stats.ttfbMs = now - startedAt
        stats.maxIdleGapMs = Math.max(stats.maxIdleGapMs, now - lastChunkAt)
        lastChunkAt = now
        stats.chunks += 1
        stats.bytes += chunk.value?.byteLength ?? 0
        try {
          res.write(chunk.value)
        } catch {
          await reader.cancel().catch(() => {})
          return stats
        }
      }
    } catch {
      res.end()
      return stats
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      const finish = (value: Buffer | null) => {
        if (settled) return
        settled = true
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        req.removeListener('aborted', onAborted)
        req.removeListener('close', onClose)
        resolve(value)
      }
      const onData = (chunk: Buffer) => {
        total += chunk.length
        chunks.push(chunk)
      }
      const onEnd = () => finish(Buffer.concat(chunks))
      const onError = () => finish(null)
      const onAborted = () => finish(null)
      const onClose = () => finish(total > 0 ? Buffer.concat(chunks) : null)
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      req.on('close', onClose)
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}
