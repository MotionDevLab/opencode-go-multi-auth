import crypto from 'node:crypto'

// CodeAF compat shim: fills the OpenCode-identity signals the Zen free-tier
// gate requires (opencode/ User-Agent, well-formed ses_* session id, bash+read
// tool names) for non-OpenCode clients. Additive-only: never touches `stream`,
// never removes or renames tools, never alters the response. Gated to zen
// paths + `-free` models + a default-off toggle; OpenCode and paid traffic
// pass through byte-identical.

export type HarnessStamp = 'codeaf' | 'openclaude' | 'opencode' | 'unknown'

export interface HarnessRule {
  token: string
  id: Exclude<HarnessStamp, 'unknown'>
  label: string
  blurb: string
}

// First match wins: keep 'opencode/' first. Tokens are matched
// case-insensitively with contains (not startsWith): harnesses ship
// compound UAs and the compat UA itself contains 'codeaf-compat'.
export const HARNESS_RULES: HarnessRule[] = [
  { token: 'opencode/', id: 'opencode', label: 'OpenCode', blurb: 'OpenCode client' },
  { token: 'codeaf', id: 'codeaf', label: 'CodeAF', blurb: 'CodeAF client' },
  { token: 'openclaude', id: 'openclaude', label: 'OpenClaude', blurb: 'OpenClaude client' },
  { token: 'open-claude', id: 'openclaude', label: 'OpenClaude', blurb: 'OpenClaude client' },
]

export function classifyHarness(userAgent: string | undefined): HarnessStamp {
  const ua = (userAgent || '').toLowerCase()
  for (const rule of HARNESS_RULES) {
    if (ua.includes(rule.token)) return rule.id
  }
  return 'unknown'
}

const MAX_UA_LOG_LENGTH = 120

const FREE_MODEL_SUFFIX = '-free'
const USER_AGENT_PREFIX = 'opencode/'
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const SID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const PHANTOM_TOOL_NAMES = ['bash', 'read']

function phantomTool(name: string): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name,
      description: 'Does things.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

function phantomAnthropicTool(name: string): Record<string, unknown> {
  return {
    name,
    description: 'Does things.',
    input_schema: { type: 'object', properties: {} },
  }
}

export function isWellFormedSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

let lastMintTimestamp = 0
let mintCounter = 0

export function mintSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastMintTimestamp) {
    lastMintTimestamp = timestamp
    mintCounter = 0
  }
  mintCounter++
  const mixed = BigInt.asUintN(48, ~(BigInt(timestamp) * 0x1000n + BigInt(mintCounter)))
  const hex = mixed.toString(16).padStart(12, '0')
  const bytes = crypto.randomBytes(14)
  let rand = ''
  for (const b of bytes) rand += SID_ALPHABET.charAt(b % 62)
  return `ses_${hex}${rand}`
}

// Upstream free-tier floor is OpenCode >= 1.18.0 (else 426
// UpgradeRequired); the router's own version does not satisfy it, so the
// shim claims the floor. Bump alongside the gate recipe if upstream moves it.
const COMPAT_USER_AGENT = 'opencode/1.18.0 codeaf-compat'

function toolNames(tools: unknown): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(tools)) return names
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    if (fn && typeof fn.name === 'string') names.add(fn.name)
    if (typeof record.name === 'string') names.add(record.name)
  }
  return names
}

export interface CompatInput {
  enabled: boolean
  targetPath: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  model: string | null
  getShimSessionId: (client: string) => string | undefined
  setShimSessionId: (client: string, sid: string) => void
}

export interface CompatResult {
  body: Buffer
  harness: HarnessStamp
  compatApplied: boolean
  clientUa: string | null
}

function getHeader(headers: CompatInput['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (!value) return undefined
  return Array.isArray(value) ? value[0] : value
}

export function applyCodeafCompat(input: CompatInput): CompatResult {
  const rawUserAgent = getHeader(input.headers, 'user-agent')
  const client = classifyHarness(rawUserAgent)
  const clientUa = rawUserAgent ? rawUserAgent.slice(0, MAX_UA_LOG_LENGTH) : null
  const userAgentOk = client === 'opencode'
  const sessionIdOk = isWellFormedSessionId(getHeader(input.headers, 'x-session-id'))
  // Phantom tool stubs are only ever appended to chat/completions payloads
  // (the only shape probed against the gate); other paths get header fills.
  const toolsEligible = input.targetPath.includes('/chat/completions')
  if (!input.enabled || !input.targetPath.startsWith('/zen/') || !input.model?.endsWith(FREE_MODEL_SUFFIX)) {
    return { body: input.body, harness: client, compatApplied: false, clientUa }
  }
  let filled = false
  if (!userAgentOk) {
    input.headers['user-agent'] = COMPAT_USER_AGENT
    filled = true
  }
  if (!sessionIdOk) {
    let shimSid = input.getShimSessionId(client)
    if (!isWellFormedSessionId(shimSid)) {
      shimSid = mintSessionId()
      input.setShimSessionId(client, shimSid)
    }
    input.headers['x-session-id'] = shimSid
    filled = true
  }
  let body = input.body
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    if (toolsEligible && Array.isArray(json.tools) && json.tools.length > 0) {
      const names = toolNames(json.tools)
      const missing = PHANTOM_TOOL_NAMES.filter((name) => !names.has(name))
      if (missing.length > 0) {
        const openAiShaped = json.tools.some((tool) =>
          tool !== null && typeof tool === 'object' &&
          ('function' in tool || (tool as Record<string, unknown>).type === 'function'))
        const phantoms = missing.map((name) => openAiShaped ? phantomTool(name) : phantomAnthropicTool(name))
        body = Buffer.from(JSON.stringify({ ...json, tools: [...json.tools, ...phantoms] }), 'utf8')
        filled = true
      }
    }
  } catch {
    // Unparseable body: header fills above still stand on their own.
  }
  return { body, harness: client, compatApplied: filled, clientUa }
}
