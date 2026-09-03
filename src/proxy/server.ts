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
  type KeySelection,
  type QuotaErrorSignal,
} from '../router/types.js'
import { buildUpstreamHeaders, extractCacheHeaders } from './header-passthrough.js'
import { isChatCompletionsPath, toResponsesPath, toResponsesRequestBody, toChatCompletion, SseTranslator } from './zen-responses.js'
import { isQuota429, resolveCooldownMs } from './quota-detector.js'
import { parseUsageData } from './response-parser.js'
import { estimateCost } from './rate-card.js'
import { SessionAffinityStore } from './session-affinity.js'

export interface ProxyServerConfig {
  port: number
  upstreamUrl: string
  upstreamUrlZen: string
  requestTimeoutMs: number
  upstreamHungTimeoutMs: number
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
    private notifier: NtfyNotifier = new NtfyNotifier(),
  ) {
    this.config = config
    this.sessionAffinity = new SessionAffinityStore()
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
    let translateZenResponses = false
    let includeUsage = false
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

        // A zen chat/completions request that 500s on its native endpoint may
        // belong to a model only the Responses API can serve (the free
        // contributor models). Retry ONCE in translated form on the SAME key:
        // a protocol switch is not a key failure, so it must not consume a
        // key-failover attempt. The per-model memo makes this a one-time cost
        // per model per process.
        if (upstreamRes.status >= 500 && isZenChatCompletions && !translateZenResponses && requestModel && req.url) {
          const translatedBody = toResponsesRequestBody(body)
          if (translatedBody) {
            requestBody = translatedBody
            req.url = toResponsesPath(req.url)
            translateZenResponses = true
            includeUsage = this.bodyRequestsUsage(body)
            prepared = this.prepareRequest(requestBody, targetPath)
            upstreamRes.body?.cancel().catch(() => {})
            this.logStream.emit(this.logger, 'warn',
              `Zen chat/completions 500 for "${requestModel}" - retrying via /responses on "${key.alias}"`, {
                method: req.method,
                path: targetPath,
                statusCode: 500,
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
            // Only a translated attempt that is not itself a 5xx proves the
            // model needs the Responses endpoint. If it also 5xxes the failure
            // is more likely the key, so the model stays unremembered and the
            // next request starts native again.
            if (translatedRes.status < 500) {
              this.zenResponsesModelMemo.set(requestModel, true)
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
          const circuitState = this.circuitBreaker.recordFailure(key.id)
          this.keyManager.markError(key.id)
          this.keyManager.recordRequest(key.id, {
            statusCode: upstreamRes.status,
            durationMs: duration,
            model: prepared.model,
            sessionId: upstreamSessionId ?? sessionKey ?? null,
            successful: false,
          })
          attemptedKeyIds.add(key.id)

          if (circuitState === CircuitState.OPEN) {
            await this.notifier.circuitTripped(key.alias, key.consecutiveErrors)
            this.logStream.emit(this.logger, 'error', `Circuit breaker OPEN for key "${key.alias}"`, {
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

          if (attempt < maxAttempts - 1) {
            continue
          }
        } else {
          this.circuitBreaker.recordSuccess(key.id)
          key.consecutiveErrors = 0
        }

        const responseHeaders = this.buildResponseHeaders(upstreamRes)
        if (translateZenResponses && upstreamRes.status < 400 && upstreamRes.body) {
          res.writeHead(upstreamRes.status, responseHeaders)
          if (prepared.stream) {
            await this.pipeTranslatedZenStream(upstreamRes.body, res, includeUsage)
          } else {
            const raw = await upstreamRes.clone().text().catch(() => '')
            res.end(toChatCompletion(raw))
          }
        } else {
          res.writeHead(upstreamRes.status, responseHeaders)
          if (upstreamRes.body) {
            await this.pipeResponseBody(upstreamRes.body, res)
          } else {
            res.end()
          }
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

        if (sessionKey) {
          this.sessionAffinity.setPreferredKey(sessionKey, key.id)
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
          upstream: isZenRequest ? 'zen' : 'go',
        })
        return
      } catch (err) {
        if (upstreamHungTimer) clearTimeout(upstreamHungTimer)
        lastError = err instanceof Error ? err.message : String(err)
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
  private async pipeTranslatedZenStream(body: ReadableStream<Uint8Array>, res: http.ServerResponse, includeUsage = false): Promise<void> {
    const reader = body.getReader()
    const translator = new SseTranslator(includeUsage)
    const decoder = new TextDecoder()
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
        const { done, value } = await reader.read()
        if (done) break
        // Normalise CRLF before splitting on \n\n so a \r\n-stream frames the
        // same way as an \n-stream.
        buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
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
    } catch {
      res.end()
    }
  }

  private async pipeResponseBody(body: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
    const reader = body.getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          res.end()
          return
        }
        res.write(value)
      }
    } catch {
      res.end()
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
