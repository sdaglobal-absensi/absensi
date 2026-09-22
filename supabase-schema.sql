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
  role            text not null default 'karyawan' check (role in ('admin','hr','karyawan')),
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

comment on table public.profiles is 'Data profil & role setiap pengguna. role: admin | hr | karyawan';

-- ---------------------------------------------------------------------
-- 2. TABEL: office_locations (titik kantor untuk validasi radius GPS)
-- ---------------------------------------------------------------------
create table if not exists public.office_locations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  lat             double precision not null,
  lng             double precision not null,
  radius_meters   integer not null default 150,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

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
  kenaikan_upah_tahunan    numeric not null default 0,   -- Rp, total kenaikan setahun (dibagi 2 periode = 50%+50%)
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
alter table public.job_levels add column if not exists kenaikan_upah_tahunan numeric not null default 0;

-- Tunjangan Jabatan & Tunjangan Loyalitas ternyata beda-beda per karyawan
-- (bukan per grade/level), jadi kolom di job_levels ini tidak dipakai lagi
-- — datanya sekarang di allowance_types + employee_allowances (Master
-- Tunjangan) di bawah. Baris ini membersihkan kolom lama kalau sempat
-- dibuat di database (aman dijalankan ulang meski kolomnya belum ada).
alter table public.job_levels drop column if exists tunjangan_jabatan;
alter table public.job_levels drop column if exists tunjangan_loyalitas;

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
-- 4h. TABEL: late_penalty_rules (Master Denda Terlambat & Pulang Cepat)
--     Dulu tabel jam bertingkat ini "hardcode" di kode Slip Gaji, sekarang
--     jadi setting manual yang bisa diubah admin/HR lewat menu Master Data
--     tanpa perlu ubah kode. Satu baris = satu tingkatan (tier) jam untuk
--     satu jenis (telat / pulang_cepat) pada satu kelompok hari
--     (weekday = Senin-Jumat, saturday = Sabtu).
--
--     - jenis = 'telat'        -> jam = batas jam MULAI dianggap telat
--                                  ("lebih dari jam ..."). Yang dipakai saat
--                                  hitung slip adalah tier PALING TERAKHIR
--                                  yang jam check-in-nya sudah terlampaui.
--     - jenis = 'pulang_cepat' -> jam = batas jam pulang ("kurang dari jam
--                                  ..."). Yang dipakai adalah tier PERTAMA
--                                  (jam paling pagi) yang jam check-out-nya
--                                  masih di bawah batas.
--     - tipe = 'flat'    -> potongan = nominal (Rp tetap), tidak tergantung
--                            "Denda Terlambat & Pulang Cepat" di Master Level.
--     - tipe = 'percent' -> potongan = persen% x "Denda Terlambat & Pulang
--                            Cepat" (Rp) pada Master Level karyawan ybs.
-- ---------------------------------------------------------------------
create table if not exists public.late_penalty_rules (
  id          uuid primary key default gen_random_uuid(),
  day_type    text not null check (day_type in ('weekday','saturday')),
  jenis       text not null check (jenis in ('telat','pulang_cepat')),
  jam         time not null,
  tipe        text not null check (tipe in ('flat','percent')) default 'percent',
  nominal     numeric not null default 0,  -- dipakai kalau tipe='flat'
  persen      numeric not null default 0,  -- dipakai kalau tipe='percent'
  label       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (day_type, jenis, jam)
);

-- Seed nilai default (persis konsep awal) supaya perhitungan tidak berubah
-- setelah migrasi. Aman dijalankan ulang (on conflict do nothing).
insert into public.late_penalty_rules (day_type, jenis, jam, tipe, nominal, persen, label) values
  ('weekday',  'telat',        '08:00', 'flat',    50000, 0,   'Telat > 08:00'),
  ('weekday',  'telat',        '10:00', 'percent', 0,     50,  'Telat > 10:00 (50% denda)'),
  ('weekday',  'telat',        '12:00', 'percent', 0,     100, 'Telat > 12:00 (100% denda)'),
  ('saturday', 'telat',        '08:00', 'flat',    50000, 0,   'Telat > 08:00'),
  ('saturday', 'telat',        '09:00', 'percent', 0,     50,  'Telat > 09:00 (50% denda)'),
  ('saturday', 'telat',        '10:00', 'percent', 0,     100, 'Telat > 10:00 (100% denda)'),
  ('weekday',  'pulang_cepat', '13:00', 'percent', 0,     100, 'Pulang < 13:00 (100% denda)'),
  ('weekday',  'pulang_cepat', '14:00', 'percent', 0,     50,  'Pulang 13:00–14:00 (50% denda)'),
  ('saturday', 'pulang_cepat', '11:00', 'percent', 0,     100, 'Pulang < 11:00 (100% denda)'),
  ('saturday', 'pulang_cepat', '12:00', 'percent', 0,     50,  'Pulang 11:00–12:00 (50% denda)')
on conflict (day_type, jenis, jam) do nothing;

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
--    (role default 'karyawan'; admin bisa upgrade role lewat panel admin)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role, employee_code, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'karyawan'),
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
-- 7. HELPER FUNCTION: role user yang sedang login
--    (security definer supaya tidak memicu rekursi RLS di profiles)
-- ---------------------------------------------------------------------
create or replace function public.my_role()
returns text language sql security definer stable set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin_or_hr()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select role in ('admin','hr') from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.attendance enable row level security;
alter table public.leave_requests enable row level security;
alter table public.office_locations enable row level security;

-- profiles -------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using ( id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using ( id = auth.uid() )
  with check ( id = auth.uid() and role = (select role from public.profiles where id = auth.uid()) );

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all using ( public.my_role() = 'admin' )
  with check ( public.my_role() = 'admin' );

-- attendance -------------------------------------------------------------
drop policy if exists "attendance_select" on public.attendance;
create policy "attendance_select" on public.attendance
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "attendance_insert_self" on public.attendance;
create policy "attendance_insert_self" on public.attendance
  for insert with check ( user_id = auth.uid() );

drop policy if exists "attendance_update_self" on public.attendance;
create policy "attendance_update_self" on public.attendance
  for update using ( user_id = auth.uid() or public.my_role() = 'admin' );

-- leave_requests -------------------------------------------------------------
drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select" on public.leave_requests
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "leave_insert_self" on public.leave_requests;
create policy "leave_insert_self" on public.leave_requests
  for insert with check ( user_id = auth.uid() );

drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update" on public.leave_requests
  for update using ( user_id = auth.uid() or public.is_admin_or_hr() );

-- overtime_requests (Pengajuan Lembur) -------------------------------------------------------------
alter table public.overtime_requests enable row level security;

drop policy if exists "overtime_select" on public.overtime_requests;
create policy "overtime_select" on public.overtime_requests
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "overtime_insert_self" on public.overtime_requests;
create policy "overtime_insert_self" on public.overtime_requests
  for insert with check ( user_id = auth.uid() );

drop policy if exists "overtime_update" on public.overtime_requests;
create policy "overtime_update" on public.overtime_requests
  for update using ( user_id = auth.uid() or public.is_admin_or_hr() );

-- payroll_adjustments (Slip Gaji — komponen manual) -------------------------------------------------------------
alter table public.payroll_adjustments enable row level security;

drop policy if exists "payroll_adjustments_select" on public.payroll_adjustments;
create policy "payroll_adjustments_select" on public.payroll_adjustments
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "payroll_adjustments_admin_write" on public.payroll_adjustments;
create policy "payroll_adjustments_admin_write" on public.payroll_adjustments
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- office_locations -------------------------------------------------------------
drop policy if exists "office_select_all" on public.office_locations;
create policy "office_select_all" on public.office_locations
  for select using ( true );

drop policy if exists "office_admin_write" on public.office_locations;
create policy "office_admin_write" on public.office_locations
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- job_levels (Master Level) -------------------------------------------------------------
drop trigger if exists trg_job_levels_updated_at on public.job_levels;
create trigger trg_job_levels_updated_at
  before update on public.job_levels
  for each row execute function public.set_updated_at();

alter table public.job_levels enable row level security;

drop policy if exists "job_levels_select" on public.job_levels;
create policy "job_levels_select" on public.job_levels
  for select using ( public.is_admin_or_hr() );

drop policy if exists "job_levels_admin_write" on public.job_levels;
create policy "job_levels_admin_write" on public.job_levels
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- wage_history (Riwayat Upah Harian) -------------------------------------------------------------
alter table public.wage_history enable row level security;

drop policy if exists "wage_history_select" on public.wage_history;
create policy "wage_history_select" on public.wage_history
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "wage_history_admin_write" on public.wage_history;
create policy "wage_history_admin_write" on public.wage_history
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- salary_history (Riwayat Gaji Bulanan) -------------------------------------------------------------
alter table public.salary_history enable row level security;

drop policy if exists "salary_history_select" on public.salary_history;
create policy "salary_history_select" on public.salary_history
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "salary_history_admin_write" on public.salary_history;
create policy "salary_history_admin_write" on public.salary_history
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- departments (Master Departemen) -------------------------------------------------------------
drop trigger if exists trg_departments_updated_at on public.departments;
create trigger trg_departments_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();

alter table public.departments enable row level security;

drop policy if exists "departments_select" on public.departments;
create policy "departments_select" on public.departments
  for select using ( public.is_admin_or_hr() );

drop policy if exists "departments_admin_write" on public.departments;
create policy "departments_admin_write" on public.departments
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

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
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

drop policy if exists "schedule_days_select" on public.work_schedule_days;
create policy "schedule_days_select" on public.work_schedule_days for select using ( true );
drop policy if exists "schedule_days_admin_write" on public.work_schedule_days;
create policy "schedule_days_admin_write" on public.work_schedule_days
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- holidays (Master Hari Libur) -------------------------------------------------------------
alter table public.holidays enable row level security;
drop policy if exists "holidays_select" on public.holidays;
create policy "holidays_select" on public.holidays for select using ( true );
drop policy if exists "holidays_admin_write" on public.holidays;
create policy "holidays_admin_write" on public.holidays
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

-- late_penalty_rules (Master Denda Terlambat & Pulang Cepat) -------------------------------------------------------------
drop trigger if exists trg_late_penalty_rules_updated_at on public.late_penalty_rules;
create trigger trg_late_penalty_rules_updated_at
  before update on public.late_penalty_rules
  for each row execute function public.set_updated_at();

alter table public.late_penalty_rules enable row level security;

drop policy if exists "late_penalty_rules_select" on public.late_penalty_rules;
create policy "late_penalty_rules_select" on public.late_penalty_rules
  for select using ( public.is_admin_or_hr() );

drop policy if exists "late_penalty_rules_admin_write" on public.late_penalty_rules;
create policy "late_penalty_rules_admin_write" on public.late_penalty_rules
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

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
  for select using ( public.is_admin_or_hr() );

drop policy if exists "allowance_types_admin_write" on public.allowance_types;
create policy "allowance_types_admin_write" on public.allowance_types
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );

drop policy if exists "employee_allowances_select" on public.employee_allowances;
create policy "employee_allowances_select" on public.employee_allowances
  for select using ( user_id = auth.uid() or public.is_admin_or_hr() );

drop policy if exists "employee_allowances_admin_write" on public.employee_allowances;
create policy "employee_allowances_admin_write" on public.employee_allowances
  for all using ( public.my_role() = 'admin' ) with check ( public.my_role() = 'admin' );




-- ---------------------------------------------------------------------
-- 9. STORAGE BUCKET untuk foto absensi (jalankan sekali)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('attendance-photos', 'attendance-photos', true)
on conflict (id) do nothing;

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
-- 11. AKUN ADMIN PERTAMA
-- ---------------------------------------------------------------------
-- Buat user pertama lewat Supabase Dashboard > Authentication > Users >
-- Add user (centang "Auto Confirm User"). Trigger di atas otomatis membuat
-- baris di public.profiles untuknya. Lalu jalankan baris berikut (ganti
-- email) supaya akun itu jadi admin:
--
-- update public.profiles set role = 'admin' where id =
--   (select id from auth.users where email = 'admin@perusahaan.com');
