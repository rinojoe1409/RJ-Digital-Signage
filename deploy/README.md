# Deployment

Pemasangan baru memakai Docker Compose dari root source; lihat RUNBOOK.md. Backup instalasi aktif dan tinjau kompatibilitas sebelum update. Jangan menghapus volume.

verify-volume-backup.py memeriksa arsip volume, restore sementara, SQLite dan hash media. tests/backup-verifier.test.py menguji penerimaan/penolakan arsip. Helper terminal/deploy lama yang terikat versi dan jalur instalasi tertentu tidak disertakan; tidak ada deployment otomatis dari repository ini.
