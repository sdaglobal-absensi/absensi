-- =====================================================================
-- PRIORITAS TINGGI #2 — DINAS LUAR / WFH / KUNJUNGAN
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-008. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. Karyawan mengajukan dinas luar / WFH / kunjungan (rentang tanggal).
--   2. Atasan (rantai approval unit, jumlah tingkat = pengaturan approval
--      'izin' usaha itu) menyetujui / menolak. Memakai tabel approval
--      SENDIRI, jadi fungsi approval izin/lembur/koreksi TIDAK disentuh.
--   3. Absen yang dikirim pada tanggal yang tercakup pengajuan DISETUJUI
--      otomatis ditandai (attendance.field_work_id & work_mode) oleh trigger
--      di server -> absen di luar radius dianggap sah, tanpa tinjau manual.
--
-- Paket: fitur dasar (tidak ada di feature_catalog), aktif di semua paket.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.field_work_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default public.current_tenant_id()
                references public.tenants(id) on delete restrict,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('dinas_luar', 'wfh', 'kunjungan')),
  start_date  date not null,
  end_date    date not null,
  destination text,
  reason      text not null check (length(btrim(reason)) > 0),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 31)
);
create index if not exists idx_fwr_tenant_user on public.field_work_requests (tenant_id, user_id, start_date);
create index if not exists idx_fwr_status on public.field_work_requests (tenant_id, status);

create table if not exists public.field_work_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete restrict,
  request_id     uuid not null references public.field_work_requests(id) on delete cascade,
  step_order     integer not null,
  approver_ids   uuid[] not null,
  approver_names text,
  status         text not null default 'waiting' check (status in ('waiting', 'pending', 'approved', 'rejected')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  notes          text,
  unique (request_id, step_order)
);
create index if not exists idx_fwa_request on public.field_work_approvals (request_id);

-- Tanda pada absensi (diisi trigger, bukan klien).
alter table public.attendance add column if not exists field_work_id uuid
  references public.field_work_requests(id) on delete set null;
alter table public.attendance add column if not exists work_mode text;
alter table public.attendance drop constraint if exists attendance_work_mode_check;
alter table public.attendance add constraint attendance_work_mode_check
  check (work_mode is null or work_mode in ('dinas_luar', 'wfh', 'kunjungan'));

drop trigger if exists aa_tenant_immutable on public.field_work_requests;
create trigger aa_tenant_immutable before update on public.field_work_requests
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------
alter table public.field_work_requests enable row level security;
alter table public.field_work_approvals enable row level security;

drop policy if exists tenant_isolation on public.field_work_requests;
create policy tenant_isolation on public.field_work_requests as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.field_work_approvals;
create policy tenant_isolation on public.field_work_approvals as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- Karyawan: melihat & mengajukan HANYA untuk dirinya (status selalu 'pending'
-- saat dibuat). Perubahan status lewat fungsi di bawah, bukan update langsung.
-- Fungsi security definer (melewati RLS) supaya policy dua tabel tidak
-- saling memanggil (rekursi tak hingga).
create or replace function public.fw_is_approver(p_req uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.field_work_approvals a
                  where a.request_id = p_req and auth.uid() = any (a.approver_ids));
$$;
create or replace function public.fw_is_owner(p_req uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.field_work_requests r
                  where r.id = p_req and r.user_id = auth.uid());
$$;
grant execute on function public.fw_is_approver(uuid) to authenticated;
grant execute on function public.fw_is_owner(uuid) to authenticated;

drop policy if exists fwr_select on public.field_work_requests;
create policy fwr_select on public.field_work_requests for select
  using (
    user_id = auth.uid()
    or public.is_super()
    or public.has_menu_access('dinas-luar-approval')
    or public.fw_is_approver(id)
  );
drop policy if exists fwr_insert on public.field_work_requests;
create policy fwr_insert on public.field_work_requests for insert
  with check (user_id = auth.uid() and status = 'pending' and public.has_menu_access('dinas-luar'));

drop policy if exists fwa_select on public.field_work_approvals;
create policy fwa_select on public.field_work_approvals for select
  using (
    auth.uid() = any (approver_ids)
    or public.is_super()
    or public.has_menu_access('dinas-luar-approval')
    or public.fw_is_owner(request_id)
  );

-- ---------------------------------------------------------------------
-- 3. PEMBENTUK TAHAP APPROVAL (trigger setelah pengajuan dibuat)
-- ---------------------------------------------------------------------
create or replace function public.tg_fwr_build_steps()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_levels integer;
  v_name   text;
  v_role   text;
  v_count  integer := 0;
  v_has_notify boolean := to_regprocedure('public.notify_users(uuid[],text,text,text,text,uuid)') is not null;
  r record;
begin
  select full_name, role into v_name, v_role from public.profiles where id = new.user_id;
  select coalesce((select levels from public.approval_settings
                    where tenant_id = new.tenant_id and request_type = 'izin'), 1) into v_levels;

  for r in select * from public.resolve_approval_chain(new.user_id, v_levels, 'dinas-luar-approval') loop
    insert into public.field_work_approvals (tenant_id, request_id, step_order, approver_ids, approver_names, status)
    values (new.tenant_id, new.id, r.r_step, r.r_ids, r.r_names, case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;

    if r.r_step = 1 and v_has_notify then
      perform public.notify_users(
        r.r_ids, 'field_work_needed', 'Pengajuan menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' mengajukan ' || public.field_work_label(new.kind) || '.',
        'field_work', new.id);
    end if;
  end loop;

  -- Tanpa approver: hanya Super Admin yang pengajuannya disetujui otomatis.
  if v_count = 0 and v_role = 'super_admin' then
    update public.field_work_requests
       set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
     where id = new.id;
  end if;
  return new;
end;
$$;

create or replace function public.field_work_label(p_kind text)
returns text language sql immutable as $$
  select case p_kind when 'dinas_luar' then 'Dinas Luar' when 'wfh' then 'WFH' when 'kunjungan' then 'Kunjungan' else p_kind end;
$$;

drop trigger if exists zz_fwr_build_steps on public.field_work_requests;
create trigger zz_fwr_build_steps after insert on public.field_work_requests
  for each row execute function public.tg_fwr_build_steps();

-- ---------------------------------------------------------------------
-- 4. NOTIFIKASI: perluas CHECK tabel notifications
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.notifications'::regclass and contype = 'c'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.notifications add constraint notifications_type_check
  check (type in ('approval_needed', 'approval_decided', 'announcement', 'field_work_needed', 'field_work_decided'));
alter table public.notifications add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement', 'field_work'));

-- ---------------------------------------------------------------------
-- 5. KEPUTUSAN (satu-satunya jalan menyetujui / menolak / membatalkan)
-- ---------------------------------------------------------------------
create or replace function public.decide_field_work(p_request uuid, p_decision text, p_notes text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_req  public.field_work_requests%rowtype;
  v_step public.field_work_approvals%rowtype;
  v_next integer;
  v_has_notify boolean := to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  select * into v_req from public.field_work_requests where id = p_request for update;
  if not found or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_req.status <> 'pending' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_req.user_id = auth.uid() then raise exception 'Tidak boleh memutuskan pengajuan sendiri'; end if;

  select * into v_step from public.field_work_approvals
   where request_id = p_request and status = 'pending' order by step_order limit 1 for update;

  -- Hanya approver di tahap yang sedang berjalan; Super Admin selalu boleh
  -- (jalan keluar kalau approver tidak ada / berhalangan).
  if not public.is_super() and (v_step.id is null or not (auth.uid() = any (v_step.approver_ids))) then
    raise exception 'Bukan giliran Anda untuk memutuskan pengajuan ini';
  end if;

  if v_step.id is not null then
    update public.field_work_approvals
       set status = p_decision, decided_by = auth.uid(), decided_at = now(), notes = p_notes
     where id = v_step.id;
  end if;

  if p_decision = 'rejected' then
    update public.field_work_requests
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes
     where id = p_request;
    update public.field_work_approvals set status = 'rejected'
     where request_id = p_request and status in ('waiting', 'pending') and id is distinct from v_step.id;
  else
    select min(step_order) into v_next from public.field_work_approvals
     where request_id = p_request and status = 'waiting';
    -- Super Admin yang memutuskan = langsung final (melewati sisa tahap).
    if v_next is not null and not public.is_super() then
      update public.field_work_approvals set status = 'pending' where request_id = p_request and step_order = v_next;
      if v_has_notify then
        perform public.notify_users(
          (select approver_ids from public.field_work_approvals where request_id = p_request and step_order = v_next),
          'field_work_needed', 'Pengajuan menunggu persetujuanmu',
          (select full_name from public.profiles where id = v_req.user_id) || ' mengajukan ' || public.field_work_label(v_req.kind) || '.',
          'field_work', p_request);
      end if;
      return 'pending';
    end if;
    update public.field_work_requests
       set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes
     where id = p_request;
    update public.field_work_approvals set status = 'approved'
     where request_id = p_request and status in ('waiting', 'pending');
    -- Absen yang SUDAH terlanjur masuk pada rentang ini ikut ditandai.
    perform set_config('kerjora.fw_sync', '1', true);
    update public.attendance a
       set field_work_id = v_req.id, work_mode = v_req.kind
     where a.user_id = v_req.user_id and a.date between v_req.start_date and v_req.end_date
       and a.field_work_id is null;
    perform set_config('kerjora.fw_sync', '', true);
  end if;

  if v_has_notify then
    perform public.notify_user(
      v_req.user_id, 'field_work_decided',
      case when p_decision = 'approved' then public.field_work_label(v_req.kind) || ' disetujui' else public.field_work_label(v_req.kind) || ' ditolak' end,
      case when p_notes is not null and btrim(p_notes) <> '' then p_notes else null end,
      'field_work', p_request);
  end if;
  return p_decision;
end;
$$;
revoke execute on function public.decide_field_work(uuid, text, text) from public, anon;
grant execute on function public.decide_field_work(uuid, text, text) to authenticated;

-- Pemohon membatalkan pengajuannya sendiri (selama belum diputuskan, atau
-- sudah disetujui tapi belum dimulai).
create or replace function public.cancel_field_work(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_req public.field_work_requests%rowtype;
begin
  select * into v_req from public.field_work_requests where id = p_request for update;
  if not found or v_req.user_id <> auth.uid() or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_req.status = 'pending' or (v_req.status = 'approved' and v_req.start_date > current_date) then
    update public.field_work_requests set status = 'cancelled', reviewed_at = now() where id = p_request;
    update public.field_work_approvals set status = 'rejected'
     where request_id = p_request and status in ('waiting', 'pending');
  else
    raise exception 'Pengajuan ini tidak bisa dibatalkan';
  end if;
end;
$$;
revoke execute on function public.cancel_field_work(uuid) from public, anon;
grant execute on function public.cancel_field_work(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. ABSEN OTOMATIS TERTANDAI (server, bukan klien)
-- ---------------------------------------------------------------------
create or replace function public.tg_attendance_field_work()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_kind text;
begin
  select id, kind into v_id, v_kind
    from public.field_work_requests
   where user_id = new.user_id and tenant_id = new.tenant_id and status = 'approved'
     and new.date between start_date and end_date
   order by created_at desc limit 1;
  new.field_work_id := v_id;
  new.work_mode := v_kind;
  return new;
end;
$$;
drop trigger if exists ac_attendance_field_work on public.attendance;
create trigger ac_attendance_field_work before insert on public.attendance
  for each row execute function public.tg_attendance_field_work();

-- Klien tidak boleh menulis tanda ini sendiri lewat update.
create or replace function public.tg_attendance_field_work_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('kerjora.fw_sync', true), '') <> '1'
     and (
       new.field_work_id is distinct from old.field_work_id
       or new.work_mode is distinct from old.work_mode) then
    new.field_work_id := old.field_work_id;
    new.work_mode := old.work_mode;
  end if;
  return new;
end;
$$;
drop trigger if exists ac_attendance_field_work_guard on public.attendance;
create trigger ac_attendance_field_work_guard before update on public.attendance
  for each row execute function public.tg_attendance_field_work_guard();

-- Dipakai halaman Absensi: apakah hari ini ada dinas luar yang disetujui?
create or replace function public.my_field_work_today(p_date date default current_date)
returns table (id uuid, kind text, destination text, start_date date, end_date date)
language sql security definer stable set search_path = public as $$
  select r.id, r.kind, r.destination, r.start_date, r.end_date
    from public.field_work_requests r
   where r.user_id = auth.uid() and r.tenant_id = public.current_tenant_id()
     and r.status = 'approved' and p_date between r.start_date and r.end_date
   order by r.created_at desc limit 1;
$$;
grant execute on function public.my_field_work_today(date) to authenticated;

-- ---------------------------------------------------------------------
-- 7. HAK MENU
--    dinas-luar          : semua role (pengajuan pribadi)
--    dinas-luar-approval : Admin HR, Super Admin HR, Admin approval
--                          (karyawan mati; Super Admin selalu lolos)
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'dinas-luar', true), ('admin_hr', 'dinas-luar', true),
  ('admin_approval', 'dinas-luar', true), ('karyawan', 'dinas-luar', true),
  ('super_admin_hr', 'dinas-luar-approval', true), ('admin_hr', 'dinas-luar-approval', true),
  ('admin_approval', 'dinas-luar-approval', true), ('karyawan', 'dinas-luar-approval', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('dinas-luar', 'dinas-luar-approval')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): tambahkan 'dinas-luar' ke menu pribadi karyawan.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar'];
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
--   drop trigger if exists ac_attendance_field_work on public.attendance;
--   drop trigger if exists ac_attendance_field_work_guard on public.attendance;
--   alter table public.attendance drop column if exists field_work_id, drop column if exists work_mode;
--   drop table if exists public.field_work_approvals, public.field_work_requests cascade;
--   delete from public.role_permissions where menu_id in ('dinas-luar','dinas-luar-approval');
--   delete from public.role_permission_defaults where menu_id in ('dinas-luar','dinas-luar-approval');
-- =====================================================================
