# Agent HQ + Claude Code

Panduan ini menyambungkan Claude Code ke Agent HQ, supaya setiap sesi (dan subagennya) tampil sebagai karakter
di kantor. Claude Code mengirim aktivitasnya lewat **hooks** tipe `http` ke `http://127.0.0.1:8787/api/hook`.
Tidak ada skrip tambahan: bridge Agent HQ sendiri yang menerjemahkan event-nya.

## 1. Nyalakan Agent HQ

```bash
npm install
npm run dev            # atau: npm run build && npm start
curl -s http://127.0.0.1:8787/api/health      # {"ok":true,...}
```

## 2. Pasang hook (sekali saja)

Installer menggabungkan `examples/claude-hooks.settings.json` ke `~/.claude/settings.json`. Jalan sama di Windows,
macOS, dan Linux (tidak butuh `jq`). Setting dan hook lain tetap ada, file lama dicadangkan dulu
(`settings.json.agent-hq-<waktu>.bak`), dan aman dijalankan ulang: hook Agent HQ diganti, tidak dobel.

```bash
node examples/claude/install.mjs                         # semua project di laptop ini
node examples/claude/install.mjs --project ../shop-api   # satu project saja (<folder>/.claude/settings.json)
```

| Pilihan | Fungsi |
|---|---|
| `--url http://127.0.0.1:9787` | alamat Agent HQ lain |
| `--settings <file>` | file setting lain, misalnya `.claude/settings.local.json` |
| `--print` | tampilkan blok hook hasil gabungan, tanpa mengubah apa pun |
| `--uninstall` | copot hook Agent HQ saja |

Lalu **buka sesi `claude` baru**. Sesi yang sudah jalan masih memakai hook lama. Kalau Claude Code memberi tahu
bahwa hook berubah, buka `/hooks` untuk memuatnya.

Cara manual (tanpa installer): kalau `~/.claude/settings.json` belum ada, cukup salin
`examples/claude-hooks.settings.json` ke sana. Kalau sudah ada, gabungkan blok `hooks` dengan tangan.

## 3. Nama, peran, tim, dan grup (opsional)

```bash
HQ_NAME=Rexx   HQ_TEAM=red    claude    # repo pentest
HQ_NAME=Glimbo HQ_ROLE=Coder  claude    # sesi coding biasa
HQ_NAME=Vexa   HQ_GROUP="Rilis v2.3" claude
claude                                  # tanpa nama: "<folder>#<4 huruf session>"
```

PowerShell: `$env:HQ_NAME="Rexx"; $env:HQ_TEAM="red"; claude`.

- `HQ_TEAM`: `red`, `report`, `blue`, atau kosong (ditebak dari prompt dan perintah).
- `HQ_GROUP`: sesi dengan grup yang sama rapat bersama di Lt.4 Meeting. Subagen ikut sesinya otomatis.
- `HQ_TOKEN`: isi kalau Agent HQ dijalankan dengan `HQ_TOKEN`.
- Nama bisa diganti kapan saja lewat tombol ✎ di kartu agen (README bagian 3).

## 4. Yang terlihat di kantor

| Claude Code | Kantor |
|---|---|
| Prompt masuk | kartu di Papan Tugas (Lt.2), karakter mengambilnya |
| Tool jalan | karakter kerja, bubble `$ npm test`, `Edit auth.go` |
| Minta izin | melambai, "Butuh kamu" |
| Selesai | confetti, lalu santai |
| Subagen | sesi naik ke ruang meeting Lt.4 bersama subagennya |
| Sesi ditutup | offline, hilang setelah 5 menit |

Token di kartu agen dibaca dari transcript Claude Code (semua jenis token, kumulatif per sesi).
Kalau Agent HQ mati, Claude Code tetap jalan normal: hook menunggu paling lama 3 detik.

## 5. Masalah umum

| Masalah | Solusi |
|---|---|
| Sesi tidak muncul | `curl -s http://127.0.0.1:8787/api/health`; pastikan sesi dibuka setelah hook dipasang. |
| Karakter dobel | hook terpasang di dua file (global dan project). Jalankan `--uninstall` di salah satunya. |
| `401` di log Agent HQ | `HQ_TOKEN` di shell `claude` berbeda dengan di server. |
| Installer menolak `bukan JSON yang valid` | perbaiki `settings.json` dulu; installer tidak mengubah file rusak. |
