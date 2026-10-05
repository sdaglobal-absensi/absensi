-- =====================================================================
-- 006 — pa_overview() ikut mengirim daftar fitur tiap paket
-- Dipakai Admin Platform untuk menampilkan fitur apa saja yang termasuk
-- di paket sebuah usaha. Hanya mengganti satu fungsi; aman dijalankan
-- berulang. Jalankan di SQL Editor SETELAH 005_tahap5_billing.sql.
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
    'features',        (select coalesce(jsonb_agg(jsonb_build_object('kode', kode, 'nama', nama) order by sort_order), '[]'::jsonb)
                          from public.feature_catalog)
  );
end;
$$;
revoke execute on function public.pa_overview() from public, anon;
grant execute on function public.pa_overview() to authenticated;
