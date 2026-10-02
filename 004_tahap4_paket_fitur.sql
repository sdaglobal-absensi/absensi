-- =====================================================================
-- TAHAP 4 — Paket & Fitur per usaha, template UMKM (2 role), modul opsional
-- =====================================================================
-- Jalankan SETELAH 001, 002 dan 003. Aman dijalankan dua kali.
-- Satu transaksi: kalau ada error, semuanya dibatalkan.
--
-- Isi:
--   1. Katalog fitur (feature_catalog) + pemetaan menu -> fitur (menu_features)
--   2. Paket (plans) + override per usaha (tenant_features)
--   3. Fungsi: effective_features(), tenant_has_feature(), menu_in_plan(),
--      my_plan_info()  (dipakai aplikasi untuk menyaring menu)
--   4. has_menu_access() ikut memeriksa paket  -> fitur dikunci di SERVER,
--      bukan cuma disembunyikan di sidebar
--   5. Policy RLS "feature_gate" (restrictive) di tabel milik fitur berbayar
--   6. Template ringkas UMKM: tenants.role_mode ('lengkap' | 'ringkas'),
--      trigger yang menolak role selain Pemilik & Karyawan di mode ringkas
--   7. create_tenant_for_owner / register_tenant memakai paket + template
--   8. Helper untuk pemilik platform (hanya SQL Editor / service role):
--      platform_set_plan, platform_set_feature, platform_clear_feature,
--      platform_set_role_mode, platform_tenant_overview
--
-- Yang TIDAK berubah: usaha utama (paket 'internal') tetap memegang SEMUA
-- fitur dan role_mode 'lengkap', jadi perilakunya sama seperti sekarang.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. KATALOG FITUR
--    Fitur "dasar" TIDAK ada di katalog: selalu aktif di semua paket
--    (profil, absensi, riwayat, data karyawan, monitor absensi, master
--    lokasi/jadwal/libur/level/departemen, laporan, approval perubahan
--    data, pengaturan sistem, paket).
-- ---------------------------------------------------------------------
create table if not exists public.feature_catalog (
  kode       text primary key check (kode ~ '^[a-z0-9_]+$'),
  nama       text not null,
  deskripsi  text,
  requires   text[] not null default '{}',   -- fitur lain yang harus ikut aktif
  sort_order integer not null default 0
);

insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('izin_cuti',      'Izin, Sakit & Cuti',          'Pengajuan dan approval izin/sakit/cuti, kuota cuti tahunan dan cuti khusus', '{}', 10),
  ('koreksi_absen',  'Koreksi Absen',               'Karyawan mengajukan koreksi lupa absen masuk/pulang, atasan menyetujui',    '{}', 20),
  ('lembur',         'Lembur',                      'Pengajuan dan approval lembur',                                              '{}', 30),
  ('struktur',       'Struktur Organisasi',         'Unit, anggota, dan rantai approval berjenjang',                              '{}', 40),
  ('payroll',        'Slip Gaji & Payroll',         'Slip gaji, tunjangan, denda telat, kenaikan upah',                           '{}', 50),
  ('audit_ekspor',   'Audit Log & Ekspor',          'Riwayat perubahan data dan unduh backup Excel/JSON',                         '{}', 60),
  ('vendor_invoice', 'Vendor & Invoice Outsourcing','Master PT/Vendor dan pencocokan invoice outsourcing',                        '{payroll}', 70)
on conflict (kode) do nothing;

-- Menu yang dikunci oleh sebuah fitur. Menu yang tidak ada di tabel ini
-- (termasuk semua menu "dasar") selalu lolos pemeriksaan paket.
create table if not exists public.menu_features (
  menu_id text primary key,
  feature text not null references public.feature_catalog(kode) on update cascade on delete cascade
);

insert into public.menu_features (menu_id, feature) values
  ('izin',                'izin_cuti'),
  ('izin-approval',       'izin_cuti'),
  ('kuota-cuti',          'izin_cuti'),
  ('koreksi',             'koreksi_absen'),
  ('koreksi-approval',    'koreksi_absen'),
  ('lembur',              'lembur'),
  ('lembur-approval',     'lembur'),
  ('struktur-organisasi', 'struktur'),
  ('struktur-kelola',     'struktur'),
  ('slip-gaji',           'payroll'),
  ('slip-gaji-saya',      'payroll'),
  ('kenaikan-upah',       'payroll'),
  ('master-tunjangan',    'payroll'),
  ('master-denda',        'payroll'),
  ('audit-log',           'audit_ekspor'),
  ('ekspor-backup',       'audit_ekspor'),
  ('master-pt',           'vendor_invoice'),
  ('invoice-outsourcing', 'vendor_invoice')
on conflict (menu_id) do nothing;

-- ---------------------------------------------------------------------
-- 2. PAKET + OVERRIDE PER USAHA
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  kode         text primary key check (kode ~ '^[a-z0-9_]+$'),
  nama         text not null,
  deskripsi    text,
  max_karyawan integer check (max_karyawan is null or max_karyawan > 0),  -- NULL = tanpa batas
  features     text[] not null default '{}',
  sort_order   integer not null default 0,
  is_active    boolean not null default true
);

-- Isi awal. Ubah angkanya kapan saja lewat SQL Editor (tidak ditimpa kalau
-- skrip ini dijalankan ulang). Usaha yang sudah memakai paket tidak ikut
-- berubah batas karyawannya sampai kamu memanggil platform_set_plan().
insert into public.plans (kode, nama, deskripsi, max_karyawan, features, sort_order) values
  ('free',       'Gratis',      'Absensi, izin/cuti, dan koreksi absen untuk usaha kecil',           10,   '{izin_cuti,koreksi_absen}', 10),
  ('bisnis',     'Bisnis',      'Ditambah lembur, struktur organisasi, slip gaji, audit log & ekspor', 50,   '{izin_cuti,koreksi_absen,lembur,struktur,payroll,audit_ekspor}', 20),
  ('enterprise', 'Enterprise',  'Semua fitur, termasuk Master PT/Vendor dan invoice outsourcing',    null, '{izin_cuti,koreksi_absen,lembur,struktur,payroll,audit_ekspor,vendor_invoice}', 30),
  ('internal',   'Internal',    'Usaha utama pemilik aplikasi — semua fitur, tanpa batas',           null, '{izin_cuti,koreksi_absen,lembur,struktur,payroll,audit_ekspor,vendor_invoice}', 99)
on conflict (kode) do nothing;

create table if not exists public.tenant_features (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  feature    text not null references public.feature_catalog(kode) on update cascade on delete cascade,
  enabled    boolean not null,           -- true = tambahan di luar paket, false = dicabut dari paket
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature)
);

-- Kolom tenants: mode role (template UMKM).
alter table public.tenants
  add column if not exists role_mode text not null default 'lengkap';
alter table public.tenants drop constraint if exists tenants_role_mode_check;
alter table public.tenants
  add constraint tenants_role_mode_check check (role_mode in ('lengkap', 'ringkas'));

-- tenants.plan sebelumnya teks bebas. Rapikan lalu kunci ke tabel plans.
do $$
declare v_default uuid; v_n integer;
begin
  select default_tenant_id into v_default from public.platform_settings where id = 1;
  update public.tenants set plan = 'internal'
   where id = v_default and plan not in (select kode from public.plans);
  update public.tenants set plan = 'free'
   where plan not in (select kode from public.plans);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    raise notice '% usaha dengan nama paket tak dikenal dipindah ke paket "free"', v_n;
  end if;
end $$;

alter table public.tenants drop constraint if exists tenants_plan_fkey;
alter table public.tenants
  add constraint tenants_plan_fkey foreign key (plan) references public.plans(kode) on update cascade;

-- Tabel konfigurasi ini hanya dibaca lewat fungsi (my_plan_info) dan diubah
-- lewat SQL Editor / service role. Tidak ada akses langsung dari aplikasi.
alter table public.feature_catalog  enable row level security;
alter table public.menu_features    enable row level security;
alter table public.plans            enable row level security;
alter table public.tenant_features  enable row level security;
revoke all on public.feature_catalog, public.menu_features, public.plans, public.tenant_features
  from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. FUNGSI PEMERIKSA FITUR
-- ---------------------------------------------------------------------
-- Fitur efektif sebuah usaha = fitur paket + tambahan - yang dicabut.
create or replace function public.effective_features(p_tenant uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(f order by f), '{}'::text[])
  from (
    select unnest(coalesce(
             (select p.features from public.tenants t join public.plans p on p.kode = t.plan where t.id = p_tenant),
             '{}'::text[])) as f
    union
    select tf.feature from public.tenant_features tf where tf.tenant_id = p_tenant and tf.enabled
  ) x
  where x.f not in (select tf.feature from public.tenant_features tf where tf.tenant_id = p_tenant and not tf.enabled);
$$;
revoke execute on function public.effective_features(uuid) from public, anon, authenticated;

create or replace function public.tenant_has_feature(p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_feature = any(public.effective_features(public.current_tenant_id())), false);
$$;
revoke execute on function public.tenant_has_feature(text) from public, anon;
grant execute on function public.tenant_has_feature(text) to authenticated;

-- true kalau menu itu termasuk paket usaha pemanggil (atau menu "dasar").
create or replace function public.menu_in_plan(p_menu_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select public.tenant_has_feature(mf.feature) from public.menu_features mf where mf.menu_id = p_menu_id),
    true);
$$;
revoke execute on function public.menu_in_plan(text) from public, anon;
grant execute on function public.menu_in_plan(text) to authenticated;

-- Info paket untuk aplikasi (sidebar, halaman Paket & Fitur).
create or replace function public.my_plan_info()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_t       uuid := public.current_tenant_id();
  v_feat    text[];
  v_blocked text[];
  v_cnt     integer;
  r         record;
begin
  if auth.uid() is null or v_t is null then
    raise exception 'Belum login atau belum terdaftar di sebuah usaha';
  end if;
  v_feat := public.effective_features(v_t);
  select coalesce(array_agg(menu_id order by menu_id), '{}'::text[]) into v_blocked
    from public.menu_features where not (feature = any(v_feat));
  select count(*) into v_cnt from public.profiles where tenant_id = v_t;
  select t.plan, p.nama as plan_nama, t.status, t.role_mode, t.max_karyawan, t.trial_ends_at
    into r
    from public.tenants t left join public.plans p on p.kode = t.plan
   where t.id = v_t;

  return jsonb_build_object(
    'plan',            r.plan,
    'plan_nama',       r.plan_nama,
    'status',          r.status,
    'role_mode',       r.role_mode,
    'max_karyawan',    r.max_karyawan,
    'karyawan_count',  v_cnt,
    'trial_ends_at',   r.trial_ends_at,
    'features',        to_jsonb(v_feat),
    'blocked_menus',   to_jsonb(v_blocked),
    'catalog', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kode', c.kode, 'nama', c.nama, 'deskripsi', c.deskripsi,
               'included', c.kode = any(v_feat)) order by c.sort_order), '[]'::jsonb)
        from public.feature_catalog c)
  );
end;
$$;
revoke execute on function public.my_plan_info() from public, anon;
grant execute on function public.my_plan_info() to authenticated;

-- ---------------------------------------------------------------------
-- 4. has_menu_access() IKUT MEMERIKSA PAKET
--    Versi 001 + syarat menu_in_plan(). Super Admin tetap melewati toggle
--    role, tetapi TIDAK melewati paket (fitur di luar paket memang tak ada).
-- ---------------------------------------------------------------------
create or replace function public.has_menu_access(p_menu_id text)
returns boolean language sql security definer stable set search_path = public as $$
  select
    public.menu_in_plan(p_menu_id)
    and (
      public.is_super()
      or coalesce((
        select rp.enabled from public.role_permissions rp
        where rp.tenant_id = public.current_tenant_id()
          and rp.role = public.my_role()
          and rp.menu_id = p_menu_id
      ), false)
    );
$$;

-- ---------------------------------------------------------------------
-- 5. GERBANG DI TABEL (RLS restrictive, di-AND dengan semua policy lain)
--    Data tidak dihapus saat paket turun: hanya tidak bisa dibaca/ditulis
--    sampai fiturnya aktif lagi. Edge Function (service role) dan fungsi
--    security definer tidak terpengaruh.
--    audit_log: hanya SELECT yang dikunci, supaya pencatatan tetap jalan.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
    ('izin_cuti',      'leave_requests',                'all'),
    ('izin_cuti',      'leave_balances',                'all'),
    ('izin_cuti',      'special_leave_rules',           'all'),
    ('koreksi_absen',  'attendance_correction_requests','all'),
    ('lembur',         'overtime_requests',             'all'),
    ('payroll',        'payroll_slips',                 'all'),
    ('payroll',        'payroll_periods',               'all'),
    ('payroll',        'payroll_adjustments',           'all'),
    ('payroll',        'wage_history',                  'all'),
    ('payroll',        'salary_history',                'all'),
    ('payroll',        'employee_allowances',           'all'),
    ('payroll',        'allowance_types',               'all'),
    ('payroll',        'late_penalty_rules',            'all'),
    ('audit_ekspor',   'audit_log',                     'select'),
    ('vendor_invoice', 'outsourcing_invoices',          'all'),
    ('vendor_invoice', 'outsourcing_area_invoices',     'all')
  ) as x(feature, tbl, cmd)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'Tabel % tidak ada, dilewati', r.tbl;
      continue;
    end if;
    execute format('drop policy if exists feature_gate on public.%I', r.tbl);
    if r.cmd = 'all' then
      execute format(
        'create policy feature_gate on public.%I as restrictive for all to authenticated
           using ((select public.tenant_has_feature(%L)))
           with check ((select public.tenant_has_feature(%L)))', r.tbl, r.feature, r.feature);
    else
      execute format(
        'create policy feature_gate on public.%I as restrictive for select to authenticated
           using ((select public.tenant_has_feature(%L)))', r.tbl, r.feature);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. TEMPLATE RINGKAS UMKM (2 ROLE)
--    role_mode = 'ringkas'  -> hanya Pemilik (super_admin) dan karyawan.
--    Role lain ditolak di database, apa pun jalurnya (aplikasi, Edge
--    Function, Excel, SQL).
-- ---------------------------------------------------------------------
create or replace function public.tg_profiles_role_mode()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role not in ('super_admin', 'karyawan')
     and exists (select 1 from public.tenants where id = new.tenant_id and role_mode = 'ringkas') then
    raise exception 'Usaha ini memakai template ringkas: hanya ada 2 role, Pemilik (Super Admin) dan Karyawan.';
  end if;
  return new;
end;
$$;
drop trigger if exists ab_profiles_role_mode on public.profiles;
create trigger ab_profiles_role_mode before insert or update of role, tenant_id on public.profiles
  for each row execute function public.tg_profiles_role_mode();

-- Mengisi hak menu usaha baru menurut template. 'lengkap' = perilaku lama
-- (salinan role_permission_defaults). 'ringkas' = karyawan hanya menu pribadi,
-- role lain mati semua.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya'];
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

-- ---------------------------------------------------------------------
-- 7. ONBOARDING USAHA BARU: paket + template
--    Tanda tangan fungsi berubah (tambah p_template), jadi versi lama dibuang.
-- ---------------------------------------------------------------------
drop function if exists public.create_tenant_for_owner(text, text, uuid, text, text, integer);

create or replace function public.create_tenant_for_owner(
  p_nama text, p_kode text, p_owner uuid, p_full_name text,
  p_plan text default 'free', p_max_karyawan integer default null,
  p_template text default 'ringkas'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_email  text;
  v_plan   public.plans%rowtype;
begin
  if coalesce(trim(p_nama), '') = '' then
    raise exception 'Nama usaha wajib diisi';
  end if;
  select * into v_plan from public.plans where kode = p_plan and is_active;
  if not found then
    raise exception 'Paket "%" tidak ada atau tidak aktif', p_plan;
  end if;
  select email into v_email from auth.users where id = p_owner;
  if v_email is null and not exists (select 1 from auth.users where id = p_owner) then
    raise exception 'Akun pemilik tidak ditemukan';
  end if;

  insert into public.tenants (kode, nama, plan, status, max_karyawan, owner_id)
  values (public._mt_make_kode(coalesce(nullif(trim(p_kode), ''), p_nama)), trim(p_nama), v_plan.kode, 'active',
          coalesce(p_max_karyawan, v_plan.max_karyawan), p_owner)
  returning id into v_tenant;

  if exists (select 1 from public.profiles where id = p_owner) then
    update public.profiles set tenant_id = v_tenant, role = 'super_admin' where id = p_owner;
  else
    insert into public.profiles (id, tenant_id, full_name, role, email)
    values (p_owner, v_tenant, coalesce(nullif(trim(p_full_name), ''), v_email, 'Pemilik'), 'super_admin', v_email);
  end if;

  perform public.seed_tenant_defaults(v_tenant);
  perform public.seed_tenant_template(v_tenant, p_template);
  return v_tenant;
end;
$$;
revoke execute on function public.create_tenant_for_owner(text, text, uuid, text, text, integer, text)
  from public, anon, authenticated;

-- Pendaftaran publik: paket Gratis + template ringkas.
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
  return public.create_tenant_for_owner(p_nama_usaha, p_kode, auth.uid(), p_full_name, 'free', null, 'ringkas');
end;
$$;
revoke execute on function public.register_tenant(text, text, text) from public, anon;
grant execute on function public.register_tenant(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. HELPER PEMILIK PLATFORM
--    Hanya bisa dipanggil dari SQL Editor / service role (tidak dari aplikasi).
--    Contoh:
--      select * from platform_tenant_overview();
--      select platform_set_plan('tokouji', 'bisnis');
--      select platform_set_feature('tokouji', 'lembur', true);   -- tambahan di luar paket
--      select platform_clear_feature('tokouji', 'lembur');       -- kembali ke aturan paket
--      select platform_set_role_mode('tokouji', 'ringkas', true);
-- ---------------------------------------------------------------------
create or replace function public._tenant_by_kode(p_kode text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from public.tenants where lower(kode) = lower(coalesce(p_kode, ''));
  if v is null then raise exception 'Usaha dengan kode "%" tidak ditemukan', p_kode; end if;
  return v;
end;
$$;
revoke execute on function public._tenant_by_kode(text) from public, anon, authenticated;

-- Tolak kombinasi fitur yang melanggar "requires" (mis. vendor_invoice tanpa payroll).
create or replace function public._check_feature_deps(p_tenant uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_eff text[] := public.effective_features(p_tenant); r record;
begin
  select c.kode, c.requires into r from public.feature_catalog c
   where c.kode = any(v_eff) and not (c.requires <@ v_eff) limit 1;
  if found then
    raise exception 'Fitur "%" membutuhkan fitur % yang belum aktif', r.kode, r.requires;
  end if;
end;
$$;
revoke execute on function public._check_feature_deps(uuid) from public, anon, authenticated;

create or replace function public.platform_set_plan(p_kode text, p_plan text, p_keep_limit boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid := public._tenant_by_kode(p_kode); v_p public.plans%rowtype; v_cnt integer;
begin
  select * into v_p from public.plans where kode = p_plan and is_active;
  if not found then raise exception 'Paket "%" tidak ada atau tidak aktif', p_plan; end if;
  if p_keep_limit then
    update public.tenants set plan = v_p.kode where id = v_t;
  else
    select count(*) into v_cnt from public.profiles where tenant_id = v_t;
    if v_p.max_karyawan is not null and v_cnt > v_p.max_karyawan then
      raise exception 'Usaha % punya % karyawan, melebihi batas paket % (%). Kurangi karyawan, atau pakai p_keep_limit => true untuk mempertahankan batas lama.',
        p_kode, v_cnt, v_p.kode, v_p.max_karyawan;
    end if;
    update public.tenants set plan = v_p.kode, max_karyawan = v_p.max_karyawan where id = v_t;
  end if;
  perform public._check_feature_deps(v_t);
end;
$$;
revoke execute on function public.platform_set_plan(text, text, boolean) from public, anon, authenticated;

create or replace function public.platform_set_feature(p_kode text, p_feature text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid := public._tenant_by_kode(p_kode);
begin
  if not exists (select 1 from public.feature_catalog where kode = p_feature) then
    raise exception 'Fitur "%" tidak ada di katalog', p_feature;
  end if;
  insert into public.tenant_features (tenant_id, feature, enabled) values (v_t, p_feature, p_enabled)
  on conflict (tenant_id, feature) do update set enabled = excluded.enabled, updated_at = now();
  perform public._check_feature_deps(v_t);
end;
$$;
revoke execute on function public.platform_set_feature(text, text, boolean) from public, anon, authenticated;

create or replace function public.platform_clear_feature(p_kode text, p_feature text)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid := public._tenant_by_kode(p_kode);
begin
  delete from public.tenant_features where tenant_id = v_t and feature = p_feature;
  perform public._check_feature_deps(v_t);
end;
$$;
revoke execute on function public.platform_clear_feature(text, text) from public, anon, authenticated;

create or replace function public.platform_set_role_mode(p_kode text, p_mode text, p_convert boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid := public._tenant_by_kode(p_kode); v_n integer;
begin
  if p_mode not in ('lengkap', 'ringkas') then
    raise exception 'Mode harus "lengkap" atau "ringkas"';
  end if;
  if p_mode = 'ringkas' then
    select count(*) into v_n from public.profiles
     where tenant_id = v_t and role not in ('super_admin', 'karyawan');
    if v_n > 0 and not p_convert then
      raise exception 'Ada % anggota dengan role selain Pemilik/Karyawan. Pakai p_convert => true untuk menjadikan mereka Karyawan.', v_n;
    end if;
    update public.profiles set role = 'karyawan'
     where tenant_id = v_t and role not in ('super_admin', 'karyawan');
  end if;
  update public.tenants set role_mode = p_mode where id = v_t;
end;
$$;
revoke execute on function public.platform_set_role_mode(text, text, boolean) from public, anon, authenticated;

create or replace function public.platform_tenant_overview()
returns table (kode text, nama text, status text, plan text, role_mode text,
               max_karyawan integer, karyawan bigint, fitur text[], override jsonb)
language sql stable security definer set search_path = public as $$
  select t.kode, t.nama, t.status, t.plan, t.role_mode, t.max_karyawan,
         (select count(*) from public.profiles p where p.tenant_id = t.id),
         public.effective_features(t.id),
         coalesce((select jsonb_object_agg(tf.feature, tf.enabled) from public.tenant_features tf where tf.tenant_id = t.id), '{}'::jsonb)
  from public.tenants t order by t.created_at;
$$;
revoke execute on function public.platform_tenant_overview() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. PEMERIKSAAN AKHIR
-- ---------------------------------------------------------------------
do $$
declare v_default uuid; v_feat text[];
begin
  select default_tenant_id into v_default from public.platform_settings where id = 1;
  v_feat := public.effective_features(v_default);
  if array_length(v_feat, 1) is distinct from (select count(*)::int from public.feature_catalog) then
    raise exception 'Usaha utama tidak memegang semua fitur (%): cek tabel plans', v_feat;
  end if;
  raise notice 'OK — Tahap 4 (SQL) terpasang. Usaha utama: paket "%", % fitur aktif.',
    (select plan from public.tenants where id = v_default), array_length(v_feat, 1);
end $$;

commit;
