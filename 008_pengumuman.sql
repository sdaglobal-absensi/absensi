-- =====================================================================
-- PRIORITAS TINGGI #1 — PENGUMUMAN / INFO INTERNAL
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-007 (dan supabase-notifikasi.sql).
-- Aman dijalankan dua kali (idempotent). Satu transaksi.
--
-- Isi:
--   1. Tabel announcements (+ target: semua karyawan / satu unit & anak unitnya)
--   2. Tabel announcement_reads (siapa sudah membaca)
--   3. RLS: karyawan hanya melihat pengumuman yang ditujukan ke dia;
--      yang boleh membuat/mengubah = pemegang menu 'pengumuman-kelola'
--   4. Trigger: pengumuman baru -> notifikasi lonceng ke semua penerima
--   5. Hak menu: 'pengumuman' (Info Internal, semua role) dan
--      'pengumuman-kelola' (Admin HR / Super Admin HR) + default usaha baru
--
-- Paket: fitur DASAR (tidak ada di feature_catalog) -> aktif di semua
-- paket termasuk Gratis.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Fungsi bantu: unit + semua unit di bawahnya
-- ---------------------------------------------------------------------
create or replace function public.unit_with_descendants(p_unit uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  with recursive tree as (
    select id from public.org_units
     where id = p_unit and tenant_id = public.current_tenant_id()
    union all
    select u.id from public.org_units u
      join tree t on u.parent_id = t.id
     where u.tenant_id = public.current_tenant_id()
  )
  select id from tree;
$$;
grant execute on function public.unit_with_descendants(uuid) to authenticated;

-- Unit tujuan + semua unit di bawahnya (tanpa cek tenant: dipanggil hanya
-- dengan id dari baris announcements yang sudah lolos isolasi tenant).
create or replace function public.unit_with_descendants_of_root(p_unit uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  with recursive tree as (
    select id from public.org_units where id = p_unit
    union all
    select u.id from public.org_units u join tree t on u.parent_id = t.id
  )
  select id from tree;
$$;
revoke execute on function public.unit_with_descendants_of_root(uuid) from public, anon;
grant execute on function public.unit_with_descendants_of_root(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 1. TABEL announcements
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default public.current_tenant_id()
                   references public.tenants(id) on delete restrict,
  title          text not null check (length(btrim(title)) between 1 and 150),
  body           text not null check (length(btrim(body)) between 1 and 5000),
  target_type    text not null default 'semua' check (target_type in ('semua', 'unit')),
  target_unit_id uuid references public.org_units(id) on delete cascade,
  is_pinned      boolean not null default false,
  is_active      boolean not null default true,
  expires_at     timestamptz,
  created_by     uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint announcements_target_chk check (
    (target_type = 'semua' and target_unit_id is null)
    or (target_type = 'unit' and target_unit_id is not null)
  )
);
create index if not exists idx_announcements_tenant_created
  on public.announcements (tenant_id, created_at desc);

comment on table public.announcements is
  'Pengumuman / info internal dari admin ke karyawan. target_type=semua -> seluruh karyawan usaha; target_type=unit -> anggota unit itu beserta unit di bawahnya.';

-- tenant_id tidak boleh diubah (pola yang sama dengan tabel lain)
drop trigger if exists aa_tenant_immutable on public.announcements;
create trigger aa_tenant_immutable before update on public.announcements
  for each row execute function public.tg_tenant_immutable();

create or replace function public.tg_announcements_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists ab_announcements_touch on public.announcements;
create trigger ab_announcements_touch before update on public.announcements
  for each row execute function public.tg_announcements_touch();

-- ---------------------------------------------------------------------
-- 2. TABEL announcement_reads
-- ---------------------------------------------------------------------
create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  tenant_id       uuid not null default public.current_tenant_id()
                    references public.tenants(id) on delete restrict,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index if not exists idx_announcement_reads_user on public.announcement_reads (user_id);

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;

-- Isolasi antar usaha (restrictive, di-AND dengan policy lain).
drop policy if exists tenant_isolation on public.announcements;
create policy tenant_isolation on public.announcements as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists tenant_isolation on public.announcement_reads;
create policy tenant_isolation on public.announcement_reads as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- Pengelola (menu 'pengumuman-kelola', Super Admin selalu lolos) boleh semua.
drop policy if exists announcements_manage on public.announcements;
create policy announcements_manage on public.announcements for all
  using (public.has_menu_access('pengumuman-kelola'))
  with check (
    public.has_menu_access('pengumuman-kelola')
    and (
      target_unit_id is null
      or target_unit_id in (select public.unit_with_descendants(target_unit_id))
    )
  );

-- Karyawan: hanya pengumuman AKTIF, belum kedaluwarsa, dan ditujukan ke dia.
drop policy if exists announcements_read_audience on public.announcements;
create policy announcements_read_audience on public.announcements for select
  using (
    is_active
    and (expires_at is null or expires_at > now())
    and (
      target_type = 'semua'
      or exists (
        select 1 from public.org_unit_members m
         where m.user_id = auth.uid()
           and m.unit_id in (select public.unit_with_descendants_of_root(target_unit_id))
      )
    )
  );

-- Catatan kecil: policy 'announcements_manage' memakai unit_with_descendants(target_unit_id)
-- sebagai pemeriksaan bahwa unit tujuan memang milik usaha ini (fungsi itu
-- sudah memfilter tenant). Unit milik usaha lain -> himpunan kosong -> ditolak.

-- announcement_reads: setiap orang hanya mencatat & melihat bacaan DIRINYA.
drop policy if exists announcement_reads_own on public.announcement_reads;
create policy announcement_reads_own on public.announcement_reads for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.announcements a where a.id = announcement_id)
  );

-- Pengelola boleh MELIHAT (bukan mengubah) siapa saja yang sudah membaca.
drop policy if exists announcement_reads_manage_select on public.announcement_reads;
create policy announcement_reads_manage_select on public.announcement_reads for select
  using (public.has_menu_access('pengumuman-kelola'));

-- ---------------------------------------------------------------------
-- 4. NOTIFIKASI LONCENG
--    Tipe & jenis permintaan di tabel notifications dibatasi CHECK, jadi
--    diperluas dulu ('announcement').
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.notifications'::regclass and contype = 'c'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('approval_needed', 'approval_decided', 'announcement'));
alter table public.notifications
  add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement'));

-- Daftar penerima sebuah pengumuman (aktif, satu usaha, kecuali pembuatnya).
create or replace function public.announcement_audience(p_ann uuid)
returns table (user_id uuid) language sql security definer stable set search_path = public as $$
  select p.id
    from public.announcements a
    join public.profiles p on p.tenant_id = a.tenant_id and p.is_active
   where a.id = p_ann
     and p.id is distinct from a.created_by
     and (
       a.target_type = 'semua'
       or exists (
         select 1 from public.org_unit_members m
          where m.user_id = p.id
            and m.unit_id in (select public.unit_with_descendants_of_root(a.target_unit_id))
       )
     );
$$;
revoke execute on function public.announcement_audience(uuid) from public, anon, authenticated;

create or replace function public.tg_announcement_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Kirim hanya saat pengumuman BARU aktif, atau saat diaktifkan kembali.
  if tg_op = 'UPDATE' and not (new.is_active and not old.is_active) then
    return new;
  end if;
  if not new.is_active then
    return new;
  end if;

  insert into public.notifications (tenant_id, user_id, type, title, body, request_type, request_id)
  select new.tenant_id, aud.user_id, 'announcement',
         case when new.is_pinned then 'Pengumuman penting: ' else 'Pengumuman: ' end || new.title,
         left(new.body, 140),
         'announcement', new.id
    from public.announcement_audience(new.id) aud;

  return new;
end;
$$;

drop trigger if exists zz_announcement_notify on public.announcements;
create trigger zz_announcement_notify after insert or update of is_active on public.announcements
  for each row execute function public.tg_announcement_notify();

-- ---------------------------------------------------------------------
-- 5. HAK MENU
--    pengumuman        : semua role melihat Info Internal
--    pengumuman-kelola : hanya Admin HR & Super Admin HR (Super Admin
--                        selalu lolos). Karyawan & Admin approval = mati,
--                        bisa dinyalakan manual di Pengaturan Sistem.
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'pengumuman', true),
  ('admin_hr',       'pengumuman', true),
  ('admin_approval', 'pengumuman', true),
  ('karyawan',       'pengumuman', true),
  ('super_admin_hr', 'pengumuman-kelola', true),
  ('admin_hr',       'pengumuman-kelola', true),
  ('admin_approval', 'pengumuman-kelola', false),
  ('karyawan',       'pengumuman-kelola', false)
on conflict (role, menu_id) do nothing;

-- Usaha yang SUDAH ada: salin default di atas (tidak menimpa yang sudah ada).
insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('pengumuman', 'pengumuman-kelola')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): karyawan hanya menu pribadi -> tambahkan
-- 'pengumuman' ke daftar menu pribadi. (Isi fungsi = salinan 004 + 1 item.)
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman'];
begin
  if p_template = 'lengkap' then
    update public.tenants set role_mode = 'lengkap' where id = p_tenant;
  elsif p_template = 'ringkas' then
    update public.tenants set role_mode = 'ringkas' where id = p_tenant;
    update public.role_permissions
       set enabled = (role = 'karyawan' and menu_id = any(v_personal))
     where tenant_id = p_tenant;
    insert into public.role_permissions (tenant_id, role, menu_id, enabled)
    select p_tenant, 'karyawan', m, true from unnest(v_personal) m
    on conflict (tenant_id, role, menu_id) do update set enabled = true;
  else
    raise exception 'Template "%" tidak dikenal (pilih: lengkap / ringkas)', p_template;
  end if;
end;
$$;
revoke execute on function public.seed_tenant_template(uuid, text) from public, anon, authenticated;

-- Realtime untuk daftar pengumuman (opsional, aman diulang).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;

commit;

-- =====================================================================
-- ROLLBACK (jalankan manual kalau perlu membatalkan):
--   drop trigger if exists zz_announcement_notify on public.announcements;
--   drop table if exists public.announcement_reads, public.announcements cascade;
--   delete from public.role_permissions where menu_id in ('pengumuman','pengumuman-kelola');
--   delete from public.role_permission_defaults where menu_id in ('pengumuman','pengumuman-kelola');
-- =====================================================================
