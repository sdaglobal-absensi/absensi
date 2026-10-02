-- =====================================================================
-- ROLLBACK TAHAP 5 — kembali ke keadaan Tahap 4
-- =====================================================================
-- Aman dijalankan dua kali. Data usaha tidak disentuh.
-- YANG HILANG: riwayat pesanan (billing_orders), log webhook, log admin
-- platform, harga paket, masa aktif per usaha, dan pengaturan trial.
-- Usaha yang sedang berstatus 'trial' tetap 'trial' tanpa batas waktu;
-- ubah manual kalau perlu:  update tenants set status = 'active' where status = 'trial';
-- Simpan dulu kalau butuh arsip:  create table arsip_billing_orders as select * from billing_orders;
-- Setelah ini upload kembali JS Tahap 4 dan hapus Edge Function billing & midtrans-webhook.
-- =====================================================================
begin;

-- Kembalikan fungsi Tahap 4 (isi sama persis dengan 004_tahap4_paket_fitur.sql).
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

-- Buang objek Tahap 5.
drop function if exists public.pa_set_trial(integer, text);
drop function if exists public.pa_set_price(text, integer, integer);
drop function if exists public.pa_set_feature(text, text, boolean);
drop function if exists public.pa_set_status(text, text);
drop function if exists public.pa_start_trial(text, text, integer);
drop function if exists public.pa_extend(text, integer);
drop function if exists public.pa_set_plan(text, text, boolean, timestamptz);
drop function if exists public.pa_audit(integer);
drop function if exists public.pa_orders(integer);
drop function if exists public.pa_tenants();
drop function if exists public.pa_overview();
drop function if exists public._pa_not_default(uuid);
drop function if exists public._pa_guard();
drop function if exists public.billing_overview();
drop function if exists public.billing_apply_payment(text, text, text, timestamptz, jsonb);
drop function if exists public.billing_attach_snap(text, text, text);
drop function if exists public.billing_new_order(uuid, uuid, text, text);
drop function if exists public.billing_expire_due();
drop function if exists public._billing_expire_tenant(uuid);
drop function if exists public.effective_plan(uuid);

drop table if exists public.billing_events;
drop table if exists public.billing_orders;
drop table if exists public.platform_audit;

alter table public.platform_settings drop column if exists trial_plan, drop column if exists trial_days;
alter table public.tenants drop column if exists plan_expires_at;
alter table public.plans drop column if exists harga_tahunan, drop column if exists harga_bulanan;

do $$ begin raise notice 'OK — Tahap 5 dicabut. Upload kembali JS Tahap 4.'; end $$;
commit;
