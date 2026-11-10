# Kebutuhan RJ Digital Signage System

Pemilik keputusan: Mas Rino. Identitas mengikuti DESIGN_LOCK.md.

- Server Linux/Docker on-premise pada VM Proxmox, diakses melalui LAN.
- Player Windows adalah unit yang dikelola; splitter menggandakan output identik ke banyak TV.
- Alur signage mengacu pada Xibo yang disederhanakan, tanpa klaim kesetaraan seluruh fitur.
- Gambar, video, playlist, running text, jam, waktu sholat dan YouTube Live opsional. Mute playlist diatur per video.
- Playlist mengikuti urutan dan durasi file. YouTube memerlukan internet dan tidak dicache sebagai video offline.
- Publish memberi notifikasi; player mengunduh dan memeriksa media sebelum tayangan baru aktif.
- Pergantian menunggu klip file aktif selesai; live tidak menahan pergantian. Jadwal/cache tetap berjalan saat LAN putus.
- Pantau progres/status/cuplikan; kondisi PC tidak membuktikan TV fisik setelah splitter.
- Batalkan terbit melepaskan penugasan dan menonaktifkan jadwal terkait sebelum layout dapat dihapus.
- Batalkan unggahan menghentikan file berjalan dan sisa antrean; file selesai tetap tersimpan.
- Node.js 24 ESM dan SQLite bawaan tanpa dependency NPM runtime; dashboard HTML/CSS/JS dengan renderer bersama.
- Player memakai agen lokal, Edge kiosk, launcher WinForms dan installer EXE dengan runtime resmi.
- CMS internal 3210, compose menerbitkan 80/3210; player lokal hanya loopback 3211.
- Admin dibuat sendiri; tanpa password bawaan. Kredensial bukan bagian source/paket.
- Konten installer normal di Content RJ Digital pada profil Windows; pairing/token tetap privat di AppData.
- Migrasi menyalin cache valid tanpa menghapus sumber; autostart opsional setelah login, tanpa auto-login.
- Jadwal sholat impor diutamakan; perhitungan cadangan perlu acuan setempat. Tidak ada azan.
- Setiap perubahan penting dicatat dalam Markdown dan status versi.

Batas source: CMS 0.2.4/Player 0.3.2. Durasi unlimited ditunda. Gangguan video/jaringan PC fisik perlu diagnosis terpisah.
