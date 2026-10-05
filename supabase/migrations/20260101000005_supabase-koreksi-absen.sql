-- =====================================================================
-- KOREKSI ABSEN — Pengajuan koreksi jika karyawan lupa absen masuk/pulang
-- Jalankan sekali di Supabase SQL Editor (aman dijalankan ulang).
--
-- Cara kerja: karyawan mengajukan koreksi untuk satu tanggal + satu jenis
-- ("masuk" atau "pulang") + jam yang seharusnya + alasan. Pengajuan lewat
-- alur approval bertingkat yang SAMA seperti Izin/Lembur (tabel
-- request_approvals, fungsi create_approval_steps/decide_approval — lihat
-- supabase-org-approval.sql). Begitu pengajuan disetujui SAMPAI TAHAP
-- TERAKHIR, jam yang diajukan otomatis diterapkan ke tabel attendance
-- (dibuatkan baris absensi kalau belum ada sama sekali, mis. karyawan
-- benar-benar tidak absen sama sekali hari itu).
--
-- Butuh supabase-schema.sql (khususnya bagian approval bertingkat / Struktur
-- Organisasi) sudah pernah dijalankan lebih dulu.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: attendance_correction_requests
-- ---------------------------------------------------------------------
create table if not exists public.attendance_correction_requests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  attendance_date  date not null,
  correction_type  text not null check (correction_type in ('masuk', 'pulang')),
  corrected_time   timestamptz not null,  -- instan absolut jam yang seharusnya (sudah dihitung sesuai zona lokasi kerja karyawan)
  reason           text not null,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  review_notes     text,
  revision_of      uuid references public.attendance_correction_requests(id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on table public.attendance_correction_requests is 'Pengajuan koreksi absen (lupa absen masuk/pulang). Satu baris = satu pengajuan untuk satu tanggal + satu jenis (masuk/pulang). Disetujui -> jam yang diajukan diterapkan otomatis ke tabel attendance.';

-- Satu pengajuan ditolak hanya boleh punya SATU revisi (sama seperti izin/lembur).
create unique index if not exists uq_koreksi_revision_of
  on public.attendance_correction_requests(revision_of) where revision_of is not null;

create index if not exists idx_koreksi_user on public.attendance_correction_requests(user_id);

-- ---------------------------------------------------------------------
-- 2. Daftarkan 'koreksi' sebagai jenis pengajuan yang sah di
--    approval_settings & request_approvals (keduanya sebelumnya hanya
--    mengizinkan izin/sakit/cuti/lembur & leave/overtime).
-- ---------------------------------------------------------------------
alter table public.approval_settings drop constraint if exists approval_settings_request_type_check;
alter table public.approval_settings add constraint approval_settings_request_type_check
  check (request_type in ('izin', 'sakit', 'cuti', 'lembur', 'koreksi'));

insert into public.approval_settings (request_type, levels) values ('koreksi', 1)
on conflict (request_type) do nothing;

alter table public.request_approvals drop constraint if exists request_approvals_request_type_check;
alter table public.request_approvals add constraint request_approvals_request_type_check
  check (request_type in ('leave', 'overtime', 'koreksi'));

-- ---------------------------------------------------------------------
-- 3. FUNGSI: apply_attendance_correction — dipanggil saat pengajuan koreksi
--    disetujui SAMPAI TAHAP TERAKHIR. Menerapkan jam yang diajukan ke
--    tabel attendance (upsert per user_id+date, sesuai kolom check_in atau
--    check_out tergantung correction_type).
-- ---------------------------------------------------------------------
create or replace function public.apply_attendance_correction(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_req public.attendance_correction_requests%rowtype;
  v_note text;
begin
  select * into v_req from public.attendance_correction_requests where id = p_request_id;
  if not found then
    raise exception 'Pengajuan koreksi tidak ditemukan';
  end if;

  v_note := 'Dikoreksi lewat pengajuan koreksi absen (' ||
    case v_req.correction_type when 'masuk' then 'check-in' else 'check-out' end || ' disetujui).';

  if v_req.correction_type = 'masuk' then
    insert into public.attendance (user_id, date, check_in, notes)
      values (v_req.user_id, v_req.attendance_date, v_req.corrected_time, v_note)
    on conflict (user_id, date) do update
      set check_in = excluded.check_in,
          notes = coalesce(public.attendance.notes || ' | ', '') || v_note;
  else
    insert into public.attendance (user_id, date, check_out, notes)
      values (v_req.user_id, v_req.attendance_date, v_req.corrected_time, v_note)
    on conflict (user_id, date) do update
      set check_out = excluded.check_out,
          notes = coalesce(public.attendance.notes || ' | ', '') || v_note;
  end if;
end;
$$;

revoke execute on function public.apply_attendance_correction(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Perluas create_approval_steps supaya auto-approve (kasus tidak ada
--    approver sama sekali, pemohon Super Admin) juga menerapkan koreksinya.
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
      elsif p_kind = 'overtime' then
        update public.overtime_requests
          set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
          where id = p_request_id;
      else
        update public.attendance_correction_requests
          set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
          where id = p_request_id;
        perform public.apply_attendance_correction(p_request_id);
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Perluas decide_approval supaya menerima kind 'koreksi', dan
--    menerapkan koreksinya ke tabel attendance begitu SEMUA tahap selesai
--    (status akhir 'approved').
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
  if p_kind not in ('leave', 'overtime', 'koreksi') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind
    when 'leave' then 'leave_requests'
    when 'overtime' then 'overtime_requests'
    else 'attendance_correction_requests'
  end;
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

    if v_final = 'approved' and p_kind = 'koreksi' then
      perform public.apply_attendance_correction(p_request_id);
    end if;
  end if;

  return v_final;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Perluas is_approver_of_user (dipakai policy "profiles_select_approver"
--    supaya approver bisa membaca nama/departemen pemohon) & policy select
--    request_approvals supaya ikut mencakup kind 'koreksi'.
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
        or (a.request_type = 'koreksi' and exists (
          select 1 from public.attendance_correction_requests r where r.id = a.request_id and r.user_id = p_user))
      )
  );
$$;

drop policy if exists "request_approvals_select" on public.request_approvals;
create policy "request_approvals_select" on public.request_approvals
  for select using (
    public.is_super()
    or public.is_request_approver(request_type, request_id)
    or (request_type = 'leave' and exists (
          select 1 from public.leave_requests r where r.id = request_id and r.user_id = auth.uid()))
    or (request_type = 'overtime' and exists (
          select 1 from public.overtime_requests r where r.id = request_id and r.user_id = auth.uid()))
    or (request_type = 'koreksi' and exists (
          select 1 from public.attendance_correction_requests r where r.id = request_id and r.user_id = auth.uid()))
  );

-- ---------------------------------------------------------------------
-- 7. TRIGGER pada attendance_correction_requests
--    BEFORE INSERT : paksa status 'pending' (pakai fungsi generik yang
--                    sama dengan leave/overtime)
--    BEFORE INSERT : jaga revisi (revision_of hanya utk pengajuan sendiri
--                    yang berstatus 'rejected')
--    AFTER  INSERT : bentuk tahap-tahap approval
-- ---------------------------------------------------------------------
create or replace function public.koreksi_check_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner  uuid;
  v_status text;
begin
  if new.revision_of is null then
    return new;
  end if;

  select user_id, status into v_owner, v_status
    from public.attendance_correction_requests where id = new.revision_of;

  if v_owner is null then
    raise exception 'Pengajuan asal tidak ditemukan';
  end if;
  if v_owner <> new.user_id then
    raise exception 'Pengajuan asal bukan milikmu';
  end if;
  if v_status <> 'rejected' then
    raise exception 'Hanya pengajuan yang ditolak yang bisa diajukan ulang';
  end if;
  return new;
end;
$$;

create or replace function public.koreksi_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_approval_steps('koreksi', new.id, new.user_id, 'koreksi', 'koreksi-approval');
  return new;
end;
$$;

drop trigger if exists trg_koreksi_force_pending on public.attendance_correction_requests;
create trigger trg_koreksi_force_pending
  before insert on public.attendance_correction_requests
  for each row execute function public.requests_force_pending();

drop trigger if exists trg_koreksi_check_revision on public.attendance_correction_requests;
create trigger trg_koreksi_check_revision
  before insert on public.attendance_correction_requests
  for each row execute function public.koreksi_check_revision();

drop trigger if exists trg_koreksi_after_insert on public.attendance_correction_requests;
create trigger trg_koreksi_after_insert
  after insert on public.attendance_correction_requests
  for each row execute function public.koreksi_after_insert();

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY — persis pola leave_requests/overtime_requests:
--    lihat baris sendiri, ATAU (lihat semua) kalau toggle 'koreksi-approval'
--    menyala; insert hanya untuk diri sendiri & butuh toggle 'koreksi'
--    menyala; update langsung (di luar decide_approval) hanya Super Admin.
-- ---------------------------------------------------------------------
alter table public.attendance_correction_requests enable row level security;

drop policy if exists "koreksi_select" on public.attendance_correction_requests;
create policy "koreksi_select" on public.attendance_correction_requests
  for select using ( user_id = auth.uid() or public.has_menu_access('koreksi-approval') );

drop policy if exists "koreksi_insert_self" on public.attendance_correction_requests;
create policy "koreksi_insert_self" on public.attendance_correction_requests
  for insert with check ( user_id = auth.uid() and public.has_menu_access('koreksi') );

drop policy if exists "koreksi_update" on public.attendance_correction_requests;
create policy "koreksi_update" on public.attendance_correction_requests
  for update using ( public.is_super() );

grant execute on function public.decide_approval(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Hak menu default: menu pribadi "koreksi" menyala untuk semua role
--    yang sudah punya menu pribadi lain (sama seperti izin/lembur); menu
--    approval "koreksi-approval" menyala untuk role yang sudah menyetujui
--    izin/lembur (Admin HR, Super Admin HR, Admin/admin_approval),
--    Karyawan biasa tetap mati (Super Admin bisa nyalakan manual).
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_hr', 'koreksi', true),
  ('admin_hr', 'koreksi-approval', true),
  ('super_admin_hr', 'koreksi', true),
  ('super_admin_hr', 'koreksi-approval', true),
  ('admin_approval', 'koreksi', true),
  ('admin_approval', 'koreksi-approval', true),
  ('karyawan', 'koreksi', true),
  ('karyawan', 'koreksi-approval', false)
on conflict (role, menu_id) do nothing;

-- ---------------------------------------------------------------------
-- 10. BACKFILL: pengajuan koreksi yang mungkin sudah sempat dibuat sebelum
--     migrasi ini rampung (mis. race saat deploy) dan belum punya tahap
--     approval.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select id, user_id from public.attendance_correction_requests k
    where k.status = 'pending'
      and not exists (select 1 from public.request_approvals a where a.request_type = 'koreksi' and a.request_id = k.id)
  loop
    perform public.create_approval_steps('koreksi', r.id, r.user_id, 'koreksi', 'koreksi-approval');
  end loop;
end $$;
