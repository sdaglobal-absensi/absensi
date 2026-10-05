-- =====================================================================
-- PRIORITAS MENENGAH #7 — DASHBOARD ANALITIK HR
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-013. Aman dijalankan ulang.
--
-- Tidak ada tabel baru: dashboard hanya menampilkan data yang sudah ada
-- (attendance, leave_requests, overtime_requests, leave_balances, holidays).
-- SQL ini hanya mendaftarkan menu 'analitik-hr' ke sistem paket & hak menu.
--
-- Paket : fitur baru 'analitik_hr' -> Bisnis, Enterprise, Internal.
-- Hak   : analitik-hr aktif untuk Super Admin HR & Admin HR (Super Admin
--         selalu bisa). Bisa diubah di Pengaturan Sistem > Kelola Akses Menu.
-- Data  : yang terlihat tetap mengikuti RLS tabel-tabel sumbernya.
-- =====================================================================

begin;

insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('analitik_hr', 'Dashboard Analitik HR',
   'Tingkat keterlambatan, tren lembur, absensi per departemen, dan cuti belum terpakai', '{}', 59)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('analitik-hr', 'analitik_hr')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['analitik_hr']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('analitik_hr' = any(features));

insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'analitik-hr', true), ('admin_hr', 'analitik-hr', true),
  ('admin_approval', 'analitik-hr', false), ('karyawan', 'analitik-hr', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id = 'analitik-hr'
on conflict (tenant_id, role, menu_id) do nothing;

commit;

-- =====================================================================
-- ROLLBACK (manual):
--   delete from public.role_permissions where menu_id = 'analitik-hr';
--   delete from public.role_permission_defaults where menu_id = 'analitik-hr';
--   delete from public.menu_features where menu_id = 'analitik-hr';
--   update public.plans set features = array_remove(features, 'analitik_hr');
--   delete from public.feature_catalog where kode = 'analitik_hr';
-- =====================================================================
