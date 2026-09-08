# VPN rotation spike — egress IP control on Windows (2026-09-08)

Why: the per-IP burst bucket is the dominant limiter on heavy days. Keys cover
quota; only a new egress IP clears burst. Goal: scriptable server hop that the
router (or an operator script) can trigger without touching samosa logic —
`localhost:18905` follows the OS default route, so any tunnel change applies.

## Local findings (this machine)

- **VyprVPN desktop installed** (`C:\Program Files (x86)\VyprVPN`), GUI app
  `VyprVPN.exe` + services `VyprVPN`, `VyprVPNWireGuardTunnel` + adapters
  (`VyprWireGuard`, TAP `Local Area Connection`, `Ethernet 2`).
- **No CLI surface found**: no `vyprvpn.exe --help`-style binary; `ServiceManager.exe`
  exists but is undocumented; control flows through `GoldenFrogIPC.dll`
  (proprietary IPC, no public spec).
- **Bundled stock OpenVPN**: `OpenVPN\bin\openvpn.exe` + libs ship with the app,
  plus `OpenVPN\Certs\ca.vyprvpn.com.crt`. No user `.ovpn` profiles on disk;
  no `%APPDATA%/LOCALAPPDATA%\VyprVPN` config dirs.
- **Cloudflare WARP**: service `WarpJITSvc` present but `warp-cli.exe` not found
  at the standard path — install state unverified, treat as lead not fact.

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
  decides between options 1 and 2/3.)
- If yes: follow-up build = `scripts/vpn-hop.ps1` (disconnect → swap profile →
  reconnect → verify via `api.ipify.org` → optional ntfy ping) + Task Scheduler
  or dashboard-button trigger. Samosa needs zero changes.

## Constraints (unchanged)

- Rotation is an **egress-layer** concern; the router stays key-layer. No proxy
  code changes for any option above (worst case: a dashboard button that shells
  the hop script).
- `node.exe`/OpenCode must stay inside the tunnel (Vypr Per-App settings);
  Kill Switch will fail in-flight requests during a hop — retry after reconnect.
