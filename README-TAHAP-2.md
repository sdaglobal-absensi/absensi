# Tahap 2 — Pembuatan Akun via Edge Function, Login PIN, Daftar Usaha

## Yang baru

| Fitur | Di mana |
|---|---|
| Akun karyawan dibuat **di server**, otomatis masuk ke usaha admin yang membuat (tidak lagi `signUp` dari browser) | `supabase/functions/account-admin`, `js/accountApi.js` |
| Karyawan **tanpa email**: login pakai **kode usaha + kode karyawan + PIN 6 digit** | `supabase/functions/login-pin`, tab baru di `index.html` |
| Pesan undangan siap kirim WhatsApp setelah akun dibuat / PIN direset | `admin-karyawan.js` |
| Tombol **Reset PIN** di Edit Karyawan (juga membuka kunci akun) | `admin-karyawan.js` |
| Import Excel ikut memakai Edge Function | `karyawan-excel.js` |
| Halaman **daftar usaha** (terkunci sampai `public_mode` dinyalakan) | `daftar.html` |
| 3 `onConflict` Tahap 1 (sudah diterapkan di versi ini) | `super-pengaturan.js`, `admin-struktur-organisasi.js`, `admin-invoice-outsourcing.js` |

## Urutan pasang (± 15 menit) — ikuti berurutan

1. **Backup** database (Dashboard → Database → Backups).
2. **SQL Editor** → jalankan seluruh `002_tahap2_akun.sql`. Harus muncul notice `OK — Tahap 2 (SQL) terpasang`.
3. **Deploy Edge Function** (butuh Supabase CLI, `supabase login` dan `supabase link` dulu):
   ```bash
   supabase secrets set PIN_PEPPER=$(openssl rand -hex 32)
   supabase functions deploy account-admin --no-verify-jwt
   supabase functions deploy login-pin --no-verify-jwt
   ```
   - `--no-verify-jwt` **wajib**: kunci `sb_publishable_...` bukan JWT sehingga ditolak pengecekan bawaan. Kedua function memverifikasi sendiri di dalam kode.
   - **Catat/simpan `PIN_PEPPER`. Jangan diganti setelah ada akun PIN** — semua PIN akan berhenti berlaku.
4. **Upload file aplikasi** ke hosting: `index.html`, `daftar.html`, `css/style.css`, `js/accountApi.js`, `js/auth.js`, `js/supabaseClient.js`, dan `js/modules/` (`admin-karyawan.js`, `karyawan-excel.js`, `super-pengaturan.js`, `admin-struktur-organisasi.js`, `admin-invoice-outsourcing.js`).
5. **Tes** (semua harus lolos sebelum langkah 6):
   - Login Super Admin → Data Karyawan → **Tambah Karyawan** dengan email → muncul jendela pesan undangan. Login sebagai karyawan itu.
   - Tambah karyawan dengan **Cara Login = Tanpa email** → catat kode usaha, kode karyawan, PIN. Buka tab **Karyawan (tanpa email)** di halaman login (jendela incognito) → masuk → coba absen.
   - Salah PIN 5× → akun terkunci 15 menit. Di Edit Karyawan klik **Reset PIN** → PIN baru, kunci terbuka.
   - Import Excel 1–2 baris → berhasil.
6. **Terakhir**: jalankan `002b_tutup_signup_lama.sql`. Ini menutup celah lama: sebelum ini siapa pun yang tahu anon key (publik) bisa `signUp` sendiri dan langsung jadi karyawan di perusahaan utama.

## Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| `Edge Function "account-admin" belum di-deploy` | Langkah 3 belum dijalankan / salah project (`supabase link`). |
| `Server belum dikonfigurasi (PIN_PEPPER)` | `supabase secrets set PIN_PEPPER=...` lalu deploy ulang kedua function. |
| Membuat akun PIN gagal dengan pesan soal email | Supabase menolak domain `.invalid`. Set secret `PIN_EMAIL_DOMAIN` ke domain yang kamu miliki, mis. `supabase secrets set PIN_EMAIL_DOMAIN=pin.domainmu.com`, lalu deploy ulang. |
| `Profil karyawan tidak terbentuk` | `001_multi_tenant.sql` belum dijalankan, atau tenant Anda berstatus `suspended`. |
| 403 "Menu Data Karyawan belum diizinkan" | Role itu belum diberi menu Data Karyawan di Pengaturan Sistem. |

## Keamanan — apa yang dijaga

- Tenant akun baru diambil dari **profil pemanggil di database**, bukan dari isi request.
- Password akun PIN di Supabase Auth bukan PIN mentah, melainkan `HMAC(PIN_PEPPER, user_id:PIN)`. Orang yang menebak langsung ke endpoint Auth tidak bisa melewati batas percobaan `login-pin`.
- 5 salah berturut-turut per akun → kunci 15 menit. Pesan error sama untuk "usaha tidak ada / kode salah / PIN salah" (tidak membocorkan akun mana yang ada).
- Reset PIN hanya untuk akun di usaha yang sama, dan akun Super Admin hanya bisa direset oleh Super Admin.
- `profiles.login_type` tidak bisa diubah lewat API aplikasi.

## Batasan yang perlu diketahui

- Penguncian bersifat **per akun**: seseorang yang tahu kode usaha + kode karyawan bisa sengaja mengunci akun itu 15 menit (admin bisa buka dengan Reset PIN). Itu harga untuk menahan tebak-tebakan PIN 6 digit.
- Akun PIN tidak punya "Lupa password"; pemulihan = admin Reset PIN. Karyawan belum bisa ganti PIN sendiri.
- Import Excel masih mensyaratkan kolom Email (karyawan tanpa email: tambah satu per satu).
- CAPTCHA (Cloudflare Turnstile) sudah terpasang di `daftar.html` dan `index.html`. **Pastikan CAPTCHA juga aktif di Supabase (Authentication → Attack Protection) sebelum `public_mode` dinyalakan** di Tahap 3.
- Aturan Tahap 1 tetap berlaku: jangan nyalakan `public_mode` dan jangan buat tenant kedua untuk dipakai sungguhan sebelum Tahap 3 (storage privat + `checkout-reminder` per tenant).

## Halaman daftar usaha

`daftar.html` memeriksa `public_signup_open()`. Selama `public_mode = false` ia hanya menampilkan "Pendaftaran belum dibuka", dan tautan "Daftarkan usaha" di halaman login disembunyikan. Setelah dibuka: pendaftar mengisi form → (konfirmasi email bila aktif di Supabase) → `register_tenant()` membuat usaha dengan paket `free` (maks. 10 karyawan) → ditampilkan **kode usaha**-nya.

## Belum diuji

Pengujian di sini hanya mencakup: sintaks seluruh JS dan skrip halaman, serta logika turunan password HMAC / validasi PIN / escape pencarian. **SQL, Edge Function, dan alur login belum dijalankan terhadap Supabase asli** (tidak ada Supabase/Deno di lingkungan ini) — karena itu langkah 5 jangan dilewati.

## Tahap 3 (berikutnya)

Storage privat per tenant (signed URL), `checkout-reminder` per tenant, backup/ekspor, audit log — **sudah dikerjakan, lihat `README-TAHAP-3.md`**. Setelah itu `public_mode` boleh dinyalakan (dengan syarat di README Tahap 3).
