-- =====================================================================
-- ROLLBACK TAHAP 4 — kembali ke kondisi setelah Tahap 3
-- =====================================================================
-- Efek:
--   * Semua fitur terbuka lagi untuk semua usaha (paket diabaikan).
--   * Template ringkas dicabut (role lain boleh dipakai lagi).
--   * Tabel paket/fitur DIHAPUS. Kolom tenants.plan tetap (teks bebas).
--   * Data usaha (karyawan, lembur, slip gaji, dst.) TIDAK disentuh.
-- Setelah ini, upload kembali berkas JS Tahap 3 (core.js, app.html,
-- super-pengaturan.js, admin-struktur-organisasi.js; super-paket.js boleh
-- dihapus). Aman dijalankan dua kali.
-- =====================================================================
begin;

-- 1. Lepas gerbang tabel
do $$
declare r record;
begin
  for r in select schemaname, tablename from pg_policies where policyname = 'feature_gate' and schemaname = 'public' loop
    execute format('drop policy if exists feature_gate on %I.%I', r.schemaname, r.tablename);
  end loop;
end $$;

-- 2. has_menu_access versi Tahap 1 (tanpa pemeriksaan paket)
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

-- 3. Cabut template ringkas
drop trigger if exists ab_profiles_role_mode on public.profiles;
drop function if exists public.tg_profiles_role_mode();

-- 4. Onboarding versi Tahap 1
drop function if exists public.create_tenant_for_owner(text, text, uuid, text, text, integer, text);
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

revoke execute on function public.create_tenant_for_owner(text, text, uuid, text, text, integer) from public, anon, authenticated;

-- register_tenant versi Tahap 1
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

-- 5. Buang fungsi, constraint, kolom, dan tabel Tahap 4
drop function if exists public.platform_tenant_overview();
drop function if exists public.platform_set_role_mode(text, text, boolean);
drop function if exists public.platform_clear_feature(text, text);
drop function if exists public.platform_set_feature(text, text, boolean);
drop function if exists public.platform_set_plan(text, text, boolean);
drop function if exists public._check_feature_deps(uuid);
drop function if exists public._tenant_by_kode(text);
drop function if exists public.seed_tenant_template(uuid, text);
drop function if exists public.my_plan_info();
drop function if exists public.menu_in_plan(text);
drop function if exists public.tenant_has_feature(text);
drop function if exists public.effective_features(uuid);

alter table public.tenants drop constraint if exists tenants_plan_fkey;
alter table public.tenants drop constraint if exists tenants_role_mode_check;
alter table public.tenants drop column if exists role_mode;

drop table if exists public.tenant_features;
drop table if exists public.menu_features;
drop table if exists public.plans;
drop table if exists public.feature_catalog;

do $$ begin raise notice 'OK — Tahap 4 dicabut. Upload kembali JS Tahap 3.'; end $$;
commit;
