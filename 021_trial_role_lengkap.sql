-- =====================================================================
-- 021 — Trial paket berbayar (Bisnis/Enterprise) memakai role LENGKAP
--
-- Masalah: register_tenant membuat usaha baru dengan template 'ringkas'
-- (hanya Pemilik + Karyawan), lalu trial hanya mengganti kolom plan.
-- role_mode tidak ikut berubah, sehingga di Pengaturan Sistem akun trial
-- Enterprise cuma punya kolom "Akses Karyawan" (lihat super-pengaturan.js:
-- role_mode = 'ringkas' -> hanya role karyawan).
--
-- Perbaikan: usaha yang sedang trial paket berbayar diperlakukan sama
-- dengan paket berbayar -> role_mode 'lengkap' + izin menu role lain
-- diisi dari role_permission_defaults.
--
-- Aman dijalankan ulang. Tidak menyentuh usaha berpaket 'free' maupun
-- usaha berbayar yang sengaja dibuat 'ringkas'.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Helper: ubah usaha 'ringkas' menjadi 'lengkap'.
--    - role_mode -> 'lengkap'
--    - izin menu Super Admin HR / Admin HR / Admin diisi default bawaan
--      (template ringkas mematikan semuanya)
--    - izin Karyawan TIDAK diubah (menu pribadi tetap menyala; Pemilik bisa
--      menambah sendiri lewat Pengaturan Sistem)
-- ---------------------------------------------------------------------
create or replace function public._tenant_ke_lengkap(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.tenants where id = p_tenant and role_mode = 'ringkas') then
    return;
  end if;

  update public.tenants set role_mode = 'lengkap' where id = p_tenant;

  insert into public.role_permissions (tenant_id, role, menu_id, enabled)
  select p_tenant, d.role, d.menu_id, d.enabled
    from public.role_permission_defaults d
   where d.role <> 'karyawan'
  on conflict (tenant_id, role, menu_id) do update set enabled = excluded.enabled;
end;
$$;
revoke execute on function public._tenant_ke_lengkap(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Daftar mandiri: kalau trial paket berbayar aktif -> langsung lengkap.
--    (Kalau trial_days = 0, usaha tetap paket free + template ringkas.)
-- ---------------------------------------------------------------------
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
      perform public._tenant_ke_lengkap(v_t);   -- trial berbayar = role lengkap
    end if;
  end if;
  return v_t;
end;
$$;
revoke execute on function public.register_tenant(text, text, text) from public, anon;
grant execute on function public.register_tenant(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Platform Admin memulai trial untuk usaha yang sudah ada.
-- ---------------------------------------------------------------------
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
  perform public._tenant_ke_lengkap(v_t);       -- trial berbayar = role lengkap
  insert into public.platform_audit (actor, action, tenant_id, detail)
  values (auth.uid(), 'start_trial', v_t, jsonb_build_object('plan', p_plan, 'days', p_days));
end;
$$;
revoke execute on function public.pa_start_trial(text, text, integer) from public, anon;
grant execute on function public.pa_start_trial(text, text, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Perbaiki usaha trial yang sudah terlanjur 'ringkas'.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id from public.tenants
            where status = 'trial' and plan not in ('free', 'internal') and role_mode = 'ringkas'
  loop
    perform public._tenant_ke_lengkap(r.id);
  end loop;
end $$;

commit;
