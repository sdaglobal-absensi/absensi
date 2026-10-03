-- =====================================================================
-- 007 — Fitur per paket bisa diedit dari Admin Platform
--   1. pa_overview() ikut mengirim "requires" tiap fitur (untuk validasi di layar)
--   2. pa_set_plan_features(plan, fitur[]) — mengganti daftar fitur sebuah paket
-- Jalankan di SQL Editor SETELAH 005 dan 006. Aman dijalankan berulang.
-- Catatan: perubahan langsung berlaku untuk SEMUA usaha yang memakai paket itu
-- (effective_features() membaca plans.features). Override per usaha tetap menang.
-- =====================================================================

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
                          'harga_bulanan', harga_bulanan, 'harga_tahunan', harga_tahunan,
                          'features', to_jsonb(features)) order by sort_order), '[]'::jsonb)
                          from public.plans),
    'features',        (select coalesce(jsonb_agg(jsonb_build_object('kode', kode, 'nama', nama, 'requires', to_jsonb(requires)) order by sort_order), '[]'::jsonb)
                          from public.feature_catalog)
  );
end;
$$;
revoke execute on function public.pa_overview() from public, anon;
grant execute on function public.pa_overview() to authenticated;


create or replace function public.pa_set_plan_features(p_plan text, p_features text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_new text[]; v_old text[]; v_bad text; r record;
begin
  perform public._pa_guard();
  if p_plan = 'internal' then
    raise exception 'Paket Internal selalu memuat semua fitur dan tidak bisa diubah';
  end if;
  select features into v_old from public.plans where kode = p_plan;
  if not found then raise exception 'Paket "%" tidak ada', p_plan; end if;

  select coalesce(array_agg(distinct f order by f), '{}'::text[]) into v_new
    from unnest(coalesce(p_features, '{}'::text[])) f;

  select f into v_bad from unnest(v_new) f
   where f not in (select kode from public.feature_catalog) limit 1;
  if v_bad is not null then raise exception 'Fitur "%" tidak ada di katalog', v_bad; end if;

  select c.kode, c.nama, c.requires into r from public.feature_catalog c
   where c.kode = any(v_new) and not (c.requires <@ v_new) limit 1;
  if found then
    raise exception 'Fitur "%" membutuhkan fitur % ikut aktif di paket yang sama', r.nama, r.requires;
  end if;

  update public.plans set features = v_new where kode = p_plan;
  insert into public.platform_audit (actor, action, detail)
  values (auth.uid(), 'set_plan_features',
          jsonb_build_object('plan', p_plan, 'sebelum', to_jsonb(v_old), 'sesudah', to_jsonb(v_new)));
end;
$$;
revoke execute on function public.pa_set_plan_features(text, text[]) from public, anon;
grant execute on function public.pa_set_plan_features(text, text[]) to authenticated;
