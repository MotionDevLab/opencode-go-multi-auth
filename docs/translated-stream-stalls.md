# Translated-stream stalls: diagnosis and remedies

Date: 2026-10-01. Observed on the `/zen` translated path
(`pipeTranslatedZenStream`, Responses SSE → chat-completion chunks),
model `muse-spark-1.3-contributor-free`, Zen upstream, sticky session.

Two distinct stall flavors were seen in production. They look identical
in the UI (session stops producing output) but have different causes and
different remedies. The router log now distinguishes them — read this
before hunting.

## Flavor A: mid-stream silence (transport stall)

**Signature in the log:** `stream stalled (Nms silence), aborted`
(warn), `idleAborted` on the stream stats, client connection destroyed.

**What it is:** chunks flowed (often 100+), then zero bytes for longer
than the watchdog threshold. The 200 headers and partial body are
already committed to the client, so the turn cannot fail over to the
next key — it fails loudly instead. The client is expected to retry.

**Evidence seen:** three aborts in ~7 minutes on one session, all at
`maxIdleGapMs ≈ 100007` — i.e. exactly the then-configured 100 s
threshold, never a natural longer gap. Chunks flowed before each
silence (115–140 chunks), so these were not empty turns.

**Implemented remedy:** `SSE_IDLE_TIMEOUT_MS` env fallback plus the
dashboard-tunable `sseIdleTimeoutMs` (Failover tuning, 0 or 30–900 s,
live-applied, tuning wins over env, 0/0 = off). Shared `readStreamChunk`
helper arms the timer on both the native and translated pipes;
`setTimeout` overflow is clamped to 2³¹−1. Before the watchdog, this
flavor hung forever with zero evidence.

**If implemented later:**
- Consider raising the threshold (was 100 s, since moved to 180 s):
  long model reasoning gaps with zero chunks are indistinguishable
  from a hung stream, so the threshold should stay generous (minutes).
- Per-model thresholds were deliberately not built — no evidence yet
  that stall behavior varies by model. Revisit if the log shows it does.
- A gap histogram (distribution of `maxIdleGapMs` on healthy turns)
  would let the threshold be set from data instead of judgment.
  The fields are already logged; only the aggregation is missing.

## Flavor B: narrate-without-tool-call (model-side stall)

**Signature in the log:** a clean `200` completion with a small output
token count (35–42 tokens seen; 19 tokens in one case),
`translatedTools: 0`, terminal event present, zero anomaly warns.

**What it is:** the model ends its turn after narrating intent
("live proof below", "doing X now") without emitting the tool call.
Transport is innocent: upstream produced text, the router translated
and delivered it, the UI rendered it. The turn completed normally —
there is just no follow-up action. Retries do not help; the next turn
typically does the same thing.

**Evidence seen:** 6/6 investigated stalls resolved to this. The
decisive case: a turn logged `output: 19, translatedTools: 0` with the
narration text visible in the UI and nothing after it.

**How to confirm in one lookup:** find the session's last completion
line. `translatedTools: 0` + small output + terminal present + no
anomaly warn = model-side, stop investigating the proxy.

**If implemented later (all client-side — the router cannot fix this):**
- Nudge the session ("show the proof", "continue"); it usually needs
  just one more turn.
- If it loops (promises, never delivers), break the loop by asking for
  one file or one command at a time.
- If the session is old, start a fresh one — old-session rot is a
  standing suspect, though unproven.
- Never "fix" this with router retries: the turn succeeded, so there
  is nothing to retry at the transport layer.

## The translation tripwires (what proves which flavor)

`SseTranslator` counts per stream: `eventsIn`, `framesOut`,
`toolFramesOut`, `unknownEvents`, `parseErrors`, terminal accounting
(`sawTerminal`, `terminalKind`), and the first 10 distinct unknown
event names (`unknownKinds`). Completed translated streams attach
`translatedIn/Out/Tools` to the completion line (null on native
passthrough turns). A completed stream warns `translation anomaly`
when: nonzero unknown/parseErrors, missing terminal, or an
`response.incomplete` terminal. Idle-aborted streams warn separately
and never double-warn (placement is after the abort early-return).

## Known-benign Responses events (explicit known-noops)

These carry no translatable content and return `''` without counting
as unknown. They were identified from live `unknownKinds` output:

- `response.function_call_arguments.done` (per-call end marker; args
  already streamed via deltas)
- `response.content_part.added` / `response.content_part.done`
- `response.output_text.done`

If a future anomaly names a new event, apply the same test: does the
turn complete with correct tool frames and output? If yes, add it to
the noop branch in `translateInner` (`src/proxy/zen-responses.ts`).
If no, it is a garbling vector — investigate before silencing.

## Watch items (seen once each, not chased)

- `no terminal event (3 in, 1 out)`: a turn ending after 3 events with
  no terminal. Most likely a client-side cancel (only the role frame
  went out). Revisit only if it repeats.
- `processEvent` drops named events with empty data before they reach
  the translator, so a hypothetical data-less terminal would read as
  "no terminal event". Responses streams always carry JSON data on
  named events in practice; widening the gate is out of scope because
  feeding `''` into the translator would false-positive the
  parse-error counter.
