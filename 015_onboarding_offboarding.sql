-- =====================================================================
-- PRIORITAS MENENGAH #8 — ONBOARDING & OFFBOARDING
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-014. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. HR memilih karyawan + jenis (onboarding / offboarding) -> server membuat
--      checklist dari "template tugas" milik usaha itu (bisa diedit HR).
--   2. HR mencentang tugas satu per satu, memberi catatan, atau menambah/
--      menghapus tugas khusus untuk karyawan itu saja.
--   3. Semua tugas tercentang -> checklist otomatis 'selesai'. Kalau ada
--      yang dibuka lagi -> kembali 'berjalan'.
--   Template bawaan diisi otomatis saat pertama dipakai (ensure_checklist_templates).
--
-- Paket : fitur baru 'onboarding' -> Bisnis, Enterprise, Internal.
-- Hak   : menu 'onboarding-kelola' -> Super Admin HR & Admin HR (Super Admin
--         selalu bisa). Karyawan biasa tidak melihat checklist ini.
-- Catatan: checklist TIDAK mengubah data karyawan secara otomatis (tidak
--          menonaktifkan akun sendiri) -- HR tetap melakukannya di Data Karyawan.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.checklist_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default public.current_tenant_id()
             references public.tenants(id) on delete restrict,
  kind       text not null check (kind in ('onboarding', 'offboarding')),
  title      text not null check (length(btrim(title)) between 1 and 200),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_cltpl_tenant on public.checklist_templates (tenant_id, kind, sort_order);

create table if not exists public.employee_checklists (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id()
               references public.tenants(id) on delete restrict,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('onboarding', 'offboarding')),
  target_date  date,                       -- tanggal masuk / tanggal resign
  status       text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_emp_cl_tenant on public.employee_checklists (tenant_id, status, created_at desc);
-- Satu checklist berjalan per karyawan per jenis.
create unique index if not exists uq_emp_cl_open on public.employee_checklists (user_id, kind) where status = 'open';

create table if not exists public.employee_checklist_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete restrict,
  checklist_id uuid not null references public.employee_checklists(id) on delete cascade,
  title        text not null check (length(btrim(title)) between 1 and 200),
  sort_order   integer not null default 0,
  is_done      boolean not null default false,
  done_by      uuid references public.profiles(id) on delete set null,
  done_at      timestamptz,
  notes        text check (notes is null or length(notes) <= 500),
  is_custom    boolean not null default false
);
create index if not exists idx_cl_items_cl on public.employee_checklist_items (checklist_id, sort_order);

drop trigger if exists aa_tenant_immutable on public.checklist_templates;
create trigger aa_tenant_immutable before update on public.checklist_templates
  for each row execute function public.tg_tenant_immutable();
drop trigger if exists aa_tenant_immutable on public.employee_checklists;
create trigger aa_tenant_immutable before update on public.employee_checklists
  for each row execute function public.tg_tenant_immutable();
drop trigger if exists aa_tenant_immutable on public.employee_checklist_items;
create trigger aa_tenant_immutable before update on public.employee_checklist_items
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. GERBANG PAKET (fitur 'onboarding')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('onboarding', 'Onboarding & Offboarding',
   'Checklist tugas saat karyawan baru masuk atau resign: serah terima aset, penonaktifan akun, gaji terakhir', '{}', 60)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('onboarding-kelola', 'onboarding')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['onboarding']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('onboarding' = any(features));

-- ---------------------------------------------------------------------
-- 3. RLS (baca & kelola template langsung; checklist hanya dibaca, ditulis lewat fungsi)
-- ---------------------------------------------------------------------
alter table public.checklist_templates enable row level security;
alter table public.employee_checklists enable row level security;
alter table public.employee_checklist_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['checklist_templates', 'employee_checklists', 'employee_checklist_items'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all
      using (tenant_id = (select public.current_tenant_id()))
      with check (tenant_id = (select public.current_tenant_id()))$p$, t);
    execute format('drop policy if exists feature_gate on public.%I', t);
    execute format($p$create policy feature_gate on public.%I as restrictive for all to authenticated
      using ((select public.tenant_has_feature('onboarding')))
      with check ((select public.tenant_has_feature('onboarding')))$p$, t);
  end loop;
end $$;

drop policy if exists cltpl_manage on public.checklist_templates;
create policy cltpl_manage on public.checklist_templates for all
  using (public.has_menu_access('onboarding-kelola'))
  with check (public.has_menu_access('onboarding-kelola'));

drop policy if exists emp_cl_read on public.employee_checklists;
create policy emp_cl_read on public.employee_checklists for select
  using (public.has_menu_access('onboarding-kelola'));

drop policy if exists emp_cl_items_read on public.employee_checklist_items;
create policy emp_cl_items_read on public.employee_checklist_items for select
  using (public.has_menu_access('onboarding-kelola'));

-- ---------------------------------------------------------------------
-- 4. FUNGSI
-- ---------------------------------------------------------------------
-- Template bawaan, diisi sekali kalau usaha ini belum punya template sama sekali.
create or replace function public.ensure_checklist_templates()
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  if exists (select 1 from public.checklist_templates where tenant_id = v_tenant) then
    return;
  end if;
  insert into public.checklist_templates (tenant_id, kind, title, sort_order)
  select v_tenant, 'onboarding', t.title, t.ord from (values
    (1, 'Lengkapi data diri & biodata karyawan di sistem'),
    (2, 'Kumpulkan & unggah dokumen (KTP, KK, NPWP, ijazah) di Dokumen Karyawan'),
    (3, 'Tanda tangan kontrak kerja & unggah ke Dokumen Karyawan'),
    (4, 'Daftarkan BPJS Kesehatan & Ketenagakerjaan'),
    (5, 'Atur jadwal kerja, lokasi kantor, dan atasan (struktur organisasi)'),
    (6, 'Isi kuota cuti tahunan'),
    (7, 'Buat akun & sampaikan akses login ke karyawan'),
    (8, 'Serah terima aset / perlengkapan (laptop, seragam, ID card)'),
    (9, 'Perkenalan tim & orientasi hari pertama')
  ) as t(ord, title)
  union all
  select v_tenant, 'offboarding', t.title, t.ord from (values
    (1, 'Terima surat pengunduran diri & sepakati tanggal resign terakhir'),
    (2, 'Isi tanggal resign di Data Karyawan'),
    (3, 'Serah terima pekerjaan ke pengganti / atasan'),
    (4, 'Kembalikan aset (laptop, seragam, ID card, kunci)'),
    (5, 'Selesaikan kasbon / pinjaman yang masih berjalan'),
    (6, 'Hitung gaji terakhir (gaji prorata, lembur, sisa cuti, potongan)'),
    (7, 'Exit interview'),
    (8, 'Nonaktifkan akun karyawan di Data Karyawan'),
    (9, 'Terbitkan surat paklaring / keterangan kerja')
  ) as t(ord, title);
end;
$$;
revoke execute on function public.ensure_checklist_templates() from public, anon;
grant execute on function public.ensure_checklist_templates() to authenticated;

-- Hitung ulang status checklist dari item-itemnya.
create or replace function public._checklist_recalc(p_checklist uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_total integer; v_done integer;
begin
  select count(*), count(*) filter (where is_done) into v_total, v_done
    from public.employee_checklist_items where checklist_id = p_checklist;
  update public.employee_checklists
     set status = case when v_total > 0 and v_done = v_total then 'done' else 'open' end,
         completed_at = case when v_total > 0 and v_done = v_total then coalesce(completed_at, now()) else null end
   where id = p_checklist and status in ('open', 'done');
end;
$$;
revoke execute on function public._checklist_recalc(uuid) from public, anon, authenticated;

create or replace function public.start_checklist(p_user uuid, p_kind text, p_target date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  if p_kind not in ('onboarding', 'offboarding') then
    raise exception 'Jenis checklist tidak dikenal';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and tenant_id = v_tenant) then
    raise exception 'Karyawan tidak ditemukan';
  end if;
  if exists (select 1 from public.employee_checklists where user_id = p_user and kind = p_kind and status = 'open') then
    raise exception 'Karyawan ini sudah punya checklist % yang masih berjalan', p_kind;
  end if;

  perform public.ensure_checklist_templates();

  insert into public.employee_checklists (tenant_id, user_id, kind, target_date)
  values (v_tenant, p_user, p_kind, p_target)
  returning id into v_id;

  insert into public.employee_checklist_items (tenant_id, checklist_id, title, sort_order)
  select v_tenant, v_id, title, sort_order
    from public.checklist_templates
   where tenant_id = v_tenant and kind = p_kind and is_active
   order by sort_order, created_at;

  return v_id;
end;
$$;
revoke execute on function public.start_checklist(uuid, text, date) from public, anon;
grant execute on function public.start_checklist(uuid, text, date) to authenticated;

create or replace function public.toggle_checklist_item(p_item uuid, p_done boolean, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_cl uuid; v_status text;
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  select i.checklist_id, c.status into v_cl, v_status
    from public.employee_checklist_items i
    join public.employee_checklists c on c.id = i.checklist_id
   where i.id = p_item and i.tenant_id = public.current_tenant_id();
  if v_cl is null then raise exception 'Tugas tidak ditemukan'; end if;
  if v_status = 'cancelled' then raise exception 'Checklist ini sudah dibatalkan'; end if;

  update public.employee_checklist_items
     set is_done = p_done,
         done_by = case when p_done then coalesce(case when is_done then done_by end, auth.uid()) else null end,
         done_at = case when p_done then coalesce(case when is_done then done_at end, now()) else null end,
         notes = nullif(btrim(coalesce(p_notes, notes, '')), '')
   where id = p_item;
  perform public._checklist_recalc(v_cl);
end;
$$;
revoke execute on function public.toggle_checklist_item(uuid, boolean, text) from public, anon;
grant execute on function public.toggle_checklist_item(uuid, boolean, text) to authenticated;

create or replace function public.add_checklist_item(p_checklist uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); v_status text;
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  select status into v_status from public.employee_checklists where id = p_checklist and tenant_id = v_tenant;
  if v_status is null then raise exception 'Checklist tidak ditemukan'; end if;
  if v_status = 'cancelled' then raise exception 'Checklist ini sudah dibatalkan'; end if;
  insert into public.employee_checklist_items (tenant_id, checklist_id, title, sort_order, is_custom)
  select v_tenant, p_checklist, btrim(p_title), coalesce(max(sort_order), 0) + 1, true
    from public.employee_checklist_items where checklist_id = p_checklist;
  perform public._checklist_recalc(p_checklist);
end;
$$;
revoke execute on function public.add_checklist_item(uuid, text) from public, anon;
grant execute on function public.add_checklist_item(uuid, text) to authenticated;

create or replace function public.remove_checklist_item(p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_cl uuid;
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  delete from public.employee_checklist_items
   where id = p_item and tenant_id = public.current_tenant_id()
   returning checklist_id into v_cl;
  if v_cl is not null then perform public._checklist_recalc(v_cl); end if;
end;
$$;
revoke execute on function public.remove_checklist_item(uuid) from public, anon;
grant execute on function public.remove_checklist_item(uuid) to authenticated;

create or replace function public.cancel_checklist(p_checklist uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_menu_access('onboarding-kelola') then
    raise exception 'Tidak punya akses ke Onboarding & Offboarding';
  end if;
  update public.employee_checklists set status = 'cancelled'
   where id = p_checklist and tenant_id = public.current_tenant_id() and status in ('open', 'done');
end;
$$;
revoke execute on function public.cancel_checklist(uuid) from public, anon;
grant execute on function public.cancel_checklist(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. HAK MENU
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'onboarding-kelola', true), ('admin_hr', 'onboarding-kelola', true),
  ('admin_approval', 'onboarding-kelola', false), ('karyawan', 'onboarding-kelola', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id = 'onboarding-kelola'
on conflict (tenant_id, role, menu_id) do nothing;

commit;

-- =====================================================================
-- ROLLBACK (manual):
--   drop table if exists public.employee_checklist_items, public.employee_checklists, public.checklist_templates cascade;
--   drop function if exists public.ensure_checklist_templates(), public._checklist_recalc(uuid),
--     public.start_checklist(uuid, text, date), public.toggle_checklist_item(uuid, boolean, text),
--     public.add_checklist_item(uuid, text), public.remove_checklist_item(uuid), public.cancel_checklist(uuid);
--   delete from public.role_permissions where menu_id = 'onboarding-kelola';
--   delete from public.role_permission_defaults where menu_id = 'onboarding-kelola';
--   delete from public.menu_features where menu_id = 'onboarding-kelola';
--   update public.plans set features = array_remove(features, 'onboarding');
--   delete from public.feature_catalog where kode = 'onboarding';
-- =====================================================================
