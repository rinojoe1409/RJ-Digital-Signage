# Versi source

Export: 11 November 2026, Asia/Jakarta.

Dokumentasi instalasi: manual versi 1.1 untuk source publik, 11 November 2026, tersedia di `deploy/Manual-Instalasi-RJ-Digital-Signage-Server-Linux.md`. Versi aplikasi tetap seperti tabel berikut.

| Komponen | Versi | Sumber |
|---|---|---|
| CMS/dashboard | 0.2.4 | rj-signage-0.2.4-20261110074838 |
| Agen/launcher Windows | 0.3.2 | Source player yang telah dibangun/diuji, termasuk Content RJ Digital |
| Renderer bersama | Sesuai player 0.3.2 | Diagnostik video dan perlindungan hasil play() yang kedaluwarsa |

Seluruh 106 hash baseline diperiksa sebelum export. Server, admin, package dan compose mempertahankan 0.2.4. Overlay player membawa folder konten, migrasi cache yang mempertahankan sumber dan pesan gangguan video lebih jelas. Renderer dipakai preview CMS/player; gabungan ini bukan salinan byte identik image CMS terpasang.

Dikeluarkan: kandidat durasi 0.2.5, helper jaringan belum teruji, helper deploy spesifik instalasi lama, arsip lama, data operasional, pairing, token, backup, binary dan alat build. Tidak ada deployment server dalam export ini. Pemasangan/kelancaran/koneksi PC fisik perlu verifikasi terpisah.

## Adaptasi publik — 11 November 2026

Source CMS 0.2.4 / Player 0.3.2 disiapkan untuk https://github.com/rinojoe1409/RJ-Digital-Signage dalam export terpisah tanpa riwayat Git asal. Manual 1.1 memakai URL publik. Alamat jaringan preset dan contoh akun Linux asal diganti placeholder. Monogram RJ dipertahankan, seluruh teks copyright/publisher diseragamkan menjadi Rino Joe sesuai permintaan terbaru; logo direvisi pada baris copyright. Tidak ada lisensi baru. Versi aplikasi tidak berubah. Installer build publik menggunakan branding Rino Joe dan alamat server generik; asset distribusi terpisah pada https://github.com/rinojoe1409/RJ-Digital-Signage/releases. Hasil publikasi/validasi adaptasi dicatat setelah benar-benar selesai.
