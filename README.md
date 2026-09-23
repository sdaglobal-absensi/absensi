# Absensi & Database Karyawan

Aplikasi absensi karyawan berbasis web (vanilla JS + Supabase). Absensi memakai
verifikasi **GPS lokasi** + **foto selfie** saat check-in/check-out. Ada 4 role:
**Super Admin**, **Super Admin HR**, **Admin HR**, dan **Karyawan**.

## Role

| Role | Akses |
|---|---|
| **Super Admin** | All Akses — semua menu, semua data, termasuk mengatur akses Admin HR & Karyawan. |
| **Super Admin HR** | Setara persis dengan Super Admin (All Akses). Dua role terpisah supaya bisa dipegang orang yang berbeda tanpa harus berbagi satu akun "super admin". |
| **Admin HR** | Akses dibatasi. Menu mana saja yang boleh dibuka diatur oleh Super Admin/Super Admin HR lewat menu **Pengaturan Sistem** — baik menu staff (approval, laporan, master data, dst) maupun menu pribadi (absensi/izin/lembur sendiri, karena Admin HR juga karyawan). Secara default: boleh monitor absensi, approve izin & lembur, lihat laporan, dan absen/ajukan izin & lembur sendiri — tapi *tidak* boleh buka Data Karyawan, Slip Gaji, Kenaikan Upah, atau Master Data sampai dinyalakan manual. |
| **Karyawan** | Check-in/out, ajukan izin & lembur, lihat riwayat sendiri. Menu mana saja dari keempat ini yang aktif juga diatur lewat **Pengaturan Sistem** (default: semua menyala, sama seperti sebelumnya). |

Menu pribadi (Absensi, Pengajuan Izin, Pengajuan Lembur, Riwayat Saya) kini
muncul di sidebar **semua role** — Super Admin, Super Admin HR, dan Admin HR
juga bisa absen dan mengajukan izin/lembur untuk diri sendiri, tidak cuma
role Karyawan.

Pembatasan akses Admin HR **dan** Karyawan ditegakkan di **dua lapis**: menu
disembunyikan di sidebar (UI), dan RLS (Row Level Security) di Supabase
menolak query langsung ke tabel terkait kalau menu itu belum diizinkan — jadi
bukan cuma "disembunyikan", tapi benar-benar tertutup di sisi server. Toggle
akses Admin HR dan Karyawan disimpan terpisah (per role), jadi mematikan
suatu menu untuk satu role tidak memengaruhi role lainnya.

## Fitur

- **Karyawan**: check-in/check-out dengan foto + validasi lokasi GPS terhadap
  radius kantor, ajukan izin/sakit/cuti/lembur, lihat riwayat & rekap kehadiran sendiri.
- **Admin HR**: monitor absensi semua karyawan, approve/reject izin & lembur,
  lihat laporan — plus menu tambahan (Data Karyawan, Slip Gaji, dst.) kalau
  diizinkan Super Admin.
- **Super Admin / Super Admin HR**: semua fitur Admin HR + kelola data karyawan,
  master data, slip gaji, kenaikan upah, dan mengatur akses Admin HR & periode
  cut-off gaji lewat **Pengaturan Sistem**.

## Struktur Proyek

```
index.html                Halaman login
app.html                  Shell aplikasi (sidebar + router modul + guard akses per menu)
css/style.css              Semua styling
js/supabaseClient.js       Koneksi Supabase (isi URL & anon key di sini)
js/auth.js                  Login, logout, proteksi halaman per role
js/core.js                   Util bersama: sidebar (dinamis sesuai permission), role helper,
                              periode cut-off slip gaji, GPS, kamera, upload foto, format
js/modules/
  employee-absensi.js       Check-in/out (GPS + kamera)
  employee-izin.js           Form & riwayat pengajuan izin
  employee-lembur.js         Form & riwayat pengajuan lembur
  employee-riwayat.js        Riwayat & rekap absensi pribadi
  admin-karyawan.js          CRUD data karyawan (menu "karyawan")
  admin-absensi.js           Monitor absensi semua karyawan (menu "absensi-monitor")
  admin-izin.js              Approval izin (menu "izin-approval")
  admin-lembur.js            Approval lembur (menu "lembur-approval")
  admin-kenaikan-upah.js     Riwayat & input kenaikan upah/gaji (menu "kenaikan-upah")
  admin-slip-gaji.js         Hitung & cetak slip gaji, ikut periode cut-off, bisa difinalisasi/dikunci (menu "slip-gaji")
  admin-laporan.js           Laporan bulanan + export (menu "laporan")
  admin-master-*.js          Master data (level, tunjangan, denda, departemen, jadwal, libur, lokasi)
  super-pengaturan.js        Kelola akses menu Admin HR + atur cut-off slip gaji (khusus Super Admin/Super Admin HR)
supabase-schema.sql         Semua tabel, RLS policy, trigger, storage bucket
```

## Setup

### 1. Buat project Supabase
Buka [supabase.com](https://supabase.com) → New Project.

### 2. Jalankan schema
Buka **SQL Editor** di dashboard Supabase → paste isi `supabase-schema.sql` →
**Run**. Ini akan membuat semua tabel, trigger, RLS policy, storage bucket
`attendance-photos`, tabel `role_permissions` (default akses Admin HR & akses
Karyawan, satu baris per role per menu), dan tabel `payroll_settings` (default
cut-off = tanggal 1, alias kalender biasa).

> Kalau ini upgrade dari versi lama (role `admin`/`hr`), script yang sama aman
> dijalankan ulang — akun `admin` otomatis jadi `super_admin`, akun `hr`
> otomatis jadi `admin_hr`, tanpa perlu bikin ulang akun.
>
> Kalau ini upgrade dari versi sebelum `role_permissions` punya kolom `role`
> (toggle akses masih cuma untuk Admin HR), script yang sama juga aman
> dijalankan ulang — kolom `role` otomatis ditambahkan, baris lama dilabeli
> `admin_hr`, lalu baris default baru untuk menu pribadi (Admin HR) dan untuk
> role Karyawan ditambahkan tanpa menimpa pengaturan yang sudah ada.

### 3. Sambungkan aplikasi ke Supabase
Buka **Project Settings → API**, salin **Project URL** dan **anon public key**,
lalu isi di `js/supabaseClient.js`:

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

### 4. Set lokasi kantor
Di tabel `office_locations` (lewat Table Editor), sesuaikan `lat`, `lng`, dan
`radius_meters` dengan koordinat kantor asli. Bisa lebih dari satu baris kalau
ada beberapa cabang.

### 5. Buat akun Super Admin pertama
Tidak ada halaman daftar publik (sengaja dihilangkan) — semua akun karyawan
dibuat lewat panel admin. Untuk akun Super Admin pertama:

1. Di Supabase Dashboard → **Authentication → Users → Add user** → buat user
   dengan email & password kamu sendiri (centang **Auto Confirm User**).
   Trigger otomatis akan membuat baris di tabel `profiles` dengan role
   `karyawan`.
2. Di **SQL Editor**, jadikan Super Admin:
   ```sql
   update public.profiles set role = 'super_admin'
   where id = (select id from auth.users where email = 'emailkamu@contoh.com');
   ```
   (Ganti `'super_admin'` jadi `'super_admin_hr'` kalau mau akun ini jadi
   Super Admin HR — keduanya All Akses, tinggal pilih salah satu.)
3. Login di `index.html` — sekarang kamu masuk sebagai Super Admin dan bisa
   menambah karyawan/Admin HR lain lewat menu **Data Karyawan** (otomatis
   membuat akun login untuk mereka).

### 6. Atur akses Admin HR, akses Karyawan & periode cut-off slip gaji
Login sebagai Super Admin/Super Admin HR → buka menu **Pengaturan Sistem**:
- **Kelola Akses Menu** — satu tabel dengan dua kolom checkbox berdampingan,
  **Akses Admin HR** dan **Akses Karyawan**, jadi bisa diatur sekaligus di satu
  tempat. Kedua toggle independen satu sama lain (mematikan menu untuk satu
  role tidak memengaruhi role lainnya). Menu staff (approval, laporan, master
  data, dst) cuma berlaku untuk Admin HR — kolom Akses Karyawan di baris itu
  ditandai "–". Menu pribadi (Absensi, Pengajuan Izin, Pengajuan Lembur,
  Riwayat Saya) berlaku untuk keduanya — default: menyala semua untuk kedua
  role (Admin HR karena mereka juga karyawan; Karyawan sama seperti perilaku
  sebelumnya). Menu staff selain itu, default sesuai tabel Role di atas.
- **Periode Cut-Off Slip Gaji** — isi `1` untuk periode kalender biasa
  (tanggal 1 s/d akhir bulan), atau isi tanggal lain (mis. `26`) kalau
  perusahaan pakai cut-off, misalnya periode berjalan dari tanggal 26 bulan
  sebelumnya sampai tanggal 25 bulan yang dipilih. Berlaku global untuk semua
  karyawan.

> **Catatan tentang mengubah cut-off setelah berjalan lama:** pengaturan ini
> cuma satu angka global, dan periode gaji yang **belum difinalisasi** selalu
> dihitung ulang pakai cut-off yang *sedang* berlaku. Jadi kalau cut-off
> diubah 6 bulan/setahun lagi, membuka ulang slip gaji periode lama yang
> belum difinalisasi bisa menggeser rentang tanggalnya dan mengubah
> angkanya. Data absensi/lembur asli tidak ikut berubah — cuma cara
> pengelompokannya ke periode yang bergeser. Supaya slip gaji yang sudah
> dicetak/diserahkan ke karyawan tidak ikut berubah, gunakan tombol
> **🔒 Finalisasi Periode Ini** di menu Slip Gaji setiap periode selesai —
> begitu difinalisasi, angkanya dibekukan permanen (tabel `payroll_periods` +
> `payroll_slips`) dan tidak lagi dihitung ulang otomatis walau cut-off atau
> tarif di Master Level/Master Denda/Master Tunjangan berubah di kemudian
> hari. Kalau perlu dikoreksi, ada tombol **🔓 Buka Kunci** untuk kembali ke
> mode draft, lalu finalisasi ulang setelah dikoreksi.

### 7. Aktifkan email untuk fitur "Lupa Password"
Fitur reset password memakai `supabase.auth.resetPasswordForEmail`, yang
otomatis aktif begitu project Supabase dibuat (pakai email bawaan Supabase).
Kalau mau pakai domain email sendiri, atur di **Authentication → Email
Templates / SMTP Settings**. Pastikan juga di **Authentication → URL
Configuration**, `reset-password.html` (URL lengkap situs kamu, contoh
`https://namamu.github.io/absensi/reset-password.html`) ditambahkan ke
**Redirect URLs**, atau reset password tidak akan berfungsi.

### 8. Jalankan secara lokal
Karena pakai ES Modules, buka lewat local server (bukan `file://`), misalnya:

```bash
npx serve .
# atau
python3 -m http.server 8080
```

### 9. Deploy
Bisa langsung deploy folder ini ke **GitHub Pages**, **Netlify**, atau
**Vercel** — murni file statis, tidak butuh backend server sendiri (backend =
Supabase).

## Catatan Keamanan

- Semua akses data diatur lewat **Row Level Security (RLS)** di Supabase —
  karyawan hanya bisa melihat/mengubah data miliknya sendiri; Super Admin &
  Super Admin HR bisa melihat/mengubah semua data; Admin HR mengikuti
  `role_permissions` per menu (lihat tabel Role di atas).
- Role akun **tidak pernah** dipercaya dari data yang dikirim browser saat
  signup — trigger di server selalu membuat akun baru dengan role `karyawan`,
  lalu Super Admin/Admin HR menaikkan role-nya lewat update yang tunduk RLS.
  Ini mencegah siapa pun membuat akun dengan role tinggi lewat cara di luar
  aplikasi (mis. memanggil API Supabase langsung).
- Admin HR **tidak bisa** menaikkan role siapa pun (termasuk dirinya sendiri)
  ke Admin HR/Super Admin/Super Admin HR — ditegakkan di RLS, bukan cuma di
  form. Kalaupun menu Data Karyawan diizinkan, Admin HR cuma bisa membuat/edit
  akun ber-role Karyawan.
- Validasi radius GPS saat ini dilakukan di sisi klien untuk kenyamanan UX
  (tetap mengirim absen meski di luar radius, ditandai untuk ditinjau admin).
  Untuk validasi yang tidak bisa dimanipulasi user, pertimbangkan menambahkan
  **Supabase Edge Function** yang memvalidasi jarak sebelum insert.
- Foto disimpan di storage bucket publik `attendance-photos` supaya mudah
  ditampilkan admin; jika perlu lebih privat, ubah bucket jadi private dan
  gunakan signed URL.
