# PRD: Agent HQ

A 3D virtual office for watching AI agents work in real time.

| | |
|---|---|
| Owner | I Made Juli Astawa |
| Status | Prototype works, moving to a Next.js codebase |
| Target stack | Next.js (App Router, TypeScript, Node.js runtime), Three.js, Tailwind CSS |
| Last updated | 2026-11-02 |
| Primary agents to monitor | Claude Code sessions and their subagents |

---

## 1. Summary

Agent HQ turns agent telemetry into a living cartoon office. Each agent is a small character with its own desk. Work status changes what the character does: it types when working, scratches its chin when thinking, waves when it needs a human, smokes when it errors, and walks off to the lounge when idle. A security wing on floor 3 holds a Red Team lab, a vulnerability-assessment (VA) report room, and a Blue Team SOC. Agents whose work matches those teams move there automatically.

The goal is to make it obvious, at a glance, **who is doing what, who is stuck, and who needs me**, without reading terminal logs.

## 2. Problem

Running several Claude Code sessions in parallel (plus their subagents) means switching between terminals to find out:
- which session is blocked on a permission prompt,
- which one finished and is waiting for the next prompt,
- what a session is actually running right now (which command, which file),
- whether security work (pentest, VA reporting, brute-force detection) is progressing and what it found.

Terminal output is dense and scattered. A spatial, ambient view is faster to read and more pleasant to keep open on a second screen.

## 3. Goals and non-goals

### Goals
1. Show every live agent (Claude Code session or subagent) as a character within 1 second of its first event.
2. Reflect status changes (working, thinking, waiting, idle, error, offline) visually within 1 second.
3. Show the current concrete action (tool + target, for example `$ nmap -sV staging`, `Edit auth.go`) in a bubble and in the roster.
4. Make "needs human" states impossible to miss (bubble, color, log, and roster pill).
5. Route security work to dedicated rooms and surface findings and alerts on room displays.
6. Zero changes to how the user runs Claude Code beyond adding hooks to settings.
7. Never slow down or block Claude Code. Hook failures are always non-blocking.

### Non-goals (for now)
- Controlling agents from the UI (approving permissions, sending prompts). Read-only first.
- Multi-user accounts, cloud hosting, or remote access over the internet.
- Running pentests or detection logic. Agent HQ only visualizes what agents and tools report.
- Exact token or cost accounting (nice to have, see M2).

## 4. Users and key scenarios

Primary user: a developer and DevOps engineer running multiple Claude Code agents on a local machine or a Linux box.

| # | Scenario | What the user sees |
|---|---|---|
| S1 | Starts 3 Claude Code sessions in different repos | 3 characters spawn at desks on floor 2, named from `HQ_NAME` or the repo folder |
| S2 | A session asks for permission to run a command | Character jumps and waves, bubble turns orange, roster pill "Butuh kamu", log line in yellow |
| S3 | A session finishes its turn | Confetti, status "Santai", and after a short delay the character walks to a lounge activity |
| S4 | A session spawns subagents | New characters appear for each subagent, then leave about 45 s after they stop |
| S5 | A pentest session runs `nmap` | Character walks to the Red Team lab on floor 3 (lift from floor 2), attack-surface wall animates |
| S6 | Blue Team agent reports a brute-force alert | SOC video wall banner flashes, siren spins, room light pulses red, alert logged and toasted |
| S7 | Red Team agent reports a finding | VA board counts update, the affected node on the attack map turns red |
| S8 | User clicks a character | Camera flies to it, switches to its floor, roster card expands with progress and recent events |

## 5. Current state (prototype)

Three files already work and are the reference implementation. Treat them as the source of truth for behavior and look. The goal of M1 is to port them into a Next.js app with the same behavior; the prototype files stay in `reference/` and are not shipped.

| File | Role |
|---|---|
| `agent-hq.html` | Single-file Three.js app (about 1,700 lines): scene, avatars, navigation, UI, demo simulator, SSE/WebSocket client |
| `server.js` | Zero-dependency Node bridge: `POST /event`, `POST /hook` (Claude Code), `GET /stream` (SSE), `GET /health`, serves the page at `/` |
| `claude-hooks.settings.json` | Hook block to merge into Claude Code settings |

Run it: `node server.js`, then open `http://localhost:8787`. Without a server the page runs a demo simulator.

## 6. Architecture

One Next.js app does both jobs: it serves the 3D office and acts as the event bridge through Route Handlers.

```
 Claude Code session(s)              other agents / scripts
   hooks (type: "http")                curl, python, log tailers
          |                                     |
          v                                     v
   POST /api/hook ------------>  Next.js app on 127.0.0.1:8787 (next start, Node.js runtime)
   (raw hook JSON)  translate     |  lib/bridge: in-memory hub (agents, recent buffer)
                                  |  redaction, auth token
   POST /api/event -------------> |
                                  v
                          GET /api/stream (SSE)
                                  |
                                  v
                    Browser: app/page.tsx (client)
                    React UI (Tailwind) + Three.js engine (imperative, in a ref)
```

- **Transport:** Server-Sent Events from `app/api/stream/route.ts` using a `ReadableStream`. The client also accepts `ws://` URLs for external sources.
- **State:** a singleton hub keeps the last known state per agent plus the last 80 logs, findings, and alerts, and replays them to new viewers (`_replay: true` so alerts do not re-trigger the siren). Store it on `globalThis` so it survives hot reload in `next dev`.
- **Runtime constraints:** all bridge routes use `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`. The bridge needs one long-lived process, so run it with `next dev` or `next start` (or a Node container). Serverless platforms such as Vercel are not supported for the bridge, because SSE connections and in-memory state do not persist there.
- **Port and bind address:** `npm run dev` and `npm start` both listen on `127.0.0.1:8787`, the same port as the prototype bridge. Optional `HQ_TOKEN` required on `/api/event` and `/api/hook` when set.
- **Prototype URLs:** `next.config.ts` rewrites `/hook`, `/event`, `/stream`, and `/health` to the matching `/api/*` routes, so anything configured for `references/server.js` (hook settings, curl scripts, `?stream=` links) keeps working unchanged. Rewrites are internal, so SSE on `/stream` is not buffered (covered by `tests/integration/bridge-parity.test.ts`). The static demo export has no rewrites (and no bridge).

## 7. Event protocol (v1)

All events are JSON objects. `id` identifies the agent. Unknown fields are ignored. Arrays of events are accepted on `/event`.

### 7.1 Agent update
```json
{ "type": "agent_update", "id": "coder-1", "name": "Glimbo", "role": "Coder",
  "status": "working", "task": "Refactor handler auth", "progress": 0.4,
  "tokens": 18230, "team": "red" }
```
- `status`: `working | thinking | waiting | idle | error | offline`. Aliases are normalized (`running`, `busy` to working; `blocked`, `needs_input` to waiting; `done`, `completed` to idle; `failed` to error; `stopped` to offline).
- `progress`: 0..1 or 0..100.
- `tokens` absolute, or `tokens_delta` incremental.
- `team` (optional): `red | report | blue | office`. Overrides keyword inference.

### 7.2 Other agent events
```json
{ "type": "log", "id": "coder-1", "level": "info|warn|error", "message": "..." }
{ "type": "task_done", "id": "coder-1", "task": "..." }
{ "type": "remove", "id": "coder-1" }
{ "type": "snapshot", "agents": [ { ...agent_update fields } ] }
```

### 7.3 Security events
```json
{ "type": "finding", "id": "rexx", "severity": "critical|high|medium|low|info", "title": "SQL injection di /login" }
{ "type": "alert", "id": "sentra", "severity": "high", "message": "Bruteforce SSH 412x/2 mnt", "source_ip": "103.94.12.7" }
{ "type": "metric", "name": "failed_logins", "value": 37 }
```
- `finding` updates the VA board and marks a node on the Red Team attack map (node chosen by keyword: ssh, db, api/idor, admin, else web).
- `alert` flashes the SOC wall for 8 s, spins the siren, logs at level `alert`, toasts if high or critical.
- `metric` with a login-related name drives the "failed logins per minute" chart for 6 s; otherwise the chart shows a baseline plus alert spikes.
- `id` is optional on these three. Without it, no character is created.

### 7.4 Rename and agent list
Renames an agent that is already running, for example a Claude Code session started without `HQ_NAME`.
```json
{ "type": "rename", "match": "property-web#ab12", "name": "Rexx", "team": "red", "role": "Pentester" }
```
- Target: `id` (exact) if given, otherwise `match`, tried in order: exact id, displayed name (case-insensitive), id or session prefix (`"ab12"` matches `"cc-ab12cd34"`; a prefix shared by a session and its subagents picks the main session).
- `name`, `team`, `role` are optional; at least one is required. A string sets the override (max 60 chars), `null` or `""` clears it. Clearing `team` sends `team: "office"`, so the agent walks back to its office desk.
- Overrides are stored per agent id and applied to every published `agent_update` and `task_done`, including events translated from hooks, so later hooks (and `X-HQ-Name` headers) cannot overwrite them. Session ids are stable, so a resumed session keeps its name.
- Persisted to `agent-hq-names.json` in the project root (env `HQ_NAMES_FILE` to change), read at start and rewritten on every rename. The file is in `.gitignore`.
- Responses on `POST /event` (or `/api/event`): `202 {"ok":true,"id","matchedBy","before","after","override","file"}` and an `agent_update` broadcast; `404` when no agent matches (the error points at `GET /agents`); `409 {"candidates":[...]}` when a name or prefix matches several agents; `400` for invalid input. In an array of events each rename result is listed under `renames`.
- `GET /agents` (or `/api/agents`): `{"ok":true,"agents":[{"id","name","role","team","status","renamed"}]}` to look up a name or id before renaming. Not authenticated, like `/stream` (localhost only); rename needs `HQ_TOKEN` when it is set, like every `POST /event`.

### 7.5 Scheduled jobs (Hermes cron)
Not in the prototype. Source: `examples/hermes/hq_cron.py`, running next to Hermes Agent (docs/hermes.md section 10).
```json
{ "type": "schedule", "source": "Hermes di vps", "controls": ["run", "pause", "resume"], "scheduler": { "alive": true },
  "jobs": [ { "id": "a1b2c3d4e5f6", "name": "Laporan harian", "schedule": "0 9 * * *", "next_run_at": 1793754000000,
              "last_run_at": 1793667602000, "last_status": "ok", "last_error": "", "state": "scheduled", "enabled": true,
              "running": false, "failure_streak": 0, "deliver": "telegram" } ] }
{ "type": "cron_command", "id": "c-1a2b3c4d", "action": "run", "job": "a1b2c3d4e5f6", "job_name": "Laporan harian",
  "status": "queued|sent|ok|error", "message": "" }
```
- `schedule` is a full snapshot, sent on change and every 30 s. It is never an agent. The bridge keeps the latest one and sends it to new viewers right after the agent snapshot, with `age_ms`. A snapshot older than 90 s (or `"offline": true`) is shown as disconnected. Times are epoch ms (ISO strings and epoch seconds are also read). Job prompts are never sent; names and errors are redacted by the source.
- The office shows the jobs on the schedule board (floor 2, back wall, right of the clock; hidden without a schedule) and in the schedule panel (board click or the "Jadwal" button).
- Controls: `POST /api/cron {"action","job"}` from the panel queues a command (`202`). Refused: other sites (`Origin` / `Sec-Fetch-Site` not same-origin, `403`), non-JSON (`415`), wrong token (`401`), unknown action (`400`), no or stale schedule (`409` / `503`), action not in `controls` (`403`), unknown job (`404`), a command for the job still open (`409`). No CORS headers on the `/api/cron*` routes.
- The source long-polls `GET /api/cron/commands?wait=20` (queued -> sent), checks each command again, runs `hermes cron <action> <id>` as the Hermes user, and answers `POST /api/cron/result {"id","ok","message"}`. A command without an answer for 90 s fails. Every step is broadcast as `cron_command`, logged under the name `Jadwal`, and toasted when it ends. The bridge itself never runs anything.
- With `HQ_TOKEN` set, all of these need the token (the panel asks for it once per tab).

### 7.6 Hermes chat
Not in the prototype. The office's chat panel talks to Hermes Agent through its API server (gateway platform `api_server`, `HQ_HERMES_API_URL`, default `http://127.0.0.1:8642`, key `HQ_HERMES_API_KEY` = Hermes' `API_SERVER_KEY`; docs/hermes.md section 11). Off (no button, routes answer `404`) without a key.
- The Agent HQ server holds the conversation (`lib/bridge/hermes-chat.ts`, on `globalThis.__hqChat`): it creates a session titled `Agent HQ <date time>` (`POST /api/sessions`), posts each message to `/api/sessions/{id}/chat/stream`, and reads that SSE stream itself, because Hermes interrupts a turn when its stream client disconnects. After a restart it resumes the newest `Agent HQ` session with its history (`GET /api/sessions/{id}/messages`).
- Panel endpoints: `GET /api/hermes` -> `{"enabled"}`; `GET /api/hermes/stream` (SSE: `chat_snapshot`, then `chat_item` upserts, `chat_delta` text appends, `chat_state` phase changes); `POST /api/hermes` with `{"action":"send","text"}` (`202`, `409` while a turn runs, `413` over 8000 chars), `{"action":"approve","choice","id"?}` (`once|session|always|deny`), `{"action":"stop"}`, `{"action":"new"}`.
- Items: `user`, `assistant` (streamed, replaced by the final `assistant.completed` text), `tool` (`running|ok|error`), `note`, `approval` (`pending|expired|<choice>`). Phases: `idle`, `starting`, `running`, `approval`, `stopping`.
- Approvals go to `POST /v1/runs/{run_id}/approval`: with the canonical session owner the body is exactly `{request_id, execution_generation, choice}` taken from `GET /v1/runs/{run_id}` `pending_controls`, otherwise `{choice, request_id?}`. Stop is `POST /v1/runs/{run_id}/stop`; before `run.started`, or if Hermes does not settle within 20 s, the bridge drops the stream instead.
- Guard on the panel routes: same origin only (`Origin` / `Sec-Fetch-Site`, `403`), Host must be loopback (`localhost`, `127.x`, `[::1]`) or listed in `HQ_ALLOWED_HOSTS`, and a non-loopback host also needs `HQ_TOKEN` (`403` without it); `HQ_TOKEN` when set (`401`); JSON body (`415`). No CORS. The API key never reaches the browser. Shown text is redacted; Hermes receives the message as typed.

### 7.7 Web terminal
Not in the prototype. A Terminal button opens the server's shell next to the office (docs/terminal.md). The terminal is ttyd, a separate program; Agent HQ never runs commands and never proxies the terminal.
- `GET /api/terminal` -> `{"ok": true, "url"}` from `HQ_TERMINAL_URL`, the address as seen from the viewer's browser (usually `http://localhost:7681` through the SSH tunnel). `url` is `null` (no button) when unset, not `http(s)`, or carrying a user or password. No CORS.
- The panel shows that URL in an iframe and takes the Hermes panel's spot (opening one closes the other). An open panel stays connected while the office stream reconnects.
- `examples/terminal/ttyd.sh` runs ttyd on loopback only (`--interface lo`), writable, `--check-origin`, Basic auth `hq:<random>` from `~/.config/agent-hq/terminal.cred` (blocks DNS rebinding), refuses root, and attaches to the tmux session `agent-hq` when tmux exists.
- Without a tunnel, the same ttyd can sit behind the office's https reverse proxy at `/terminal/` (prefix stripped, WebSocket upgrade, `limit_req`); docs/terminal.md section 5 records the risk (a public shell behind one password).

## 8. Claude Code integration

### 8.1 Mechanism
Claude Code hooks with handler `type: "http"` POST the same JSON a command hook receives on stdin to `http://127.0.0.1:8787/api/hook` (Next.js app). The prototype URL `http://127.0.0.1:8787/hook` is rewritten to the same route, so hook settings made for the prototype keep working. The server translates it and always replies `200` with an empty body, so Claude Code treats it as success with no decision. Timeout is 3 s. Default `onFailure` is `continue`, so a stopped server never blocks a session.

Install by merging `claude-hooks.settings.json` into `~/.claude/settings.json` (all projects) or a project's `.claude/settings.json`. Hook arrays from different settings files merge.

### 8.2 Identity
| Field | Source |
|---|---|
| Agent id | `cc-<first 8 of session_id>`; subagents `cc-<6 of session_id>-<8 of agent_id>` |
| Name | header `X-HQ-Name` from env `HQ_NAME`, else `<repo folder>#<4 of session_id>`; subagents use `agent_type` |
| Role | header `X-HQ-Role` from env `HQ_ROLE`, else `Claude Code · <repo folder>` |
| Team | header `X-HQ-Team` from env `HQ_TEAM` (optional) |

Usage: `HQ_NAME=Rexx HQ_TEAM=red claude` in the repo you want to test. Headers use `allowedEnvVars`, so unset variables become empty strings and the server falls back.

A session that is already running without `HQ_NAME` can be renamed afterwards with a `rename` event (§7.4); the override wins over the header-derived name, role, and team on every later hook.

### 8.3 Hook to event mapping
| Hook event | Agent HQ result |
|---|---|
| `SessionStart` | status idle, task "Sesi <source> di <repo> · <model>" |
| `UserPromptSubmit` | status thinking, task = prompt (redacted, 140 chars), log "Prompt baru masuk" |
| `PreToolUse` | status working, task = tool description; log line except for quiet tools (Read, Grep, Glob, todo updates) |
| `PostToolUseFailure` | log warn "<tool> gagal: <error>" |
| `PermissionRequest` | status waiting, task "Minta izin: <tool description>" |
| `Notification` | `permission_prompt`, `agent_needs_input`, `elicitation_*` to waiting; `idle_prompt` to idle; others to log |
| `Stop` / `SubagentStop` | `task_done` (confetti, idle) plus log of `last_assistant_message`; subagents removed about 45 s later if silent |
| `StopFailure` | status error, error log |
| `SubagentStart` | new character, status working |
| `PreCompact` | status thinking, task "Merangkum konteks (compact)" |
| `SessionEnd` | status offline; removed after 5 min if silent |

Tool descriptions: `Bash` to `$ <command>`, `Edit/Write` to `Edit <file>`, `Read` to `Baca <file>`, `WebSearch` to `Search: <query>`, `WebFetch` to `Buka <host>`, `Task/Agent` to `Delegasi: <description>`, `mcp__srv__tool` to `MCP srv: tool`.

### 8.4 Redaction (must keep)
Before anything leaves the server, prompts and commands are passed through `redact()`: bearer tokens, `token=`, `api_key=`, `password=`, `secret=`, `authorization:` values, and common key prefixes (`sk-`, `ghp_`, `xox*`) become `***`. Commands are truncated to 90 chars. Extend this list; never remove it.

### 8.5 Security agents reporting findings
Hooks only see tool calls. Findings and alerts need the agent (or a tool) to report them. Put this in the CLAUDE.md of the security repos:

```md
## Agent HQ reporting
After you confirm a vulnerability, report it:
curl -s -X POST http://127.0.0.1:8787/api/event -H 'content-type: application/json' \
  -d '{"type":"finding","id":"'"$HQ_ID"'","severity":"high","title":"<short title>"}'
Only test targets listed in SCOPE.md. Never test anything outside scope.
```
Blue Team: a log tailer (see M3) posts `alert` and `metric` events from fail2ban, Wazuh, or Nginx logs.

Red Team activity must stay within properties the user owns or has written authorization to test. Agent HQ only visualizes; it never initiates testing.

## 9. World specification

Cartoon cutaway building on a floating rock in an alien sky. Front and right walls are open. Floors stack at y = 0, 5.6, 11.2.

### Floor 1: Santai (idle activities)
| Room | Spots (activity) |
|---|---|
| Lounge | 3 sofa seats (nonton TV or main HP), 2 beanbags (rebahan sambil main HP). TV turns on when someone watches. |
| Pantry | Coffee machine (bikin kopi, steam, then holds a mug), fridge (nyari camilan, door opens), 2 stools (ngopi santai) |
| Game room | Arcade (screen plays when used), solo ping-pong (half table folded up, ball animates) |
| Ruang rebahan | 2 futons (tidur siang or rebahan sambil main HP) |
| Lobby | Decor: alien plant, water cooler, sign. Stairs to floor 2 at the right. |

### Floor 2: Kantor
| Room | Content |
|---|---|
| Office | 9 home desks in a 3 x 3 grid (one per agent, max 9; more agents are listed in the roster only), monitor shows status, name plate, hover chair with status ring |
| Ruang rapat | Whiteboard (corat-coret, strokes accumulate), card table with 2 stools (main kartu) |
| Pojok baca | Bookshelf, 2 armchairs (baca buku) |
| Server room | Racks with blinking LEDs, bubbling tank (decor) |
| Hall jendela | 2 window spots (bengong lihat planet) |
| Lift | Glass tube to floor 3 |

### Floor 3: Security Ops
| Room | Stations | Displays |
|---|---|---|
| Red Team Lab | 4 | Attack-surface wall (nodes WEB, API, SSH, DB, ADMIN, animated packets when active, red nodes with findings), hologram target model with scan ring |
| Ruang Laporan VA | 3 | Severity board (counts and latest 5 findings), printer that prints while someone writes |
| SOC Blue Team | 4 | Video wall (failed logins per minute with threshold 25, alert list, flashing banner), siren with rotating beams and red room light |

Stations face the back wall so the camera sees agents and their monitors over their shoulders.

## 10. Agent behavior

### 10.1 Where an agent goes
```
status idle (for >= 3 s)        -> random free idle spot; every 30-60 s maybe switch spot
status working/thinking/
  waiting/error                 -> team station if team known and a station is free, else home desk
status offline                  -> home desk, eyes closed
```
Leaving for work is urgent (runs), leaving for a break is a stroll.

### 10.2 Team inference
1. Explicit `team` field or `X-HQ-Team` header wins (`office` forces the home desk).
2. Else keywords in the current task. The match is sticky until the agent goes idle or offline, so a pentest session running `ls` stays in the Red Team lab.
3. Else keywords in the role.

Keyword sets (case-insensitive):
- red: pentest, penetration, red team, exploit, recon, nmap, sqlmap, burp, payload, privesc, xss, sqli, sql injection, idor, enumerate, metasploit, subdomain, port scan, "uji ... brute"
- blue: brute force, siem, soc, blue team, deteksi, detect, fail2ban, ids, waf, threat hunt, incident, insiden, login gagal, failed login, wazuh, suricata, block ip
- report: laporan, report (word), vulnerability assessment, va, cvss, temuan, executive summary, remediasi, remediation, poc

### 10.3 Navigation
- Waypoint graph per floor plus vertical links (stairs F1 to F2, lift F2 to F3). Dijkstra shortest path.
- Every place (desk, station, spot) is a chain `hub -> via points -> final position` with a facing angle. Paths never cut through walls or furniture.
- Redirect mid-walk: retrace to the last reached waypoint, then re-route.
- Spot and station reservation: one agent per place.
- Snapshot on connect places idle agents directly in spots and team agents directly at stations (no long walk on page load).

### 10.4 Poses and animation
Poses: desk, walk, stand, sit (sofa, armchair), stool, recline (beanbag), lie (futon). Props: phone, mug (kept while walking after coffee), book, cards, paddle. Status overlays at the desk: typing, chin scratch, wave, shake with smoke, sleep. Blink, eye tracking (monitor, camera when selected or needs attention), squash and stretch on status change, spawn pop-in, confetti on task done.

## 11. UI specification

- **Top bar:** logo, floor switcher (Semua, Lt.3 Security, Lt.2 Kantor, Lt.1 Santai), status chips with counts, connection pill (Mode demo, Live, Terputus), home camera button, Sambungkan button.
- **Floor switcher:** hides floors above the chosen one (Sims style) and flies the camera. Bubbles of agents on other floors get an `Lt.N` badge in overview modes and are hidden on Lt.3.
- **Roster (right):** one card per agent: color dot, name, role, status pill, task, location chip (room and floor) plus activity, tokens and last update. Click expands progress bar and last 12 events, and focuses the camera.
- **Log (bottom left):** timestamped lines. Filters: "Jalan" toggles movement lines, "Error saja" shows only errors and alerts. Max 220 lines.
- **Bubbles:** status icon, name, and context (activity when idle, destination when walking, task when waiting, error, or selected).
- **Connect modal:** URL input (`http(s)://` for SSE, `ws(s)://` for WebSocket), event format reference, back to demo.
- UI copy is Indonesian. Keep it.

## 12. Visual style

- Original cartoon sci-fi look: thick dark outlines (inverted hull, `OutlineEffect`), 3-step toon shading, saturated palette, wobbly organic shapes.
- Do not use characters, logos, portal effects, or other recognizable elements from existing animated shows or brands. All characters are original.
- Palette: ink `#1b1530`, paper `#fff6e3`, pink `#ff6fd8`, status colors working `#a6e22e`, thinking `#ffd23f`, waiting `#ff9f1c`, idle `#59c3ff`, error `#ff4f5e`, offline `#9a94b0`.
- Fonts: Bungee (headings, signs), Fredoka (UI), JetBrains Mono (logs). No em dashes in UI copy.

## 13. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | 60 fps on a mid laptop iGPU with 9 agents; canvas textures redrawn at most every 120-150 ms; lower floors' heavy displays skip redraw when hidden |
| Latency | Hook to on-screen change under 1 s on localhost |
| Resilience | SSE auto-reconnect with backoff up to 15 s; server never crashes on bad JSON; hooks never block Claude Code |
| Security | Bind 127.0.0.1 by default; `HQ_TOKEN` supported; redaction before broadcast; no secrets in URLs; HTML-escape all agent-provided strings in the UI |
| Portability | One `npm run build && npm start` runs everything. Bridge code in `lib/bridge` uses only Node built-ins. A static demo export (no bridge) must still build for sharing |
| Hosted artifact | When opened as a Claude artifact, outbound connections are blocked by CSP, so the page must stay fully functional in demo mode |

## 14. Target codebase (Next.js)

Keep behavior identical to the prototype while splitting it up.

```
agent-hq/
  prd.md
  CLAUDE.md                        # conventions for agents working on this repo
  reference/                       # prototype, read-only: agent-hq.html, server.js
  app/
    layout.tsx                     # fonts via next/font (Bungee, Fredoka, JetBrains Mono)
    page.tsx                       # server component shell, renders <Office />
    globals.css                    # Tailwind
    api/
      event/route.ts               # POST: Agent HQ events
      hook/route.ts                # POST: Claude Code hook payloads, always 200 empty body
      stream/route.ts              # GET: SSE (snapshot, replay, live)
      health/route.ts              # GET
      agents/route.ts              # GET: agent list for renames (§7.4)
  components/
    Office.tsx                     # 'use client'; mounts the engine, wires store and transport
    TopBar.tsx  FloorSwitcher.tsx  StatusChips.tsx
    Roster.tsx  AgentCard.tsx  LogPanel.tsx  ConnectModal.tsx  Toast.tsx
  engine/                          # framework-free Three.js, ported from the prototype
    index.ts                       # createEngine(canvas, labelsEl, store) -> { setFloor, select, dispose }
    scene/                         # renderer, OutlineEffect, lights, sky, materials, helpers
    world/                         # floor1.ts, floor2.ts, floor3.ts, props/
    agents/                        # avatar.ts, poses.ts, animate.ts
    nav/                           # graph.ts, places.ts, router.ts
    displays/                      # canvas textures: monitors, TV, arcade, red wall, VA board, SOC wall
  lib/
    events.ts                      # types + normalization (shared by client and server)
    teams.ts                       # team keywords and inference
    store.ts                       # zustand store: agents, logs, soc, vuln, floorMode, selectedId
    transport.ts                   # SSE / WebSocket client with backoff
    demo.ts                        # demo simulator
    bridge/
      hub.ts                       # globalThis singleton: state, subscribers, replay buffer
      hooks.ts                     # Claude Code hook -> events (port of server.js hookToEvents)
      redact.ts
      auth.ts
      overrides.ts                 # rename overrides: merge, load/save agent-hq-names.json (§7.4)
  examples/
    claude-hooks.settings.json     # URL http://127.0.0.1:8787/api/hook
    server.js                      # standalone bridge: copy of references/server.js plus rename and /api/* URLs
    report-finding.sh
    tail-fail2ban.ts
  tests/                           # vitest unit tests, playwright visual tests
```

Decisions:
- **Engine stays imperative Three.js** (no React Three Fiber in M1). The prototype is about 1,700 lines of imperative scene code; porting it as plain TypeScript modules is faster and keeps parity. The engine is created once in a `useEffect` inside `Office.tsx` and disposed on unmount (renderer, geometries, materials, textures, event listeners, `requestAnimationFrame`). R3F can be revisited later.
- **Client-only rendering for the canvas:** `Office.tsx` is a client component; load it with `next/dynamic` and `ssr: false` so Three.js never runs on the server.
- **React owns the 2D UI** (top bar, roster, log, modal, toast) styled with Tailwind, matching the prototype look (thick ink borders, offset shadows, Bungee/Fredoka). The engine keeps the in-scene bubbles (CSS2DRenderer) for performance.
- **One store as the contract** between React and the engine: `lib/store.ts` (zustand). React writes `floorMode` and `selectedId`; the engine reads them and writes back derived data (agent location, current activity) at a throttled rate (at most every 250 ms) to avoid re-render storms.
- **Shared types:** `lib/events.ts` and `lib/teams.ts` are imported by both the route handlers and the client.
- **Three.js version pinned** (`three@0.160.x`) with the addons used by the prototype: OrbitControls, CSS2DRenderer, OutlineEffect, RoundedBoxGeometry, BufferGeometryUtils.
- **Demo mode:** if `/api/stream` is unreachable, or the build is a static export, the client falls back to `lib/demo.ts`.

## 15. Milestones and acceptance criteria

### M1. Port to Next.js (parity)
- [ ] Next.js App Router project with TypeScript and Tailwind, structure as in section 14. `npm run dev`, `npm run build`, `npm start` work.
- [ ] `/api/event`, `/api/hook`, `/api/stream`, `/api/health` behave like the prototype bridge (same payloads in, same SSE out). Verified by replaying recorded payloads.
- [ ] Visual and behavioral parity with `reference/agent-hq.html` (screenshot comparison of the four floor views in demo mode).
- [ ] Engine disposes cleanly: navigating away and back (or HMR) does not leak WebGL contexts or duplicate animation loops.
- [ ] All event types in section 7 covered by unit tests for normalization.
- [ ] No console errors or hydration warnings in demo mode for 5 minutes.

### M2. Claude Code integration hardening
- [ ] `server/hooks.js` with unit tests using recorded payloads for every event in section 8.3.
- [ ] Token usage per session: on `Stop`, read `transcript_path` (JSONL) and sum usage fields, emit `tokens`. Verify the transcript format against the current Claude Code docs first; skip silently if the format differs.
- [ ] `examples/install-hooks.js` merges the hook block into `~/.claude/settings.json` safely (backup first, idempotent).
- [ ] Session list in the roster grouped by repo, subagents nested under their parent.

### M3. Security integrations
- [ ] `examples/tail-fail2ban.js`: tails fail2ban and auth logs, posts `metric` every 60 s and `alert` on bans or threshold breaches.
- [ ] Nginx access-log tailer: 401/403 spikes per IP to `alert`.
- [ ] `report-finding.sh` helper and a CLAUDE.md template for Red Team and VA agents.
- [ ] Optional Wazuh webhook receiver mapped to `alert`.

### M4. History and persistence
- [ ] Append-only JSONL event log in `data/` (zero-dep), rotated daily.
- [ ] Timeline scrubber to replay a past period in the office.
- [ ] Export the VA findings list as Markdown for the report.

### M6. Hermes Agent (docs/hermes.md)
- [x] Shell-hook adapter (`examples/hermes/hq_hook.py`): Hermes events translated to Claude Code hook payloads, subagents, cron runs named after their job.
- [x] MCP server (`examples/hermes/hq_mcp.py`) for status, logs, findings, alerts, metrics; reports to the hook's character.
- [x] Scheduled jobs (§7.5): reporter `hq_cron.py` as a systemd user service, schedule board on floor 2, schedule panel with run / pause / resume.
- [x] Installer (`examples/hermes/install.py`): files, `agent-hq.env`, config.yaml merge with backup and YAML check, reporter service.
- [x] Hermes chat (§7.6): panel next to the office, server-held stream to the Hermes API server, approvals, stop, resume; `install.py --chat` sets up both sides.
- [x] Web terminal (§7.7): Terminal button and panel for a separate ttyd on loopback, `examples/terminal/ttyd.sh` launcher, docs/terminal.md.

### M5. Polish
- [ ] Follow-cam toggle for the selected agent.
- [ ] Optional sounds (typing, siren, confetti) with a mute toggle, off by default.
- [ ] Mobile layout pass, reduced-motion mode.
- [ ] More than 9 agents: extra desk row or overflow area.

## 16. Testing

- Unit (vitest): event normalization, team inference, hook translation, redaction (include tricky secrets), router pathfinding.
- Integration: start `next start`, replay a recorded Claude Code session (`tests/fixtures/*.jsonl` of hook payloads) to `/api/hook` and assert the `/api/stream` output.
- Visual: Playwright with headless Chromium (SwiftShader) taking screenshots of each floor view in demo mode; compare against baselines.
- Manual: run two real Claude Code sessions plus one subagent, confirm scenarios S1 to S8.

## 17. Open questions

1. Keep the bridge inside Next.js, or split it out later (Go single binary) if the app is deployed somewhere serverless?
2. Should the UI ever be able to answer permission prompts (two-way control), or stay read-only?
3. Persist per-agent identity across sessions (same character and desk for the same `HQ_NAME`)?
4. Support remote agents on other machines (requires TLS and auth beyond `HQ_TOKEN`)?

## Appendix A: quick start

```bash
# 1. start the app (bridge included)
npm run build && npm start                    # http://localhost:8787 (bound to 127.0.0.1)
# prototype alternative: node references/server.js (same port; stop the app first)

# 2. merge examples/claude-hooks.settings.json into ~/.claude/settings.json

# 3. run Claude Code sessions with optional identity
HQ_NAME=Rexx  HQ_TEAM=red    claude    # pentest repo
HQ_NAME=Quill HQ_TEAM=report claude    # VA report repo
HQ_NAME=Sentra HQ_TEAM=blue  claude    # SOC / detection repo
claude                                   # normal coding session, team inferred
```

## Appendix B: manual test events

```bash
curl -s -X POST localhost:8787/api/event -H 'content-type: application/json' \
  -d '{"id":"demo","name":"Tester","status":"working","task":"nmap -sV staging"}'
curl -s -X POST localhost:8787/api/event -H 'content-type: application/json' \
  -d '{"type":"alert","severity":"high","message":"Bruteforce SSH","source_ip":"10.0.0.9"}'
```

## Appendix C: Next.js bridge sketch

Reference shape for `lib/bridge/hub.ts` and `app/api/stream/route.ts`. Adapt, do not copy blindly.

```ts
// lib/bridge/hub.ts
type Send = (ev: unknown) => void;
type Hub = { agents: Map<string, any>; recent: any[]; subs: Set<Send> };
const g = globalThis as unknown as { __hq?: Hub };
export const hub: Hub = g.__hq ??= { agents: new Map(), recent: [], subs: new Set() };
export function publish(ev: any) { /* remember(ev) as in reference/server.js */ for (const s of hub.subs) s(ev); }
```

```ts
// app/api/stream/route.ts
import { hub } from '@/lib/bridge/hub';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (ev: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      ctrl.enqueue(enc.encode('retry: 2000\n\n'));
      send({ type: 'snapshot', agents: [...hub.agents.values()] });
      hub.recent.slice(-30).forEach(ev => send({ ...ev, _replay: true }));
      hub.subs.add(send);
      const ping = setInterval(() => ctrl.enqueue(enc.encode(': ping\n\n')), 15000);
      cleanup = () => { clearInterval(ping); hub.subs.delete(send); };
      req.signal.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch {} });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
}
```

Pitfalls to check:
- If events arrive in bursts instead of live, disable response compression for the stream (`compress: false` in `next.config`, or put a reverse proxy without gzip in front).
- `app/api/hook/route.ts` must return `new Response(null, { status: 200 })` even on parse errors, so Claude Code never logs hook failures.
- Behind Nginx, set `proxy_buffering off;` for `/api/stream` and its alias `/stream`.
