-- =====================================================================
-- 022 — KEPESERTAAN BPJS PER KARYAWAN
--
-- Masalah: potongan BPJS Kesehatan & Ketenagakerjaan di slip gaji dihitung
-- otomatis dari Master Level, jadi SEMUA karyawan yang levelnya cocok kena
-- potongan -- walau karyawan baru belum didaftarkan BPJS.
--
-- Solusi: status kepesertaan disimpan per karyawan. Tarif & upah lapor tetap
-- di Master Level; "dipotong atau tidak" ditentukan oleh kolom di bawah.
--
--   status : 'belum'   = belum terdaftar          -> TIDAK dipotong
--            'aktif'   = terdaftar                -> dipotong
--            'berhenti'= kepesertaan dihentikan   -> TIDAK dipotong
--   mulai  : tanggal mulai dipotong. Slip periode yang mencakup (atau
--            sesudah) tanggal ini mulai memotong. NULL = berlaku sejak awal.
--
-- Karyawan yang SUDAH ADA saat file ini dijalankan otomatis berstatus 'aktif'
-- (mulai NULL) supaya slip mereka tidak berubah. Karyawan BARU berstatus
-- 'belum' sampai admin mengisinya di Data Karyawan.
--
-- Aman dijalankan ulang (idempotent).
-- =====================================================================

-- 1) Kolom. DEFAULT sementara 'aktif' => baris lama ikut terisi 'aktif'.
alter table public.profiles
  add column if not exists bpjs_kes_status text not null default 'aktif',
  add column if not exists bpjs_kes_nomor  text,
  add column if not exists bpjs_kes_mulai  date,
  add column if not exists bpjs_tk_status  text not null default 'aktif',
  add column if not exists bpjs_tk_nomor   text,
  add column if not exists bpjs_tk_mulai   date;

-- 2) Setelah baris lama terisi, default untuk karyawan BARU = 'belum'.
alter table public.profiles alter column bpjs_kes_status set default 'belum';
alter table public.profiles alter column bpjs_tk_status  set default 'belum';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_bpjs_kes_status_check') then
    alter table public.profiles add constraint profiles_bpjs_kes_status_check
      check (bpjs_kes_status in ('belum', 'aktif', 'berhenti'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_bpjs_tk_status_check') then
    alter table public.profiles add constraint profiles_bpjs_tk_status_check
      check (bpjs_tk_status in ('belum', 'aktif', 'berhenti'));
  end if;
end $$;

comment on column public.profiles.bpjs_kes_status is 'BPJS Kesehatan: belum | aktif | berhenti. Hanya "aktif" yang dipotong di slip gaji.';
comment on column public.profiles.bpjs_kes_mulai  is 'Tanggal mulai dipotong BPJS Kesehatan. NULL = sejak awal.';
comment on column public.profiles.bpjs_tk_status  is 'BPJS Ketenagakerjaan: belum | aktif | berhenti. Hanya "aktif" yang dipotong di slip gaji.';
comment on column public.profiles.bpjs_tk_mulai   is 'Tanggal mulai dipotong BPJS Ketenagakerjaan. NULL = sejak awal.';

-- 3) Penjaga: policy "profiles_update_self" mengizinkan karyawan mengubah semua
--    kolom barisnya sendiri (kecuali role). Kolom BPJS memengaruhi gaji, jadi
--    hanya Super Admin / pemegang menu "Data Karyawan" yang boleh mengubahnya.
--    auth.uid() NULL (SQL editor / service role / Edge Function) diizinkan.
create or replace function public.profiles_guard_bpjs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if (new.bpjs_kes_status, new.bpjs_kes_nomor, new.bpjs_kes_mulai,
      new.bpjs_tk_status,  new.bpjs_tk_nomor,  new.bpjs_tk_mulai)
     is distinct from
     (old.bpjs_kes_status, old.bpjs_kes_nomor, old.bpjs_kes_mulai,
      old.bpjs_tk_status,  old.bpjs_tk_nomor,  old.bpjs_tk_mulai)
  then
    if not (public.is_super() or public.has_menu_access('karyawan')) then
      raise exception 'Data BPJS hanya bisa diubah oleh admin (menu Data Karyawan).';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_bpjs on public.profiles;
create trigger trg_profiles_guard_bpjs
  before update on public.profiles
  for each row execute function public.profiles_guard_bpjs();
