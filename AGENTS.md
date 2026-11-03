<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent HQ

3D cartoon office that shows AI agents (Claude Code sessions and subagents) working in real time.
Spec: `prd.md`. Current milestone: **M1, port the prototype to Next.js with identical behavior and look** (prd.md §15).
Step plan and approved deviations: `plan-m1.md`. Do not start M2+ work.

## Source of truth

- `references/agent-hq.html` (scene, UI, demo, client) and `references/server.js` (bridge) are the prototype.
  **Read-only.** Never edit, move, rename, or reformat anything in `references/`.
- **Folder name:** the prototype lives in `references/` (plural). prd.md writes `reference/`; that is the same
  folder. Do not create `reference/` and do not rename `references/`.
- For M1 the prototype wins over the PRD on behavior and look, except the deviations listed in `plan-m1.md`.
- Port, do not redesign. Keep constants, coordinates, colors, timings, UI copy, and order of operations.
  Any new deviation must be added to `plan-m1.md` and approved by the user first.

## Stack

- Next.js 16.4 App Router, React 19, TypeScript strict, Tailwind v4 (loaded through `@tailwindcss/turbopack`).
  This Next.js differs from training data: read `node_modules/next/dist/docs/` before using any Next API.
- `three@0.160.0` pinned (same as the prototype). Addons from `three/addons/...`:
  OrbitControls, CSS2DRenderer, OutlineEffect, RoundedBoxGeometry, BufferGeometryUtils.
- `zustand` for client state. `vitest` for unit and integration tests, `@playwright/test` for visual tests.
- Do not add other runtime dependencies without asking. `lib/bridge/` uses Node built-ins only.

## Commands

```bash
npm run dev          # next dev on 127.0.0.1:8787 (same port as the prototype bridge)
npm run build        # production build (bridge included)
npm start            # next start on 127.0.0.1:8787
npm run build:demo   # static demo export to out/ (no bridge, demo mode only)
npm run lint
npm run typecheck    # tsc --noEmit
npm test             # vitest run (unit + bridge integration)
npm run test:e2e     # playwright (visual parity, dispose/leak, console errors); needs `npm run build` first.
                     # Next allows one `next dev` per folder: if one is running, set HQ_E2E_DEV_URL=http://localhost:8787
node references/server.js   # prototype bridge (default :8787; parity tests start it on a free port)
```

## Layout

```
app/            layout.tsx (next/font), page.tsx (server shell), globals.css, api/{event,hook,stream,health}/route.ts
components/     React 2D UI: Office, OfficeLoader, TopBar, FloorSwitcher, StatusChips, Roster, AgentCard, LogPanel, ConnectModal, Toast
engine/         framework-free Three.js: index.ts (createEngine), scene/, world/, agents/, nav/, displays/
lib/            events.ts, teams.ts, store.ts, transport.ts, demo.ts, bridge/{hub,hooks,redact,auth}.ts
examples/       claude-hooks.settings.json (URL http://127.0.0.1:8787/api/hook)
tests/          unit/, integration/, e2e/, fixtures/*.jsonl
```

## Rules

### Engine (`engine/`)
- Plain imperative Three.js. No React imports, no React Three Fiber.
- All mutable state lives inside the `createEngine()` instance: desk slots, spot and station reservations,
  stations, fx, timers, listeners. Module scope holds only pure constants and pure functions (nav graph data,
  palettes, keyword tables). Reason: React StrictMode double-mount and HMR must not share state.
- `dispose()` must cancel `requestAnimationFrame`, remove every listener it added, dispose OrbitControls,
  dispose every geometry, material, and texture, call `renderer.dispose()` and `renderer.forceContextLoss()`,
  and remove the canvas and CSS2D label DOM. `dispose()` is idempotent: a second call is a no-op
  (React StrictMode runs effect cleanup twice in dev).
- Canvas text uses font families resolved from the CSS variables set by `next/font` (names are hashed).
  Never hard-code `'Bungee'` in `ctx.font`. Canvas text is drawn only after `document.fonts.ready`
  (load each family explicitly first); before that, text textures stay blank.
- Floors are rendered in separate passes by `renderFloors()` (approved deviation 6 in `plan-m1.md`): each pass
  re-renders the sun's shadow map with only that floor's objects, so nothing shadows another floor through a slab.
  Do not merge back into a single `effect.render`. New world-root objects must be assigned to a pass in `bandOf`.
- Keep the prototype's redraw rates: desk screens, TV, arcade every 120 ms; floor 3 displays every 150 ms
  and only while floor 3 is visible; whiteboard every 90 ms; mission board and roster "ago" text every 1 s.
- Do not chase identical `Math.random()` call order with the prototype. Randomness (books, stars, plants,
  demo) may differ; layout, geometry, colors, and behavior may not.

### Store contract (`lib/store.ts`)
- One zustand store: agents, logs, soc, vuln, stats, floorMode, selectedId, connection, toast.
- React writes `floorMode` and `selectedId`. The engine reads them.
- The engine writes derived per-agent data (location, activity, floor) at most every 250 ms, only on change.
- One-shot effects (confetti, squash, snapshot placement, removal) go through the engine event bus, not store state.

### Bridge (`lib/bridge/`, `app/api/`)
- Same payloads in, same SSE out as `references/server.js`. Parity is checked by replaying fixtures to both.
- `/api/hook` always answers `200` with an empty body, including bad JSON. Only a wrong token gives `401`.
- Hub state lives on `globalThis.__hq` so it survives `next dev` reloads.
- Rename overrides (`lib/bridge/overrides.ts`, prd.md §7.4) are applied inside `publish()` to every `agent_update` and
  `task_done`. Every event, including hook translations, must go through `publish()` so a rename cannot be bypassed.
- `redact()` runs on prompts, commands, and log messages before anything is broadcast.
  Extend its patterns; never remove one. Commands truncated to 90 chars.
- Response compression stays off (`compress: false`) so SSE is not buffered.
- Token totals (`lib/bridge/tokens.ts`) come from Claude Code transcripts: all four usage fields, deduped per
  `message.id`, cumulative per session. Read only allowed roots (`~/.claude/projects`, `HQ_TRANSCRIPT_ROOTS`), after
  the hook response (`after()`), incrementally. The transcript format is undocumented: never throw on odd lines.
- Port 8787 on 127.0.0.1 for `dev` and `start`. `next.config.ts` rewrites the prototype URLs `/hook`, `/event`,
  `/stream`, `/health` to `/api/*` (server build only; static export cannot rewrite). Keep both URL sets working;
  `tests/integration/bridge-parity.test.ts` checks the aliases, including that `/stream` is not buffered.
- `cacheComponents` and `partialPrefetching` are OFF (decision D1). Every `app/api/*/route.ts` exports
  `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`. After `npm run build`, every `/api/*` route must
  show as dynamic (`ƒ`) in the route table; none may be prerendered.

### UI
- UI copy is Indonesian and must match the prototype word for word. No em dashes in UI copy.
- Agent-provided strings are rendered as React text or `textContent`. Never `innerHTML` with agent data.
- Palette: ink `#1b1530`, paper `#fff6e3`, pink `#ff6fd8`; status working `#a6e22e`, thinking `#ffd23f`,
  waiting `#ff9f1c`, idle `#59c3ff`, error `#ff4f5e`, offline `#9a94b0`.
  Fonts: Bungee (headings, signs), Fredoka (UI), JetBrains Mono (logs).
- Original characters only. No characters, logos, or effects from existing shows or brands.
- Engine-owned DOM (`.bubble`, `.room`) is styled with plain CSS classes in `globals.css`.
  React-owned UI uses Tailwind utilities with the prototype's exact sizes, borders, and shadows.
- Tailwind is imported WITHOUT preflight (`app/globals.css`: theme + utilities only), so browser defaults match the
  prototype (h1/h2 bold, `pre` margins, `line-height: normal`). Side effect: `border-dashed`/`border-dotted` set the
  style on all four sides and unset sides fall back to `medium` width; use e.g. `[border-top:2px_dashed_var(--ink)]`.
- Every 2D UI root carries `data-hq-ui` so visual tests can hide the overlay and compare the scene only.
- If built CSS looks stale (e.g. old rules after editing `globals.css`), rebuild; check `.next/static/chunks/*.css`.

### Security
- Bind `127.0.0.1` by default. Support `HQ_TOKEN` (`Authorization: Bearer` or `x-hq-token`).
- No secrets in URLs or logs. Red Team features only visualize; nothing in this repo initiates testing.

### Tests
- Unit (vitest): event normalization (all §7 types), team inference, hook translation, redaction, router
  pathfinding, store flows (walking, poses, room changes are verified here, not by screenshots).
- Bridge parity: replay `tests/fixtures/*.jsonl` to `node references/server.js` and to `next start`,
  compare SSE output ignoring `ts`.
- Visual (Playwright): building without agents in the 4 views (Semua, Lt.3, Lt.2, Lt.1) compared with the
  prototype using a tolerance; agents placed at fixed spots via `window.agentHQ` with the simulator stopped
  for manual review. Tests run offline: intercept `cdn.jsdelivr.net/npm/three@0.160.0/**` with `page.route`
  and serve files from `node_modules/three`.

## Done means
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` pass, and the M1 checks in `plan-m1.md`
are green. Do not commit unless the user asks.

## Git
- Never add a `Co-Authored-By: Claude` trailer, or any other co-author, to commits. Commits are authored by the repository owner only, so that only their name appears in the GitHub contributor list.
- Commit and push finished work straight to `main` once the checks pass (lint, typecheck, tests, build), then confirm CI is green and that the deploy after it went through. There is no need to ask first; the owner approved this on 2026-10-12.
- Git lives only at the repository root. `frontend/` and `backend/` keep their own `.gitignore` but are not separate repositories.
