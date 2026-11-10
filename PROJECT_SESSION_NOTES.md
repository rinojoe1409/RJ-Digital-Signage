# Catatan sesi publikasi source

## 11 November 2026

Pengguna meminta aplikasi RJ Digital Signage dipush ke GitHub miliknya. Export mandiri memakai baseline CMS 0.2.4 dan overlay Player 0.3.2, tanpa perubahan durasi 0.2.5 yang ditunda.

- Hash baseline 106/106 cocok sebelum penyalinan.
- Paket Windows dapat dibangun dari script source; binary/alat build tidak disertakan.
- Tes browser memakai dependency lokal/override lingkungan tanpa path akun pengembang; default Chromium Playwright.
- Build source menyertakan packaging/; dokumentasi diringkas untuk repository.
- Data, token, backup, media operasional, riwayat operator dan arsip lama dikeluarkan.
- Aplikasi asal dan instalasi server tidak diubah oleh export.

Hasil tes/push/deployment dicatat terpisah sesuai bukti; persiapan source tidak otomatis membuktikan ketiganya selesai. Lihat states/001-export-github.md.

Verifikasi source selesai: syntax JavaScript/PowerShell, lint tanpa error, 5 tes backup Python dan build source lulus. Suite Chrome 69 lulus/1 gagal fixture kosong/2 tes EXE dilewati; pengulangan khusus playlist dengan Edge lulus. Detail dan batas verifikasi: states/002-verifikasi-source.md. Hasil di atas berasal dari validasi source sebelum adaptasi publik; tidak melakukan deployment server.

## 11 November 2026 — Manual instalasi

Atas permintaan pengguna, manual instalasi versi 1.0 ditambahkan di `deploy/Manual-Instalasi-RJ-Digital-Signage-Server-Linux.md` dan ditautkan dari README. Salinan identik dengan file manual yang sudah diberikan. Perubahan README yang sudah ada di remote dipertahankan. Penambahan ini hanya dokumentasi; versi CMS/player dan runtime tidak berubah. Rincian: `states/003-manual-instalasi.md`.

## 11 November 2026 — Persiapan source publik

Pengguna mengizinkan aplikasi dan manual dapat diunduh publik. Export baru hanya mengambil berkas tracked dari source acuan, tanpa .git, data, token, media operasional, binary atau hasil build. Repository asal tidak diubah. URL manual diarahkan ke repository publik, default alamat player/installer dan contoh akun server dibuat generik. Seluruh copyright/publisher menggunakan Rino Joe sesuai permintaan terbaru. Monogram RJ tetap, baris copyright logo direvisi. Manual lengkap berada di deploy/ dan ditautkan dari root. Tidak ada perubahan versi, aturan durasi, protokol atau lisensi. Lihat states/004-persiapan-source-publik.md; commit/push, pengujian adaptasi dan deployment adalah tahap terpisah.

## 11 November 2026 — Verifikasi paket publik

Source adaptasi lulus 70 pemeriksaan utama dan 2 tes EXE terkemas, 5 tes backup Python, syntax JS/PowerShell, serta lint tanpa error. Installer branding Rino Joe dibangun ulang dan 20 berkas hasil ekstraksi cocok manifest; tidak mengubah startup/registrasi komputer pengembangan. Logo baru beserta gate hash diperbarui. Audit public source tidak menemukan kredensial nyata, alamat kantor, atau riwayat Git lama. Rincian dan checksum: states/005-verifikasi-rilis-publik.md. Tidak ada deployment server/perangkat fisik pada tahap publikasi.
