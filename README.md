# Absensi & Database Karyawan

Aplikasi absensi karyawan berbasis web (vanilla JS + Supabase). Absensi memakai
verifikasi **GPS lokasi** + **foto selfie** saat check-in/check-out. Ada 3 role:
**Admin**, **HR/Manager**, dan **Karyawan**.

## Fitur

- **Karyawan**: check-in/check-out dengan foto + validasi lokasi GPS terhadap
  radius kantor, ajukan izin/sakit/cuti, lihat riwayat & rekap kehadiran sendiri.
- **HR/Manager**: monitor absensi semua karyawan (termasuk foto & lokasi),
  approve/reject pengajuan izin, lihat laporan bulanan.
- **Admin**: semua fitur HR + kelola data karyawan (tambah/edit akun, atur role).

## Struktur Proyek

```
index.html               Halaman login & daftar
app.html                 Shell aplikasi (sidebar + router modul)
css/style.css             Semua styling
js/supabaseClient.js      Koneksi Supabase (isi URL & anon key di sini)
js/auth.js                 Login, logout, proteksi halaman per role
js/core.js                  Util bersama: sidebar, GPS, kamera, upload foto, format
js/modules/
  employee-absensi.js      Check-in/out (GPS + kamera)
  employee-izin.js          Form & riwayat pengajuan izin
  employee-riwayat.js       Riwayat & rekap absensi pribadi
  admin-karyawan.js         CRUD data karyawan (admin only)
  admin-absensi.js          Monitor absensi semua karyawan (admin & HR)
  admin-izin.js             Approval izin (admin & HR)
  admin-laporan.js          Laporan bulanan + export CSV (admin & HR)
supabase-schema.sql        Semua tabel, RLS policy, trigger, storage bucket
```

## Setup

### 1. Buat project Supabase
Buka [supabase.com](https://supabase.com) → New Project.

### 2. Jalankan schema
Buka **SQL Editor** di dashboard Supabase → paste isi `supabase-schema.sql` →
**Run**. Ini akan membuat semua tabel, trigger, RLS policy, dan storage bucket
`attendance-photos`.

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

### 5. Buat akun admin pertama
1. Buka `index.html` di browser → tab **Daftar Karyawan Baru** → daftar dengan
   email kamu sendiri (default role: karyawan).
2. Di Supabase SQL Editor jalankan:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'emailkamu@contoh.com');
   ```
3. Login lagi di `index.html` — sekarang kamu masuk sebagai Admin dan bisa
   menambah karyawan lain lewat menu **Data Karyawan**.

### 6. Jalankan secara lokal
Karena pakai ES Modules, buka lewat local server (bukan `file://`), misalnya:

```bash
npx serve .
# atau
python3 -m http.server 8080
```

### 7. Deploy
Bisa langsung deploy folder ini ke **GitHub Pages**, **Netlify**, atau
**Vercel** — murni file statis, tidak butuh backend server sendiri (backend =
Supabase).

## Catatan Keamanan

- Semua akses data diatur lewat **Row Level Security (RLS)** di Supabase —
  karyawan hanya bisa melihat/mengubah data miliknya sendiri; admin & HR bisa
  melihat semua data.
- Validasi radius GPS saat ini dilakukan di sisi klien untuk kenyamanan UX
  (tetap mengirim absen meski di luar radius, ditandai untuk ditinjau admin).
  Untuk validasi yang tidak bisa dimanipulasi user, pertimbangkan menambahkan
  **Supabase Edge Function** yang memvalidasi jarak sebelum insert.
- Foto disimpan di storage bucket publik `attendance-photos` supaya mudah
  ditampilkan admin; jika perlu lebih privat, ubah bucket jadi private dan
  gunakan signed URL.
