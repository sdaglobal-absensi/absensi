# Changelog

## 1.1.1 — 2026-10-05 (konsistensi tampilan pengajuan)
- Halaman **Pengajuan Izin, Pengajuan Lembur, dan Koreksi Absen** kini memakai pola yang sama dengan Dinas Luar dan Kasbon: judul + tombol **+ Ajukan …** + daftar riwayat; formulir tampil di popup (`js/requestModal.js`). Panel "Informasi" dipindah menjadi catatan singkat di dalam popup.
- Banner "lupa check-out" tetap berfungsi: popup Koreksi Absen terbuka otomatis dengan tanggal & jenis terisi.
- Tombol pengajuan memakai nama halamannya, seperti Kasbon: **+ Ajukan Izin**, **+ Ajukan Lembur**, **+ Ajukan Koreksi Absen**, **+ Ajukan Kasbon**, **+ Ajukan Dinas Luar**. Nama menu dan judul halaman tidak diubah. Teks daftar kosong seragam "Belum ada pengajuan."
- Pesan validasi form di popup berbahasa Indonesia ("Kolom ini wajib diisi.").
- Tes jsdom untuk popup (21 tes total).

## 1.1.0 — 2026-10-05 (hardening & profesionalisasi)

### Keamanan
- **Absensi dinilai server** (`018_absensi_server_side.sql`): jam check-in/out = `now()` server, jarak ke kantor dihitung haversine di server, status telat dihitung dari jadwal + tukar shift + zona waktu kantor; kolom check-in terkunci setelah dibuat, check-out hanya sekali, tanggal hanya hari ini/kemarin. Akurasi GPS disimpan (`check_in_accuracy_m`, `check_out_accuracy_m`).
- **Dependensi di-self-host dengan SRI**: `supabase-js 2.117.2` dan SheetJS `0.20.3` (`@e965/xlsx`, mirror npm 0.20.x yang memperbaiki CVE-2023-30533) di `vendor/`. CDN dihapus.
- **CSP & header keamanan** (`_headers`, `vercel.json`): `script-src 'self'` + Turnstile, `frame-ancestors 'none'`, HSTS, `nosniff`, Permissions-Policy. Semua skrip inline dipindah ke `js/pages/*.js` dan `js/registerSw.js`.
- **CORS Edge Function** tidak lagi `*`: allowlist lewat secret `ALLOWED_ORIGINS`.
- Pesan error di 10 modul + `app.js` kini di-escape sebelum masuk `innerHTML`.

### Kepatuhan
- Persetujuan Kebijakan Privasi (UU PDP): `privacy.html`, `js/privacy.js`, tabel `privacy_consents` (`019`).
- Retensi foto absensi per usaha + Edge Function `retention-cleanup`.

### Operasional
- Pelaporan error browser → `client_errors` (`020`, `js/errorReporter.js`).
- Service worker: cache app-shell network-first, halaman offline, banner "versi baru".
- Migrasi dalam format Supabase CLI (`supabase/migrations/`, dibangun oleh `scripts/build-migrations.sh`).
- ESLint, Vitest (16 tes), GitHub Actions CI, `.gitignore`.

> CSP mengizinkan Midtrans Snap (`app.midtrans.com`, `app.sandbox.midtrans.com`) untuk modul pembayaran paket.
