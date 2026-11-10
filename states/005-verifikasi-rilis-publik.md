# 005 — Verifikasi rilis publik

Tanggal: 11 November 2026.

- Identitas copyright pada source, logo, CMS, launcher dan installer: `©2026 Rino Joe`.
- Logo navy–teal dan nama Digital Signage System dipertahankan; hanya footer copyright direvisi. SHA-256 PNG: `5c167c93f838a8d909011a3ee69cc82091d2870b6afcba6d15a09a4a2d023945`.
- Node.js 24: 70 pemeriksaan API/agen/cache/jadwal/editor/browser lulus, 0 gagal; 2 tes EXE dilewati pada suite utama, lalu dijalankan terpisah dan keduanya lulus.
- Tes EXE terkemas: pairing privat, folder konten, migrasi cache, supervisi proses, shutdown dan cold start offline lulus.
- Pemeriksaan JavaScript: 35 berkas lulus. PowerShell: 8 berkas lulus. ESLint: 0 error, 2 warning variabel yang tidak dipakai.
- Verifier backup Python: 5 tes lulus.
- Installer dibangun ulang tanpa warning compiler. Ekstraksi 20 berkas cocok manifest; diagnostik EXE x64 lulus. Ekstraksi/uji tidak memasang startup atau registrasi installer pada komputer pengembangan.
- Installer publik: `RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe`, 24.903.533 byte; SHA-256 `159f9b3d8a540efb78cbdd6529ced7b66024e35ddfb56bcc1c81dd7d00e164fa`.
- Audit 80 berkas staged sebelum penambahan catatan ini: tidak ada data operasional, kredensial nyata, alamat kantor, path operator, atau riwayat Git asal. Nama institusi lama tidak ada dalam teks/logo; identitas commit menggunakan email noreply.
- CMS tetap 0.2.4 dan Player 0.3.2. Adaptasi publik memuat branding dan alamat preset generik; fitur durasi yang ditunda tidak disertakan.

Pemeriksaan ini tidak melakukan deployment ke server operasional dan tidak menguji ulang TV/splitter/perangkat player fisik. Gangguan fisik yang pernah dilaporkan tidak diklaim selesai. Distribusi source dan installer dilakukan melalui repository/Releases publik dengan checksum.
