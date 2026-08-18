-- ============================================================
--  SKEMA DATABASE — Aplikasi Absensi Karyawan (mirip DingTalk)
--  Jalankan seluruh file ini di Supabase Dashboard:
--  Project → SQL Editor → New query → paste → Run
-- ============================================================

-- 1) Tabel profil pengguna (menambahkan info role & departemen di atas auth.users bawaan Supabase)
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  employee_code text,                     -- NIK / kode karyawan (opsional)
  department    text,
  position      text,                     -- jabatan
  phone         text,                     -- no. HP
  join_date     date,                     -- tanggal bergabung
  is_active     boolean not null default true,
  role          text not null default 'karyawan' check (role in ('karyawan','admin')),
  created_at    timestamptz not null default now()
);

-- Jika tabel profiles sudah ada dari versi sebelumnya, tambahkan kolom baru dengan aman:
alter table public.profiles add column if not exists position text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists join_date date;
alter table public.profiles add column if not exists is_active boolean not null default true;

-- 2) Tabel absensi
create table if not exists public.attendance (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  date         date not null default current_date,
  check_in     timestamptz,
  check_out    timestamptz,
  status       text not null default 'hadir' check (status in ('hadir','terlambat','izin','sakit','alpha')),
  note         text,
  created_at   timestamptz not null default now(),
  unique (user_id, date)                  -- satu baris absensi per karyawan per hari
);

-- 3) Fungsi + trigger: otomatis buat baris profile saat ada user baru mendaftar
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'karyawan'          -- role default; naikkan ke 'admin' manual lewat SQL (lihat catatan di bawah)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 4) Fungsi bantu: cek apakah user yang sedang login adalah admin (dipakai di RLS, hindari infinite recursion)
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- 4b) Fungsi khusus modul "Data Karyawan": kembalikan email asli dari auth.users,
--     hanya untuk pemanggil yang berrole admin (dipakai oleh js/modules/admin-karyawan.js)
create or replace function public.admin_list_users()
returns table(id uuid, email text)
language sql
security definer set search_path = public
stable
as $$
  select u.id, u.email
  from auth.users u
  where public.is_admin();
$$;

grant execute on function public.admin_list_users() to authenticated;

-- 5) Aktifkan Row Level Security
alter table public.profiles enable row level security;
alter table public.attendance enable row level security;

-- 6) Kebijakan (policies) — PROFILES
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using ( auth.uid() = id or public.is_admin() );

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
  on public.profiles for update
  using ( auth.uid() = id or public.is_admin() );

-- 7) Kebijakan — ATTENDANCE
drop policy if exists "attendance_select_own_or_admin" on public.attendance;
create policy "attendance_select_own_or_admin"
  on public.attendance for select
  using ( auth.uid() = user_id or public.is_admin() );

drop policy if exists "attendance_insert_own" on public.attendance;
create policy "attendance_insert_own"
  on public.attendance for insert
  with check ( auth.uid() = user_id );

drop policy if exists "attendance_update_own_or_admin" on public.attendance;
create policy "attendance_update_own_or_admin"
  on public.attendance for update
  using ( auth.uid() = user_id or public.is_admin() );

-- ============================================================
--  CATATAN PENTING
-- ============================================================
-- A) Membuat akun ADMIN pertama kali:
--    1. Daftar akun biasa dulu lewat halaman signup di aplikasi (index.html).
--    2. Lalu jalankan query berikut di SQL Editor (ganti email-nya):
--
--       update public.profiles
--       set role = 'admin'
--       where id = (select id from auth.users where email = 'admin@perusahaan.com');
--
-- B) Karyawan baru cukup daftar sendiri lewat halaman signup (role default: karyawan),
--    lalu admin bisa mengubah department/employee_code lewat tab "Karyawan" di dashboard admin.
--
-- C) Jika ingin menonaktifkan pendaftaran bebas dan hanya admin yang mengundang karyawan,
--    lakukan lewat Supabase Dashboard → Authentication → Users → Invite user.
-- ============================================================
