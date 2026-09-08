# CONTEXT.md — opencode-go-multi-auth (MotionDevLab fork)

> Short-lived context for anyone (human or agent) working in this repo.
> Deep history lives in the operator's exploration journal, not here.

## 1. What this is

TypeScript proxy + dashboard that pools multiple OpenCode Go/Zen API keys behind
one local endpoint (`:18905`) with automatic failover. Fork of
`samosa-ai-com/opencode-go-multi-auth` — **this fork never talks to upstream**:
no fetch/pull/push/PRs against `samosa-ai-com`. All git I/O via remote `mine`
(`MotionDevLab/opencode-go-multi-auth`).

## 2. Repo map

| Path | Role |
|---|---|
| `src/proxy/server.ts` | Request loop: key select → forward → classify status → failover/breaker |
| `src/proxy/session-affinity.ts` | Sticky pins (session → key), 20-min TTL |
| `src/proxy/quota-detector.ts` | Quota-429 vs burst-429 classification, Retry-After parsing |
| `src/router/circuit-breaker.ts` | Consecutive + window trip, proactive self-cancel timer |
| `src/router/types.ts` | `RouterConfig`, defaults, ranges, tuning validation |
| `src/router/key-manager.ts` | Pool, priorities, cooldowns, display counters |
| `src/dashboard/server.ts` | REST API (`/api/keys`, `/api/failover-tuning`, …) |
| `src/dashboard/public/app.js` | Dashboard UI (cards, tuning panel, logs) |
| `src/storage/*` | `ConfigStore` (tuning), `SecureStore` (keys, encrypted), runtime state |

## 3. Iron rules

- **Build in Git Bash**: `npm run build` ends with Unix `cp -r`; PowerShell fails.
- **Git**: `mine`-only. Branch per feature; PR `mine → mine`.
- **Tuning**: via `PUT /api/failover-tuning` (dashboard). Never hand-edit
  `~/.opencode/router-config.json` except snapshot/restore.
- **Daemon**: Task Scheduler `Open Code Zen Router` (AtLogOn, hidden). Restart via
  stop/start of that task — never run a second bare `node dist/bin.js` beside it.
- **Probes**: `curl.exe` (not bare `curl` — PS alias trap). Logs: `GET /api/logs`.

## 4. Current tuning (failover)

| Knob | Default | Meaning |
|---|---|---|
| Streak trip | 6 (2–10) | Unbroken failure run that opens the breaker |
| Window fails / window | 12 / 300s (3–20 / 60–600s) | N failures in M seconds trips even with 200s between |
| Recovery | 120s (60–900s) | Fallback exile; keep >60s (Retry-After overlap) |
| Self-cancel | 0 = follow Recovery (0 or 30–900s) | Proactive OPEN → half-open timer, no traffic needed |
| Retry-After cap | 5m (60s–60m) | Clamp for upstream-supplied waits |
| Burst-failover | on | Count burst-429s toward the breaker (next-request failover) |

## 5. Failure taxonomy (matches dashboard legend colors)

- 🟢 `2xx` — resets streak (not the window ring).
- 🔴 `5xx` — feeds breaker; exact 500 on Zen chat also triggers `/responses` retry.
- 🟡 burst-429 — feeds breaker iff burst-failover on; returned verbatim (no same-request burn).
- 🟡 quota-429/402 — `markExhausted` + cooldown + same-request failover.
- ⚪ other 4xx (400/403/404 probes) — count-only, breaker-neutral.
- ⚪ transport errors (`statusCode 0`, incl. client disconnect) — counted, never trip.

Breaker states: `closed` → `open` (skipped) → `half-open` (next request probes;
success closes, failure re-trips). Self-cancel timer advances open → half-open
without traffic; re-trips re-arm it.

## 6. Verify ritual

`npm run typecheck` → Git Bash `npm run build` → restart task →
`GET :18904/healthz` + `GET :18904/api/failover-tuning` → `:18905/zen/models`
200 → one `(proxy)` turn, confirm 200 on the tape.

## 7. Roadmap

- **Next big update**: egress IP rotation for the per-IP burst bucket (see
  `docs/vpn-rotation-spike.md`). Keys cover quota; only new egress IP clears burst.
- Deferred: rolling 10-min error rate, burst-vs-quota split counter,
  self-adapting thresholds, transport-error breaker counting.
