# Agent HQ + OpenCode

Panduan ini menyambungkan [OpenCode](https://opencode.ai) ke Agent HQ, supaya setiap sesi OpenCode, termasuk
subagennya, tampil sebagai karakter di kantor seperti sesi Claude Code. Berlaku untuk TUI `opencode`,
`opencode run`, dan `opencode serve`/`opencode web`.

Integrasinya berupa satu plugin, `examples/opencode/agent-hq.js`. OpenCode memuatnya sendiri saat start, lalu
plugin menerjemahkan event OpenCode ke format hook Claude Code dan mengirimnya ke `/api/hook` Agent HQ.
Tidak ada dependensi dan tidak ada `npm install`.

Butuh: OpenCode 1.x dengan plugin API v1 (diuji di 1.19).

## Isi

1. [Pasang](#1-pasang)
2. [Cek](#2-cek)
3. [Nama, peran, tim, dan grup](#3-nama-peran-tim-dan-grup)
4. [Yang terlihat di kantor](#4-yang-terlihat-di-kantor)
5. [Pengaturan](#5-pengaturan)
6. [Masalah umum](#6-masalah-umum)
7. [Update dan mencopot](#7-update-dan-mencopot)
8. [Cara kerjanya](#8-cara-kerjanya)

## 1. Pasang

Nyalakan Agent HQ dulu (README bagian 1), lalu salin plugin ke folder plugin global OpenCode. Dari folder repo
ini:

macOS dan Linux:

```bash
mkdir -p ~/.config/opencode/plugins
cp examples/opencode/agent-hq.js ~/.config/opencode/plugins/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\opencode\plugins" | Out-Null
Copy-Item examples\opencode\agent-hq.js "$HOME\.config\opencode\plugins\"
```

Mau untuk satu project saja? Salin ke `<project>/.opencode/plugins/` sebagai gantinya. Pasang di **satu** tempat
saja: plugin di dua folder berarti dua karakter untuk satu sesi.

Tutup OpenCode yang sedang jalan, lalu buka lagi. Plugin hanya dimuat saat OpenCode start.

## 2. Cek

1. Buka `http://localhost:8787`.
2. Jalankan `opencode` di folder project mana pun dan kirim prompt.
3. Karakter `<folder>#xxxx` dengan peran `OpenCode · <folder>` masuk, mengambil kartu di Papan Tugas, bekerja,
   lalu merayakan dengan confetti saat jawaban selesai.

Karakter baru muncul setelah prompt pertama, karena OpenCode baru membuat sesi saat itu.

Tidak muncul? Cek `curl -s http://127.0.0.1:8787/api/health`, lalu jalankan
`opencode --print-logs --log-level INFO` dan cari baris error tentang `agent-hq.js`.

## 3. Nama, peran, tim, dan grup

```bash
HQ_NAME=Rexx HQ_TEAM=red opencode
HQ_NAME=Vexa HQ_GROUP="Rilis v2.3" opencode
```

PowerShell: `$env:HQ_NAME="Rexx"; opencode`.

Untuk nama tetap (misalnya `opencode web` yang jalan sebagai service), tulis di `agent-hq.env` di samping plugin
(bagian 5). Nama juga bisa diganti kapan saja lewat tombol ✎ di kartu agen (permanen, README bagian 3).

## 4. Yang terlihat di kantor

| Yang terjadi di OpenCode | Yang kamu lihat |
|---|---|
| Prompt pertama di sesi baru | Karakter masuk ("Sesi baru di <folder> · <provider>/<model>") |
| Prompt masuk | Karakter mikir; kalau sedang santai, kartu tugas muncul di Papan Tugas (Kantor) |
| Tool jalan | Kerja, bubble `$ npm test`, `Baca cart.ts`, `Edit cart.ts`, `Cari "TODO"`, `Search: ...` |
| Tool gagal | Baris log kuning, misalnya `Bash gagal: ...` |
| OpenCode minta izin | Melambai, status oranye "Butuh kamu" |
| Izin diberikan / ditolak | Kerja lagi ("Izin diberikan, lanjut kerja") / mikir ("Izin ditolak, mencari cara lain") |
| OpenCode bertanya (tool `question`) | "Butuh kamu" dengan pertanyaannya |
| Jawaban selesai | Confetti, lalu jalan ke area santai |
| Kamu menekan Esc, atau giliran berhenti karena izin ditolak | Santai, "Menunggu prompt berikutnya", tanpa confetti |
| Error dari provider (API error) | Error: merah dan berasap |
| Provider sibuk, OpenCode mencoba lagi | Baris log `Coba lagi (1): ...` |
| Subagen (`task`, misalnya `@explore`) | Sesi naik ke ruang meeting bersama subagennya, bernama sesuai agennya |
| Subagen selesai | Subagen pergi sekitar 45 detik kemudian |
| OpenCode ditutup, atau sesi dihapus | Offline, hilang setelah 5 menit |

**Token** di kartu agen adalah total kumulatif sesi (input, output, reasoning, cache read, dan cache write),
dikirim setiap kali giliran selesai.

Ganti sesi di TUI (`/new`, `/sessions`) membuat karakter baru. Karakter sesi lama tetap santai di kantor sampai
OpenCode ditutup, karena OpenCode tidak memberi tahu kapan sebuah sesi ditinggalkan.

## 5. Pengaturan

Plugin membaca env var dulu, lalu `agent-hq.env` di folder yang sama dengan plugin (misalnya
`~/.config/opencode/plugins/agent-hq.env`). Contoh isi:

```bash
HQ_URL=http://127.0.0.1:8787
HQ_NAME=Rexx
HQ_TEAM=red
```

| Variabel | Default | Fungsi |
|---|---|---|
| `HQ_URL` | `http://127.0.0.1:8787` | alamat Agent HQ, tanpa `/api` |
| `HQ_TOKEN` | kosong | isi kalau Agent HQ dijalankan dengan `HQ_TOKEN` |
| `HQ_NAME` | `<folder>#xxxx` | nama karakter (huruf Latin; nama lain lewat ✎) |
| `HQ_ROLE` | `OpenCode · <folder>` | peran di kartu agen |
| `HQ_TEAM` | kosong | `red`, `report`, `blue`, `ops`: agen pindah ke ruangannya (Security, atau Ruang Server untuk `ops`) |
| `HQ_GROUP` | kosong | sesi dengan grup yang sama rapat bersama di ruang Meeting |
| `HQ_TIMEOUT` | `1.5` | batas tunggu kirim ke Agent HQ, dalam detik |
| `HQ_DISABLE` | mati | `1` mematikan plugin tanpa menghapusnya |
| `HQ_ENV_FILE` | `agent-hq.env` di samping plugin | file pengaturan lain |

Pengaturan dibaca saat OpenCode start, jadi buka ulang OpenCode setelah mengubahnya. OpenCode hanya memuat file
`.js` dan `.ts` dari folder plugin, jadi `agent-hq.env` di sana tidak dianggap plugin.

## 6. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Karakter tidak muncul | Agent HQ mati, atau OpenCode belum dibuka ulang setelah plugin disalin. Setelah gagal menghubungi Agent HQ, plugin diam 20 detik sebelum mencoba lagi. |
| Karakter dobel | Plugin ada di folder global dan di `.opencode/plugins/` project. Hapus salah satunya. |
| Karakter baru muncul setelah prompt | Normal. OpenCode membuat sesi saat prompt pertama. |
| `401` di log Agent HQ | `HQ_TOKEN` berbeda dengan token server Agent HQ. |
| Subagen bernama `subagen` | Nama agen tidak ada di panggilan `task`. Tidak mengganggu; bisa diganti lewat ✎. |
| Banyak karakter santai dari sesi lama | Lihat catatan `/new` di bagian 4. Tutup OpenCode, atau hapus karakter lewat event `remove` (README bagian 7). |
| Memakai OpenCode 2 (plugin API v2) | Plugin ini memakai API v1. OpenCode 2 belum didukung. |

## 7. Update dan mencopot

Update: salin ulang `examples/opencode/agent-hq.js` ke folder plugin (bagian 1), lalu buka ulang OpenCode.

Mencopot: hapus `agent-hq.js` (dan `agent-hq.env` kalau ada) dari folder plugin, lalu buka ulang OpenCode.
Untuk mematikan sementara: `HQ_DISABLE=1`.

## 8. Cara kerjanya

- Plugin memakai hook OpenCode `chat.message` (prompt), `tool.execute.before` (tool),
  `experimental.session.compacting` (compact), `event` (sesi, izin, pertanyaan, status, error, token), dan
  `dispose` (OpenCode ditutup). Semuanya diterjemahkan ke event hook Claude Code lalu dikirim ke `/api/hook`,
  jadi sensor rahasia, papan tugas, subagen, ruang meeting, dan rename sama persis dengan Claude Code. Status
  yang tidak punya padanan di Claude Code (izin dijawab, pertanyaan dijawab, token) dikirim ke `/api/event`.
- Id sesi OpenCode diawali waktu, sedangkan bridge memakai 8 karakter pertama sebagai id agen. Karena itu id
  sesi dan subagen di-hash SHA-1 dulu.
- Subagen dikenali dari sesi anak (`parentID`). Namanya diambil dari `subagent_type` panggilan `task`, atau dari
  judul sesi anak (`(@explore subagent)`).
- Hook plugin hanya memasukkan permintaan ke antrean lalu langsung kembali, jadi OpenCode tidak pernah menunggu
  Agent HQ. Antrean dikirim satu per satu di latar belakang supaya urutannya terjaga. Error ditelan; plugin tidak
  pernah menghentikan tool atau prompt.
- Tes: `tests/integration/agent-adapters.test.ts` (ikut `npm test`).
