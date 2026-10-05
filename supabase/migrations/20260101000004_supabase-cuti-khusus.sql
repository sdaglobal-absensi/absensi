-- =====================================================================
-- CUTI TAHUNAN & CUTI KHUSUS
-- Aman dijalankan ulang (idempotent). Jalankan SETELAH supabase-schema.sql
-- dan supabase-org-approval.sql.
--
-- Ringkasan:
--   - Jenis pengajuan "Izin" diganti labelnya jadi "Izin Tidak Masuk" di
--     tampilan saja (value database tetap 'izin', tidak perlu migrasi data).
--   - Pengajuan type='cuti' sekarang wajib punya leave_category:
--       'tahunan' -> tanggal diisi manual, jumlah hari dipotong dari saldo
--                    tahunan karyawan ybs (tabel leave_balances).
--       'khusus'  -> pilih salah satu dari 7 jenis cuti khusus (master di
--                    special_leave_rules), jumlah hari & tanggal selesai
--                    otomatis terhitung dari master, tidak memotong saldo
--                    cuti tahunan (hak terpisah per kejadian).
--   - Validasi jumlah hari & saldo dicek di DUA titik: saat pengajuan dibuat
--     (trigger, defense pertama) DAN saat disetujui (decide_approval, defense
--     kedua) -- supaya 2 pengajuan pending yang sama-sama disetujui tidak
--     dobel memakai saldo yang sama.
--   - Cuti yang sudah disetujui bisa dibatalkan (status 'dibatalkan', beda
--     dari 'rejected') oleh HR/Super Admin lewat cancel_leave_request();
--     kalau kategorinya tahunan, saldo yang sudah terpakai dikembalikan.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: special_leave_rules (master 7 jenis cuti khusus, jumlah hari
--    per jenis bisa diubah admin lewat menu "Kuota Cuti Tahunan" tanpa
--    ubah kode).
-- ---------------------------------------------------------------------
create table if not exists public.special_leave_rules (
  kode        text primary key,
  label       text not null,
  jumlah_hari integer not null check (jumlah_hari > 0),
  sort_order  integer not null default 0,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

insert into public.special_leave_rules (kode, label, jumlah_hari, sort_order) values
  ('nikah_sendiri', 'Pekerja Menikah', 3, 1),
  ('menikahkan_anak', 'Menikahkan Anak', 2, 2),
  ('mengkhitankan_anak', 'Mengkhitankan Anak', 2, 3),
  ('membaptiskan_anak', 'Membaptiskan Anak', 2, 4),
  ('istri_melahirkan', 'Istri Melahirkan atau Keguguran Kandungan', 2, 5),
  ('keluarga_inti_meninggal', 'Anggota Keluarga Inti Meninggal Dunia (Suami/Istri, Orang Tua/Mertua, Anak, atau Menantu)', 2, 6),
  ('keluarga_serumah_meninggal', 'Anggota Keluarga dalam Satu Rumah Meninggal Dunia', 1, 7)
on conflict (kode) do nothing;

comment on table public.special_leave_rules is 'Master 7 jenis Cuti Khusus + jumlah hari haknya. Diatur lewat menu Kuota Cuti Tahunan.';

-- ---------------------------------------------------------------------
-- 2. TABEL: leave_balances (kuota & pemakaian Cuti Tahunan per karyawan
--    per tahun -- baris terpisah per tahun, jadi menjalankan ulang untuk
--    tahun baru tidak menimpa histori tahun sebelumnya).
-- ---------------------------------------------------------------------
create table if not exists public.leave_balances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  tahun         integer not null,
  kuota_hari    numeric not null default 0,
  terpakai_hari numeric not null default 0,
  updated_by    uuid references public.profiles(id),
  updated_at    timestamptz not null default now(),
  unique (user_id, tahun)
);
create index if not exists idx_leave_balances_user on public.leave_balances(user_id);

comment on table public.leave_balances is 'Kuota & pemakaian Cuti Tahunan per karyawan per tahun. Sisa = kuota_hari - terpakai_hari, dihitung on the fly (tidak disimpan) supaya tidak bisa out-of-sync.';

drop trigger if exists trg_leave_balances_updated_at on public.leave_balances;
create trigger trg_leave_balances_updated_at
  before update on public.leave_balances
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. KOLOM BARU di leave_requests
-- ---------------------------------------------------------------------
alter table public.leave_requests add column if not exists leave_category text;
alter table public.leave_requests add column if not exists special_leave_code text references public.special_leave_rules(kode);
alter table public.leave_requests add column if not exists cancelled_by uuid references public.profiles(id);
alter table public.leave_requests add column if not exists cancelled_at timestamptz;
alter table public.leave_requests add column if not exists cancel_reason text;

-- Backfill: pengajuan cuti lama (sebelum migrasi ini) dianggap Cuti Tahunan,
-- supaya lolos constraint baru di bawah tanpa mengubah histori jadi tidak jelas.
update public.leave_requests set leave_category = 'tahunan' where type = 'cuti' and leave_category is null;

alter table public.leave_requests drop constraint if exists leave_requests_leave_category_check;
alter table public.leave_requests add constraint leave_requests_leave_category_check
  check ( (type <> 'cuti' and leave_category is null) or (type = 'cuti' and leave_category in ('tahunan','khusus')) );

alter table public.leave_requests drop constraint if exists leave_requests_status_check;
alter table public.leave_requests add constraint leave_requests_status_check
  check (status in ('pending','approved','rejected','dibatalkan'));

-- ---------------------------------------------------------------------
-- 4. VALIDASI saat pengajuan dibuat (defense pertama)
-- ---------------------------------------------------------------------
create or replace function public.leave_before_insert_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_days     integer;
  v_kuota    numeric;
  v_terpakai numeric;
  v_year     integer;
begin
  if new.type <> 'cuti' then
    new.leave_category := null;
    new.special_leave_code := null;
    return new;
  end if;

  if new.leave_category is null or new.leave_category not in ('tahunan', 'khusus') then
    raise exception 'Pilih kategori cuti (Cuti Tahunan atau Cuti Khusus)';
  end if;

  if new.leave_category = 'khusus' then
    if new.special_leave_code is null then
      raise exception 'Pilih jenis cuti khusus';
    end if;
    select jumlah_hari into v_days from public.special_leave_rules where kode = new.special_leave_code;
    if v_days is null then
      raise exception 'Jenis cuti khusus tidak valid';
    end if;
    -- Tanggal selesai SELALU dihitung ulang di server dari master (bukan
    -- dari input klien) -- pengaman kedua setelah field readonly di form.
    new.end_date := new.start_date + (v_days - 1);
  else
    new.special_leave_code := null;
    v_days := (new.end_date - new.start_date) + 1;
    v_year := extract(year from new.start_date)::int;
    select kuota_hari, terpakai_hari into v_kuota, v_terpakai
      from public.leave_balances where user_id = new.user_id and tahun = v_year;
    if v_kuota is null then
      raise exception 'Kuota Cuti Tahunan % belum diatur untuk kamu. Hubungi admin.', v_year;
    end if;
    if v_terpakai + v_days > v_kuota then
      raise exception 'Sisa Cuti Tahunan tidak mencukupi (sisa % hari, diajukan % hari)', (v_kuota - v_terpakai), v_days;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_leave_before_insert_validate on public.leave_requests;
create trigger trg_leave_before_insert_validate
  before insert on public.leave_requests
  for each row execute function public.leave_before_insert_validate();

-- ---------------------------------------------------------------------
-- 5. decide_approval -- tambah potong saldo Cuti Tahunan saat status akhir
--    benar-benar 'approved' (defense kedua, cek ulang sisa saldo di sini).
--    Signature SAMA seperti supabase-org-approval.sql -- create or replace
--    aman, tidak perlu drop function / ubah grant.
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
  if p_kind not in ('leave', 'overtime') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind when 'leave' then 'leave_requests' else 'overtime_requests' end;

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
  end if;

  return v_final;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. cancel_leave_request -- membatalkan cuti yang SUDAH disetujui.
--    Hanya HR/Super Admin (is_staff(): super_admin, super_admin_hr,
--    admin_hr). Kalau kategorinya Cuti Tahunan, saldo yang sudah terpakai
--    dikembalikan (tidak boleh negatif).
-- ---------------------------------------------------------------------
create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_status   text;
  v_type     text;
  v_category text;
  v_start    date;
  v_end      date;
  v_owner    uuid;
  v_days     integer;
  v_year     integer;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not public.is_staff() then
    raise exception 'Hanya HR/Super Admin yang boleh membatalkan pengajuan cuti';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Alasan pembatalan wajib diisi';
  end if;

  select status, type, leave_category, start_date, end_date, user_id
    into v_status, v_type, v_category, v_start, v_end, v_owner
    from public.leave_requests where id = p_request_id for update;

  if v_status is null then raise exception 'Pengajuan tidak ditemukan'; end if;
  if v_type <> 'cuti' then raise exception 'Hanya pengajuan cuti yang bisa dibatalkan lewat sini'; end if;
  if v_status <> 'approved' then raise exception 'Hanya pengajuan yang sudah disetujui yang bisa dibatalkan'; end if;

  update public.leave_requests
    set status = 'dibatalkan', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = p_reason
    where id = p_request_id;

  if v_category = 'tahunan' then
    v_days := (v_end - v_start) + 1;
    v_year := extract(year from v_start)::int;
    update public.leave_balances set terpakai_hari = greatest(0, terpakai_hari - v_days)
      where user_id = v_owner and tahun = v_year;
  end if;

  return 'dibatalkan';
end;
$$;

revoke execute on function public.cancel_leave_request(uuid, text) from public, anon;
grant execute on function public.cancel_leave_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.special_leave_rules enable row level security;
drop policy if exists "special_leave_rules_select" on public.special_leave_rules;
create policy "special_leave_rules_select" on public.special_leave_rules
  for select using ( auth.uid() is not null );

drop policy if exists "special_leave_rules_write" on public.special_leave_rules;
create policy "special_leave_rules_write" on public.special_leave_rules
  for all using ( public.has_menu_access('kuota-cuti') ) with check ( public.has_menu_access('kuota-cuti') );

alter table public.leave_balances enable row level security;
drop policy if exists "leave_balances_select" on public.leave_balances;
create policy "leave_balances_select" on public.leave_balances
  for select using (
    user_id = auth.uid()
    or public.is_staff()
    or public.has_menu_access('kuota-cuti')
    or public.has_menu_access('izin-approval')
  );

drop policy if exists "leave_balances_write" on public.leave_balances;
create policy "leave_balances_write" on public.leave_balances
  for all using ( public.has_menu_access('kuota-cuti') ) with check ( public.has_menu_access('kuota-cuti') );

-- ---------------------------------------------------------------------
-- 8. Hak menu: 'kuota-cuti' (Kuota Cuti Tahunan). Default sama seperti
--    'master-level': menyala untuk Super Admin HR, mati untuk yang lain
--    sampai sengaja dinyalakan lewat Pengaturan Sistem.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, menu_id, enabled) values
  ('super_admin_hr', 'kuota-cuti', true),
  ('admin_hr', 'kuota-cuti', false),
  ('admin_approval', 'kuota-cuti', false),
  ('karyawan', 'kuota-cuti', false)
on conflict (role, menu_id) do nothing;
