# Translation Tripwires Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the Responses→chat-completions SSE translator so any future garbling is caught in the router log next to the turn it broke, with zero behavior change and zero config.

**Architecture:** Counters plus terminal accounting inside `SseTranslator` (the only code that sees both sides of the translation); an anomaly warn emitted by the existing per-attempt block in `server.ts` for completed streams; counters attached to the existing completion log line. No UI, no settings, no new runtime files.

**Tech Stack:** TypeScript strict, Node 22+, existing winston log stream. No new dependencies.

**Spec:** Chat discussion 2026-10-01 (translation-fidelity hypothesis for narrate-without-tool-call stalls; Zen2-direct path works, router translated path stutters). No separate spec doc — this plan IS the spec; executors read this file only.

## Global Constraints

- TypeScript `strict: true`, `target: ES2022`, `module: Node16`. ESM imports use the explicit `.js` extension even when the source is `.ts`.
- The proxy is a byte-for-byte pass-through; translator return values must stay identical. Counting only — never alter, buffer, or reorder frames.
- No new runtime dependencies (project keeps winston, ws, express, two `@opencode-ai/*` packages).
- No code comments unless they capture a non-obvious gotcha.
- Verification = `npm run typecheck` (exit 0) + `npm run build` (exit 0). There is no test suite, linter, or formatter in this repo.
- Never kill or restart the daemon. The user restarts via `./restart-router.sh`; verify with `curl -sf http://127.0.0.1:18904/healthz` afterwards.

---

### Task 1: Instrument `SseTranslator`

**Files:**
- Modify: `src/proxy/zen-responses.ts` (add `TranslatorStats` interface near top; modify class `SseTranslator` lines ~328-446)

**Interfaces:**
- Consumes: nothing new (existing event names: `response.created`, `response.in_progress`, `response.output_item.done`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.output_text.delta`, `response.completed`, `response.incomplete`, `response.failed`, `error`).
- Produces: `export interface TranslatorStats { eventsIn: number; framesOut: number; toolFramesOut: number; unknownEvents: number; parseErrors: number; sawTerminal: boolean; terminalKind: string | null }` and `SseTranslator.stats(): TranslatorStats` (fresh snapshot object per call). Consumed by Task 2.

- [ ] **Step 1: Add the stats interface and storage**

```ts
export interface TranslatorStats {
  eventsIn: number
  framesOut: number
  toolFramesOut: number
  unknownEvents: number
  parseErrors: number
  sawTerminal: boolean
  terminalKind: string | null
}
```

```ts
export class SseTranslator {
  // ... existing fields ...
  private readonly stat: TranslatorStats = {
    eventsIn: 0, framesOut: 0, toolFramesOut: 0,
    unknownEvents: 0, parseErrors: 0,
    sawTerminal: false, terminalKind: null,
  }

  stats(): TranslatorStats {
    return { ...this.stat }
  }
```

- [ ] **Step 2: Split `translate` into counting wrapper plus unchanged inner**

Rename the existing `translate(eventName: string, data: string): string` method to `private translateInner(eventName: string, data: string): string` without changing its body except for the counting hooks in Steps 3-4, then add:

```ts
translate(eventName: string, data: string): string {
  this.stat.eventsIn += 1
  const out = this.translateInner(eventName, data)
  if (out) this.stat.framesOut += (out.match(/^data: /gm) || []).length
  return out
}
```

Frame-count rationale (do not change): `frame()` emits one `data:` line; the `failed`/`error` path emits two (`data: {error}` + `data: [DONE]`); `usageFrame` emits one when usage is present and `''` otherwise. The regex counts exactly the emitted frames.

- [ ] **Step 3: Count parse errors and unknown events in `translateInner`**

In the `catch` around `JSON.parse(data)`, add `this.stat.parseErrors += 1` before `return ''`. In the final fallthrough `return ''` (after the `failed`/`error` branch), add `this.stat.unknownEvents += 1`. No other return value changes.

- [ ] **Step 4: Record terminal events and tool frames in `translateInner`**

In the `response.completed` / `response.incomplete` branch, before the existing `return`, add `this.stat.sawTerminal = true; this.stat.terminalKind = eventName`. In the `response.failed` / `error` branch, before the existing `return`, add the same two lines with `eventName`. On each of the three tool-call emits (`output_item.done` full frame, `output_item.added` opening frame, `arguments.delta` frame) — only on the paths that actually `return this.frame(...)` carrying `tool_calls`, never on the early `return ''` paths — add `this.stat.toolFramesOut += 1`.

- [ ] **Step 5: Verify no behavior change**

Run: `npm run typecheck`
Expected: exit 0 with no output.

Known counting boundary (documented, not fixed): `processEvent` in `server.ts` only forwards events that have both a name AND data (`if (eventName && data)`). A hypothetical terminal event with empty data would not reach the translator and `sawTerminal` would stay false. Widening that gate is out of scope: feeding `''` into `translateInner` would false-positive the parse-error counter, and Responses streams always carry JSON data on named events in practice.

### Task 2: Plumb stats to the log

**Files:**
- Modify: `src/proxy/server.ts` (import line 19; `StreamPipeStats` interface; `pipeTranslatedZenStream` tail returns; per-attempt block after the idle-abort early return; completion `logStream.emit` fields; idle-abort warn left untouched)
- Modify: `AGENTS.md` (mid-stream-stall paragraph, two sentences)

**Interfaces:**
- Consumes: `TranslatorStats` type and `SseTranslator.stats()` from Task 1.
- Produces: `translatedIn` / `translatedOut` / `translatedTools` log fields (number or null) and one `translation anomaly` warn shape. Nothing else consumes them (dashboard Logs page renders log fields generically).

- [ ] **Step 1: Extend the import and `StreamPipeStats`**

Change line 19's import to include the type: `import { isChatCompletionsPath, toResponsesPath, toResponsesRequestBody, toChatCompletion, SseTranslator, type TranslatorStats } from './zen-responses.js'`. Add to the interface: `translate?: TranslatorStats` with no comment (self-explanatory; the native path leaves it absent and log fields render null, exactly like `ttfbMs` does on untranslated turns).

- [ ] **Step 2: Attach translator stats on every translated-pipe exit**

In `pipeTranslatedZenStream`, set `stats.translate = translator.stats()` before each of the three `return stats` statements (normal end after `res.end()`, idle-abort after `res.destroy()`, `catch` after `res.end()`).

- [ ] **Step 3: Emit the anomaly warn for completed streams only**

Placement is load-bearing: insert AFTER the existing idle-abort early-return block (an aborted stream never sees a terminal event by design — checking before it would double-warn every watchdog firing) and BEFORE the `responseTextPromise` usage parsing. Insert:

```ts
const tr = streamStats?.translate
if (tr && (tr.unknownEvents > 0 || tr.parseErrors > 0 || !tr.sawTerminal || tr.terminalKind === 'response.incomplete')) {
  const reason = !tr.sawTerminal
    ? `no terminal event (${tr.eventsIn} in, ${tr.framesOut} out)`
    : tr.terminalKind === 'response.incomplete'
      ? `truncated turn (${tr.toolFramesOut} tool frames in flight)`
      : `unknown=${tr.unknownEvents} parseErrors=${tr.parseErrors}`
  this.logStream.emit(this.logger, 'warn', `${req.method} ${targetPath} -> translation anomaly (${reason})`, {
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
```

- [ ] **Step 4: Attach counters to the normal completion line**

In the completion `logStream.emit` field object (the one carrying `ttfbMs`, `maxIdleGapMs`, `streamChunks`), add `translatedIn: streamStats?.translate?.eventsIn ?? null, translatedOut: streamStats?.translate?.framesOut ?? null, translatedTools: streamStats?.translate?.toolFramesOut ?? null`. No dashboard UI work — fields flow into log detail generically.

- [ ] **Step 5: Document in `AGENTS.md`**

Append to the mid-stream-stall paragraph: `Translated streams also carry translatedIn/Out/Tools counters; any nonzero unknown/parseErrors, a missing terminal event, or an incomplete terminal emits a 'translation anomaly' warn.`

### Task 3: Verify

**Files:** none (scratch probe only, kept out of the repo).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 2: Build and confirm dist**

Run: `npm run build`
Expected: exit 0. Then confirm: `Select-String -Path "dist/proxy/zen-responses.js" -Pattern "translateInner"` returns matches and `Select-String -Path "dist/proxy/server.js" -Pattern "translation anomaly"` returns a match.

- [ ] **Step 3: Synthetic probe of the counters**

PowerShell quoting makes `tsx -e` with inline JSON fragile, so write the probe to a temp file outside the repo (kept out of git) and run it from the repo root (`tsx` is already a dev dependency). Create `C:\Users\reini\AppData\Local\Temp\opencode\tripwire-probe.ts`:

```ts
import { SseTranslator } from 'C:/Users/reini/opencode-go-multi-auth/src/proxy/zen-responses.ts'
const t = new SseTranslator()
t.translate('response.created', JSON.stringify({ response: { id: 'r1', model: 'm' } }))
t.translate('response.foo', '{}')
t.translate('response.output_text.delta', 'not-json')
t.translate('response.function_call_arguments.delta', JSON.stringify({ delta: '{"a":1}', output_index: 0 }))
t.translate('response.completed', JSON.stringify({ response: { status: 'completed' } }))
console.log(JSON.stringify(t.stats()))
```

Run: `npx tsx C:\Users\reini\AppData\Local\Temp\opencode\tripwire-probe.ts`

Expected output: `{"eventsIn":5,"framesOut":4,"toolFramesOut":1,"unknownEvents":1,"parseErrors":1,"sawTerminal":true,"terminalKind":"response.completed"}` — framesOut is 4 (role frame + delta tool frame + finish frame + `[DONE]` line; the unknown and garbage events emit nothing).

- [ ] **Step 4: Live check after user restart**

The user runs `./restart-router.sh` (never restart from here). Then verify: pid in `~/.opencode/router.pid` owns ports 18904/18905 via `Get-NetTCPConnection -LocalPort 18904,18905 -State Listen`, and confirm 2–3 proxied turns carry populated `translatedIn/Out/Tools` with zero anomaly warns on healthy traffic.
