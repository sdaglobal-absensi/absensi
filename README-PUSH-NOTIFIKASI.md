# Push Notifikasi "Lupa Check-out" — Panduan Deploy

Fitur ini terdiri dari 2 bagian:

- **Bagian A (sudah aktif otomatis, tanpa langkah tambahan):** panel "⚠️ Lupa
  Check-out" di halaman *Monitor Absensi* admin + kartu ringkasan di
  Dashboard admin. Tinggal upload ulang file yang sudah diubah.
- **Bagian B (perlu di-deploy manual, langkah di bawah ini):** notifikasi
  push otomatis ke HP karyawan begitu jam pulangnya lewat tapi belum
  check-out.

Bagian B tidak bisa saya jalankan dari sini karena butuh kredensial project
Supabase Anda (project ref, service role key) dan akses ke Supabase
CLI/Dashboard Anda. Ikuti langkah berikut di komputer Anda:

## 1. Jalankan migrasi database

Buka **Supabase Dashboard → SQL Editor**, jalankan isi file
`supabase-push-notifikasi.sql`. Ini menambahkan:
- tabel `push_subscriptions` (menyimpan "alamat" notifikasi tiap device karyawan)
- kolom `attendance.checkout_reminder_sent_at` (anti-kirim-dobel)

## 2. VAPID keys (kunci untuk mengirim push)

Sudah saya generate-kan sepasang untuk Anda (VAPID = standar identitas
pengirim Web Push, BUKAN kredensial Supabase):

```
VAPID_PUBLIC_KEY  = BJuVJ1JAIxOp2PkrRMKHA7C4Mc8EIfvs8hrnVvVjLZ99q2WIahJGcy6KXzvmr3AhG5UNECmM26TKE4g4MxV74N0
VAPID_PRIVATE_KEY = OAmHXKytL2p7L6QdIH0iSEGU_QDhUrZtedbDaa5PseQ
```

- Public key **sudah ditaruh** di `js/push.js` (memang boleh publik).
- Private key **JANGAN** ditaruh di kode. Simpan hanya sebagai secret Edge
  Function di langkah 3. Kalau mau generate pasangan baru sendiri:
  `npx web-push generate-vapid-keys`.

## 3. Deploy Edge Function

Butuh [Supabase CLI](https://supabase.com/docs/guides/cli) sudah terpasang & login (`supabase login`).

```bash
cd kerjora
supabase link --project-ref <PROJECT_REF_ANDA>

supabase secrets set \
  VAPID_PUBLIC_KEY="BJuVJ1JAIxOp2PkrRMKHA7C4Mc8EIfvs8hrnVvVjLZ99q2WIahJGcy6KXzvmr3AhG5UNECmM26TKE4g4MxV74N0" \
  VAPID_PRIVATE_KEY="OAmHXKytL2p7L6QdIH0iSEGU_QDhUrZtedbDaa5PseQ" \
  VAPID_SUBJECT="mailto:admin@perusahaan-anda.com"

supabase functions deploy checkout-reminder
```

(`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` otomatis tersedia di dalam
Edge Function, tidak perlu di-set manual.)

## 4. Jadwalkan function-nya jalan otomatis tiap 15 menit

Paling mudah lewat **Supabase Dashboard → Edge Functions → checkout-reminder
→ Cron**, set jadwal `*/15 * * * *`.

Alternatif via SQL (`pg_cron` + `pg_net`), jalankan di SQL Editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'checkout-reminder-every-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF_ANDA>.supabase.co/functions/v1/checkout-reminder',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_ANDA>',
      'Content-Type', 'application/json'
    )
  );
  $$
);
```

Ganti `<PROJECT_REF_ANDA>` dan `<SERVICE_ROLE_KEY_ANDA>` sesuai project Anda
(Dashboard → Project Settings → API).

## 5. Upload file aplikasi

Upload semua file yang berubah/baru ke hosting Anda (GitHub Pages):
`app.html`, `manifest.webmanifest`, `sw.js`, `js/push.js`,
`js/modules/employee-absensi.js`, `js/modules/admin-absensi.js`,
`js/modules/dashboard.js`.

**Catatan penting:** Web Push HANYA jalan di **HTTPS** (GitHub Pages sudah
HTTPS, aman) dan browser TIDAK bisa mengirim notifikasi kalau tab/app-nya
benar-benar tertutup di sebagian OS/browser (terutama iOS Safari perlu
"Add to Home Screen" dulu sebelum izin notifikasi bisa diminta — ini
batasan Apple, bukan batasan kode).

## 6. Cara karyawan mengaktifkannya

Tidak otomatis nge-prompt (supaya tidak dianggap spam oleh browser). Di
halaman **Absensi**, karyawan yang belum berlangganan akan melihat kartu
kecil "🔔 Aktifkan Pengingat" — tinggal klik, browser akan minta izin
notifikasi sekali, selesai.

## Cara kerja singkat

1. Karyawan klik "Aktifkan Pengingat" → browser generate *push subscription*
   → disimpan ke tabel `push_subscriptions`.
2. Tiap 15 menit, Edge Function `checkout-reminder` mengecek semua sesi
   absen yang masih terbuka, membandingkan jam sekarang dengan jam pulang
   dari Master Jadwal Kerja karyawan itu.
3. Kalau sudah lewat 15–120 menit dari jam pulang dan belum check-out →
   kirim push notification ke semua device karyawan itu, lalu tandai
   `checkout_reminder_sent_at` supaya tidak dikirim berkali-kali.
4. Klik notifikasinya akan membuka langsung ke halaman Absensi.
