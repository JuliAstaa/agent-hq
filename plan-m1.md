# Rencana M1: Port Agent HQ ke Next.js (parity)

Status: **disetujui 2026-11-02**. Langkah 0-4 **selesai**, berhenti di checkpoint: menunggu user meninjau screenshot 4 lantai (mode demo) sebelum langkah 5 (UI React).

## Progres

| Langkah | Status | Bukti |
|---|---|---|
| 0. Fondasi | selesai | build OK, font self-hosted |
| 1. `lib/events.ts`, `lib/teams.ts` | selesai | `tests/unit/events.test.ts`, `teams.test.ts` |
| 2. Bridge | selesai | 50 payload rekaman (`tests/fixtures/session.jsonl`) -> respons HTTP + SSE identik dengan `references/server.js`, juga dengan `HQ_TOKEN`; semua `/api/*` = `ƒ` |
| 3. Store, transport, demo | selesai | `tests/unit/store.test.ts` |
| 4. Engine | selesai | `tests/unit/nav.test.ts`; `tests/e2e/visual.spec.ts` (gedung kosong 4 view vs prototipe, toleransi 4%, lolos); `tests/e2e/dispose.spec.ts` (StrictMode: 2 konteks dibuat, 1 di-lose, 1 canvas, 1 loop; `dispose()` 2x aman) |
| 5-7 | belum | |

## Usulan perbaikan bug prototipe (menunggu persetujuan user)

Saat ini di-port **apa adanya** (parity). Masing-masing satu perubahan kecil.

| # | Bug di prototipe | Dampak | Usulan |
|---|---|---|---|
| B1 | `removeAgent()` hanya melepas reservasi spot, bukan stasiun Lt.3 (dikonfirmasi penulis prototipe sebagai bug). | Agen yang dihapus saat di stasiun membuat stasiun itu terkunci selamanya. Contoh: demo -> live, stasiun Rexx/Quill/Sentra tetap terpakai "hantu". | `releasePlaces()` melepas semua tujuan non-meja (`kind !== 'desk'`). Ada di `engine/agents/movement.ts`, tes sudah menandai perilaku sekarang. |
| B2 | `redact()` hanya menyamarkan `-p<password>` kalau kata `mysql` muncul **setelah** `-p`. | `mysql -u root -pS3cret` bocor apa adanya ke log dan SSE. | Tambah pola untuk `-p<pw>` setelah `mysql`/`mysqldump`/`mariadb` (memperluas daftar, sesuai PRD §8.4). Tes `it.fails` di `tests/unit/redact.test.ts` sudah siap dibalik. |

## Catatan teknis (tanpa perubahan perilaku yang terlihat)

- Body > 2 MB: prototipe memutus socket; Route Handler tidak bisa, jadi membalas `400 {"ok":false,"error":"body terlalu besar"}`.
- Lookup alias status/tim pakai `hasOwnProperty` (prototipe pakai `in`, sehingga kata seperti `constructor` lolos sebagai status).
- Bubble langsung diperbarui saat agen mulai jalan (prototipe menunggu tick 1 detik berikutnya).
- Avatar dan meja agen yang dihapus di-dispose (prototipe membiarkan geometri/material menumpuk).
- `@types/node` ^24, aset SVG bawaan create-next-app di `public/` dihapus.

Sumber: `prd.md` §5, §6, §7, §8, §14, §15 (M1), §16; prototipe di `references/`.

## Keputusan (disetujui user)

| # | Keputusan | Hasil |
|---|---|---|
| D1 | Scaffold memakai `cacheComponents: true`. Di Next 16.4 opsi ini **melarang** `export const runtime` dan menganjurkan hapus `dynamic = 'force-dynamic'`, padahal PRD §6 meminta keduanya. | **Setuju.** `cacheComponents` dan `partialPrefetching` dimatikan. Semua route `app/api` pakai `runtime = 'nodejs'` + `dynamic = 'force-dynamic'`, dan wajib tetap dinamis saat build (tidak ada yang di-prerender, dicek di tabel route `next build`). |
| D2 | Folder `example/` berisi hook config dengan URL `http://127.0.0.1:3000/hook` (salah untuk Next maupun prototipe). PRD §14 minta `examples/` dengan URL `/api/hook`. | **Setuju.** `examples/claude-hooks.settings.json` (URL `/api/hook`), `example/` dihapus. |
| D3 | PRD menyebut `reference/`, folder aslinya `references/`. | **Setuju.** `references/` dibiarkan, dicatat di CLAUDE.md. |
| D4 | Tes visual Playwright perlu download Chromium (~150 MB) dan internet (prototipe memuat three.js dari CDN dan font dari Google). | **Setuju.** Tes tidak butuh internet: request ke `cdn.jsdelivr.net/npm/three@0.160.0/**` dicegat `page.route` dan disajikan dari `node_modules/three`. |

## Perbedaan yang disengaja dari prototipe

1. **Koneksi awal.** Halaman otomatis connect ke `/api/stream` (same origin), sama seperti prototipe yang di-inject `AGENT_HQ_STREAM` oleh `server.js`. Bedanya: kalau koneksi **pertama** gagal, jatuh ke mode demo (PRD §14). Kalau sudah live lalu putus, tetap retry dengan backoff 1.5 s x1.7 sampai 15 s seperti prototipe. `?stream=` tetap didukung.
2. **Teks modal "Sambungkan".** `node server.js` / `localhost:8787` diganti `npm start` / `localhost:3000`, default URL `http://localhost:3000/api/stream`. Kalimat lain sama persis.
3. **Lokasi dan aktivitas di roster** di-update lewat store dengan throttle 250 ms (keputusan PRD §14), bukan langsung tiap frame.
4. **Font** di-host sendiri lewat `next/font` (bukan link Google Fonts). Tampilan sama.
5. Build static demo (`npm run build:demo`) tidak punya bridge, langsung mode demo.

## Langkah

### 0. Fondasi
- Install: `three@0.160.0` (exact), `zustand`; dev: `@types/three@0.160.0`, `vitest`, `@playwright/test`. `@types/node` dinaikkan ke ^24 (runtime Node 24; ^20 bentrok dengan peer vitest 5).
- `next.config.ts`: `compress: false`; terapkan D1; mode static export saat `HQ_STATIC=1` (`output: 'export'`, `pageExtensions: ['tsx']` supaya `route.ts` tidak ikut).
- Script: `dev`/`start` dengan `-H 127.0.0.1`, `build:demo`, `typecheck`, `test`, `test:e2e`.
- `app/layout.tsx`: Bungee, Fredoka (400-700), JetBrains Mono (400, 600) via `next/font/google` sebagai CSS variable; `lang="id"`, title "Agent HQ".
- `app/globals.css`: Tailwind, token warna, `@keyframes pulse`, class engine `.bubble` dan `.room` (salinan CSS prototipe dengan variabel font).
- Cek: `npm run build` lolos dengan halaman kosong.

### 1. Lib bersama (`lib/events.ts`, `lib/teams.ts`)
- Tipe event v1 (§7), `STATUS`, `STATUS_ALIAS`, `normStatus`, normalisasi progress (0..1 atau 0..100), tokens / tokens_delta, `TEAM_ALIAS`, `SEV`, mapping severity finding (moderate, informational), pemilihan node attack map.
- `DEPT_RX` dan `inferDept` (eksplisit > task, lengket sampai idle/offline > role).
- Tes vitest: semua tipe event §7, semua alias status, team inference termasuk sticky.

### 2. Bridge (`lib/bridge/*`, `app/api/*`)
- `redact.ts`, `auth.ts`, `hooks.ts` (port `hookToEvents` + `describeTool` + `QUIET_TOOLS` + `scheduleRemove`), `hub.ts` (`remember`, `publish`, `lastSeen`, timer, subscriber, buffer 80, di `globalThis.__hq`).
- Route: `POST /api/event` (202 `{ok,received}`, 400 JSON rusak, 401 token salah, batas body 2 MB), `POST /api/hook` (selalu 200 kosong), `GET /api/stream` (`retry: 2000`, snapshot, replay 30 dengan `_replay: true`, ping 15 s, cleanup saat abort), `GET /api/health`. CORS dan `OPTIONS` 204 seperti prototipe.
- Tes: unit redact (termasuk rahasia yang licin), unit hooks untuk tiap event §8.3.
- Tes parity: rekam fixture `tests/fixtures/*.jsonl` (payload hook Claude Code + event §7), kirim ke `node references/server.js` (:8787) dan `next start` (:3000), bandingkan output SSE (abaikan `ts`). Harus identik.

### 3. Store, transport, demo (`lib/store.ts`, `lib/transport.ts`, `lib/demo.ts`)
- Port `applyEvent`, `raiseAlert`, `addFinding`, `pushLog` (maks 220), event per agen (maks 60, tampil 12), `stats`, `soc`, `vuln`, `clearAgents`, toast.
- Event bus ke engine: agent ditambah/dihapus, squash, confetti, penempatan snapshot.
- Transport SSE/WebSocket dengan backoff dan status pill (Mode demo, Live, Terputus, Menyambung...).
- Simulator demo sama persis (data DEMO, ERRORS, FINDINGS, ALERTS, WAITS, probabilitas, timing).
- Tes vitest untuk alur store (task_done, error count, snapshot, remove, finding, alert replay tidak memicu sirene).

### 4. Engine (`engine/`)
Port 1:1 dari `agent-hq.html`, dipecah sesuai PRD §14:
- `scene/`: renderer, OutlineEffect, CSS2DRenderer, kamera + VIEWS, OrbitControls, lampu, langit, material toon, helper (`rbox`, `boxAt`, `cyl`, `wobble`, `canvasTex`, `makeWall`, `partition`).
- `world/`: `floor1.ts`, `floor2.ts`, `floor3.ts`, `props/` (alien plant, lift, stasiun, meja).
- `nav/`: `graph.ts` (node + link + Dijkstra), `places.ts` (spot, desk slot, stasiun), `router.ts` (`chainOf`, `route`, retrace saat redirect). Tes vitest untuk pathfinding.
- `agents/`: `avatar.ts`, `poses.ts`, `animate.ts`, plus movement (`pickSpot`, `reserve`, `goTo`, `arrive`, `updateNav`, `workTarget`).
- `displays/`: layar meja, papan nama, TV, arcade, whiteboard, papan misi, red wall, papan VA, SOC wall, layar stasiun.
- `index.ts`: `createEngine(canvasHost, labelsEl, store)` -> `{ setFloor, select, dispose }`, loop, raycast pick + hover, resize, `window.agentHQ` (untuk debug dan tes).
- Urutan `Math.random()` **tidak** dikejar sama dengan prototipe (koreksi user).
- `dispose()` idempotent (aman dipanggil dua kali, StrictMode), termasuk `renderer.forceContextLoss()`.
- Teks canvas baru digambar setelah `document.fonts.ready`, nama font dari CSS variable `next/font`.
- **Checkpoint:** halaman sementara yang hanya me-mount engine + demo. Screenshot 4 view (Semua, Lt.3, Lt.2, Lt.1) di mode demo, kirim ke user, tunggu persetujuan sebelum langkah 5.

### 5. UI React (`components/`)
- `OfficeLoader` (client, `next/dynamic` dengan `ssr: false`) -> `Office` (mount engine di `useEffect`, dispose saat unmount, pilih transport atau demo).
- `TopBar`, `FloorSwitcher`, `StatusChips`, `Roster` + `AgentCard` (expand, progress, 12 event, scroll ke kartu terpilih), `LogPanel` (filter Jalan / Error saja, minimize, auto-stick scroll), `ConnectModal` (Esc, klik backdrop, Enter, localStorage `agenthq.url`), `Toast` (2.6 s).
- Ukuran, border, shadow, breakpoint 1180 px dan 820 px sama dengan CSS prototipe.

### 6. Static demo dan contoh
- `npm run build:demo` menghasilkan `out/` yang jalan tanpa server (mode demo).
- `examples/claude-hooks.settings.json` dengan URL `/api/hook` (D2). README: quick start (Lampiran A PRD).

### 7. Verifikasi M1 (kriteria PRD §15)
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm start`, `npm run build:demo` lolos.
- [ ] Parity bridge: replay fixture ke prototipe dan Next, output SSE identik.
- [ ] Parity visual (koreksi user, tanpa mengejar urutan `Math.random`):
  1. Screenshot gedung **tanpa agen** di 4 view (Semua, Lt.3, Lt.2, Lt.1), prototipe vs Next, dibandingkan dengan toleransi.
  2. Agen ditaruh di posisi tetap lewat `window.agentHQ` dengan simulator dihentikan, screenshot untuk cek manual.
  3. Perilaku jalan, pose, dan perpindahan ruangan diverifikasi lewat unit test router dan store.
  - Offline: `page.route` menyajikan three.js dari `node_modules/three`.
- [ ] Dispose bersih: StrictMode double-mount dan remount lewat tes tidak menambah konteks WebGL (hitung `getContext`) dan hanya ada satu loop animasi.
- [ ] Unit test normalisasi untuk semua tipe event §7.
- [ ] Mode demo 5 menit tanpa console error atau hydration warning (Playwright).
- [ ] Manual: curl Lampiran B PRD, plus satu sesi Claude Code asli dengan hook terpasang.

## Di luar M1
`report-finding.sh`, `tail-fail2ban.ts` (M3), token dari transcript dan installer hook (M2), persistensi (M4), polish (M5).
Commit hanya kalau diminta.
