# PRD: Agent HQ

A 3D virtual office for watching AI agents work in real time.

| | |
|---|---|
| Owner | I Made Juli Astawa |
| Status | Prototype works, moving to a Next.js codebase |
| Target stack | Next.js (App Router, TypeScript, Node.js runtime), Three.js, Tailwind CSS |
| Last updated | 2026-11-04 |
| Primary agents to monitor | Claude Code sessions and their subagents |

---

## 1. Summary

Agent HQ turns agent telemetry into a living cartoon office. Each agent is a small character with its own desk. Work status changes what the character does: it types when working, scratches its chin when thinking, waves when it needs a human, smokes when it errors, and walks off to the lounge when idle. The office is one terraced floor (§9). On its back tier a security wing holds a Red Team lab, a vulnerability-assessment (VA) report room, and a Blue Team SOC, next to three meeting rooms and a server room with DevOps stations. Agents whose work matches those teams move there automatically. The meeting rooms seat a session with its subagents, or agents that share a group, around one table (§7.9).

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
| S5 | A pentest session runs `nmap` | Character climbs the stairs to the Red Team lab on the back tier, attack-surface wall animates |
| S6 | Blue Team agent reports a brute-force alert | SOC video wall banner flashes, siren spins, room light pulses red, alert logged and toasted |
| S7 | Red Team agent reports a finding | VA board counts update, the affected node on the attack map turns red |
| S8 | User clicks a character | Camera flies to it, switches to its floor, roster card expands with progress and recent events |
| S9 | A session delegates to two subagents | The session's character walks up to a free meeting room, the subagents pop in at its table, the room screen lists the team; when the last subagent is done the character goes back to work |

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
- `parent`, `group` (optional): who delegated this agent, and a shared work group. Put agents in a meeting room (§7.9).

### 7.2 Other agent events
```json
{ "type": "log", "id": "coder-1", "level": "info|warn|error", "message": "..." }
{ "type": "task_done", "id": "coder-1", "task": "..." }
{ "type": "remove", "id": "coder-1" }
{ "type": "snapshot", "agents": [ { ...agent_update fields } ] }
```
A `remove` with `"reason": "kick"` comes from the bridge after a kick (§7.10).

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
- The Agent HQ server holds the conversation (`lib/bridge/hermes-chat.ts`, on `globalThis.__hqChat`): it creates a session titled `Agent HQ <date time>` (`POST /api/sessions`), posts each message to `/api/sessions/{id}/chat/stream`, and reads that SSE stream itself, because Hermes interrupts a turn when its stream client disconnects. The first message renames the session `Agent HQ · <topic>` (`PATCH`, redacted, max 48 chars; the time is added when the title is taken). After a restart it resumes the most recently active `Agent HQ` session with its history (`GET /api/sessions/{id}/messages`).
- One session is displayed at a time; multiple sessions can run concurrently with separate streams, items, approvals and stop controllers. Riwayat lists the API server's sessions (`GET /api/sessions?source=api_server&limit=50`, without hidden, archived, internal or other-source rows, newest `last_active` first) and can open (including while another session runs; other sources are refused, Hermes would answer `409 permission_denied`), rename (`Agent HQ · <title>`, max 80 chars) or delete one (with its character, pinned name and model). All sessions share Hermes' memory, skills and `session_search`; the panel shows whether the `memory` and `session_search` toolsets are on for `api_server` (`GET /v1/toolsets`).
- Each session has an office character with the id the Hermes hook gives it (`cc-` + 8 hex of SHA-1 of the session id), so chat and hook move the same character. The bridge publishes its status from the chat (idle, thinking, working, waiting, error; no logs and no `task_done`, the hook sends those). Characters stay in the office when the panel switches sessions and after a background turn completes; completed agents become idle and follow the usual leisure behavior. Opening an already visible idle character preserves its last task. Explicitly deleting the session removes its character; compression still replaces the character when its session id changes. Riwayat includes each session's live phase and prevents deleting a running session. A new session (`new`) is created right away so its character walks in; its name, role and team (`office|red|report|blue`) are pinned like a rename (§7.4) and told to Hermes on every turn as `system_message` (ephemeral: memory, skills and the transcript are untouched).
- Model per session: `{"provider","model"}` sent with every turn (`model`, `provider`), null = Hermes' default; kept in `agent-hq-hermes.json` (`HQ_HERMES_CHAT_FILE`, max 500). The picker lists authenticated providers from `GET /api/model/options?include_unconfigured=false` (cached 1 minute). `runtime` on `assistant.completed` / `run.completed` shows which model answered. When those events carry another `session_id` (context compression), the bridge follows it with the character, its pinned name and the model.
- Panel endpoints: `GET /api/hermes` -> `{"enabled"}`; `GET /api/hermes/stream` (SSE: `chat_snapshot`, then `chat_item` upserts, `chat_delta` text appends, `chat_state` with phase, session, title, character, model and runtime); `POST /api/hermes` with `{"action":"send","text"}` (`202`, `409` while a turn runs in that session, `413` over 8000 chars), `{"action":"approve","choice","id"?}` (`once|session|always|deny`), `{"action":"stop"}`, `{"action":"new","agent"?:{"name","role","team"},"model"?}`, `{"action":"sessions"}` (rows plus the server clock `now`), `{"action":"open","sessionId"}`, `{"action":"rename","sessionId"?,"title"}`, `{"action":"delete","sessionId"}`, `{"action":"models","refresh"?}` (`error` instead of a failure when Hermes has no list), `{"action":"model","model"}`.
- Actions `send`, `approve`, `stop`, and `model` accept `sessionId` to target the intended session despite a concurrent panel switch; omitting it keeps compatibility with the displayed session. Draft text is kept separately per session. The panel receives events only from the displayed session and a full snapshot on switching back. At most 50 idle/selected sessions are cached; active streams are never evicted. Hermes/provider concurrency limits still apply.
- Items: `user`, `assistant` (streamed, replaced by the final `assistant.completed` text), `tool` (`running|ok|error`), `note`, `approval` (`pending|expired|<choice>`). Phases: `idle`, `starting`, `running`, `approval`, `stopping`.
- Approvals go to `POST /v1/runs/{run_id}/approval`: with the canonical session owner the body is exactly `{request_id, execution_generation, choice}` taken from `GET /v1/runs/{run_id}` `pending_controls`, otherwise `{choice, request_id?}`. Stop is `POST /v1/runs/{run_id}/stop`; before `run.started`, or if Hermes does not settle within 20 s, the bridge drops the stream instead.
- Guard on the panel routes: same origin only (`Origin` / `Sec-Fetch-Site`, `403`), Host must be loopback (`localhost`, `127.x`, `[::1]`) or listed in `HQ_ALLOWED_HOSTS`, and a non-loopback host also needs `HQ_TOKEN` (`403` without it); `HQ_TOKEN` when set (`401`); JSON body (`415`). No CORS. The API key never reaches the browser. Shown text is redacted; Hermes receives the message as typed.

### 7.7 Web terminal
Not in the prototype. A Terminal button opens the server's shell next to the office (docs/terminal.md). The terminal is ttyd, a separate program; Agent HQ never runs commands and never proxies the terminal.
- `GET /api/terminal` -> `{"ok": true, "url"}` from `HQ_TERMINAL_URL`, the address as seen from the viewer's browser (usually `http://localhost:7681` through the SSH tunnel). `url` is `null` (no button) when unset, not `http(s)`, or carrying a user or password. No CORS.
- The panel shows that URL in an iframe and takes the Hermes panel's spot (opening one closes the other). An open panel stays connected while the office stream reconnects.
- `examples/terminal/ttyd.sh` runs ttyd on loopback only (`--interface lo`), writable, `--check-origin`, Basic auth `hq:<random>` from `~/.config/agent-hq/terminal.cred` (blocks DNS rebinding), refuses root, and attaches to the tmux session `agent-hq` when tmux exists.
- Without a tunnel, the same ttyd can sit behind the office's https reverse proxy at `/terminal/` (prefix stripped, WebSocket upgrade, `limit_req`); docs/terminal.md section 5 records the risk (a public shell behind one password).

### 7.8 Server monitor
Not in the prototype (there the server room is decor). The server room on floor 2 shows the condition of the machine Agent HQ runs on (usually the VPS of docs/hermes.md). The bridge measures it itself with Node built-ins (`lib/bridge/server-stats.ts`); nothing is installed and no command is run.
```json
{ "type": "server_stats", "platform": "linux", "interval_ms": 5000, "cpu": 0.42, "cores": 4, "load": [0.52, 0.4, 0.31],
  "mem_used": 2577006592, "mem_total": 4085719040, "disk_used": 31138512896, "disk_avail": 9126313984,
  "disk_size": 42144039936, "uptime_s": 1036800, "app_rss": 220200960 }
```
- Sampled every 5 s from the start of the server (`instrumentation.ts`), also while nobody watches; the first sample comes 1 s after the start (CPU needs two readings). The bridge keeps the samples of the last 30 minutes in memory (at most 400; a restart starts empty). New viewers get the latest sample right after the agent snapshot (and the schedule), with `age_ms` and `history`: the earlier samples of the last 30 minutes, oldest first, as shares 0..1 (`null` = unknown). Live samples carry no `history`. It is never an agent and never replayed as a log line. `POST /event` ignores a posted `server_stats`: only the bridge produces it.
```json
"history": [{ "age_ms": 1795000, "cpu": 0.031, "mem": 0.474, "disk": 0.59 }, { "age_ms": 1790000, "cpu": 0.028, "mem": 0.474, "disk": 0.59 }]
```
- `cpu`: busy share of all cores since the previous sample (0..1, from `os.cpus()` times). `load`: `os.loadavg()`, `null` on Windows (always zero there; the office then leaves it out). Memory: `MemTotal` and `MemTotal - MemAvailable` from `/proc/meminfo` on Linux, otherwise `os.totalmem()` and `os.totalmem() - os.freemem()`. Disk: `fs.statfs` of `HQ_DISK_PATH` (default `/`): used `(blocks - bfree) * bsize`, avail `bavail * bsize`, size `blocks * bsize`; percent like `df`: `used / (used + avail)`. `uptime_s`: `os.uptime()`. `app_rss`: resident memory of the Agent HQ server process. A value that cannot be read is `null`.
- Nothing else leaves the server: no host name, IP address, user, process list, or command line.
- `HQ_SERVER_STATS=0` (or `off`, `false`) turns sampling off; the room then stays decor.
- In the office: left rack = CPU, right rack = RAM. LED rows light up from the bottom by percent (at least one row), colored by level: below 50% `#a6e22e`, 50-75% `#ffd23f`, 75-90% `#ff9f1c`, from 90% `#ff4f5e`; the CPU rack blinks faster the busier it is. The tank = disk: liquid height by percent, pink, red from 90%. A wall screen above the racks (redrawn every 1 s while floor 2 is visible) shows CPU with cores and load, RAM and disk with used / total, uptime, and the Agent HQ process memory, plus a state: NORMAL, SIBUK (a value from 75%), KRITIS (a value from 90%). No sample for 20 s: grey LEDs and liquid, and the screen says TERPUTUS with the age of the last sample.
- Without any sample (demo mode, static export, sampling off) the room looks exactly like the prototype (random blinking LEDs, bubbling tank) and the screen is hidden.
- Clicking the server room (a rack, the tank or the wall screen) opens the **Server** panel on the right, in any view, only while there is a sample (decor is not clickable); the pointer turns into a hand over it. The panel shows the state (as on the screen) and the age of the last sample; a card each for CPU (cores, load 1/5/15 minutes), RAM and disk (used / total, free) with the percent, a bar in the level color, and a line chart of the last 30 minutes (from `history` plus the live samples, with the 90% warning line); then uptime, Agent HQ memory and platform; and the last 5 `Server` log lines. Without a fresh sample a banner says the data is cut off and since when, and the colors turn grey. It closes with Tutup or Esc, and it takes the spot of the Hermes and terminal panels: opening one closes the other.
- Warnings, computed in the office (each viewer): CPU at 90% or more for 60 s, RAM at 90% or more, disk at 90% or more give a `warn` log line under the name `Server` and a toast; once the value is below 85% again, an `info` line says it is back to normal.

### 7.9 Meeting floor (team collaboration)
Not in the prototype. Today a session that delegates gets its subagents at separate desks, so the teamwork does not show. Floor 4 seats a team around one table. Decisions by the user (2026-11-04): while a team has an active subagent, its meeting wins over the floor-3 stations; teams form from subagents and from an explicit `group`; the floor-2 room the prototype calls "Ruang Rapat" is renamed "Ruang Kreatif" so the two are not confused.

**Fields.** Two optional agent fields on `agent_update` and `task_done`, kept in the bridge's agent state so the snapshot carries them:
```json
{ "type": "agent_update", "id": "cc-ab12cd-9f8e7d6c", "parent": "cc-ab12cd34", "status": "working" }
{ "type": "agent_update", "id": "coder-1", "group": "Rilis v2.3", "status": "working" }
```
- `parent`: id of the agent that delegated this one. The bridge sets it on every event translated from a subagent hook (`agent_id` present) to the main session's id, `cc-<first 8 of session_id>`. Claude Code and Hermes subagents (both go through `/api/hook`) get it without any settings change. Other sources may send it. `null` or `""` clears it; an agent's own id is ignored.
- `group`: free label for agents that work on the same thing. Trimmed, redacted, max 40 chars; compared case-insensitively, shown as first seen. Header `X-HQ-Group` from env `HQ_GROUP` (Claude Code hook settings; Hermes `agent-hq.env`). `null` or `""` clears it.
- Both are new in the bridge output, so the parity test with `references/server.js` ignores these two keys. Events without them are unchanged.

**Team.** Key: the agent's own `group` if set; else, for a subagent, its parent's `group` if set, else the parent id; else, for an agent that another agent names as `parent`, its own id. The leader is the parent (in a group without one: the first member to sit). Team name on screens and in logs: the group as given, else `Tim <leader name>` (`Tim <parent id>` while the leader is unknown).

**Meeting rule.** A team holds a meeting while it has at least one active subagent, or at least two active members (active = working, thinking, waiting, error). While it lasts these members sit in the team's room:
- every subagent of the team that is not offline, also once it is done, until it is removed;
- the leader in any status but offline (an idle leader waits for its subagents);
- every other active member.

Idle members without an active subagent do their idle activities as usual. Offline agents go to their desk as today. Where a member of a meeting works: meeting seat, then team station, then home desk (§10.1). The task-board pickup (deviation 14) still comes first: the agent carries the card to its seat and lays it on the table.

**Rooms and seats.** Three rooms, Meeting A, B and C, with five seats each: the head seat at the back of the table, facing the camera (the leader), and two on each side, facing the table. A team gets the first free room (A, B, C) when its meeting starts. It keeps the room until the meeting is over and its last member has left. No free room: the team works as today (desks and stations), with one log line, and moves in as soon as a room is free. More than five members: the extra ones work as today.

**Subagents without a desk.** A subagent that gets a seat when it first appears takes no desk. It pops in at its seat without walking (many subagents live only seconds), keeps the seat until it is removed, and does not count against the 9 desks. A subagent that gets no seat takes a desk as today (or is listed only when the desks are full). An agent with a desk walks back to its desk or station when its meeting is over. On connect, the snapshot places members of a meeting directly at their seats.

**In the room.** Each seat has a laptop on the table. Seated members use the desk pose and the desk status overlays (typing, chin scratch, wave, smoke, sleep). Every 4 to 7 s one calm member (working or thinking) talks for 2 to 3 s: it turns to the table and gestures, and the others look at it. Chat balloons in a meeting use work lines (`aku cek bagian ini ya`, `tes-nya hijau!`, `bentar, aku baca dulu`, `siap, lanjut`, `aku ambil yang ini`, `oke, digabung ya`), and stay off while someone in the room waits or errors. When a subagent joins, a small card flies from the leader's seat to its seat (0.6 s). The room's accent strip takes the team color: the leader's dept color (§10.2) when it has one, else pink `#ff6fd8`.

**Room screen.** On the back wall above the head seat. It shows the room name, then either `KOSONG` or the team name, the leader's task, up to five members (avatar color dot, name, status color, short task) and how long the meeting has run (`rapat 3 mnt`). Redrawn every 1 s, and right away when the members change.

**Log and roster.** Log lines under the name `Meeting`: `Rapat mulai: <team> di Meeting A`, `Rapat selesai: <team> (<n> mnt)`, `Ruang meeting penuh, <team> kerja di meja`. Movement lines as for any room (`Buru-buru ke Meeting A`). Roster location chip: `Meeting A` with the activity `rapat <team>`; while walking `jalan ke Meeting A`.

**Manual discussion (approved 2026-11-04, deviation 27).** Clicking a room monitor opens its control panel (HTML room buttons provide keyboard access). The user enters a goal and selects 2–5 Hermes API-server sessions, and/or creates new agents in the panel with name, role and model. Creating an agent makes a normal retained Hermes session and immediately selects it, without changing the open ordinary chat. The server reserves the chosen empty room and participants; each agent receives the shared transcript on its turn. Discussion runs for 1–5 rounds (default 3), then the first participant summarizes conclusions, decisions, open questions and action items. The panel streams attributed messages and supports directions for the next turn, approval requests, and a scoped Stop. It does not start follow-up execution automatically. The latest discussion per room is persisted; browser disconnects do not stop runs, and interrupted server restarts restore the transcript without replaying model calls. Automatic meetings continue in other rooms. Details: `docs/meeting-discussion.md`.

**Views.** Since deviation 29 (2026-11-05) the meeting rooms are on the back tier of the single floor, between Security and the server room (§9), reached by stairs; there is no floor 4 any more. The area switcher has a `Meeting` view, and the meeting access buttons (Meeting A/B/C, bottom right) show in that view. Following an agent keeps Semua in Semua; in an area view the switcher follows the agent's area.

**Demo.** Glimbo sometimes delegates to 2 or 3 demo subagents (`parent: "glimbo"`) when it starts a new task; each works 20 to 45 s, sends `task_done` and is removed 8 s later. Plonk and Vexa sometimes share the group `Rilis v2.3` for one task.

**Later (not in M8):** `group` in `rename` (§7.4) and in the Hermes "Sesi baru" form; clicking a room screen; nesting subagents under their parent in the roster (M2).

### 7.10 Kick an agent out (Airlock)
```json
{ "type": "kick", "id": "cc-ab12cd34" }
{ "type": "kick", "match": "property-web#ab12" }
```
Requested by the user 2026-11-05. Sends an agent that is not working out of the office; it comes back by itself.

- **Who.** Only an agent whose status is `idle` (Santai) or `offline`, for example a Hermes agent whose session was deleted outside the panel. `working`, `thinking`, `waiting` and `error` are refused with `409` (`"<name> berstatus <label>. Hanya agen Santai atau Offline yang bisa dikeluarkan."`). `id` must match exactly; `match` works like rename (§7.4: id, displayed name, id or session prefix). Unknown: `404`; neither given: `400`. Answer `202` `{ ok, kicked: true, id, name, matchedBy }`; in an array, results are listed under `kicks`. `HQ_TOKEN` applies as for every `/event`.
- **Broadcast.** The bridge publishes `{ "type": "remove", "id": ..., "reason": "kick" }`. Viewers drop the agent from the roster at once (log line `Dikeluarkan lewat Airlock`); older clients just see a remove. The bridge keeps the agent's last record and its own identity (`lib/bridge/hub.ts` `hub.kicked`, saved in the restart snapshot).
- **Held back.** `publish()` filters every event of a kicked agent, so no path (hooks, `/event`, Hermes chat) can bypass it. Events that show no activity (status `idle` or `offline`, `task_done`, token counts, logs, idle prompts, session starts) are not broadcast and do not add the agent back; agent updates still refresh the kept record (tokens). A `metric` keeps its value but loses the agent link.
- **Coming back.** A status of `thinking`, `working`, `waiting` or `error`, or a `finding` or `alert`, ends the kick: the kept record returns to the snapshot and the event goes out with the name, role, team, `parent`, `group`, tokens and cost the agent had (renames still apply). Viewers add it as a new agent (log line `Kembali ke kantor`). A `remove` (for example 5 minutes after `SessionEnd`, or deleting the Hermes session) also ends the kick; so does age: a kick older than 7 days is forgotten.
- **Roster.** Every card has **Keluarkan** at the left of its bottom row (**Buka chat** stays at the right), enabled only for Santai and Offline (tooltip otherwise: `Hanya agen Santai atau Offline yang bisa dikeluarkan`). No confirmation dialog: a kick is not permanent. Toast `<name> dikeluarkan lewat Airlock. Kembali saat mulai kerja.`; errors (409, `HQ_TOKEN`, a bridge without kicks such as `examples/server.js`) are shown as a toast. Demo mode kicks on that screen only; a kicked demo agent comes back with a new task after a while.
- **Airlock (front tier, §9).** A small metal room in the front right corner of the Santai tier, between the vending machines and the Teras (x 23.6 to 29.0, z 4.4 to 8.2): a sliding inner door on its left side (node `AL`, linked to the Teras hub `TE`), a clear glass front so the camera sees inside, sign `AIRLOCK / PINTU KE LUAR ANGKASA` on the back wall, three standing rings, a beacon, and a hatch on the island's right edge that swings out to space.
- **Sequence** (`engine/agents/eject.ts`). The engine takes over the kicked avatar (its desk, station or seat is freed at once): a small escort drone with a tractor beam leads it along the normal routes to the Airlock (bubble `· diantar ke Airlock`), head down. Inside, the inner door shuts, the beacon and floor lights flash red and an alarm beeps; the agent panics. Then the hatch bursts open, the air rushes out, and the agent is pulled through, tumbling up over the island into space while it shrinks, and twinkles out. The drone flies off. Sounds: `airlock-alarm`, `airlock`, `twinkle` (Web Audio, `lib/audio.ts`). Several kicked agents share the Airlock and leave together once the door is shut. If the agent comes back before its launch, the leaving avatar goes poof and a new one appears at its desk; after the launch the flight just finishes. Every area is always visible, so the whole sequence shows in any view (best framed in Semua and Santai).

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
| Group | header `X-HQ-Group` from env `HQ_GROUP` (optional, §7.9) |
| Parent | subagents only: the main session's id `cc-<first 8 of session_id>` (§7.9) |

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

Cartoon office on a floating rock in an alien sky. **One floor in three tiers** (terraces) that rise toward the back,
joined by stairs (user decision 2026-11-05, plan-m1.md deviation 29; until then four stacked floors). Tier heights
y = 0 (front), 1.2 (middle), 2.4 (back). Outer walls on the back and the left; the front and the right side are open
toward the camera. Every area is always visible: the area switcher (Semua, Santai, Kantor, Security, Meeting,
Server) only moves the camera. Constants: `engine/layout.ts`.

```
   back (y 2.4):   SECURITY (Red | VA | SOC)   | MEETING (A | B | C) | RUANG SERVER
   middle (y 1.2): KANTOR (9 desks, boards)    | Kreatif | Baca | Taman (garden)
   front (y 0):    Rebahan | Lounge | Pantry | Lobby (grand stairs) | Game room | Teras
```

### Front tier: Santai (idle activities)
| Room | Spots (activity) |
|---|---|
| Lounge | 3 sofa seats (nonton TV or main HP), 2 beanbags (rebahan sambil main HP). TV on a low cabinet, turns on when someone watches. |
| Pantry | Coffee machine (bikin kopi, steam, then holds a mug), fridge (nyari camilan, door opens), 2 stools (ngopi santai); shelf on a backsplash |
| Game room | Arcade (screen plays when used), solo ping-pong (half table folded up, ball animates), PLAY sign on posts |
| Ruang rebahan | 2 futons (tidur siang or rebahan sambil main HP) |
| Lobby | "AGENT HQ" floor emblem, 2 benches (nongkrong di bangku), alien plant, water cooler, grand stairs to the office. Welcome sign on the left wall. |
| Teras | Deck on the front-right corner with a railing and a telescope, 2 spots (bengong lihat planet) |
| Airlock (§7.10) | Between the vending machines and the Teras: metal room with a sliding inner door, clear glass front, sign `AIRLOCK`, beacon, hatch to space on the island's right edge. Kicked agents leave the office through it |

Vending machines stand against the riser right of the game room.

### Middle tier: Kantor
| Room | Content |
|---|---|
| Office | 9 home desks in a 3 x 3 grid (one per agent, max 9; more agents are listed in the roster only), monitor shows status, name plate, hover chair with status ring. On the left wall: schedule board, mission board, task board with the clock above it |
| Ruang kreatif | Whiteboard on a stand (corat-coret, strokes accumulate), card table with 2 stools (main kartu). Called "Ruang rapat" in the prototype; renamed for the meeting rooms (§7.9): label `RUANG KREATIF`, roster `Ruang Kreatif` |
| Pojok baca | Bookshelf, 2 armchairs (baca buku) |
| Taman | Pond with lily pads, 2 benches (nongkrong di bangku), alien plants, garden lamps |

### Back tier: Security Ops
| Room | Stations | Displays |
|---|---|---|
| Red Team Lab | 4 | Attack-surface wall (nodes WEB, API, SSH, DB, ADMIN, animated packets when active, red nodes with findings), hologram target model with scan ring |
| Ruang Laporan VA | 3 | Severity board (counts and latest 5 findings), printer that prints while someone writes |
| SOC Blue Team | 4 | Video wall (failed logins per minute with threshold 25, alert list, flashing banner), siren with rotating beams and red room light |

Stations face the back wall so the camera sees agents and their monitors over their shoulders.

### Back tier: Meeting (§7.9)
| Room | Content |
|---|---|
| Meeting A, B, C | Side by side along the back wall (6.8 wide each), enclosed like ordinary office meeting rooms: frosted glass walls 2.6 high on the street, between the rooms and on both outer sides (dense film with three etched lines near the top), in slim light frames at the floor, the top, the corners and the doors only; the panes hide the outlines of what is behind them; a sliding frosted door in the middle of each front wall opens while an agent is at it (every route in and out goes through it). Seated agents stay visible from the camera over the frosted part. Table with five seats and laptops (head seat at the back facing the camera, two per side), room screen on the back wall, accent strip in the team color, rug per room |
| Street | In front of the rooms, reached by the stairs from the office. Sign `MEETING` on a post |

Labels: `MEETING A`, `MEETING B`, `MEETING C`.

### Back tier: Ruang Server
A dedicated server room behind clear tinted glass with a sliding door. Front rack row: the CPU rack and the RAM rack
(server monitor, §7.8), two decor racks and the disk tank; back rack row (decor) with the wall screen above it; a
cooling unit whose fans spin faster with CPU; cable trays over the racks; a status lamp over the door (worst
CPU/RAM/disk level, dim without samples); 3 **DevOps** stations (team `ops`) whose screens show a deploy terminal,
pipeline stages, and the live CPU and RAM bars when samples arrive. Label `RUANG SERVER`.

## 10. Agent behavior

### 10.1 Where an agent goes
```
status idle (for >= 3 s)        -> random free idle spot; every 30-60 s maybe switch spot
status working/thinking/
  waiting/error                 -> meeting seat if the agent's team is in a meeting (§7.9),
                                   else team station if team known and a station is free, else home desk
status offline                  -> home desk, eyes closed
```
Leaving for work is urgent (runs), leaving for a break is a stroll. Exception: an idle leader whose team still has an active subagent stays at its meeting seat.

### 10.2 Team inference
1. Explicit `team` field or `X-HQ-Team` header wins (`office` forces the home desk).
2. Else keywords in the current task. The match is sticky until the agent goes idle or offline, so a pentest session running `ls` stays in the Red Team lab.
3. Else keywords in the role.

Keyword sets (case-insensitive), checked in this order:
- red: pentest, penetration, red team, exploit, recon, nmap, sqlmap, burp, payload, privesc, xss, sqli, sql injection, idor, enumerate, metasploit, subdomain, port scan, "uji ... brute"
- blue: brute force, siem, soc, blue team, deteksi, detect, fail2ban, ids, waf, threat hunt, incident, insiden, login gagal, failed login, wazuh, suricata, block ip
- report: laporan, report (word), vulnerability assessment, va, cvss, temuan, executive summary, remediasi, remediation, poc
- ops (server room, deviation 29): devops, sre, docker, kubectl, kubernetes, k8s, helm, terraform, ansible, systemctl, rolling deploy, deploy ke / deploy to, rollout, worker_processes, sertifikat tls, tls cert, ruang server, server room, infrastruktur, infrastructure

### 10.3 Navigation
- Waypoint graph: a street along each tier, the office walkway grid, and five stairs between the tiers (heights change only on the stairs). Dijkstra shortest path.
- Every place (desk, station, spot) is a chain `hub -> via points -> final position` with a facing angle. Paths never cut through walls or furniture.
- Redirect mid-walk: retrace to the last reached waypoint, then re-route.
- Spot and station reservation: one agent per place.
- Snapshot on connect places idle agents directly in spots and team agents directly at stations (no long walk on page load).

### 10.4 Poses and animation
Poses: desk, walk, stand, sit (sofa, armchair), stool, recline (beanbag), lie (futon). Props: phone, mug (kept while walking after coffee), book, cards, paddle. Status overlays at the desk: typing, chin scratch, wave, shake with smoke, sleep. Blink, eye tracking (monitor, camera when selected or needs attention), squash and stretch on status change, spawn pop-in, confetti on task done.

## 11. UI specification

- **Top bar:** logo, area switcher (Semua, Santai, Kantor, Security, Meeting, Server), status chips with counts, connection pill (Mode demo, Live, Terputus), home camera button, Sambungkan button.
- **Area switcher:** flies the camera to the area and shows that area's room labels (all labels in Semua). Every area stays visible (single floor, §9); it was a floor switcher that hid the floors above the chosen one until deviation 29.
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

### M7. Server monitor (§7.8)
- [x] Bridge sampler (`lib/bridge/server-stats.ts`, Node built-ins only): CPU, load, RAM, disk, uptime, app memory every 5 s from server start (`instrumentation.ts`); latest sample plus 30 minutes of history for new viewers; `HQ_SERVER_STATS=0` turns it off.
- [x] Server room on floor 2: racks show CPU and RAM, the tank shows disk, wall screen with the numbers; decor without data.
- [x] Warnings in the log and as a toast (CPU 90% for 60 s, RAM 90%, disk 90%), back-to-normal line below 85%.
- [x] Server panel (`components/ServerPanel.tsx`): a click on the server room in the Lt.2 view opens it; values, 30 minute charts, server warnings.
- [x] Tests: sampler, parsing and routes (`tests/unit/server-stats.test.ts`), levels, formatting, warnings and store (`tests/unit/server.test.ts`), samples over `next start` and `HQ_SERVER_STATS=0` (`tests/integration/server-stats.test.ts`), parity ignores `server_stats`, the visual test hides the monitor, the UI test clicks the server room and checks the panel (`tests/e2e/ui.spec.ts`).

### M8. Meeting floor (§7.9)
- [x] Protocol: `parent` and `group` normalized (`lib/events.ts`); the hook translation sets `parent` for subagents and reads `X-HQ-Group`; the hub keeps both in its agent state and snapshot. `X-HQ-Group` / `HQ_GROUP` added to `examples/claude-hooks.settings.json`, the Hermes hook and its installer.
- [x] Team key, meeting rule, room and seat assignment as pure functions (`lib/meeting.ts`), applied by the store (`meeting` per agent, like `slot`); subagents seated without a desk.
- [x] Floor 4 (`engine/world/floor4.ts`), lift through floor 3, nav nodes and seat places, movement order (meeting seat, station, desk), room screens (`engine/displays/meeting.ts`), talking turns, meeting chat lines, delegation card.
- [x] Floor switcher, camera presets, follow cam, bubble badges, fourth render pass, sky placement for the taller building, `engine.debug.hideMeetingFloor()`.
- [x] Floor 2 "Ruang Rapat" renamed "Ruang Kreatif" (label and roster).
- [x] Demo: Glimbo delegates, Plonk and Vexa share `Rilis v2.3`.
- [x] Tests (`tests/unit/meeting.test.ts`, `tests/unit/meeting-nav.test.ts`, parity and Hermes integration, `tests/e2e/visual.spec.ts` "meeting floor", `tests/e2e/ui.spec.ts`): normalization and hooks (`parent`, `group`, snapshot); store (team key, meeting start and end, room order, head seat, idle leader stays, idle group member leaves, rooms full, more than five members, desk-less subagent, seat freed on remove, meeting before station); nav (every desk, station and spot to every seat and back through the lift, no wall crossing); parity ignores `parent` and `group`; visual: the four prototype views with floor 4 hidden, a new Lt.4 baseline, a meeting placed via `window.agentHQ` for manual review; the floor switcher fits at 360 px; dispose frees floor 4.

### M9. Single terraced floor and server room (§9, plan-m1.md deviation 29)
- [x] Four stacked floors replaced by one island with three tiers and five stairs (`engine/layout.ts`, `engine/world/`); areas Santai, Kantor, Security, Meeting, Server always visible; area switcher; one render pass.
- [x] Dedicated server room: rack rows, disk tank, wall screen, cooling unit, cable trays, glass with a sliding door, status lamp, 3 DevOps stations (team `ops`, keyword inference, rename and chat team option).
- [x] Front tier lobby (floor emblem, benches), terrace with telescope, garden on the middle tier.
- [x] Tests: stairs are the only height changes, every place lies in its area, DevOps agents reach the server room, server door; e2e area switcher and server panel; the scene parity test against the prototype is retired.

### M10. Kick (§7.10)
- [x] Rules shared by bridge and store (`lib/kick.ts`): who may be kicked, what brings an agent back.
- [x] Bridge: `{"type":"kick"}` on `/event`, filter in `publish()`, kept record restored on return, kicks in the restart snapshot, Hermes chat treats a kicked agent as known (`agentKnown`).
- [x] Store: `remove` with `reason: "kick"` emits the `kick` signal; demo-mode filter; demo agents come back.
- [x] Engine: Airlock on the front tier (`engine/world/airlock.ts`), node `AL`, escort drone, launch and flight (`engine/agents/eject.ts`), sounds.
- [x] Roster button **Keluarkan** (`components/AgentCard.tsx`).
- [x] Tests: `tests/unit/kick.test.ts` (rules, bridge filter and return, route, client), `tests/unit/store.test.ts`, `tests/unit/airlock-nav.test.ts` (routes to the Airlock without crossing walls), `tests/unit/persistence.test.ts` (restart), `tests/e2e/visual.spec.ts` "kick" (manual review screenshots), `tests/e2e/ui.spec.ts` "kick from the roster".

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
