# Manual Instalasi RJ Digital Signage System

**Server Linux / Docker dan Player Windows**

| Informasi | Keterangan |
|---|---|
| Versi manual | 1.1 — 11 November 2026 |
| Sistem server contoh | Ubuntu Server 24.04 LTS |
| Versi source acuan | CMS 0.2.4 / Windows Player 0.3.2 |
| Penggunaan | Jaringan lokal / on-premises |
| Copyright | ©2026 Rino Joe |

Manual ini untuk **instalasi baru dengan data kosong**. Pemindahan layout, video, akun, dan pairing dari server lama memerlukan backup dan proses migrasi terpisah. Perintah pemasangan Docker di bawah khusus Ubuntu; sesuaikan panduan resmi jika memakai distribusi lain.

## Daftar isi

1. [Persiapan](#1-persiapan)
2. [Pemasangan Docker](#2-pemasangan-docker)
3. [Download aplikasi dari GitHub](#3-download-aplikasi-dari-github)
4. [Upload aplikasi ke server](#4-upload-aplikasi-ke-server)
5. [Jalankan CMS](#5-jalankan-cms)
6. [Periksa akses CMS](#6-periksa-akses-cms)
7. [Buat akun admin](#7-buat-akun-admin)
8. [Hubungkan player Windows](#8-hubungkan-player-windows)
9. [Penyimpanan dan backup](#9-penyimpanan-dan-backup)
10. [Pemeriksaan akhir dan pemecahan masalah](#10-pemeriksaan-akhir-dan-pemecahan-masalah)

## 1. Persiapan

Siapkan:

- Server Ubuntu Server 24.04 LTS dengan IP tetap atau reservasi DHCP.
- Akun Linux dengan akses SSH dan izin `sudo`.
- PuTTY untuk menjalankan perintah dan WinSCP untuk mengirim file melalui SFTP.
- Internet pada server untuk pemasangan Docker dan pengunduhan image saat build pertama.
- Port TCP **80 dan 3210** tersedia pada server.
- Browser laptop untuk mengunduh source dari repository publik; tidak memerlukan login GitHub.
- Installer RJ Player Windows `.exe` untuk PC player, diunduh dari [GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases).

Dalam manual ini, `IP-SERVER` adalah penanda yang harus diganti dengan alamat IP Linux baru. Password Linux, password admin, kode pengaturan, dan token cukup dimasukkan langsung pada aplikasi yang memintanya.

Semua blok perintah `bash` dijalankan di **PuTTY pada server Linux**. Server host tidak perlu dipasangi Node.js atau NPM; runtime CMS sudah berada dalam image Docker.

Periksa distribusi server:

```bash
cat /etc/os-release
```

## 2. Pemasangan Docker

Jika Docker dan Compose sudah terpasang serta dapat digunakan, lanjut ke langkah 3. Jangan memasang ulang Docker pada host yang sudah menjalankan layanan lain tanpa meninjau kondisinya.

Untuk Ubuntu baru yang belum memiliki Docker, jalankan:

```bash
sudo apt update
sudo apt install -y ca-certificates curl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Jika suatu perintah gagal, periksa penyebabnya sebelum melanjutkan. Langkah ini tidak menghapus paket/container lama secara otomatis.

Aktifkan Docker saat server menyala dan periksa pemasangannya:

```bash
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Hasil yang diharapkan: Docker menampilkan informasi Client dan Server tanpa error koneksi; Compose menampilkan versinya.

## 3. Download aplikasi dari GitHub

Lakukan pada browser laptop:

1. Buka https://github.com/rinojoe1409/RJ-Digital-Signage.
2. Gunakan branch default repository dan klik **Code → Download ZIP**.
3. Ekstrak ZIP di laptop.
4. Ubah nama folder hasil ekstrak menjadi **`rj-digital-signage`**.

Pastikan folder tersebut langsung berisi:

```text
rj-digital-signage/
├── compose.yaml
├── Dockerfile
├── package.json
├── server/
├── public/
├── shared/
└── branding/
```

Sertakan seluruh isi source, termasuk file bertitik seperti `.dockerignore`. Hindari folder bertingkat ganda `rj-digital-signage/rj-digital-signage/`.

Repository aplikasi ini publik dan source dapat diunduh tanpa login GitHub. Tidak perlu menyimpan token GitHub pada server dengan metode ini. Manual mengacu pada CMS 0.2.4 / Player 0.3.2; periksa package.json dan dokumentasi rilis jika versi source berubah.

## 4. Upload aplikasi ke server

Pada WinSCP:

1. Buat koneksi dengan protokol **SFTP**.
2. Isi host dengan IP server baru, port SSH yang digunakan (umumnya 22), serta username Linux.
3. Login dan pastikan identitas host SSH sesuai server tujuan.
4. Buka folder home akun Linux pada panel server.
5. Upload seluruh folder **`rj-digital-signage`** dari laptop ke panel server.
6. Tunggu transfer selesai.

Contoh lokasi jika username Linux adalah `USER-LINUX`:

```text
/home/USER-LINUX/rj-digital-signage/
```

Pada PuTTY, masuk ke folder aplikasi dan periksa dua file utamanya:

```bash
cd "$HOME/rj-digital-signage"
ls -l compose.yaml Dockerfile
```

Kedua file harus ditemukan sebelum melanjutkan.

## 5. Jalankan CMS

Pastikan masih berada di folder aplikasi. Periksa penggunaan port:

```bash
sudo ss -ltnp '( sport = :80 or sport = :3210 )'
```

Jika ada layanan lain yang menggunakan port 80 atau 3210, selesaikan bentroknya terlebih dahulu. Jangan mematikan layanan lain tanpa mengetahui fungsinya.

Periksa konfigurasi dan jalankan CMS:

```bash
sudo docker compose config -q
sudo docker compose up -d --build
sudo docker compose ps
```

`config -q` yang berhasil biasanya tidak menampilkan output. Build pertama memerlukan waktu untuk mengunduh runtime dan membuat image. Tunggu sampai perintah selesai tanpa error.

Service bernama **`signage`** harus berstatus berjalan. Status health dapat sementara menampilkan `starting` saat aplikasi baru menyala, kemudian menjadi `healthy`.

Konfigurasi bawaan menyediakan:

- Port 80 untuk akses CMS tanpa mengetik port.
- Port 3210 untuk kompatibilitas alamat lama.
- Penyimpanan data pada volume Docker terpisah.
- `restart: unless-stopped` agar container kembali berjalan bersama Docker setelah reboot, selama tidak sengaja dihentikan.

## 6. Periksa akses CMS

Di server, jalankan:

```bash
curl --fail http://127.0.0.1/api/health
```

Hasil yang diharapkan: JSON dengan status **`ok`** dan versi CMS **`0.2.4`** untuk source acuan manual ini.

Jika gagal, baca pesan aplikasi:

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 signage
```

Kemudian dari browser laptop buka:

```text
http://IP-SERVER/
```

Ganti `IP-SERVER` dengan IP Linux baru. Tidak perlu mengetik `:3210`.

Jika health berhasil di server tetapi gagal dari laptop/PC player, periksa IP, jalur LAN/VLAN, serta firewall host/VM/jaringan untuk TCP 80. Pertahankan akses dalam jaringan internal sesuai kebutuhan on-premises; jangan mengandalkan aturan UFW saja untuk membatasi port yang dipublikasikan Docker.

## 7. Buat akun admin

Pada pemasangan baru belum ada akun/password admin bawaan. Baca kode pengaturan awal melalui PuTTY:

```bash
sudo docker compose exec -T signage cat /app/data/setup-token
```

Pada halaman pengaturan awal CMS:

1. Buat username admin.
2. Buat password minimal **12 karakter**.
3. Masukkan kode pengaturan awal dari PuTTY.
4. Selesaikan pembuatan akun dan pastikan dashboard terbuka.

Kode pengaturan awal dihapus setelah admin berhasil dibuat. Jika instalasi sudah memiliki admin, tidak adanya file `setup-token` adalah keadaan yang dapat diharapkan; jangan menghapus database untuk membuat ulang kode.

Simpan password dengan aman. Jangan memasukkan password/kode/token ke source, repository, atau manual ini.

## 8. Hubungkan player Windows

Siapkan PC Windows 10/11 x64, Microsoft Edge, dan .NET Framework 4.8. Untuk source acuan ini gunakan installer **RJ Digital Signage Player 0.3.2**:

```text
RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe
```

Unduh file installer `.exe` dari [GitHub Releases](https://github.com/rinojoe1409/RJ-Digital-Signage/releases), lalu gunakan pada PC player. Binary distribusi terpisah dari source Git. Script pembuat installer tersedia pada `packaging/windows/` jika ingin membangun sendiri dengan lingkungan Windows. Build publik memakai copyright Rino Joe dan alamat server generik; versi aplikasi tetap CMS 0.2.4 / Player 0.3.2.

Langkah pemasangan dan pairing:

1. Pasang installer di PC player.
2. Dari browser pada **PC player**, buka `http://IP-SERVER/api/health` dan pastikan berhasil.
3. Di CMS, buka menu **Player** dan buat kode pemasangan.
4. Buka RJ Player. Isi alamat CMS dengan `http://IP-SERVER`, lalu masukkan kode pemasangan.
5. Hubungkan player dan pastikan statusnya terlihat di CMS.
6. Upload media, buat layout, pilih player tujuan, lalu klik **Terbitkan**.
7. Tunggu transfer selesai dan periksa tayangan pada monitor/TV langsung.

Jangan mengisi `localhost` sebagai alamat CMS jika CMS berjalan di mesin Linux yang berbeda. `localhost` pada PC player menunjuk PC player itu sendiri.

Konten installer normal tersimpan pada:

```text
%USERPROFILE%\Content RJ Digital
```

Konfigurasi pairing, token, dan data privat player terpisah pada:

```text
%LOCALAPPDATA%\RJ Digital Signage Player\data
```

Ketika aplikasi player berjalan, status lokal dapat dibaca dari browser PC yang sama:

```text
http://127.0.0.1:3211/api/local/status
```

Video lokal yang telah tersimpan dapat diputar tanpa koneksi CMS. YouTube Live memerlukan internet pada player. Uji kelancaran video, suara per klip, dan keluaran splitter pada perangkat fisik; instalasi source tidak otomatis membuktikan semuanya sudah lancar.

## 9. Penyimpanan dan backup

CMS memakai named volume Docker:

```text
rj-digital-signage_signage-data
```

Volume memuat database dan media. Menyalin folder source saja **tidak** mencadangkan isi CMS. Gunakan konfigurasi volume bawaan; jangan menggantinya dengan folder lain tanpa meninjau hak akses dan data.

Setelah CMS digunakan, **jangan menjalankan `docker compose down -v`**, karena opsi `-v` menghapus volume proyek beserta data di dalamnya.

Untuk pemulihan/pindah server, siapkan backup volume lengkap yang konsisten dan sudah diuji restore. Pembuatan backup saat layanan dihentikan memerlukan jeda layanan. Backup dari dashboard dibatasi maksimal 80 MB media per arsip dan tidak membawa password/sesi/token; backup itu bukan pengganti backup volume penuh. Lihat `RUNBOOK.md` dalam source untuk batas dan ketentuan operasional.

## 10. Pemeriksaan akhir dan pemecahan masalah

### Checklist penerimaan

- [ ] Service `signage` berjalan dan health menjadi `healthy`.
- [ ] `/api/health` berhasil dari server, laptop admin, dan PC player.
- [ ] CMS dapat dibuka tanpa mengetik port.
- [ ] Akun admin berhasil dibuat.
- [ ] Player terhubung dan transfer media selesai.
- [ ] Gambar/video/playlist berjalan pada monitor atau TV langsung.
- [ ] Mute per video, running text, jadwal, dan waktu sholat diperiksa jika digunakan.
- [ ] Docker aktif saat boot; uji kembali akses CMS setelah reboot terencana.
- [ ] Backup serta prosedur pemulihannya tersedia.

### Gangguan umum

| Gejala | Pemeriksaan pertama |
|---|---|
| `docker: command not found` | Pastikan pemasangan Docker berhasil. |
| `permission denied` pada Docker | Jalankan perintah dengan `sudo`. |
| `no configuration file provided` | Masuk ke folder yang berisi `compose.yaml`. |
| `port is already allocated` / alamat sudah dipakai | Periksa port 80 dan 3210; jangan hentikan layanan lain secara sembarang. |
| Build gagal mengunduh image | Periksa internet, DNS, dan akses ke registry dari server. |
| CMS gagal dibuka dari semua perangkat | Periksa `docker compose ps`, log service, dan health dari server. |
| Health lokal berhasil, PC player gagal | Periksa IP/rute/firewall/VLAN dari PC tersebut sebelum pairing. |
| Player menampilkan `fetch failed` | Pastikan alamat CMS benar dan health bisa dibuka dari PC player. |
| Status lokal port 3211 ditolak | Pastikan RJ Player masih berjalan dan browser dibuka di PC player yang sama. |

## Referensi

- [Repository RJ Digital Signage System](https://github.com/rinojoe1409/RJ-Digital-Signage)
- [Docker Engine untuk Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker: konfigurasi setelah instalasi](https://docs.docker.com/engine/install/linux-postinstall/)
- [GitHub: download source ZIP](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)
- [WinSCP: upload file/folder](https://winscp.net/eng/docs/guide_upload)

Manual disusun dari konfigurasi dan panduan source acuan serta dokumentasi resmi yang diperiksa pada 11 November 2026. Versi layanan/paket di masa depan dapat berubah. Pembuatan manual ini tidak menjalankan pemasangan atau perubahan pada server.
