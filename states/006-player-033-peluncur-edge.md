# 006 — Player 0.3.3: peluncuran Edge dan YouTube berulang

Tanggal: 17 November 2026.

## Temuan

- Rekaman perangkat menunjukkan YouTube hilang, menampilkan thumbnail/buffering, lalu memutar lagi sekitar setiap lima detik.
- Riwayat pemutaran berulang pada `renders=1` dan `attempt=1`, tanpa alasan fallback atau kode error YouTube. Ini konsisten dengan dokumen browser baru; riwayat tersebut sendiri belum membuktikan penyebab tunggal.
- Agen 0.3.2 membuka Edge kembali lima detik setelah proses yang diluncurkan keluar, tanpa memeriksa apakah halaman tayangan masih aktif.
- Uji Edge Windows dengan profil sementara membuktikan proses peluncuran dapat keluar dengan kode 21 sementara halaman browser sebelumnya tetap hidup. Tidak menggunakan profil browser pribadi/perangkat produksi.

## Perubahan

- Supervisor menahan peluncuran ulang selama laporan halaman tayangan yang valid masih segar, termasuk ketika proses pembuka menyerahkan pekerjaan ke browser yang sudah berjalan.
- Waktu terima laporan menggunakan jam monotonik server lokal; timestamp dari halaman tidak menentukan masa aktifnya.
- Tenggang awal 30 detik dan tenggang laporan browser delegasi 90 detik. Pemulihan halaman delegasi yang benar-benar hilang dapat menunggu sampai tenggang tersebut habis.
- Proses Edge milik player yang masih hidup tidak diganti hanya karena laporan terlambat saat jendela tersembunyi.
- Hanya satu timer pengawas dan satu peluncuran aktif. Penghentian membatalkan timer dan membersihkan proses yang memang dimiliki.
- `/api/local/status` menampilkan versi 0.3.3 dan diagnostik `browser` berupa penghitung/status/waktu peluncuran, keluar, serta laporan halaman. Tidak memuat URL, token, atau PID.
- CMS tetap 0.2.4. Renderer, aturan durasi, pairing dan folder konten tidak diubah.

## Verifikasi

- 77 tes utama lulus, 0 gagal, 2 tes EXE dilewati pada suite utama lalu keduanya dijalankan terpisah dan lulus.
- Tujuh regresi baru: handoff kode 21 selama 300 detik simulasi, laporan terhambat, halaman delegasi hilang, laporan tidak valid/timestamp masa depan, event ganda, startup/shutdown bersamaan, dan mode headless.
- Syntax JavaScript 36 berkas lulus; PowerShell lulus; ESLint 0 error/2 warning lama.
- Installer dibangun ulang; 20 berkas hasil ekstraksi cocok manifest. Diagnostik launcher x64, pairing, folder konten, supervisi proses, shutdown dan cold start offline lulus.
- Startup dan registrasi pemasangan komputer pengembangan tetap sama selama uji ekstraksi.
- Installer: `RJ-Digital-Signage-Player-Setup-0.3.3-x64.exe`, 24.918.908 byte, SHA-256 `185a592009d9b915abaef082d7a615adb6eaa29f8e93ceb9c02822d8c08366fb`.

## Batas hasil

Paket disiapkan sebagai kandidat uji lapangan. Pengujian lokal membuktikan penanganan kondisi proses peluncur keluar; penyelesaian kedip pada PC pelapor masih perlu dikonfirmasi setelah pembaruan. Tidak melakukan perubahan pada CMS operasional atau mengklaim gangguan GPU/jaringan selesai. Browser yang tetap hidup tetapi macet/tidak memiliki jendela tidak dihentikan hanya berdasarkan laporan terlambat.
