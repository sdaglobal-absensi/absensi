# Push Notifikasi "Lupa Absen" — Panduan Deploy

Fitur ini terdiri dari 2 bagian:

- **Bagian A (sudah aktif otomatis, tanpa langkah tambahan):** panel "⚠️ Lupa
  Check-out" di halaman *Monitor Absensi* admin + kartu ringkasan di
  Dashboard admin. Tinggal upload ulang file yang sudah diubah.
- **Bagian B (perlu di-deploy manual, langkah di bawah ini):** notifikasi
  push otomatis ke HP karyawan, untuk EMPAT kondisi:
  - **Sebentar lagi jam masuk** — 15 menit sebelum jam masuk, kalau belum ada absen masuk sama sekali hari ini.
  - **Belum check-in** — jam masuk sudah lewat (+15 menit) tapi belum ada absen masuk sama sekali.
  - **Sebentar lagi jam pulang** — 15 menit sebelum jam pulang, kalau sesi absennya masih terbuka (belum check-out).
  - **Belum check-out** — jam pulang sudah lewat (+15 menit) tapi belum absen pulang.
  Pengingat "sebentar lagi" masing-masing cuma dikirim sekali. Pengingat
  "belum check-in/out" berhenti mengingatkan otomatis kalau sudah lewat 2
  jam dari jamnya (dianggap kasus untuk ditindaklanjuti admin, bukan lagi
  pengingat).

Bagian B tidak bisa saya jalankan dari sini karena butuh kredensial project
Supabase Anda (project ref, service role key) dan akses ke Supabase
CLI/Dashboard Anda. Ikuti langkah berikut di komputer Anda:

## 1. Jalankan migrasi database

Buka **Supabase Dashboard → SQL Editor**, jalankan isi file
`supabase-push-notifikasi.sql`. Ini menambahkan:
- tabel `push_subscriptions` (menyimpan "alamat" notifikasi tiap device karyawan)
- kolom `attendance.checkout_reminder_sent_at` (anti-kirim-dobel pengingat *belum* check-out)
- tabel `checkin_reminders_sent` (anti-kirim-dobel pengingat *belum* check-in — perlu tabel terpisah karena belum ada baris attendance sama sekali saat pengingat ini relevan)
- kolom `attendance.checkout_before_reminder_sent_at` (anti-kirim-dobel pengingat *sebelum* jam pulang)
- tabel `checkin_before_reminder_sent` (anti-kirim-dobel pengingat *sebelum* jam masuk)

> Kalau Anda **sudah pernah** menjalankan versi lama file ini, tinggal
> jalankan ulang file yang sekarang — semua statement-nya `if not exists`,
> jadi aman dijalankan ulang dan cuma akan menambahkan yang belum ada
> (dua kondisi "sebelum" di atas).

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
2. Tiap 15 menit, Edge Function `checkout-reminder` melakukan empat pengecekan
   (dua untuk check-in, dua untuk check-out), berdasarkan jam masuk/pulang
   dari Master Jadwal Kerja karyawan itu:
   - **Sebelum jam masuk:** karyawan aktif berjadwal, hari ini hari kerja,
     sisa waktu ke jam masuk ≤ 15 menit, dan belum ada baris absen sama
     sekali hari ini → kirim "Sebentar lagi jam masuk", sekali saja per hari.
   - **Belum check-in:** sama seperti di atas tapi jam masuknya justru
     sudah *lewat* 15–120 menit dan tetap belum ada baris absen.
   - **Sebelum jam pulang:** sesi absen yang masih terbuka (belum
     check-out), sisa waktu ke jam pulang ≤ 15 menit → kirim "Sebentar lagi
     jam pulang", sekali saja per sesi.
   - **Belum check-out:** sesi absen yang masih terbuka, jam pulangnya
     sudah lewat 15–120 menit.
3. Tiap kondisi yang sudah dikirim langsung dicatat (kolom
   `checkout_reminder_sent_at` / `checkout_before_reminder_sent_at` di
   tabel `attendance`, atau baris di `checkin_reminders_sent` /
   `checkin_before_reminder_sent`) supaya tidak dikirim berkali-kali untuk
   kejadian yang sama.
4. Klik notifikasinya akan membuka langsung ke halaman Absensi.

> Catatan: pengingat check-in memakai tanggal kalender hari ini (menurut
> zona kerja karyawan) sebagai acuan, bukan logika penuh "shift lintas
> tengah malam" yang dipakai halaman Absensi. Untuk shift reguler ini sudah
> tepat; untuk kasus sangat telat check-in di shift lintas hari, panel admin
> "Monitor Absensi" tetap jadi jaring pengamannya.
