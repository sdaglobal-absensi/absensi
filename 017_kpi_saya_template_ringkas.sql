-- =====================================================================
-- 017 — Template "ringkas": aktifkan menu KPI Saya untuk Karyawan
-- ---------------------------------------------------------------------
-- Latar belakang: seed_tenant_template (versi terakhir di 013) menyimpan daftar
-- menu pribadi Karyawan untuk template ringkas (v_personal) dan MEMATIKAN menu
-- lain. Menu 'kpi-saya' ditambahkan di 016 tetapi tidak masuk daftar itu, sehingga
-- usaha ringkas BARU kehilangan "KPI Saya" untuk Karyawan.
--
-- Migrasi ini hanya mendefinisikan ulang fungsi itu (daftar + 'kpi-saya').
-- TIDAK mengubah usaha yang sudah ada. Menu tetap tunduk pada paket: 'kpi-saya'
-- baru tampil bila paket usaha memuat fitur 'kpi' (lihat menu_features).
--
-- Jalankan SETELAH 016. Aman dijalankan ulang.
--
-- Opsional — aktifkan juga untuk usaha ringkas yang SUDAH ada (hapus tanda
-- komentar kalau memang diinginkan):
--   update public.role_permissions rp set enabled = true
--     from public.tenants t
--    where rp.tenant_id = t.id and t.role_mode = 'ringkas'
--      and rp.role = 'karyawan' and rp.menu_id = 'kpi-saya';
--
-- Rollback: jalankan ulang fungsi di 013_tukar_shift.sql (tanpa 'kpi-saya').
-- =====================================================================
begin;

create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse','dokumen','tukar-shift','kpi-saya'];
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

commit;
