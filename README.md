# Agent HQ

Kantor virtual 3D untuk memantau AI agent (sesi Claude Code dan subagennya) secara real time. Tiap agen jadi
karakter kartun dengan meja sendiri. Gerak-geriknya ikut status: mengetik saat kerja, garuk dagu saat mikir,
melambai saat butuh kamu, berasap saat error, lalu jalan-jalan ke area santai saat idle.

Spesifikasi lengkap ada di `prd.md`. README ini panduan pakainya.

## Isi

1. [Menjalankan](#1-menjalankan)
2. [Menyambungkan Claude Code](#2-menyambungkan-claude-code)
3. [Mengganti nama agen yang sudah jalan](#3-mengganti-nama-agen-yang-sudah-jalan)
4. [Membaca tampilan](#4-membaca-tampilan)
5. [Kontrol kamera dan panel](#5-kontrol-kamera-dan-panel)
6. [Tombol "Sambungkan"](#6-tombol-sambungkan)
7. [Mengirim event sendiri](#7-mengirim-event-sendiri)
8. [Daftar endpoint](#8-daftar-endpoint)
9. [Keamanan](#9-keamanan)
10. [Masalah umum](#10-masalah-umum)
11. [Untuk developer](#11-untuk-developer)
12. [Musik, efek suara, dan event langit](#12-musik-efek-suara-dan-event-langit)

## 1. Menjalankan

Butuh Node.js 20 atau lebih baru.

```bash
npm install
npm run dev                    # mode pengembangan
# atau, untuk pemakaian sehari-hari:
npm run build && npm start
```

Buka **http://localhost:8787**. Server hanya bisa diakses dari laptopmu sendiri (terikat ke `127.0.0.1`).

Bridge (penerima event dari agen) sudah ada di dalam app, jadi cukup satu proses. Kalau belum ada agen yang
tersambung, kantornya kosong: 9 meja dengan layar STANDBY. Ingin melihat kantor yang ramai? Pakai mode demo
(lihat [bagian 6](#6-tombol-sambungkan)).

Alternatif tanpa Next.js: `node examples/server.js` menjalankan bridge mandiri di port yang sama dengan fitur
yang sama. Jangan jalankan bersamaan dengan app, karena portnya sama.

## 2. Menyambungkan Claude Code

Claude Code mengirim aktivitasnya lewat **hooks** ke `http://127.0.0.1:8787/api/hook`. Contoh setting-nya ada
di `examples/claude-hooks.settings.json`.

**Pasang sekali saja** (semua project di laptopmu ikut terpantau):

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak 2>/dev/null   # cadangan dulu

# gabungkan: hook lama dan setting lain tetap ada
jq -s '.[0] as $a | .[1] as $b | $a + {hooks: (reduce ($b.hooks | keys[]) as $k (($a.hooks // {}); .[$k] = ((.[$k] // []) + $b.hooks[$k])))}' \
  ~/.claude/settings.json examples/claude-hooks.settings.json > /tmp/claude-settings.json \
  && mv /tmp/claude-settings.json ~/.claude/settings.json
```

Kalau `~/.claude/settings.json` belum ada, cukup `cp examples/claude-hooks.settings.json ~/.claude/settings.json`.
Perintah `jq` di atas jangan dijalankan dua kali, nanti hook-nya dobel. Mau hanya untuk satu project? Taruh isi
file contoh itu di `.claude/settings.json` milik project tersebut.

**Beri nama, peran, dan tim (opsional)** saat membuka Claude Code:

```bash
HQ_NAME=Rexx   HQ_TEAM=red    claude    # repo pentest
HQ_NAME=Quill  HQ_TEAM=report claude    # repo laporan VA
HQ_NAME=Sentra HQ_TEAM=blue   claude    # repo deteksi
HQ_NAME=Glimbo HQ_ROLE=Coder  claude    # sesi coding biasa
claude                                  # tanpa nama: tampil sebagai "<folder>#<4 huruf session>"
```

`HQ_TEAM` bisa `red`, `report`, `blue`, atau dikosongkan. Kalau dikosongkan, tim ditebak dari isi prompt dan
perintah (lihat [bagian 4](#4-membaca-tampilan)).

**Yang terlihat di kantor:**

| Yang dilakukan Claude Code | Yang kamu lihat |
|---|---|
| Kamu kirim prompt | Kartu tugas muncul di Papan Tugas (Lt.2); karakter lari mengambilnya, lalu membawanya ke meja (atau ke ruangan timnya di Lt.3) |
| Claude memakai tool (Bash, Edit, Read, ...) | Karakter kerja; bubble menampilkan aksinya, misalnya `$ npm test` atau `Edit auth.go` |
| Claude minta izin | Karakter melambai, status oranye "Butuh kamu" |
| Claude selesai | Confetti, lalu karakter jalan ke area santai |
| Subagen dimulai | Karakter baru muncul, lalu pergi sekitar 45 detik setelah selesai |
| Sesi ditutup | Karakter offline, hilang setelah 5 menit |

Kalau Agent HQ mati, Claude Code tetap jalan normal: hook-nya cuma menunggu maksimal 3 detik dan kegagalannya
tidak memblokir apa pun.

Memakai Hermes Agent (Nous Research) di VPS Ubuntu? Lihat `docs/hermes.md`: hook dan server MCP siap pakai
di `examples/hermes/`, plus panel chat untuk memberi perintah ke Hermes dari kantor.

## 3. Mengganti nama agen yang sudah jalan

**Dari Daftar Agen (paling gampang):** klik tombol ✎ di kartu agen, ubah Nama, Peran, atau Tim, lalu Simpan.
Nama baru tersimpan di bridge, jadi sama permanennya dengan cara curl di bawah. "Pakai nama asli" mengembalikan
nama dan peran yang dilaporkan agen itu sendiri. Di mode demo, nama hanya berubah di layar. Kalau bridge memakai
`HQ_TOKEN`, rename dari kartu ditolak, jadi pakai curl dengan token.

**Lewat curl:** sesi yang dibuka tanpa `HQ_NAME` bisa diganti namanya tanpa restart sesi:

```bash
# 1. lihat daftar agen (nama, id, tim, status)
curl -s http://127.0.0.1:8787/agents | jq '.agents[] | {id, name, team, status}'

# 2. ganti nama; cari lewat nama yang tampil, id, atau awalan session. team dan role opsional
curl -s -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"type":"rename","match":"property-web#ab12","name":"Rexx","team":"red","role":"Pentester"}'

# 3. hapus satu override dengan null atau "" (team yang dihapus = agen balik ke meja kantor)
curl -s -X POST http://127.0.0.1:8787/event -H 'content-type: application/json' \
  -d '{"type":"rename","match":"Rexx","team":null}'
```

- Balasan `202` berisi `before` dan `after`. `404` kalau tidak ada yang cocok (cek lagi `GET /agents`).
  `409` kalau nama atau awalan cocok dengan beberapa agen (pakai `id`-nya).
- Nama baru menempel: hook berikutnya tidak menimpanya, juga setelah server di-restart. Datanya disimpan di
  `agent-hq-names.json` di folder project (bisa dipindah lewat env `HQ_NAMES_FILE`; file ini tidak ikut git).

## 4. Membaca tampilan

**Status** (warna pada bubble, kartu, dan lampu antena):

| Status | Warna | Gerakan |
|---|---|---|
| Kerja | hijau | mengetik di meja |
| Mikir | kuning | garuk dagu, lampu antena berkedip |
| Butuh kamu | oranye | melompat sambil melambai |
| Santai | biru | jalan ke area santai setelah 3 detik idle |
| Error | merah | gemetar dan berasap |
| Offline | abu-abu | tidur di meja |

**Lantai:**

- **Lt.1 Santai:** lounge (TV, sofa, beanbag), pantry (mesin kopi, kulkas), game room (arcade, pingpong),
  ruang rebahan. Agen yang idle main HP, nonton TV, ngopi, atau tidur siang di sini.
- **Lt.2 Kantor:** 9 meja kerja (agen ke-10 dan seterusnya hanya tampil di Daftar Agen), Papan Tugas, ruang rapat (whiteboard, main kartu), pojok baca, ruang server,
  jendela.
  Papan misi di dinding merangkum agen aktif, tugas selesai, token, dan error.
- **Lt.3 Security** (naik lift dari Lt.2):
  - **Red Team Lab:** peta target. Node yang punya temuan jadi merah.
  - **Ruang Laporan VA:** papan jumlah temuan per severity.
  - **SOC Blue Team:** grafik login gagal per menit. Saat ada alert, sirene berputar dan ruangan berkedip merah.

**Papan Tugas:** setiap kali agen yang sedang santai atau offline menerima tugas baru (prompt), kartu berwarna
agen itu muncul di Papan Tugas di dinding kiri Lt.2. Agen lari ke papan, mengambil kartunya, lalu membawanya ke
meja atau ke ruangan timnya. Kalau tugasnya selesai sebelum kartu diambil, kartunya batal dan agen kembali
santai. Papan punya tiga tempat. Kalau penuh, atau agen sudah sibuk sejak awal, agen langsung ke meja.

**Ruang server** (Lt.2, kanan belakang) memantau mesin tempat Agent HQ jalan, misalnya VPS-mu. Server Agent HQ
mengukurnya sendiri tiap 5 detik sejak start, juga saat tidak ada yang membuka halaman, tanpa program tambahan:

- **Rak kiri = CPU, rak kanan = RAM.** Baris LED menyala dari bawah sesuai persen. Warnanya hijau di bawah 50%,
  kuning sampai 75%, oranye sampai 90%, lalu merah. Makin sibuk CPU, makin cepat LED-nya berkedip.
- **Tabung = disk.** Tinggi cairan sesuai pemakaian disk `/`, merah mulai 90%.
- **Layar di atas rak:** CPU (jumlah core dan load average), RAM, disk, uptime, dan memori proses Agent HQ.
- **Peringatan** di Log Aktivitas (nama `Server`) dan toast: CPU 90% atau lebih selama 1 menit, RAM atau disk
  90% atau lebih. Baris "normal lagi" muncul setelah turun di bawah 85%.
- Data berhenti datang lebih dari 20 detik: LED abu-abu dan layar menulis TERPUTUS.
- **Klik rak, tabung, atau layarnya** (di tampilan Lt.2) untuk membuka panel **Server** di kanan: CPU, RAM, dan
  disk dengan detailnya, grafik 30 menit terakhir (arahkan kursor ke grafik untuk membaca nilainya), uptime, memori
  Agent HQ, dan peringatan server terakhir. Tutup dengan tombol Tutup atau Esc. Riwayat 30 menit disimpan di memori
  server, jadi grafiknya langsung terisi saat halaman dibuka dan mulai kosong lagi setelah Agent HQ di-restart.

Yang dikirim hanya angka; nama host, IP, dan daftar proses tidak pernah keluar dari server. Di mode demo ruangan
ini hanya hiasan. Matikan dengan `HQ_SERVER_STATS=0`; disk lain dengan `HQ_DISK_PATH=/data`. Di Windows load
average tidak ada, jadi tidak ditampilkan. Tidak tersedia di `examples/server.js`.

**Token** di kartu agen adalah total kumulatif semua jenis token sesi itu (input, output, dan cache), dibaca dari
transcript Claude Code, jadi angkanya bisa besar karena cache read ikut dihitung.

**Agen masuk ke Lt.3** kalau `HQ_TEAM` diisi, atau kalau prompt dan perintahnya memuat kata kunci tim:

- **Red Team:** pentest, nmap, sqlmap, exploit, recon, xss, idor
- **Blue Team:** bruteforce, siem, fail2ban, wazuh, login gagal
- **Laporan VA:** laporan, cvss, temuan, remediasi

Daftar kata kuncinya ada di `lib/teams.ts`.

## 5. Kontrol kamera dan panel

| Aksi | Cara |
|---|---|
| Putar kamera | seret dengan klik kiri |
| Geser kamera | seret dengan klik kanan |
| Zoom | scroll mouse atau cubit trackpad |
| Fokus ke agen | klik badan, bubble nama, atau kartu agen; kamera lalu mengikuti agen itu (termasuk naik turun lantai) |
| Keluar dari fokus | klik lagi agen yang sedang difokus (kamera kembali ke posisi sebelumnya) |
| Lihat satu lantai | tombol Semua / Lt.3 Security / Lt.2 Kantor / Lt.1 Santai |
| Reset kamera | tombol ⌂ |

- **Daftar Agen** (kanan): satu kartu per agen. Klik kartu untuk fokus dan melihat progres serta 12 event
  terakhir agen itu. Di layar sempit, buka daftarnya lewat tombol "Agen".
- **Log Aktivitas** (kiri bawah): semua kejadian. Tombol "Jalan" menyembunyikan atau menampilkan baris
  perpindahan agen, "Error saja" menyaring error dan alert.
- **Chip status** (atas): jumlah agen per status.
- **Terminal** (kanan atas, opsional): terminal server tempat Agent HQ jalan, lewat ttyd. Tombolnya hanya muncul
  kalau `HQ_TERMINAL_URL` diisi. Lihat `docs/terminal.md`.

## 6. Tombol "Sambungkan"

Tombol ini **tidak** menyambungkan agen. Agen tersambung sendiri lewat hook (bagian 2) atau lewat event
(bagian 7). Tombol ini memilih **dari mana halaman mengambil data** untuk ditampilkan.

Biasanya kamu tidak perlu membukanya, karena halaman otomatis tersambung ke `/api/stream`. Pakai kalau:

- **Kembali ke demo:** ingin melihat agen simulasi (Zorp, Glimbo, Rexx, Sentra, dan lain-lain) yang bergerak
  sendiri, misalnya untuk mencoba tampilan atau presentasi.
- **Pindah sumber:** menonton bridge lain, misalnya di komputer lain atau `examples/server.js` di port lain.
  `http(s)://...` dibaca sebagai Server-Sent Events, `ws(s)://...` sebagai WebSocket.
- **Menyambung ulang:** isi `/api/stream`, lalu tekan Sambungkan, untuk kembali ke data asli setelah mode demo.

Kotak format JSON di dalamnya cuma contekan untuk mengirim event sendiri.

## 7. Mengirim event sendiri

Agen apa pun (skrip Python, n8n, log tailer) bisa tampil dengan mengirim JSON ke `POST /event`:

```bash
E=http://127.0.0.1:8787/event; H='content-type: application/json'

# buat atau perbarui agen
curl -s -X POST $E -H "$H" -d '{"id":"bot-1","name":"Glimbo","role":"Coder","status":"working","task":"Refactor auth","progress":0.4}'
# log (level: info | warn | error)
curl -s -X POST $E -H "$H" -d '{"type":"log","id":"bot-1","level":"error","message":"Test gagal 3/42"}'
# tugas selesai (confetti)
curl -s -X POST $E -H "$H" -d '{"type":"task_done","id":"bot-1","task":"Refactor auth"}'
# hapus agen
curl -s -X POST $E -H "$H" -d '{"type":"remove","id":"bot-1"}'

# Lt.3 Security
curl -s -X POST $E -H "$H" -d '{"type":"finding","id":"rexx","severity":"high","title":"SQL injection di /login"}'
curl -s -X POST $E -H "$H" -d '{"type":"alert","id":"sentra","severity":"critical","message":"Bruteforce SSH 412x/2 mnt","source_ip":"103.94.12.7"}'
curl -s -X POST $E -H "$H" -d '{"type":"metric","name":"failed_logins","value":37}'
```

- `status`: `working`, `thinking`, `waiting`, `idle`, `error`, `offline`. Variasi umum seperti `running`,
  `done`, `failed`, atau `needs_input` diterjemahkan otomatis.
- `severity`: `critical`, `high`, `medium`, `low`, `info`.
- Beberapa event sekaligus: kirim sebagai array JSON.

Format lengkapnya ada di `prd.md` bagian 7.

## 8. Daftar endpoint

Semua URL tersedia dalam dua bentuk: dengan awalan `/api` dan tanpa (sama seperti prototipe lama).

| Endpoint | Fungsi |
|---|---|
| `POST /api/event` atau `/event` | kirim event (bagian 7) dan rename (bagian 3) |
| `POST /api/hook` atau `/hook` | dipakai hooks Claude Code |
| `GET /api/stream` atau `/stream` | aliran data (SSE) untuk halaman kantor |
| `GET /api/agents` atau `/agents` | daftar agen |
| `GET /api/health` atau `/health` | status singkat (jumlah agen dan penonton) |
| `POST /api/cron` | perintah dari panel PAPAN JADWAL: jalankan, jeda, lanjutkan (hanya dari halaman Agent HQ sendiri) |
| `GET /api/cron/commands`, `POST /api/cron/result` | dipakai reporter jadwal Hermes (`docs/hermes.md` bagian 10) |
| `GET /api/hermes` | apakah chat Hermes aktif (`{"enabled": true}`) |
| `POST /api/hermes`, `GET /api/hermes/stream` | panel chat Hermes: kirim pesan, jawab izin, hentikan, percakapan baru (`docs/hermes.md` bagian 11) |
| `GET /api/terminal` | alamat terminal web untuk tombol Terminal (`{"url": ...}`, `docs/terminal.md`) |

Endpoint `/api/cron`, `/api/hermes`, dan `/api/terminal` hanya ada dengan awalan `/api` dan hanya di app Next.js
(tidak di `examples/server.js`). Chat Hermes hanya melayani halaman Agent HQ sendiri yang dibuka lewat `localhost`.

## 9. Keamanan

- Server hanya bisa diakses dari laptopmu (`127.0.0.1`).
- **Token (opsional):** jalankan server dengan `HQ_TOKEN=rahasia npm start`. Setelah itu, setiap `POST` harus
  membawa `Authorization: Bearer rahasia`. Untuk hook, jalankan Claude Code dengan `HQ_TOKEN` yang sama.
- **Sensor otomatis:** prompt dan perintah disensor sebelum ditampilkan, misalnya token, API key, password,
  `mysql -p...`, `curl -u user:pass`, dan password di URL.
- **Terminal web (opsional):** tombol Terminal hanya menampilkan ttyd yang jalan terpisah di `127.0.0.1` dengan
  password sendiri, dibuka lewat tunnel SSH. Agent HQ tidak menjalankan perintah dan tidak melihat isi terminal.
  Lihat `docs/terminal.md` bagian 7.
- **Batas Red Team:** fitur Red Team hanya memvisualisasikan. Agen pentest-mu hanya boleh menguji target milikmu
  sendiri atau yang sudah kamu kantongi izin tertulisnya.

## 10. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Kantor kosong, tidak ada karakter | Belum ada agen yang mengirim data. Pasang hook (bagian 2), atau pakai mode demo (bagian 6). |
| Sesi Claude Code tidak muncul | Cek `curl -s http://127.0.0.1:8787/health`. Pastikan hook terpasang dan URL-nya `http://127.0.0.1:8787/api/hook`. Kalau `HQ_TOKEN` di-set di server, set juga di shell tempat menjalankan `claude`. |
| `port 8787 already in use` | Server lain masih jalan (mungkin `examples/server.js` atau sesi `npm run dev` lain). Matikan dulu. |
| Nama agen kembali ke nama lama | Rename dilakukan lewat `agent_update` biasa. Pakai event `rename` (bagian 3). |
| Membuka lewat link artifact Claude | Browser memblokir koneksi ke server luar, jadi hanya mode demo yang jalan. Untuk data asli, buka `http://localhost:8787`. |

## 11. Untuk developer

```bash
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm test              # vitest: unit + integrasi bridge (integrasi butuh `npm run build` dulu)
npm run test:e2e      # Playwright: kemiripan visual dengan prototipe, kebocoran WebGL, console error
                      # kalau `npm run dev` sedang jalan: HQ_E2E_DEV_URL=http://localhost:8787 npm run test:e2e
npm run build:demo    # versi statis tanpa bridge (mode demo saja) ke folder out/
```

`out/` bisa disajikan server statis apa saja (misalnya `npx serve out`); halamannya langsung mode demo dan tidak
pernah memanggil bridge. Catatan: `build:demo` memakai folder `.next` yang sama dengan build server, jadi jalankan
`npm run build` lagi sebelum `npm start` atau `npm test`.

Struktur singkat:

```
app/          halaman dan route bridge (app/api/{event,hook,stream,health,agents})
components/   UI 2D (React + Tailwind)
engine/       scene 3D (Three.js murni): dunia, agen, navigasi, layar
lib/          event, tim, store, transport, demo, bridge/ (hub, hooks, sensor, rename)
examples/     setting hooks Claude Code, bridge mandiri server.js
references/   prototipe asli, hanya acuan (jangan diubah)
tests/        unit, integrasi, e2e
```

Dokumen lain:

- `prd.md`: spesifikasi lengkap (protokol event, integrasi Claude Code, dunia, perilaku agen).
- `plan-m1.md`: rencana port ke Next.js dan daftar perbedaan yang disengaja dari prototipe.
- `docs/hermes.md`: menyambungkan Hermes Agent di VPS Ubuntu (hook, MCP, papan jadwal, chat).
- `docs/terminal.md`: tombol Terminal, terminal server di samping kantor lewat ttyd.
- `CLAUDE.md`: aturan kerja untuk AI agent yang mengerjakan repo ini.

## 12. Musik, efek suara, dan event langit

**Musik latar (BGM):** diputar berulang dari `public/audio/agent-hq.mp3`. Untuk mengganti lagu, timpa file itu
dengan nama yang sama, atau arahkan ke file lain lewat env `NEXT_PUBLIC_HQ_BGM`, misalnya
`NEXT_PUBLIC_HQ_BGM=/audio/lagu.ogg npm run dev` (file-nya di `public/audio/lagu.ogg`).

**Tombol speaker** di kanan atas menyalakan atau mematikan semua suara. **Tombol roda gigi** membuka panel
Pengaturan berisi dua slider terpisah:

- **Musik:** volume lagu latar.
- **Efek suara:** volume portal, pesawat, dan meteor. Tombol **Tes** memutar contoh efek, jadi kamu bisa
  mengatur keras-pelannya tanpa menunggu event.

Menggeser slider saat suara mati langsung menyalakan suara. Tutup panel dengan Esc atau klik di luar panel.
Pilihanmu diingat browser. Suara mati secara default, dan browser baru mengizinkan suara setelah kamu mengklik
sesuatu di halaman. Efek suara melewati peredam lonjakan, jadi bunyi yang tiba-tiba keras ikut diredam. Kalau
file musik tidak ditemukan, efek suara tetap jalan (keterangannya muncul di panel Pengaturan).

**Event langit acak** muncul pertama kali 25 sampai 50 detik setelah halaman dibuka, lalu setiap 45 sampai
120 detik. Posisinya diacak di **kiri, tengah, atau kanan** layar (termasuk di atas gedung atau di bawah pulau
melayang), selalu jauh di belakang gedung, dan tidak pernah menembus planet, bulan, atau batu melayang. Event
tidak muncul di bawah panel, jadi kalau zona yang terpilih tertutup panel, event pindah ke zona lain:

- **Portal:** gerbang cincin pink-cyan terbuka jauh di latar belakang. Pesawat kurir kecil (pilotnya bermata
  satu) keluar dan terbang menjauh ke luar angkasa, lalu gerbang menutup. Portal boleh sebagian tersembunyi di
  balik atap, seperti mengintip, tapi tidak pernah menabrak kantor. Suaranya lebih pelan karena jauh.
- **Meteor:** batu berekor api melintas dan jatuh di balik gedung, kadang berupa hujan 2 sampai 4 meteor.

Efek suaranya dibuat langsung di browser (Web Audio), jadi tidak ada file suara yang perlu dilisensi.

Di layar kecil, panel Daftar Agen menutupi langit kanan, jadi event lebih sering muncul di kiri. Zoom out
(scroll) memberi langit lebih banyak ruang. Mulai lebar 1440 px, kiri, tengah, dan kanan muncul hampir sama
sering.

Mau memicu event tanpa menunggu? Buka console DevTools di halaman kantor:

```js
agentHQ.engine.skyEvent("portal")            // atau "meteor"; tanpa argumen = acak
agentHQ.engine.skyEvent("portal", "right")   // pilih zona: "left", "center", "right"
agentHQ.engine.debug.skyZones("portal")      // dari sudut kamera sekarang, zona mana saja yang bisa dipakai
```

Desain portal, pesawat, dan meteor ada di `engine/skyEvents.ts`, aturan penempatannya di
`engine/skyPlacement.ts`, suara dan kontrolnya di `lib/audio.ts` dan `components/AudioControl.tsx`.
