# Agent HQ + Hermes Agent di VPS Ubuntu

Panduan ini menyambungkan [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) yang jalan
di VPS Ubuntu ke Agent HQ, supaya setiap sesi Hermes tampil sebagai karakter di kantor. Ini termasuk sesi CLI
lewat SSH maupun sesi gateway seperti Telegram dan Discord.

Ada dua sambungan. Installer memasang keduanya, dan memang paling bagus dipakai bersama:

| | Hook | MCP |
|---|---|---|
| Yang melapor | Hermes, otomatis di setiap event | AI-nya sendiri, saat ia memanggil tool |
| Isinya | kerja, mikir, butuh kamu, error, bubble aksi, confetti, subagen | progres, catatan penting, temuan Red Team, alert SOC, metrik login gagal |
| File | `examples/hermes/hq_hook.py` | `examples/hermes/hq_mcp.py` |

Kalau hook dan MCP jalan di proses Hermes yang sama, laporan MCP masuk ke karakter yang sama dengan hook.
Satu sesi Hermes tetap satu karakter.

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
10. [Pengaturan](#10-pengaturan)
11. [Pasang manual](#11-pasang-manual)
12. [Masalah umum](#12-masalah-umum)
13. [Update dan mencopot](#13-update-dan-mencopot)
14. [Cara kerjanya](#14-cara-kerjanya)

## 1. Pilih tempat Agent HQ

| | **A. Agent HQ di VPS (disarankan)** | B. Agent HQ di laptop |
|---|---|---|
| Hermes mengirim ke | `127.0.0.1:8787` di VPS itu sendiri | `127.0.0.1:8787` di VPS, diteruskan ke laptop lewat tunnel |
| Cara menonton | `ssh -L` dari laptop, lalu buka `http://localhost:8787` | buka `http://localhost:8787` di laptop |
| Saat laptop mati | kantor tetap jalan, status agen tetap tercatat | event Hermes terbuang (Hermes tetap jalan normal) |
| Kebutuhan VPS | Node.js 24 dan RAM 2 GB untuk build (atau swap) | cukup `python3` |

Di kedua opsi, Agent HQ hanya mendengar di `127.0.0.1`. Port 8787 **tidak** dibuka ke internet; semua lewat SSH.

Opsi A:

```
VPS Ubuntu                                                        Laptop
┌──────────────────────────────────────────────────┐
│ Hermes ─ hq_hook.py ─ POST /api/hook ──┐         │
│        └ hq_mcp.py  ─ POST /api/event ─┤         │
│                                        ▼         │
│                     Agent HQ 127.0.0.1:8787 ◄────┼── ssh -L 8787 ── browser localhost:8787
└──────────────────────────────────────────────────┘
```

Langkah singkat opsi A: bagian 2, 3, 4, 6, 7. Opsi B: bagian 2, 5, 6, 7.

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

Mau Hermes jalan 24 jam (Telegram, Discord, dan lain-lain)? Pasang gateway sebagai service:

```bash
hermes gateway setup                 # pilih platform chat
hermes gateway install               # service systemd milik user
sudo loginctl enable-linger $USER    # tetap jalan setelah logout SSH
hermes gateway start
```

## 3. Jalankan Agent HQ di VPS

Lewati bagian ini kalau memakai opsi B.

**Node.js 24** dari NodeSource (versi `apt` bawaan Ubuntu terlalu lama):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

**Ambil dan build repo:**

```bash
git clone https://github.com/JuliAstaa/agent-hq.git ~/agent-hq
cd ~/agent-hq
npm ci
npm run build
```

Kalau `git clone` ditolak (repo privat), pakai token GitHub atau deploy key. Bisa juga salin folder dari laptop
dengan `scp -r`, tapi jangan ikut menyalin `node_modules` dan `.next`.

Build Next.js butuh sekitar 2 GB RAM. Kalau `free -h` menunjukkan kurang dari itu, atau build berhenti dengan
`Killed`, tambahkan swap dulu:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Jalankan sebagai service** supaya hidup terus dan otomatis menyala setelah reboot:

```bash
sudo tee /etc/systemd/system/agent-hq.service >/dev/null <<EOF
[Unit]
Description=Agent HQ
After=network.target

[Service]
User=$USER
WorkingDirectory=$HOME/agent-hq
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now agent-hq
curl -s http://127.0.0.1:8787/api/health     # harus menjawab {"ok":true,...}
```

`npm start` mendengar di `127.0.0.1:8787` saja. Jangan membuka port 8787 di `ufw` atau firewall penyedia VPS.
Log: `journalctl -u agent-hq -f`.

**VPS kecil (RAM 1 GB)?** Ada bridge mandiri tanpa build: ganti `ExecStart` dengan
`/usr/bin/node examples/server.js`. Isinya halaman prototipe dengan fitur bridge yang sama, dan bisa dipakai
tanpa `npm ci` dan `npm run build`.

**Token (opsional):** di VPS yang dipakai bersama orang lain, tambahkan `Environment=HQ_TOKEN=<rahasia>` di
service, isi `HQ_TOKEN` yang sama di `agent-hq.env` (bagian 10), lalu `sudo systemctl restart agent-hq`.
Akibatnya, ganti nama dari tombol ✎ di kartu agen ditolak, jadi pakai `curl` dengan token (README bagian 3).

## 4. Tonton dari laptop

Buka tunnel dari laptop (PowerShell Windows, macOS, atau Linux), biarkan jalan selama menonton:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@ip-vps
```

Lalu buka **http://localhost:8787** di browser laptop. Halaman otomatis tersambung ke data asli dari VPS.

Kalau port 8787 di laptop sudah terpakai (misalnya Agent HQ lokal sedang jalan), pakai port lain:
`ssh -N -L 9787:127.0.0.1:8787 user@ip-vps`, lalu buka `http://localhost:9787`.

Saat tunnel ditutup, kantor di VPS tetap jalan. Begitu dibuka lagi, halaman langsung menampilkan status semua
agen dan log terakhir.

## 5. Opsi B: Agent HQ di laptop

Jalankan Agent HQ di laptop seperti biasa (README bagian 1). Lalu buka reverse tunnel dari laptop. Dengan
tunnel ini, `127.0.0.1:8787` di VPS diteruskan ke Agent HQ di laptop:

```bash
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 8787:127.0.0.1:8787 user@ip-vps
```

Cek dari VPS: `curl -s http://127.0.0.1:8787/api/health`.

- Event Hermes hanya sampai selama tunnel terbuka. Saat tunnel putus, hook diam dan mencoba lagi tiap 20 detik,
  dan Hermes tetap jalan normal.
- Kalau port 8787 di VPS sudah terpakai, pakai `-R 9787:127.0.0.1:8787` dan pasang adapter dengan
  `--url http://127.0.0.1:9787`.
- Tanpa repo di VPS, salin foldernya saja dari laptop: `scp -r examples/hermes user@ip-vps:~/agent-hq-hermes`.

## 6. Pasang adapter Hermes

Di VPS, sebagai user yang menjalankan Hermes:

```bash
python3 ~/agent-hq/examples/hermes/install.py          # opsi B tanpa repo: python3 ~/agent-hq-hermes/install.py
```

Yang dilakukan installer:

- Menyalin `hq_common.py`, `hq_hook.py`, `hq_mcp.py` ke `~/.hermes/agent-hq/`. Setelah itu Hermes tidak
  bergantung lagi pada folder repo.
- Membuat `~/.hermes/agent-hq/agent-hq.env` (alamat Agent HQ, nama default, token) kalau belum ada.
- Menambahkan 13 hook dan server MCP `agent_hq` ke `~/.hermes/config.yaml`. Sebelumnya config disalin ke
  `config.yaml.agent-hq-<waktu>.bak`, dan hasil gabungannya diperiksa dengan parser YAML. Setting lain tidak
  disentuh.
- Mengetes koneksi ke Agent HQ.

| Pilihan | Fungsi |
|---|---|
| `--no-mcp` | hook saja |
| `--no-hooks` | MCP saja |
| `--url http://127.0.0.1:9787` | alamat Agent HQ lain (disimpan di `agent-hq.env`) |
| `--print` | salin file saja, tampilkan blok `config.yaml`, jangan ubah config |
| `--hermes-home <folder>` | folder Hermes lain (default `$HERMES_HOME` atau `~/.hermes`) |

Installer aman dijalankan ulang: file disalin ulang, blok yang sudah ada dibiarkan. Kalau keluar pesan
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
`<folder>#xxxx`.

**Cek:**

```bash
hermes hooks list                                     # 13 hook hq_hook.py beserta status izinnya
hermes hooks doctor                                   # cek izin dan file hook
hermes mcp test agent_hq                              # server MCP menjawab
hermes hooks test pre_tool_call --for-tool terminal   # karakter muncul dengan status kerja
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

Tool Hermes yang dikenali: `terminal`, `read_file`, `write_file`, `patch`, `search_files`, `session_search`,
`web_search`, `web_extract`, `browser_navigate`, `delegate_task`, `todo`, `skill_view`, `skills_list`. Tool lain
tampil dengan namanya sendiri.

- **Gateway:** setiap sesi chat jadi satu karakter. Kalau `HQ_NAME` diisi, semuanya memakai nama itu. Bedakan
  lewat ✎, atau kosongkan `HQ_NAME` supaya tiap sesi bernama `<folder>#xxxx`. Server MCP di gateway dipakai
  bersama semua sesi, jadi laporannya masuk ke sesi yang terakhir aktif.
- **Token** di kartu agen tetap kosong untuk Hermes, karena Agent HQ membaca token dari transcript Claude Code.

## 10. Pengaturan

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
| `HQ_DISABLE` | mati | `1` mematikan adapter tanpa mengubah `config.yaml` |
| `HQ_STATE_DIR` | `~/.cache/agent-hq` | catatan sesi yang dipakai bersama hook dan MCP |

Perubahan di file ini langsung berlaku untuk hook. Server MCP membacanya saat mulai, jadi jalankan
`hermes gateway restart` atau buka ulang `hermes`.

Kalau Agent HQ tidak terjangkau, hook berhenti mengirim selama 20 detik lalu mencoba lagi. Hermes tetap jalan
normal.

**MCP saja** (dipasang dengan `--no-hooks`): nyalakan `HQ_ANNOUNCE=1` di `agent-hq.env` supaya karakter
langsung muncul saat Hermes menyala. Jangan nyalakan `HQ_ANNOUNCE` kalau hook juga terpasang, karena hasilnya
dua karakter untuk satu Hermes.

## 11. Pasang manual

Kalau tidak mau memakai installer:

```bash
mkdir -p ~/.hermes/agent-hq
cp ~/agent-hq/examples/hermes/{hq_common.py,hq_hook.py,hq_mcp.py} ~/.hermes/agent-hq/
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

## 12. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Kantor tidak berubah sama sekali | Di VPS: `curl -s http://127.0.0.1:8787/api/health`. Kalau gagal, cek `systemctl status agent-hq` (opsi A) atau tunnel `ssh -R` (opsi B). Kalau berhasil, cek `hermes hooks list` (izin), lalu tes kirim manual (bagian 7). |
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
| Hermes terasa lebih lambat | Tiap event menjalankan `python3` sebentar (puluhan milidetik). Hapus event yang tidak perlu dari `config.yaml`, misalnya `post_tool_call`. |

## 13. Update dan mencopot

**Update** setelah repo berubah:

```bash
cd ~/agent-hq && git pull
npm ci && npm run build && sudo systemctl restart agent-hq   # opsi A
python3 examples/hermes/install.py                           # salin ulang adapter
hermes gateway restart                                       # kalau memakai gateway
```

**Mencopot adapter:**

```bash
hermes hooks revoke "/usr/bin/python3 /home/kamu/.hermes/agent-hq/hq_hook.py"   # cabut izin hook
rm -rf ~/.hermes/agent-hq ~/.cache/agent-hq
```

Lalu hapus entri `hq_hook.py` dari `hooks:` dan `agent_hq:` dari `mcp_servers:` di `~/.hermes/config.yaml`.
Kalau config belum diubah lagi sejak instalasi, cukup kembalikan cadangannya:
`cp ~/.hermes/config.yaml.agent-hq-<waktu>.bak ~/.hermes/config.yaml`. Untuk mematikan sementara, cukup set
`HQ_DISABLE=1` di `agent-hq.env`.

**Mencopot Agent HQ di VPS:**
`sudo systemctl disable --now agent-hq && sudo rm /etc/systemd/system/agent-hq.service && rm -rf ~/agent-hq`.

## 14. Cara kerjanya

- `hq_hook.py` menerima satu event Hermes lewat stdin, menerjemahkannya ke format hook Claude Code, lalu
  mengirimnya ke `/api/hook`. Jadi sensor, papan tugas, subagen, dan rename di bridge sama persis dengan
  Claude Code. Status yang tidak punya padanan di Claude Code (izin diberikan, jawaban dari kamu) dikirim ke
  `/api/event`. Skrip ini tidak pernah mencetak apa pun dan selalu keluar dengan kode 0, jadi tidak pernah
  memblokir tool Hermes.
- Session id Hermes di-hash dengan SHA-1, karena bridge memakai 8 karakter pertama sebagai id agen sedangkan
  id sesi Hermes diawali tanggal.
- `~/.cache/agent-hq/hermes-state.json` mencatat sesi tiap proses Hermes dan subagen yang sedang jalan. Hook
  dan server MCP sama-sama anak dari proses Hermes, sehingga `hq_mcp.py` bisa menemukan karakter milik hook.
- Teks dari MCP disensor di Python dengan pola yang sama dengan `lib/bridge/redact.ts`, karena `/api/event`
  tidak menyensor apa pun.
- Tes: `tests/integration/hermes.test.ts` (ikut `npm test`, dilewati kalau tidak ada Python 3). Nama event dan
  isi payload mengikuti dokumentasi hooks Hermes. Kalau Hermes mengubahnya, sesuaikan `hq_hook.py`.
