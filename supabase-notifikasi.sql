-- =====================================================================
-- NOTIFIKASI DALAM APLIKASI (lonceng di pojok kanan atas)
--
-- Beda dari push notification browser (supabase-push-notifikasi.sql, yang
-- cuma untuk pengingat lupa absen dan butuh izin notifikasi HP masing-
-- masing): ini notifikasi DI DALAM aplikasi, tersimpan di database, jadi
-- tetap kelihatan walau browser/HP tidak mengizinkan notifikasi sama sekali.
--
-- Dua jenis notifikasi (dua-duanya untuk izin/lembur/koreksi absen, yang
-- approval-nya lewat request_approvals -- BUKAN utk "Perubahan Data" yang
-- masih alur approval satu-tingkat terpisah):
--   - approval_needed  : ke approver, begitu ada pengajuan yang giliran dia.
--   - approval_decided : ke pemohon, begitu pengajuannya disetujui/ditolak
--                        (final -- utk approval bertingkat, baru dikirim
--                        setelah SEMUA tahap selesai, bukan tiap tahap).
--
-- Jalankan file ini PALING TERAKHIR, setelah supabase-schema.sql,
-- supabase-org-approval.sql, supabase-cuti-khusus.sql,
-- supabase-koreksi-absen.sql, dan supabase-fix-decide-approval-merge.sql
-- -- karena create_approval_steps & decide_approval didefinisikan ulang di
-- sini (menggabungkan SEMUA logic dari file-file itu + notifikasi baru),
-- supaya tidak ketiban masalah "ditimpa migrasi lain" seperti yang dulu
-- terjadi (lihat catatan di supabase-fix-decide-approval-merge.sql). Aman
-- dijalankan ulang (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: notifications
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  type         text not null check (type in ('approval_needed', 'approval_decided')),
  title        text not null,
  body         text,
  request_type text check (request_type in ('leave', 'overtime', 'koreksi')),
  request_id   uuid,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_notifications_user_created on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_unread on public.notifications(user_id) where not is_read;

comment on table public.notifications is 'Notifikasi dalam aplikasi (lonceng). Hanya diisi lewat create_approval_steps/decide_approval (security definer) -- tidak lewat insert langsung dari klien.';

alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select using (user_id = auth.uid());

-- Klien cuma boleh menandai notifikasi MILIKNYA SENDIRI sebagai sudah
-- dibaca (dipakai tombol "Tandai semua sudah dibaca" & klik satu notifikasi).
drop policy if exists "notifications_update_own_read" on public.notifications;
create policy "notifications_update_own_read" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Nyalakan Realtime utk tabel ini (badge lonceng update otomatis tanpa
-- refresh). Aman dijalankan ulang -- dilewati kalau sudah pernah ditambahkan.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. FUNGSI KECIL: label jenis pengajuan & pengirim notifikasi
-- ---------------------------------------------------------------------
create or replace function public.request_kind_label(p_kind text)
returns text language sql immutable as $$
  select case p_kind
    when 'leave' then 'Izin/Cuti/Sakit'
    when 'overtime' then 'Lembur'
    when 'koreksi' then 'Koreksi Absen'
    else p_kind
  end;
$$;

create or replace function public.notify_user(
  p_user uuid, p_type text, p_title text, p_body text, p_request_type text, p_request_id uuid
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  insert into public.notifications (user_id, type, title, body, request_type, request_id)
  values (p_user, p_type, p_title, p_body, p_request_type, p_request_id);
end;
$$;

create or replace function public.notify_users(
  p_users uuid[], p_type text, p_title text, p_body text, p_request_type text, p_request_id uuid
)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  foreach u in array coalesce(p_users, array[]::uuid[]) loop
    perform public.notify_user(u, p_type, p_title, p_body, p_request_type, p_request_id);
  end loop;
end;
$$;

revoke execute on function public.notify_user(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.notify_users(uuid[], text, text, text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. create_approval_steps -- ditambah notifikasi "approval_needed" ke
--    approver tahap pertama, begitu tahapnya berhasil dibentuk.
-- ---------------------------------------------------------------------
create or replace function public.create_approval_steps(
  p_kind text, p_request_id uuid, p_user uuid, p_setting_key text, p_menu text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_levels integer;
  v_count  integer := 0;
  v_role   text;
  v_name   text;
  r record;
begin
  select coalesce((select levels from public.approval_settings where request_type = p_setting_key), 1)
    into v_levels;
  select full_name into v_name from public.profiles where id = p_user;

  for r in select * from public.resolve_approval_chain(p_user, v_levels, p_menu) loop
    insert into public.request_approvals (request_type, request_id, step_order, unit_id, approver_ids, approver_names, status)
    values (p_kind, p_request_id, r.r_step, r.r_unit, r.r_ids, r.r_names,
            case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;

    if r.r_step = 1 then
      perform public.notify_users(
        r.r_ids, 'approval_needed', 'Pengajuan menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' mengajukan ' || public.request_kind_label(p_kind) || '.',
        p_kind, p_request_id
      );
    end if;
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
      -- Super Admin mengajukan & langsung auto-approved -- tidak ada
      -- approver lain yang perlu tahu, jadi tidak ada notifikasi.
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. decide_approval -- ditambah notifikasi "approval_needed" ke tahap
--    berikutnya (kalau ada), dan "approval_decided" ke pemohon begitu
--    status akhirnya approved/rejected. Selain itu isinya SAMA PERSIS
--    dengan versi gabungan di supabase-fix-decide-approval-merge.sql
--    (potong saldo Cuti Tahunan + terapkan Koreksi Absen).
-- ---------------------------------------------------------------------
create or replace function public.decide_approval(
  p_kind text, p_request_id uuid, p_decision text, p_notes text default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_uid_name text;
  v_tbl    text;
  v_owner  uuid;
  v_status text;
  v_leave_category text;
  v_start  date;
  v_end    date;
  v_step   public.request_approvals%rowtype;
  v_next   public.request_approvals%rowtype;
  v_final  text := 'pending';
  v_days   integer;
  v_kuota  numeric;
  v_terpakai numeric;
  v_year   integer;
begin
  if v_uid is null then raise exception 'Belum login'; end if;
  if p_kind not in ('leave', 'overtime', 'koreksi') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind
    when 'leave' then 'leave_requests'
    when 'overtime' then 'overtime_requests'
    else 'attendance_correction_requests'
  end;

  if p_kind = 'leave' then
    select user_id, status, leave_category, start_date, end_date
      into v_owner, v_status, v_leave_category, v_start, v_end
      from public.leave_requests where id = p_request_id for update;
  else
    execute format('select user_id, status from public.%I where id = $1 for update', v_tbl)
      into v_owner, v_status using p_request_id;
  end if;

  if v_owner is null then raise exception 'Pengajuan tidak ditemukan'; end if;
  if v_status <> 'pending' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_owner = v_uid then raise exception 'Tidak boleh memproses pengajuan sendiri'; end if;

  select full_name into v_uid_name from public.profiles where id = v_uid;

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
          decided_by_name = v_uid_name
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
        perform public.notify_users(
          v_next.approver_ids, 'approval_needed', 'Pengajuan menunggu persetujuanmu',
          coalesce((select full_name from public.profiles where id = v_owner), 'Seseorang')
            || ' mengajukan ' || public.request_kind_label(p_kind) || ', sekarang giliranmu.',
          p_kind, p_request_id
        );
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

  -- Cuti Tahunan: potong saldo HANYA saat status akhir benar-benar 'approved'.
  -- Dicek ulang di sini (bukan cuma saat submit) supaya 2 pengajuan pending
  -- yang sama-sama disetujui tidak dobel memakai saldo yang sama.
  if v_final = 'approved' and p_kind = 'leave' and v_leave_category = 'tahunan' then
    v_days := (v_end - v_start) + 1;
    v_year := extract(year from v_start)::int;
    select kuota_hari, terpakai_hari into v_kuota, v_terpakai
      from public.leave_balances where user_id = v_owner and tahun = v_year
      for update;
    if v_kuota is null then
      raise exception 'Kuota Cuti Tahunan % belum diatur untuk karyawan ini. Hubungi admin.', v_year;
    end if;
    if v_terpakai + v_days > v_kuota then
      raise exception 'Sisa Cuti Tahunan karyawan ini tidak mencukupi (sisa % hari, pengajuan % hari) -- kemungkinan ada pengajuan lain yang sudah memakai saldo ini duluan', (v_kuota - v_terpakai), v_days;
    end if;
    update public.leave_balances set terpakai_hari = terpakai_hari + v_days
      where user_id = v_owner and tahun = v_year;
  end if;

  if v_final <> 'pending' then
    execute format(
      'update public.%I set status = $1, reviewed_by = $2, reviewed_at = now(), review_notes = $3 where id = $4',
      v_tbl
    ) using v_final, v_uid, p_notes, p_request_id;

    -- Koreksi Absen: terapkan jam yang diajukan ke tabel attendance begitu
    -- disetujui sampai tahap terakhir.
    if v_final = 'approved' and p_kind = 'koreksi' then
      perform public.apply_attendance_correction(p_request_id);
    end if;

    -- Notifikasi ke pemohon: baru dikirim di sini, artinya utk approval
    -- bertingkat cuma dikirim SEKALI di akhir (bukan tiap tahap), karena
    -- v_final baru terisi 'approved'/'rejected' kalau memang final.
    perform public.notify_user(
      v_owner,
      'approval_decided',
      case when v_final = 'approved' then 'Pengajuan disetujui' else 'Pengajuan ditolak' end,
      public.request_kind_label(p_kind) || ' kamu ' ||
        case when v_final = 'approved' then 'disetujui' else 'ditolak' end ||
        ' oleh ' || coalesce(v_uid_name, '-') ||
        case when p_notes is not null and p_notes <> '' then '. Catatan: ' || p_notes else '.' end,
      p_kind, p_request_id
    );
  end if;

  return v_final;
end;
$$;

grant execute on function public.decide_approval(text, uuid, text, text) to authenticated;
