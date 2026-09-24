-- =====================================================================
-- SISTEM ABSENSI & DATABASE KARYAWAN
-- Schema untuk Supabase (PostgreSQL)
-- =====================================================================
-- Cara pakai: buka Supabase Dashboard > SQL Editor > paste seluruh file
-- ini > Run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. TABEL: profiles (data karyawan, 1:1 dengan auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  employee_code   text unique,
  full_name       text not null,
  role            text not null default 'karyawan' check (role in ('super_admin','super_admin_hr','admin_hr','admin_approval','karyawan')),
  department      text,
  bagian          text,
  position        text,
  grade           text,
  level           text,
  unit_pt         text,
  lokasi_kerja    text,
  status_karyawan text check (status_karyawan in ('bulanan','harian')),
  phone           text,
  alamat          text,
  nik_ktp         text,
  npwp            text,
  photo_url       text,
  join_date       date default current_date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Untuk database yang sudah pernah menjalankan versi schema sebelumnya:
alter table public.profiles add column if not exists bagian text;
alter table public.profiles add column if not exists grade text;
alter table public.profiles add column if not exists level text;
alter table public.profiles add column if not exists unit_pt text;
alter table public.profiles add column if not exists lokasi_kerja text;
alter table public.profiles add column if not exists status_karyawan text;
alter table public.profiles add column if not exists alamat text;
alter table public.profiles add column if not exists nik_ktp text;
alter table public.profiles add column if not exists npwp text;
-- Simpan salinan email di profiles supaya Admin bisa melihatnya langsung dari
-- aplikasi (tanpa perlu buka Supabase Dashboard) — misal saat karyawan lupa
-- email login-nya.
alter table public.profiles add column if not exists email text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_karyawan_check') then
    alter table public.profiles add constraint profiles_status_karyawan_check
      check (status_karyawan in ('bulanan','harian'));
  end if;
end $$;

-- Backfill email untuk akun yang sudah ada sebelum kolom ini ditambahkan
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

-- ---------------------------------------------------------------------
-- 1b. MIGRASI ROLE: admin -> super_admin, hr -> admin_hr
--     (untuk database yang sudah pernah menjalankan versi schema lama
--     dengan role admin/hr/karyawan). Constraint lama dilepas dulu supaya
--     UPDATE di bawah tidak ditolak, baru constraint baru dipasang.
--     Aman dijalankan berkali-kali (idempotent).
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles set role = 'super_admin' where role = 'admin';
update public.profiles set role = 'admin_hr' where role = 'hr';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles add constraint profiles_role_check
      check (role in ('super_admin','super_admin_hr','admin_hr','admin_approval','karyawan'));
  end if;
end $$;

comment on table public.profiles is 'Data profil & role setiap pengguna. role: super_admin | super_admin_hr | admin_hr | admin_approval | karyawan';

-- ---------------------------------------------------------------------
-- 2. TABEL: office_locations (titik kantor untuk validasi radius GPS)
-- ---------------------------------------------------------------------
create table if not exists public.office_locations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  lat             double precision not null,
  lng             double precision not null,
  radius_meters   integer not null default 150,
  -- Zona waktu cabang ini -- dipakai utk hitung telat/tidak, tanggal "hari
  -- ini", dst utk karyawan yg lokasi_kerja-nya cocok dgn nama lokasi ini.
  -- Kode IANA harus salah satu dari TIMEZONE_OPTIONS di js/core.js.
  timezone        text not null default 'Asia/Jakarta'
                    check (timezone in ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Migrasi kolom timezone utk yang sudah pernah menjalankan schema versi
-- lama tanpa kolom ini (aman dijalankan berulang).
alter table public.office_locations add column if not exists timezone text not null default 'Asia/Jakarta';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'office_locations_timezone_check') then
    alter table public.office_locations add constraint office_locations_timezone_check
      check (timezone in ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura'));
  end if;
end $$;
-- Tebakan awal dari nama lokasi yang sudah ada (S6 Balikpapan -> WITA) --
-- SILAKAN DICEK ULANG & disesuaikan manual lewat menu Master Lokasi Kantor,
-- ini cuma migrasi data lama supaya tidak semuanya kepatok WIB begitu saja.
update public.office_locations set timezone = 'Asia/Makassar'
  where timezone = 'Asia/Jakarta' and name ilike '%balikpapan%';
update public.office_locations set timezone = 'Asia/Jayapura'
  where timezone = 'Asia/Jakarta' and (name ilike '%jayapura%' or name ilike '%ambon%');

-- ---------------------------------------------------------------------
-- 3. TABEL: attendance (absensi harian, GPS + foto)
-- ---------------------------------------------------------------------
create table if not exists public.attendance (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  date                date not null default current_date,

  check_in            timestamptz,
  check_in_lat        double precision,
  check_in_lng        double precision,
  check_in_distance_m numeric,
  check_in_photo_url  text,
  check_in_status     text check (check_in_status in ('tepat_waktu','telat')),

  check_out           timestamptz,
  check_out_lat       double precision,
  check_out_lng       double precision,
  check_out_distance_m numeric,
  check_out_photo_url text,

  notes               text,
  created_at          timestamptz not null default now(),

  unique (user_id, date)
);

comment on table public.attendance is 'Satu baris per karyawan per hari. Diisi via check-in lalu dilengkapi check-out.';

-- ---------------------------------------------------------------------
-- 4. TABEL: leave_requests (izin / sakit / cuti)
-- ---------------------------------------------------------------------
create table if not exists public.leave_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  type           text not null check (type in ('izin','sakit','cuti')),
  start_date     date not null,
  end_date       date not null,
  reason         text not null,
  attachment_url text,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by    uuid references public.profiles(id),
  reviewed_at    timestamptz,
  review_notes   text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4b. TABEL: job_levels (Master Level — grade, denda, lembur, perjalanan dinas)
--     Dasar acuan untuk perhitungan gaji nanti. Trigger & RLS-nya
--     didefinisikan di bagian bawah, setelah fungsi helper role dibuat.
-- ---------------------------------------------------------------------
create table if not exists public.job_levels (
  id                       uuid primary key default gen_random_uuid(),
  grade                    text not null,
  level                    text not null,
  denda_terlambat          numeric not null default 0,   -- Rp, denda per keterlambatan & pulang cepat
  upah_lembur_hari_biasa   numeric not null default 0,   -- Rp per jam
  upah_lembur_hari_libur   numeric not null default 0,   -- Rp per jam
  uang_perjalanan_dinas    numeric not null default 0,   -- Rp per perjalanan/hari
  upah_lapor_bpjs                    numeric not null default 0,   -- Rp, upah dasar yang dilaporkan ke BPJS
  bpjs_kesehatan_karyawan_persen     numeric not null default 1,   -- % dari upah lapor, ditanggung karyawan
  bpjs_kesehatan_perusahaan_persen   numeric not null default 4,   -- % dari upah lapor, ditanggung perusahaan
  bpjs_tk_karyawan_persen            numeric not null default 2,   -- % BPJS Ketenagakerjaan ditanggung karyawan
  bpjs_tk_perusahaan_persen          numeric not null default 3.7, -- % BPJS Ketenagakerjaan ditanggung perusahaan
  pph21_persen                       numeric not null default 5,   -- % PPh21
  upah_harian_pokok        numeric not null default 0,   -- Rp/hari, upah awal karyawan harian di grade ini
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (grade, level)
);

-- Untuk database yang sudah pernah menjalankan versi schema sebelumnya
-- (create table if not exists tidak menambah kolom baru ke tabel lama):
alter table public.job_levels add column if not exists upah_lapor_bpjs numeric not null default 0;
alter table public.job_levels add column if not exists bpjs_kesehatan_karyawan_persen numeric not null default 1;
alter table public.job_levels add column if not exists bpjs_kesehatan_perusahaan_persen numeric not null default 4;
alter table public.job_levels add column if not exists bpjs_tk_karyawan_persen numeric not null default 2;
alter table public.job_levels add column if not exists bpjs_tk_perusahaan_persen numeric not null default 3.7;
alter table public.job_levels add column if not exists pph21_persen numeric not null default 5;
alter table public.job_levels add column if not exists upah_harian_pokok numeric not null default 0;

-- Tunjangan Jabatan & Tunjangan Loyalitas ternyata beda-beda per karyawan
-- (bukan per grade/level), jadi kolom di job_levels ini tidak dipakai lagi
-- — datanya sekarang di allowance_types + employee_allowances (Master
-- Tunjangan) di bawah. Baris ini membersihkan kolom lama kalau sempat
-- dibuat di database (aman dijalankan ulang meski kolomnya belum ada).
alter table public.job_levels drop column if exists tunjangan_jabatan;
alter table public.job_levels drop column if exists tunjangan_loyalitas;

-- Kenaikan Upah per Tahun (utk Karyawan Harian) dulu satu nilai per grade
-- di sini, dipakai otomatis oleh menu Kenaikan Upah & Gaji. Sekarang
-- nominalnya diinput manual tiap kali kenaikan diterapkan (sama seperti
-- Karyawan Bulanan, karena bisa beda-beda tiap periode/karyawan), jadi
-- kolom ini tidak dipakai lagi.
alter table public.job_levels drop column if exists kenaikan_upah_tahunan;

-- ---------------------------------------------------------------------
-- 4b2. TABEL: wage_history (Riwayat Upah Harian)
--      Satu baris = satu perubahan upah harian karyawan yang berlaku
--      mulai tanggal tertentu. Payroll nanti mencari baris dengan
--      effective_date terbaru yang <= tanggal yang dihitung.
-- ---------------------------------------------------------------------
create table if not exists public.wage_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  effective_date  date not null,
  daily_wage      numeric not null,
  reason          text not null,  -- "Upah Awal", "Kenaikan Periode 1 2027", "Penyesuaian Manual", dst
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4b3. TABEL: salary_history (Riwayat Gaji Bulanan)
--      Satu baris = satu perubahan gaji bulanan karyawan yang berlaku
--      mulai tanggal tertentu. Berbeda dari upah harian, gaji bulanan
--      & kenaikan tahunannya individual per karyawan (bukan per grade),
--      jadi annual_increase disimpan per-baris supaya bisa disesuaikan
--      tiap kali admin mengubah gaji seseorang.
-- ---------------------------------------------------------------------
create table if not exists public.salary_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  effective_date  date not null,
  monthly_salary  numeric not null,
  annual_increase numeric not null default 0,  -- kenaikan/tahun (Rp) yang berlaku utk karyawan ini
  reason          text not null,  -- "Gaji Awal", "Kenaikan Tahun 2027", "Penyesuaian Manual", dst
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4c. TABEL: departments (Master Departemen — Departemen, Bagian, Jabatan)
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  departemen  text not null,
  bagian      text not null,
  jabatan     text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (departemen, bagian, jabatan)
);

-- ---------------------------------------------------------------------
-- 4d. TABEL: work_schedules & work_schedule_days (Master Jadwal Kerja)
--     Satu "jadwal" bisa punya jam kerja berbeda tiap hari, termasuk
--     shift yang lintas hari (misal 22:00 - 06:00).
-- ---------------------------------------------------------------------
create table if not exists public.work_schedules (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  late_tolerance_minutes  integer not null default 0,   -- toleransi sebelum dianggap telat
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists public.work_schedule_days (
  id                uuid primary key default gen_random_uuid(),
  schedule_id       uuid not null references public.work_schedules(id) on delete cascade,
  day_of_week       smallint not null check (day_of_week between 0 and 6), -- 0=Minggu ... 6=Sabtu
  is_working_day    boolean not null default false,
  start_time        time,
  end_time          time,
  crosses_midnight  boolean not null default false,  -- true kalau end_time < start_time (shift lintas hari)
  unique (schedule_id, day_of_week)
);

-- ---------------------------------------------------------------------
-- 4e. TABEL: holidays (Master Hari Libur — diisi manual oleh admin)
-- ---------------------------------------------------------------------
create table if not exists public.holidays (
  id          uuid primary key default gen_random_uuid(),
  date        date not null unique,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Hubungkan karyawan ke salah satu jadwal kerja
alter table public.profiles add column if not exists schedule_id uuid references public.work_schedules(id);

-- ---------------------------------------------------------------------
-- 4f. TABEL: overtime_requests (Pengajuan Lembur)
-- ---------------------------------------------------------------------
create table if not exists public.overtime_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  date           date not null,
  start_time     time not null,
  end_time       time not null,
  is_hari_libur  boolean not null default false,  -- otomatis: Minggu atau tanggal di Master Hari Libur
  reason         text not null,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by    uuid references public.profiles(id),
  reviewed_at    timestamptz,
  review_notes   text,
  created_at     timestamptz not null default now()
);

-- Kolom total jam lembur (hasil pembulatan otomatis saat pengajuan dikirim)
alter table public.overtime_requests add column if not exists total_jam numeric;

-- ---------------------------------------------------------------------
-- 4g. TABEL: payroll_adjustments (Slip Gaji — komponen manual per periode)
--     Satu baris = penyesuaian manual (dinas, tunjangan lain, potongan
--     lain) untuk satu karyawan pada satu periode "YYYY-MM". Komponen
--     lain di slip gaji (gaji pokok, lembur, denda telat, BPJS, PPh21)
--     dihitung otomatis dari data yang sudah ada (absensi, lembur,
--     riwayat upah/gaji, Master Level) — ini hanya untuk yang tidak
--     tercatat otomatis di sistem.
-- ---------------------------------------------------------------------
create table if not exists public.payroll_adjustments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  period                text not null,  -- format 'YYYY-MM'
  hari_dinas            integer not null default 0,   -- dikali "Uang Perjalanan Dinas" di Master Level
  tunjangan_lain        numeric not null default 0,
  keterangan_tunjangan  text,
  potongan_lain         numeric not null default 0,
  keterangan_potongan   text,
  updated_by            uuid references public.profiles(id),
  updated_at            timestamptz not null default now(),
  unique (user_id, period)
);

-- ---------------------------------------------------------------------
-- 4g-2. TABEL: payroll_periods & payroll_slips (Slip Gaji — kunci/finalisasi)
--     payroll_settings.cutoff_start_day itu satu pengaturan GLOBAL yang bisa
--     diubah kapan saja (mis. 6 bulan lagi). Kalau slip gaji selalu dihitung
--     ulang live dari cutoff yang SEDANG berlaku, maka membuka ulang slip
--     periode lama setelah cutoff berubah bisa menggeser rentang tanggalnya
--     dan mengubah angka yang sudah pernah dicetak/diserahkan ke karyawan.
--     Begitu juga kalau tarif di Master Level / Master Denda / Master
--     Tunjangan diubah setelah slip lama pernah dibuat.
--
--     Solusinya: saat admin "Finalisasi" sebuah periode, hasil hitungan
--     dibekukan (snapshot) ke payroll_slips. Setelah difinalisasi, periode
--     itu TIDAK dihitung ulang otomatis lagi walau cutoff/tarif berubah di
--     kemudian hari — hanya berubah kalau admin sengaja "Buka Kunci" lalu
--     Finalisasi ulang. Periode yang belum difinalisasi tetap dihitung
--     live seperti sebelumnya (mode draft, lihat "Slip Gaji" berjalan).
-- ---------------------------------------------------------------------
create table if not exists public.payroll_periods (
  period             text primary key,  -- format 'YYYY-MM'
  period_start       date not null,     -- rentang tanggal aktual (hasil cut-off) yang DIBEKUKAN saat finalisasi
  period_end         date not null,
  cutoff_start_day   integer not null,  -- snapshot payroll_settings.cutoff_start_day saat difinalisasi (jejak audit)
  finalized_by       uuid references public.profiles(id),
  finalized_at       timestamptz not null default now()
);

comment on table public.payroll_periods is 'Penanda periode gaji yang sudah difinalisasi/dikunci. Ada baris = periode itu final, slip-nya dibekukan di payroll_slips dan tidak dihitung ulang otomatis lagi.';

create table if not exists public.payroll_slips (
  id            uuid primary key default gen_random_uuid(),
  period        text not null references public.payroll_periods(period) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  snapshot      jsonb not null,   -- seluruh rincian slip (pendapatan, potongan, dst.) yang dibekukan saat finalisasi
  gaji_bersih   numeric not null, -- disalin dari snapshot supaya gampang dipakai untuk laporan/rekap tanpa parse JSON
  unique (period, user_id)
);

comment on table public.payroll_slips is 'Snapshot slip gaji per karyawan per periode yang sudah difinalisasi. Sumber kebenaran begitu periode dikunci — bukan dihitung ulang dari absensi/lembur/tarif saat ini.';

-- ---------------------------------------------------------------------
-- 4h. TABEL: late_penalty_rules (Master Denda Terlambat & Pulang Cepat)
--     Dulu tabel jam bertingkat ini "hardcode" di kode Slip Gaji, sekarang
--     jadi setting manual yang bisa diubah admin/HR lewat menu Master Data
--     tanpa perlu ubah kode. Satu baris = satu tingkatan (tier) untuk satu
--     jenis (telat / pulang_cepat) pada satu kelompok hari (weekday =
--     Senin-Jumat, saturday = Sabtu).
--
--     - menit_offset DIHITUNG RELATIF terhadap jam masuk/pulang sesuai
--       JADWAL MASING-MASING KARYAWAN (Master Jadwal Kerja), BUKAN jam
--       dinding tetap (mis. "> 08:00") -- supaya tetap benar untuk
--       karyawan yang shiftnya beda-beda (shift malam, shift sore, dst).
--       Karyawan tanpa jadwal (schedule_id kosong) pakai acuan default
--       08:00-17:00 (sama seperti toleransi telat lama).
--     - jenis = 'telat'        -> menit_offset = berapa menit SETELAH jam
--                                  masuk jadwalnya dianggap telat. Yang
--                                  dipakai saat hitung slip adalah tier
--                                  PALING TERAKHIR yang sudah terlampaui.
--     - jenis = 'pulang_cepat' -> menit_offset = berapa menit SEBELUM jam
--                                  pulang jadwalnya dianggap pulang cepat.
--                                  Yang dipakai adalah tier PERTAMA (paling
--                                  kecil menit_offset-nya) yang masih
--                                  terlampaui.
--     - tipe = 'flat'    -> potongan = nominal (Rp tetap), tidak tergantung
--                            "Denda Terlambat & Pulang Cepat" di Master Level.
--     - tipe = 'percent' -> potongan = persen% x "Denda Terlambat & Pulang
--                            Cepat" (Rp) pada Master Level karyawan ybs.
-- ---------------------------------------------------------------------
create table if not exists public.late_penalty_rules (
  id            uuid primary key default gen_random_uuid(),
  day_type      text not null check (day_type in ('weekday','saturday')),
  jenis         text not null check (jenis in ('telat','pulang_cepat')),
  menit_offset  integer not null check (menit_offset >= 0),
  tipe          text not null check (tipe in ('flat','percent')) default 'percent',
  nominal       numeric not null default 0,  -- dipakai kalau tipe='flat'
  persen        numeric not null default 0,  -- dipakai kalau tipe='percent'
  label         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (day_type, jenis, menit_offset)
);

-- ---------------------------------------------------------------------
-- 4h1. MIGRASI late_penalty_rules: kolom "jam" (jam dinding tetap, mis.
--      "> 08:00") -> "menit_offset" (relatif thd jadwal masing-masing
--      karyawan). Untuk database yang sudah pernah menjalankan versi
--      schema lama dengan kolom "jam". HARUS jalan SEBELUM seed insert di
--      bawah (tabel lama belum punya kolom menit_offset). Nilai lama
--      dikonversi memakai asumsi jam kerja standar yang sama dengan seed
--      di bawah (Senin-Jumat 08:00-17:00, Sabtu 08:00-13:00) -- SILAKAN
--      DICEK ULANG lewat menu Master Denda Telat setelah migrasi,
--      terutama kalau jam kerja standar kantor kamu bukan itu. Aman
--      dijalankan berkali-kali (idempotent).
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'late_penalty_rules' and column_name = 'jam') then
    alter table public.late_penalty_rules drop constraint if exists late_penalty_rules_day_type_jenis_jam_key;
    alter table public.late_penalty_rules add column if not exists menit_offset integer;
    update public.late_penalty_rules set menit_offset = greatest(0, case
      when jenis = 'telat' and day_type = 'weekday'  then (extract(hour from jam)*60 + extract(minute from jam)) - 480
      when jenis = 'telat' and day_type = 'saturday' then (extract(hour from jam)*60 + extract(minute from jam)) - 480
      when jenis = 'pulang_cepat' and day_type = 'weekday'  then 1020 - (extract(hour from jam)*60 + extract(minute from jam))
      when jenis = 'pulang_cepat' and day_type = 'saturday' then 780  - (extract(hour from jam)*60 + extract(minute from jam))
    end::integer)
    where menit_offset is null;
    alter table public.late_penalty_rules alter column menit_offset set not null;
    alter table public.late_penalty_rules add constraint late_penalty_rules_menit_offset_check check (menit_offset >= 0);
    alter table public.late_penalty_rules drop column jam;
    alter table public.late_penalty_rules add constraint late_penalty_rules_day_type_jenis_menit_offset_key unique (day_type, jenis, menit_offset);
  end if;
end $$;

-- Seed nilai default, setara dengan konsep jam-dinding lama (asumsi jam
-- kerja standar Senin-Jumat 08:00-17:00, Sabtu 08:00-13:00) tapi sekarang
-- disimpan relatif supaya otomatis benar untuk jadwal apa pun. Aman
-- dijalankan ulang (on conflict do nothing).
insert into public.late_penalty_rules (day_type, jenis, menit_offset, tipe, nominal, persen, label) values
  ('weekday',  'telat',        0,   'flat',    50000, 0,   'Telat > 0 menit dari jam masuk'),
  ('weekday',  'telat',        120, 'percent', 0,     50,  'Telat > 2 jam dari jam masuk (50% denda)'),
  ('weekday',  'telat',        240, 'percent', 0,     100, 'Telat > 4 jam dari jam masuk (100% denda)'),
  ('saturday', 'telat',        0,   'flat',    50000, 0,   'Telat > 0 menit dari jam masuk'),
  ('saturday', 'telat',        60,  'percent', 0,     50,  'Telat > 1 jam dari jam masuk (50% denda)'),
  ('saturday', 'telat',        120, 'percent', 0,     100, 'Telat > 2 jam dari jam masuk (100% denda)'),
  ('weekday',  'pulang_cepat', 240, 'percent', 0,     100, 'Pulang > 4 jam sebelum jam pulang (100% denda)'),
  ('weekday',  'pulang_cepat', 180, 'percent', 0,     50,  'Pulang 3-4 jam sebelum jam pulang (50% denda)'),
  ('saturday', 'pulang_cepat', 120, 'percent', 0,     100, 'Pulang > 2 jam sebelum jam pulang (100% denda)'),
  ('saturday', 'pulang_cepat', 60,  'percent', 0,     50,  'Pulang 1-2 jam sebelum jam pulang (50% denda)')
on conflict (day_type, jenis, menit_offset) do nothing;

-- ---------------------------------------------------------------------
-- 4i. TABEL: allowance_types & employee_allowances (Master Tunjangan)
--     Tunjangan seperti "Tunjangan Jabatan" atau "Tunjangan Loyalitas"
--     nominalnya beda-beda per karyawan (bukan per grade/level), dan
--     admin bisa membuat jenis tunjangan sendiri secara bebas (tidak
--     terbatas cuma 2 nama itu). allowance_types = daftar jenis
--     tunjangan yang tersedia; employee_allowances = nominal tunjangan
--     tertentu untuk karyawan tertentu (berlaku terus tiap bulan sampai
--     diubah/dinonaktifkan, tidak perlu diisi ulang tiap periode).
-- ---------------------------------------------------------------------
create table if not exists public.allowance_types (
  id          uuid primary key default gen_random_uuid(),
  nama        text not null unique,
  keterangan  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.allowance_types (nama, keterangan) values
  ('Tunjangan Jabatan', 'Tunjangan sesuai jabatan/tanggung jawab karyawan'),
  ('Tunjangan Loyalitas', 'Tunjangan berdasarkan masa kerja/loyalitas karyawan')
on conflict (nama) do nothing;

create table if not exists public.employee_allowances (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  allowance_type_id  uuid not null references public.allowance_types(id) on delete cascade,
  nominal            numeric not null default 0,  -- Rp/bulan
  is_active          boolean not null default true,
  updated_by         uuid references public.profiles(id),
  updated_at         timestamptz not null default now(),
  unique (user_id, allowance_type_id)
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. TRIGGER: auto-create profile saat user baru signup
--    Role SELALU dibuat 'karyawan' di sini, TIDAK PERNAH dipercaya dari
--    signUp metadata (anon key itu publik, siapa pun bisa memanggil
--    auth.signUp langsung dan menitipkan role apapun kalau kita percaya
--    metadata-nya). Super Admin/Super Admin HR/Admin HR menaikkan role
--    lewat UPDATE ke tabel profiles sesudahnya, yang tunduk RLS di bawah.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role, employee_code, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'karyawan',
    new.raw_user_meta_data->>'employee_code',
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 6b. TABEL: role_permissions (menu mana yang boleh dibuka role
--     super_admin_hr, admin_hr, ATAU karyawan -- ketiganya lewat kolom
--     `role`, jadi tiap role punya toggle sendiri yang independen, dan
--     diperlakukan SAMA PERSIS satu sama lain). Diatur lewat menu
--     "Pengaturan Sistem" (dibuka default oleh super_admin -- satu-satunya
--     root -- tapi SEKARANG BISA didelegasikan ke role lain, termasuk ke
--     dirinya sendiri yaitu menu_id 'pengaturan-sistem', lewat baris di
--     tabel ini juga -- lihat has_menu_access()/kebijakan tulis di bawah).
--     Kalau (role, menu_id) tidak ada barisnya di sini, dianggap TIDAK
--     diizinkan (fail-closed / restrictive by default) -- termasuk
--     'pengaturan-sistem' sendiri, jadi delegasi ini murni opt-in. super_admin
--     sendiri TIDAK pernah punya baris di tabel ini -- selalu full akses
--     lewat is_super(), apapun isi tabel ini.
-- ---------------------------------------------------------------------
create table if not exists public.role_permissions (
  role        text not null check (role in ('super_admin_hr', 'admin_hr', 'admin_approval', 'karyawan')),
  menu_id     text not null,
  enabled     boolean not null default false,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now(),
  primary key (role, menu_id)
);

comment on table public.role_permissions is 'Kontrol menu mana yang bisa diakses role super_admin_hr, admin_hr, dan karyawan (satu baris per (role, menu_id)) -- ketiganya diperlakukan sama persis, diatur manual lewat Pengaturan Sistem. super_admin TIDAK pernah dicek ke tabel ini -- satu-satunya role yang selalu full akses & tidak bisa dibatasi lewat toggle apapun (lihat is_super()/has_menu_access()). Halaman "pengaturan-sistem" itu sendiri sekarang ikut jadi salah satu menu_id yang bisa ditoggle di sini (defaultnya mati untuk semua role), supaya bisa didelegasikan sebagai admin cadangan kalau memang mau -- lihat kebijakan role_permissions_write & payroll_settings_write.';

-- Migrasi dari versi lama (role_permissions tanpa kolom `role`, PK di
-- menu_id saja, semua baris implisit untuk admin_hr): aman dijalankan
-- ulang di project yang sudah ada -- kalau kolom `role` belum ada, kolom
-- ditambahkan, baris lama diberi label 'admin_hr', lalu primary key diganti
-- jadi (role, menu_id).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'role_permissions' and column_name = 'role'
  ) then
    alter table public.role_permissions add column role text;
    update public.role_permissions set role = 'admin_hr' where role is null;
    alter table public.role_permissions alter column role set not null;
    alter table public.role_permissions add constraint role_permissions_role_check check (role in ('admin_hr', 'karyawan'));
    alter table public.role_permissions drop constraint if exists role_permissions_pkey;
    alter table public.role_permissions add primary key (role, menu_id);
  end if;
end $$;

-- Kalau project ini sebelumnya sempat pakai versi lain yang memberi
-- super_admin baris sendiri di role_permissions, hapus dulu SEBELUM
-- constraint dikencangkan di bawah -- super_admin TIDAK pernah dicek ke
-- tabel ini (lihat has_menu_access()), jadi baris itu cuma bikin bingung
-- kalau dibiarkan (dan bikin constraint di bawah gagal ditambahkan).
delete from public.role_permissions where role = 'super_admin';

-- Migrasi lanjutan: project yang sudah pernah pakai skema 2-role
-- (admin_hr/karyawan saja) atau skema 4-role punya constraint lama yang
-- beda -- kencangkan/lebarkan supaya persis 3 role ini saja (super_admin_hr,
-- admin_hr, karyawan). super_admin SENGAJA tidak dimasukkan ke constraint
-- ini -- role itu tidak pernah punya baris di tabel ini (selalu full akses
-- lewat is_super(), lihat komentar di atas tabel).
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'role_permissions' and constraint_name = 'role_permissions_role_check'
  ) then
    alter table public.role_permissions drop constraint role_permissions_role_check;
  end if;
  alter table public.role_permissions add constraint role_permissions_role_check
    check (role in ('super_admin_hr', 'admin_hr', 'admin_approval', 'karyawan'));
end $$;

-- Default Admin HR setelah migrasi: yang sudah jadi kerjaan harian HR
-- sebelumnya (monitor, approval, laporan) tetap menyala; data sensitif
-- (karyawan, gaji, master data) dimatikan dulu -- Super Admin bisa
-- nyalakan manual. Menu pribadi (absensi/izin/lembur/riwayat) dinyalakan
-- default karena Admin HR juga karyawan yang perlu absen sendiri.
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_hr', 'karyawan', false),
  ('admin_hr', 'struktur-organisasi', true),
  ('admin_hr', 'absensi-monitor', true),
  ('admin_hr', 'izin-approval', true),
  ('admin_hr', 'lembur-approval', true),
  ('admin_hr', 'kenaikan-upah', false),
  ('admin_hr', 'slip-gaji', false),
  ('admin_hr', 'laporan', true),
  ('admin_hr', 'master-level', false),
  ('admin_hr', 'master-tunjangan', false),
  ('admin_hr', 'master-denda', false),
  ('admin_hr', 'master-departemen', false),
  ('admin_hr', 'master-jadwal', false),
  ('admin_hr', 'master-libur', false),
  ('admin_hr', 'master-lokasi', false),
  ('admin_hr', 'absensi', true),
  ('admin_hr', 'izin', true),
  ('admin_hr', 'lembur', true),
  ('admin_hr', 'riwayat', true),
  ('admin_hr', 'pengaturan-sistem', false)
on conflict (role, menu_id) do nothing;

-- Default Karyawan: 4 menu pribadi menyala (sama seperti perilaku lama),
-- menu staff (Data Karyawan, Approval, Master Data, dst) dimatikan dulu --
-- Super Admin bisa nyalakan manual satu-satu kalau memang mau dibuka untuk
-- Karyawan.
insert into public.role_permissions (role, menu_id, enabled) values
  ('karyawan', 'absensi', true),
  ('karyawan', 'izin', true),
  ('karyawan', 'lembur', true),
  ('karyawan', 'riwayat', true),
  ('karyawan', 'karyawan', false),
  ('karyawan', 'struktur-organisasi', false),
  ('karyawan', 'absensi-monitor', false),
  ('karyawan', 'izin-approval', false),
  ('karyawan', 'lembur-approval', false),
  ('karyawan', 'kenaikan-upah', false),
  ('karyawan', 'slip-gaji', false),
  ('karyawan', 'laporan', false),
  ('karyawan', 'master-level', false),
  ('karyawan', 'master-tunjangan', false),
  ('karyawan', 'master-denda', false),
  ('karyawan', 'master-departemen', false),
  ('karyawan', 'master-jadwal', false),
  ('karyawan', 'master-libur', false),
  ('karyawan', 'master-lokasi', false),
  ('karyawan', 'pengaturan-sistem', false)
on conflict (role, menu_id) do nothing;

-- Default Super Admin HR: SEMUA menu operasional menyala dulu -- Super Admin
-- HR tidak lagi istimewa (beda dari super_admin), jadi diberi default "full
-- akses" yang persis sama seperti perilaku lama, tapi sekarang benar-benar
-- cuma default: bisa dimatikan manual satu-satu lewat Pengaturan Sistem
-- kalau Super Admin memang mau membatasi akun Super Admin HR tertentu.
-- Pengecualian: 'pengaturan-sistem' TETAP dimulai mati (beda dari menu
-- lain di daftar ini) -- ini halaman paling sensitif (kelola akses semua
-- role + periode cut-off gaji global), jadi didelegasikan cuma kalau Super
-- Admin sengaja menyalakannya manual, bukan otomatis lewat default seed ini.
insert into public.role_permissions (role, menu_id, enabled) values
  ('super_admin_hr', 'karyawan', true),
  ('super_admin_hr', 'struktur-organisasi', true),
  ('super_admin_hr', 'absensi-monitor', true),
  ('super_admin_hr', 'izin-approval', true),
  ('super_admin_hr', 'lembur-approval', true),
  ('super_admin_hr', 'kenaikan-upah', true),
  ('super_admin_hr', 'slip-gaji', true),
  ('super_admin_hr', 'laporan', true),
  ('super_admin_hr', 'master-level', true),
  ('super_admin_hr', 'master-tunjangan', true),
  ('super_admin_hr', 'master-denda', true),
  ('super_admin_hr', 'master-departemen', true),
  ('super_admin_hr', 'master-jadwal', true),
  ('super_admin_hr', 'master-libur', true),
  ('super_admin_hr', 'master-lokasi', true),
  ('super_admin_hr', 'absensi', true),
  ('super_admin_hr', 'izin', true),
  ('super_admin_hr', 'lembur', true),
  ('super_admin_hr', 'riwayat', true),
  ('super_admin_hr', 'pengaturan-sistem', false)
on conflict (role, menu_id) do nothing;

-- Default role Admin (admin_approval): menu pribadi + Approval Izin
-- & Approval Lembur menyala; semua menu staff lain mati -- Super Admin bisa
-- menyalakan satu-satu lewat Pengaturan Sistem (mis. Approval Perubahan Data).
-- Role ini SENGAJA tidak masuk is_staff(): akses datanya murni lewat toggle
-- ini, jadi tidak otomatis bisa membaca data gaji/karyawan orang lain.
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_approval', 'profil', true),
  ('admin_approval', 'absensi', true),
  ('admin_approval', 'izin', true),
  ('admin_approval', 'lembur', true),
  ('admin_approval', 'riwayat', true),
  ('admin_approval', 'slip-gaji-saya', true),
  ('admin_approval', 'izin-approval', true),
  ('admin_approval', 'lembur-approval', true),
  ('admin_approval', 'profil-approval', false),
  ('admin_approval', 'karyawan', false),
  ('admin_approval', 'struktur-organisasi', false),
  ('admin_approval', 'struktur-kelola', false),
  ('admin_approval', 'absensi-monitor', false),
  ('admin_approval', 'kenaikan-upah', false),
  ('admin_approval', 'slip-gaji', false),
  ('admin_approval', 'laporan', false),
  ('admin_approval', 'master-level', false),
  ('admin_approval', 'master-tunjangan', false),
  ('admin_approval', 'master-denda', false),
  ('admin_approval', 'master-departemen', false),
  ('admin_approval', 'master-jadwal', false),
  ('admin_approval', 'master-libur', false),
  ('admin_approval', 'master-lokasi', false),
  ('admin_approval', 'pengaturan-sistem', false)
on conflict (role, menu_id) do nothing;

-- ---------------------------------------------------------------------
-- 6c. TABEL: payroll_settings (periode cut-off Slip Gaji, satu baris global)
-- ---------------------------------------------------------------------
create table if not exists public.payroll_settings (
  id                 integer primary key default 1,
  cutoff_start_day   integer not null default 1 check (cutoff_start_day between 1 and 28),
  updated_by         uuid references public.profiles(id),
  updated_at         timestamptz not null default now(),
  constraint payroll_settings_single_row check (id = 1)
);

comment on table public.payroll_settings is 'Pengaturan global periode gajian. cutoff_start_day=1 berarti kalender biasa (tgl 1 - akhir bulan); >1 (mis. 26) berarti periode cut-off tgl itu s/d (tgl itu - 1) bulan berikutnya.';

insert into public.payroll_settings (id, cutoff_start_day) values (1, 1) on conflict (id) do nothing;

alter table public.role_permissions enable row level security;
alter table public.payroll_settings enable row level security;

-- ---------------------------------------------------------------------
-- 7. HELPER FUNCTION: role user yang sedang login
--    (security definer supaya tidak memicu rekursi RLS di profiles)
-- ---------------------------------------------------------------------
create or replace function public.my_role()
returns text language sql security definer stable set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Super Admin = satu-satunya role "root", All Akses mutlak di semua tabel.
-- Ini SENGAJA hardcoded (tidak dicek ke role_permissions sama sekali) --
-- satu-satunya jaminan supaya selalu ada jalan masuk untuk memperbaiki
-- pengaturan kalau ada role lain (termasuk Super Admin HR) yang salah
-- disetel sampai kehilangan akses ke halaman-halaman penting.
create or replace function public.is_super()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select role = 'super_admin' from public.profiles where id = auth.uid()), false);
$$;

-- Role SEBELUM diedit dari sebuah baris profiles, dicek terpisah dari
-- my_role() (yg selalu tentang user yg sedang login) supaya policy
-- profiles_admin_all bisa membandingkan role LAMA vs role BARU yang mau
-- disimpan -- dipakai supaya Admin HR/Super Admin HR boleh menyimpan
-- perubahan field LAIN (nama, no HP, dst) pada baris ber-role Super Admin,
-- selama field role-nya sendiri tidak ikut diubah.
create or replace function public.role_of(p_id uuid)
returns text language sql security definer stable set search_path = public as $$
  select role from public.profiles where id = p_id;
$$;


create or replace function public.is_staff()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select role in ('super_admin','super_admin_hr','admin_hr') from public.profiles where id = auth.uid()), false);
$$;

-- true kalau user sekarang boleh MENGELOLA (tulis) resource yang terkait
-- menu tsb: selalu true untuk super_admin (satu-satunya root, bypass
-- mutlak); untuk super_admin_hr, admin_hr, ATAU karyawan, baru true kalau
-- ada baris (role, menu_id) yang enabled=true di role_permissions untuk
-- role akun yang sedang login -- ketiga role ini diperlakukan generic &
-- sama persis (termasuk Super Admin HR, tidak istimewa lagi).
create or replace function public.has_menu_access(p_menu_id text)
returns boolean language sql security definer stable set search_path = public as $$
  select
    public.is_super()
    or coalesce((
      select enabled from public.role_permissions
      where role = public.my_role() and menu_id = p_menu_id
    ), false);
$$;

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.attendance enable row level security;
alter table public.leave_requests enable row level security;
alter table public.office_locations enable row level security;

-- profiles -------------------------------------------------------------
-- has_menu_access('laporan') & has_menu_access('struktur-organisasi')
-- ditambahkan di sini supaya menu "Laporan" dan "Struktur Organisasi" bisa
-- baca nama/departemen/bagian/lokasi karyawan (dipakai buat rekap & pohon
-- organisasi) walau menu "Data Karyawan" tidak ikut dinyalakan terpisah
-- untuk role yang sama.
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using ( id = auth.uid() or public.is_staff() or public.has_menu_access('laporan') or public.has_menu_access('struktur-organisasi') );

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using ( id = auth.uid() )
  with check ( id = auth.uid() and role = (select role from public.profiles where id = auth.uid()) );

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all
  -- USING: baris mana yg boleh disentuh (dibaca utk update/delete). Semua
  -- baris boleh disentuh oleh siapa pun yg punya akses menu "Data
  -- Karyawan", TERMASUK baris ber-role Super Admin -- supaya Admin HR/
  -- Super Admin HR tetap bisa mengedit field LAIN (nama, no HP, dst) punya
  -- akun Super Admin. Pembatasan supaya role-nya sendiri tidak ikut
  -- berubah ada di WITH CHECK di bawah, bukan di sini.
  using ( public.is_super() or public.has_menu_access('karyawan') )
  with check (
    -- WITH CHECK: nilai role BARU yang boleh disimpan.
    -- - super_admin: bebas (root, all akses).
    -- - super_admin_hr/admin_hr (staff) dgn menu "Data Karyawan": boleh
    --   menyimpan role 'karyawan', 'admin_hr', 'admin_approval', atau 'super_admin_hr' --
    --   TAPI TIDAK PERNAH boleh menaikkan siapa pun (termasuk dirinya) ke
    --   'super_admin'. is_super() di sini SENGAJA tetap hardcoded ke role
    --   super_admin saja supaya kemampuan membuat akun Super Admin baru
    --   selalu ada di satu role yang jelas & tidak pernah bisa mati lewat
    --   toggle menu "Data Karyawan".
    -- - PENGECUALIAN: kalau baris yg diedit SEBELUMNYA sudah 'super_admin'
    --   (role_of(id) = 'super_admin') dan field role yg disimpan TETAP
    --   'super_admin' (tidak diubah), izinkan juga -- ini yang membuat
    --   Admin HR/Super Admin HR bisa menyimpan perubahan field lain punya
    --   akun Super Admin tanpa bisa menurunkan/menaikkan role siapa pun
    --   ke/dari Super Admin.
    -- - karyawan biasa yg kebetulan diberi akses menu ini: tetap cuma
    --   boleh role 'karyawan'.
    public.is_super()
    or (
      public.has_menu_access('karyawan')
      and (
        ( public.my_role() in ('super_admin_hr','admin_hr') and role in ('karyawan','admin_hr','admin_approval','super_admin_hr') )
        or ( role = 'karyawan' )
        or ( role = 'super_admin' and public.role_of(id) = 'super_admin' )
      )
    )
  );

-- role_permissions: staff (super_admin/super_admin_hr/admin_hr) boleh lihat
-- semua baris (perlu untuk halaman Pengaturan Sistem, dan supaya
-- super_admin_hr/admin_hr sendiri bisa tahu menunya sendiri yang mana yang
-- menyala lewat has_menu_access()); karyawan cuma boleh lihat baris
-- role='karyawan' miliknya sendiri (perlu untuk sidebar-nya tahu menu mana
-- yang dinyalakan). Yang MENULIS tabel ini: super_admin (satu-satunya root,
-- selalu bisa apapun isi tabel ini -- jadi tidak pernah ada skenario Super
-- Admin terkunci total dari halaman Pengaturan Sistem), ATAU siapa pun yang
-- sedang punya akses ke menu 'pengaturan-sistem' (lewat has_menu_access() --
-- default TIDAK ada yang punya, murni opt-in kalau Super Admin sengaja
-- menyalakan baris "Pengaturan Sistem" untuk role tsb, biasanya
-- super_admin_hr, di tabel Kelola Akses Menu). payroll_settings pakai
-- kebijakan yang sama persis, karena satu halaman yang sama.
drop policy if exists "role_permissions_select" on public.role_permissions;
create policy "role_permissions_select" on public.role_permissions
  for select using ( public.is_staff() or role = public.my_role() );

drop policy if exists "role_permissions_super_write" on public.role_permissions;
drop policy if exists "role_permissions_write" on public.role_permissions;
create policy "role_permissions_write" on public.role_permissions
  for all
  using ( public.is_super() or public.has_menu_access('pengaturan-sistem') )
  with check ( public.is_super() or public.has_menu_access('pengaturan-sistem') );

-- SELECT dibuka untuk SEMUA user yang login (termasuk karyawan), bukan cuma
-- is_staff() -- cutoff_start_day bukan data sensitif, dan Karyawan WAJIB
-- bisa membacanya juga, karena dipakai untuk menentukan rentang tanggal
-- (start/end) yang menghitung slip gaji miliknya sendiri di menu "Slip
-- Gaji Saya" (lihat admin-slip-gaji.js -> loadData() -> getPayrollCutoffDay()).
-- Kalau dibatasi ke is_staff() saja, query Karyawan ditolak RLS, lalu
-- getPayrollCutoffDay() di js/core.js diam-diam fallback ke cutoffDay=1
-- (kalender biasa) -- bikin tampilan filter DAN rentang tanggal perhitungan
-- slip gaji Karyawan beda (dan salah) dibanding punya staff untuk periode
-- yang sama. Menulis (UPDATE) tetap dibatasi lewat payroll_settings_write
-- di bawah, jadi ini cuma soal baca.
drop policy if exists "payroll_settings_select" on public.payroll_settings;
create policy "payroll_settings_select" on public.payroll_settings
  for select using ( auth.uid() is not null );

drop policy if exists "payroll_settings_super_write" on public.payroll_settings;
drop policy if exists "payroll_settings_write" on public.payroll_settings;
create policy "payroll_settings_write" on public.payroll_settings
  for all
  using ( public.is_super() or public.has_menu_access('pengaturan-sistem') )
  with check ( public.is_super() or public.has_menu_access('pengaturan-sistem') );

-- attendance -------------------------------------------------------------
-- SELECT baris ORANG LAIN (bukan milik sendiri) sekarang lewat
-- has_menu_access('absensi-monitor') -- BUKAN is_staff() lagi. Sebelumnya
-- is_staff() dipakai di sini, yang artinya baca semua data absensi selalu
-- terbuka untuk super_admin_hr/admin_hr TANPA PEDULI toggle "Monitor
-- Absensi"-nya menyala atau tidak, dan sebaliknya TIDAK PERNAH bisa
-- didelegasikan ke Karyawan walau sudah dicentang "Diizinkan" di Kelola
-- Akses Menu (karena is_staff() memang tidak pernah true untuk role
-- karyawan). has_menu_access() memperbaiki keduanya sekaligus -- benar-benar
-- ikut toggle, utk ketiga role (super_admin_hr, admin_hr, karyawan) sama
-- persis, konsisten dengan cara kerja menu-menu lain.
drop policy if exists "attendance_select" on public.attendance;
create policy "attendance_select" on public.attendance
  for select using ( user_id = auth.uid() or public.has_menu_access('absensi-monitor') );

drop policy if exists "attendance_insert_self" on public.attendance;
create policy "attendance_insert_self" on public.attendance
  for insert with check ( user_id = auth.uid() and public.has_menu_access('absensi') );

drop policy if exists "attendance_update_self" on public.attendance;
create policy "attendance_update_self" on public.attendance
  for update using ( user_id = auth.uid() or public.has_menu_access('absensi-monitor') );

-- leave_requests -------------------------------------------------------------
-- Sama seperti attendance di atas -- select baris orang lain sekarang ikut
-- toggle "Approval Izin" (has_menu_access), bukan is_staff() yang hardcoded.
drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select" on public.leave_requests
  for select using ( user_id = auth.uid() or public.has_menu_access('izin-approval') );

drop policy if exists "leave_insert_self" on public.leave_requests;
create policy "leave_insert_self" on public.leave_requests
  for insert with check ( user_id = auth.uid() and public.has_menu_access('izin') );

drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update" on public.leave_requests
  for update using ( user_id = auth.uid() or public.has_menu_access('izin-approval') );

-- overtime_requests (Pengajuan Lembur) -------------------------------------------------------------
alter table public.overtime_requests enable row level security;

-- Sama seperti attendance/leave_requests -- select baris orang lain sekarang
-- ikut toggle "Approval Lembur" (has_menu_access), bukan is_staff().
drop policy if exists "overtime_select" on public.overtime_requests;
create policy "overtime_select" on public.overtime_requests
  for select using ( user_id = auth.uid() or public.has_menu_access('lembur-approval') );

drop policy if exists "overtime_insert_self" on public.overtime_requests;
create policy "overtime_insert_self" on public.overtime_requests
  for insert with check ( user_id = auth.uid() and public.has_menu_access('lembur') );

drop policy if exists "overtime_update" on public.overtime_requests;
create policy "overtime_update" on public.overtime_requests
  for update using ( user_id = auth.uid() or public.has_menu_access('lembur-approval') );

-- payroll_adjustments (Slip Gaji — komponen manual) -------------------------------------------------------------
alter table public.payroll_adjustments enable row level security;

drop policy if exists "payroll_adjustments_select" on public.payroll_adjustments;
create policy "payroll_adjustments_select" on public.payroll_adjustments
  for select using ( user_id = auth.uid() or public.is_staff() );

drop policy if exists "payroll_adjustments_admin_write" on public.payroll_adjustments;
create policy "payroll_adjustments_admin_write" on public.payroll_adjustments
  -- is_staff() ditambahkan supaya Karyawan TIDAK PERNAH bisa menulis baris
  -- ini walau menu "Slip Gaji" sengaja ditoggle untuk role-nya (menu itu
  -- untuknya cuma "lihat & cetak punya sendiri", bukan "kelola tunjangan/
  -- potongan siapa saja").
  for all using ( public.is_staff() and public.has_menu_access('slip-gaji') )
  with check ( public.is_staff() and public.has_menu_access('slip-gaji') );

-- payroll_periods & payroll_slips (Slip Gaji — kunci/finalisasi) -------------------------------------------------
alter table public.payroll_periods enable row level security;
alter table public.payroll_slips enable row level security;

drop policy if exists "payroll_periods_select" on public.payroll_periods;
create policy "payroll_periods_select" on public.payroll_periods
  -- Tabel ini cuma berisi status kunci per periode (tanggal & siapa yang
  -- finalisasi), TIDAK ada angka gaji siapa pun -- jadi aman dibaca semua
  -- orang yang login. Ini penting supaya Karyawan (yang tidak is_staff())
  -- tetap tahu periode gajinya sendiri sudah final atau belum, dan supaya
  -- slip yang ditampilkan ke dia ikut memakai snapshot yang dibekukan
  -- (payroll_slips), bukan hasil hitung ulang yang bisa berubah-ubah.
  for select using ( true );

-- Finalisasi/buka kunci periode gaji HANYA boleh oleh Super Admin -- tidak
-- ikut toggle has_menu_access('slip-gaji') lagi seperti sebelumnya (yang
-- artinya kalau menu itu ditoggle utk Karyawan, dia jadi bisa ikut
-- finalisasi/buka kunci periode siapa saja -- celah ini sekarang ditutup).
drop policy if exists "payroll_periods_admin_write" on public.payroll_periods;
create policy "payroll_periods_admin_write" on public.payroll_periods
  for all using ( public.is_super() ) with check ( public.is_super() );

drop policy if exists "payroll_slips_select" on public.payroll_slips;
create policy "payroll_slips_select" on public.payroll_slips
  for select using ( user_id = auth.uid() or public.is_staff() );

-- Snapshot slip beku hanya ditulis lewat proses finalisasi/buka kunci di
-- atas, jadi ikut dibatasi ke Super Admin saja juga -- staff lain
-- (termasuk Karyawan kalau menu "Slip Gaji"-nya ditoggle) tetap bisa BACA
-- (lihat slip), tapi tidak bisa menulis/menghapus snapshot siapa pun.
drop policy if exists "payroll_slips_admin_write" on public.payroll_slips;
create policy "payroll_slips_admin_write" on public.payroll_slips
  for all using ( public.is_super() ) with check ( public.is_super() );

-- office_locations -------------------------------------------------------------
drop policy if exists "office_select_all" on public.office_locations;
create policy "office_select_all" on public.office_locations
  for select using ( true );

drop policy if exists "office_admin_write" on public.office_locations;
create policy "office_admin_write" on public.office_locations
  for all using ( public.has_menu_access('master-lokasi') ) with check ( public.has_menu_access('master-lokasi') );

-- job_levels (Master Level) -------------------------------------------------------------
drop trigger if exists trg_job_levels_updated_at on public.job_levels;
create trigger trg_job_levels_updated_at
  before update on public.job_levels
  for each row execute function public.set_updated_at();

alter table public.job_levels enable row level security;

drop policy if exists "job_levels_select" on public.job_levels;
create policy "job_levels_select" on public.job_levels
  -- Sebelumnya is_staff() saja -- akibatnya kalau Karyawan (atau siapa pun
  -- yang bukan staff) buka slip gajinya sendiri, tabel ini ikut terkunci
  -- dan BPJS/PPh21/lembur di slipnya salah kehitung Rp 0 (bukan karena
  -- datanya kosong, tapi karena baris Master Level-nya tidak kebaca RLS).
  -- Tabel ini cuma berisi definisi tarif per grade (bukan data personal per
  -- karyawan), jadi aman dibuka untuk semua yang sudah login.
  for select using ( true );

drop policy if exists "job_levels_admin_write" on public.job_levels;
create policy "job_levels_admin_write" on public.job_levels
  for all using ( public.has_menu_access('master-level') ) with check ( public.has_menu_access('master-level') );

-- wage_history (Riwayat Upah Harian) -------------------------------------------------------------
alter table public.wage_history enable row level security;

drop policy if exists "wage_history_select" on public.wage_history;
create policy "wage_history_select" on public.wage_history
  for select using ( user_id = auth.uid() or public.is_staff() );

drop policy if exists "wage_history_admin_write" on public.wage_history;
create policy "wage_history_admin_write" on public.wage_history
  for all using ( public.has_menu_access('kenaikan-upah') ) with check ( public.has_menu_access('kenaikan-upah') );

-- salary_history (Riwayat Gaji Bulanan) -------------------------------------------------------------
alter table public.salary_history enable row level security;

drop policy if exists "salary_history_select" on public.salary_history;
create policy "salary_history_select" on public.salary_history
  for select using ( user_id = auth.uid() or public.is_staff() );

drop policy if exists "salary_history_admin_write" on public.salary_history;
create policy "salary_history_admin_write" on public.salary_history
  for all using ( public.has_menu_access('kenaikan-upah') ) with check ( public.has_menu_access('kenaikan-upah') );

-- departments (Master Departemen) -------------------------------------------------------------
drop trigger if exists trg_departments_updated_at on public.departments;
create trigger trg_departments_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();

alter table public.departments enable row level security;

drop policy if exists "departments_select" on public.departments;
create policy "departments_select" on public.departments
  for select using ( public.is_staff() );

drop policy if exists "departments_admin_write" on public.departments;
create policy "departments_admin_write" on public.departments
  for all using ( public.has_menu_access('master-departemen') ) with check ( public.has_menu_access('master-departemen') );

-- work_schedules & work_schedule_days (Master Jadwal Kerja) -------------------------------------------------------------
drop trigger if exists trg_work_schedules_updated_at on public.work_schedules;
create trigger trg_work_schedules_updated_at
  before update on public.work_schedules
  for each row execute function public.set_updated_at();

alter table public.work_schedules enable row level security;
alter table public.work_schedule_days enable row level security;

drop policy if exists "schedules_select" on public.work_schedules;
create policy "schedules_select" on public.work_schedules for select using ( true );
drop policy if exists "schedules_admin_write" on public.work_schedules;
create policy "schedules_admin_write" on public.work_schedules
  for all using ( public.has_menu_access('master-jadwal') ) with check ( public.has_menu_access('master-jadwal') );

drop policy if exists "schedule_days_select" on public.work_schedule_days;
create policy "schedule_days_select" on public.work_schedule_days for select using ( true );
drop policy if exists "schedule_days_admin_write" on public.work_schedule_days;
create policy "schedule_days_admin_write" on public.work_schedule_days
  for all using ( public.has_menu_access('master-jadwal') ) with check ( public.has_menu_access('master-jadwal') );

-- holidays (Master Hari Libur) -------------------------------------------------------------
alter table public.holidays enable row level security;
drop policy if exists "holidays_select" on public.holidays;
create policy "holidays_select" on public.holidays for select using ( true );
drop policy if exists "holidays_admin_write" on public.holidays;
create policy "holidays_admin_write" on public.holidays
  for all using ( public.has_menu_access('master-libur') ) with check ( public.has_menu_access('master-libur') );

-- late_penalty_rules (Master Denda Terlambat & Pulang Cepat) -------------------------------------------------------------
drop trigger if exists trg_late_penalty_rules_updated_at on public.late_penalty_rules;
create trigger trg_late_penalty_rules_updated_at
  before update on public.late_penalty_rules
  for each row execute function public.set_updated_at();

alter table public.late_penalty_rules enable row level security;

drop policy if exists "late_penalty_rules_select" on public.late_penalty_rules;
create policy "late_penalty_rules_select" on public.late_penalty_rules
  -- Sama seperti job_levels di atas -- tabel tarif denda per jam/tier,
  -- bukan data personal, jadi aman dibuka untuk semua yang login supaya
  -- slip gaji pribadi (menu "Slip Gaji Saya") bisa dihitung dengan benar.
  for select using ( true );

drop policy if exists "late_penalty_rules_admin_write" on public.late_penalty_rules;
create policy "late_penalty_rules_admin_write" on public.late_penalty_rules
  for all using ( public.has_menu_access('master-denda') ) with check ( public.has_menu_access('master-denda') );

-- allowance_types & employee_allowances (Master Tunjangan) -------------------------------------------------------------
drop trigger if exists trg_allowance_types_updated_at on public.allowance_types;
create trigger trg_allowance_types_updated_at
  before update on public.allowance_types
  for each row execute function public.set_updated_at();

drop trigger if exists trg_employee_allowances_updated_at on public.employee_allowances;
create trigger trg_employee_allowances_updated_at
  before update on public.employee_allowances
  for each row execute function public.set_updated_at();

alter table public.allowance_types enable row level security;
alter table public.employee_allowances enable row level security;

drop policy if exists "allowance_types_select" on public.allowance_types;
create policy "allowance_types_select" on public.allowance_types
  -- Sama alasannya seperti job_levels/late_penalty_rules di atas -- ini
  -- cuma daftar NAMA jenis tunjangan (mis. "Tunjangan Jabatan"), bukan
  -- nominal per karyawan (itu di employee_allowances, tetap dibatasi).
  for select using ( true );

drop policy if exists "allowance_types_admin_write" on public.allowance_types;
create policy "allowance_types_admin_write" on public.allowance_types
  for all using ( public.has_menu_access('master-tunjangan') ) with check ( public.has_menu_access('master-tunjangan') );

drop policy if exists "employee_allowances_select" on public.employee_allowances;
create policy "employee_allowances_select" on public.employee_allowances
  for select using ( user_id = auth.uid() or public.is_staff() );

drop policy if exists "employee_allowances_admin_write" on public.employee_allowances;
create policy "employee_allowances_admin_write" on public.employee_allowances
  for all using ( public.has_menu_access('master-tunjangan') ) with check ( public.has_menu_access('master-tunjangan') );




-- ---------------------------------------------------------------------
-- 9. STORAGE BUCKET untuk foto absensi
-- ---------------------------------------------------------------------
-- PENTING: baris "insert into storage.buckets" TIDAK BISA dijalankan lewat
-- SQL Editor -- akan gagal dengan error "42501: must be owner of table
-- buckets", karena tabel storage.buckets dimiliki oleh Supabase sendiri
-- (supabase_storage_admin), bukan role yang dipakai SQL Editor. Bucket-nya
-- HARUS dibuat manual lewat Dashboard, baru lanjut jalankan dua "create
-- policy" di bawah (itu aman dijalankan lewat SQL Editor):
--
--   1. Buka Storage (ikon di sidebar kiri) → tombol "New bucket".
--   2. Name: attendance-photos (harus persis sama, huruf kecil semua).
--   3. Toggle "Public bucket" → ON.
--   4. Create bucket.
--   5. Baru jalankan (lagi) dua statement "create policy" di bawah ini
--      lewat SQL Editor kalau belum sempat jalan waktu error kemarin
--      (statement sebelum baris yang error tadi sudah tersimpan duluan).
--
-- insert into storage.buckets (id, name, public)
-- values ('attendance-photos', 'attendance-photos', true)
-- on conflict (id) do nothing;

drop policy if exists "photo_upload_own" on storage.objects;
create policy "photo_upload_own" on storage.objects
  for insert with check (
    bucket_id = 'attendance-photos' and auth.role() = 'authenticated'
  );

drop policy if exists "photo_read_all" on storage.objects;
create policy "photo_read_all" on storage.objects
  for select using ( bucket_id = 'attendance-photos' );

-- ---------------------------------------------------------------------
-- 10. CONTOH DATA lokasi kantor (edit sesuai lokasi asli)
-- ---------------------------------------------------------------------
-- Bersihkan duplikat lokasi kerja yang mungkin sudah terbentuk dari
-- menjalankan schema ini berkali-kali sebelumnya
delete from public.office_locations a
using public.office_locations b
where a.id > b.id and a.name = b.name;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'office_locations_name_key') then
    alter table public.office_locations add constraint office_locations_name_key unique (name);
  end if;
end $$;

-- (Contoh lokasi "Kantor Pusat" bawaan sudah dihapus — tambahkan lokasi
-- kantor/cabang asli lewat menu Master Lokasi Kantor di panel admin.)

-- ---------------------------------------------------------------------
-- Contoh data jadwal kerja sesuai kondisi saat ini (silakan edit/hapus lewat panel admin)
-- ---------------------------------------------------------------------
do $$
declare
  v_reguler uuid;
  v_malam uuid;
begin
  if not exists (select 1 from public.work_schedules where name = 'Reguler Kantor (Senin-Sabtu)') then
    insert into public.work_schedules (name, late_tolerance_minutes) values ('Reguler Kantor (Senin-Sabtu)', 0)
      returning id into v_reguler;
    insert into public.work_schedule_days (schedule_id, day_of_week, is_working_day, start_time, end_time, crosses_midnight) values
      (v_reguler, 0, false, null, null, false),                    -- Minggu libur
      (v_reguler, 1, true, '08:00', '16:00', false),                -- Senin
      (v_reguler, 2, true, '08:00', '16:00', false),                -- Selasa
      (v_reguler, 3, true, '08:00', '16:00', false),                -- Rabu
      (v_reguler, 4, true, '08:00', '16:00', false),                -- Kamis
      (v_reguler, 5, true, '08:00', '16:00', false),                -- Jumat
      (v_reguler, 6, true, '08:00', '13:00', false);                -- Sabtu
  end if;

  if not exists (select 1 from public.work_schedules where name = 'Shift Malam (22:00-06:00)') then
    insert into public.work_schedules (name, late_tolerance_minutes) values ('Shift Malam (22:00-06:00)', 0)
      returning id into v_malam;
    insert into public.work_schedule_days (schedule_id, day_of_week, is_working_day, start_time, end_time, crosses_midnight) values
      (v_malam, 0, false, null, null, false),
      (v_malam, 1, true, '22:00', '06:00', true),
      (v_malam, 2, true, '22:00', '06:00', true),
      (v_malam, 3, true, '22:00', '06:00', true),
      (v_malam, 4, true, '22:00', '06:00', true),
      (v_malam, 5, true, '22:00', '06:00', true),
      (v_malam, 6, true, '22:00', '06:00', true);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 11. AKUN SUPER ADMIN PERTAMA
-- ---------------------------------------------------------------------
-- Buat user pertama lewat Supabase Dashboard > Authentication > Users >
-- Add user (centang "Auto Confirm User"). Trigger di atas otomatis membuat
-- baris di public.profiles untuknya (role default 'karyawan'). Lalu
-- jalankan baris berikut (ganti email) supaya akun itu jadi Super Admin:
--
-- update public.profiles set role = 'super_admin' where id =
--   (select id from auth.users where email = 'admin@perusahaan.com');
--
-- Role yang tersedia: super_admin, super_admin_hr (keduanya All Akses),
-- admin_hr (akses dibatasi, diatur lewat menu "Pengaturan Sistem" oleh
-- salah satu dari 2 role di atas), karyawan.

-- =====================================================================
-- 12. MENU "PROFIL SAYA" + PENGAJUAN PERUBAHAN DATA
-- =====================================================================
-- Karyawan boleh mengedit LANGSUNG (tanpa approval) field low-risk milik
-- sendiri (no HP, alamat, foto profil) lewat policy "profiles_update_self"
-- yang SUDAH ADA di atas (mengizinkan update semua kolom profiles sendiri
-- kecuali role). Field yang lebih sensitif/berdampak ke payroll & dokumen
-- legal (nama, NIK KTP, NPWP, penempatan) TIDAK diizinkan diedit langsung
-- lewat UI -- karyawan cuma bisa "mengajukan" lewat tabel di bawah, admin
-- yang menyetujui baru datanya benar-benar berubah di profiles.
create table if not exists public.profile_change_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  -- Catatan: daftar field_key di bawah diperluas (alamat_ktp, jenis_kelamin,
  -- tempat_lahir, tanggal_lahir, status_pernikahan) oleh bagian 13 di akhir file ini.
  field_key    text not null check (field_key in (
                 'full_name','nik_ktp','npwp','unit_pt','lokasi_kerja','department','bagian','position'
               )),
  field_label  text not null,
  old_value    text,
  new_value    text not null,
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  review_notes text,
  created_at   timestamptz not null default now()
);

comment on table public.profile_change_requests is
  'Pengajuan koreksi data profil (menu "Profil Saya") untuk field yang tidak boleh diedit langsung oleh karyawan -- baru diterapkan ke tabel profiles setelah disetujui lewat menu "Approval Perubahan Data".';

alter table public.profile_change_requests enable row level security;

drop policy if exists "pcr_select" on public.profile_change_requests;
create policy "pcr_select" on public.profile_change_requests
  for select using ( user_id = auth.uid() or public.has_menu_access('profil-approval') );

drop policy if exists "pcr_insert_self" on public.profile_change_requests;
create policy "pcr_insert_self" on public.profile_change_requests
  for insert with check ( user_id = auth.uid() and public.has_menu_access('profil') );

-- Karyawan boleh membatalkan (hapus) pengajuannya sendiri SELAMA masih
-- berstatus pending -- begitu sudah approved/rejected, baris ini jadi
-- riwayat yang tidak boleh dihapus siapa pun.
drop policy if exists "pcr_delete_self" on public.profile_change_requests;
create policy "pcr_delete_self" on public.profile_change_requests
  for delete using ( user_id = auth.uid() and status = 'pending' );

-- Approve/reject: hanya yang punya akses menu "profil-approval" (atau
-- super_admin, selalu lewat has_menu_access() -> is_super()). Karyawan
-- TIDAK BISA mengubah status pengajuannya sendiri (cuma insert & delete
-- selagi pending, lihat 2 policy di atas).
drop policy if exists "pcr_update_review" on public.profile_change_requests;
create policy "pcr_update_review" on public.profile_change_requests
  for update using ( public.has_menu_access('profil-approval') )
  with check ( public.has_menu_access('profil-approval') );

-- Menu baru: "profil" (personal, semua role, sama seperti absensi/izin/
-- lembur/riwayat) dan "profil-approval" (staff, sama perlakuannya seperti
-- izin-approval/lembur-approval). Default: profil menyala untuk semua
-- role (setiap orang wajar mau bisa lihat & koreksi data sendiri);
-- profil-approval mengikuti pola Admin HR/Super Admin HR yang sudah ada
-- untuk approval lainnya (menyala default), Karyawan tetap mati.
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_hr', 'profil', true),
  ('admin_hr', 'profil-approval', true),
  ('super_admin_hr', 'profil', true),
  ('super_admin_hr', 'profil-approval', true),
  ('karyawan', 'profil', true),
  ('karyawan', 'profil-approval', false)
on conflict (role, menu_id) do nothing;

-- =====================================================================
-- 13. BIODATA LENGKAP KARYAWAN (data pribadi + keluarga)
-- =====================================================================
-- Melengkapi data karyawan dengan: jenis kelamin, agama, tempat & tanggal
-- lahir, pendidikan terakhir, status pernikahan, nama ayah & ibu, data
-- suami/istri, dan daftar anak. Aman dijalankan ulang (idempotent).
--
-- Ada DUA alamat: `alamat_ktp` (sesuai KTP, kolom baru) dan `alamat`
-- (kolom yang SUDAH ADA, sekarang berarti alamat domisili -- data lama
-- tetap utuh dan otomatis jadi alamat domisili).
comment on column public.profiles.alamat is 'Alamat domisili (tempat tinggal saat ini)';

alter table public.profiles add column if not exists alamat_ktp             text;
alter table public.profiles add column if not exists jenis_kelamin          text;
alter table public.profiles add column if not exists agama                  text;
alter table public.profiles add column if not exists tempat_lahir           text;
alter table public.profiles add column if not exists tanggal_lahir          date;
alter table public.profiles add column if not exists pendidikan_terakhir    text;
alter table public.profiles add column if not exists status_pernikahan      text;
alter table public.profiles add column if not exists nama_ayah              text;
alter table public.profiles add column if not exists nama_ibu               text;
alter table public.profiles add column if not exists pasangan_nama          text;
alter table public.profiles add column if not exists pasangan_tempat_lahir  text;
alter table public.profiles add column if not exists pasangan_tanggal_lahir date;
alter table public.profiles add column if not exists pasangan_pekerjaan     text;

comment on column public.profiles.alamat_ktp is 'Alamat sesuai KTP';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_jenis_kelamin_check') then
    alter table public.profiles add constraint profiles_jenis_kelamin_check
      check (jenis_kelamin in ('laki_laki','perempuan'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_agama_check') then
    alter table public.profiles add constraint profiles_agama_check
      check (agama in ('islam','kristen','katolik','hindu','buddha','konghucu'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_pendidikan_terakhir_check') then
    alter table public.profiles add constraint profiles_pendidikan_terakhir_check
      check (pendidikan_terakhir in ('sd','smp','sma_smk','d1','d2','d3','d4','s1','s2','s3'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_pernikahan_check') then
    alter table public.profiles add constraint profiles_status_pernikahan_check
      check (status_pernikahan in ('belum_menikah','menikah','cerai_hidup','cerai_mati'));
  end if;
end $$;

-- Anak (satu baris per anak). `urutan` menentukan anak pertama, kedua, dst.
create table if not exists public.employee_children (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  urutan        smallint not null default 1,
  nama          text not null,
  tempat_lahir  text,
  tanggal_lahir date,
  pekerjaan     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists employee_children_user_idx on public.employee_children(user_id);

drop trigger if exists trg_employee_children_updated_at on public.employee_children;
create trigger trg_employee_children_updated_at
  before update on public.employee_children
  for each row execute function public.set_updated_at();

alter table public.employee_children enable row level security;

-- Baca: pemilik datanya sendiri, atau siapa pun yang punya akses menu
-- "Data Karyawan" (super_admin selalu, lewat has_menu_access -> is_super).
-- Sengaja BUKAN is_staff(): data keluarga sensitif, jadi Admin HR yang menu
-- Data Karyawan-nya belum dinyalakan tidak ikut bisa membacanya.
drop policy if exists "employee_children_select" on public.employee_children;
create policy "employee_children_select" on public.employee_children
  for select using ( user_id = auth.uid() or public.has_menu_access('karyawan') );

-- Tulis oleh karyawan sendiri (lewat menu "Profil Saya").
drop policy if exists "employee_children_write_self" on public.employee_children;
create policy "employee_children_write_self" on public.employee_children
  for all
  using ( user_id = auth.uid() and public.has_menu_access('profil') )
  with check ( user_id = auth.uid() and public.has_menu_access('profil') );

-- Tulis oleh admin (lewat menu "Data Karyawan").
drop policy if exists "employee_children_write_admin" on public.employee_children;
create policy "employee_children_write_admin" on public.employee_children
  for all
  using ( public.has_menu_access('karyawan') )
  with check ( public.has_menu_access('karyawan') );

comment on table public.employee_children is
  'Data anak karyawan (nama, tempat/tanggal lahir, pekerjaan). Urutan anak pertama, kedua, dst. lewat kolom urutan.';

-- Pengajuan perubahan data (Profil Saya): tambah 5 field yang mirip data
-- KTP/berdampak ke pajak -- alamat KTP, jenis kelamin, tempat lahir, tanggal
-- lahir, status pernikahan -- supaya perubahannya
-- ikut lewat approval admin seperti Nama/NIK/NPWP. Constraint lama dicari
-- dan dibuang dulu berdasarkan isinya (bukan cuma namanya), lalu dipasang
-- ulang dengan daftar field terbaru.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profile_change_requests'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%field_key%'
  loop
    execute format('alter table public.profile_change_requests drop constraint %I', c.conname);
  end loop;

  alter table public.profile_change_requests
    add constraint profile_change_requests_field_key_check
    check (field_key in (
      'full_name','nik_ktp','npwp','unit_pt','lokasi_kerja','department','bagian','position',
      'alamat_ktp','jenis_kelamin','tempat_lahir','tanggal_lahir','status_pernikahan'
    ));
end $$;


-- =====================================================================
-- 14. PTKP OTOMATIS + TANGGAL RESIGN
-- =====================================================================
-- Aman dijalankan ulang (idempotent).

-- 14a. Tanggal resign. Kosong = karyawan masih bekerja.
alter table public.profiles add column if not exists resign_date date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_resign_after_join_check') then
    alter table public.profiles add constraint profiles_resign_after_join_check
      check (resign_date is null or join_date is null or resign_date >= join_date);
  end if;
end $$;

comment on column public.profiles.resign_date is 'Tanggal resign / berhenti bekerja. NULL = masih bekerja.';

-- 14b. PTKP otomatis dari status pernikahan + jumlah anak.
--   - status "menikah"                                  -> K/n
--   - status lain (belum menikah, cerai hidup/mati)     -> TK/n
--   - n = jumlah anak, maksimal 3 (batas tanggungan PTKP)
--   - status belum diisi                                -> NULL
-- Yang TIDAK dihitung otomatis: K/I/n (penghasilan istri digabung) dan
-- syarat tanggungan lain (mis. usia/penghasilan anak) -- sengaja tidak
-- ditebak dari data yang ada.
alter table public.profiles add column if not exists ptkp text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_ptkp_check') then
    alter table public.profiles add constraint profiles_ptkp_check
      check (ptkp ~ '^(TK|K)/[0-3]$');
  end if;
end $$;

comment on column public.profiles.ptkp is
  'Kode PTKP (TK/0..TK/3, K/0..K/3). Diisi OTOMATIS oleh trigger dari status_pernikahan + jumlah anak; nilai yang dikirim dari aplikasi selalu ditimpa.';

create or replace function public.hitung_ptkp(p_status text, p_anak integer)
returns text language sql immutable as $$
  select case
    when p_status is null then null
    else (case when p_status = 'menikah' then 'K' else 'TK' end)
         || '/' || least(greatest(coalesce(p_anak, 0), 0), 3)
  end;
$$;

-- Trigger di profiles: (1) hitung ulang ptkp; (2) kosongkan data
-- suami/istri kalau status bukan "menikah". security definer supaya bisa
-- menghitung anak walau si pemanggil tidak punya akses baca employee_children.
create or replace function public.profiles_derive_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status_pernikahan is distinct from 'menikah' then
    new.pasangan_nama := null;
    new.pasangan_tempat_lahir := null;
    new.pasangan_tanggal_lahir := null;
    new.pasangan_pekerjaan := null;
  end if;
  new.ptkp := public.hitung_ptkp(
    new.status_pernikahan,
    (select count(*)::int from public.employee_children where user_id = new.id)
  );
  return new;
end;
$$;

drop trigger if exists trg_profiles_derive_fields on public.profiles;
create trigger trg_profiles_derive_fields
  before insert or update on public.profiles
  for each row execute function public.profiles_derive_fields();

-- Trigger di employee_children: tiap anak ditambah/dihapus/dipindah,
-- PTKP karyawannya dihitung ulang (lewat trigger di atas).
create or replace function public.employee_children_touch_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.profiles set ptkp = ptkp where id = old.user_id;
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.user_id is distinct from old.user_id) then
    update public.profiles set ptkp = ptkp where id = new.user_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_employee_children_ptkp on public.employee_children;
create trigger trg_employee_children_ptkp
  after insert or update or delete on public.employee_children
  for each row execute function public.employee_children_touch_profile();

-- Isi PTKP untuk karyawan yang sudah ada (hanya baris yang memang berubah).
update public.profiles p set ptkp = p.ptkp
where p.ptkp is distinct from public.hitung_ptkp(
  p.status_pernikahan,
  (select count(*)::int from public.employee_children c where c.user_id = p.id)
);


-- =====================================================================
-- BAGIAN: STRUKTUR ORGANISASI BERBASIS UNIT + APPROVAL BERTINGKAT
-- (sama persis dengan file supabase-org-approval.sql -- untuk database
-- yang sudah berjalan cukup jalankan file terpisah itu saja)
-- =====================================================================
-- =====================================================================
-- STRUKTUR ORGANISASI BERBASIS UNIT + APPROVAL BERTINGKAT
-- Aman dijalankan ulang (idempotent). Jalankan SETELAH supabase-schema.sql
-- (atau sudah termasuk di bagian akhir supabase-schema.sql untuk instalasi baru).
--
-- Aturan approval:
--   1. Approver = anggota unit yang role-nya Super Admin / Super Admin HR /
--      Admin HR DAN menu approval terkait (izin-approval / lembur-approval)
--      menyala untuk role itu di Pengaturan Sistem. Role Karyawan tidak
--      pernah jadi approver.
--   2. Pencarian mulai dari UNIT UTAMA pemohon. Kalau unit itu tidak punya
--      approver, naik ke unit induk, dan seterusnya.
--   3. Jumlah tingkat approval per jenis pengajuan diatur di approval_settings.
--   4. Tidak punya unit utama / tidak ada approver di rantai atas -> fallback
--      ke semua Super Admin + staff yang berhak approve (perilaku lama).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: org_units (pohon unit organisasi, kedalaman bebas)
-- ---------------------------------------------------------------------
create table if not exists public.org_units (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.org_units(id) on delete restrict,
  nama        text not null,
  tipe        text not null default 'departemen' check (tipe in ('pusat','cabang','departemen','bagian','lainnya')),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_org_units_parent on public.org_units(parent_id);

comment on table public.org_units is 'Pohon unit organisasi (kantor pusat, cabang, departemen, bagian). parent_id = unit induk. Dipakai sebagai acuan rantai approval izin & lembur.';

-- ---------------------------------------------------------------------
-- 2. TABEL: org_unit_members (siapa ada di unit mana; satu orang bisa
--    ada di banyak unit, tapi hanya SATU unit utama yang jadi acuan approval)
-- ---------------------------------------------------------------------
create table if not exists public.org_unit_members (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.org_units(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (unit_id, user_id)
);
create index if not exists idx_org_unit_members_user on public.org_unit_members(user_id);
create unique index if not exists uq_org_unit_members_one_primary
  on public.org_unit_members(user_id) where is_primary;

comment on table public.org_unit_members is 'Keanggotaan karyawan di unit. is_primary = unit utama (tepat satu per karyawan) yang menentukan rantai approval pengajuannya.';

-- ---------------------------------------------------------------------
-- 3. TABEL: approval_settings (jumlah tingkat approval per jenis pengajuan)
-- ---------------------------------------------------------------------
create table if not exists public.approval_settings (
  request_type text primary key check (request_type in ('izin','sakit','cuti','lembur')),
  levels       integer not null default 1 check (levels between 1 and 5),
  updated_by   uuid references public.profiles(id),
  updated_at   timestamptz not null default now()
);

insert into public.approval_settings (request_type, levels) values
  ('izin', 1), ('sakit', 1), ('cuti', 1), ('lembur', 1)
on conflict (request_type) do nothing;

-- ---------------------------------------------------------------------
-- 4. TABEL: request_approvals (tahap approval per pengajuan; approver
--    di-snapshot saat pengajuan dibuat, jadi pindah unit / ganti role
--    setelahnya tidak mengubah riwayat)
-- ---------------------------------------------------------------------
create table if not exists public.request_approvals (
  id              uuid primary key default gen_random_uuid(),
  request_type    text not null check (request_type in ('leave','overtime')),
  request_id      uuid not null,
  step_order      integer not null,
  unit_id         uuid references public.org_units(id) on delete set null,
  approver_ids    uuid[] not null,
  approver_names  text,
  status          text not null default 'waiting' check (status in ('waiting','pending','approved','rejected','skipped')),
  decided_by      uuid references public.profiles(id),
  decided_by_name text,
  decided_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  unique (request_type, request_id, step_order)
);
alter table public.request_approvals add column if not exists decided_by_name text;
create index if not exists idx_request_approvals_req on public.request_approvals(request_type, request_id);
create index if not exists idx_request_approvals_approvers on public.request_approvals using gin (approver_ids);

comment on table public.request_approvals is 'Satu baris = satu tahap approval untuk satu pengajuan izin/lembur. Hanya diisi & diubah lewat fungsi security definer (create_approval_steps / decide_approval), tidak lewat query langsung dari aplikasi.';

-- ---------------------------------------------------------------------
-- 5. TRIGGER: updated_at + jaga pohon unit (tidak boleh siklus)
-- ---------------------------------------------------------------------
drop trigger if exists trg_org_units_updated_at on public.org_units;
create trigger trg_org_units_updated_at
  before update on public.org_units
  for each row execute function public.set_updated_at();

create or replace function public.org_units_guard()
returns trigger language plpgsql as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Unit tidak boleh menjadi induk dirinya sendiri';
    end if;
    if tg_op = 'UPDATE' and exists (
      with recursive d as (
        select id from public.org_units where parent_id = new.id
        union all
        select u.id from public.org_units u join d on u.parent_id = d.id
      )
      select 1 from d where id = new.parent_id
    ) then
      raise exception 'Unit tidak boleh dipindah ke bawah turunannya sendiri';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_org_units_guard on public.org_units;
create trigger trg_org_units_guard
  before insert or update of parent_id on public.org_units
  for each row execute function public.org_units_guard();

-- Cek apakah user login adalah approver di salah satu tahap sebuah pengajuan.
-- security definer supaya dipakai di policy request_approvals tanpa rekursi RLS.
create or replace function public.is_request_approver(p_kind text, p_request_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.request_approvals a
    where a.request_type = p_kind and a.request_id = p_request_id and auth.uid() = any (a.approver_ids)
  );
$$;

-- ---------------------------------------------------------------------
-- 6. FUNGSI: resolve_approval_chain — inti aturan "cari Admin ke atas"
-- ---------------------------------------------------------------------
create or replace function public.resolve_approval_chain(p_user uuid, p_levels integer, p_menu text)
returns table (r_step integer, r_unit uuid, r_ids uuid[], r_names text)
language plpgsql security definer stable set search_path = public as $$
declare
  v_unit uuid;
  v_step integer := 0;
  v_used uuid[] := array[p_user];
  v_ids  uuid[];
  v_names text;
begin
  select m.unit_id into v_unit
  from public.org_unit_members m
  join public.org_units u on u.id = m.unit_id
  where m.user_id = p_user and m.is_primary and u.is_active
  limit 1;

  while v_unit is not null and v_step < p_levels loop
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.org_unit_members m
    join public.profiles p on p.id = m.user_id
    where m.unit_id = v_unit
      and p.is_active
      and p.id <> all (v_used)
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr', 'admin_approval')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );

    if v_ids is not null then
      v_step := v_step + 1;
      v_used := v_used || v_ids;
      r_step := v_step; r_unit := v_unit; r_ids := v_ids; r_names := v_names;
      return next;
    end if;

    select parent_id into v_unit from public.org_units where id = v_unit;
  end loop;

  -- Fallback: tidak ada approver sama sekali di rantai (atau belum punya unit
  -- utama) -> Super Admin + staff yang berhak approve (perilaku sebelum ada struktur).
  if v_step = 0 then
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.profiles p
    where p.is_active
      and p.id <> p_user
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );
    if v_ids is not null then
      r_step := 1; r_unit := null; r_ids := v_ids; r_names := v_names;
      return next;
    end if;
  end if;

  return;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. FUNGSI: create_approval_steps — dipanggil trigger saat pengajuan dibuat
-- ---------------------------------------------------------------------
create or replace function public.create_approval_steps(
  p_kind text, p_request_id uuid, p_user uuid, p_setting_key text, p_menu text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_levels integer;
  v_count  integer := 0;
  v_role   text;
  r record;
begin
  select coalesce((select levels from public.approval_settings where request_type = p_setting_key), 1)
    into v_levels;

  for r in select * from public.resolve_approval_chain(p_user, v_levels, p_menu) loop
    insert into public.request_approvals (request_type, request_id, step_order, unit_id, approver_ids, approver_names, status)
    values (p_kind, p_request_id, r.r_step, r.r_unit, r.r_ids, r.r_names,
            case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;
  end loop;

  -- Tidak ada approver sama sekali: hanya boleh disetujui otomatis kalau
  -- pemohonnya sendiri Super Admin (puncak). Selain itu dibiarkan pending
  -- dan hanya Super Admin yang bisa memprosesnya (lihat decide_approval).
  if v_count = 0 then
    select role into v_role from public.profiles where id = p_user;
    if v_role = 'super_admin' then
      if p_kind = 'leave' then
        update public.leave_requests
          set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
          where id = p_request_id;
      else
        update public.overtime_requests
          set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
          where id = p_request_id;
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. FUNGSI: decide_approval — satu-satunya jalan menyetujui/menolak
-- ---------------------------------------------------------------------
create or replace function public.decide_approval(
  p_kind text, p_request_id uuid, p_decision text, p_notes text default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_tbl    text;
  v_owner  uuid;
  v_status text;
  v_step   public.request_approvals%rowtype;
  v_next   public.request_approvals%rowtype;
  v_final  text := 'pending';
begin
  if v_uid is null then raise exception 'Belum login'; end if;
  if p_kind not in ('leave', 'overtime') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind when 'leave' then 'leave_requests' else 'overtime_requests' end;
  execute format('select user_id, status from public.%I where id = $1 for update', v_tbl)
    into v_owner, v_status using p_request_id;

  if v_owner is null then raise exception 'Pengajuan tidak ditemukan'; end if;
  if v_status <> 'pending' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_owner = v_uid then raise exception 'Tidak boleh memproses pengajuan sendiri'; end if;

  select * into v_step
  from public.request_approvals
  where request_type = p_kind and request_id = p_request_id and status = 'pending'
  order by step_order limit 1
  for update;

  if found then
    if not (v_uid = any (v_step.approver_ids) or public.is_super()) then
      raise exception 'Bukan giliran kamu untuk memproses pengajuan ini';
    end if;

    update public.request_approvals
      set status = p_decision, decided_by = v_uid, decided_at = now(), notes = p_notes,
          decided_by_name = (select full_name from public.profiles where id = v_uid)
      where id = v_step.id;

    if p_decision = 'rejected' then
      update public.request_approvals set status = 'skipped'
        where request_type = p_kind and request_id = p_request_id and status = 'waiting';
      v_final := 'rejected';
    else
      select * into v_next
      from public.request_approvals
      where request_type = p_kind and request_id = p_request_id and status = 'waiting'
      order by step_order limit 1;
      if found then
        update public.request_approvals set status = 'pending' where id = v_next.id;
      else
        v_final := 'approved';
      end if;
    end if;
  else
    -- Tidak ada tahap sama sekali (tidak ada approver ditemukan): hanya Super Admin.
    if not public.is_super() then
      raise exception 'Pengajuan ini belum punya approver. Hubungi Super Admin.';
    end if;
    v_final := p_decision;
  end if;

  if v_final <> 'pending' then
    execute format(
      'update public.%I set status = $1, reviewed_by = $2, reviewed_at = now(), review_notes = $3 where id = $4',
      v_tbl
    ) using v_final, v_uid, p_notes, p_request_id;
  end if;

  return v_final;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. FUNGSI: set_primary_unit — pindah unit utama secara atomik
-- ---------------------------------------------------------------------
create or replace function public.set_primary_unit(p_user uuid, p_unit uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  update public.org_unit_members set is_primary = false
    where user_id = p_user and is_primary and unit_id <> p_unit;
  insert into public.org_unit_members (unit_id, user_id, is_primary)
    values (p_unit, p_user, true)
  on conflict (unit_id, user_id) do update set is_primary = true;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. TRIGGER pada leave_requests & overtime_requests
--     BEFORE INSERT : paksa status 'pending' (karyawan tidak boleh menitipkan
--                     status 'approved' lewat API)
--     AFTER  INSERT : bentuk tahap-tahap approval
-- ---------------------------------------------------------------------
create or replace function public.requests_force_pending()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_notes := null;
  end if;
  return new;
end;
$$;

create or replace function public.leave_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_approval_steps('leave', new.id, new.user_id, new.type, 'izin-approval');
  return new;
end;
$$;

create or replace function public.overtime_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_approval_steps('overtime', new.id, new.user_id, 'lembur', 'lembur-approval');
  return new;
end;
$$;

drop trigger if exists trg_leave_force_pending on public.leave_requests;
create trigger trg_leave_force_pending
  before insert on public.leave_requests
  for each row execute function public.requests_force_pending();

drop trigger if exists trg_leave_after_insert on public.leave_requests;
create trigger trg_leave_after_insert
  after insert on public.leave_requests
  for each row execute function public.leave_after_insert();

drop trigger if exists trg_overtime_force_pending on public.overtime_requests;
create trigger trg_overtime_force_pending
  before insert on public.overtime_requests
  for each row execute function public.requests_force_pending();

drop trigger if exists trg_overtime_after_insert on public.overtime_requests;
create trigger trg_overtime_after_insert
  after insert on public.overtime_requests
  for each row execute function public.overtime_after_insert();

-- Fungsi internal tidak boleh dipanggil langsung dari aplikasi.
revoke execute on function public.create_approval_steps(text, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.resolve_approval_chain(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.decide_approval(text, uuid, text, text) to authenticated;
grant execute on function public.set_primary_unit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 11. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.org_units enable row level security;
alter table public.org_unit_members enable row level security;
alter table public.approval_settings enable row level security;
alter table public.request_approvals enable row level security;

-- org_units: nama unit tidak sensitif, semua user login boleh baca.
drop policy if exists "org_units_select" on public.org_units;
create policy "org_units_select" on public.org_units
  for select using ( auth.uid() is not null );

drop policy if exists "org_units_write" on public.org_units;
create policy "org_units_write" on public.org_units
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- org_unit_members: baris sendiri, atau yang punya akses lihat/kelola struktur.
drop policy if exists "org_members_select" on public.org_unit_members;
create policy "org_members_select" on public.org_unit_members
  for select using (
    user_id = auth.uid()
    or public.is_staff()
    or public.has_menu_access('struktur-organisasi')
    or public.has_menu_access('struktur-kelola')
  );

drop policy if exists "org_members_write" on public.org_unit_members;
create policy "org_members_write" on public.org_unit_members
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- approval_settings
drop policy if exists "approval_settings_select" on public.approval_settings;
create policy "approval_settings_select" on public.approval_settings
  for select using ( auth.uid() is not null );

drop policy if exists "approval_settings_write" on public.approval_settings;
create policy "approval_settings_write" on public.approval_settings
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- request_approvals: hanya baca. Tulis HANYA lewat fungsi security definer.
drop policy if exists "request_approvals_select" on public.request_approvals;
create policy "request_approvals_select" on public.request_approvals
  for select using (
    public.is_super()
    or public.is_request_approver(request_type, request_id)
    or (request_type = 'leave' and exists (
          select 1 from public.leave_requests r where r.id = request_id and r.user_id = auth.uid()))
    or (request_type = 'overtime' and exists (
          select 1 from public.overtime_requests r where r.id = request_id and r.user_id = auth.uid()))
  );

-- ---------------------------------------------------------------------
-- 11b. Approver boleh MEMBACA profil pemohon yang pengajuannya menunggu /
--      pernah melewati dirinya (untuk menampilkan nama & departemen di
--      halaman Approval). Terbatas ke pemohon di rantainya saja -- Admin
--      Approval tidak dianggap staff (is_staff), jadi tanpa ini nama
--      pemohon tidak terbaca.
-- ---------------------------------------------------------------------
create or replace function public.is_approver_of_user(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.request_approvals a
    where a.approver_ids @> array[auth.uid()]
      and (
        (a.request_type = 'leave' and exists (
          select 1 from public.leave_requests r where r.id = a.request_id and r.user_id = p_user))
        or (a.request_type = 'overtime' and exists (
          select 1 from public.overtime_requests r where r.id = a.request_id and r.user_id = p_user))
      )
  );
$$;

drop policy if exists "profiles_select_approver" on public.profiles;
create policy "profiles_select_approver" on public.profiles
  for select using ( public.is_approver_of_user(id) );

-- ---------------------------------------------------------------------
-- 12. TUTUP CELAH: karyawan bisa mengubah status pengajuannya sendiri.
--     Policy update lama mengizinkan (user_id = auth.uid()) -- sekarang
--     UPDATE langsung hanya untuk Super Admin (koreksi manual). Approve /
--     tolak lewat decide_approval().
-- ---------------------------------------------------------------------
drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update" on public.leave_requests
  for update using ( public.is_super() );

drop policy if exists "overtime_update" on public.overtime_requests;
create policy "overtime_update" on public.overtime_requests
  for update using ( public.is_super() );

-- ---------------------------------------------------------------------
-- 13. Hak menu: 'struktur-kelola' = boleh mengubah struktur & pengaturan
--     tingkat approval (menu 'struktur-organisasi' tetap untuk melihat).
--     Default: hanya Super Admin HR; bisa diatur di Pengaturan Sistem.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, menu_id, enabled) values
  ('super_admin_hr', 'struktur-kelola', true),
  ('admin_hr', 'struktur-kelola', false),
  ('karyawan', 'struktur-kelola', false)
on conflict (role, menu_id) do nothing;

-- ---------------------------------------------------------------------
-- 14. BACKFILL: pengajuan yang masih 'pending' sebelum migrasi ini
--     dibentuk tahap approvalnya (supaya tidak menggantung).
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select id, user_id, type from public.leave_requests l
    where l.status = 'pending'
      and not exists (select 1 from public.request_approvals a where a.request_type = 'leave' and a.request_id = l.id)
  loop
    perform public.create_approval_steps('leave', r.id, r.user_id, r.type, 'izin-approval');
  end loop;

  for r in
    select id, user_id from public.overtime_requests o
    where o.status = 'pending'
      and not exists (select 1 from public.request_approvals a where a.request_type = 'overtime' and a.request_id = o.id)
  loop
    perform public.create_approval_steps('overtime', r.id, r.user_id, 'lembur', 'lembur-approval');
  end loop;
end $$;
