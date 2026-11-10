# Export source mandiri

Tanggal: 11 November 2026, Asia/Jakarta.

Baseline rj-signage-0.2.4-20261110074838; hash manifest 106/106 cocok sebelum export. Server/admin/package/compose tetap baseline. Overlay Player 0.3.2 mencakup agen, launcher C#, folder konten/migrasi, renderer diagnostik dan tes terkait.

Script build EXE disertakan tanpa binary/alat build. Build source menyalin packaging/. Path akun pengembang pada tes diganti dependency lokal/override; default Chromium Playwright. Perilaku runtime tidak diubah oleh penyesuaian tes.

Tidak disertakan: durasi unlimited 0.2.5 yang ditunda, helper jaringan belum diuji, helper deploy lama, riwayat operator, DB/token/media/backup/cache, binary/arsip/hasil build. Logo/copyright tetap; tidak ada lisensi baru.

Verifikasi tahap persiapan: hash baseline cocok. Validasi gabungan meliputi sintaks/lint/tes/build dan audit data; hasil aktual dicatat sesudah selesai. Tidak ada deployment atau instalasi player fisik pada tahap export. Gangguan video/jaringan perangkat fisik belum dinyatakan selesai.
