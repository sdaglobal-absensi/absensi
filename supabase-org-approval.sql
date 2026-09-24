-- =====================================================================
-- STRUKTUR ORGANISASI BERBASIS UNIT + APPROVAL BERTINGKAT
-- Aman dijalankan ulang (idempotent). Jalankan SETELAH supabase-schema.sql
-- (atau sudah termasuk di bagian akhir supabase-schema.sql untuk instalasi baru).
--
-- Aturan approval:
--   1. Approver = anggota unit yang role-nya Super Admin / Super Admin HR /
--      Admin HR / Admin (admin_approval) DAN menu approval terkait (izin-approval / lembur-approval)
--      menyala untuk role itu di Pengaturan Sistem. Role Karyawan tidak
--      pernah jadi approver.
--   2. Pencarian mulai dari UNIT UTAMA pemohon. Kalau unit itu tidak punya
--      approver, naik ke unit induk, dan seterusnya.
--   3. Jumlah tingkat approval per jenis pengajuan diatur di approval_settings.
--   4. Tidak punya unit utama / tidak ada approver di rantai atas -> fallback
--      ke semua Super Admin + staff yang berhak approve (perilaku lama).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: org_units (pohon unit organisasi, kedalaman bebas)
-- ---------------------------------------------------------------------
create table if not exists public.org_units (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.org_units(id) on delete restrict,
  nama        text not null,
  tipe        text not null default 'departemen' check (tipe in ('pusat','cabang','departemen','bagian','lainnya')),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_org_units_parent on public.org_units(parent_id);

comment on table public.org_units is 'Pohon unit organisasi (kantor pusat, cabang, departemen, bagian). parent_id = unit induk. Dipakai sebagai acuan rantai approval izin & lembur.';

-- ---------------------------------------------------------------------
-- 2. TABEL: org_unit_members (siapa ada di unit mana; satu orang bisa
--    ada di banyak unit, tapi hanya SATU unit utama yang jadi acuan approval)
-- ---------------------------------------------------------------------
create table if not exists public.org_unit_members (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.org_units(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (unit_id, user_id)
);
create index if not exists idx_org_unit_members_user on public.org_unit_members(user_id);
create unique index if not exists uq_org_unit_members_one_primary
  on public.org_unit_members(user_id) where is_primary;

comment on table public.org_unit_members is 'Keanggotaan karyawan di unit. is_primary = unit utama (tepat satu per karyawan) yang menentukan rantai approval pengajuannya.';

-- ---------------------------------------------------------------------
-- 3. TABEL: approval_settings (jumlah tingkat approval per jenis pengajuan)
-- ---------------------------------------------------------------------
create table if not exists public.approval_settings (
  request_type text primary key check (request_type in ('izin','sakit','cuti','lembur')),
  levels       integer not null default 1 check (levels between 1 and 5),
  updated_by   uuid references public.profiles(id),
  updated_at   timestamptz not null default now()
);

insert into public.approval_settings (request_type, levels) values
  ('izin', 1), ('sakit', 1), ('cuti', 1), ('lembur', 1)
on conflict (request_type) do nothing;

-- ---------------------------------------------------------------------
-- 4. TABEL: request_approvals (tahap approval per pengajuan; approver
--    di-snapshot saat pengajuan dibuat, jadi pindah unit / ganti role
--    setelahnya tidak mengubah riwayat)
-- ---------------------------------------------------------------------
create table if not exists public.request_approvals (
  id              uuid primary key default gen_random_uuid(),
  request_type    text not null check (request_type in ('leave','overtime')),
  request_id      uuid not null,
  step_order      integer not null,
  unit_id         uuid references public.org_units(id) on delete set null,
  approver_ids    uuid[] not null,
  approver_names  text,
  status          text not null default 'waiting' check (status in ('waiting','pending','approved','rejected','skipped')),
  decided_by      uuid references public.profiles(id),
  decided_by_name text,
  decided_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  unique (request_type, request_id, step_order)
);
alter table public.request_approvals add column if not exists decided_by_name text;
create index if not exists idx_request_approvals_req on public.request_approvals(request_type, request_id);
create index if not exists idx_request_approvals_approvers on public.request_approvals using gin (approver_ids);

comment on table public.request_approvals is 'Satu baris = satu tahap approval untuk satu pengajuan izin/lembur. Hanya diisi & diubah lewat fungsi security definer (create_approval_steps / decide_approval), tidak lewat query langsung dari aplikasi.';

-- ---------------------------------------------------------------------
-- 5. TRIGGER: updated_at + jaga pohon unit (tidak boleh siklus)
-- ---------------------------------------------------------------------
drop trigger if exists trg_org_units_updated_at on public.org_units;
create trigger trg_org_units_updated_at
  before update on public.org_units
  for each row execute function public.set_updated_at();

create or replace function public.org_units_guard()
returns trigger language plpgsql as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Unit tidak boleh menjadi induk dirinya sendiri';
    end if;
    if tg_op = 'UPDATE' and exists (
      with recursive d as (
        select id from public.org_units where parent_id = new.id
        union all
        select u.id from public.org_units u join d on u.parent_id = d.id
      )
      select 1 from d where id = new.parent_id
    ) then
      raise exception 'Unit tidak boleh dipindah ke bawah turunannya sendiri';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_org_units_guard on public.org_units;
create trigger trg_org_units_guard
  before insert or update of parent_id on public.org_units
  for each row execute function public.org_units_guard();

-- Cek apakah user login adalah approver di salah satu tahap sebuah pengajuan.
-- security definer supaya dipakai di policy request_approvals tanpa rekursi RLS.
create or replace function public.is_request_approver(p_kind text, p_request_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.request_approvals a
    where a.request_type = p_kind and a.request_id = p_request_id and auth.uid() = any (a.approver_ids)
  );
$$;

-- ---------------------------------------------------------------------
-- 6. FUNGSI: resolve_approval_chain — inti aturan "cari Admin ke atas"
-- ---------------------------------------------------------------------
create or replace function public.resolve_approval_chain(p_user uuid, p_levels integer, p_menu text)
returns table (r_step integer, r_unit uuid, r_ids uuid[], r_names text)
language plpgsql security definer stable set search_path = public as $$
declare
  v_unit uuid;
  v_step integer := 0;
  v_used uuid[] := array[p_user];
  v_ids  uuid[];
  v_names text;
begin
  select m.unit_id into v_unit
  from public.org_unit_members m
  join public.org_units u on u.id = m.unit_id
  where m.user_id = p_user and m.is_primary and u.is_active
  limit 1;

  while v_unit is not null and v_step < p_levels loop
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.org_unit_members m
    join public.profiles p on p.id = m.user_id
    where m.unit_id = v_unit
      and p.is_active
      and p.id <> all (v_used)
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr', 'admin_approval')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );

    if v_ids is not null then
      v_step := v_step + 1;
      v_used := v_used || v_ids;
      r_step := v_step; r_unit := v_unit; r_ids := v_ids; r_names := v_names;
      return next;
    end if;

    select parent_id into v_unit from public.org_units where id = v_unit;
  end loop;

  -- Fallback: tidak ada approver sama sekali di rantai (atau belum punya unit
  -- utama) -> Super Admin + staff yang berhak approve (perilaku sebelum ada struktur).
  if v_step = 0 then
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.profiles p
    where p.is_active
      and p.id <> p_user
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );
    if v_ids is not null then
      r_step := 1; r_unit := null; r_ids := v_ids; r_names := v_names;
      return next;
    end if;
  end if;

  return;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. FUNGSI: create_approval_steps — dipanggil trigger saat pengajuan dibuat
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
      else
        update public.overtime_requests
          set status = 'approved', reviewed_at = now(), review_notes = 'Disetujui otomatis (tidak ada approver di atasnya)'
          where id = p_request_id;
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. FUNGSI: decide_approval — satu-satunya jalan menyetujui/menolak
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
  if p_kind not in ('leave', 'overtime') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind when 'leave' then 'leave_requests' else 'overtime_requests' end;
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
  end if;

  return v_final;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. FUNGSI: set_primary_unit — pindah unit utama secara atomik
-- ---------------------------------------------------------------------
create or replace function public.set_primary_unit(p_user uuid, p_unit uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  update public.org_unit_members set is_primary = false
    where user_id = p_user and is_primary and unit_id <> p_unit;
  insert into public.org_unit_members (unit_id, user_id, is_primary)
    values (p_unit, p_user, true)
  on conflict (unit_id, user_id) do update set is_primary = true;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. TRIGGER pada leave_requests & overtime_requests
--     BEFORE INSERT : paksa status 'pending' (karyawan tidak boleh menitipkan
--                     status 'approved' lewat API)
--     AFTER  INSERT : bentuk tahap-tahap approval
-- ---------------------------------------------------------------------
create or replace function public.requests_force_pending()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_notes := null;
  end if;
  return new;
end;
$$;

create or replace function public.leave_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_approval_steps('leave', new.id, new.user_id, new.type, 'izin-approval');
  return new;
end;
$$;

create or replace function public.overtime_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_approval_steps('overtime', new.id, new.user_id, 'lembur', 'lembur-approval');
  return new;
end;
$$;

drop trigger if exists trg_leave_force_pending on public.leave_requests;
create trigger trg_leave_force_pending
  before insert on public.leave_requests
  for each row execute function public.requests_force_pending();

drop trigger if exists trg_leave_after_insert on public.leave_requests;
create trigger trg_leave_after_insert
  after insert on public.leave_requests
  for each row execute function public.leave_after_insert();

drop trigger if exists trg_overtime_force_pending on public.overtime_requests;
create trigger trg_overtime_force_pending
  before insert on public.overtime_requests
  for each row execute function public.requests_force_pending();

drop trigger if exists trg_overtime_after_insert on public.overtime_requests;
create trigger trg_overtime_after_insert
  after insert on public.overtime_requests
  for each row execute function public.overtime_after_insert();

-- ---------------------------------------------------------------------
-- 9b. FUNGSI: set_member_role — ubah role dari halaman Struktur Organisasi
--     (Data Karyawan TIDAK lagi mengatur role: akun baru selalu 'karyawan').
--     Harus punya hak 'struktur-kelola'. Kewenangan:
--       Super Admin              : semua role.
--       Super Admin HR / Admin HR: karyawan, admin_approval (label UI: Admin),
--                                  admin_hr, super_admin_hr -- TIDAK boleh
--                                  menyentuh/menetapkan super_admin.
--       lainnya (mis. Karyawan/Admin yang diberi hak kelola): hanya
--                                  karyawan <-> admin_approval.
--     Tidak boleh mengubah role diri sendiri.
-- ---------------------------------------------------------------------
create or replace function public.set_member_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller text := public.my_role();
  v_old    text;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  if p_role not in ('karyawan', 'admin_approval', 'admin_hr', 'super_admin_hr', 'super_admin') then
    raise exception 'Role tidak valid';
  end if;
  if p_user = auth.uid() then
    raise exception 'Tidak bisa mengubah role diri sendiri';
  end if;

  select role into v_old from public.profiles where id = p_user;
  if v_old is null then raise exception 'Karyawan tidak ditemukan'; end if;
  if v_old = p_role then return; end if;

  if v_caller = 'super_admin' then
    null; -- bebas
  elsif v_caller in ('super_admin_hr', 'admin_hr') then
    if p_role = 'super_admin' or v_old = 'super_admin' then
      raise exception 'Role Super Admin hanya bisa diatur oleh Super Admin';
    end if;
  else
    if p_role not in ('karyawan', 'admin_approval') or v_old not in ('karyawan', 'admin_approval') then
      raise exception 'Role ini hanya bisa diatur oleh Admin HR ke atas';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user;
end;
$$;

revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- Fungsi internal tidak boleh dipanggil langsung dari aplikasi.
revoke execute on function public.create_approval_steps(text, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.resolve_approval_chain(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.decide_approval(text, uuid, text, text) to authenticated;
grant execute on function public.set_primary_unit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 11. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.org_units enable row level security;
alter table public.org_unit_members enable row level security;
alter table public.approval_settings enable row level security;
alter table public.request_approvals enable row level security;

-- org_units: nama unit tidak sensitif, semua user login boleh baca.
drop policy if exists "org_units_select" on public.org_units;
create policy "org_units_select" on public.org_units
  for select using ( auth.uid() is not null );

drop policy if exists "org_units_write" on public.org_units;
create policy "org_units_write" on public.org_units
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- org_unit_members: baris sendiri, atau yang punya akses lihat/kelola struktur.
drop policy if exists "org_members_select" on public.org_unit_members;
create policy "org_members_select" on public.org_unit_members
  for select using (
    user_id = auth.uid()
    or public.is_staff()
    or public.has_menu_access('struktur-organisasi')
    or public.has_menu_access('struktur-kelola')
  );

drop policy if exists "org_members_write" on public.org_unit_members;
create policy "org_members_write" on public.org_unit_members
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- approval_settings
drop policy if exists "approval_settings_select" on public.approval_settings;
create policy "approval_settings_select" on public.approval_settings
  for select using ( auth.uid() is not null );

drop policy if exists "approval_settings_write" on public.approval_settings;
create policy "approval_settings_write" on public.approval_settings
  for all using ( public.has_menu_access('struktur-kelola') )
  with check ( public.has_menu_access('struktur-kelola') );

-- request_approvals: hanya baca. Tulis HANYA lewat fungsi security definer.
drop policy if exists "request_approvals_select" on public.request_approvals;
create policy "request_approvals_select" on public.request_approvals
  for select using (
    public.is_super()
    or public.is_request_approver(request_type, request_id)
    or (request_type = 'leave' and exists (
          select 1 from public.leave_requests r where r.id = request_id and r.user_id = auth.uid()))
    or (request_type = 'overtime' and exists (
          select 1 from public.overtime_requests r where r.id = request_id and r.user_id = auth.uid()))
  );

-- ---------------------------------------------------------------------
-- 11b. Approver boleh MEMBACA profil pemohon yang pengajuannya menunggu /
--      pernah melewati dirinya (untuk menampilkan nama & departemen di
--      halaman Approval). Terbatas ke pemohon di rantainya saja -- Admin
--      Approval tidak dianggap staff (is_staff), jadi tanpa ini nama
--      pemohon tidak terbaca.
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
      )
  );
$$;

drop policy if exists "profiles_select_approver" on public.profiles;
create policy "profiles_select_approver" on public.profiles
  for select using ( public.is_approver_of_user(id) );

-- ---------------------------------------------------------------------
-- 12. TUTUP CELAH: karyawan bisa mengubah status pengajuannya sendiri.
--     Policy update lama mengizinkan (user_id = auth.uid()) -- sekarang
--     UPDATE langsung hanya untuk Super Admin (koreksi manual). Approve /
--     tolak lewat decide_approval().
-- ---------------------------------------------------------------------
drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update" on public.leave_requests
  for update using ( public.is_super() );

drop policy if exists "overtime_update" on public.overtime_requests;
create policy "overtime_update" on public.overtime_requests
  for update using ( public.is_super() );

-- ---------------------------------------------------------------------
-- 13. Hak menu: 'struktur-kelola' = boleh mengubah struktur & pengaturan
--     tingkat approval (menu 'struktur-organisasi' tetap untuk melihat).
--     Default: hanya Super Admin HR; bisa diatur di Pengaturan Sistem.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, menu_id, enabled) values
  ('super_admin_hr', 'struktur-kelola', true),
  ('admin_hr', 'struktur-kelola', false),
  ('karyawan', 'struktur-kelola', false)
on conflict (role, menu_id) do nothing;

-- ---------------------------------------------------------------------
-- 14. BACKFILL: pengajuan yang masih 'pending' sebelum migrasi ini
--     dibentuk tahap approvalnya (supaya tidak menggantung).
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select id, user_id, type from public.leave_requests l
    where l.status = 'pending'
      and not exists (select 1 from public.request_approvals a where a.request_type = 'leave' and a.request_id = l.id)
  loop
    perform public.create_approval_steps('leave', r.id, r.user_id, r.type, 'izin-approval');
  end loop;

  for r in
    select id, user_id from public.overtime_requests o
    where o.status = 'pending'
      and not exists (select 1 from public.request_approvals a where a.request_type = 'overtime' and a.request_id = o.id)
  loop
    perform public.create_approval_steps('overtime', r.id, r.user_id, 'lembur', 'lembur-approval');
  end loop;
end $$;
