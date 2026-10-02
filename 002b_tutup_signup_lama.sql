-- =====================================================================
-- 002b_tutup_signup_lama.sql — JALANKAN PALING AKHIR di Tahap 2.
--
-- Syarat sebelum menjalankan file ini (kalau belum, pembuatan karyawan
-- dari aplikasi LAMA akan gagal):
--   1. 002_tahap2_akun.sql sudah dijalankan.
--   2. Edge Function `account-admin` & `login-pin` sudah di-deploy dan
--      secret PIN_PEPPER sudah diisi.
--   3. File aplikasi (JS/HTML) versi Tahap 2 sudah ter-deploy ke hosting.
--   4. Kamu sudah mencoba "Tambah Karyawan" di aplikasi dan berhasil.
--
-- Yang dilakukan: akun hasil auth.signUp() dari browser TIDAK LAGI otomatis
-- masuk ke tenant bawaan sebagai karyawan. Tadinya siapa pun yang tahu
-- anon key (publik, ada di js/supabaseClient.js) bisa mendaftar sendiri dan
-- langsung jadi karyawan di perusahaan utama. Sesudah ini, tenant HANYA
-- dipercaya dari app_metadata (hanya bisa ditulis Edge Function / service
-- role). Akun tanpa tenant tidak punya profil -> tidak bisa melihat data.
-- =====================================================================
begin;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  begin
    v_tenant := nullif(new.raw_app_meta_data->>'tenant_id', '')::uuid;
  exception when others then
    v_tenant := null;
  end;

  -- Tanpa tenant di app_metadata: JANGAN buat profil. (Pendaftar usaha
  -- baru memanggil register_tenant() setelah login.)
  if v_tenant is null then
    return new;
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
    case when coalesce(new.raw_app_meta_data->>'login_type', 'email') = 'pin' then null else new.email end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$ begin raise notice 'OK — signUp dari browser tidak lagi masuk ke tenant bawaan.'; end $$;

commit;
