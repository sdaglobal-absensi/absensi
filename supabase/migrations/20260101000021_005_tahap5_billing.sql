-- =====================================================================
-- TAHAP 5 — Billing (Midtrans), masa aktif paket, trial, Admin Platform
-- =====================================================================
-- Jalankan SETELAH 001 s/d 004. Aman dijalankan dua kali.
-- Satu transaksi: kalau ada error, semuanya dibatalkan.
--
-- Isi:
--   1. Harga paket (plans.harga_bulanan / harga_tahunan), masa aktif
--      (tenants.plan_expires_at), pengaturan trial (platform_settings)
--   2. Tabel: billing_orders, billing_events, platform_audit
--      (tanpa akses langsung dari aplikasi; semua lewat fungsi)
--   3. Kedaluwarsa: effective_plan() -> paket yang berlaku SEKARANG.
--      Paket habis / trial habis => fitur otomatis jatuh ke Gratis,
--      tanpa cron. Data tidak dihapus.
--   4. Fungsi untuk Edge Function (service role): billing_new_order,
--      billing_attach_snap, billing_apply_payment, billing_expire_due
--   5. Fungsi untuk Pemilik usaha: billing_overview()
--   6. Fungsi untuk Admin Platform (platform_admins): pa_*
--   7. my_plan_info() diperkaya; register_tenant() ikut pengaturan trial
--
-- Yang TIDAK berubah: usaha utama (paket 'internal') tidak pernah
-- kedaluwarsa. Usaha yang plan_expires_at-nya kosong (semua usaha lama)
-- berperilaku persis seperti Tahap 4.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. KOLOM BARU
-- ---------------------------------------------------------------------
alter table public.plans
  add column if not exists harga_bulanan integer check (harga_bulanan is null or harga_bulanan >= 0),
  add column if not exists harga_tahunan integer check (harga_tahunan is null or harga_tahunan >= 0);
comment on column public.plans.harga_bulanan is 'Rupiah per bulan. NULL = paket tidak dijual lewat aplikasi.';
comment on column public.plans.harga_tahunan is 'Rupiah per 12 bulan. NULL = tidak ada pilihan tahunan.';

alter table public.tenants
  add column if not exists plan_expires_at timestamptz;
comment on column public.tenants.plan_expires_at is 'Paket berbayar berlaku sampai waktu ini. NULL = tanpa kedaluwarsa (Gratis, Internal, atau diberikan manual).';

alter table public.platform_settings
  add column if not exists trial_days integer not null default 0 check (trial_days between 0 and 365),
  add column if not exists trial_plan text not null default 'bisnis';
comment on column public.platform_settings.trial_days is '0 = pendaftar baru langsung Gratis (perilaku Tahap 4). >0 = trial paket trial_plan selama N hari.';

-- ---------------------------------------------------------------------
-- 2. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.billing_orders (
  id               uuid primary key default gen_random_uuid(),
  order_code       text not null unique,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  plan             text not null references public.plans(kode) on update cascade,
  period           text not null check (period in ('monthly', 'yearly')),
  months           integer not null check (months > 0),
  amount           integer not null check (amount > 0),
  status           text not null default 'pending'
                     check (status in ('pending', 'paid', 'expired', 'failed', 'canceled')),
  provider         text not null default 'midtrans',
  snap_token       text,
  redirect_url     text,
  payment_type     text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  paid_at          timestamptz,
  applied_at       timestamptz,          -- terisi saat paket usaha SUDAH diperpanjang (penjaga anti dobel)
  provider_payload jsonb
);
create index if not exists ix_billing_orders_tenant on public.billing_orders (tenant_id, created_at desc);
create index if not exists ix_billing_orders_status on public.billing_orders (status, created_at desc);

create table if not exists public.billing_events (
  id          bigserial primary key,
  order_code  text,
  status      text,
  payload     jsonb,
  received_at timestamptz not null default now()
);

create table if not exists public.platform_audit (
  id         bigserial primary key,
  actor      uuid,                                  -- NULL = sistem (kedaluwarsa, webhook)
  action     text not null,
  tenant_id  uuid references public.tenants(id) on delete set null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_platform_audit_time on public.platform_audit (created_at desc);

alter table public.billing_orders  enable row level security;
alter table public.billing_events  enable row level security;
alter table public.platform_audit  enable row level security;
revoke all on public.billing_orders, public.billing_events, public.platform_audit from anon, authenticated;
revoke all on sequence public.billing_events_id_seq, public.platform_audit_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. KEDALUWARSA
--    effective_plan(): paket yang BERLAKU sekarang. Dipakai effective_features(),
--    jadi gerbang fitur di server (RLS feature_gate, has_menu_access) langsung
--    ikut, walau tidak ada cron yang jalan.
-- ---------------------------------------------------------------------
create or replace function public.effective_plan(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
           when t.plan = 'internal' then t.plan
           when t.plan_expires_at is not null and t.plan_expires_at <= now() then 'free'
           when t.status = 'trial' and t.trial_ends_at is not null and t.trial_ends_at <= now() then 'free'
           else t.plan
         end
    from public.tenants t where t.id = p_tenant;
$$;
revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;

-- Sama seperti Tahap 4, hanya paketnya diambil dari effective_plan().
create or replace function public.effective_features(p_tenant uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(f order by f), '{}'::text[])
  from (
    select unnest(coalesce(
             (select p.features from public.tenants t
                join public.plans p on p.kode = public.effective_plan(t.id)
               where t.id = p_tenant),
             '{}'::text[])) as f
    union
    select tf.feature from public.tenant_features tf where tf.tenant_id = p_tenant and tf.enabled
  ) x
  where x.f not in (select tf.feature from public.tenant_features tf where tf.tenant_id = p_tenant and not tf.enabled);
$$;
revoke execute on function public.effective_features(uuid) from public, anon, authenticated;

-- Menuliskan kedaluwarsa ke baris tenants: paket -> free, batas karyawan ikut Gratis.
-- Karyawan yang sudah melebihi batas Gratis TIDAK dihapus; hanya tidak bisa menambah.
create or replace function public._billing_expire_tenant(p_tenant uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_old public.tenants%rowtype; v_free public.plans%rowtype; v_n integer;
begin
  select * into v_old from public.tenants where id = p_tenant;
  if not found or v_old.plan = 'internal' then return false; end if;
  select * into v_free from public.plans where kode = 'free';
  if not found then return false; end if;

  update public.tenants
     set plan = 'free',
         max_karyawan = v_free.max_karyawan,
         plan_expires_at = null,
         trial_ends_at = null,
         status = case when status = 'trial' then 'active' else status end,
         updated_at = now()
   where id = p_tenant
     and plan <> 'internal'
     and ((plan_expires_at is not null and plan_expires_at <= now())
          or (status = 'trial' and trial_ends_at is not null and trial_ends_at <= now()));
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;

  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (null, 'expire', p_tenant, jsonb_build_object(
    'from_plan', v_old.plan, 'was_trial', v_old.status = 'trial',
    'expired_at', coalesce(v_old.plan_expires_at, v_old.trial_ends_at)));
  return true;
end;
$$;
revoke execute on function public._billing_expire_tenant(uuid) from public, anon, authenticated;

-- Sapu semua usaha yang sudah lewat masa aktif + tandai pesanan menggantung.
-- Opsional dijadwalkan (lihat README-TAHAP-5.md); aplikasi tetap benar tanpa ini.
create or replace function public.billing_expire_due()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_n integer := 0;
begin
  for r in select id from public.tenants
            where plan <> 'internal'
              and ((plan_expires_at is not null and plan_expires_at <= now())
                   or (status = 'trial' and trial_ends_at is not null and trial_ends_at <= now()))
  loop
    if public._billing_expire_tenant(r.id) then v_n := v_n + 1; end if;
  end loop;
  update public.billing_orders set status = 'expired'
   where status = 'pending' and expires_at is not null and expires_at < now() - interval '1 hour';
  return v_n;
end;
$$;
revoke execute on function public.billing_expire_due() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. FUNGSI UNTUK EDGE FUNCTION (hanya service role)
-- ---------------------------------------------------------------------
-- Buat pesanan. Harga SELALU dibaca dari tabel plans, tidak pernah dari klien.
-- Pesanan pending yang sama (paket + periode, masih berlaku) dipakai ulang.
create or replace function public.billing_new_order(p_tenant uuid, p_user uuid, p_plan text, p_period text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.tenants%rowtype; p public.plans%rowtype; cur public.plans%rowtype;
  v_months integer; v_amount integer; v_cnt integer; v_code text; o public.billing_orders%rowtype;
begin
  select * into t from public.tenants where id = p_tenant for update;
  if not found then raise exception 'Usaha tidak ditemukan'; end if;
  if t.status = 'suspended' then raise exception 'Usaha ini sedang dinonaktifkan'; end if;
  if not exists (select 1 from public.profiles
                  where id = p_user and tenant_id = p_tenant and role = 'super_admin' and is_active) then
    raise exception 'Hanya Pemilik (Super Admin) yang bisa membeli atau memperpanjang paket';
  end if;
  if t.plan = 'internal' then raise exception 'Usaha utama memakai paket Internal, tidak perlu berlangganan'; end if;

  if p_period not in ('monthly', 'yearly') then raise exception 'Periode harus monthly atau yearly'; end if;
  select * into p from public.plans where kode = p_plan and is_active and kode not in ('free', 'internal');
  if not found then raise exception 'Paket "%" tidak dijual', p_plan; end if;

  v_months := case p_period when 'yearly' then 12 else 1 end;
  v_amount := case p_period when 'yearly' then p.harga_tahunan else p.harga_bulanan end;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Harga paket % untuk periode ini belum diatur', p.nama;
  end if;

  select count(*) into v_cnt from public.profiles where tenant_id = p_tenant;
  if p.max_karyawan is not null and v_cnt > p.max_karyawan then
    raise exception 'Usaha punya % karyawan, melebihi batas paket % (%). Pilih paket yang lebih besar.', v_cnt, p.nama, p.max_karyawan;
  end if;

  -- Tidak boleh pindah ke paket lebih rendah selagi paket berbayar masih berlaku
  -- (tidak ada prorata). Naik paket dan perpanjang paket yang sama boleh.
  if t.plan_expires_at is not null and t.plan_expires_at > now() then
    select * into cur from public.plans where kode = t.plan;
    if found and cur.sort_order > p.sort_order then
      raise exception 'Paket % masih aktif sampai %. Turun ke paket % bisa dilakukan setelah masa aktifnya habis.',
        cur.nama, to_char(t.plan_expires_at at time zone 'Asia/Jakarta', 'DD-MM-YYYY'), p.nama;
    end if;
  end if;

  select * into o from public.billing_orders
   where tenant_id = p_tenant and plan = p.kode and period = p_period and status = 'pending'
     and snap_token is not null and expires_at > now() + interval '30 minutes' and amount = v_amount
   order by created_at desc limit 1;
  if found then
    return to_jsonb(o) || jsonb_build_object('plan_nama', p.nama, 'reused', true);
  end if;

  v_code := 'KRJ-' || substr(replace(p_tenant::text, '-', ''), 1, 6) || '-'
            || to_char(now() at time zone 'UTC', 'YYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4);
  insert into public.billing_orders (order_code, tenant_id, plan, period, months, amount, created_by, expires_at)
  values (v_code, p_tenant, p.kode, p_period, v_months, v_amount, p_user, now() + interval '24 hours')
  returning * into o;
  return to_jsonb(o) || jsonb_build_object('plan_nama', p.nama, 'reused', false);
end;
$$;
revoke execute on function public.billing_new_order(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.billing_attach_snap(p_order text, p_token text, p_url text)
returns void language sql security definer set search_path = public as $$
  update public.billing_orders set snap_token = p_token, redirect_url = p_url where order_code = p_order;
$$;
revoke execute on function public.billing_attach_snap(text, text, text) from public, anon, authenticated;

-- Terapkan hasil pembayaran. IDEMPOTEN: notifikasi yang datang berulang tidak
-- memperpanjang dua kali (dijaga applied_at + kunci baris).
-- p_status: paid | pending | expired | failed | canceled
create or replace function public.billing_apply_payment(
  p_order text, p_status text, p_payment_type text default null,
  p_paid_at timestamptz default null, p_payload jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.billing_orders%rowtype; t public.tenants%rowtype; pl public.plans%rowtype;
  v_base timestamptz; v_new timestamptz;
begin
  if p_status not in ('paid', 'pending', 'expired', 'failed', 'canceled') then
    raise exception 'Status "%" tidak dikenal', p_status;
  end if;
  select * into o from public.billing_orders where order_code = p_order for update;
  if not found then raise exception 'Pesanan % tidak ditemukan', p_order; end if;

  insert into public.billing_events (order_code, status, payload) values (p_order, p_status, p_payload);

  if p_status = 'paid' then
    if o.applied_at is not null then
      return jsonb_build_object('status', 'paid', 'applied', false, 'note', 'sudah diterapkan sebelumnya');
    end if;
    select * into t from public.tenants where id = o.tenant_id for update;
    select * into pl from public.plans where kode = o.plan;

    v_base := case when t.plan = o.plan and t.plan_expires_at is not null and t.plan_expires_at > now()
                   then t.plan_expires_at else now() end;
    v_new := v_base + make_interval(months => o.months);

    update public.tenants
       set plan = o.plan, max_karyawan = pl.max_karyawan, plan_expires_at = v_new,
           trial_ends_at = null,
           status = case when status = 'suspended' then status else 'active' end,
           updated_at = now()
     where id = o.tenant_id;

    update public.billing_orders
       set status = 'paid', paid_at = coalesce(p_paid_at, now()), applied_at = now(),
           payment_type = coalesce(p_payment_type, payment_type), provider_payload = p_payload
     where id = o.id;

    insert into public.platform_audit (actor, action, tenant_id, detail)
    values (null, 'payment', o.tenant_id, jsonb_build_object(
      'order', o.order_code, 'plan', o.plan, 'period', o.period, 'amount', o.amount, 'expires_at', v_new));
    return jsonb_build_object('status', 'paid', 'applied', true, 'expires_at', v_new);
  end if;

  -- Bukan "paid": jangan pernah menurunkan pesanan yang sudah dibayar.
  if o.status = 'pending' then
    update public.billing_orders
       set status = p_status, payment_type = coalesce(p_payment_type, payment_type), provider_payload = p_payload
     where id = o.id;
  end if;
  return jsonb_build_object('status', case when o.status = 'paid' then 'paid' else p_status end, 'applied', false);
end;
$$;
revoke execute on function public.billing_apply_payment(text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. UNTUK PEMILIK USAHA
-- ---------------------------------------------------------------------
create or replace function public.billing_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t uuid := public.current_tenant_id();
begin
  if auth.uid() is null or v_t is null then raise exception 'Belum login atau belum terdaftar di sebuah usaha'; end if;
  if not public.is_super() then raise exception 'Hanya Pemilik (Super Admin) yang bisa mengelola langganan'; end if;
  return jsonb_build_object(
    'plans', (select coalesce(jsonb_agg(jsonb_build_object(
                'kode', p.kode, 'nama', p.nama, 'deskripsi', p.deskripsi, 'max_karyawan', p.max_karyawan,
                'harga_bulanan', p.harga_bulanan, 'harga_tahunan', p.harga_tahunan,
                'features', p.features, 'sort_order', p.sort_order) order by p.sort_order), '[]'::jsonb)
                from public.plans p where p.is_active and p.kode not in ('free', 'internal')),
    'orders', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                 select o.order_code, o.plan, pl.nama as plan_nama, o.period, o.amount, o.status,
                        o.created_at, o.paid_at, o.expires_at, o.payment_type,
                        case when o.status = 'pending' and o.expires_at > now() then o.snap_token end as snap_token
                   from public.billing_orders o left join public.plans pl on pl.kode = o.plan
                  where o.tenant_id = v_t order by o.created_at desc limit 10) x)
  );
end;
$$;
revoke execute on function public.billing_overview() from public, anon;
grant execute on function public.billing_overview() to authenticated;

-- ---------------------------------------------------------------------
-- 6. UNTUK ADMIN PLATFORM (baris di platform_admins)
--    Semua fungsi memeriksa is_platform_admin() sendiri, lalu memanggil
--    helper platform_* Tahap 4. Setiap perubahan dicatat di platform_audit.
--    Usaha utama (default_tenant_id) dilindungi dari perubahan paket/status.
-- ---------------------------------------------------------------------
create or replace function public._pa_guard()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'Hanya admin platform yang boleh melakukan ini';
  end if;
end;
$$;
revoke execute on function public._pa_guard() from public, anon, authenticated;

create or replace function public._pa_not_default(p_tenant uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_tenant = (select default_tenant_id from public.platform_settings where id = 1) then
    raise exception 'Usaha utama tidak boleh diubah paket/statusnya dari sini';
  end if;
end;
$$;
revoke execute on function public._pa_not_default(uuid) from public, anon, authenticated;

create or replace function public.pa_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_month timestamptz := date_trunc('month', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta';
begin
  perform public._pa_guard();
  return jsonb_build_object(
    'tenants_total',   (select count(*) from public.tenants),
    'by_status',       (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.tenants group by status) s),
    'by_plan',         (select coalesce(jsonb_object_agg(plan, n), '{}'::jsonb) from (select plan, count(*) n from public.tenants group by plan) s),
    'expiring_7d',     (select count(*) from public.tenants
                         where plan <> 'internal' and status <> 'suspended'
                           and coalesce(case when status = 'trial' then trial_ends_at else plan_expires_at end, 'infinity') between now() and now() + interval '7 days'),
    'pending_orders',  (select count(*) from public.billing_orders where status = 'pending' and expires_at > now()),
    'revenue_month',   (select coalesce(sum(amount), 0) from public.billing_orders where status = 'paid' and paid_at >= v_month),
    'revenue_30d',     (select coalesce(sum(amount), 0) from public.billing_orders where status = 'paid' and paid_at >= now() - interval '30 days'),
    'paid_orders',     (select count(*) from public.billing_orders where status = 'paid'),
    'settings',        (select jsonb_build_object('trial_days', trial_days, 'trial_plan', trial_plan, 'public_mode', public_mode)
                          from public.platform_settings where id = 1),
    'plans',           (select coalesce(jsonb_agg(jsonb_build_object(
                          'kode', kode, 'nama', nama, 'max_karyawan', max_karyawan, 'is_active', is_active,
                          'harga_bulanan', harga_bulanan, 'harga_tahunan', harga_tahunan) order by sort_order), '[]'::jsonb)
                          from public.plans),
    'features',        (select coalesce(jsonb_agg(jsonb_build_object('kode', kode, 'nama', nama) order by sort_order), '[]'::jsonb)
                          from public.feature_catalog)
  );
end;
$$;
revoke execute on function public.pa_overview() from public, anon;
grant execute on function public.pa_overview() to authenticated;

create or replace function public.pa_tenants()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._pa_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'kode', t.kode, 'nama', t.nama, 'status', t.status, 'plan', t.plan, 'plan_nama', p.nama,
      'effective_plan', public.effective_plan(t.id),
      'plan_expires_at', t.plan_expires_at, 'trial_ends_at', t.trial_ends_at,
      'max_karyawan', t.max_karyawan,
      'karyawan', (select count(*) from public.profiles pr where pr.tenant_id = t.id),
      'role_mode', t.role_mode, 'created_at', t.created_at,
      'owner_email', (select u.email from auth.users u where u.id = t.owner_id),
      'override', coalesce((select jsonb_object_agg(tf.feature, tf.enabled) from public.tenant_features tf where tf.tenant_id = t.id), '{}'::jsonb),
      'is_default', t.id = (select default_tenant_id from public.platform_settings where id = 1)
    ) order by t.created_at), '[]'::jsonb)
    from public.tenants t left join public.plans p on p.kode = t.plan);
end;
$$;
revoke execute on function public.pa_tenants() from public, anon;
grant execute on function public.pa_tenants() to authenticated;

create or replace function public.pa_orders(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._pa_guard();
  return (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select o.order_code, o.plan, o.period, o.amount, o.status, o.payment_type, o.created_at, o.paid_at,
           t.kode as tenant_kode, t.nama as tenant_nama
      from public.billing_orders o join public.tenants t on t.id = o.tenant_id
     order by o.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x);
end;
$$;
revoke execute on function public.pa_orders(integer) from public, anon;
grant execute on function public.pa_orders(integer) to authenticated;

create or replace function public.pa_audit(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._pa_guard();
  return (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select a.action, a.detail, a.created_at, t.kode as tenant_kode, t.nama as tenant_nama,
           (select u.email from auth.users u where u.id = a.actor) as actor_email
      from public.platform_audit a left join public.tenants t on t.id = a.tenant_id
     order by a.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x);
end;
$$;
revoke execute on function public.pa_audit(integer) from public, anon;
grant execute on function public.pa_audit(integer) to authenticated;

-- Ganti paket secara manual. p_expires_at kosong = tanpa kedaluwarsa (mis. mitra / hadiah).
create or replace function public.pa_set_plan(p_kode text, p_plan text, p_keep_limit boolean default false, p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  perform public._pa_guard();
  v_t := public._tenant_by_kode(p_kode);
  perform public._pa_not_default(v_t);
  perform public.platform_set_plan(p_kode, p_plan, coalesce(p_keep_limit, false));
  update public.tenants
     set plan_expires_at = case when p_plan = 'free' then null else p_expires_at end,
         trial_ends_at = null,
         status = case when status = 'trial' then 'active' else status end,
         updated_at = now()
   where id = v_t;
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'set_plan', v_t, jsonb_build_object('plan', p_plan, 'expires_at', p_expires_at, 'keep_limit', coalesce(p_keep_limit, false)));
end;
$$;
revoke execute on function public.pa_set_plan(text, text, boolean, timestamptz) from public, anon;
grant execute on function public.pa_set_plan(text, text, boolean, timestamptz) to authenticated;

-- Tambah / kurangi hari masa aktif (atau masa trial kalau usaha sedang trial).
create or replace function public.pa_extend(p_kode text, p_days integer)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_t uuid; t public.tenants%rowtype; v_new timestamptz;
begin
  perform public._pa_guard();
  v_t := public._tenant_by_kode(p_kode);
  perform public._pa_not_default(v_t);
  if p_days is null or p_days = 0 or abs(p_days) > 3650 then raise exception 'Jumlah hari harus antara -3650 dan 3650, bukan 0'; end if;
  select * into t from public.tenants where id = v_t for update;
  if t.status = 'trial' and t.trial_ends_at is not null then
    v_new := greatest(now(), t.trial_ends_at) + make_interval(days => p_days);
    update public.tenants set trial_ends_at = v_new, updated_at = now() where id = v_t;
  elsif t.plan_expires_at is not null then
    v_new := greatest(now(), t.plan_expires_at) + make_interval(days => p_days);
    update public.tenants set plan_expires_at = v_new, updated_at = now() where id = v_t;
  else
    raise exception 'Usaha ini tidak punya masa aktif. Pakai "Ubah paket" dengan tanggal berakhir.';
  end if;
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'extend', v_t, jsonb_build_object('days', p_days, 'new_end', v_new));
  return v_new;
end;
$$;
revoke execute on function public.pa_extend(text, integer) from public, anon;
grant execute on function public.pa_extend(text, integer) to authenticated;

create or replace function public.pa_start_trial(p_kode text, p_plan text, p_days integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  perform public._pa_guard();
  v_t := public._tenant_by_kode(p_kode);
  perform public._pa_not_default(v_t);
  if p_days is null or p_days < 1 or p_days > 365 then raise exception 'Lama trial 1-365 hari'; end if;
  if p_plan in ('free', 'internal') then raise exception 'Trial hanya untuk paket berbayar'; end if;
  if (select status from public.tenants where id = v_t) = 'suspended' then
    raise exception 'Usaha sedang ditangguhkan. Aktifkan dulu.';
  end if;
  perform public.platform_set_plan(p_kode, p_plan, false);
  update public.tenants
     set status = 'trial', trial_ends_at = now() + make_interval(days => p_days), plan_expires_at = null, updated_at = now()
   where id = v_t;
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'start_trial', v_t, jsonb_build_object('plan', p_plan, 'days', p_days));
end;
$$;
revoke execute on function public.pa_start_trial(text, text, integer) from public, anon;
grant execute on function public.pa_start_trial(text, text, integer) to authenticated;

create or replace function public.pa_set_status(p_kode text, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  perform public._pa_guard();
  v_t := public._tenant_by_kode(p_kode);
  perform public._pa_not_default(v_t);
  if p_status not in ('active', 'suspended') then raise exception 'Status harus active atau suspended'; end if;
  update public.tenants set status = p_status, updated_at = now() where id = v_t;
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'set_status', v_t, jsonb_build_object('status', p_status));
end;
$$;
revoke execute on function public.pa_set_status(text, text) from public, anon;
grant execute on function public.pa_set_status(text, text) to authenticated;

-- p_enabled: true = tambah di luar paket, false = cabut, NULL = kembali ke aturan paket.
create or replace function public.pa_set_feature(p_kode text, p_feature text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  perform public._pa_guard();
  v_t := public._tenant_by_kode(p_kode);
  if p_enabled is null then
    perform public.platform_clear_feature(p_kode, p_feature);
  else
    perform public.platform_set_feature(p_kode, p_feature, p_enabled);
  end if;
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'set_feature', v_t, jsonb_build_object('feature', p_feature, 'enabled', p_enabled));
end;
$$;
revoke execute on function public.pa_set_feature(text, text, boolean) from public, anon;
grant execute on function public.pa_set_feature(text, text, boolean) to authenticated;

create or replace function public.pa_set_price(p_plan text, p_bulanan integer, p_tahunan integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._pa_guard();
  if p_plan in ('free', 'internal') then raise exception 'Paket % tidak dijual', p_plan; end if;
  if (p_bulanan is not null and p_bulanan <= 0) or (p_tahunan is not null and p_tahunan <= 0) then
    raise exception 'Harga harus lebih dari 0 (atau kosongkan untuk tidak dijual)';
  end if;
  update public.plans set harga_bulanan = p_bulanan, harga_tahunan = p_tahunan where kode = p_plan;
  if not found then raise exception 'Paket "%" tidak ada', p_plan; end if;
  insert into public.platform_audit (actor, action, detail)
  values (auth.uid(), 'set_price', jsonb_build_object('plan', p_plan, 'bulanan', p_bulanan, 'tahunan', p_tahunan));
end;
$$;
revoke execute on function public.pa_set_price(text, integer, integer) from public, anon;
grant execute on function public.pa_set_price(text, integer, integer) to authenticated;

create or replace function public.pa_set_trial(p_days integer, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._pa_guard();
  if p_days is null or p_days < 0 or p_days > 365 then raise exception 'Lama trial 0-365 hari (0 = tanpa trial)'; end if;
  if not exists (select 1 from public.plans where kode = p_plan and is_active and kode not in ('free', 'internal')) then
    raise exception 'Paket trial "%" tidak ada atau tidak dijual', p_plan;
  end if;
  update public.platform_settings set trial_days = p_days, trial_plan = p_plan, updated_at = now() where id = 1;
  insert into public.platform_audit (actor, action, detail)
  values (auth.uid(), 'set_trial', jsonb_build_object('days', p_days, 'plan', p_plan));
end;
$$;
revoke execute on function public.pa_set_trial(integer, text) from public, anon;
grant execute on function public.pa_set_trial(integer, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. my_plan_info() DIPERKAYA + register_tenant() IKUT PENGATURAN TRIAL
--    my_plan_info kini menuliskan kedaluwarsa (volatile), jadi halaman
--    Paket & Fitur selalu menampilkan keadaan yang benar.
-- ---------------------------------------------------------------------
create or replace function public.my_plan_info()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_t       uuid := public.current_tenant_id();
  v_feat    text[];
  v_blocked text[];
  v_cnt     integer;
  v_end     timestamptz;
  v_exp     jsonb;
  r         record;
begin
  if auth.uid() is null or v_t is null then
    raise exception 'Belum login atau belum terdaftar di sebuah usaha';
  end if;
  perform public._billing_expire_tenant(v_t);

  v_feat := public.effective_features(v_t);
  select coalesce(array_agg(menu_id order by menu_id), '{}'::text[]) into v_blocked
    from public.menu_features where not (feature = any(v_feat));
  select count(*) into v_cnt from public.profiles where tenant_id = v_t;
  select t.plan, p.nama as plan_nama, t.status, t.role_mode, t.max_karyawan, t.trial_ends_at, t.plan_expires_at
    into r
    from public.tenants t left join public.plans p on p.kode = t.plan
   where t.id = v_t;

  v_end := case when r.status = 'trial' then r.trial_ends_at else r.plan_expires_at end;
  select jsonb_build_object('from_plan', a.detail->>'from_plan', 'at', a.created_at,
                            'was_trial', coalesce((a.detail->>'was_trial')::boolean, false))
    into v_exp
    from public.platform_audit a
   where a.tenant_id = v_t and a.action = 'expire' and a.created_at > now() - interval '14 days'
   order by a.created_at desc limit 1;

  return jsonb_build_object(
    'plan',            r.plan,
    'plan_nama',       r.plan_nama,
    'status',          r.status,
    'role_mode',       r.role_mode,
    'max_karyawan',    r.max_karyawan,
    'karyawan_count',  v_cnt,
    'trial_ends_at',   r.trial_ends_at,
    'plan_expires_at', r.plan_expires_at,
    'days_left',       case when v_end is null then null else ceil(extract(epoch from (v_end - now())) / 86400)::int end,
    'recently_expired', v_exp,
    'is_owner',        public.is_super(),
    'is_platform_admin', public.is_platform_admin(),
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

create or replace function public.register_tenant(p_nama_usaha text, p_full_name text, p_kode text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_t uuid; v_days integer; v_plan text; v_pl public.plans%rowtype;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not public.platform_public_mode() then
    raise exception 'Pendaftaran usaha baru belum dibuka';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Akun ini sudah terdaftar di sebuah usaha';
  end if;
  v_t := public.create_tenant_for_owner(p_nama_usaha, p_kode, auth.uid(), p_full_name, 'free', null, 'ringkas');

  select trial_days, trial_plan into v_days, v_plan from public.platform_settings where id = 1;
  if coalesce(v_days, 0) > 0 then
    select * into v_pl from public.plans where kode = v_plan and is_active and kode not in ('free', 'internal');
    if found then
      update public.tenants
         set plan = v_pl.kode, max_karyawan = v_pl.max_karyawan, status = 'trial',
             trial_ends_at = now() + make_interval(days => v_days)
       where id = v_t;
    end if;
  end if;
  return v_t;
end;
$$;
revoke execute on function public.register_tenant(text, text, text) from public, anon;
grant execute on function public.register_tenant(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. PEMERIKSAAN AKHIR
-- ---------------------------------------------------------------------
do $$
declare v_default uuid; v_feat text[];
begin
  select default_tenant_id into v_default from public.platform_settings where id = 1;
  v_feat := public.effective_features(v_default);
  if array_length(v_feat, 1) is distinct from (select count(*)::int from public.feature_catalog) then
    raise exception 'Usaha utama tidak memegang semua fitur (%): cek tabel plans', v_feat;
  end if;
  raise notice 'OK — Tahap 5 (SQL) terpasang. Usaha utama tetap "%", % fitur aktif. Harga paket belum diatur? Lihat README-TAHAP-5.md.',
    (select plan from public.tenants where id = v_default), array_length(v_feat, 1);
end $$;

commit;
