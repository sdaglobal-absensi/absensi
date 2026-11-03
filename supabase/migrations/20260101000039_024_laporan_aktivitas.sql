-- =====================================================================
-- 024 — LAPORAN AKTIVITAS HARIAN
--
-- Karyawan mengisi laporan aktivitas harian sesuai TEMPLATE jabatannya
-- (HR Admin, GA, Security, Cleaning Service, Koordinator, dst). HR/admin melihat
-- rekap siapa yang sudah/belum mengisi, membaca laporan, dan menandai "ditinjau".
--
-- Tabel:
--   daily_report_templates    template laporan (daftar bagian & baris bawaan, JSON)
--   daily_report_assignments  template mana yang dipakai tiap karyawan (1 karyawan = 1 template)
--   daily_reports             laporan per karyawan per tanggal. Menyimpan SALINAN template
--                             (template_snapshot) supaya laporan lama tetap utuh walau template diubah.
--
-- Menu: 'laporan-aktivitas' (karyawan mengisi) dan 'laporan-aktivitas-kelola' (HR).
-- Fitur paket: 'laporan_aktivitas'.
--
-- Jalankan SETELAH 023. Aman dijalankan ulang (idempotent).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.daily_report_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default public.current_tenant_id()
              references public.tenants(id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 100),
  description text check (description is null or length(description) <= 300),
  wajib       boolean not null default true,     -- wajib diisi tiap hari kerja (yang belum isi ditandai di rekap)
  is_active   boolean not null default true,
  sections    jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  created_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists uq_daily_report_templates_name
  on public.daily_report_templates (tenant_id, lower(name));

create table if not exists public.daily_report_assignments (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  tenant_id   uuid not null default public.current_tenant_id()
              references public.tenants(id) on delete restrict,
  template_id uuid not null references public.daily_report_templates(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists idx_daily_report_assignments_tpl on public.daily_report_assignments (template_id);

create table if not exists public.daily_reports (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default public.current_tenant_id()
                    references public.tenants(id) on delete restrict,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  template_id       uuid references public.daily_report_templates(id) on delete set null,
  report_date       date not null,
  status            text not null default 'draft' check (status in ('draft', 'submitted')),
  template_snapshot jsonb not null,    -- { name, sections } saat laporan dibuat
  data              jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  submitted_at      timestamptz,
  reviewed_by       uuid references public.profiles(id) on delete set null,
  reviewed_at       timestamptz,
  review_note       text check (review_note is null or length(review_note) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, report_date)
);
create index if not exists idx_daily_reports_date on public.daily_reports (tenant_id, report_date desc);

comment on table public.daily_report_templates is 'Template Laporan Aktivitas Harian: sections = [{key, kind, title, preset[], blank_rows}].';
comment on table public.daily_reports is 'Laporan aktivitas harian per karyawan per tanggal. Setelah reviewed_at terisi, laporan terkunci untuk karyawan.';

drop trigger if exists aa_tenant_immutable on public.daily_report_templates;
create trigger aa_tenant_immutable before update on public.daily_report_templates
  for each row execute function public.tg_tenant_immutable();
drop trigger if exists aa_tenant_immutable on public.daily_report_assignments;
create trigger aa_tenant_immutable before update on public.daily_report_assignments
  for each row execute function public.tg_tenant_immutable();
drop trigger if exists aa_tenant_immutable on public.daily_reports;
create trigger aa_tenant_immutable before update on public.daily_reports
  for each row execute function public.tg_tenant_immutable();

create or replace function public.daily_reports_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_daily_reports_touch on public.daily_reports;
create trigger trg_daily_reports_touch before update on public.daily_reports
  for each row execute function public.daily_reports_touch();
drop trigger if exists trg_daily_report_templates_touch on public.daily_report_templates;
create trigger trg_daily_report_templates_touch before update on public.daily_report_templates
  for each row execute function public.daily_reports_touch();

-- ---------------------------------------------------------------------
-- 2. PENJAGA LAPORAN
--    - Karyawan hanya mengisi laporannya sendiri, untuk 7 hari terakhir (jam WIB,
--      toleransi +1 hari), dan tidak bisa menyentuh kolom tinjauan.
--    - Setelah ditinjau (reviewed_at), laporan terkunci untuk karyawan.
--    - Peninjau (HR) hanya boleh mengubah kolom tinjauan, bukan isi laporan.
--    auth.uid() NULL (SQL editor / service role) diizinkan.
-- ---------------------------------------------------------------------
create or replace function public.daily_reports_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  if v_uid is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.reviewed_at is not null or new.reviewed_by is not null or new.review_note is not null then
      raise exception 'Kolom tinjauan tidak boleh diisi saat membuat laporan.';
    end if;
    if new.report_date > v_today + 1 or new.report_date < v_today - 7 then
      raise exception 'Laporan hanya bisa diisi untuk 7 hari terakhir.';
    end if;
    return new;
  end if;

  -- UPDATE
  if v_uid = old.user_id then
    if old.reviewed_at is not null then
      raise exception 'Laporan sudah ditinjau dan tidak bisa diubah lagi.';
    end if;
    if new.user_id <> old.user_id or new.report_date <> old.report_date
       or new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at
       or new.review_note is distinct from old.review_note then
      raise exception 'Kolom ini tidak bisa diubah.';
    end if;
    return new;
  end if;

  if public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola') then
    if new.user_id <> old.user_id or new.report_date <> old.report_date
       or new.status is distinct from old.status
       or new.data is distinct from old.data
       or new.template_snapshot is distinct from old.template_snapshot
       or new.template_id is distinct from old.template_id
       or new.submitted_at is distinct from old.submitted_at then
      raise exception 'Peninjau hanya boleh mengubah catatan tinjauan, bukan isi laporan.';
    end if;
    return new;
  end if;

  raise exception 'Tidak berwenang mengubah laporan ini.';
end;
$$;

drop trigger if exists trg_daily_reports_guard on public.daily_reports;
create trigger trg_daily_reports_guard before insert or update on public.daily_reports
  for each row execute function public.daily_reports_guard();

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.daily_report_templates   enable row level security;
alter table public.daily_report_assignments enable row level security;
alter table public.daily_reports            enable row level security;

drop policy if exists tenant_isolation on public.daily_report_templates;
create policy tenant_isolation on public.daily_report_templates as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.daily_report_assignments;
create policy tenant_isolation on public.daily_report_assignments as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.daily_reports;
create policy tenant_isolation on public.daily_reports as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.daily_report_templates;
create policy feature_gate on public.daily_report_templates as restrictive for all to authenticated
  using ((select public.tenant_has_feature('laporan_aktivitas')))
  with check ((select public.tenant_has_feature('laporan_aktivitas')));
drop policy if exists feature_gate on public.daily_report_assignments;
create policy feature_gate on public.daily_report_assignments as restrictive for all to authenticated
  using ((select public.tenant_has_feature('laporan_aktivitas')))
  with check ((select public.tenant_has_feature('laporan_aktivitas')));
drop policy if exists feature_gate on public.daily_reports;
create policy feature_gate on public.daily_reports as restrictive for all to authenticated
  using ((select public.tenant_has_feature('laporan_aktivitas')))
  with check ((select public.tenant_has_feature('laporan_aktivitas')));

-- Template: semua orang di tenant boleh membaca (isinya bukan data sensitif);
-- hanya pengelola yang boleh mengubah.
drop policy if exists drt_select on public.daily_report_templates;
create policy drt_select on public.daily_report_templates for select to authenticated using (true);
drop policy if exists drt_write on public.daily_report_templates;
create policy drt_write on public.daily_report_templates for all
  using (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola'))
  with check (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola'));

-- Penugasan template: karyawan hanya melihat miliknya; pengelola semuanya.
drop policy if exists dra_select on public.daily_report_assignments;
create policy dra_select on public.daily_report_assignments for select
  using (user_id = auth.uid() or (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola')));
drop policy if exists dra_write on public.daily_report_assignments;
create policy dra_write on public.daily_report_assignments for all
  using (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola'))
  with check (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola'));

-- Laporan: pemilik & pengelola membaca; hanya pemilik membuat; pemilik/pengelola
-- mengubah (isi vs tinjauan dibedakan oleh trigger di atas).
drop policy if exists dr_select on public.daily_reports;
create policy dr_select on public.daily_reports for select
  using (user_id = auth.uid() or (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola')));
drop policy if exists dr_insert on public.daily_reports;
create policy dr_insert on public.daily_reports for insert
  with check (user_id = auth.uid());
drop policy if exists dr_update on public.daily_reports;
create policy dr_update on public.daily_reports for update
  using (user_id = auth.uid() or (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola')))
  with check (user_id = auth.uid() or (public.is_staff() and public.has_menu_access('laporan-aktivitas-kelola')));
drop policy if exists dr_delete on public.daily_reports;
create policy dr_delete on public.daily_reports for delete
  using ((user_id = auth.uid() and status = 'draft' and reviewed_at is null) or public.is_super());

-- ---------------------------------------------------------------------
-- 4. GERBANG PAKET + HAK MENU
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('laporan_aktivitas', 'Laporan Aktivitas Harian',
   'Karyawan mengisi laporan aktivitas harian sesuai template jabatan; HR melihat rekap dan menandai ditinjau', '{}', 62)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('laporan-aktivitas', 'laporan_aktivitas'), ('laporan-aktivitas-kelola', 'laporan_aktivitas')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['laporan_aktivitas']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('laporan_aktivitas' = any(features));

-- 'laporan-aktivitas' (mengisi) terbuka untuk semua role; 'laporan-aktivitas-kelola'
-- (rekap, template, tinjauan) untuk Super Admin HR dan Admin HR.
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'laporan-aktivitas', true),  ('admin_hr', 'laporan-aktivitas', true),
  ('admin_approval', 'laporan-aktivitas', true),  ('karyawan', 'laporan-aktivitas', true),
  ('super_admin_hr', 'laporan-aktivitas-kelola', true),  ('admin_hr', 'laporan-aktivitas-kelola', true),
  ('admin_approval', 'laporan-aktivitas-kelola', false), ('karyawan', 'laporan-aktivitas-kelola', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('laporan-aktivitas', 'laporan-aktivitas-kelola')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): versi 023 + 'laporan-aktivitas'.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse','dokumen','tukar-shift','kpi-saya','thr-saya','laporan-aktivitas'];
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

commit;

-- =====================================================================
-- ROLLBACK (manual):
--   drop table if exists public.daily_reports, public.daily_report_assignments, public.daily_report_templates cascade;
--   drop function if exists public.daily_reports_guard();
--   drop function if exists public.daily_reports_touch();
--   delete from public.role_permissions where menu_id in ('laporan-aktivitas','laporan-aktivitas-kelola');
--   delete from public.role_permission_defaults where menu_id in ('laporan-aktivitas','laporan-aktivitas-kelola');
--   delete from public.menu_features where menu_id in ('laporan-aktivitas','laporan-aktivitas-kelola');
--   update public.plans set features = array_remove(features, 'laporan_aktivitas');
--   delete from public.feature_catalog where kode = 'laporan_aktivitas';
--   -- lalu jalankan ulang fungsi seed_tenant_template di 023 (tanpa 'laporan-aktivitas')
-- =====================================================================
