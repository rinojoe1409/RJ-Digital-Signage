# RJ Digital Signage System

Source aplikasi CMS signage ini dapat diunduh publik dan dijalankan pada server Linux menggunakan Docker. Source Windows Player dan script build installer `.exe` juga disertakan; installer `.exe` publik disediakan terpisah melalui [GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases). Satu output player dapat digandakan melalui splitter ke banyak layar dengan tayangan identik.

Source berisi **CMS 0.2.4** dan **Windows Player 0.3.2**. Versi keduanya berbeda karena dirilis terpisah. Copyright ©2026 Rino Joe

Repository: https://github.com/rinojoe1409/RJ-Digital-Signage

[Manual instalasi langkah demi langkah](deploy/Manual-Instalasi-RJ-Digital-Signage-Server-Linux.md) mencakup pengunduhan source tanpa login, Docker, setup CMS dan player.

Manual instalasi adalah buku petunjuk untuk memasang RJ Digital pada server Linux baru sampai CMS berjalan dan player Windows dapat menampilkan tayangan. Unduh source CMS lewat **Code → Download ZIP**, ikuti manual, lalu ambil installer player dari **Releases**.

## Fitur

- Editor layout drag/resize, layer, draft dan pratinjau.
- Gambar, video, playlist video dengan mute per klip, running text, jam dan waktu sholat. Elemen dapat dinonaktifkan.
- YouTube Live opsional dengan cadangan lokal; memerlukan internet dan izin embed.
- Terbitkan langsung, jadwal, batalkan terbit, rollback tayangan dan indikator transfer per player.
- Media diperiksa sebelum tayangan baru aktif. Video file aktif diselesaikan sebelum pergantian. Konten dan jadwal cache tetap berjalan offline.
- Cuplikan/status player, backup/restore dan tombol Batalkan unggahan.

## CMS Linux/Docker

[Manual instalasi server baru langkah demi langkah](deploy/Manual-Instalasi-RJ-Digital-Signage-Server-Linux.md) mencakup Ubuntu 24.04, Docker, setup admin, pairing player, backup, dan pemecahan masalah.

Siapkan Docker Engine dan Compose, lalu dari root source:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1/api/health
```

Buka http://IP-SERVER/ tanpa port. Compose juga menyediakan port 3210 untuk kompatibilitas. Buat admin sendiri; tidak ada akun/password bawaan. Password minimal 12 karakter. Kode pengaturan awal untuk akses LAN dibaca langsung pada server:

```sh
docker compose exec -T signage cat /app/data/setup-token
```

Masukkan kode pada formulir, jangan simpan ke repository. Data berada pada volume Docker terpisah. Lihat [RUNBOOK.md](RUNBOOK.md).

## CMS lokal dari source

Butuh Node.js 24. Tidak perlu dependency NPM runtime:

```sh
node server/server.mjs
```

Buka http://localhost:3210/. Pada Windows tersedia Start-Local.cmd. Data lokal dibuat pada folder data/ yang diabaikan Git.

## Windows Player

Windows 10/11 x64, Microsoft Edge dan .NET Framework 4.8. Installer membundel Node.js 24; binary distribusi berada di Releases, sedangkan alat build tidak disimpan dalam Git. Build publik memakai copyright Rino Joe dan alamat server generik; versi player tetap 0.3.2.

- [Unduh installer Windows dari GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases).
- [Panduan player](player/README.md).
- [Alat build](packaging/windows/BUILD-TOOLS.md), lalu jalankan packaging/windows/Build-Player.ps1 pada Windows.
- [Panduan pemasangan](packaging/windows/PLAYER-INSTALLATION.md).
- Hasil: dist/windows-player/RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe beserta checksum.

Gunakan alamat CMS yang dapat dijangkau PC player dan kode pemasangan dari menu Player. Konten installer normal disimpan di %USERPROFILE%\Content RJ Digital. Pairing/token tetap terpisah di %LOCALAPPDATA%\RJ Digital Signage Player\data.

## Pengembangan dan verifikasi

Pasang devDependencies hanya untuk lint/tes browser:

```sh
npm install
npx playwright install chromium
npm run check
npm run lint
node --test --test-concurrency=1 tests/*.test.mjs shared/*.test.mjs player/*.test.mjs
python3 tests/backup-verifier.test.py
npm run build
```

Tes browser memakai Chromium Playwright; RJ_PLAYWRIGHT_PATH dan RJ_BROWSER_EXECUTABLE dapat menunjuk modul/browser yang tersedia. Tes EXE memerlukan Windows dan RJ_PLAYER_EXE; tanpa itu dilewati. Tes YouTube Live nyata terpisah, memerlukan internet/link yang mengizinkan embed. Tes simulasi tidak membuktikan perangkat fisik atau layanan eksternal sudah diuji.

Build membuat folder source baru dengan MANIFEST.json di dist/, tanpa data, token, media operasional atau alat build. Tidak ada kompilasi TypeScript/frontend.

## Status

Perubahan durasi unlimited 0.2.5 ditunda atas permintaan pengguna dan tidak termasuk source ini. Durasi layout mempertahankan perilaku CMS 0.2.4. Gangguan video tersendat/pengulangan dini dan koneksi PC fisik masih perlu verifikasi; diagnostik bukan klaim masalah itu selesai.

Lihat [PROJECT_VERSION.md](PROJECT_VERSION.md), [PROJECT_MASTER.md](PROJECT_MASTER.md) dan [states/README.md](states/README.md). Monogram RJ dipertahankan dengan Copyright ©2026 Rino Joe; tidak ada lisensi open source baru.
