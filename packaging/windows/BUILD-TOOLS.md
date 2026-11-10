# Alat build player Windows

Tidak perlu memasang alat berikut pada PC player. Installer menyertakan runtime yang diperlukan aplikasi.

- Node.js 24.22.2 Windows x64: `https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip`.
- Daftar hash resmi: `https://nodejs.org/dist/v24.22.2/SHASUMS256.txt`.
- SHA-256 ZIP Node: `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Binary `node.exe` terverifikasi Authenticode valid, penerbit OpenJS Foundation. LICENSE runtime disertakan dalam payload.
- NSIS portabel 3.12: rilis upstream `https://sourceforge.net/projects/nsis/files/NSIS%203/3.12/nsis-3.12.zip/`.
- Arsip diambil dari mirror MacPorts `https://ftp.kaist.ac.kr/macports/distfiles/nsis/nsis-3.12.zip` dan cocok dengan SHA-256 upstream `56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f`.
- Compiler C# menggunakan .NET Framework Windows yang sudah tersedia: `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

Struktur lokal yang diharapkan:

```text
build-tools/node-v24.22.2-win-x64/node.exe
build-tools/node-v24.22.2-win-x64/LICENSE
build-tools/nsis-3.12/Bin/makensis.exe
build-tools/nsis-3.12/COPYING
```

Jalankan `packaging/windows/Build-Player.ps1`. Build memakai daftar berkas eksplisit, memeriksa runtime dan logo, lalu membuat manifest, daftar uninstall, installer, dan SHA-256. Compiler memakai UTF-8 dan memperlakukan warning sebagai error. Tidak ada password/token/database pengguna dalam payload.

Mode QA installer `/S /EXTRACTONLY /D=folder-baru-absolut` hanya mengekstrak payload, tanpa registry, shortcut, startup atau peluncuran player. Folder harus baru/kosong; gunakan lokasi uji di workspace. Periksa seluruh `player-package.json`, lalu jalankan diagnostik atau tes EXE dengan data temporer terpisah.
