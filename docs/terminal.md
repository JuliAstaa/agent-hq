# Terminal web (tombol Terminal)

Tombol **Terminal** di kanan atas Agent HQ membuka terminal server tempat Agent HQ di-deploy, langsung di samping
kantor. Terminalnya adalah [ttyd](https://github.com/tsl0922/ttyd), program terpisah yang jalan di server. Agent HQ
sendiri tidak menjalankan perintah apa pun: ia hanya menampilkan halaman ttyd di sebuah panel. Tombolnya hanya
muncul kalau `HQ_TERMINAL_URL` diisi.

```
Laptop                                              VPS
browser ── localhost:8787 ──┐    tunnel SSH    ┌── 127.0.0.1:8787  Agent HQ  (pm2: agent-hq)
        └─ localhost:7681 ──┴──────────────────┴── 127.0.0.1:7681  ttyd -> tmux "agent-hq"  (pm2: agent-hq-terminal)
```

Panduan ini mengikuti setup VPS Ubuntu di `docs/hermes.md` (Agent HQ dijalankan `start.sh` dengan pm2, dibuka
lewat tunnel SSH). Kalau Agent HQ jalan di laptopmu sendiri, terminal biasa sudah cukup.

## Isi

1. [Pasang ttyd](#1-pasang-ttyd)
2. [Jalankan ttyd](#2-jalankan-ttyd)
3. [Nyalakan tombol di Agent HQ](#3-nyalakan-tombol-di-agent-hq)
4. [Buka dari laptop](#4-buka-dari-laptop)
5. [Lewat domain (tanpa tunnel)](#5-lewat-domain-tanpa-tunnel)
6. [Pakai](#6-pakai)
7. [Keamanan](#7-keamanan)
8. [Masalah umum](#8-masalah-umum)
9. [Mencopot](#9-mencopot)
10. [Cara kerjanya](#10-cara-kerjanya)

## 1. Pasang ttyd

Butuh ttyd 1.7 atau lebih baru (versi lama belum punya `--writable`). Paket `apt` di sebagian versi Ubuntu masih
1.6, jadi pakai binary resmi dari GitHub dan cek checksum-nya:

```bash
V=1.7.7; A=$(uname -m)          # A = x86_64 atau aarch64
cd /tmp
curl -fsSLO https://github.com/tsl0922/ttyd/releases/download/$V/ttyd.$A
curl -fsSLO https://github.com/tsl0922/ttyd/releases/download/$V/SHA256SUMS
grep " ttyd.$A\$" SHA256SUMS | sha256sum -c -     # harus menulis: ttyd.x86_64: OK
sudo install -m 755 ttyd.$A /usr/local/bin/ttyd
ttyd --version
sudo apt install -y tmux          # biasanya sudah terpasang
```

tmux tidak wajib, tapi sangat disarankan: dengan tmux, perintah tetap jalan saat panel ditutup (bagian 6).

## 2. Jalankan ttyd

Sebagai user yang sama dengan Agent HQ (user biasa, bukan root), dari folder repo:

```bash
cd ~/agent-hq
pm2 start examples/terminal/ttyd.sh --name agent-hq-terminal
pm2 save
pm2 logs agent-hq-terminal --lines 5 --nostream    # cek: tidak ada error
```

`examples/terminal/ttyd.sh` menjalankan ttyd dengan pengaturan yang aman:

- hanya mendengar di `127.0.0.1:7681` (`--interface lo`), tidak di IP publik;
- login `hq` dengan password acak yang dibuat sekali di `~/.config/agent-hq/terminal.cred` (`chmod 600`);
- menolak koneksi WebSocket dari situs lain (`--check-origin`);
- membuka shell di sesi tmux `agent-hq` (kalau tmux ada), mulai dari folder home;
- menolak jalan sebagai root.

Lihat password-nya dengan `cat ~/.config/agent-hq/terminal.cred` (formatnya `hq:<password>`).

`start.sh` hanya me-restart proses `agent-hq`, jadi update Agent HQ tidak memutus terminal. Port lain:
`HQ_TERMINAL_PORT=7682 pm2 start examples/terminal/ttyd.sh --name agent-hq-terminal` (pm2 menyimpan env saat
start).

## 3. Nyalakan tombol di Agent HQ

Tambahkan alamat terminal ke `~/agent-hq/.env.local` (file yang sama dengan pengaturan chat Hermes), lalu restart:

```bash
printf '\nHQ_TERMINAL_URL=http://localhost:7681\n' >> ~/agent-hq/.env.local
pm2 restart agent-hq
curl -s http://127.0.0.1:8787/api/terminal       # {"ok":true,"url":"http://localhost:7681/"}
```

`HQ_TERMINAL_URL` adalah alamat terminal **dilihat dari browser**, bukan dari VPS. Lewat tunnel di bagian 4,
alamatnya `http://localhost:7681`. Jangan taruh user atau password di alamat ini: alamatnya dikirim ke browser,
jadi alamat seperti `http://hq:rahasia@localhost:7681` diabaikan dan tombolnya tidak muncul.

## 4. Buka dari laptop

Tambahkan port terminal ke tunnel yang biasa (`docs/hermes.md` bagian 4):

```bash
ssh -N -L 8787:127.0.0.1:8787 -L 7681:127.0.0.1:7681 user@ip-vps
```

Buka **http://localhost:8787**, klik **Terminal** di kanan atas, lalu login dengan user `hq` dan password dari
bagian 2. Browser biasanya menawarkan menyimpan password-nya.

Kalau port 7681 di laptop sudah terpakai, pakai port lain di sisi laptop dan samakan `HQ_TERMINAL_URL`, misalnya
`-L 7781:127.0.0.1:7681` dengan `HQ_TERMINAL_URL=http://localhost:7781`.

## 5. Lewat domain (tanpa tunnel)

Kalau Agent HQ sudah dibuka lewat domain https di belakang nginx (misalnya `https://agent.contoh.id` diteruskan ke
`127.0.0.1:8787`), terminal bisa ditaruh di `https://agent.contoh.id/terminal/` di server nginx yang sama, jadi bisa
dibuka dari mana saja, termasuk HP, tanpa tunnel.

**Risikonya lebih besar.** Shell-mu sekarang terbuka ke internet dan hanya dijaga password ttyd. Kalau user di VPS
punya `sudo` tanpa password, siapa pun yang mendapat password itu (atau menemukan bug di ttyd) jadi root. Lebih
aman: tunnel (bagian 4), atau Cloudflare Access/Tailscale di depan nginx. Kalau tetap memilih ini:

1. Batasi percobaan login. Buat `/etc/nginx/conf.d/agent-hq-terminal.conf` (konteks `http`):

   ```nginx
   limit_req_zone $binary_remote_addr zone=hq_terminal:10m rate=30r/m;
   ```

2. Di blok `server` domain Agent HQ (yang `listen 443 ssl`), tambahkan sebelum `location /`. `proxy_pass` yang
   diakhiri `/` membuang awalan `/terminal`, jadi ttyd tetap jalan dengan skrip yang sama tanpa diubah:

   ```nginx
   location = /terminal { return 301 /terminal/; }
   location /terminal/ {
       limit_req zone=hq_terminal burst=20 nodelay;
       proxy_pass http://127.0.0.1:7681/;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 1h;
   }
   ```

3. Cek dan muat ulang: `sudo nginx -t && sudo systemctl reload nginx`. Tanpa login, `curl -sI
   https://agent.contoh.id/terminal/` harus menjawab `401`.
4. Arahkan tombol ke alamat itu, lalu restart Agent HQ:
   `HQ_TERMINAL_URL=https://agent.contoh.id/terminal/` di `~/agent-hq/.env.local`, lalu `pm2 restart agent-hq`.

`--check-origin` tetap jalan di belakang nginx karena `Host` diteruskan apa adanya. Catatan: terminal ini satu
origin dengan halaman kantor, jadi celah XSS di halaman kantor bisa memakai sesi terminal yang sedang login. Agent
HQ menampilkan semua teks agen sebagai teks biasa (bukan HTML) untuk mencegah itu.

## 6. Pakai

- Panel **TERMINAL** muncul di kanan. Panel Hermes dan panel terminal memakai tempat yang sama, jadi membuka
  yang satu menutup yang lain.
- **Tutup** memutus koneksi, tapi shell tetap hidup di tmux. Buka lagi, dan kamu kembali ke layar yang sama,
  termasuk perintah yang masih jalan.
- **Tab baru** membuka terminal di tab sendiri (lebih lebar). Panel dan tab melihat sesi tmux yang sama.
  Browser mungkin meminta login sekali lagi di tab itu.
- **Muat ulang** menyambung ulang, misalnya setelah tunnel sempat putus.
- `exit` menutup sesi tmux. Sesi baru dibuat saat terminal dibuka lagi.
- Menggulir ke atas di tmux: `Ctrl+b` lalu `[`, keluar dengan `q`. Atau nyalakan mouse sekali saja:
  `echo 'set -g mouse on' >> ~/.tmux.conf` lalu `tmux source ~/.tmux.conf`.
- `Ctrl+W` ditangkap browser (menutup tab), bukan menghapus kata. Pakai `Alt+Backspace`.
- `./start.sh` boleh dijalankan dari terminal ini. Hanya `agent-hq` yang restart; panel terminal tetap
  tersambung, dan kantor tersambung lagi sendiri setelah build selesai.

## 7. Keamanan

Terminal ini memberi shell penuh sebagai user yang menjalankan ttyd. Lapisannya:

- **Tunnel SSH adalah pintu utama.** ttyd hanya mendengar di `127.0.0.1`, jadi dari luar VPS satu-satunya jalan
  masuk adalah tunnel SSH dengan kunci SSH-mu. Jangan buka port 7681 di `ufw` atau firewall penyedia VPS.
- **Password ttyd adalah lapisan kedua.** Ini menutup serangan DNS rebinding: situs jahat yang namanya diarahkan
  ke `127.0.0.1` saat tunnel terbuka. `--check-origin` saja tidak cukup untuk itu, karena situs seperti itu
  dianggap satu origin dengan dirinya sendiri. Browser tidak punya password untuk nama situs itu, jadi ditolak.
- **`--check-origin`** menolak halaman dari situs lain yang mencoba membuka WebSocket ke terminal.
- **Agent HQ tidak ikut campur.** Browser bicara langsung ke ttyd lewat tunnel. Agent HQ tidak menyimpan, tidak
  meneruskan, dan tidak melihat password maupun isi terminal; `/api/terminal` hanya memberi tahu alamatnya.
- **Bukan root.** Skripnya menolak jalan sebagai root. Pakai `sudo` di dalam terminal kalau perlu.
- **VPS pribadi saja.** Password terlihat di daftar proses (`ps`) karena diberikan lewat argumen ttyd, dan user
  lain di VPS yang sama bisa membuka `127.0.0.1:7681`. Jangan pakai terminal web di VPS yang dipakai bersama.
- **Ganti password:** hapus `~/.config/agent-hq/terminal.cred`, lalu `pm2 restart agent-hq-terminal`.
- **Dari HP atau tanpa SSH** berarti terminal terbuka ke internet (bagian 5). Sebaiknya taruh di belakang
  Tailscale atau Cloudflare Access, dan selalu pakai https. Halaman https tidak bisa menampilkan terminal http
  selain `localhost`, jadi `HQ_TERMINAL_URL` lewat domain juga harus https.

## 8. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Tombol Terminal tidak muncul | `HQ_TERMINAL_URL` belum terbaca: cek `~/agent-hq/.env.local`, lalu `pm2 restart agent-hq`. Cek dengan `curl -s http://127.0.0.1:8787/api/terminal`; `"url":null` berarti kosong atau tidak valid (harus `http(s)://`, tanpa user dan password). Halaman juga harus tersambung lewat `/api/stream`; `examples/server.js` tidak punya tombol ini. |
| Panel menulis `localhost menolak terhubung` | Tunnel belum meneruskan port 7681 (bagian 4), atau ttyd mati (`pm2 status`, `pm2 logs agent-hq-terminal`). Di VPS, `curl -sI http://127.0.0.1:7681` harus menjawab `401`. |
| Login terus ditolak | User harus `hq`, password dari `cat ~/.config/agent-hq/terminal.cred` (bagian setelah titik dua). |
| Log pm2: `ttyd terlalu lama` | Yang terpakai ttyd versi `apt`. Pasang binary GitHub (bagian 1), `sudo apt remove ttyd`, lalu `pm2 restart agent-hq-terminal`. |
| Log pm2: `Jangan jalankan terminal web sebagai root` | pm2 jalan sebagai root. Jalankan pm2 sebagai user biasa (`docs/hermes.md` bagian 3). |
| Terminal tampil tapi tidak bisa mengetik | ttyd dijalankan langsung tanpa `--writable`. Jalankan lewat `examples/terminal/ttyd.sh`. |
| Panel kosong saat Agent HQ dibuka lewat https | Browser memblokir halaman http di dalam halaman https. Terminal juga harus https (bagian 5 dan 7). |
| Lewat domain: `502 Bad Gateway` | ttyd mati (`pm2 status`), atau `proxy_pass` tidak menunjuk `127.0.0.1:7681` (bagian 5). |
| Lewat domain: halaman tampil tapi tidak tersambung | Baris `Upgrade`/`Connection` hilang dari blok nginx, atau `Host` tidak diteruskan (`--check-origin` menolak). |

## 9. Mencopot

```bash
pm2 delete agent-hq-terminal && pm2 save
tmux kill-session -t agent-hq                                  # kalau masih ada
sed -i '/^HQ_TERMINAL_URL=/d' ~/agent-hq/.env.local && pm2 restart agent-hq
rm -f ~/.config/agent-hq/terminal.cred
sudo rm -f /usr/local/bin/ttyd
```

Lewat domain: hapus juga blok `location /terminal` dari konfigurasi nginx dan
`/etc/nginx/conf.d/agent-hq-terminal.conf`, lalu `sudo nginx -t && sudo systemctl reload nginx`.

## 10. Cara kerjanya

- `GET /api/terminal` (`app/api/terminal/route.ts`) menjawab `{"ok": true, "url": ...}` dari `HQ_TERMINAL_URL`, atau
  `"url": null` kalau kosong atau tidak valid. Tanpa CORS. Pemeriksaan alamatnya ada di `lib/terminal.ts`.
- Kantor menanyakan alamat itu saat tersambung ke `/api/stream` (`useTerminalUrl` di `components/TerminalPanel.tsx`),
  lalu menampilkan tombol Terminal. Panel membuka alamat itu di iframe. Panel yang sedang terbuka tetap tersambung
  walau koneksi kantor putus sebentar, karena ttyd tidak bergantung pada Agent HQ.
- Tes: `tests/unit/terminal.test.ts`.
