# Deploy & Operasional

## 1. Database
```bash
./scripts/build-migrations.sh      # susun supabase/migrations/
supabase db reset                  # UJI dari database kosong (lokal) — lakukan sebelum produksi
supabase db push                   # terapkan ke project yang sudah di-link
```
Untuk **database produksi yang sudah berjalan**, jangan `db push` seluruhnya. Jalankan hanya migrasi baru
di SQL Editor: `018_absensi_server_side.sql`, `019_privasi_retensi.sql`, `020_client_errors.sql`.
Setelah `018`, ujilah manual (lihat komentar di akhir file) dengan akun karyawan biasa.

## 2. Edge Function
```bash
supabase secrets set ALLOWED_ORIGINS=https://app.contoh.com   # WAJIB; tanpa ini hanya localhost yang lolos
supabase secrets set CRON_SECRET=<acak-panjang>               # untuk retention-cleanup
supabase functions deploy account-admin billing login-pin midtrans-webhook checkout-reminder retention-cleanup
```
`login-pin`, `midtrans-webhook`, `retention-cleanup` memakai `--no-verify-jwt` (sudah di `supabase/config.toml`).
Jadwalkan `retention-cleanup` harian (contoh SQL ada di header `index.ts`).

## 3. Hosting statis
- **Netlify / Cloudflare Pages**: file `_headers` otomatis dipakai.
- **Vercel**: `vercel.json`.
- **GitHub Pages**: tidak mendukung header kustom → pindah host, atau CSP lewat `<meta>` (kurang lengkap: tanpa `frame-ancestors`).
- Ganti `https://*.supabase.co` di CSP dengan URL project Anda agar lebih ketat.

## 4. Setelah rilis
1. Naikkan `CACHE_VERSION` di `sw.js` jika perlu memaksa buang cache.
2. Isi placeholder `[...]` di `privacy.html`, minta review hukum, lalu naikkan `PRIVACY_VERSION` di `js/privacy.js` saat isinya berubah material.
3. Atur retensi foto per usaha (contoh SQL di akhir `019`).
4. Pantau `select * from client_errors order by created_at desc limit 50;`.

## 5. Pengembangan
```bash
npm install
npm run check      # lint + tes
npx serve .
```
