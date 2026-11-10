# Operasional

## Instalasi baru

Siapkan Docker Engine/Compose dan pastikan port 80/3210 tersedia. Dari root source:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1/api/health
curl --fail http://127.0.0.1:3210/api/health
```

Health menampilkan CMS 0.2.4. Untuk admin awal dari LAN, baca kode dengan docker compose exec -T signage cat /app/data/setup-token dan masukkan langsung ke form. Password minimal 12 karakter. Kode dihapus setelah admin dibuat.

Compose memakai proyek rj-digital-signage dan volume signage-data. Jangan gunakan identitas yang sama untuk instalasi terpisah pada host yang sama tanpa memisahkan konfigurasi/volume.

## Pembaruan dan backup

Simpan source/image aktif dan backup volume yang sudah diuji pemulihannya. Tinjau kompatibilitas data sebelum mengganti source/image, lalu jalankan compose dari rilis terpilih dengan volume yang sama. Jangan menjalankan docker compose down -v pada instalasi berisi data.

Backup volume lengkap dibuat saat layanan berhenti agar SQLite/media konsisten; ada jeda layanan. Simpan salinan terpisah dan uji restore terisolasi. deploy/verify-volume-backup.py tersedia sebagai pemeriksa arsip, SQLite dan hash media; baca bantuan/script sebelum pemakaian. Helper deploy lama yang mengunci versi/jalur instalasi tertentu tidak disertakan.

Backup dashboard berisi konten/pengaturan dengan maksimal 80 MB media per arsip JSON, tanpa password/sesi/token. Restore meminta PULIHKAN, memeriksa hash dan mempertahankan identitas yang sudah terdaftar. Migrasi server perlu penanganan pairing terpisah. Backup konten bukan pengganti backup volume penuh. Jangan unggah backup/DB/media/token ke GitHub.

## Player dan jaringan

PC harus dapat membuka http://IP-SERVER/api/health sebelum pairing. localhost pada PC player berarti PC itu sendiri. Alamat preset launcher dapat diganti. Player membuka SSE ke CMS; tidak perlu akses masuk jaringan ke Windows. Layanan lokal hanya 127.0.0.1:3211.

Saat aplikasi berjalan, http://127.0.0.1:3211/api/local/status menunjukkan versi, cache, kondisi pemutaran dan gangguan. Konten installer normal di %USERPROFILE%\Content RJ Digital; pairing/token/log terpisah di %LOCALAPPDATA%\RJ Digital Signage Player\data. File media memakai nama hash, isinya tetap file asli.

Konten cache tetap berjalan offline; YouTube memerlukan internet dan memakai cadangan lokal. Untuk HTTPS internal gunakan reverse proxy/sertifikat tepercaya; perubahan DNS/firewall tetap keputusan operator.

## Penerimaan perangkat

1. Pair player uji; terbitkan gambar/video/playlist dengan mute berbeda.
2. Pastikan unduhan lengkap sebelum tayangan aktif dan pergantian menunggu klip berjalan.
3. Uji jadwal, offline, restart player dan jam server/PC.
4. Periksa TV fisik/splitter serta restart VM/login Windows/autostart.
5. Cocokkan waktu sholat dan uji cadangan live bila dipakai.
6. Uji pemulihan backup sebelum penggunaan penuh.

Tes source/preview tidak membuktikan gangguan video atau jaringan PC fisik sudah selesai.
