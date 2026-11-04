# Agent HQ + Hermes Agent di VPS Ubuntu

Panduan ini menyambungkan [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) yang jalan
di VPS Ubuntu ke Agent HQ, supaya setiap sesi Hermes tampil sebagai karakter di kantor. Ini termasuk sesi CLI
lewat SSH maupun sesi gateway seperti Telegram dan Discord.

Ada tiga bagian. Installer memasang ketiganya, dan memang paling bagus dipakai bersama:

| | Hook | MCP | Reporter jadwal |
|---|---|---|---|
| Yang melapor | Hermes, otomatis di setiap event | AI-nya sendiri, saat ia memanggil tool | service kecil di samping Hermes |
| Isinya | kerja, mikir, butuh kamu, error, bubble aksi, confetti, subagen | progres, catatan penting, temuan Red Team, alert SOC, metrik login gagal | jadwal cron Hermes di PAPAN JADWAL, plus tombol jalankan, jeda, lanjutkan |
| File | `examples/hermes/hq_hook.py` | `examples/hermes/hq_mcp.py` | `examples/hermes/hq_cron.py` |

Kalau hook dan MCP jalan di proses Hermes yang sama, laporan MCP masuk ke karakter yang sama dengan hook.
Satu sesi Hermes tetap satu karakter.

Opsional: **chat Hermes** (bagian 11), panel di Agent HQ untuk mengobrol dan memberi perintah ke Hermes langsung
dari kantor. Dipasang dengan `install.py --chat`. Juga opsional: **terminal VPS** di samping kantor lewat ttyd,
lihat `docs/terminal.md`.

## Isi

1. [Pilih tempat Agent HQ](#1-pilih-tempat-agent-hq)
2. [Siapkan VPS dan pasang Hermes](#2-siapkan-vps-dan-pasang-hermes)
3. [Jalankan Agent HQ di VPS](#3-jalankan-agent-hq-di-vps)
4. [Tonton dari laptop](#4-tonton-dari-laptop)
5. [Opsi B: Agent HQ di laptop](#5-opsi-b-agent-hq-di-laptop)
6. [Pasang adapter Hermes](#6-pasang-adapter-hermes)
7. [Izinkan hook dan cek](#7-izinkan-hook-dan-cek)
8. [Ajari AI memakai tool MCP](#8-ajari-ai-memakai-tool-mcp)
9. [Yang terlihat di kantor](#9-yang-terlihat-di-kantor)
10. [Papan Jadwal (cron Hermes)](#10-papan-jadwal-cron-hermes)
11. [Chat Hermes](#11-chat-hermes)
12. [Pengaturan](#12-pengaturan)
13. [Pasang manual](#13-pasang-manual)
14. [Masalah umum](#14-masalah-umum)
15. [Update dan mencopot](#15-update-dan-mencopot)
16. [Cara kerjanya](#16-cara-kerjanya)

## 1. Pilih tempat Agent HQ

| | **A. Agent HQ di VPS (disarankan)** | B. Agent HQ di laptop |
|---|---|---|
| Hermes mengirim ke | `127.0.0.1:8787` di VPS itu sendiri | `127.0.0.1:8787` di VPS, diteruskan ke laptop lewat tunnel |
| Cara menonton | `ssh -L` dari laptop, lalu buka `http://localhost:8787` | buka `http://localhost:8787` di laptop |
| Saat laptop mati | kantor tetap jalan, status agen dan jadwal tetap tercatat | event Hermes terbuang dan PAPAN JADWAL terputus (Hermes dan jadwalnya tetap jalan normal) |
| Kebutuhan VPS | Node.js 20+ dan pm2, RAM 2 GB untuk build (atau swap) | cukup `python3` |

Di kedua opsi, Agent HQ hanya mendengar di `127.0.0.1`. Port 8787 **tidak** dibuka ke internet; semua lewat SSH.

Opsi A:

```
VPS Ubuntu                                                        Laptop
┌──────────────────────────────────────────────────┐
│ Hermes ─ hq_hook.py ─ POST /api/hook ──┐         │
│        └ hq_mcp.py  ─ POST /api/event ─┤         │
│ hq_cron.py ─ jadwal dan perintah ──────┤         │
│ API Hermes :8642 ◄─ chat (opsional) ───┤         │
│                                        ▼         │
│                     Agent HQ 127.0.0.1:8787 ◄────┼── ssh -L 8787 ── browser localhost:8787
└──────────────────────────────────────────────────┘
```

Langkah singkat opsi A: bagian 2, 3, 4, 6, 7. Opsi B: bagian 2, 5, 6, 7. Jadwal cron dan tombolnya ada di bagian 10, chat Hermes di bagian 11.

## 2. Siapkan VPS dan pasang Hermes

Ubuntu 22.04 atau 24.04. Pakai user biasa dengan `sudo`, bukan root, dan jalankan Hermes, installer adapter,
dan Agent HQ sebagai user yang sama.

```bash
sudo apt update && sudo apt install -y git curl python3
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc
hermes          # jalankan sekali dan ikuti setup awal (model, API key)
```

Adapter hanya memakai Python bawaan Ubuntu, tanpa `pip install`. Hermes yang dibutuhkan versi yang sudah
punya shell hooks (v2026.4.18 ke atas).

Mau Hermes jalan 24 jam (Telegram, Discord, dan lain-lain), atau memakai jadwal cron Hermes? Pasang gateway
sebagai service. Jadwal cron dijalankan di dalam gateway, jadi tanpa gateway jadwal agen tidak pernah jalan:

```bash
hermes gateway setup                 # pilih platform chat
hermes gateway install               # service systemd milik user
sudo loginctl enable-linger $USER    # tetap jalan setelah logout SSH
hermes gateway start
```

## 3. Jalankan Agent HQ di VPS

Lewati bagian ini kalau memakai opsi B. Agent HQ dijalankan dengan **pm2** lewat `start.sh` di folder repo.

**Node.js dan pm2.** Butuh Node.js 20 atau lebih baru. Versi `apt` bawaan Ubuntu terlalu lama, jadi pakai
NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

**Ambil repo dan jalankan:**

```bash
git clone https://github.com/JuliAstaa/agent-hq.git ~/agent-hq
cd ~/agent-hq
./start.sh
```

`start.sh` menghentikan proses pm2 `agent-hq` yang lama kalau ada, menjalankan `git pull`, `npm install`, dan
`npm run build`, lalu menyalakan `next start -H 127.0.0.1 -p 8787` di pm2 dengan nama `agent-hq`. Proses itu
di-restart otomatis kalau memakai lebih dari 800 MB. Untuk update, jalankan script yang sama lagi. Kalau
`git clone` ditolak (repo privat), pakai token GitHub atau deploy key.

**Cek:**

```bash
pm2 ls                                       # agent-hq: online
curl -s http://127.0.0.1:8787/api/health     # {"ok":true,...}
pm2 logs agent-hq                            # log berjalan, Ctrl+C untuk keluar
```

**Tetap jalan setelah VPS reboot.** pm2 tidak otomatis menyala saat boot. Siapkan sekali:

```bash
pm2 startup     # mencetak satu perintah sudo: salin dan jalankan perintah itu
pm2 save        # simpan daftar proses pm2
```

`start.sh` menghapus lalu membuat ulang proses `agent-hq`, jadi jalankan `pm2 save` lagi setiap selesai
`./start.sh`.

**Pakai satu pm2 saja.** pm2 milik root (`sudo pm2`) dan pm2 milik user adalah dua daemon terpisah, dan
masing-masing punya daftar proses sendiri. Kalau keduanya menjalankan `agent-hq`, yang kedua gagal karena port
8787 sudah dipakai. Jalankan `start.sh`, `pm2`, dan `pm2 startup` sebagai user yang sama, sebaiknya user biasa
tanpa `sudo`. Cek keduanya dengan `pm2 ls` dan `sudo pm2 ls`. Untuk pindah dari pm2 root ke user biasa:

```bash
sudo pm2 delete agent-hq && sudo pm2 save
sudo chown -R $USER:$USER ~/agent-hq     # file yang sempat dibuat root (node_modules, agent-hq-names.json)
./start.sh && pm2 startup                # lalu jalankan perintah sudo yang dicetak, kemudian:
pm2 save
```

`next start` di sini hanya mendengar di `127.0.0.1:8787`. Jangan membuka port 8787 di `ufw` atau firewall
penyedia VPS.

**RAM.** Build Next.js butuh sekitar 2 GB RAM. Kalau `free -h` menunjukkan kurang dari itu, atau build berhenti
dengan `Killed`, tambahkan swap dulu:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**VPS kecil (RAM 1 GB)?** Ada bridge mandiri tanpa build. Isinya halaman prototipe dengan fitur bridge yang
sama: dari folder repo, jalankan `pm2 start examples/server.js --name agent-hq` (tanpa `start.sh`). Bridge ini
tidak punya PAPAN JADWAL dan kontrolnya (bagian 10).

**Token (opsional):** di VPS yang dipakai bersama orang lain, jalankan `HQ_TOKEN=<rahasia> ./start.sh` (pm2
menyimpan env saat start), lalu isi `HQ_TOKEN` yang sama di `agent-hq.env` (bagian 12) dan restart reporter
jadwal. Akibatnya, ganti nama dari tombol ✎ di kartu agen ditolak, jadi pakai `curl` dengan token (README
bagian 3), dan panel jadwal serta chat Hermes meminta token itu sekali per tab browser.

## 4. Tonton dari laptop

Buka tunnel dari laptop (PowerShell Windows, macOS, atau Linux), biarkan jalan selama menonton:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@ip-vps
```

Lalu buka **http://localhost:8787** di browser laptop. Halaman otomatis tersambung ke data asli dari VPS, dan
tombol di panel jadwal (bagian 10) juga jalan lewat tunnel ini.

Kalau port 8787 di laptop sudah terpakai (misalnya Agent HQ lokal sedang jalan), pakai port lain:
`ssh -N -L 9787:127.0.0.1:8787 user@ip-vps`, lalu buka `http://localhost:9787`.

Saat tunnel ditutup, kantor di VPS tetap jalan. Begitu dibuka lagi, halaman langsung menampilkan status semua
agen dan log terakhir.

Memakai tombol Terminal (`docs/terminal.md`)? Teruskan port terminal di tunnel yang sama:
`ssh -N -L 8787:127.0.0.1:8787 -L 7681:127.0.0.1:7681 user@ip-vps`.

## 5. Opsi B: Agent HQ di laptop

Jalankan Agent HQ di laptop seperti biasa (README bagian 1). Lalu buka reverse tunnel dari laptop. Dengan
tunnel ini, `127.0.0.1:8787` di VPS diteruskan ke Agent HQ di laptop:

```bash
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 8787:127.0.0.1:8787 user@ip-vps
```

Cek dari VPS: `curl -s http://127.0.0.1:8787/api/health`.

- Event Hermes hanya sampai selama tunnel terbuka. Saat tunnel putus, hook diam dan mencoba lagi tiap 20 detik,
  dan Hermes tetap jalan normal.
- Reporter jadwal di VPS juga lewat tunnel ini. Saat tunnel putus, PAPAN JADWAL menulis `TERPUTUS` dan tombolnya
  mati, tapi jadwal Hermes tetap jalan. Begitu tunnel tersambung lagi, papan pulih sendiri dalam beberapa detik.
- Kalau port 8787 di VPS sudah terpakai, pakai `-R 9787:127.0.0.1:8787` dan pasang adapter dengan
  `--url http://127.0.0.1:9787`.
- Tanpa repo di VPS, salin foldernya saja dari laptop: `scp -r examples/hermes user@ip-vps:~/agent-hq-hermes`.

## 6. Pasang adapter Hermes

Di VPS, sebagai user yang menjalankan Hermes:

```bash
python3 ~/agent-hq/examples/hermes/install.py          # opsi B tanpa repo: python3 ~/agent-hq-hermes/install.py
```

Yang dilakukan installer:

- Menyalin `hq_common.py`, `hq_hook.py`, `hq_mcp.py`, `hq_cron.py` ke `~/.hermes/agent-hq/`. Setelah itu Hermes
  tidak bergantung lagi pada folder repo.
- Membuat `~/.hermes/agent-hq/agent-hq.env` (alamat Agent HQ, nama default, token) kalau belum ada.
- Menambahkan 13 hook dan server MCP `agent_hq` ke `~/.hermes/config.yaml`. Sebelumnya config disalin ke
  `config.yaml.agent-hq-<waktu>.bak`, dan hasil gabungannya diperiksa dengan parser YAML. Setting lain tidak
  disentuh.
- Menyalakan reporter jadwal sebagai service systemd user `agent-hq-cron` (bagian 10), dan mengingatkan kalau
  linger belum aktif.
- Mengetes koneksi ke Agent HQ.

| Pilihan | Fungsi |
|---|---|
| `--no-mcp` | hook saja |
| `--no-hooks` | MCP saja |
| `--no-cron` | tanpa reporter jadwal (PAPAN JADWAL tetap tersembunyi) |
| `--no-service` | salin `hq_cron.py` tanpa memasang service; jalankan sendiri |
| `--url http://127.0.0.1:9787` | alamat Agent HQ lain (disimpan di `agent-hq.env`) |
| `--print` | salin file saja, tampilkan blok `config.yaml`, jangan ubah config |
| `--hermes-home <folder>` | folder Hermes lain (default `$HERMES_HOME` atau `~/.hermes`) |
| `--chat` | juga nyalakan API server Hermes untuk panel chat (bagian 11) |
| `--agent-hq-dir <folder>` | folder Agent HQ untuk `.env.local` chat (default: repo tempat installer ini) |

Installer aman dijalankan ulang: file disalin ulang, blok yang sudah ada dibiarkan, dan reporter jadwal
di-restart dengan kode baru. Kalau keluar pesan
**perlu digabung manual**, berarti event itu sudah punya hook lain. Tambahkan entri yang dicetak installer ke
daftar event itu sendiri.

## 7. Izinkan hook dan cek

Hermes meminta izin satu kali untuk setiap hook baru, dan itu hanya terjadi di sesi `hermes` interaktif.
**Gateway tidak pernah bertanya**, jadi hook yang belum diizinkan dilewati diam-diam. Karena itu, izinkan dulu
lewat sesi interaktif:

```bash
hermes                     # jawab ya untuk tiap hook hq_hook.py (13 kali, disimpan permanen)
hermes gateway restart     # kalau memakai gateway: muat ulang config, hook, dan MCP
```

Pilihan izin disimpan di `~/.hermes/shell-hooks-allowlist.json` dan ikut berlaku untuk gateway. Cara lain:
tulis `hooks_auto_accept: true` di `config.yaml`. Cara ini berlaku untuk semua hook, jadi pakai hanya kalau kamu
percaya seluruh isi config.

**Nama karakter.** Gateway jalan sebagai service, jadi tidak membawa env dari shell. Tulis nama default di
`~/.hermes/agent-hq/agent-hq.env`:

```bash
HQ_NAME=Rexx
HQ_TEAM=red            # red, report, blue, atau kosong
```

Untuk sesi CLI, nama per sesi bisa lewat env: `HQ_NAME=Quill HQ_TEAM=report hermes`. Nama juga bisa diganti
kapan saja dari tombol ✎ di kartu agen, dan perubahan itu permanen. Tanpa nama, karakter tampil sebagai
`<folder>#xxxx`. Karakter dari jadwal cron tidak memakai `HQ_NAME`, tapi nama jadwalnya (bagian 10).

**Cek:**

```bash
hermes hooks list                                     # 13 hook hq_hook.py beserta status izinnya
hermes hooks doctor                                   # cek izin dan file hook
hermes mcp test agent_hq                              # server MCP menjawab
hermes hooks test pre_tool_call --for-tool terminal   # karakter muncul dengan status kerja
systemctl --user status agent-hq-cron                 # reporter jadwal: active (running)
python3 ~/.hermes/agent-hq/hq_cron.py --once          # jadwal yang dikirim ke kantor, tanpa jaringan
```

Tes adapter tanpa Hermes. Dengan `--dry-run` permintaannya hanya dicetak. Tanpa `--dry-run` benar-benar dikirim:
karakter `tmp#xxxx` muncul, dan kalau gagal, pesan errornya tampil di terminal.

```bash
E='{"hook_event_name":"pre_tool_call","session_id":"tes","cwd":"/tmp","tool_name":"terminal","tool_input":{"command":"ls"}}'
echo "$E" | python3 ~/.hermes/agent-hq/hq_hook.py --dry-run
echo "$E" | python3 ~/.hermes/agent-hq/hq_hook.py
```

Setelah itu kirim prompt ke Hermes, lewat CLI atau chat gateway. Karakter muncul begitu giliran pertama dimulai,
karena Hermes baru melapor awal sesi saat itu.

## 8. Ajari AI memakai tool MCP

Hook jalan otomatis. Tool MCP hanya dipakai kalau AI memutuskan memanggilnya. Server MCP sudah mengirim
petunjuk, tapi belum tentu Hermes meneruskannya ke model. Supaya konsisten, tambahkan aturan ini ke file
konteks Hermes: `~/.hermes/SOUL.md` untuk semua sesi termasuk gateway, atau file konteks project. Hermes hanya
memuat satu file konteks project, yaitu yang pertama ada dari `.hermes.md`, `AGENTS.md`, lalu `CLAUDE.md`.

```markdown
## Agent HQ
Kamu tampil sebagai karakter di Agent HQ. Aktivitas tool biasa sudah terlapor otomatis.
- Mulai pekerjaan multi-langkah: panggil hq_status (task singkat, progress 0 sampai 1). Ulangi di tiap milestone.
- Temuan keamanan: hq_finding. Aktivitas mencurigakan: hq_alert. Jumlah login gagal per menit: hq_metric.
- Hasil penting: hq_log. Pekerjaan selesai: hq_done, sekali saja.
- Jangan menulis rahasia (token, password). Kalau laporan gagal, lanjutkan tanpa mengulang.
```

Di Hermes, nama tool-nya diberi awalan server, misalnya `mcp_agent_hq_hq_status`.

| Tool | Untuk | Tampil di |
|---|---|---|
| `hq_status` | status, task, progres | bubble dan kartu agen |
| `hq_log` | satu baris catatan (info, warn, error) | Log Aktivitas |
| `hq_done` | pekerjaan selesai | confetti (MCP saja) atau baris log (dengan hook, karena hook sudah memicu confetti) |
| `hq_finding` | temuan keamanan | Red Team Lab (node merah) dan papan Laporan VA, Lt.3 |
| `hq_alert` | alert keamanan | SOC Blue Team: sirene, ruangan berkedip merah |
| `hq_metric` | login gagal per menit | grafik SOC |

Node di peta Red Team dipilih dari judul temuan: `ssh` ke SSH; `db`, `database`, `mysql`, `postgres`, `redis` ke
DB; `api` atau `idor` ke API; `admin`, `panel`, `wp-` ke ADMIN; selain itu WEB.

Agen Blue Team di VPS bisa memakai `hq_alert` dan `hq_metric` untuk melaporkan percobaan login ke VPS itu
sendiri, misalnya dari `journalctl -u ssh` atau `fail2ban`.

Semua teks dari tool MCP disensor dulu (token, API key, password, `user:pass` di URL) sebelum dikirim. Fitur
Red Team hanya memvisualisasikan. Agen pentest-mu hanya boleh menguji target milikmu sendiri atau yang sudah
kamu kantongi izin tertulisnya.

## 9. Yang terlihat di kantor

| Yang terjadi di Hermes | Yang kamu lihat |
|---|---|
| Prompt masuk (CLI atau chat gateway) | Karakter mikir. Kalau sedang santai, kartu tugas muncul di Papan Tugas (Lt.2) dan karakter mengambilnya |
| Tool jalan | Karakter kerja, bubble menampilkan aksinya: `$ npm test`, `Baca app.py`, `Edit cart.py`, `Search: ...` |
| Tool gagal (exit code bukan 0, atau error) | Baris log kuning, misalnya `Bash gagal: exit code 1` |
| Hermes minta izin menjalankan perintah berbahaya | Melambai, status oranye "Butuh kamu" |
| Hermes bertanya ke kamu (clarify, password sudo) | "Butuh kamu" |
| Jawaban akhir | Confetti, lalu jalan ke area santai |
| Giliran dihentikan | Santai, "Menunggu prompt berikutnya" |
| Giliran gagal tanpa jawaban | Error: merah dan berasap |
| `delegate_task` (subagen) | Karakter baru dengan nama dari tujuannya, pergi sekitar 45 detik setelah selesai |
| Keluar dari Hermes, `/new`, atau sesi gateway ditutup | Offline, hilang setelah 5 menit |
| Jadwal cron jalan | Karakter bernama sesuai jadwal (peran `Cron · <jadwal>`), offline begitu selesai, hilang 5 menit kemudian. Jadwalnya sendiri tampil di PAPAN JADWAL (bagian 10) |
| Pesan dari panel chat Hermes | Sesi chat itu tampil sebagai karakter, sama seperti sesi gateway (bagian 11) |

Tool Hermes yang dikenali: `terminal`, `read_file`, `write_file`, `patch`, `search_files`, `session_search`,
`web_search`, `web_extract`, `browser_navigate`, `delegate_task`, `todo`, `skill_view`, `skills_list`. Tool lain
tampil dengan namanya sendiri.

- **Gateway:** setiap sesi chat jadi satu karakter. Kalau `HQ_NAME` diisi, semuanya memakai nama itu. Bedakan
  lewat ✎, atau kosongkan `HQ_NAME` supaya tiap sesi bernama `<folder>#xxxx`. Server MCP di gateway dipakai
  bersama semua sesi, jadi laporannya masuk ke sesi yang terakhir aktif.
- **Token** di kartu agen tetap kosong untuk Hermes, karena Agent HQ membaca token dari transcript Claude Code.

## 10. Papan Jadwal (cron Hermes)

Jadwal cron Hermes tampil di **PAPAN JADWAL**, papan gelap di dinding belakang Lt.2, di kanan jam dinding. Papan
ini muncul begitu reporter jadwal (`hq_cron.py`) tersambung, dan tersembunyi kalau tidak ada reporter.

- **Isi papan:** maksimal 5 jadwal, masing-masing dengan titik warna status, nama, jadwalnya (`0 9 * * *`,
  `every 30m`), dan hitung mundur ke jalan berikutnya. Jadwal yang sedang jalan berkedip hijau, dan lonceng di
  atas papan berbunyi. Pojok kanan atas menunjukkan `AKTIF` (scheduler Hermes jalan), `SCHEDULER MATI` (gateway
  mati, jadwal agen tidak akan jalan), atau `TERPUTUS` (tidak ada kabar dari reporter selama 90 detik).
- **Panel kontrol:** klik papannya di tampilan Lt.2 Kantor, atau tombol **Jadwal** di kanan atas. Tiap jadwal
  punya tombol:
  - **Jalankan sekarang** (`hermes cron run <id>`): mulai di tick berikutnya, paling lama 1 menit. Perlu dua kali
    klik, karena setiap jalan memakai token model.
  - **Jeda** dan **Lanjutkan** (`hermes cron pause|resume <id>`).

  Hasilnya muncul di panel, di Log Aktivitas (dengan nama `Jadwal`), dan sebagai notifikasi. Tombol hanya aktif
  kalau halaman tersambung ke Agent HQ itu sendiri lewat `/api/stream` (misalnya lewat tunnel di bagian 4),
  reporter tersambung, dan perintah sebelumnya untuk jadwal itu sudah selesai. Di mode demo panel hanya bisa dilihat.
- **Saat jadwal jalan**, sesi cron Hermes tampil sebagai karakter bernama sesuai jadwalnya, dengan peran
  `Cron · <jadwal>`. Ia mengambil kartu di Papan Tugas, bekerja, merayakan dengan confetti, lalu offline dan hilang
  5 menit kemudian. Bagian ini butuh hook yang terpasang (bagian 6) dan sudah diizinkan (bagian 7). Jadwal yang
  sangat sering (misalnya tiap menit) membuat banyak karakter sekaligus, padahal meja kantor maksimal 9.
- **Membuat, mengubah, dan menghapus** jadwal tetap lewat Hermes (`/cron` di chat atau `hermes cron create`).
  Dari kantor hanya bisa jalankan, jeda, dan lanjutkan.

| Warna titik | Status |
|---|---|
| hijau berkedip | Jalan |
| kuning | Segera (kurang dari 1 menit) |
| biru | Terjadwal |
| merah | Gagal (jalan terakhir gagal) |
| abu-abu | Jeda |
| ungu | Selesai (jadwal sekali jalan) |

**Reporter jadwal** dipasang installer (bagian 6) sebagai service systemd milik user, di samping service
`hermes-gateway`. Seperti gateway, ia butuh linger (`sudo loginctl enable-linger $USER`) agar tetap jalan setelah
logout SSH.

```bash
systemctl --user status agent-hq-cron      # jalan?
journalctl --user -u agent-hq-cron -f      # log, termasuk setiap perintah dari kantor
systemctl --user restart agent-hq-cron     # setelah mengubah agent-hq.env
```

Tanpa systemd, jalankan `python3 ~/.hermes/agent-hq/hq_cron.py` lewat pm2 atau tmux, sebagai user Hermes.
Dengan `HQ_DISABLE=1` reporter berhenti sendiri dan tetap berhenti. Setelah menghapusnya, jalankan
`systemctl --user restart agent-hq-cron`.

**Keamanan kontrol:**

- Agent HQ sendiri tidak menjalankan apa pun. Ia hanya meneruskan perintah ke reporter. Reporter mengecek ulang
  (aksinya diizinkan, jadwalnya ada di Hermes), lalu menjalankan `hermes cron` sebagai user Hermes, tanpa shell.
- `/api/cron` menolak permintaan dari situs lain yang terbuka di browser yang sama: ia mengecek `Origin` dan
  `Sec-Fetch-Site` dan tidak memberi header CORS. Jadi halaman web lain tidak bisa memicu jadwal lewat tunnel
  `localhost:8787`.
- Kalau Agent HQ memakai `HQ_TOKEN`, panel meminta token sekali dan menyimpannya hanya untuk tab itu. Reporter
  memakai token yang sama dari `agent-hq.env`.
- Prompt jadwal tidak pernah dikirim ke Agent HQ. Nama dan pesan error disensor dulu, dan tujuan pengiriman hanya
  dikirim nama platformnya (tanpa ID chat).
- Mau lihat saja tanpa kontrol? Set `HQ_CRON_CONTROLS=none` di `agent-hq.env`, lalu restart reporter.

## 11. Chat Hermes

Panel **HERMES** di Agent HQ dipakai untuk mengobrol dan memberi perintah ke Hermes langsung dari kantor, sambil
melihat karakternya bekerja. Hasilnya sama seperti menjalankan `hermes` lewat SSH: Hermes memakai semua tool-nya
(terminal, file, web) di VPS.

**Pasang** di VPS, sebagai user Hermes:

```bash
python3 ~/agent-hq/examples/hermes/install.py --chat   # boleh sekalian dengan pemasangan biasa
hermes gateway restart                                  # API server Hermes mulai di 127.0.0.1:8642
pm2 restart agent-hq                                    # Agent HQ membaca .env.local
```

Installer mengisi dua file. Keduanya hanya bisa dibaca pemiliknya (`chmod 600`):

| File | Isi |
|---|---|
| `~/.hermes/.env` | `API_SERVER_ENABLED=true` dan `API_SERVER_KEY` acak. Kunci yang sudah ada tetap dipakai. Cadangan: `.env.agent-hq-<waktu>.bak` |
| `~/agent-hq/.env.local` | `HQ_HERMES_API_URL=http://127.0.0.1:8642` dan `HQ_HERMES_API_KEY` (sama dengan `API_SERVER_KEY`) |

Kunci tidak pernah dicetak installer dan tidak pernah dikirim ke browser. Cek API server-nya dengan
`curl -s http://127.0.0.1:8642/health`.

**Pakai:** buka Agent HQ lewat tunnel (bagian 4), lalu klik tombol **Hermes** di kanan atas. Tombol ini hanya
muncul kalau Agent HQ punya `HQ_HERMES_API_KEY`.

- Tulis pesan, lalu Enter untuk kirim (Shift+Enter untuk baris baru). Jawaban Hermes muncul sambil ditulis. Tiap
  tool tampil sebagai baris kecil dengan titik kuning (jalan), hijau (selesai), atau merah (gagal).
- **Hentikan** menghentikan pekerjaan yang sedang jalan.
- Panel boleh ditutup dan halaman boleh di-reload: Hermes tetap bekerja, dan percakapan tampil lagi saat panel
  dibuka. Setelah Agent HQ restart, sesi `Agent HQ` yang terakhir dipakai dilanjutkan.
- Sesi diberi judul dari pesan pertamanya, misalnya `Agent HQ · cek disk penuh` (judul di Hermes harus unik,
  jadi kalau sudah dipakai, jamnya ditambahkan).

**Banyak sesi, satu memori.** Satu sesi terbuka pada satu waktu, tapi sesi lama tetap bisa dilanjutkan:

- **Baru** membuka form **Sesi baru**: Nama, Peran, Tim (Kantor, Red Team, Laporan VA, Blue Team), dan Model.
  Setelah **Mulai sesi**, Hermes langsung membuat sesinya dan agen baru masuk ke kantor, meski hook belum
  dipasang. Kosongkan Nama, Peran, dan Tim untuk agen "Hermes" biasa.
- Nama, peran, dan tim disimpan seperti rename di Daftar Agen (`agent-hq-names.json`), jadi event hook tidak
  menimpanya. Karakternya memakai id yang sama dengan hook (`cc-` + 8 karakter SHA-1 id sesi), jadi chat dan hook
  menggerakkan karakter yang sama.
- Nama dan peran juga diberitahukan ke Hermes di setiap pesan sesi itu, lewat `system_message`. Hermes
  menambahkannya ke system prompt untuk pesan itu saja; memori, skill, dan transkrip tidak diubah.
- **Riwayat** menampilkan sesi API server, yang terakhir dipakai paling atas, dengan potongan pesan terakhir.
  **Buka** melanjutkan sesi (riwayat, model, dan agennya ikut), **Ganti nama** mengganti judulnya, **Hapus**
  menghapus sesi dari Hermes beserta agen dan namanya. Pindah sesi hanya bisa saat Hermes tidak sedang bekerja.
  Agen sesi yang ditinggalkan keluar dari kantor, dan masuk lagi saat sesinya dibuka.
- Sesi CLI, Telegram, dan Discord tidak muncul di Riwayat. Hermes hanya mengizinkan API server melanjutkan sesi
  buatannya sendiri (sesi lain ditolak dengan `409 permission_denied`).
- **Memori Hermes** (MEMORY.md, USER.md), skill, dan `session_search` berlaku untuk semua sesi, termasuk sesi
  dari CLI dan Telegram. Jadi sesi baru tetap tahu apa yang dipelajari Hermes di sesi lama, dan makin sering
  dipakai, makin banyak yang diingat. Di bawah pemilih model, panel menunjukkan apakah toolset `memory` dan
  `session_search` menyala untuk API server (dibaca dari `GET /v1/toolsets`). Kalau mati, nyalakan:

  ```bash
  hermes tools enable memory session_search --platform api_server
  hermes gateway restart   # kalau pesan berikutnya belum memakainya
  ```

- Kalau konteks sesi yang panjang dipadatkan (compression) dan Hermes memindahkan percakapan ke id sesi baru,
  panel ikut pindah, bersama agen, namanya, dan modelnya.

**Model per sesi.** Pemilih **Model** di atas percakapan berlaku untuk sesi yang terbuka, mulai pesan
berikutnya. **Default Hermes** memakai model dari config Hermes. Daftarnya diambil dari `GET /api/model/options`
Hermes (hanya provider yang sudah login) dan disimpan sementara selama 1 menit. Pilihan disimpan per sesi di
`agent-hq-hermes.json` (bisa diganti dengan `HQ_HERMES_CHAT_FILE`), jadi tetap berlaku setelah Agent HQ restart.
**Terakhir dijawab** menunjukkan model yang benar-benar menjawab. Hermes versi lama tanpa route itu menampilkan
"Daftar model" kosong; pakai `hermes model` di SSH.
- **Izin perintah berbahaya.** Kalau approval Hermes menyala (`approvals.mode: smart` atau `manual` di
  `~/.hermes/config.yaml`), perintah seperti `rm -r` memunculkan kartu **Hermes minta izin** dengan tombol
  Izinkan sekali, Izinkan sesi ini, Selalu izinkan, dan Tolak. Dengan `approvals.mode: off`, Hermes menjalankan
  semuanya tanpa bertanya, termasuk perintah dari panel ini. Pakai `smart` atau `manual` kalau panel dibuka dari
  HP atau dipakai orang lain.
- Teks yang mirip rahasia (token, password, kunci) disamarkan jadi `***` di panel, sama seperti di log. Hermes
  tetap menerima pesanmu apa adanya.
- Panel ini untuk percakapan, perintah biasa, dan memilih model. Pengaturan Hermes lain (skill, slash command,
  toolset) tetap lewat `hermes` di SSH.

**Keamanan.** Pesan ke Hermes setara dengan akses terminal ke VPS, jadi chat dijaga lebih ketat dari kontrol jadwal:

- Kunci API Hermes hanya ada di server Agent HQ. Browser bicara ke `/api/hermes` dan `/api/hermes/stream`, lalu
  Agent HQ meneruskannya ke `127.0.0.1:8642`.
- Permintaan dari situs lain di browser yang sama ditolak (`Origin`, `Sec-Fetch-Site`, tanpa CORS), dan aksi
  harus berupa JSON.
- Chat hanya dilayani untuk alamat `localhost`, `127.0.0.1`, atau `[::1]`, yaitu lewat tunnel SSH. Ini juga
  menutup serangan DNS rebinding (situs jahat yang namanya diarahkan ke `127.0.0.1`).
- Membuka Agent HQ lewat domain (reverse proxy)? Daftarkan nama host-nya di `HQ_ALLOWED_HOSTS`, dan `HQ_TOKEN`
  **wajib** diisi. Tanpa token, chat menolak semua permintaan dari host itu. Panel meminta token sekali per tab.
- Jangan buka port 8642 ke internet. Biarkan `API_SERVER_HOST` kosong atau `127.0.0.1`.

Pengaturan chat ada di `.env.local` Agent HQ (bukan di `agent-hq.env`). Setelah mengubahnya, jalankan
`pm2 restart agent-hq`.

| Variabel | Default | Fungsi |
|---|---|---|
| `HQ_HERMES_API_KEY` | kosong | sama dengan `API_SERVER_KEY` Hermes; kosong berarti chat mati dan tombolnya tersembunyi |
| `HQ_HERMES_API_URL` | `http://127.0.0.1:8642` | alamat API server Hermes |
| `HQ_ALLOWED_HOSTS` | kosong | nama host selain localhost yang boleh memakai chat, dipisah koma (butuh `HQ_TOKEN`) |
| `HQ_HERMES_CHAT_FILE` | `agent-hq-hermes.json` di folder Agent HQ | file model yang dipilih per sesi |

## 12. Pengaturan

Semua pengaturan ada di `~/.hermes/agent-hq/agent-hq.env`. Env var dengan nama sama selalu menang, tapi env
dari shell hanya sampai ke sesi CLI, tidak ke gateway dan tidak ke server MCP. Jadi di VPS, isi file ini.

| Variabel | Default | Fungsi |
|---|---|---|
| `HQ_URL` | `http://127.0.0.1:8787` | alamat Agent HQ, tanpa `/api` |
| `HQ_TOKEN` | kosong | isi kalau Agent HQ dijalankan dengan `HQ_TOKEN` |
| `HQ_NAME` | `<folder>#xxxx` | nama karakter (huruf Latin; nama lain lewat ✎) |
| `HQ_ROLE` | `Hermes · <folder>` | peran di kartu agen |
| `HQ_TEAM` | kosong | `red`, `report`, `blue`: agen pindah ke ruangannya di Lt.3 |
| `HQ_TIMEOUT` | `1.5` | batas tunggu kirim ke Agent HQ, dalam detik |
| `HQ_ANNOUNCE` | mati | khusus MCP tanpa hook: karakter muncul begitu Hermes menyala |
| `HQ_DISABLE` | mati | `1` mematikan hook, MCP, dan reporter jadwal tanpa mengubah `config.yaml` |
| `HQ_STATE_DIR` | `~/.cache/agent-hq` | catatan sesi yang dipakai bersama hook dan MCP |
| `HQ_CRON_CONTROLS` | `run,pause,resume` | aksi yang boleh dari panel jadwal; `none` = lihat saja |
| `HQ_CRON_SOURCE` | `Hermes di <hostname>` | label sumber jadwal di panel |
| `HQ_HERMES_BIN` | dicari otomatis | path ke perintah `hermes` untuk reporter jadwal (installer mengisinya di service) |

Perubahan di file ini langsung berlaku untuk hook. Server MCP dan reporter jadwal membacanya saat mulai, jadi
jalankan `hermes gateway restart` (atau buka ulang `hermes`) dan `systemctl --user restart agent-hq-cron`.

Kalau Agent HQ tidak terjangkau, hook berhenti mengirim selama 20 detik lalu mencoba lagi. Hermes tetap jalan
normal.

**MCP saja** (dipasang dengan `--no-hooks`): nyalakan `HQ_ANNOUNCE=1` di `agent-hq.env` supaya karakter
langsung muncul saat Hermes menyala. Jangan nyalakan `HQ_ANNOUNCE` kalau hook juga terpasang, karena hasilnya
dua karakter untuk satu Hermes.

## 13. Pasang manual

Kalau tidak mau memakai installer:

```bash
mkdir -p ~/.hermes/agent-hq
cp ~/agent-hq/examples/hermes/{hq_common.py,hq_hook.py,hq_mcp.py,hq_cron.py} ~/.hermes/agent-hq/
cp ~/agent-hq/examples/hermes/agent-hq.env.example ~/.hermes/agent-hq/agent-hq.env
python3 ~/agent-hq/examples/hermes/install.py --print    # mencetak blok config.yaml dengan path yang benar
```

Bentuk bloknya (ganti `/home/kamu` dengan folder home-mu). Path harus lengkap, karena Hermes menjalankan hook
tanpa shell sehingga `~` tidak diterjemahkan:

```yaml
hooks:
  pre_tool_call:
    - command: "/usr/bin/python3 /home/kamu/.hermes/agent-hq/hq_hook.py"
      timeout: 5
  # ...ulangi dengan command yang sama untuk: on_session_start, pre_llm_call, post_tool_call,
  # post_llm_call, on_session_end, on_session_finalize, subagent_start, subagent_stop,
  # pre_approval_request, post_approval_response, on_human_input_request, on_human_input_resolved

mcp_servers:
  agent_hq:
    command: "/usr/bin/python3"
    args: ["/home/kamu/.hermes/agent-hq/hq_mcp.py"]
    timeout: 15
    connect_timeout: 15
```

Kalau `hooks:` atau `mcp_servers:` sudah ada di config, tambahkan isinya di bawah kunci yang sudah ada. Jangan
menulis kunci yang sama dua kali, karena kunci yang terakhir akan menimpa yang pertama.

Reporter jadwal sebagai service user, di `~/.config/systemd/user/agent-hq-cron.service`:

```ini
[Unit]
Description=Agent HQ: jadwal cron Hermes ke PAPAN JADWAL
After=network-online.target

[Service]
ExecStart="/usr/bin/python3" "/home/kamu/.hermes/agent-hq/hq_cron.py"
Environment="HERMES_HOME=/home/kamu/.hermes"
Environment="HQ_HERMES_BIN=/home/kamu/.local/bin/hermes"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Lalu `systemctl --user daemon-reload && systemctl --user enable --now agent-hq-cron`.

## 14. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Kantor tidak berubah sama sekali | Di VPS: `curl -s http://127.0.0.1:8787/api/health`. Kalau gagal, cek `pm2 ls` dan `pm2 logs agent-hq` (opsi A) atau tunnel `ssh -R` (opsi B). Kalau berhasil, cek `hermes hooks list` (izin), lalu tes kirim manual (bagian 7). |
| `agent-hq` di pm2 restart terus, log berisi `EADDRINUSE` | Port 8787 sudah dipakai, biasanya oleh `agent-hq` kedua di pm2 milik user lain. Cek `pm2 ls` dan `sudo pm2 ls`, lalu sisakan satu (bagian 3). |
| Agent HQ mati setelah VPS reboot | `pm2 startup` belum disiapkan, atau `pm2 save` lupa diulang setelah `./start.sh` (bagian 3). |
| `npm install` di `start.sh` gagal dengan `EACCES` | Ada file milik root di folder repo. Jalankan `sudo chown -R $USER:$USER ~/agent-hq`. |
| Sesi CLI muncul, sesi gateway tidak | Gateway tidak pernah menanyakan izin. Izinkan lewat `hermes` interaktif, lalu `hermes gateway restart` (bagian 7). |
| Halaman di laptop tidak terbuka | Tunnel `ssh -L` belum jalan atau sudah putus. Kalau keluar `bind: Address already in use`, port di laptop terpakai: pakai `-L 9787:...`. |
| `remote port forwarding failed` (opsi B) | Port 8787 di VPS terpakai, atau `AllowTcpForwarding no` di `/etc/ssh/sshd_config`. Pakai port lain (`-R 9787:...` dan `--url`), atau izinkan forwarding lalu `sudo systemctl restart ssh`. |
| `npm run build` berhenti dengan `Killed` | RAM habis. Tambahkan swap (bagian 3), atau pakai `examples/server.js`. |
| Karakter baru muncul setelah prompt pertama | Normal. Hermes baru melapor awal sesi saat giliran pertama. |
| Dua karakter untuk satu Hermes | `HQ_ANNOUNCE` menyala padahal hook juga terpasang. Matikan `HQ_ANNOUNCE`. |
| Tool `hq_*` tidak pernah dipanggil | Tambahkan aturan di bagian 8. Cek `hermes mcp test agent_hq`. Setelah mengubah config, ketik `/reload-mcp` di sesi atau `hermes gateway restart`. |
| Nama kembali ke `<folder>#xxxx` | `HQ_NAME` tidak sampai ke hook. Tulis di `agent-hq.env`, atau ganti nama lewat ✎ (permanen). |
| Tes kirim manual menulis `HTTP 401 (HQ_TOKEN salah?)` | `HQ_TOKEN` di `agent-hq.env` berbeda dengan token di service Agent HQ. |
| Tes kirim manual menulis `tidak terjangkau` | Agent HQ mati atau `HQ_URL` salah. Setelah gagal, hook diam 20 detik sebelum mencoba lagi, jadi tunggu sebentar sebelum tes ulang. |
| Subagen tidak pergi | Subagen pergi 45 detik setelah `subagent_stop`, atau saat induknya memberi jawaban akhir. |
| PAPAN JADWAL tidak muncul | Reporter belum jalan: `systemctl --user status agent-hq-cron`. Papan hanya ada di app Next.js, bukan di `examples/server.js`. |
| Papan menulis `TERPUTUS` | Reporter mati atau tidak bisa menghubungi `HQ_URL`. Cek `journalctl --user -u agent-hq-cron`. |
| Papan menulis `SCHEDULER MATI` | Gateway Hermes mati: `hermes gateway status`, lalu `hermes gateway start`. Tanpa gateway, jadwal agen tidak jalan. |
| Tombol di panel jadwal abu-abu | Halaman tidak tersambung lewat `/api/stream`, reporter terputus, atau perintah sebelumnya untuk jadwal itu belum selesai. |
| "Jalankan sekarang" berhasil, tapi jadwal tidak jalan | Jadwal mulai di tick berikutnya (paling lama 1 menit) di dalam gateway. Kalau papan menulis `SCHEDULER MATI`, nyalakan gateway dulu. |
| Meja kantor penuh oleh karakter cron | Jadwalnya jalan sangat sering. Tiap jalan jadi karakter sendiri selama sekitar 5 menit; perjarang jadwalnya di Hermes. |
| Perintah gagal `perintah hermes tidak ditemukan` | Tulis `HQ_HERMES_BIN=/home/<user>/.local/bin/hermes` di `agent-hq.env`, lalu restart reporter. |
| Tombol Hermes tidak muncul | `HQ_HERMES_API_KEY` belum terbaca: cek `~/agent-hq/.env.local`, lalu `pm2 restart agent-hq`. Halaman juga harus tersambung lewat `/api/stream`. `examples/server.js` tidak punya chat. |
| Panel chat: `Hermes tidak bisa dihubungi` | API server Hermes belum jalan. Cek `API_SERVER_ENABLED=true` di `~/.hermes/.env`, `hermes gateway restart`, lalu `curl -s http://127.0.0.1:8642/health`. |
| Panel chat: `Kunci API ditolak Hermes` | `HQ_HERMES_API_KEY` berbeda dengan `API_SERVER_KEY`. Jalankan ulang `install.py --chat`, lalu `pm2 restart agent-hq`. |
| Panel chat: `Ditolak: host ... tidak diizinkan` | Agent HQ dibuka lewat IP atau domain. Buka lewat tunnel (`localhost`), atau isi `HQ_ALLOWED_HOSTS` dan `HQ_TOKEN`. |
| Hermes menjalankan perintah tanpa kartu izin | `approvals.mode: off` di `~/.hermes/config.yaml`. Ganti ke `smart` atau `manual`, lalu `hermes gateway restart`. |
| Hermes terasa lebih lambat | Tiap event menjalankan `python3` sebentar (puluhan milidetik). Hapus event yang tidak perlu dari `config.yaml`, misalnya `post_tool_call`. |

## 15. Update dan mencopot

**Update** setelah repo berubah:

```bash
cd ~/agent-hq
./start.sh && pm2 save                  # opsi A: pull, build, restart Agent HQ (opsi B: cukup git pull)
python3 examples/hermes/install.py      # salin ulang adapter, restart reporter jadwal
hermes gateway restart                  # kalau memakai gateway
```

Chat Hermes tidak perlu dipasang ulang: `install.py --chat` boleh diulang dan memakai kunci yang sama.

**Mencopot adapter:**

```bash
hermes hooks revoke "/usr/bin/python3 /home/kamu/.hermes/agent-hq/hq_hook.py"   # cabut izin hook
systemctl --user disable --now agent-hq-cron && rm ~/.config/systemd/user/agent-hq-cron.service
rm -rf ~/.hermes/agent-hq ~/.cache/agent-hq
```

Lalu hapus entri `hq_hook.py` dari `hooks:` dan `agent_hq:` dari `mcp_servers:` di `~/.hermes/config.yaml`.
Kalau config belum diubah lagi sejak instalasi, cukup kembalikan cadangannya:
`cp ~/.hermes/config.yaml.agent-hq-<waktu>.bak ~/.hermes/config.yaml`. Untuk mematikan sementara, cukup set
`HQ_DISABLE=1` di `agent-hq.env`.

**Mematikan chat Hermes:** hapus baris `HQ_HERMES_*` dari `~/agent-hq/.env.local` lalu `pm2 restart agent-hq`.
Kalau API server Hermes tidak dipakai aplikasi lain, set juga `API_SERVER_ENABLED=false` di `~/.hermes/.env` lalu
`hermes gateway restart`.

**Mencopot Agent HQ di VPS:** `pm2 delete agent-hq && pm2 save && rm -rf ~/agent-hq`.

## 16. Cara kerjanya

- `hq_hook.py` menerima satu event Hermes lewat stdin, menerjemahkannya ke format hook Claude Code, lalu
  mengirimnya ke `/api/hook`. Jadi sensor, papan tugas, subagen, dan rename di bridge sama persis dengan
  Claude Code. Status yang tidak punya padanan di Claude Code (izin diberikan, jawaban dari kamu) dikirim ke
  `/api/event`. Skrip ini tidak pernah mencetak apa pun dan selalu keluar dengan kode 0, jadi tidak pernah
  memblokir tool Hermes.
- Session id Hermes di-hash dengan SHA-1, karena bridge memakai 8 karakter pertama sebagai id agen sedangkan
  id sesi Hermes diawali tanggal.
- `~/.cache/agent-hq/hermes-state.json` mencatat sesi tiap proses Hermes dan subagen yang sedang jalan. Hook
  dan server MCP sama-sama anak dari proses Hermes, sehingga `hq_mcp.py` bisa menemukan karakter milik hook.
- `hq_cron.py` membaca `~/.hermes/cron/jobs.json`, `executions.db` (jadwal yang sedang jalan) dan `ticker_heartbeat`
  (scheduler hidup), lalu mengirim event `schedule` ke `/api/event` saat ada perubahan dan setiap 30 detik. Perintah
  dari panel masuk antrian di bridge (`POST /api/cron`); reporter mengambilnya dengan long poll
  (`GET /api/cron/commands`) dan melapor lewat `POST /api/cron/result`. Perintah yang tidak dijawab dalam 90 detik
  dianggap gagal. Sesi cron Hermes ber-id `cron_<id jadwal>_<waktu>`, jadi hook bisa menamai karakternya sesuai
  jadwal.
- Chat Hermes: server Agent HQ (`lib/bridge/hermes-chat.ts`) membuat sesi lewat `POST /api/sessions` di API
  server Hermes, mengirim pesan ke `/api/sessions/<id>/chat/stream`, dan membaca stream-nya sendiri. Ini perlu
  karena Hermes menghentikan pekerjaan kalau klien stream-nya putus, sedangkan panel boleh ditutup. Panel menerima
  percakapan lewat `GET /api/hermes/stream` dan mengirim aksi (`send`, `approve`, `stop`, `new`, `sessions`,
  `open`, `rename`, `delete`, `models`, `model`) ke `POST /api/hermes`. Izin dijawab lewat
  `/v1/runs/<id>/approval` dan berhenti lewat `/v1/runs/<id>/stop`. Riwayat memakai `GET /api/sessions?source=api_server`,
  `GET`/`PATCH`/`DELETE /api/sessions/<id>`, dan `GET /api/sessions/<id>/messages`. Model dikirim per pesan
  (`model`, `provider`), peran agen sebagai `system_message`. Daftar model dari `GET /api/model/options`, status
  memori dari `GET /v1/toolsets`. Kalau `assistant.completed` atau `run.completed` membawa `session_id` lain
  (compression), pesan berikutnya dikirim ke id itu.
- Teks dari MCP disensor di Python dengan pola yang sama dengan `lib/bridge/redact.ts`, karena `/api/event`
  tidak menyensor apa pun.
- Tes (ikut `npm test`): `tests/integration/hermes.test.ts` untuk hook, MCP, installer, dan reporter jadwal
  (dilewati kalau tidak ada Python 3), `tests/integration/cron-routes.test.ts` untuk endpoint `/api/cron` di
  `next start` (butuh `npm run build`), serta `tests/unit/cron.test.ts` dan `tests/unit/bridge-cron.test.ts`.
  Chat diuji dengan API Hermes tiruan di `tests/unit/bridge-hermes-chat.test.ts`, `tests/unit/hermes-chat.test.ts`,
  dan `tests/integration/hermes-chat-routes.test.ts`.
  Nama event, isi payload, format `jobs.json`, dan id sesi cron mengikuti dokumentasi dan kode Hermes. Kalau
  Hermes mengubahnya, sesuaikan `hq_hook.py` dan `hq_cron.py`.
