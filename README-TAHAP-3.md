# Tahap 3 — Storage Foto Privat, Pengingat per Usaha, Audit Log, Ekspor & Backup

## Yang baru

| Fitur | Di mana |
|---|---|
| **Foto privat.** Database menyimpan *path* file (bukan URL). Foto tampil lewat tautan sementara berumur 1 jam. | `003_tahap3_storage_audit.sql`, `js/core.js` |
| Upload hanya ke folder usaha **dan** akun sendiri, hanya `jpg/jpeg/png/webp` | policy `photo_insert_own_tenant` |
| Foto profil dibaca semua anggota usaha yang sama. Foto absensi hanya oleh pemiliknya + yang punya menu **Monitor Absensi** | policy `photo_select_tenant` |
| Foto lama **tidak perlu dipindah** dan tetap terbaca (URL publik lama otomatis dikenali) | `photo_info()`, `photoPathFromValue()` |
| **`checkout-reminder` per usaha**: usaha `suspended` dan usaha yang mematikan pengingat dilewati; zona waktu dicari di lokasi milik usaha itu; query dipaging; karyawan diproses paralel terbatas; anti-dobel | `supabase/functions/checkout-reminder/` |
| **Audit Log**: tabel baru, trigger di tabel penting, halaman baru. Pembuatan akun & reset PIN dicatat oleh `account-admin` (tanpa PIN). Log tidak bisa diubah/dihapus dari aplikasi | `audit_log`, `js/modules/admin-audit-log.js`, `account-admin` |
| **Ekspor & Backup**: halaman baru untuk unduh semua data usaha ke Excel atau JSON (setiap unduhan tercatat di Audit Log) | `js/modules/admin-ekspor-backup.js` |
| Perbaikan: Export Excel absensi dulu **terpotong diam-diam di 1000 baris**. Sekarang dipaging, dan kolom foto berisi tautan 7 hari | `admin-absensi.js` |

Dua menu baru (**Audit Log**, **Ekspor & Backup**) otomatis muncul untuk Super Admin. Role lain harus diberi akses lewat **Pengaturan Sistem** (default: mati).

## Urutan pasang (± 20 menit) — ikuti berurutan

1. **Backup** database (Dashboard → Database → Backups).
2. **SQL Editor** → jalankan seluruh `003_tahap3_storage_audit.sql`. Harus muncul notice `OK — Tahap 3 (SQL) terpasang`. Aman dijalankan dua kali.
   - Bucket `attendance-photos` harus sudah ada (dari tahap sebelumnya). Skrip mencoba mengatur batas 5 MB dan jenis file gambar; kalau SQL Editor tidak diizinkan, muncul notice — atur manual di Dashboard → Storage → `attendance-photos` → Edit.
3. **Deploy dua Edge Function** (`supabase link` sudah dilakukan di Tahap 2):
   ```bash
   supabase functions deploy account-admin --no-verify-jwt
   supabase functions deploy checkout-reminder
   ```
   `checkout-reminder` memakai secret yang sama seperti sebelumnya (VAPID). Cron tidak perlu diubah.
4. **Upload file aplikasi** ke hosting: `app.html`, `css/style.css`, `js/core.js`, `js/modules/` (`employee-absensi.js`, `employee-profil.js`, `admin-absensi.js`, `super-pengaturan.js`, **`admin-audit-log.js`**, **`admin-ekspor-backup.js`**).
5. **Tes dengan bucket MASIH publik** (semua harus lolos sebelum langkah 6):
   - Login Super Admin → buka **Data Karyawan**, **Monitor Absensi**: foto lama (avatar & thumbnail) tampil.
   - Login sebagai karyawan → **Absensi** → check-in dengan foto → muncul di Monitor Absensi. Di database, `attendance.check_in_photo_url` berisi path berawalan `<tenant_id>/…`, bukan `https://…`.
   - **Profil Saya** → ganti foto profil → tampil di sidebar.
   - Menu **Audit Log**: ubah satu data karyawan → muncul catatannya. Buat akun karyawan baru → muncul "Membuat akun karyawan …".
   - Menu **Ekspor & Backup** → unduh Excel → file terbuka, jumlah baris masuk akal.
   - Tes pengingat: `curl -X POST https://<project>.supabase.co/functions/v1/checkout-reminder -H "Authorization: Bearer <anon/publishable key>"` → balasan JSON berisi `tenants_total`, `tenants_processed`, `errors: []`.
6. **Privatkan bucket**: Dashboard → Storage → `attendance-photos` → Edit → matikan **Public bucket** → Save.
7. **Tes ulang**, termasuk:
   - Foto lama dan baru masih tampil di aplikasi.
   - Salin alamat salah satu foto **lama** (`…/object/public/attendance-photos/…`) dan buka di **jendela incognito** → **harus gagal** (400/404).
   - Karyawan biasa tidak melihat foto absensi karyawan lain (kecuali role-nya diberi menu Monitor Absensi).

## Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| Foto tidak tampil setelah bucket diprivatkan | SQL 003 belum dijalankan, atau file `js/core.js` lama masih di-cache browser (muat ulang keras, Ctrl+Shift+R). |
| Upload foto gagal "new row violates row-level security policy" | Browser masih memakai `core.js` lama (path lama tidak diizinkan lagi) → muat ulang halaman. Atau akunnya berstatus `suspended`. |
| Upload gagal "mime type … not supported" | Bucket membatasi jenis file; foto harus jpeg/png/webp. |
| Foto di Excel hilang "-" | Tautan 7 hari hanya dibuat untuk foto yang boleh dibaca role pengunduh. |
| Menu Audit Log / Ekspor tidak muncul untuk Admin HR | Normal: nyalakan di Pengaturan Sistem. |
| `checkout-reminder` → `errors` berisi satu usaha | Usaha itu dilewati, usaha lain tetap jalan. Pesan kesalahan ada di `errors[]` dan log function. |

### Mundur
Jalankan `003z_rollback_tahap3.sql`, nyalakan lagi **Public bucket**, lalu upload kembali JS Tahap 2. Audit log tidak dihapus. Detail ada di komentar file itu.

## Catatan penting

- **Karyawan yang browsernya masih memakai `core.js` lama tidak bisa upload foto** setelah SQL 003 dijalankan sampai halaman dimuat ulang.
- Menu Ekspor **tidak mengunduh foto**, dan **backup database Supabase juga tidak mencakup isi Storage**. Untuk backup foto, unduh dari Dashboard → Storage.
- Ekspor hanya berisi data yang **boleh dibaca role pengunduh** (aturan RLS yang sama dengan aplikasi). Untuk backup lengkap, gunakan akun Super Admin.
- Audit log hanya mencatat aksi **user yang login**. Aksi sistem (membuat usaha baru, migrasi di SQL Editor, service role) tidak dicatat supaya log tidak penuh derau; Edge Function mencatat sendiri lewat `audit_write()`. Check-in/out harian sengaja tidak dicatat (hanya penghapusan absensi).
- Penghapusan baris audit hanya bisa lewat SQL Editor (pemeliharaan manual).
- **Sebelum menyalakan `public_mode`**, masih perlu: (1) aktifkan **CAPTCHA** (Authentication → Attack Protection), (2) uji dua usaha sungguhan (data tidak bocor, foto tidak saling terbaca, pengingat jalan untuk keduanya), (3) periksa email konfirmasi terkirim. `public_mode` baru boleh `true` setelah langkah 1–7 di atas lolos.

## Yang sudah diuji / belum

**Sudah (di lingkungan pengembangan, bukan Supabase asli):**
- SQL di PostgreSQL 16 di atas skema asli proyek (semua file SQL lama + 001 + 002) dengan tiruan `auth` dan `storage`: aman dijalankan dua kali; upload ke folder orang lain / usaha lain / ekstensi palsu / ekstensi ganda / path format lama / path terlalu dalam ditolak; baca foto antar-usaha terisolasi; foto lama (dua format path) tetap terbaca oleh usaha pemiliknya; anonim tidak bisa baca; audit log tidak bisa diubah, dihapus, ditambah, atau di-TRUNCATE dari sesi aplikasi; karyawan biasa dan usaha lain tidak bisa membacanya; tidak ada catatan "sistem" saat usaha baru dibuat; `audit_write` hanya service role; `log_export` menolak yang tak berhak; skrip rollback jalan dan SQL 003 bisa dipasang ulang setelahnya.
- `checkout-reminder` di Deno dengan database tiruan di memori: 8 skenario (usaha suspended/mati dilewati, zona waktu per usaha dengan nama lokasi kembar, isolasi antar-usaha, sebelum/telat check-in & check-out, anti-dobel termasuk eksekusi bersamaan, klaim dilepas bila kirim gagal, langganan 410 dihapus, 2.500 karyawan dan 1.500 sesi terbuka melewati batas 1000 baris). Ketiga Edge Function lolos `deno check`.
- Logika foto di jsdom: 31 tes (pengenalan URL lama, escape XSS pada atribut, batch & cache signed URL, retry saat kedaluwarsa, chunk 100 untuk ekspor, path upload, paging `fetchAllRows`).
- Sintaks seluruh JS dan skrip halaman valid; semua `import` bernama punya `export`-nya.

**Belum bisa diuji di sini — itulah gunanya langkah 5 dan 7:**
- Supabase Storage asli (pembuatan tautan bertanda tangan di balik policy, pengaturan bucket privat).
- Runtime Edge Function yang sebenarnya dan pengiriman push ke perangkat.
- Tampilan di browser dan HP (halaman Audit Log dan Ekspor & Backup memakai kelas CSS yang sudah ada, tapi belum dilihat langsung).
