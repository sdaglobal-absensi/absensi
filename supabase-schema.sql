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
  position        text,
  phone           text,
  photo_url       text,
  join_date       date default current_date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

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
-- 5. TRIGGER: auto-update updated_at
-- ---------------------------------------------------------------------
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
  insert into public.profiles (id, full_name, role, employee_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'karyawan'),
    new.raw_user_meta_data->>'employee_code'
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

-- office_locations -------------------------------------------------------------
drop policy if exists "office_select_all" on public.office_locations;
create policy "office_select_all" on public.office_locations
  for select using ( true );

drop policy if exists "office_admin_write" on public.office_locations;
create policy "office_admin_write" on public.office_locations
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
insert into public.office_locations (name, lat, lng, radius_meters)
values ('Kantor Pusat', -7.257472, 112.752088, 150)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 11. AKUN ADMIN PERTAMA
-- ---------------------------------------------------------------------
-- Setelah signup akun pertama lewat halaman login (index.html), jalankan
-- baris berikut di SQL editor (ganti email) supaya akun itu jadi admin:
--
-- update public.profiles set role = 'admin' where id =
--   (select id from auth.users where email = 'admin@perusahaan.com');
