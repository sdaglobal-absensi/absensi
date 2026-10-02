# Migrasi Multi-Tenant — Tahap 1

File: `001_multi_tenant.sql`

Setelah migrasi ini, satu database Supabase bisa dipakai banyak usaha dengan data yang
terisolasi. **Aplikasimu tetap jalan seperti biasa** sebagai satu perusahaan ("Perusahaan
Utama") sampai kamu sendiri membuka pendaftaran publik.

## 1. Cara menjalankan (±5 menit)

1. Supabase Dashboard → **Database → Backups** → pastikan ada backup terbaru.
2. **SQL Editor** → New query → paste seluruh isi `001_multi_tenant.sql` → **Run**.
3. Hasil yang benar: muncul notice `OK — 38 tabel diisolasi per tenant`
   (angkanya lebih kecil kalau ada file SQL opsional yang belum pernah kamu jalankan, itu normal).
4. Kalau ada error, seluruh migrasi otomatis dibatalkan (satu transaksi) — database kembali seperti semula.

Aman dijalankan ulang.

## 2. Ubah 3 baris JS (WAJIB, bersamaan dengan langkah 1)

Constraint unik berubah jadi per-usaha, jadi tiga `onConflict` harus ikut diubah:

| File | Ganti | Menjadi |
|---|---|---|
| `js/modules/super-pengaturan.js` (±baris 291) | `onConflict: "role,menu_id"` | `onConflict: "tenant_id,role,menu_id"` |
| `js/modules/admin-struktur-organisasi.js` (±baris 697) | `onConflict: "request_type"` | `onConflict: "tenant_id,request_type"` |
| `js/modules/admin-invoice-outsourcing.js` (±baris 275) | `onConflict: "vendor,area,period"` | `onConflict: "tenant_id,vendor,area,period"` |

Selain tiga baris itu, **tidak ada perubahan JS lain** — `tenant_id` terisi otomatis dari akun
yang login, jadi payload insert/update yang sudah ada tidak perlu diubah.

## 3. Setelah migrasi

```sql
-- Ganti nama tenant bawaan dengan nama usahamu
update public.tenants set nama = 'Nama Usaha Kamu' where kode = 'utama';

-- Jadikan akunmu "platform admin" (pemilik aplikasi; bisa melihat daftar semua usaha)
insert into public.platform_admins (user_id)
select id from auth.users where email = 'emailkamu@contoh.com';
```

Platform admin **tidak otomatis bisa membaca data karyawan/gaji** usaha lain — hanya daftar tenant.

## 4. Apa yang berubah dari sisi keamanan

- Semua 38 tabel data punya `tenant_id` + policy RLS `tenant_isolation` (restrictive, di-AND
  dengan policy lama — aturan role yang sudah ada tidak berubah).
- Tabel yang dulu terbuka untuk siapa saja (`using (true)`: lokasi, level, libur, dst) sekarang
  hanya terbaca oleh pengguna tenant itu, dan tertutup untuk anonim.
- `super_admin` sekarang = **pemilik usaha di tenant-nya saja**.
- Fungsi `decide_approval`, `cancel_leave_request`, `set_member_role`, `set_primary_unit`,
  rantai approver (termasuk fallback) semuanya dibatasi per tenant.
- `tenant_id` hanya dipercaya dari `raw_app_meta_data` (hanya service role yang bisa menulis),
  **tidak pernah** dari `signUp` metadata yang bisa dipalsukan siapa pun.
- Tenant bisa di-**suspend** (`update tenants set status='suspended'`) → semua penggunanya
  langsung tidak melihat data apa pun.
- Batas karyawan per tenant: kolom `tenants.max_karyawan` (kosong = tanpa batas).

## 5. JANGAN dulu (sampai Tahap 2–3 selesai)

| Jangan | Karena |
|---|---|
| `update platform_settings set public_mode = true` | Foto absensi masih di bucket **publik** (Tahap 3). Alur pembuatan akun karyawan masih lewat `signUp` dari browser admin, yang akan menempatkan akun ke tenant bawaan (Tahap 2: Edge Function). |
| Membuat tenant kedua yang dipakai sungguhan | Edge Function `checkout-reminder` masih membaca `push_settings` satu baris dan belum loop per tenant (Tahap 3). |
| Menjalankan ulang `supabase-schema.sql` / file SQL lama | Akan menimpa fungsi yang sudah sadar-tenant dengan versi lama. |

Membuat tenant uji lewat SQL Editor (aman untuk coba-coba):

```sql
-- 1) Buat user di Authentication > Users (Auto Confirm), lalu:
select public.create_tenant_for_owner(
  'Toko Uji', 'tokouji',
  (select id from auth.users where email = 'owner-uji@contoh.com'),
  'Pemilik Uji'
);
```

## 6. Yang sudah diuji

Migrasi dijalankan di PostgreSQL 16 terhadap schema aslimu (15 file SQL) berisi data contoh:
57 tes isolasi dua-tenant + 11 tes alur aplikasi lama, semuanya lolos —
termasuk: tenant A tak bisa baca/ubah/approve data tenant B (dan sebaliknya), anonim tak bisa baca
apa pun, karyawan tak bisa menaikkan role sendiri, signUp dengan metadata palsu tidak membuat
profil di mode publik, migrasi idempotent, dan jalan di schema minimal (tanpa file opsional).

Catatan jujur: pengujian memakai tiruan Supabase (bukan Supabase asli), dan **tidak** mencakup
Storage serta Edge Function. Setelah dijalankan di Supabase-mu, cek cepat: login sebagai
Super Admin, buka beberapa menu, lalu login sebagai karyawan dan coba absen.

## Tahap berikutnya

2. **Edge Function pembuat akun** + undang karyawan (karyawan tanpa email: kode usaha + kode karyawan + PIN) + halaman daftar usaha.
3. **Storage privat** per tenant (signed URL), `checkout-reminder` per tenant, backup/ekspor, audit log.
4. **Paket & fitur** (feature flag per tenant), template ringkas UMKM (2 role), modul opsional (Master PT/invoice).
5. **Billing** (Midtrans/Xendit) + halaman admin platform.
