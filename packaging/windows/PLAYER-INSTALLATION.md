# RJ Digital Signage Player — Windows

Versi player 0.3.2, untuk Windows 10/11 64-bit. Microsoft Edge dan .NET Framework 4.8 atau lebih baru perlu tersedia. Runtime Node.js 24 sudah termasuk dalam installer.

Unduh installer `.exe` publik dari [GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases). Source dan script build juga tersedia pada repository. Build publik memakai copyright Rino Joe dan alamat server generik, dengan versi player tetap 0.3.2.

## Pemasangan pada PC player

1. Masuk memakai akun Windows yang akan digunakan sehari-hari untuk signage.
2. Jalankan `RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe`.
3. Pilih apakah player berjalan otomatis setelah akun Windows login, lalu selesaikan pemasangan.
4. Pada CMS buka menu **Player**, lalu buat kode pemasangan enam digit.
5. Buka **RJ Player**, isi alamat CMS, nama player, dan kode tersebut. Klik **Hubungkan & mulai**.
6. Terbitkan layout atau jadwal dari CMS ke player. Output PC dapat digandakan memakai splitter.

Alamat CMS: `http://IP-SERVER/`. Ganti `IP-SERVER` dengan IP server Linux yang dapat dijangkau dari PC player. Tidak perlu mengetik port; port `:3210` juga tersedia untuk kompatibilitas. Jangan memakai `localhost` bila CMS berada pada mesin lain.

Kode pemasangan hanya dipakai sekali dan kedaluwarsa setelah sepuluh menit. Tidak perlu memasukkan password administrator CMS ke aplikasi player.

## Pemakaian

- Player tampil fullscreen menggunakan Microsoft Edge. Ikon RJ di dekat jam Windows menyediakan kontrol player dan pengaturan. Menu Start menyediakan shortcut **Pengaturan Player**.
- Tombol **Folder konten** pada pengaturan player atau menu tray **Buka folder konten** membuka `%USERPROFILE%\Content RJ Digital`.
- Autostart berlaku setelah login Windows. Aplikasi tidak mengatur auto-login Windows.
- Konten baru diaktifkan setelah media selesai diunduh dan diperiksa. Pergantian menunggu video yang sedang aktif selesai satu putaran.
- Setelah konten tersimpan, player tetap memutar konten dan mengevaluasi jadwal saat jaringan/server terputus.
- Video, running text dan waktu sholat mengikuti pilihan aktif/nonaktif pada layout CMS.
- **Playlist video** memerlukan CMS 0.2.2 dan Player 0.3.2 atau lebih baru. Satu elemen memutar beberapa video berurutan sesuai daftar, mengikuti durasi asli masing-masing, lalu mengulang dari awal.
- Setiap video dalam playlist mempunyai pilihan **Bisukan suara** sendiri. Klip lama yang belum mempunyai pengaturan tersebut mengikuti mute elemen agar layout lama tetap berjalan sesuai pengaturan sebelumnya.
- Saat publish atau jadwal mengganti tayangan, player menyelesaikan klip yang sedang berjalan, lalu beralih tanpa menunggu seluruh playlist selesai. Editor memakai placeholder tanpa memutar video atau suara; gunakan Pratinjau untuk mencoba playlist.
- YouTube Live tersedia pada CMS 0.2.0 dan player 0.3.2: tambahkan elemen **YouTube Live**, tempel link video/live langsung, dan pilih gambar/video lokal sebagai cadangan. Link channel bukan link siaran langsung.
- PC player memerlukan internet untuk YouTube. Konten YouTube tidak disimpan sebagai file offline; cadangan lokal tetap dapat diputar saat live gagal atau internet terputus. Player mencoba menyambung lagi setelah gangguan. Live yang sudah berakhir tetap memakai cadangan sampai layout diterbitkan ulang.
- Gunakan satu YouTube aktif per layout, area nyata minimal 200×200 piksel tanpa tertutup elemen lain. Letakkan jam/running text di luar area siaran. Pemutaran tetap mengikuti izin embed, kontrol dan kebijakan YouTube.
- Pergantian publish/jadwal tidak menunggu siaran live selesai. Jika ada video file biasa pada layout yang sama, video file tersebut tetap menyelesaikan putaran yang sedang berjalan.
- Player 0.3.2 mempertahankan siaran saat buffering sementara, dengan tenggang sampai 60 detik sebelum beralih ke cadangan. Perubahan jadwal mendatang tidak memuat ulang tayangan yang masih aktif.
- Cuplikan dari CMS menangkap layar utama PC player; gunakan PC khusus signage. Kondisi TV setelah splitter tetap diperiksa secara fisik.
- Tabel waktu sholat yang diimpor diutamakan. Cocokkan perhitungan cadangan dengan acuan setempat. Tidak ada suara azan pada versi ini.

## Data, pembaruan, dan penghapusan

Konten gambar/video secara default berada di **`%USERPROFILE%\Content RJ Digital`**, misalnya `C:\Users\NamaPengguna\Content RJ Digital`. Gunakan tombol **Folder konten** untuk membuka lokasi yang benar pada akun player. File cache tetap memakai nama hash agar pemeriksaan keutuhan dan pemutaran offline konsisten; isi video tidak dikonversi.

Data pairing, token, manifest, indeks media dan log tetap berada di `%LOCALAPPDATA%\RJ Digital Signage Player\data`, terpisah dari konten dan berkas program. Token tidak ditampilkan dan akses penyimpanannya dibatasi untuk akun Windows tersebut dan SYSTEM. Aplikasi tidak menyalin data pairing/token ke folder konten.

Untuk memperbarui ke 0.3.2, jalankan installer pada akun Windows yang sama. Pairing tetap tersimpan sehingga tidak perlu memasangkan ulang. Pada pemakaian pertama, cache lama yang valid disalin ke folder konten baru; cache lama tetap dipertahankan. Perlu ruang disk untuk salinan konten. Jika nama file bertabrakan dengan berkas berbeda pada folder tujuan, player menampilkan pesan tanpa menimpa berkas itu.

Penghapusan aplikasi tersedia di **Settings → Apps** Windows atau menu Start. Data pairing dan konten dipertahankan; penghapusan aplikasi tidak menghapus player yang terdaftar di CMS.

Cache media lama belum dibersihkan berdasarkan kuota otomatis. Pantau kapasitas disk PC. Jika ingin mengganti server atau identitas, gunakan pengaturan untuk memasangkan ulang secara eksplisit.

## Pemeriksaan teknis tanpa menyalakan layar player

Jalankan dari folder program:

```powershell
& '.\RJ Player.exe' --self-test --diagnostic-result "$env:TEMP\rj-player-diagnostic.json"
```

Diagnostik memeriksa kelengkapan paket, runtime, Edge dan .NET tanpa pairing, startup, tangkapan layar, atau kiosk.

Saat tayangan berjalan, status pemutaran dapat dibaca di `http://127.0.0.1:3211/api/local/status` pada PC player. Menu **Folder log** menyediakan `playback-diagnostic.json`, riwayat terbatas kondisi YouTube untuk pemeriksaan gangguan; file ini tidak memuat password, token pairing, atau link siaran.

Untuk konfigurasi teknis, launcher menerima `--media-dir "LOKASI_KONTEN"`. Bila memakai `--data-dir` khusus tanpa `--media-dir`, konten tetap mengikuti subfolder `media` di lokasi data khusus tersebut; ini mempertahankan isolasi pengujian dan konfigurasi lama. Pemakaian installer normal tanpa argumen memakai folder Content RJ Digital di profil Windows.

Installer belum ditandatangani dengan sertifikat penerbit aplikasi. Ikuti kebijakan instalasi software organisasi jika Windows meminta verifikasi penerbit.

Copyright ©2026 Rino Joe.
