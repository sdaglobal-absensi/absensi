# Aplikasi Absensi Karyawan

Aplikasi absensi sederhana bergaya DingTalk: karyawan absen masuk/pulang, admin memantau kehadiran semua karyawan. Data disimpan di **Supabase** (database + autentikasi). Tidak perlu server/build — tinggal dibuka di browser atau di-hosting di mana saja (Netlify, Vercel, GitHub Pages, cPanel, dll), asal struktur foldernya dijaga tetap sama (jangan pindahkan file `.html` keluar dari folder `css/` dan `js/`).

## Struktur folder (modular)

```
absensi-app/
├─ index.html                      ← shell: layout saja, tidak ada logika menu
├─ supabase-schema.sql             ← skema database Supabase
├─ css/
│  └─ style.css                    ← 1 stylesheet dipakai bersama semua modul
└─ js/
   ├─ supabaseClient.js            ← SATU-SATUNYA tempat isi URL & anon key
   ├─ core.js                      ← mesin inti: auth, sidebar, router modul (jangan diedit utk nambah menu)
   ├─ auth.js                      ← logika layar login/daftar
   └─ modules/
      ├─ employee-absensi.js       ← menu "Absen Saya" (karyawan)
      ├─ employee-riwayat.js       ← menu "Riwayat Saya" (karyawan)
      ├─ admin-ringkasan.js        ← menu "Ringkasan Harian" (admin)
      ├─ admin-riwayat.js          ← menu "Riwayat Absensi" (admin)
      └─ admin-karyawan.js         ← menu "Data Karyawan" (admin)
```

**Ide utamanya:** setiap menu di sidebar adalah satu file modul yang berdiri sendiri. Modul "mendaftarkan" dirinya ke aplikasi lewat `App.registerModule({...})`, lengkap dengan judul, ikon, role yang boleh melihatnya, dan fungsi `mount()` untuk merender isinya. Karena setiap modul hanya menyentuh elemen HTML yang ia buat sendiri, **menambah/mengubah satu menu tidak akan merusak menu lain.**

### Cara menambah menu baru (misal "Pengajuan Cuti")

1. Buat file baru, misal `js/modules/employee-cuti.js`, isinya:
   ```js
   App.registerModule({
     id: "cuti",
     label: "Pengajuan Cuti",
     icon: "📝",
     roles: ["karyawan"],      // atau ["admin"], atau ["karyawan","admin"]
     order: 3,
     async mount(container, ctx) {
       // ctx.sb = client Supabase, ctx.util = helper (todayStr, escapeHtml, dll)
       // ctx.user = user login, ctx.profile = profil (nama, role, dst)
       container.innerHTML = `<h1 class="page-title">Pengajuan Cuti</h1> ... `;
     },
     unmount() { /* opsional: bersihkan interval/listener kalau ada */ }
   });
   ```
2. Tambahkan satu baris di `index.html`, di bagian "Modul menu":
   ```html
   <script src="js/modules/employee-cuti.js"></script>
   ```
3. Selesai — menu baru langsung muncul di sidebar untuk role yang sesuai, tanpa mengubah file modul lain.

Kalau butuh tabel baru di database (mis. tabel `leave_requests` untuk cuti), tambahkan lewat SQL Editor Supabase secara terpisah — tidak perlu mengubah `supabase-schema.sql` yang sudah ada, cukup jalankan `create table` baru.

## 1. Buat project Supabase

1. Buka [supabase.com](https://supabase.com) → **New project** (gratis).
2. Setelah project siap, buka **SQL Editor** → **New query**.
3. Salin seluruh isi `supabase-schema.sql`, tempel, lalu klik **Run**.
   Ini akan membuat tabel `profiles`, `attendance`, trigger otomatis, dan aturan keamanan (RLS).
4. Buka **Project Settings → API**, salin:
   - **Project URL**
   - **anon public key**

## 2. Hubungkan aplikasi ke Supabase

Buka `js/supabaseClient.js` — ini satu-satunya file yang perlu diisi:

```js
const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
```

Ganti dengan URL dan anon key milik project Anda, lalu simpan. File-file lain tidak perlu disentuh.

> Secara default, Supabase mengirim email konfirmasi saat ada yang mendaftar. Untuk testing cepat, Anda bisa menonaktifkan ini di **Authentication → Providers → Email → Confirm email → matikan**. Untuk produksi, sebaiknya biarkan aktif.

## 3. Buat akun admin pertama

1. Buka `index.html` di browser → klik **Daftar** → buat akun dengan email admin Anda (misal `admin@perusahaan.com`).
2. Akun baru otomatis berperan **karyawan**. Untuk menjadikannya **admin**, buka **SQL Editor** di Supabase dan jalankan:

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'admin@perusahaan.com');
```

3. Logout, lalu login kembali dengan akun tersebut — Anda akan masuk ke **Dashboard Admin**.

## 4. Menambahkan karyawan

Karyawan cukup membuka halaman yang sama dan klik **Daftar** — akun baru otomatis berperan karyawan. Admin bisa melengkapi kode karyawan (NIK) dan departemen mereka lewat tab **Karyawan** di dashboard admin.

Jika Anda tidak ingin pendaftaran bebas, matikan tombol daftar (hapus/comment bagian `mode-signup` di `index.html`) dan undang karyawan lewat **Authentication → Users → Invite user** di Supabase Dashboard.

## 5. Cara pakai

**Karyawan**
- Login → tekan **Absen Masuk** saat tiba, **Absen Pulang** saat selesai kerja.
- Status otomatis ditandai **terlambat** jika absen masuk setelah jam kerja (default 08:00 — bisa diubah lewat konstanta `JAM_MASUK` di `js/supabaseClient.js`).
- Riwayat absensi 30 hari terakhir tampil di bawah.

**Admin**
- Menu **Ringkasan Harian** — status semua karyawan per tanggal (hadir/terlambat/belum absen).
- Menu **Riwayat Absensi** — filter berdasarkan rentang tanggal dan karyawan tertentu.
- Menu **Data Karyawan** — kelola nama, NIK, departemen, jabatan, no. HP, tanggal bergabung, status aktif, dan role (karyawan/admin) tiap akun. Email asli tiap karyawan diambil lewat fungsi `admin_list_users()` di database (sudah termasuk di `supabase-schema.sql`), jadi tidak perlu setup tambahan.

## 6. Deploy (opsional)

`index.html` bisa langsung di-deploy sebagai situs statis:

- **Netlify / Vercel**: drag-and-drop folder ini ke dashboard mereka.
- **GitHub Pages**: push folder ini ke repo, aktifkan Pages.
- Atau cukup dibuka langsung dari file lokal / dibagikan ke jaringan kantor lewat hosting internal.

Tidak ada proses build — file ini murni HTML + JavaScript yang memanggil Supabase langsung dari browser.

## Catatan keamanan

- Kunci `anon public key` **aman** untuk ditaruh di frontend — akses data tetap dibatasi oleh Row Level Security (RLS) yang sudah diatur di `supabase-schema.sql` (karyawan hanya bisa lihat/isi data miliknya sendiri, admin bisa lihat semua).
- Jangan pernah menaruh **service_role key** di file ini.
