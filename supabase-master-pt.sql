-- =====================================================================
-- MASTER PT / VENDOR — daftar pilihan untuk kolom "Unit / PT" di Data
-- Karyawan (menggantikan ketik manual). Jalankan sekali di Supabase SQL
-- Editor (aman dijalankan ulang). Butuh supabase-jenis-hubungan-kerja.sql
-- sudah dijalankan lebih dulu (dipakai untuk backfill di bawah).
--
-- profiles.unit_pt TETAP berisi nama PT (teks) -- tidak diubah jadi
-- foreign key -- supaya Slip Gaji, Laporan, dan Invoice Outsourcing yang
-- sudah memakai unit_pt tidak perlu diubah.
-- =====================================================================

create table if not exists public.master_pt (
  id          uuid primary key default gen_random_uuid(),
  nama        text not null unique,
  jenis       text not null default 'internal' check (jenis in ('internal', 'vendor')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.master_pt is
  'Master PT / Vendor. jenis internal = PT sendiri (Karyawan Tetap/PKWT), vendor = PT penyedia jasa outsourcing.';

-- Backfill: nama Unit/PT yang sudah pernah diketik di Data Karyawan otomatis
-- masuk daftar. Kalau ada karyawan Outsourcing yang memakainya -> vendor,
-- selain itu -> internal.
insert into public.master_pt (nama, jenis)
select trim(unit_pt),
       case when bool_or(jenis_hubungan_kerja = 'outsourcing') then 'vendor' else 'internal' end
from public.profiles
where unit_pt is not null and trim(unit_pt) <> ''
group by trim(unit_pt)
on conflict (nama) do nothing;

alter table public.master_pt enable row level security;

drop policy if exists "master_pt_select" on public.master_pt;
create policy "master_pt_select" on public.master_pt
  for select using ( public.is_staff() or public.has_menu_access('karyawan') );

drop policy if exists "master_pt_write" on public.master_pt;
create policy "master_pt_write" on public.master_pt
  for all using ( public.has_menu_access('master-pt') )
  with check ( public.has_menu_access('master-pt') );

insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_hr', 'master-pt', false),
  ('super_admin_hr', 'master-pt', true),
  ('admin_approval', 'master-pt', false),
  ('karyawan', 'master-pt', false)
on conflict (role, menu_id) do nothing;
