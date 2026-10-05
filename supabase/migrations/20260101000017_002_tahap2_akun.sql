-- =====================================================================
-- 002_tahap2_akun.sql — TAHAP 2: pembuatan akun lewat Edge Function,
-- login karyawan tanpa email (kode usaha + kode karyawan + PIN), dan
-- fondasi halaman daftar usaha.
--
-- AMAN: hanya MENAMBAH (kolom, tabel, fungsi baru). Tidak mengubah
-- perilaku aplikasi yang sekarang. Aman dijalankan ulang.
-- Jalankan SETELAH 001_multi_tenant.sql. Di Supabase: SQL Editor -> Run.
--
-- (Penutupan celah signUp lama ada di file TERPISAH: 002b_tutup_signup_lama.sql
--  — jalankan itu terakhir, setelah Edge Function & aplikasi baru terpasang.)
-- =====================================================================
begin;

-- 1. Jenis login per akun --------------------------------------------
--    email : login biasa (email + password)
--    pin   : tanpa email; login pakai kode usaha + kode karyawan + PIN
alter table public.profiles
  add column if not exists login_type text not null default 'email';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_login_type_check') then
    alter table public.profiles
      add constraint profiles_login_type_check check (login_type in ('email', 'pin'));
  end if;
end $$;

-- login_type hanya boleh diubah oleh server (Edge Function / SQL Editor),
-- tidak oleh user mana pun lewat API (mis. karyawan mengganti dirinya sendiri).
create or replace function public.tg_profiles_login_type_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and new.login_type is distinct from old.login_type then
    raise exception 'login_type tidak boleh diubah';
  end if;
  return new;
end;
$$;
drop trigger if exists aa_profiles_login_type_guard on public.profiles;
create trigger aa_profiles_login_type_guard before update on public.profiles
  for each row execute function public.tg_profiles_login_type_guard();

-- INSERT lewat API juga tidak boleh menetapkan login_type 'pin'
-- (profil dibuat oleh trigger handle_new_user / service role).
create or replace function public.tg_profiles_login_type_insert_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    new.login_type := 'email';
  end if;
  return new;
end;
$$;
drop trigger if exists aa_profiles_login_type_insert_guard on public.profiles;
create trigger aa_profiles_login_type_insert_guard before insert on public.profiles
  for each row execute function public.tg_profiles_login_type_insert_guard();

-- 2. Penghitung salah-PIN (anti tebak-tebakan) -------------------------
--    Hanya dibaca/ditulis Edge Function (service role). Tidak ada policy
--    sama sekali = tertutup untuk semua user aplikasi.
create table if not exists public.pin_login_attempts (
  key          text primary key,            -- 'kodeusaha|kodekaryawan' (huruf kecil)
  fail_count   integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.pin_login_attempts enable row level security;
revoke all on public.pin_login_attempts from anon, authenticated;

-- 3. Apakah pendaftaran usaha publik sedang dibuka? --------------------
--    Boleh dipanggil anonim (halaman daftar.html memakainya untuk
--    memutuskan menampilkan form atau pesan "belum dibuka").
create or replace function public.public_signup_open()
returns boolean language sql security definer stable set search_path = public as $$
  select public.platform_public_mode();
$$;
revoke execute on function public.public_signup_open() from public;
grant execute on function public.public_signup_open() to anon, authenticated;

-- 4. Cek hasil ----------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'login_type') then
    raise exception 'Kolom profiles.login_type gagal dibuat';
  end if;
  raise notice 'OK — Tahap 2 (SQL) terpasang. Lanjut: deploy Edge Function (lihat README-TAHAP-2.md).';
end $$;

commit;
