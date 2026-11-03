# Paket perubahan KERJORA

Struktur folder sama dengan repo: timpa file di repo dengan file di paket ini.

## 1. Jalankan SQL di Supabase (urut)
1. `022_bpjs_kepesertaan.sql`   — status BPJS per karyawan (karyawan lama otomatis "Aktif")
2. `023_thr.sql`                — tabel & hak akses THR
3. `024_laporan_aktivitas.sql`  — Laporan Aktivitas Harian (template, penugasan, laporan)

Kalau memakai Supabase CLI: `supabase/migrations/` sudah berisi ketiganya, dan
`scripts/build-migrations.sh` sudah memuatnya di daftar urutan.
(Laporan Harian / kehadiran TIDAK butuh SQL.)

## 2. Timpa file aplikasi lalu deploy
- Absensi & Dashboard   : js/modules/admin-absensi.js, js/modules/dashboard.js, css/style.css
- Analitik HR           : js/modules/admin-analitik.js
- BPJS per karyawan     : js/modules/admin-karyawan.js, js/modules/admin-slip-gaji.js
- THR                   : js/thrRules.js, js/modules/admin-thr.js, js/modules/employee-thr.js
- Laporan Harian (hadir): js/laporanHarian.js, js/dailyAttendanceData.js, js/modules/laporan-harian.js,
                          js/modules/admin-laporan.js
- Laporan Aktivitas     : js/laporanAktivitas.js, js/laporanAktivitasView.js,
                          js/modules/laporan-aktivitas.js, js/modules/laporan-aktivitas-kelola.js
- Pendaftaran menu      : js/core.js, js/pages/app.js, js/modules/super-pengaturan.js
- Tes                   : tests/thr.test.js, tests/laporanHarian.test.js, tests/laporanAktivitas.test.js

## 3. Setelah deploy: Laporan Aktivitas
1. Buka menu "Laporan Aktivitas" (Approval & Monitoring) > tab "Template & Pengguna".
2. "+ Template Baru": pilih bagian-bagian laporan, tulis aktivitas/indikator bawaan (satu baris per item).
3. Klik "Pengguna" pada template untuk memilih karyawan pemakainya (1 karyawan = 1 template).
4. Karyawan mengisi lewat menu "Laporan Harian Saya"; HR memantau di tab "Rekap Harian".
Menu "Laporan Aktivitas" terbuka untuk Super Admin HR & Admin HR; "Laporan Harian Saya" untuk semua role.
(Aktifkan/matikan per role di Pengaturan Sistem.)

## Catatan lain
- Menu "THR" hanya terbuka untuk Super Admin HR secara bawaan; "Slip THR Saya" untuk semua role.
- Karyawan lama otomatis berstatus BPJS "Aktif"; isi status karyawan baru di Data Karyawan.
- Menu "Laporan" punya tab Harian (bawaan) dan Bulanan.
