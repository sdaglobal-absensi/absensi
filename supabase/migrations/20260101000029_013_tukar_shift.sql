-- =====================================================================
-- PRIORITAS MENENGAH #6 — TUKAR SHIFT / GANTI JADWAL
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-012. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. Karyawan A mengajukan tukar jadwal untuk SATU tanggal dengan
--      karyawan B (jadwal A dan B ditukar pada tanggal itu saja).
--   2. B harus menerima dulu. Kalau B menolak, pengajuan selesai.
--   3. Setelah B menerima, atasan A menyetujui lewat rantai approval unit
--      (jumlah tingkat = pengaturan approval 'izin'). Tabel approval SENDIRI.
--   4. Saat disetujui, server mengisi tabel schedule_overrides: pada tanggal
--      itu A memakai jadwal B dan B memakai jadwal A. Jadwal dasar di
--      profil (profiles.schedule_id) TIDAK diubah.
--
-- Syarat: A dan B sama-sama punya jadwal kerja dan jadwalnya berbeda.
-- Paket: fitur baru 'tukar_shift' (butuh 'izin_cuti') -> Bisnis, Enterprise, Internal.
-- Hak menu: tukar-shift (semua role), tukar-shift-approval (Admin HR, Super Admin HR,
--           Admin approval).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.shift_swaps (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default public.current_tenant_id()
                        references public.tenants(id) on delete restrict,
  requester_id          uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  partner_id            uuid not null references public.profiles(id) on delete cascade,
  swap_date             date not null,
  requester_name        text,
  partner_name          text,
  requester_schedule_id uuid references public.work_schedules(id) on delete set null,
  partner_schedule_id   uuid references public.work_schedules(id) on delete set null,
  reason                text not null check (length(btrim(reason)) between 1 and 500),
  status                text not null default 'pending_partner'
                        check (status in ('pending_partner', 'pending', 'approved', 'rejected', 'declined', 'cancelled')),
  partner_responded_at  timestamptz,
  reviewed_by           uuid references public.profiles(id) on delete set null,
  reviewed_at           timestamptz,
  review_notes          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint shift_swaps_diff_chk check (requester_id <> partner_id)
);
create index if not exists idx_swaps_tenant_status on public.shift_swaps (tenant_id, status, swap_date);
create index if not exists idx_swaps_requester on public.shift_swaps (requester_id, created_at desc);
create index if not exists idx_swaps_partner on public.shift_swaps (partner_id, created_at desc);

create table if not exists public.shift_swap_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete restrict,
  swap_id        uuid not null references public.shift_swaps(id) on delete cascade,
  step_order     integer not null,
  approver_ids   uuid[] not null,
  approver_names text,
  status         text not null default 'waiting' check (status in ('waiting', 'pending', 'approved', 'rejected')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  notes          text,
  unique (swap_id, step_order)
);
create index if not exists idx_swap_appr_swap on public.shift_swap_approvals (swap_id);

-- Jadwal yang berlaku KHUSUS pada satu tanggal (menimpa profiles.schedule_id).
-- Hanya diisi/dihapus oleh fungsi server.
create table if not exists public.schedule_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  schedule_id uuid not null references public.work_schedules(id) on delete cascade,
  swap_id     uuid references public.shift_swaps(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (user_id, work_date)
);
create index if not exists idx_override_tenant_date on public.schedule_overrides (tenant_id, work_date);

comment on table public.schedule_overrides is
  'Jadwal kerja per tanggal yang menimpa jadwal dasar karyawan (hasil tukar shift disetujui).';

drop trigger if exists aa_tenant_immutable on public.shift_swaps;
create trigger aa_tenant_immutable before update on public.shift_swaps
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. GERBANG PAKET (fitur 'tukar_shift', butuh 'izin_cuti')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('tukar_shift', 'Tukar Shift / Ganti Jadwal',
   'Dua karyawan bertukar jadwal pada tanggal tertentu dengan persetujuan rekan dan atasan', '{izin_cuti}', 58)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('tukar-shift', 'tukar_shift'), ('tukar-shift-approval', 'tukar_shift')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['tukar_shift']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('tukar_shift' = any(features));

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.shift_swaps enable row level security;
alter table public.shift_swap_approvals enable row level security;
alter table public.schedule_overrides enable row level security;

drop policy if exists tenant_isolation on public.shift_swaps;
create policy tenant_isolation on public.shift_swaps as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.shift_swap_approvals;
create policy tenant_isolation on public.shift_swap_approvals as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.schedule_overrides;
create policy tenant_isolation on public.schedule_overrides as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.shift_swaps;
create policy feature_gate on public.shift_swaps as restrictive for all to authenticated
  using ((select public.tenant_has_feature('tukar_shift')))
  with check ((select public.tenant_has_feature('tukar_shift')));
drop policy if exists feature_gate on public.shift_swap_approvals;
create policy feature_gate on public.shift_swap_approvals as restrictive for all to authenticated
  using ((select public.tenant_has_feature('tukar_shift')))
  with check ((select public.tenant_has_feature('tukar_shift')));
-- schedule_overrides sengaja TANPA feature_gate: kalau paket turun, jadwal yang
-- sudah disetujui tetap dihormati oleh absensi.

create or replace function public.swap_is_approver(p_swap uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shift_swap_approvals a
                  where a.swap_id = p_swap and auth.uid() = any (a.approver_ids));
$$;
create or replace function public.swap_is_party(p_swap uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shift_swaps s
                  where s.id = p_swap and auth.uid() in (s.requester_id, s.partner_id));
$$;
grant execute on function public.swap_is_approver(uuid) to authenticated;
grant execute on function public.swap_is_party(uuid) to authenticated;

drop policy if exists swaps_select on public.shift_swaps;
create policy swaps_select on public.shift_swaps for select
  using (
    requester_id = auth.uid() or partner_id = auth.uid()
    or public.is_super()
    or public.has_menu_access('tukar-shift-approval')
    or public.swap_is_approver(id)
  );
-- Pengajuan baru: hanya lewat INSERT sendiri; semua perubahan status lewat fungsi server.
drop policy if exists swaps_insert on public.shift_swaps;
create policy swaps_insert on public.shift_swaps for insert
  with check (
    requester_id = auth.uid() and status = 'pending_partner'
    and public.has_menu_access('tukar-shift')
  );

drop policy if exists swap_appr_select on public.shift_swap_approvals;
create policy swap_appr_select on public.shift_swap_approvals for select
  using (
    auth.uid() = any (approver_ids)
    or public.is_super()
    or public.has_menu_access('tukar-shift-approval')
    or public.swap_is_party(swap_id)
  );

-- Jadwal penimpa: terbaca oleh pemiliknya, staf, dan pemegang menu yang
-- menilai absensi/gaji. Tidak ada policy tulis (hanya fungsi server).
drop policy if exists override_select on public.schedule_overrides;
create policy override_select on public.schedule_overrides for select
  using (
    user_id = auth.uid()
    or public.is_staff()
    or public.has_menu_access('absensi-monitor')
    or public.has_menu_access('slip-gaji')
    or public.has_menu_access('laporan')
    or public.has_menu_access('tukar-shift-approval')
  );

-- ---------------------------------------------------------------------
-- 4. NOTIFIKASI: perluas CHECK (termasuk 009-012)
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
  check (type in ('approval_needed', 'approval_decided', 'announcement',
                  'field_work_needed', 'field_work_decided', 'loan_needed', 'loan_decided',
                  'expense_needed', 'expense_decided', 'document_expiry',
                  'swap_request', 'swap_needed', 'swap_decided'));
alter table public.notifications add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement',
                  'field_work', 'loan', 'expense', 'document', 'shift_swap'));

-- ---------------------------------------------------------------------
-- 5. VALIDASI PENGAJUAN + NOTIFIKASI KE REKAN
-- ---------------------------------------------------------------------
create or replace function public.tg_swap_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_a public.profiles%rowtype;
  v_b public.profiles%rowtype;
begin
  select * into v_a from public.profiles where id = new.requester_id;
  select * into v_b from public.profiles where id = new.partner_id;

  if v_b.id is null or v_b.tenant_id is distinct from new.tenant_id or not v_b.is_active then
    raise exception 'Rekan tukar shift tidak ditemukan di usaha ini';
  end if;
  if new.swap_date < v_today then raise exception 'Tanggal tukar shift tidak boleh di masa lalu'; end if;
  if new.swap_date > v_today + 60 then raise exception 'Tukar shift maksimal 60 hari ke depan'; end if;
  if v_a.schedule_id is null or v_b.schedule_id is null then
    raise exception 'Kedua karyawan harus punya jadwal kerja untuk tukar shift';
  end if;
  if v_a.schedule_id = v_b.schedule_id then
    raise exception 'Jadwal kalian sama, tidak perlu ditukar';
  end if;

  -- Kolom jadwal selalu diisi server (abaikan kiriman klien).
  new.requester_name := v_a.full_name;
  new.partner_name   := v_b.full_name;
  new.requester_schedule_id := v_a.schedule_id;
  new.partner_schedule_id   := v_b.schedule_id;

  if exists (select 1 from public.schedule_overrides o
              where o.work_date = new.swap_date and o.user_id in (new.requester_id, new.partner_id)) then
    raise exception 'Salah satu dari kalian sudah punya penukaran jadwal di tanggal itu';
  end if;
  if exists (select 1 from public.shift_swaps s
              where s.swap_date = new.swap_date and s.status in ('pending_partner', 'pending')
                and (s.requester_id in (new.requester_id, new.partner_id)
                     or s.partner_id in (new.requester_id, new.partner_id))) then
    raise exception 'Salah satu dari kalian masih punya pengajuan tukar shift di tanggal itu';
  end if;
  return new;
end;
$$;
drop trigger if exists ab_swap_validate on public.shift_swaps;
create trigger ab_swap_validate before insert on public.shift_swaps
  for each row execute function public.tg_swap_validate();

create or replace function public.tg_swap_notify_partner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null then
    perform public.notify_user(
      new.partner_id, 'swap_request', 'Ajakan tukar shift',
      coalesce((select full_name from public.profiles where id = new.requester_id), 'Rekan kerja')
        || ' mengajak tukar jadwal pada ' || to_char(new.swap_date, 'DD-MM-YYYY') || '.',
      'shift_swap', new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists zz_swap_notify_partner on public.shift_swaps;
create trigger zz_swap_notify_partner after insert on public.shift_swaps
  for each row execute function public.tg_swap_notify_partner();

-- ---------------------------------------------------------------------
-- 6. FINALISASI: isi jadwal penimpa
-- ---------------------------------------------------------------------
create or replace function public.swap_finalize(p_swap uuid, p_by uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_s public.shift_swaps%rowtype;
  v_a uuid;
  v_b uuid;
begin
  select * into v_s from public.shift_swaps where id = p_swap for update;

  -- Baca ulang jadwal dasar sekarang (bisa berubah sejak pengajuan).
  select schedule_id into v_a from public.profiles where id = v_s.requester_id;
  select schedule_id into v_b from public.profiles where id = v_s.partner_id;
  if v_a is null or v_b is null then
    raise exception 'Salah satu karyawan sudah tidak punya jadwal kerja';
  end if;
  if exists (select 1 from public.schedule_overrides o
              where o.work_date = v_s.swap_date and o.user_id in (v_s.requester_id, v_s.partner_id)) then
    raise exception 'Salah satu karyawan sudah punya penukaran jadwal di tanggal itu';
  end if;

  insert into public.schedule_overrides (tenant_id, user_id, work_date, schedule_id, swap_id) values
    (v_s.tenant_id, v_s.requester_id, v_s.swap_date, v_b, v_s.id),
    (v_s.tenant_id, v_s.partner_id,   v_s.swap_date, v_a, v_s.id);

  update public.shift_swaps
     set status = 'approved', requester_schedule_id = v_a, partner_schedule_id = v_b,
         reviewed_by = p_by, reviewed_at = now(), review_notes = p_notes, updated_at = now()
   where id = p_swap;
  update public.shift_swap_approvals set status = 'approved'
   where swap_id = p_swap and status in ('waiting', 'pending');
end;
$$;
revoke execute on function public.swap_finalize(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. REKAN MENERIMA / MENOLAK
-- ---------------------------------------------------------------------
create or replace function public.respond_shift_swap(p_swap uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_s public.shift_swaps%rowtype;
  v_levels integer;
  v_name text;
  v_role text;
  v_count integer := 0;
  v_has_notify boolean := to_regprocedure('public.notify_users(uuid[],text,text,text,text,uuid)') is not null;
  r record;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  select * into v_s from public.shift_swaps where id = p_swap for update;
  if not found or v_s.tenant_id is distinct from public.current_tenant_id() or v_s.partner_id <> auth.uid() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_s.status <> 'pending_partner' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_s.swap_date < (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal tukar shift sudah lewat';
  end if;

  if not p_accept then
    update public.shift_swaps
       set status = 'declined', partner_responded_at = now(), updated_at = now()
     where id = p_swap;
    if v_has_notify then
      perform public.notify_user(v_s.requester_id, 'swap_decided', 'Ajakan tukar shift ditolak rekan',
        (select full_name from public.profiles where id = v_s.partner_id) || ' tidak bisa tukar jadwal pada '
          || to_char(v_s.swap_date, 'DD-MM-YYYY') || '.', 'shift_swap', p_swap);
    end if;
    return 'declined';
  end if;

  update public.shift_swaps
     set status = 'pending', partner_responded_at = now(), updated_at = now()
   where id = p_swap;

  select full_name, role into v_name, v_role from public.profiles where id = v_s.requester_id;
  select coalesce((select levels from public.approval_settings
                    where tenant_id = v_s.tenant_id and request_type = 'izin'), 1) into v_levels;

  for r in select * from public.resolve_approval_chain(v_s.requester_id, v_levels, 'tukar-shift-approval') loop
    insert into public.shift_swap_approvals (tenant_id, swap_id, step_order, approver_ids, approver_names, status)
    values (v_s.tenant_id, p_swap, r.r_step, r.r_ids, r.r_names, case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;
    if r.r_step = 1 and v_has_notify then
      perform public.notify_users(r.r_ids, 'swap_needed', 'Tukar shift menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' dan ' || (select full_name from public.profiles where id = v_s.partner_id)
          || ' bertukar jadwal pada ' || to_char(v_s.swap_date, 'DD-MM-YYYY') || '.', 'shift_swap', p_swap);
    end if;
  end loop;

  if v_count = 0 and v_role = 'super_admin' then
    perform public.swap_finalize(p_swap, null, 'Disetujui otomatis (tidak ada approver di atasnya)');
    return 'approved';
  end if;
  return 'pending';
end;
$$;
revoke execute on function public.respond_shift_swap(uuid, boolean) from public, anon;
grant execute on function public.respond_shift_swap(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 8. KEPUTUSAN ATASAN
-- ---------------------------------------------------------------------
create or replace function public.decide_shift_swap(p_swap uuid, p_decision text, p_notes text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_s    public.shift_swaps%rowtype;
  v_step public.shift_swap_approvals%rowtype;
  v_next integer;
  v_has_notify boolean := to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null;
  v_title text;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  select * into v_s from public.shift_swaps where id = p_swap for update;
  if not found or v_s.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_s.status <> 'pending' then raise exception 'Pengajuan ini belum/sudah diproses'; end if;
  if auth.uid() in (v_s.requester_id, v_s.partner_id) then
    raise exception 'Tidak boleh memutuskan tukar shift milik sendiri';
  end if;

  select * into v_step from public.shift_swap_approvals
   where swap_id = p_swap and status = 'pending' order by step_order limit 1 for update;

  if not public.is_super() and (v_step.id is null or not (auth.uid() = any (v_step.approver_ids))) then
    raise exception 'Bukan giliran Anda untuk memutuskan pengajuan ini';
  end if;

  if v_step.id is not null then
    update public.shift_swap_approvals
       set status = p_decision, decided_by = auth.uid(), decided_at = now(), notes = p_notes
     where id = v_step.id;
  end if;

  if p_decision = 'rejected' then
    update public.shift_swaps
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes, updated_at = now()
     where id = p_swap;
    update public.shift_swap_approvals set status = 'rejected'
     where swap_id = p_swap and status in ('waiting', 'pending') and id is distinct from v_step.id;
  else
    select min(step_order) into v_next from public.shift_swap_approvals
     where swap_id = p_swap and status = 'waiting';
    if v_next is not null and not public.is_super() then
      update public.shift_swap_approvals set status = 'pending' where swap_id = p_swap and step_order = v_next;
      if to_regprocedure('public.notify_users(uuid[],text,text,text,text,uuid)') is not null then
        perform public.notify_users(
          (select approver_ids from public.shift_swap_approvals where swap_id = p_swap and step_order = v_next),
          'swap_needed', 'Tukar shift menunggu persetujuanmu',
          (select full_name from public.profiles where id = v_s.requester_id) || ' dan '
            || (select full_name from public.profiles where id = v_s.partner_id)
            || ' bertukar jadwal pada ' || to_char(v_s.swap_date, 'DD-MM-YYYY') || '.',
          'shift_swap', p_swap);
      end if;
      return 'pending';
    end if;
    perform public.swap_finalize(p_swap, auth.uid(), p_notes);
  end if;

  if v_has_notify then
    v_title := case when p_decision = 'approved' then 'Tukar shift disetujui' else 'Tukar shift ditolak' end;
    perform public.notify_user(v_s.requester_id, 'swap_decided', v_title,
      case when p_notes is not null and btrim(p_notes) <> '' then p_notes else null end, 'shift_swap', p_swap);
    perform public.notify_user(v_s.partner_id, 'swap_decided', v_title,
      case when p_notes is not null and btrim(p_notes) <> '' then p_notes else null end, 'shift_swap', p_swap);
  end if;
  return p_decision;
end;
$$;
revoke execute on function public.decide_shift_swap(uuid, text, text) from public, anon;
grant execute on function public.decide_shift_swap(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. PEMBATALAN
--    Pemohon: selagi menunggu. Pemohon / rekan / pengelola: yang sudah
--    disetujui tapi tanggalnya belum tiba (jadwal kembali normal).
-- ---------------------------------------------------------------------
create or replace function public.cancel_shift_swap(p_swap uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_s public.shift_swaps%rowtype;
  v_manager boolean := public.is_super() or public.has_menu_access('tukar-shift-approval');
begin
  select * into v_s from public.shift_swaps where id = p_swap for update;
  if not found or v_s.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;

  if v_s.status in ('pending_partner', 'pending') then
    if v_s.requester_id <> auth.uid() and not v_manager then
      raise exception 'Hanya pemohon yang bisa membatalkan';
    end if;
  elsif v_s.status = 'approved' then
    if auth.uid() not in (v_s.requester_id, v_s.partner_id) and not v_manager then
      raise exception 'Anda tidak berhak membatalkan penukaran ini';
    end if;
    if v_s.swap_date <= (now() at time zone 'Asia/Jakarta')::date then
      raise exception 'Tanggal tukar shift sudah tiba atau lewat, tidak bisa dibatalkan';
    end if;
    delete from public.schedule_overrides where swap_id = p_swap;
  else
    raise exception 'Pengajuan ini sudah selesai diproses';
  end if;

  update public.shift_swaps set status = 'cancelled', reviewed_at = now(), updated_at = now() where id = p_swap;
  update public.shift_swap_approvals set status = 'rejected' where swap_id = p_swap and status in ('waiting', 'pending');

  if to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null then
    perform public.notify_user(
      case when auth.uid() = v_s.requester_id then v_s.partner_id else v_s.requester_id end,
      'swap_decided', 'Tukar shift dibatalkan',
      'Penukaran jadwal ' || to_char(v_s.swap_date, 'DD-MM-YYYY') || ' dibatalkan.', 'shift_swap', p_swap);
  end if;
end;
$$;
revoke execute on function public.cancel_shift_swap(uuid) from public, anon;
grant execute on function public.cancel_shift_swap(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 10. DAFTAR REKAN (hanya nama & kode, untuk dropdown)
--     Karyawan biasa tidak bisa membaca profil orang lain, jadi lewat fungsi.
-- ---------------------------------------------------------------------
create or replace function public.swap_candidates()
returns table (id uuid, full_name text, employee_code text, schedule_id uuid, schedule_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.employee_code, p.schedule_id, ws.name
    from public.profiles p
    join public.work_schedules ws on ws.id = p.schedule_id
   where p.tenant_id = public.current_tenant_id()
     and p.is_active
     and p.id <> auth.uid()
     and p.schedule_id is not null
     and public.has_menu_access('tukar-shift')
   order by p.full_name;
$$;
revoke execute on function public.swap_candidates() from public, anon;
grant execute on function public.swap_candidates() to authenticated;

-- ---------------------------------------------------------------------
-- 11. HAK MENU
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'tukar-shift', true), ('admin_hr', 'tukar-shift', true),
  ('admin_approval', 'tukar-shift', true), ('karyawan', 'tukar-shift', true),
  ('super_admin_hr', 'tukar-shift-approval', true), ('admin_hr', 'tukar-shift-approval', true),
  ('admin_approval', 'tukar-shift-approval', true), ('karyawan', 'tukar-shift-approval', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('tukar-shift', 'tukar-shift-approval')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): versi 012 + 'tukar-shift'.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse','dokumen','tukar-shift'];
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
--   drop table if exists public.schedule_overrides, public.shift_swap_approvals, public.shift_swaps cascade;
--   drop function if exists public.respond_shift_swap(uuid, boolean), public.decide_shift_swap(uuid, text, text),
--     public.cancel_shift_swap(uuid), public.swap_finalize(uuid, uuid, text), public.swap_candidates(),
--     public.swap_is_approver(uuid), public.swap_is_party(uuid);
--   delete from public.role_permissions where menu_id in ('tukar-shift','tukar-shift-approval');
--   delete from public.role_permission_defaults where menu_id in ('tukar-shift','tukar-shift-approval');
--   delete from public.menu_features where menu_id in ('tukar-shift','tukar-shift-approval');
--   update public.plans set features = array_remove(features, 'tukar_shift');
--   delete from public.feature_catalog where kode = 'tukar_shift';
-- =====================================================================
