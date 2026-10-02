# Tahap 5 — Billing (Midtrans), Masa Aktif Paket, Trial, Admin Platform

## Yang baru

| Fitur | Di mana |
|---|---|
| **Beli / perpanjang paket** lewat Midtrans Snap (transfer bank, e-wallet, QRIS, kartu). Pemilik usaha memilih paket + bulanan/tahunan di halaman **Paket & Fitur** | `js/modules/super-paket.js`, Edge Function `billing` |
| **Paket aktif otomatis** begitu pembayaran terkonfirmasi (webhook + tombol "Cek status") | Edge Function `midtrans-webhook`, SQL `billing_apply_payment()` |
| **Masa aktif**: paket berbayar punya tanggal berakhir. Habis => fitur otomatis jatuh ke Gratis, **tanpa cron**, data tidak dihapus | SQL `effective_plan()` |
| **Trial** untuk pendaftar baru (lama dan paketnya diatur, bawaan 0 hari = perilaku Tahap 4) | SQL `register_tenant()`, `platform_settings.trial_days` |
| **Banner** untuk Pemilik saat paket / trial tinggal ≤ 7 hari atau baru saja habis | `app.html` |
| **Halaman Admin Platform** (khusus pemilik aplikasi): ringkasan pendapatan, daftar usaha, ubah paket / perpanjang / trial / tangguhkan / fitur tambahan, pesanan, harga paket, pengaturan trial, log | `js/modules/platform-admin.js`, fungsi SQL `pa_*` |
| **Log admin platform** (`platform_audit`): perubahan manual, kedaluwarsa otomatis, dan pembayaran | SQL 005 |

**Tidak berubah:** usaha utama (paket `internal`) tidak pernah kedaluwarsa. Semua usaha lama punya `plan_expires_at` kosong, jadi perilakunya sama persis seperti Tahap 4 sampai kamu atau pembayaran mengisinya.

## File yang diupload

| File | Status | Upload ke |
|---|---|---|
| `005_tahap5_billing.sql` | baru | dijalankan di SQL Editor (tidak perlu di GitHub) |
| `005z_rollback_tahap5.sql` | baru | simpan untuk jaga-jaga |
| `supabase/functions/_shared/midtrans.ts` | baru | Edge Function (deploy lewat Supabase CLI) |
| `supabase/functions/billing/index.ts` | baru | Edge Function |
| `supabase/functions/midtrans-webhook/index.ts` | baru | Edge Function |
| `app.html` | berubah | GitHub Pages |
| `css/style.css` | berubah | GitHub Pages |
| `js/core.js` | berubah | GitHub Pages |
| `js/modules/super-paket.js` | berubah | GitHub Pages |
| `js/modules/platform-admin.js` | baru | GitHub Pages |

`_shared/common.ts` dan semua Edge Function lama **tidak berubah**.

## Urutan pasang (± 30 menit)

1. **Backup** database (Dashboard → Database → Backups).
2. **SQL Editor** → jalankan seluruh `005_tahap5_billing.sql`. Harus muncul notice `OK — Tahap 5 (SQL) terpasang. Usaha utama tetap "internal", 7 fitur aktif.` Aman dijalankan dua kali; kalau ada error, semuanya dibatalkan.
3. **Akun Midtrans** (daftar di midtrans.com, mulai dari **Sandbox**): Settings → Access Keys → salin Server Key dan Client Key.
4. **Secrets + deploy** (dari folder proyek, Supabase CLI):
   ```bash
   supabase secrets set MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxx MIDTRANS_ENV=sandbox
   supabase functions deploy billing --no-verify-jwt
   supabase functions deploy midtrans-webhook --no-verify-jwt
   ```
   (`--no-verify-jwt` wajib, sama seperti `account-admin`: kunci `sb_publishable_...` bukan JWT, dan Midtrans tidak membawa token Supabase. Kedua function memverifikasi sendiri.)
5. **Notification URL** di Dashboard Midtrans → Settings → Configuration → Payment Notification URL:
   `https://cugjzcspygqxlmbqfayc.supabase.co/functions/v1/midtrans-webhook`
6. **Upload file aplikasi** ke GitHub (daftar di atas). Muat ulang browser dengan Ctrl+Shift+R.
7. **Jadikan akunmu admin platform** (kalau belum, dari Tahap 1) lalu pastikan akun itu juga punya profil di usaha utama:
   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'emailkamu@contoh.com'
   on conflict do nothing;
   ```
8. **Atur harga**: menu **Admin Platform → Harga & Trial**, isi harga per bulan (dan per tahun kalau ada) untuk Bisnis dan Enterprise. Harga kosong = paket tidak dijual. *Aku sengaja tidak mengisi angka harga; itu keputusan bisnismu.* Alternatif lewat SQL (ganti dengan angkamu dalam Rupiah):
   ```sql
   update public.plans set harga_bulanan = <angka>, harga_tahunan = <angka> where kode = 'bisnis';
   ```

## Tes (urut)

**A. Usaha utama tidak berubah.** Login Super Admin usaha utama: semua menu lama ada, **Paket & Fitur** menampilkan paket Internal tanpa bagian Langganan, dan menu baru **Admin Platform** muncul di bawah grup Platform.

**B. Beli paket (sandbox).** Pakai usaha uji paket Gratis (`create_tenant_for_owner('Toko Uji', 'tokouji', ...)` seperti README Tahap 4):
1. Login pemilik Toko Uji → **Paket & Fitur** → bagian **Langganan** → pilih Bisnis → konfirmasi.
2. Jendela Midtrans terbuka. Pilih metode apa saja, lalu selesaikan lewat **Simulator** Midtrans (docs.midtrans.com → Sandbox Testing; mis. Virtual Account atau QRIS).
3. Setelah bayar, halaman memuat ulang sendiri: paket **Bisnis**, "Aktif sampai ...", menu lembur / slip gaji muncul. Riwayat tagihan berstatus **Lunas**.
4. Beli lagi paket yang sama: masa aktif **ditambah**, bukan diulang dari hari ini.
5. Cek di **Admin Platform → Pesanan** dan **Log**: pesanan lunas dan catatan "Pembayaran (otomatis)".

**C. Webhook tidak dobel.** Di Dashboard Midtrans, kirim ulang notifikasi pesanan yang sama: masa aktif **tidak** bertambah lagi.

**D. Kedaluwarsa.**
```sql
update public.tenants set plan_expires_at = now() - interval '1 minute' where kode = 'tokouji';
```
Muat ulang halaman pemilik Toko Uji: kembali ke **Gratis**, menu berbayar hilang, banner merah "Masa aktif paket ... sudah habis". Aksi ke tabel berbayar (mis. lembur) langsung ditolak server walau halaman lama masih terbuka. Data lembur / slip lama tetap ada dan terbaca lagi setelah membeli ulang.

**E. Admin Platform.** Coba: ubah paket manual dengan tanggal berakhir, perpanjang 30 hari, mulai trial 14 hari, tangguhkan lalu aktifkan lagi, tambah satu fitur, dan lihat semuanya muncul di **Log**. Usaha utama menolak perubahan paket / status (disengaja).

**F. Trial pendaftar baru** (nanti, setelah `public_mode` dibuka): di **Harga & Trial** isi mis. 14 hari + Bisnis. Pendaftar baru berstatus Trial; setelah habis otomatis Gratis.

## Aturan penting

- **Harga dihitung di server** dari tabel `plans`. Browser hanya mengirim paket + periode. Perubahan harga tidak memengaruhi pesanan yang sudah dibuat.
- **Naik paket** (mis. Bisnis → Enterprise) berlaku langsung dan masa aktif dihitung ulang dari hari ini. **Tidak ada prorata**: sisa hari paket lama tidak dikonversi.
- **Turun paket** lewat pembelian ditolak selagi paket berbayar masih aktif. Turun paket otomatis terjadi saat masa aktif habis.
- **Perpanjang paket yang sama** menambah masa aktif dari tanggal berakhir saat ini.
- Pembayaran yang masuk **selalu diterapkan**, termasuk untuk pesanan yang sudah ditandai kedaluwarsa di sisi kita (uang sudah diterima). Pesanan yang sudah lunas tidak pernah diturunkan statusnya.
- Usaha yang **ditangguhkan** tetap ditangguhkan walau ada pembayaran masuk (keputusan ada di tanganmu).
- Saat paket habis, batas karyawan ikut Gratis (10). Karyawan yang sudah lebih dari itu **tidak dihapus**, tetapi tidak bisa menambah karyawan baru sampai paket naik lagi.
- `my_plan_info()` sekarang ikut menuliskan kedaluwarsa ke baris usaha (supaya halaman Paket & Fitur selalu akurat). Keamanan fitur di server tidak bergantung pada ini: `effective_plan()` menghitung kedaluwarsa langsung.

## Opsional: sapu harian

Tidak wajib. Kalau mau status kedaluwarsa dan pesanan menggantung dirapikan tiap malam (butuh ekstensi **pg_cron** aktif di Dashboard → Database → Extensions):
```sql
select cron.schedule('billing-expire', '10 17 * * *', $$select public.billing_expire_due()$$);  -- 00:10 WIB
```

## Beralih ke produksi

1. Ajukan akun Midtrans produksi, lalu ganti secrets: `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY` (kunci produksi, tanpa awalan `SB-`) dan `MIDTRANS_ENV=production`. Tidak perlu deploy ulang kode.
2. Isi Payment Notification URL di dashboard **produksi** (terpisah dari sandbox).
3. Lakukan satu pembelian kecil sungguhan di usaha uji sebelum membuka ke pelanggan.
4. Sebelum menyalakan `public_mode`, syarat Tahap 3 dan 4 tetap berlaku.

## Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| "Pembayaran belum dikonfigurasi" | Secrets Midtrans belum diisi (`supabase secrets set ...`). |
| "Edge Function "billing" belum di-deploy." | Jalankan `supabase functions deploy billing --no-verify-jwt`. |
| "Harga paket ... belum diatur" | Isi harga di Admin Platform → Harga & Trial. |
| Bagian Langganan menulis "Pembelian paket belum tersedia" | SQL 005 belum dijalankan. |
| Sudah bayar tapi paket belum aktif | Klik **Cek status** di Riwayat tagihan. Kalau tetap belum: cek Notification URL di Midtrans dan log function `midtrans-webhook` (Dashboard → Edge Functions → Logs). Webhook yang gagal dikirim ulang oleh Midtrans. |
| Log webhook: "Signature tidak valid" | Server Key di secrets tidak cocok dengan akun / lingkungan Midtrans (sandbox vs produksi). |
| Log: "nominal tidak cocok" | Pesanan diubah di luar sistem. Pesanan tidak diterapkan; periksa manual di dashboard Midtrans. |
| Menu Admin Platform tidak muncul | Akunmu belum ada di `platform_admins`, atau halaman lama masih ter-cache (Ctrl+Shift+R). |
| Refund | Belum otomatis: refund / chargeback diabaikan oleh webhook. Cabut paket manual lewat Admin Platform → Kelola → Ubah paket. |

### Mundur
Jalankan `005z_rollback_tahap5.sql`, upload kembali `app.html`, `css/style.css`, `js/core.js`, `js/modules/super-paket.js` versi Tahap 4 (hapus `platform-admin.js`), dan hapus function `billing` dan `midtrans-webhook`. Riwayat pesanan, harga, dan masa aktif ikut hilang (arsipkan dulu kalau perlu; perintahnya ada di komentar file rollback). Data usaha tidak disentuh.

## Yang sudah diuji / belum

**Sudah:**
- Sintaks semua JS (`core.js`, `super-paket.js`, `platform-admin.js`, skrip di `app.html`) dan semua TypeScript Edge Function valid.
- Logika murni Midtrans dijalankan di Node: verifikasi `signature_key` (benar diterima; nominal diubah, signature pendek, dan field kurang ditolak), pemetaan status (settlement, capture + accept / challenge, expire, deny, refund), dan penerapan ke database dengan klien tiruan (nominal berbeda tidak diterapkan).

**Belum bisa diuji di sini, itulah gunanya langkah Tes A-F:**
- **SQL 005 belum pernah dijalankan** di PostgreSQL (lingkunganku tidak punya PostgreSQL). Seluruhnya satu transaksi sehingga kalau ada error, database kembali seperti semula; kirim pesan errornya kalau muncul. Bagian yang paling perlu dicermati: `my_plan_info()` (kini volatile) dan `billing_apply_payment()`.
- Edge Function di runtime Supabase / Deno dan panggilan nyata ke Midtrans (Snap, status API, webhook).
- Tampilan di browser dan HP: kartu paket, banner, dan halaman Admin Platform belum dilihat langsung. Semuanya memakai kelas CSS yang sudah ada ditambah beberapa baris di akhir `style.css`.
- Hanya **Midtrans** yang didukung (bukan Xendit). Tidak ada email pengingat, masa tenggang, atau prorata.
