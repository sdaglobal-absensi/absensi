# Paket perubahan KERJORA

Struktur folder sama dengan repo: timpa file di repo dengan file di paket ini.

## 1. Jalankan SQL di Supabase (urut)
1. `022_bpjs_kepesertaan.sql`  — status BPJS per karyawan (karyawan lama otomatis "Aktif")
2. `023_thr.sql`               — tabel & hak akses THR

Kalau memakai Supabase CLI: `supabase/migrations/` sudah berisi keduanya, dan
`scripts/build-migrations.sh` sudah memuat 022 & 023 di daftar urutannya.

## 2. Timpa file aplikasi lalu deploy
- Absensi & Dashboard : js/modules/admin-absensi.js, js/modules/dashboard.js, css/style.css
- Analitik HR         : js/modules/admin-analitik.js
- BPJS per karyawan   : js/modules/admin-karyawan.js, js/modules/admin-slip-gaji.js
- THR                 : js/thrRules.js, js/modules/admin-thr.js, js/modules/employee-thr.js,
                        js/core.js, js/pages/app.js, js/modules/super-pengaturan.js
- Tes                 : tests/thr.test.js

## 3. Setelah deploy
- Menu "THR" (Payroll & Laporan) hanya terbuka untuk Super Admin HR secara bawaan.
  Role lain bisa diaktifkan di Pengaturan Sistem.
- Menu "Slip THR Saya" terbuka untuk semua role.
- Karyawan lama otomatis berstatus BPJS "Aktif"; isi status karyawan baru di Data Karyawan.
