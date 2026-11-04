# Agent HQ + Codex

Panduan ini menyambungkan [Codex CLI](https://github.com/openai/codex) (OpenAI) ke Agent HQ, supaya setiap sesi
Codex, termasuk subagennya, tampil sebagai karakter di kantor seperti sesi Claude Code. Berlaku untuk `codex`
di terminal, `codex exec`, dan ekstensi Codex di VS Code (semuanya memakai `~/.codex` yang sama).

Codex punya hook dengan nama event dan isi yang hampir sama dengan Claude Code, tapi hanya bisa menjalankan
perintah (tidak bisa mengirim HTTP langsung). Karena itu ada skrip kecil `examples/codex/hq_codex.mjs` yang
meneruskan setiap event ke `/api/hook` Agent HQ.

Butuh: Codex CLI dengan hook (diuji di 0.164) dan Node.js 18+ (sudah ada kalau Codex dipasang lewat npm).

## Isi

1. [Pasang](#1-pasang)
2. [Percayai hook di Codex](#2-percayai-hook-di-codex)
3. [Cek](#3-cek)
4. [Nama, peran, tim, dan grup](#4-nama-peran-tim-dan-grup)
5. [Yang terlihat di kantor](#5-yang-terlihat-di-kantor)
6. [Pengaturan](#6-pengaturan)
7. [Pasang manual](#7-pasang-manual)
8. [Masalah umum](#8-masalah-umum)
9. [Update dan mencopot](#9-update-dan-mencopot)
10. [Cara kerjanya](#10-cara-kerjanya)

## 1. Pasang

Nyalakan Agent HQ dulu (README bagian 1), lalu dari folder repo ini:

```bash
node examples/codex/install.mjs
```

Yang dilakukan installer:

- Menyalin `hq_codex.mjs` ke `~/.codex/agent-hq/`. Setelah itu Codex tidak bergantung lagi pada folder repo.
- Membuat `~/.codex/agent-hq/agent-hq.env` (alamat Agent HQ, nama default, token) kalau belum ada.
- Menambahkan satu hook per event (10 event) ke `~/.codex/hooks.json`. File lama dicadangkan dulu
  (`hooks.json.agent-hq-<waktu>.bak`), dan hook lain tetap ada.
- Mengecek apakah Agent HQ terjangkau, dan memperingatkan kalau `config.toml` mematikan hook.

Installer aman dijalankan ulang: hook Agent HQ lama diganti, tidak dobel.

| Pilihan | Fungsi |
|---|---|
| `--url http://127.0.0.1:9787` | alamat Agent HQ lain (disimpan di `agent-hq.env`) |
| `--codex-home <folder>` | folder Codex lain (default `$CODEX_HOME` atau `~/.codex`) |
| `--node <path>` | path `node` yang dipakai hook (default: `node` di Windows, path lengkap Node saat ini di macOS/Linux) |
| `--print` | tampilkan blok `hooks.json`, tanpa mengubah apa pun |
| `--uninstall` | copot hook dan folder `~/.codex/agent-hq` |

## 2. Percayai hook di Codex

Codex **melewati hook baru diam-diam** sampai kamu mempercayainya. Ini berlaku juga untuk `codex exec` dan
ekstensi VS Code, jadi lakukan sekali di terminal:

```bash
codex          # lalu ketik /hooks
```

Di daftar `/hooks`, hook `hq_codex.mjs` bertanda "review required". Percayai (trust) semuanya. Codex menyimpan
pilihan ini per hook, jadi hanya perlu diulang kalau isi hook berubah (misalnya setelah installer dijalankan
dengan `--url` atau `--node` lain).

Hook di Codex aktif secara default. Kalau `~/.codex/config.toml` punya `[features]` dengan `hooks = false`,
hapus baris itu.

## 3. Cek

Tes skripnya tanpa Codex. Perintah ini mengirim karakter "Tes Codex" yang muncul, merayakan, lalu offline:

```bash
node ~/.codex/agent-hq/hq_codex.mjs --test
```

```powershell
node "$HOME\.codex\agent-hq\hq_codex.mjs" --test
```

Hasilnya `OK: ...`, atau `GAGAL: ...` dengan sebabnya (`tidak terjangkau`, `HTTP 401 (HQ_TOKEN salah?)`).

Lihat terjemahan satu event tanpa mengirim apa pun:

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"tes","cwd":"/tmp/shop","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node ~/.codex/agent-hq/hq_codex.mjs --dry-run
```

Setelah itu buka sesi `codex` baru dan kirim prompt. Karakter muncul begitu sesi dimulai.

## 4. Nama, peran, tim, dan grup

```bash
HQ_NAME=Rexx  HQ_TEAM=red codex
HQ_NAME=Vexa  HQ_GROUP="Rilis v2.3" codex
codex                                   # tanpa nama: "<folder>#xxxx"
```

PowerShell: `$env:HQ_NAME="Rexx"; codex`.

Ekstensi VS Code tidak membawa env dari terminal. Tulis nama default di `~/.codex/agent-hq/agent-hq.env`
(bagian 6), atau ganti nama lewat tombol ✎ di kartu agen (permanen, README bagian 3).

## 5. Yang terlihat di kantor

| Yang terjadi di Codex | Yang kamu lihat |
|---|---|
| Sesi dimulai | Karakter masuk, peran `Codex · <folder>` |
| Prompt masuk | Karakter mikir; kalau sedang santai, kartu tugas muncul di Papan Tugas (Lt.2) |
| Perintah shell | Kerja, bubble `$ npm test` |
| `apply_patch` | Kerja, bubble `Edit cart.py` atau `Menulis new.py`; lebih dari satu file: `Edit cart.py (+2)` |
| Tool MCP | Kerja, bubble `MCP github: create_issue` |
| `update_plan` | `Update daftar tugas` |
| Codex minta izin | Melambai, status oranye "Butuh kamu" |
| Giliran selesai | Confetti, lalu jalan ke area santai |
| Kamu menekan Esc (Interrupt) | Santai, "Menunggu prompt berikutnya", tanpa confetti |
| Merangkum konteks (compact) | Mikir, "Merangkum konteks (compact)" |
| Subagen dimulai | Sesi naik ke ruang meeting Lt.4 bersama subagennya; subagen tanpa peran bernama `subagen#xxxx` |
| Subagen selesai | Subagen pergi sekitar 45 detik kemudian |
| Sesi ditutup | Offline, hilang setelah 5 menit |

**Token** di kartu agen adalah total kumulatif sesi (input termasuk cache, dan output), dibaca dari transcript
Codex setiap kali prompt masuk dan giliran selesai.

Codex tidak punya hook untuk tool yang gagal, jadi baris "gagal" seperti di Claude Code tidak muncul. Pencarian
web bawaan Codex juga tidak lewat hook, jadi tidak tampil sebagai bubble.

## 6. Pengaturan

Semua pengaturan ada di `~/.codex/agent-hq/agent-hq.env`. Env var dengan nama sama selalu menang.

| Variabel | Default | Fungsi |
|---|---|---|
| `HQ_URL` | `http://127.0.0.1:8787` | alamat Agent HQ, tanpa `/api` |
| `HQ_TOKEN` | kosong | isi kalau Agent HQ dijalankan dengan `HQ_TOKEN` |
| `HQ_NAME` | `<folder>#xxxx` | nama karakter (huruf Latin; nama lain lewat ✎) |
| `HQ_ROLE` | `Codex · <folder>` | peran di kartu agen |
| `HQ_TEAM` | kosong | `red`, `report`, `blue`: agen pindah ke ruangannya di Lt.3 |
| `HQ_GROUP` | kosong | sesi dengan grup yang sama rapat bersama di Lt.4 Meeting |
| `HQ_TIMEOUT` | `1.5` | batas tunggu kirim ke Agent HQ, dalam detik |
| `HQ_DISABLE` | mati | `1` mematikan hook tanpa mengubah `hooks.json` |
| `HQ_STATE_DIR` | folder temp sistem | tempat catatan "Agent HQ tidak terjangkau" |

Perubahan langsung berlaku di event berikutnya, tanpa restart Codex.

## 7. Pasang manual

```bash
mkdir -p ~/.codex/agent-hq
cp examples/codex/hq_codex.mjs ~/.codex/agent-hq/
cp examples/codex/agent-hq.env.example ~/.codex/agent-hq/agent-hq.env
node examples/codex/install.mjs --print      # blok hooks.json dengan path yang benar
```

Bentuk bloknya (ulangi untuk `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`; `SessionEnd` dan `Interrupt`
maksimal `timeout: 3`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"/home/kamu/.codex/agent-hq/hq_codex.mjs\"", "timeout": 5 }] }
    ]
  }
}
```

Hook juga boleh ditulis sebagai tabel `[hooks]` di `config.toml`, atau di `.codex/hooks.json` milik satu
project (project itu harus dipercaya Codex). Pakai satu tempat saja supaya tidak ada karakter dobel.

## 8. Masalah umum

| Masalah | Penyebab dan solusi |
|---|---|
| Karakter tidak pernah muncul | Hook belum dipercaya: `codex`, lalu `/hooks` (bagian 2). Cek juga `node ~/.codex/agent-hq/hq_codex.mjs --test`. |
| `--test` menulis `tidak terjangkau` | Agent HQ mati atau `HQ_URL` salah. Setelah gagal, hook diam 20 detik sebelum mencoba lagi. |
| `--test` menulis `HTTP 401 (HQ_TOKEN salah?)` | `HQ_TOKEN` di `agent-hq.env` berbeda dengan token server Agent HQ. |
| Muncul di terminal, tidak dari VS Code | Hook dipercaya per isi hook; ulangi `/hooks` setelah menjalankan installer lagi. Nama dari env terminal tidak sampai ke VS Code, pakai `agent-hq.env`. |
| `node` tidak ditemukan (macOS/Linux, nvm) | Jalankan ulang installer dari shell yang punya Node yang benar, atau `--node /path/ke/node`, lalu percayai hook lagi. |
| Codex memperingatkan hook ganda | `hooks.json` dan `[hooks]` di `config.toml` sama-sama berisi hook Agent HQ. Hapus salah satunya. |
| Karakter dobel untuk satu sesi | Hook terpasang di dua lapisan (user dan project). Sisakan satu. |
| Token di kartu kosong | Transcript belum menulis `token_count`; angka muncul setelah giliran berikutnya selesai. |

## 9. Update dan mencopot

Setelah repo berubah: `node examples/codex/install.mjs`, lalu buka `/hooks` di Codex kalau ada hook yang perlu
dipercaya ulang. Untuk mencopot: `node examples/codex/install.mjs --uninstall` (hook lain di `hooks.json` tetap
ada). Untuk mematikan sementara: `HQ_DISABLE=1` di `agent-hq.env`.

## 10. Cara kerjanya

- Codex menjalankan `hq_codex.mjs` sekali per event dan mengirim satu objek JSON lewat stdin. Skrip menerjemahkan
  sedikit lalu meneruskannya ke `/api/hook`, jadi sensor rahasia, papan tugas, subagen, ruang meeting, dan rename
  sama persis dengan Claude Code.
- Id sesi Codex (UUIDv7) diawali waktu, sedangkan bridge memakai 8 karakter pertama sebagai id agen. Karena itu
  id sesi dan subagen di-hash SHA-1 dulu, supaya dua sesi yang dimulai berdekatan tidak jadi satu karakter.
- Nama tool Codex diubah ke padanan Claude Code (`apply_patch` jadi `Edit`/`Write`, `update_plan` jadi
  `TodoWrite`), dan `Interrupt` jadi `Notification` "idle". Event lain (`PostToolUse`, permintaan model) tidak
  dipasang karena tidak ada yang perlu ditampilkan.
- Total token diambil dari baris `token_count` terakhir di transcript Codex (`total_token_usage.total_tokens`)
  dan dikirim ke `/api/event`.
- Skrip tidak pernah mencetak ke stdout (stdout hook bisa dibaca Codex sebagai konteks), selalu keluar dengan
  kode 0, dan tidak memblokir Codex.
- Tes: `tests/integration/agent-adapters.test.ts` (ikut `npm test`).
