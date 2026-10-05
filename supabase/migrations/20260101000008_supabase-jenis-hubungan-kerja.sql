-- =====================================================================
-- JENIS HUBUNGAN KERJA (Karyawan Tetap / PKWT / Outsourcing)
-- =====================================================================
-- Tujuan: membedakan karyawan yang berstatus pegawai PT sendiri (tetap
-- atau PKWT) dengan karyawan yang disediakan oleh PT pihak ketiga
-- (outsourcing). Field ini TERPISAH dari `status_karyawan` (bulanan/harian,
-- yang mengatur pola gaji) -- dua hal berbeda yang bisa dikombinasikan
-- bebas, dan juga terpisah dari `unit_pt` (nama badan hukum tempat orang
-- itu resmi terdaftar: untuk karyawan tetap/PKWT isi PT sendiri, untuk
-- outsourcing isi PT vendor-nya).
--
-- Aman dijalankan berulang kali (idempotent), sama seperti file
-- supabase-*.sql lain di project ini. Jalankan sekali di SQL Editor
-- Supabase setelah supabase-schema.sql.
-- =====================================================================

alter table public.profiles
  add column if not exists jenis_hubungan_kerja text not null default 'karyawan_tetap';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_jenis_hubungan_kerja_check'
  ) then
    alter table public.profiles add constraint profiles_jenis_hubungan_kerja_check
      check (jenis_hubungan_kerja in ('karyawan_tetap', 'pkwt', 'outsourcing'));
  end if;
end $$;

comment on column public.profiles.jenis_hubungan_kerja is
  'karyawan_tetap = pegawai tetap PT sendiri, pkwt = kontrak PT sendiri, '
  'outsourcing = disediakan oleh PT vendor pihak ketiga (isi nama vendor di unit_pt).';

-- Data lama otomatis dianggap 'karyawan_tetap' lewat default kolom di atas --
-- tidak perlu backfill manual. Admin tinggal ubah ke 'outsourcing'/'pkwt'
-- lewat menu Data Karyawan untuk karyawan yang memang berstatus begitu.
