-- =====================================================================
-- Izinkan menu "Monitor Absensi" (absensi-monitor) ikut membaca
-- leave_requests, khusus untuk panel baru "Belum Absen [tanggal]" yang
-- perlu menampilkan keterangan Izin/Cuti/Sakit karyawan yang belum absen.
-- Sebelumnya SELECT leave_requests hanya untuk pemilik baris sendiri atau
-- pemegang menu "izin-approval" -- admin yang cuma punya akses Monitor
-- Absensi (tanpa Approval Izin) jadi tidak bisa lihat data ini sama sekali
-- (bukan error, tapi query-nya diam-diam kosong karena RLS).
--
-- Aman dijalankan berkali-kali (idempotent). Jalankan SETELAH
-- supabase-schema.sql (dan supabase-org-approval.sql / supabase-cuti-khusus.sql
-- kalau sudah pernah dijalankan -- keduanya sempat CREATE OR REPLACE ulang
-- policy "leave_select" dengan isi yang sama seperti supabase-schema.sql,
-- jadi urutan menjalankan file ini tidak masalah).
-- =====================================================================

drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select" on public.leave_requests
  for select using (
    user_id = auth.uid()
    or public.has_menu_access('izin-approval')
    or public.has_menu_access('absensi-monitor')
  );
