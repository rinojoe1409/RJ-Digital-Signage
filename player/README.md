# RJ Player Windows 0.3.2

Windows 10/11 x64, Edge dan .NET Framework 4.8. Installer membundel Node.js 24. [Panduan pemasangan](../packaging/windows/PLAYER-INSTALLATION.md) dan [alat build](../packaging/windows/BUILD-TOOLS.md).

Jalankan packaging/windows/Build-Player.ps1 pada Windows. Hasil dist/windows-player/RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe dan checksum. Binary tidak disimpan dalam Git; [unduh installer publik dari GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases). Source dan script build tetap tersedia untuk membuat installer sendiri. Build publik memakai copyright Rino Joe dan alamat server generik; versi tetap 0.3.2.

Installer memakai akun Windows sehari-hari player. Buat kode pemasangan di CMS, isi alamat CMS yang terjangkau dan kode pada form, lalu Hubungkan & mulai. Autostart opsional setelah login; tanpa auto-login. Update memakai akun yang sama agar pairing/cache dipertahankan.

## Source

Butuh Node.js 24. Pair sekali:

```powershell
node player/agent.mjs pair
```

Isi alamat CMS, kode enam digit dan nama. Config privat source di player/data/config.json tidak boleh masuk Git. Pada Windows akses dibatasi ke akun pemasangan dan SYSTEM.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File player/Start-Player.ps1
```

Pengujian tanpa kiosk: node player/agent.mjs --headless. Pemutar http://127.0.0.1:3211/player.html; status /api/local/status. Script Install-Startup.ps1 opsional mendaftarkan task setelah login akun Windows saat ini.

## Konten

- Installer normal: %USERPROFILE%\Content RJ Digital; tombol Folder konten membukanya. Pairing/token/manifest/indeks/log di %LOCALAPPDATA%\RJ Digital Signage Player\data.
- Source dengan dataDir khusus memakai dataDir/media, kecuali --media-dir atau RJ_PLAYER_MEDIA ditentukan. --data-dir/RJ_PLAYER_DATA mengatur data privat.
- Cache memakai nama SHA-256 dan isi asli. Migrasi hanya menyalin cache valid, mempertahankan sumber dan tidak menyalin token ke folder konten. Perlu ruang salinan.
- Tayangan baru menunggu media lengkap/hash valid. Pergantian menunggu klip aktif, bukan seluruh playlist. Mute berlaku per klip.
- Konten/jadwal cache tetap berjalan offline. YouTube memerlukan internet dan cadangan lokal, tidak dicache.
- Diagnostik MediaError/YouTube membantu pemeriksaan; bukan bukti gangguan seluruh PC selesai.
- Cache belum dibersihkan dengan kuota otomatis. Pantau disk. Update/uninstall mempertahankan konten/data privat.
- Cuplikan menangkap layar utama PC; gunakan perangkat khusus. Periksa TV/splitter langsung.

Jadwal sholat impor diutamakan; cocokkan perhitungan cadangan dengan acuan setempat. Tidak ada azan.
