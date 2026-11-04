# Usulan: diskusi agen melalui monitor ruang meeting

Status: **draf, menunggu jawaban dan persetujuan pengguna**. Permintaan 2026-11-04: pengguna memberi goal melalui monitor ruang meeting Lt.4, beberapa agen berdiskusi, dan pengguna melihat chat mereka. Dokumen ini belum mengizinkan implementasi perubahan perilaku.

## Tujuan dan aksi utama

Pengguna membuka monitor Meeting A, B, atau C, memilih peserta, menulis goal, lalu memulai diskusi. Jawaban peserta diteruskan kepada peserta berikutnya sehingga mereka dapat menanggapi, mengoreksi, dan menyepakati hasil bersama.

## Alur pengguna

1. Klik monitor ruangan di Lt.4 atau pilih nama ruangan lewat kontrol HTML sebagai alternatif keyboard.
2. Panel ruangan terbuka di kanan, mengikuti pola panel Hermes/Server. Pada layar kecil panel memakai lebar layar yang tersedia.
3. Isi **Goal rapat**, pilih 2 sampai 5 peserta, lalu tekan **Mulai diskusi**. Tampilkan nama, peran, model, dan ketersediaan peserta.
4. Agen menempati kursi ruangan yang dipilih. Monitor menampilkan goal, peserta, status diskusi, dan pembicara saat ini.
5. Panel menampilkan percakapan secara langsung: nama agen, waktu, pesan, serta penanda putaran. Pengguna dapat membaca pesan lama tanpa dipaksa menggulir ke bawah; ada kontrol kembali ke pesan terbaru.
6. Pengguna dapat mengirim **Tambahkan arahan** untuk giliran berikutnya atau menekan **Hentikan**. Menutup panel atau memuat ulang halaman tidak menghentikan proses di server.
7. Rapat menghasilkan kesimpulan, keputusan, pertanyaan yang belum terjawab, dan rencana tindakan. Chat tetap dapat dibuka setelah rapat selesai.

## Model diskusi yang diusulkan

- Setiap peserta memakai sesi dan modelnya sendiri. Jawaban berasal dari panggilan agen sesungguhnya.
- Peserta berbicara bergiliran. Setiap giliran menerima goal, identitas/peran peserta, percakapan bersama yang relevan, dan arahan terbaru pengguna.
- Batas awal: 3 putaran diskusi, dapat dipilih 1 sampai 5 sebelum mulai, lalu 1 giliran rangkuman oleh peserta pertama sebagai fasilitator. Tampilkan batas ini di form agar rapat tidak berjalan tanpa akhir.
- Pesan satu agen menjadi konteks untuk giliran agen berikutnya. Chat bersama menampilkan pesan yang dipertukarkan, bukan penalaran internal model.
- Sesi yang sedang bekerja atau terpakai di rapat lain tidak dapat dipilih. Pemeriksaan dan reservasi dilakukan di server, termasuk terhadap klik bersamaan dari beberapa tab.
- Bila agen gagal atau koneksi terputus, hentikan giliran berikutnya dan tampilkan masalah beserta pesan yang sudah diterima. Jangan menampilkan hasil seolah semua peserta berhasil menjawab.
- **Hentikan** menghentikan run rapat yang bersangkutan; sesi dan rapat lain tetap berjalan.

## Tata letak dan konten

- Atas: nama ruangan, status, kontrol tutup.
- Sebelum mulai: goal sebagai input utama, daftar peserta, batas putaran, tombol mulai.
- Saat berlangsung: goal ringkas dan peserta di atas; percakapan mengambil sebagian besar tinggi panel; arahan dan tombol hentikan di bawah.
- Setelah selesai: kesimpulan diikuti percakapan yang tetap dapat dibaca.
- Gaya mengikuti `.impeccable.md` dan AGENTS.md; tidak mengubah geometri ruangan, kamera, warna, atau font yang sudah disetujui.

## Keadaan yang harus ditangani

- Ruangan kosong: petunjuk memilih peserta dan menulis goal.
- Belum ada peserta yang dapat dikendalikan: jelaskan sumber agen yang didukung dan cara menyiapkannya.
- Goal kosong, peserta kurang dari 2 atau lebih dari 5, duplikat peserta: pesan validasi di form.
- Ruangan dipakai rapat otomatis: tampilkan anggota dan status; jangan merebut ruangan atau memindahkan mereka tanpa tindakan pengguna.
- Menyiapkan / peserta sedang menjawab / merangkum: status dan pembicara terlihat di monitor serta panel.
- Memerlukan izin atau masukan: tampilkan permintaan untuk sesi yang benar dan tunggu pengguna; tidak memberi izin otomatis.
- Selesai / dihentikan / gagal: chat tetap terbaca, status akhir jelas.
- Browser tersambung ulang: ambil snapshot rapat dan lanjutkan menerima pesan tanpa mengulang giliran.
- Server restart: pulihkan catatan rapat dari penyimpanan; tandai proses yang terputus dan jangan mengulang panggilan model otomatis.
- Mode demo atau Hermes belum tersedia: jelaskan bahwa diskusi langsung belum dapat dimulai; jangan memalsukan chat agen.

## Rencana teknis

- Buat pengatur diskusi di server yang menargetkan sesi peserta secara eksplisit, tanpa mengganti sesi yang sedang dibuka di panel Hermes.
- Gunakan pola guard, token lewat header, redaksi teks sebelum broadcast/persistensi, dan SSE milik chat yang sudah ada. Kunci API tetap di server. Tidak menambah dependency runtime.
- Pisahkan transkrip diskusi dari log aktivitas kantor. Simpan goal, peserta, status, pesan, dan hasil akhir secara atomik di lokasi state aplikasi.
- Tambahkan identitas rapat dan penempatan manual ke perencana kursi, tetap melalui store; engine membaca hasilnya. Agen duduk selama rapat, termasuk saat menunggu giliran.
- Hubungkan raycast monitor ke panel ruangan. Monitor dibaca ulang sesuai laju Lt.4 yang sudah ditetapkan.
- Pastikan penghapusan peserta, compression/pergantian ID sesi, pembatalan, dan status hook tidak merusak reservasi rapat.

## Validasi

- Unit/integrasi dengan API Hermes tiruan: jawaban A diteruskan ke B; konteks dan model per peserta; putaran berakhir; rangkuman; stop; kegagalan; isolasi rapat dan chat biasa; reservasi; redaksi; pemulihan catatan tanpa menjalankan ulang model.
- Browser: klik monitor dan alternatif keyboard; isi goal/peserta; pesan streaming; baca pesan lama; arahan; hentikan; tutup/buka panel; muat ulang; tampilan 360 px.
- Jalankan lint, typecheck, test, build, serta cek route API tetap dinamis dan paritas yang relevan.

## Keputusan yang masih menunggu pengguna

1. Sumber peserta: agen Hermes yang sudah ada, agen Hermes baru khusus rapat, atau campuran Hermes/Claude Code/Codex. Jalur yang sekarang dapat menerima pesan dari aplikasi adalah sesi Hermes API server; sumber lain memerlukan adapter kontrol tersendiri.
2. Hasil rapat: diskusi dan rencana tindakan saja, atau dilanjutkan eksekusi goal. Jangan menganggap pilihan ini sudah disetujui.
3. Persetujuan alur dan batas diskusi di atas sebelum implementasi, sesuai aturan perubahan perilaku di AGENTS.md.

Referensi implementasi desain: `C:/Users/YOGA/.agents/skills/impeccable/reference/interaction-design.md` dan `spatial-design.md`, dengan aturan tampilan proyek sebagai acuan utama.
