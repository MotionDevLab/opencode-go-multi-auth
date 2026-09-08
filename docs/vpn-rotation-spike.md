# VPN rotation spike — egress IP control on Windows (2026-09-08)

Why: the per-IP burst bucket is the dominant limiter on heavy days. Keys cover
quota; only a new egress IP clears burst. Goal: scriptable server hop that the
router (or an operator script) can trigger without touching samosa logic —
`localhost:18905` follows the OS default route, so any tunnel change applies.

## Local findings (this machine, 2026-09-08)

- **VyprVPN desktop 5.2.3 installed** (`C:\Program Files (x86)\VyprVPN`), GUI app
  `VyprVPN.exe` + services `VyprVPN`, `VyprVPNWireGuardTunnel` + adapters
  (`VyprWireGuard`, TAP `Local Area Connection`, `Ethernet 2`). Active use
  confirmed: connection log shows same-day hops
  (`lt1 → lv1 → cz1 → lt1.vpn.goldenfrog.com`, WireGuard, 6–13s connects).
- **No CLI surface**: `ServiceManager.exe` with no args only manages services
  (exits `ArgumentException`); control flows through `GoldenFrogIPC.dll`
  (proprietary IPC, no public spec).
- **Live WireGuard config on disk**:
  `C:\ProgramData\Certida LLC\VyprVPN\WG\VyprWireGuard.conf` — standard
  `[Interface]` + `[Peer]` (Address/DNS/Endpoint `IP:51820`,
  `AllowedIPs 0.0.0.0/1 + 128.0.0.0/1`). Rewritten by the app on every
  connect; only the CURRENT server's peer keys are present.
- **Server naming**: `{cc}{n}.vpn.goldenfrog.com` (`lt1`, `lv1`, `cz1`…);
  app fetches 73 locations via authenticated `CallLocationsApi`
  (`api.vyprvpn.com`) — no local server-list cache, no full URLs in logs.
- **Favorites/last servers** in `%LOCALAPPDATA%\Certida_LLC\…\user.config`
  (`lv1;lt1`) — display state only, cannot trigger a connect.
- **Bundled stock OpenVPN**: `OpenVPN\bin\openvpn.exe` + `ca.vyprvpn.com.crt`
  ship with the app, but no user `.ovpn` profiles exist anywhere on disk.
- **Cloudflare WARP**: service `WarpJITSvc` present but `warp-cli.exe` not found
  at the standard path — install state unverified, treat as lead not fact.

## Verdict: paid Vypr usable, but NOT scriptable from local artifacts

Peer `PublicKey`/`PresharedKey` are per-server and provisioned at connect time
via the authenticated Locations API. Hostnames are guessable, keys are not —
so a hand-rolled `wireguard.exe` + `.conf`-per-server setup is **blocked on key
material**, not on tooling. Paths, ranked:

1. **Vypr portal manual configs (decisive 5-min user check).** If the account
   offers `.ovpn`/WireGuard downloads, rotation = stock `openvpn.exe` or
   `wireguard.exe` + profile swap, fully scriptable, paid-IP quality kept.
   Log in → look for manual setup / config download.
2. **Authenticated Locations API reuse (reverse-engineering, fragile).**
   The app already calls it with the paid account's token; sniffing +
   replaying it outside the app breaks ToS-adjacent ground and breaks on app
   updates. Not recommended without explicit need.
3. **GUI automation of VyprVPN.exe** (last resort). Works today (6–13s
   connects) but breaks on every redesign; UIA/AutoHotkey driving the server
   list.
4. **`oplire watch` / WARP** (non-Vypr fallbacks, unchanged from before).

## Ranked options

1. **Manual OpenVPN configs from Vypr account portal** (best if available).
   If the subscription allows `.ovpn` profile downloads, rotation = stock
   `openvpn.exe --config hop.ovpn` managed by a script/Task Scheduler. Zero GUI,
   deterministic, keeps paid-VPN IP quality (better than shared WARP pool).
   **Next step**: log in to the Vypr portal → look for manual setup / config
   download. If absent, this path is dead (Vypr restricted manual configs before).
2. **GUI automation of VyprVPN.exe** (fragile fallback). Drive server switch via
   AutoHotkey/UIA or `ServiceManager.exe` (behavior unknown — probe with
   `/help`/`-h` strings first). Breaks on every app redesign; last resort.
3. **`oplire watch`** (packaged auto-reset). `winget install BerkeOruc.oplire`;
   verifies in 15 min whether it forwards real Zen keys + `/responses`. If yes:
   chain samosa behind it. If no: DeepSeek/Mimo-only, useless for Spark.
4. **Cloudflare WARP vendor path**. Confirm whether WARP is actually installed
   (`warp-cli` on PATH?); shared exit IPs may arrive pre-burned — strictly
   worse IP quality than Vypr, but fully scriptable (`registration delete →
   new → connect`, verify `new_ip != old`).

## Decision needed from operator

- Does the Vypr portal offer manual `.ovpn`/WireGuard configs? (5-minute check,
  decides between options 1 and 2–4.)
- If yes: follow-up build = `scripts/vpn-hop.ps1` (disconnect → swap profile →
  reconnect → verify via `api.ipify.org` → optional ntfy ping) + Task Scheduler
  or dashboard-button trigger. Samosa needs zero changes.

## Constraints (unchanged)

- Rotation is an **egress-layer** concern; the router stays key-layer. No proxy
  code changes for any option above (worst case: a dashboard button that shells
  the hop script).
- `node.exe`/OpenCode must stay inside the tunnel (Vypr Per-App settings);
  Kill Switch will fail in-flight requests during a hop — retry after reconnect.
