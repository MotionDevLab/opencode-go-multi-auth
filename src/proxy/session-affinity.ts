const SESSION_TTL_MS = 20 * 60 * 1000
const MAX_ENTRIES = 512

interface SessionEntry {
  keyId: string
  createdAt: number
}

export class SessionAffinityStore {
  private sessions: Map<string, SessionEntry> = new Map()

  getPreferredKey(sessionKey: string): string | undefined {
    const entry = this.sessions.get(sessionKey)
    if (!entry) return undefined

    const age = Date.now() - entry.createdAt
    if (age > SESSION_TTL_MS) {
      this.sessions.delete(sessionKey)
      return undefined
    }
    return entry.keyId
  }

  setPreferredKey(sessionKey: string, keyId: string): void {
    if (this.sessions.size >= MAX_ENTRIES) {
      const oldest = this.sessions.entries().next()
      if (oldest.value) {
        this.sessions.delete(oldest.value[0])
      }
    }
    this.sessions.set(sessionKey, { keyId, createdAt: Date.now() })
  }

  clear(): void {
    this.sessions.clear()
  }

  loadPersisted(entries: Array<{ sessionKey: unknown; keyId: unknown; createdAt: unknown }>): void {
    const now = Date.now()
    for (const entry of entries) {
      if (typeof entry.sessionKey !== 'string' || !entry.sessionKey) continue
      if (typeof entry.keyId !== 'string' || !entry.keyId) continue
      if (typeof entry.createdAt !== 'number' || now - entry.createdAt > SESSION_TTL_MS) continue
      if (this.sessions.size >= MAX_ENTRIES) break
      this.sessions.set(entry.sessionKey, { keyId: entry.keyId, createdAt: entry.createdAt })
    }
  }

  exportPersisted(): Array<{ sessionKey: string; keyId: string; createdAt: number }> {
    const now = Date.now()
    const out: Array<{ sessionKey: string; keyId: string; createdAt: number }> = []
    for (const [sessionKey, entry] of this.sessions) {
      if (now - entry.createdAt > SESSION_TTL_MS) continue
      out.push({ sessionKey, keyId: entry.keyId, createdAt: entry.createdAt })
    }
    return out
  }

  extractSessionKey(headers: Record<string, string | string[] | undefined>): string | undefined {
    const sessionId = this.getHeader(headers, 'x-session-id')
    if (sessionId) return sessionId

    // opencode always sends x-opencode-session for custom providers; without
    // this the store never sticks and every turn can rotate keys, which
    // breaks key-bound encrypted reasoning mid-conversation.
    const opencodeSession = this.getHeader(headers, 'x-opencode-session')
    if (opencodeSession) return opencodeSession

    const promptKey = this.getHeader(headers, 'prompt-cache-key')
    if (promptKey) return promptKey

    const promptKeyUnderscore = this.getHeader(headers, 'prompt_cache_key')
    if (promptKeyUnderscore) return promptKeyUnderscore

    const cacheControl = this.getHeader(headers, 'cache_control')
    if (cacheControl) return cacheControl

    return undefined
  }

  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()]
    if (!val) return undefined
    return Array.isArray(val) ? val[0] : val
  }
}
