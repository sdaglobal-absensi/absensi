-- =====================================================================
-- 001_multi_tenant.sql — TAHAP 1: fondasi multi-tenant (satu database,
-- banyak usaha) untuk KERJORA / aplikasi absensi.
--
-- APA YANG DILAKUKAN FILE INI
--   1. Membuat tabel `tenants` (satu baris = satu usaha/UMKM), serta tabel
--      platform: `platform_admins` (pemilik aplikasi) & `platform_settings`.
--   2. Membuat satu tenant bawaan ("Perusahaan Utama") dan memindahkan
--      SEMUA data yang sekarang ada ke tenant itu — tidak ada data hilang.
--   3. Menambah kolom `tenant_id` ke 38 tabel + memasang isolasi data:
--      policy RLS "restrictive" (di-AND dengan policy lama, jadi aturan role
--      yang sudah ada tetap berlaku persis seperti sekarang).
--   4. Membuat aturan unik per-tenant (kode karyawan, nama lokasi, dst).
--   5. Menulis ulang fungsi yang sebelumnya "global" supaya sadar tenant:
--      has_menu_access, resolve_approval_chain, create_approval_steps,
--      decide_approval, cancel_leave_request, set_member_role,
--      set_primary_unit, leave_before_insert_validate, handle_new_user.
--   6. Menyiapkan onboarding usaha baru (register_tenant) — TERKUNCI sampai
--      kamu menyalakan platform_settings.public_mode (lihat README).
--
-- CARA PAKAI
--   Supabase Dashboard > SQL Editor > paste seluruh file > Run.
--   Seluruh file berjalan dalam SATU transaksi: kalau ada error di mana pun,
--   semuanya otomatis dibatalkan (database kembali seperti semula).
--   Aman dijalankan ulang (idempotent).
--
-- SEBELUM RUN: ambil backup (Database > Backups) — kebiasaan baik untuk
-- migrasi struktur apa pun.
--
-- PENTING SETELAH MIGRASI
--   * JANGAN jalankan ulang file SQL lama (supabase-schema.sql dkk): file itu
--     akan menimpa fungsi yang sudah sadar-tenant dengan versi lama.
--   * 3 baris JS perlu diubah (onConflict) — lihat README-MULTI-TENANT.md.
--   * Jangan nyalakan public_mode sebelum Tahap 2 (Edge Function pembuat
--     akun) selesai. Selama public_mode = false, semua akun baru otomatis
--     masuk tenant bawaan (perilaku aplikasi persis seperti sebelum ini).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRASYARAT
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Tabel public.profiles tidak ditemukan. Jalankan supabase-schema.sql dulu.';
  end if;
  if to_regclass('public.role_permissions') is null then
    raise exception 'Tabel public.role_permissions tidak ditemukan. Jalankan supabase-schema.sql dulu.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. TABEL PLATFORM
-- ---------------------------------------------------------------------
-- tenants: satu baris = satu usaha/UMKM.
--   status : trial | active | suspended  (suspended = semua data usaha itu
--            langsung tertutup untuk penggunanya — saklar darurat/tunggakan)
--   plan   : free | pro | ... (teks bebas; dipakai Tahap 4 untuk fitur/paket)
--   max_karyawan : NULL = tanpa batas.
create table if not exists public.tenants (
  id            uuid primary key default gen_random_uuid(),
  kode          text not null,   -- kode usaha singkat (huruf kecil/angka), dipakai untuk login karyawan nanti
  nama          text not null,
  status        text not null default 'active' check (status in ('trial', 'active', 'suspended')),
  plan          text not null default 'free',
  max_karyawan  integer check (max_karyawan is null or max_karyawan > 0),
  owner_id      uuid references auth.users(id) on delete set null,
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_tenants_kode on public.tenants (lower(kode));

comment on table public.tenants is 'Satu baris = satu usaha (tenant). Semua tabel data punya kolom tenant_id yang menunjuk ke sini.';

-- platform_admins: pemilik aplikasi (kamu). BUKAN anggota tenant mana pun dan
-- tidak otomatis bisa membaca data tenant — hanya mengelola daftar tenant.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- platform_settings: satu baris.
--   public_mode       : false = mode lama (akun baru otomatis masuk tenant bawaan,
--                       pendaftaran usaha baru DITUTUP). true = mode publik.
--   default_tenant_id : tenant tempat data lama dipindahkan.
create table if not exists public.platform_settings (
  id                integer primary key default 1 check (id = 1),
  public_mode       boolean not null default false,
  default_tenant_id uuid references public.tenants(id),
  updated_at        timestamptz not null default now()
);
insert into public.platform_settings (id) values (1) on conflict (id) do nothing;

-- Tenant bawaan untuk data yang sudah ada. Ganti namanya nanti, mis.:
--   update public.tenants set nama = 'Nama Usaha Kamu' where kode = 'utama';
do $$
declare v uuid;
begin
  select default_tenant_id into v from public.platform_settings where id = 1;
  if v is null then
    insert into public.tenants (kode, nama, plan, status, max_karyawan)
    values ('utama', 'Perusahaan Utama', 'internal', 'active', null)
    returning id into v;
    update public.platform_settings set default_tenant_id = v, updated_at = now() where id = 1;
  end if;
end $$;

-- Daftar semua tabel data yang diisolasi per tenant. Tabel yang belum ada di
-- project kamu (migrasi opsional belum dijalankan) otomatis dilewati.
create or replace function public._mt_tables() returns text[] language sql immutable as $$
  select array[
    'profiles','office_locations','attendance','leave_requests','job_levels',
    'wage_history','salary_history','departments','work_schedules','work_schedule_days',
    'holidays','overtime_requests','payroll_adjustments','payroll_periods','payroll_slips',
    'late_penalty_rules','allowance_types','employee_allowances','role_permissions',
    'payroll_settings','profile_change_requests','employee_children','org_units',
    'org_unit_members','approval_settings','request_approvals','special_leave_rules',
    'leave_balances','attendance_correction_requests','master_pt','outsourcing_invoices',
    'outsourcing_area_invoices','notifications','push_subscriptions',
    'checkin_reminders_sent','checkin_before_reminder_sent','push_settings',
    'employee_schedule_history'
  ];
$$;

-- ---------------------------------------------------------------------
-- 2. KOLOM tenant_id + BACKFILL (semua data lama -> tenant bawaan)
--    Trigger user dimatikan sementara per tabel supaya updated_at / hitung
--    PTKP / dsb. tidak ikut berubah gara-gara backfill.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  v_default uuid;
begin
  select default_tenant_id into v_default from public.platform_settings where id = 1;
  foreach t in array public._mt_tables() loop
    if to_regclass('public.' || t) is null then
      raise notice 'Lewati % (tabel belum ada di project ini)', t;
      continue;
    end if;
    execute format('alter table public.%I add column if not exists tenant_id uuid', t);
    execute format('alter table public.%I disable trigger user', t);
    execute format('update public.%I set tenant_id = $1 where tenant_id is null', t) using v_default;
    execute format('alter table public.%I enable trigger user', t);
    execute format('alter table public.%I alter column tenant_id set not null', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. FUNGSI HELPER TENANT
-- ---------------------------------------------------------------------
-- Tenant milik user yang sedang login. NULL kalau belum punya profil, atau
-- kalau tenant-nya berstatus 'suspended' (-> semua data tertutup).
create or replace function public.current_tenant_id()
returns uuid language sql security definer stable set search_path = public as $$
  select p.tenant_id
  from public.profiles p
  join public.tenants t on t.id = p.tenant_id
  where p.id = auth.uid() and t.status <> 'suspended';
$$;

create or replace function public.is_platform_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.platform_public_mode()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select public_mode from public.platform_settings where id = 1), false);
$$;

-- is_super() TIDAK diubah secara definisi: role 'super_admin' kini berarti
-- "pemilik usaha" di tenant-nya saja, karena semua tabel sudah dibatasi
-- policy restrictive per tenant.

-- has_menu_access: sekarang membaca role_permissions MILIK TENANT user itu.
create or replace function public.has_menu_access(p_menu_id text)
returns boolean language sql security definer stable set search_path = public as $$
  select
    public.is_super()
    or coalesce((
      select rp.enabled from public.role_permissions rp
      where rp.tenant_id = public.current_tenant_id()
        and rp.role = public.my_role()
        and rp.menu_id = p_menu_id
    ), false);
$$;

-- Trigger: isi/validasi tenant_id dari user_id (tabel yang punya kolom user_id).
-- Dipakai juga oleh Edge Function (service role, auth.uid() null) yang
-- menulis baris atas nama karyawan: tenant_id otomatis ikut karyawannya.
create or replace function public.tg_tenant_from_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.profiles where id = new.user_id;
  if v_t is null then
    raise exception 'Karyawan tidak ditemukan atau belum terdaftar di sebuah usaha';
  end if;
  if new.tenant_id is null then
    new.tenant_id := v_t;
  elsif new.tenant_id <> v_t then
    raise exception 'Data lintas usaha (tenant) ditolak';
  end if;
  return new;
end;
$$;

-- Trigger: tenant_id tidak boleh diubah lewat aplikasi (hanya SQL Editor /
-- service role, yang auth.uid()-nya null).
create or replace function public.tg_tenant_immutable()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id tidak boleh diubah';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3b. PERBAIKAN POLICY LAMA YANG MEMBACA `profiles` DARI DALAM POLICY-NYA
--     `profiles_update_self` dulu memakai subquery ke tabel profiles. Begitu
--     policy isolasi (yang juga memakai subquery) dipasang di profiles,
--     Postgres menolak dengan "infinite recursion detected in policy".
--     my_role() = role milik auth.uid() — artinya SAMA PERSIS dengan
--     subquery lama, tapi lewat fungsi security definer sehingga tidak
--     memicu rekursi. Aturannya tidak berubah: karyawan boleh mengubah
--     profilnya sendiri kecuali kolom role.
-- ---------------------------------------------------------------------
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using ( id = auth.uid() )
  with check ( id = auth.uid() and role = public.my_role() );

-- ---------------------------------------------------------------------
-- 4. PASANG ISOLASI PER TABEL
--    - default tenant_id = tenant user yang login (jadi kode JS yang sekarang
--      TIDAK perlu mengirim tenant_id sama sekali)
--    - foreign key + index
--    - trigger penjaga (isi dari user_id, tenant_id tak bisa diubah)
--    - policy RLS RESTRICTIVE "tenant_isolation": di-AND dengan semua policy
--      lama, berlaku untuk SEMUA role termasuk anon. Ini sekaligus menutup
--      tabel yang dulu `using (true)` (mis. tarif/level) dari akses anonim.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array public._mt_tables() loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('alter table public.%I alter column tenant_id set default public.current_tenant_id()', t);

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass and conname = t || '_tenant_fk'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants(id) on delete restrict',
        t, t || '_tenant_fk');
    end if;

    execute format('create index if not exists %I on public.%I (tenant_id)', 'idx_' || t || '_tenant', t);

    execute format('drop trigger if exists aa_tenant_immutable on public.%I', t);
    execute format(
      'create trigger aa_tenant_immutable before update on public.%I for each row execute function public.tg_tenant_immutable()', t);

    if t <> 'profiles' and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
    ) then
      execute format('drop trigger if exists aa_tenant_from_user on public.%I', t);
      execute format(
        'create trigger aa_tenant_from_user before insert on public.%I for each row execute function public.tg_tenant_from_user()', t);
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I as restrictive for all '
      'using (tenant_id = (select public.current_tenant_id())) '
      'with check (tenant_id = (select public.current_tenant_id()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. ATURAN UNIK & PRIMARY KEY PER TENANT
--    Dulu unik "global" (cuma ada satu perusahaan). Sekarang dua usaha boleh
--    sama-sama punya karyawan "001", lokasi "Kantor Pusat", level "G1", dst.
-- ---------------------------------------------------------------------
create or replace function public._mt_make_tenant_unique(p_table text, p_cols text[])
returns void language plpgsql as $$
declare
  r record;
  v_name text := left(p_table || '_tenant_' || array_to_string(p_cols, '_') || '_key', 63);
begin
  if to_regclass('public.' || p_table) is null then return; end if;

  for r in
    select c.conname from pg_constraint c
    where c.conrelid = ('public.' || p_table)::regclass and c.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname::text)
             from unnest(c.conkey) k(attnum)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
          = (select array_agg(x order by x) from unnest(p_cols) x)
  loop
    execute format('alter table public.%I drop constraint %I', p_table, r.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conrelid = ('public.' || p_table)::regclass and conname = v_name) then
    execute format('alter table public.%I add constraint %I unique (tenant_id, %s)',
      p_table, v_name, (select string_agg(quote_ident(x), ', ') from unnest(p_cols) x));
  end if;
end;
$$;

create or replace function public._mt_swap_pk(p_table text, p_cols text[])
returns void language plpgsql as $$
declare
  r record;
  v_target text[] := (select array_agg(x order by x) from unnest(array['tenant_id'] || p_cols) x);
begin
  if to_regclass('public.' || p_table) is null then return; end if;

  -- sudah (tenant_id, ...)? lewati.
  if exists (
    select 1 from pg_constraint c
    where c.conrelid = ('public.' || p_table)::regclass and c.contype = 'p'
      and (select array_agg(a.attname::text order by a.attname::text)
             from unnest(c.conkey) k(attnum)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = v_target
  ) then
    return;
  end if;

  -- foreign key yang menunjuk ke PK lama harus dilepas dulu (dipasang ulang
  -- sebagai foreign key komposit (tenant_id, ...) di bawah).
  for r in
    select conrelid::regclass as tbl, conname from pg_constraint
    where contype = 'f' and confrelid = ('public.' || p_table)::regclass
      and conname not like '%\_tenant\_fk'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  for r in
    select conname from pg_constraint
    where conrelid = ('public.' || p_table)::regclass and contype = 'p'
  loop
    execute format('alter table public.%I drop constraint %I', p_table, r.conname);
  end loop;

  execute format('alter table public.%I add primary key (tenant_id, %s)',
    p_table, (select string_agg(quote_ident(x), ', ') from unnest(p_cols) x));
end;
$$;

-- unik biasa -> unik per tenant
select public._mt_make_tenant_unique('profiles',                  array['employee_code']);
select public._mt_make_tenant_unique('office_locations',          array['name']);
select public._mt_make_tenant_unique('job_levels',                array['grade','level']);
select public._mt_make_tenant_unique('departments',               array['departemen','bagian','jabatan']);
select public._mt_make_tenant_unique('holidays',                  array['date']);
select public._mt_make_tenant_unique('late_penalty_rules',        array['day_type','jenis','menit_offset']);
select public._mt_make_tenant_unique('allowance_types',           array['nama']);
select public._mt_make_tenant_unique('master_pt',                 array['nama']);
select public._mt_make_tenant_unique('outsourcing_area_invoices', array['vendor','area','period']);

-- primary key -> (tenant_id, ...)
select public._mt_swap_pk('role_permissions',  array['role','menu_id']);
select public._mt_swap_pk('approval_settings', array['request_type']);
select public._mt_swap_pk('payroll_settings',  array['id']);
select public._mt_swap_pk('push_settings',     array['id']);
select public._mt_swap_pk('payroll_periods',   array['period']);
select public._mt_swap_pk('special_leave_rules', array['kode']);

-- foreign key komposit yang tadi dilepas
do $$
begin
  if to_regclass('public.payroll_slips') is not null
     and not exists (select 1 from pg_constraint where conrelid = 'public.payroll_slips'::regclass and conname = 'payroll_slips_period_tenant_fk') then
    alter table public.payroll_slips
      add constraint payroll_slips_period_tenant_fk
      foreign key (tenant_id, period) references public.payroll_periods (tenant_id, period) on delete cascade;
  end if;

  if to_regclass('public.special_leave_rules') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leave_requests' and column_name = 'special_leave_code')
     and not exists (select 1 from pg_constraint where conrelid = 'public.leave_requests'::regclass and conname = 'leave_requests_special_leave_tenant_fk') then
    alter table public.leave_requests
      add constraint leave_requests_special_leave_tenant_fk
      foreign key (tenant_id, special_leave_code) references public.special_leave_rules (tenant_id, kode);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. FUNGSI YANG DITULIS ULANG AGAR SADAR TENANT
--    Fungsi "security definer" melewati RLS, jadi isolasi di dalamnya harus
--    ditulis manual. Tanpa ini, mis. fallback approver akan mengumpulkan
--    Super Admin dari SEMUA usaha.
-- ---------------------------------------------------------------------

-- 6a. Rantai approver: unit, role_permissions, dan fallback dibatasi ke
--     tenant pemohon.
create or replace function public.resolve_approval_chain(p_user uuid, p_levels integer, p_menu text)
returns table (r_step integer, r_unit uuid, r_ids uuid[], r_names text)
language plpgsql security definer stable set search_path = public as $$
declare
  v_tenant uuid;
  v_unit uuid;
  v_step integer := 0;
  v_used uuid[] := array[p_user];
  v_ids  uuid[];
  v_names text;
begin
  select tenant_id into v_tenant from public.profiles where id = p_user;
  if v_tenant is null then return; end if;

  select m.unit_id into v_unit
  from public.org_unit_members m
  join public.org_units u on u.id = m.unit_id
  where m.user_id = p_user and m.is_primary and u.is_active and u.tenant_id = v_tenant
  limit 1;

  while v_unit is not null and v_step < p_levels loop
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.org_unit_members m
    join public.profiles p on p.id = m.user_id
    where m.unit_id = v_unit
      and p.tenant_id = v_tenant
      and p.is_active
      and p.id <> all (v_used)
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr', 'admin_approval')
          and exists (
            select 1 from public.role_permissions rp
            where rp.tenant_id = v_tenant and rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );

    if v_ids is not null then
      v_step := v_step + 1;
      v_used := v_used || v_ids;
      r_step := v_step; r_unit := v_unit; r_ids := v_ids; r_names := v_names;
      return next;
    end if;

    select parent_id into v_unit from public.org_units where id = v_unit and tenant_id = v_tenant;
  end loop;

  -- Fallback: tidak ada approver di rantai -> Super Admin + staff yang berhak
  -- approve, HANYA di tenant yang sama.
  if v_step = 0 then
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.profiles p
    where p.tenant_id = v_tenant
      and p.is_active
      and p.id <> p_user
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr')
          and exists (
            select 1 from public.role_permissions rp
            where rp.tenant_id = v_tenant and rp.role = p.role and rp.menu_id = p_menu and rp.enabled
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
revoke execute on function public.resolve_approval_chain(uuid, integer, text) from public, anon, authenticated;

-- 6b. Pembentuk tahap approval. Versi gabungan (koreksi absen + notifikasi);
--     bagian notifikasi / koreksi dilewati otomatis kalau migrasinya belum
--     dijalankan di project kamu.
create or replace function public.create_approval_steps(
  p_kind text, p_request_id uuid, p_user uuid, p_setting_key text, p_menu text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_levels integer;
  v_count  integer := 0;
  v_role   text;
  v_name   text;
  v_has_notify boolean := to_regprocedure('public.notify_users(uuid[],text,text,text,text,uuid)') is not null;
  r record;
begin
  select tenant_id, full_name, role into v_tenant, v_name, v_role from public.profiles where id = p_user;
  if v_tenant is null then
    raise exception 'Pemohon tidak terdaftar di sebuah usaha';
  end if;

  select coalesce((
    select levels from public.approval_settings
    where tenant_id = v_tenant and request_type = p_setting_key
  ), 1) into v_levels;

  for r in select * from public.resolve_approval_chain(p_user, v_levels, p_menu) loop
    insert into public.request_approvals (tenant_id, request_type, request_id, step_order, unit_id, approver_ids, approver_names, status)
    values (v_tenant, p_kind, p_request_id, r.r_step, r.r_unit, r.r_ids, r.r_names,
            case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;

    if r.r_step = 1 and v_has_notify then
      perform public.notify_users(
        r.r_ids, 'approval_needed', 'Pengajuan menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' mengajukan ' || public.request_kind_label(p_kind) || '.',
        p_kind, p_request_id
      );
    end if;
  end loop;

  -- Tidak ada approver sama sekali: hanya disetujui otomatis kalau pemohonnya
  -- sendiri Super Admin (pemilik usaha).
  if v_count = 0 and v_role = 'super_admin' then
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
end;
$$;
revoke execute on function public.create_approval_steps(text, uuid, uuid, text, text) from public, anon, authenticated;

-- 6c. decide_approval & cancel_leave_request: isi fungsi LAMA (apa pun versi
--     yang terpasang di databasemu: gabungan koreksi/cuti/notifikasi) tidak
--     disentuh — hanya dibungkus. Fungsi aslinya diganti nama menjadi
--     _..._impl dan tidak bisa dipanggil langsung dari aplikasi; pembungkus
--     baru memastikan pengajuannya milik tenant si pemanggil.
do $$
declare v_src text;
begin
  if to_regprocedure('public.decide_approval(text,uuid,text,text)') is not null then
    select prosrc into v_src from pg_proc where oid = 'public.decide_approval(text,uuid,text,text)'::regprocedure;
    if v_src not like '%_decide_approval_impl%' then
      execute 'drop function if exists public._decide_approval_impl(text,uuid,text,text)';
      execute 'alter function public.decide_approval(text,uuid,text,text) rename to _decide_approval_impl';
    end if;
  end if;

  if to_regprocedure('public.cancel_leave_request(uuid,text)') is not null then
    select prosrc into v_src from pg_proc where oid = 'public.cancel_leave_request(uuid,text)'::regprocedure;
    if v_src not like '%_cancel_leave_request_impl%' then
      execute 'drop function if exists public._cancel_leave_request_impl(uuid,text)';
      execute 'alter function public.cancel_leave_request(uuid,text) rename to _cancel_leave_request_impl';
    end if;
  end if;
end $$;

create or replace function public.decide_approval(
  p_kind text, p_request_id uuid, p_decision text, p_notes text default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_tbl text;
  v_t   uuid;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  v_tbl := case p_kind
    when 'leave' then 'leave_requests'
    when 'overtime' then 'overtime_requests'
    when 'koreksi' then 'attendance_correction_requests'
    else null
  end;
  if v_tbl is null then raise exception 'Jenis pengajuan tidak valid'; end if;

  execute format('select tenant_id from public.%I where id = $1', v_tbl) into v_t using p_request_id;
  if v_t is null or v_t is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;

  return public._decide_approval_impl(p_kind, p_request_id, p_decision, p_notes);
end;
$$;

do $$
begin
  if to_regprocedure('public._decide_approval_impl(text,uuid,text,text)') is not null then
    execute 'revoke execute on function public._decide_approval_impl(text,uuid,text,text) from public, anon, authenticated';
  end if;

  if to_regprocedure('public._cancel_leave_request_impl(uuid,text)') is not null then
    execute $w$
      create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text)
      returns text language plpgsql security definer set search_path = public as $f$
      declare v_t uuid;
      begin
        if auth.uid() is null then raise exception 'Belum login'; end if;
        select tenant_id into v_t from public.leave_requests where id = p_request_id;
        if v_t is null or v_t is distinct from public.current_tenant_id() then
          raise exception 'Pengajuan tidak ditemukan';
        end if;
        return public._cancel_leave_request_impl(p_request_id, p_reason);
      end;
      $f$
    $w$;
    execute 'revoke execute on function public._cancel_leave_request_impl(uuid,text) from public, anon, authenticated';
    execute 'revoke execute on function public.cancel_leave_request(uuid,text) from public, anon';
    execute 'grant execute on function public.cancel_leave_request(uuid,text) to authenticated';
  end if;
end $$;

revoke execute on function public.decide_approval(text, uuid, text, text) from public, anon;
grant execute on function public.decide_approval(text, uuid, text, text) to authenticated;

-- 6d. set_member_role: tidak boleh menyentuh akun tenant lain.
create or replace function public.set_member_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller text := public.my_role();
  v_tenant uuid := public.current_tenant_id();
  v_old    text;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if v_tenant is null then raise exception 'Akun belum terdaftar di sebuah usaha'; end if;
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  if p_role not in ('karyawan', 'admin_approval', 'admin_hr', 'super_admin_hr', 'super_admin') then
    raise exception 'Role tidak valid';
  end if;
  if p_user = auth.uid() then
    raise exception 'Tidak bisa mengubah role diri sendiri';
  end if;

  select role into v_old from public.profiles where id = p_user and tenant_id = v_tenant;
  if v_old is null then raise exception 'Karyawan tidak ditemukan'; end if;
  if v_old = p_role then return; end if;

  if v_caller = 'super_admin' then
    null; -- pemilik usaha: bebas
  elsif v_caller in ('super_admin_hr', 'admin_hr') then
    if p_role = 'super_admin' or v_old = 'super_admin' then
      raise exception 'Role Super Admin hanya bisa diatur oleh Super Admin';
    end if;
  else
    if p_role not in ('karyawan', 'admin_approval') or v_old not in ('karyawan', 'admin_approval') then
      raise exception 'Role ini hanya bisa diatur oleh Admin HR ke atas';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user and tenant_id = v_tenant;
end;
$$;
revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- 6e. set_primary_unit: karyawan dan unit harus sama-sama milik tenant pemanggil.
create or replace function public.set_primary_unit(p_user uuid, p_unit uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'Akun belum terdaftar di sebuah usaha'; end if;
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and tenant_id = v_tenant)
     or not exists (select 1 from public.org_units where id = p_unit and tenant_id = v_tenant) then
    raise exception 'Karyawan atau unit tidak ditemukan';
  end if;

  update public.org_unit_members set is_primary = false
    where user_id = p_user and is_primary and unit_id <> p_unit;
  insert into public.org_unit_members (tenant_id, unit_id, user_id, is_primary)
    values (v_tenant, p_unit, p_user, true)
  on conflict (unit_id, user_id) do update set is_primary = true;
end;
$$;
grant execute on function public.set_primary_unit(uuid, uuid) to authenticated;

-- 6f. Validasi cuti khusus: aturan hari dibaca dari master MILIK TENANT.
do $$
begin
  if to_regprocedure('public.leave_before_insert_validate()') is not null then
    execute $w$
      create or replace function public.leave_before_insert_validate()
      returns trigger language plpgsql security definer set search_path = public as $f$
      declare
        v_days     integer;
        v_kuota    numeric;
        v_terpakai numeric;
        v_year     integer;
        v_tenant   uuid := coalesce(new.tenant_id, (select tenant_id from public.profiles where id = new.user_id));
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
          select jumlah_hari into v_days from public.special_leave_rules
            where kode = new.special_leave_code and tenant_id = v_tenant;
          if v_days is null then
            raise exception 'Jenis cuti khusus tidak valid';
          end if;
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
      $f$
    $w$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. PEMBUATAN AKUN BARU (handle_new_user)
--    tenant_id HANYA dipercaya dari raw_app_meta_data (cuma bisa ditulis
--    service role / Admin API) — TIDAK PERNAH dari raw_user_meta_data,
--    karena anon key itu publik dan siapa pun bisa memanggil auth.signUp
--    dengan metadata apa saja.
--      public_mode = false : tanpa tenant di app_metadata -> masuk tenant
--                            bawaan (perilaku lama, aplikasi tetap jalan).
--      public_mode = true  : tanpa tenant -> profil TIDAK dibuat; orang itu
--                            memanggil register_tenant() untuk membuat
--                            usahanya sendiri, atau dibuatkan lewat Edge
--                            Function (Tahap 2) yang mengisi app_metadata.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  begin
    v_tenant := nullif(new.raw_app_meta_data->>'tenant_id', '')::uuid;
  exception when others then
    v_tenant := null;
  end;

  if v_tenant is null and not public.platform_public_mode() then
    select default_tenant_id into v_tenant from public.platform_settings where id = 1;
  end if;

  if v_tenant is null then
    return new;  -- mode publik: profil dibuat lewat register_tenant()
  end if;

  if not exists (select 1 from public.tenants where id = v_tenant and status <> 'suspended') then
    raise exception 'Usaha tidak ditemukan atau sedang dinonaktifkan';
  end if;

  insert into public.profiles (id, tenant_id, full_name, role, employee_code, email)
  values (
    new.id,
    v_tenant,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'karyawan',   -- role TIDAK PERNAH dipercaya dari metadata
    new.raw_user_meta_data->>'employee_code',
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Batas jumlah karyawan per tenant (tenants.max_karyawan; NULL = tanpa batas).
create or replace function public.tg_profiles_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_max integer; v_cnt integer;
begin
  select max_karyawan into v_max from public.tenants where id = new.tenant_id;
  if v_max is not null then
    select count(*) into v_cnt from public.profiles where tenant_id = new.tenant_id;
    if v_cnt >= v_max then
      raise exception 'Batas jumlah karyawan untuk paket ini sudah tercapai (maks. %).', v_max;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists aa_profiles_limit on public.profiles;
create trigger aa_profiles_limit before insert on public.profiles
  for each row execute function public.tg_profiles_limit();

-- ---------------------------------------------------------------------
-- 8. TEMPLATE DEFAULT UNTUK USAHA BARU
--    role_permission_defaults = salinan awal hak menu per role (diambil dari
--    pengaturan tenant bawaan saat migrasi ini pertama dijalankan). Edit
--    tabel ini kapan saja untuk mengubah default usaha-usaha BARU (tidak
--    memengaruhi tenant yang sudah ada). Tahap 4 akan menambah template
--    ringkas khusus UMKM (2 role).
-- ---------------------------------------------------------------------
create table if not exists public.role_permission_defaults (
  role     text not null,
  menu_id  text not null,
  enabled  boolean not null default false,
  primary key (role, menu_id)
);

insert into public.role_permission_defaults (role, menu_id, enabled)
select rp.role, rp.menu_id, rp.enabled
from public.role_permissions rp
where rp.tenant_id = (select default_tenant_id from public.platform_settings where id = 1)
  and not exists (select 1 from public.role_permission_defaults)
on conflict do nothing;

create or replace function public.seed_tenant_defaults(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions (tenant_id, role, menu_id, enabled)
  select p_tenant, d.role, d.menu_id, d.enabled from public.role_permission_defaults d
  on conflict (tenant_id, role, menu_id) do nothing;

  insert into public.payroll_settings (tenant_id, id, cutoff_start_day)
  values (p_tenant, 1, 1) on conflict (tenant_id, id) do nothing;

  if to_regclass('public.push_settings') is not null then
    execute 'insert into public.push_settings (tenant_id, id, reminders_enabled) values ($1, 1, true) on conflict (tenant_id, id) do nothing'
      using p_tenant;
  end if;

  insert into public.approval_settings (tenant_id, request_type, levels)
  values (p_tenant, 'izin', 1), (p_tenant, 'sakit', 1), (p_tenant, 'cuti', 1), (p_tenant, 'lembur', 1)
  on conflict (tenant_id, request_type) do nothing;
  begin
    insert into public.approval_settings (tenant_id, request_type, levels)
    values (p_tenant, 'koreksi', 1) on conflict (tenant_id, request_type) do nothing;
  exception when check_violation then
    null;  -- migrasi koreksi absen belum dijalankan di project ini
  end;

  insert into public.allowance_types (tenant_id, nama, keterangan) values
    (p_tenant, 'Tunjangan Jabatan', 'Tunjangan sesuai jabatan/tanggung jawab karyawan'),
    (p_tenant, 'Tunjangan Loyalitas', 'Tunjangan berdasarkan masa kerja/loyalitas karyawan')
  on conflict (tenant_id, nama) do nothing;

  if to_regclass('public.special_leave_rules') is not null then
    execute $q$
      insert into public.special_leave_rules (tenant_id, kode, label, jumlah_hari, sort_order) values
        ($1, 'nikah_sendiri', 'Pekerja Menikah', 3, 1),
        ($1, 'menikahkan_anak', 'Menikahkan Anak', 2, 2),
        ($1, 'mengkhitankan_anak', 'Mengkhitankan Anak', 2, 3),
        ($1, 'membaptiskan_anak', 'Membaptiskan Anak', 2, 4),
        ($1, 'istri_melahirkan', 'Istri Melahirkan atau Keguguran Kandungan', 2, 5),
        ($1, 'keluarga_inti_meninggal', 'Anggota Keluarga Inti Meninggal Dunia (Suami/Istri, Orang Tua/Mertua, Anak, atau Menantu)', 2, 6),
        ($1, 'keluarga_serumah_meninggal', 'Anggota Keluarga dalam Satu Rumah Meninggal Dunia', 1, 7)
      on conflict (tenant_id, kode) do nothing
    $q$ using p_tenant;
  end if;

  insert into public.late_penalty_rules (tenant_id, day_type, jenis, menit_offset, tipe, nominal, persen, label) values
    (p_tenant, 'weekday',  'telat',        0,   'flat',    50000, 0,   'Telat > 0 menit dari jam masuk'),
    (p_tenant, 'weekday',  'telat',        120, 'percent', 0,     50,  'Telat > 2 jam dari jam masuk (50% denda)'),
    (p_tenant, 'weekday',  'telat',        240, 'percent', 0,     100, 'Telat > 4 jam dari jam masuk (100% denda)'),
    (p_tenant, 'saturday', 'telat',        0,   'flat',    50000, 0,   'Telat > 0 menit dari jam masuk'),
    (p_tenant, 'saturday', 'telat',        60,  'percent', 0,     50,  'Telat > 1 jam dari jam masuk (50% denda)'),
    (p_tenant, 'saturday', 'telat',        120, 'percent', 0,     100, 'Telat > 2 jam dari jam masuk (100% denda)'),
    (p_tenant, 'weekday',  'pulang_cepat', 240, 'percent', 0,     100, 'Pulang > 4 jam sebelum jam pulang (100% denda)'),
    (p_tenant, 'weekday',  'pulang_cepat', 180, 'percent', 0,     50,  'Pulang 3-4 jam sebelum jam pulang (50% denda)'),
    (p_tenant, 'saturday', 'pulang_cepat', 120, 'percent', 0,     100, 'Pulang > 2 jam sebelum jam pulang (100% denda)'),
    (p_tenant, 'saturday', 'pulang_cepat', 60,  'percent', 0,     50,  'Pulang 1-2 jam sebelum jam pulang (50% denda)')
  on conflict (tenant_id, day_type, jenis, menit_offset) do nothing;
end;
$$;
revoke execute on function public.seed_tenant_defaults(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. ONBOARDING USAHA BARU
-- ---------------------------------------------------------------------
create or replace function public._mt_make_kode(p_text text)
returns text language plpgsql as $$
declare v text;
begin
  v := left(lower(regexp_replace(coalesce(p_text, ''), '[^a-zA-Z0-9]+', '', 'g')), 20);
  if length(v) < 3 then v := v || substr(md5(random()::text), 1, 4); end if;
  while exists (select 1 from public.tenants where lower(kode) = v) loop
    v := left(v, 16) || substr(md5(random()::text), 1, 4);
  end loop;
  return v;
end;
$$;

-- INTERNAL (tidak bisa dipanggil dari aplikasi): membuat tenant + menjadikan
-- p_owner sebagai Super Admin (pemilik) tenant itu + mengisi default.
-- Kalau profil p_owner SUDAH ada, profil itu DIPINDAHKAN ke tenant baru —
-- hanya aman untuk akun baru tanpa data (dipakai untuk uji coba di SQL Editor).
create or replace function public.create_tenant_for_owner(
  p_nama text, p_kode text, p_owner uuid, p_full_name text,
  p_plan text default 'free', p_max_karyawan integer default 10
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_email  text;
begin
  if coalesce(trim(p_nama), '') = '' then
    raise exception 'Nama usaha wajib diisi';
  end if;
  select email into v_email from auth.users where id = p_owner;
  if v_email is null and not exists (select 1 from auth.users where id = p_owner) then
    raise exception 'Akun pemilik tidak ditemukan';
  end if;

  insert into public.tenants (kode, nama, plan, status, max_karyawan, owner_id)
  values (public._mt_make_kode(coalesce(nullif(trim(p_kode), ''), p_nama)), trim(p_nama), p_plan, 'active', p_max_karyawan, p_owner)
  returning id into v_tenant;

  if exists (select 1 from public.profiles where id = p_owner) then
    update public.profiles set tenant_id = v_tenant, role = 'super_admin' where id = p_owner;
  else
    insert into public.profiles (id, tenant_id, full_name, role, email)
    values (p_owner, v_tenant, coalesce(nullif(trim(p_full_name), ''), v_email, 'Pemilik'), 'super_admin', v_email);
  end if;

  perform public.seed_tenant_defaults(v_tenant);
  return v_tenant;
end;
$$;
revoke execute on function public.create_tenant_for_owner(text, text, uuid, text, text, integer) from public, anon, authenticated;

-- Dipanggil aplikasi setelah pendaftar login: membuat usahanya sendiri.
-- TERKUNCI selama platform_settings.public_mode = false.
create or replace function public.register_tenant(p_nama_usaha text, p_full_name text, p_kode text default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not public.platform_public_mode() then
    raise exception 'Pendaftaran usaha baru belum dibuka';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Akun ini sudah terdaftar di sebuah usaha';
  end if;
  return public.create_tenant_for_owner(p_nama_usaha, p_kode, auth.uid(), p_full_name, 'free', 10);
end;
$$;
revoke execute on function public.register_tenant(text, text, text) from public, anon;
grant execute on function public.register_tenant(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 10. KUNCI TABEL PLATFORM
-- ---------------------------------------------------------------------
drop trigger if exists trg_tenants_updated_at on public.tenants;
create trigger trg_tenants_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();

alter table public.tenants enable row level security;
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select using ( id = (select public.current_tenant_id()) or public.is_platform_admin() );

-- Pemilik usaha hanya boleh mengganti NAMA usahanya (grant kolom di bawah);
-- plan/status/batas karyawan hanya lewat SQL Editor / service role.
drop policy if exists tenants_update_owner on public.tenants;
create policy tenants_update_owner on public.tenants
  for update
  using ( id = (select public.current_tenant_id()) and public.is_super() )
  with check ( id = (select public.current_tenant_id()) and public.is_super() );

revoke all on public.tenants from anon, authenticated;
grant select on public.tenants to authenticated;
grant update (nama) on public.tenants to authenticated;

alter table public.platform_admins enable row level security;
alter table public.platform_settings enable row level security;
alter table public.role_permission_defaults enable row level security;
revoke all on public.platform_admins from anon, authenticated;
revoke all on public.platform_settings from anon, authenticated;
revoke all on public.role_permission_defaults from anon, authenticated;
-- (tanpa policy = hanya SQL Editor / service role / fungsi security definer)

-- ---------------------------------------------------------------------
-- 11. FOTO ABSENSI (storage) — DISENGAJA BELUM DIUBAH DI TAHAP 1
--     Bucket `attendance-photos` masih publik, URL foto lama tersimpan
--     sebagai URL publik di database. Mengubahnya butuh perubahan JS
--     (signed URL + path berawalan tenant_id), jadi dikerjakan di Tahap 3.
--     Sampai saat itu: JANGAN buka pendaftaran publik (public_mode).
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 12. PEMERIKSAAN AKHIR
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  v_null bigint;
  v_total integer := 0;
  v_rls_off text := '';
begin
  foreach t in array public._mt_tables() loop
    if to_regclass('public.' || t) is null then continue; end if;
    v_total := v_total + 1;
    execute format('select count(*) from public.%I where tenant_id is null', t) into v_null;
    if v_null > 0 then
      raise exception 'Tabel % masih punya % baris tanpa tenant_id', t, v_null;
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'tenant_isolation' and permissive = 'RESTRICTIVE'
    ) then
      v_rls_off := v_rls_off || t || ' ';
    end if;
  end loop;
  if v_rls_off <> '' then
    raise exception 'Policy tenant_isolation belum terpasang di: %', v_rls_off;
  end if;
  raise notice 'OK — % tabel diisolasi per tenant. Tenant bawaan: %',
    v_total, (select nama from public.tenants where id = (select default_tenant_id from public.platform_settings where id = 1));
end $$;

-- helper sementara tidak dibutuhkan lagi
drop function if exists public._mt_make_tenant_unique(text, text[]);
drop function if exists public._mt_swap_pk(text, text[]);

commit;
