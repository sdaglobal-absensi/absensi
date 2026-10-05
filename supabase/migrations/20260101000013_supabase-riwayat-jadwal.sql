-- =====================================================================
-- RIWAYAT PENGGANTIAN JADWAL KERJA KARYAWAN
--
-- Masalah: halaman Riwayat Absensi menilai semua tanggal memakai jadwal
-- karyawan yang berlaku SEKARANG (profiles.schedule_id). Kalau jadwal
-- diganti di tengah bulan, hari-hari sebelum penggantian ikut berubah.
--
-- Solusi: tabel ini mencatat jadwal apa yang berlaku sejak tanggal berapa.
-- Diisi OTOMATIS oleh trigger tiap kali profiles.schedule_id berubah
-- (dari Master Jadwal Kerja maupun dari tempat lain) -- tidak perlu ubah
-- alur admin. Halaman Riwayat lalu memilih jadwal sesuai tanggalnya.
--
-- Catatan:
--  - Penggantian jadwal yang terjadi SEBELUM file ini dijalankan tidak
--    bisa dilacak; jadwal karyawan saat ini dianggap berlaku "dari dulu".
--  - Penggantian dicatat berlaku mulai HARI ini (zona waktu Asia/Jakarta).
--  - Aman dijalankan ulang (idempotent).
-- =====================================================================

create table if not exists public.employee_schedule_history (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  schedule_id    uuid references public.work_schedules(id) on delete set null, -- null = tanpa jadwal
  effective_from date not null,
  created_at     timestamptz not null default now(),
  unique (user_id, effective_from)
);
create index if not exists idx_esh_user_from on public.employee_schedule_history(user_id, effective_from desc);

comment on table public.employee_schedule_history is 'Jadwal kerja karyawan berlaku mulai tanggal X (sampai baris berikutnya). Diisi trigger dari profiles.schedule_id.';

alter table public.employee_schedule_history enable row level security;

-- Karyawan boleh lihat riwayat jadwalnya sendiri; staf/admin boleh lihat semua.
-- Tidak ada policy insert/update/delete: penulisan hanya lewat trigger (security definer).
drop policy if exists "esh_select" on public.employee_schedule_history;
create policy "esh_select" on public.employee_schedule_history
  for select using ( user_id = auth.uid() or public.is_staff() );

-- ---------------------------------------------------------------------
-- Backfill: jadwal saat ini dianggap berlaku sejak dulu.
-- ---------------------------------------------------------------------
insert into public.employee_schedule_history (user_id, schedule_id, effective_from)
select p.id, p.schedule_id, date '1900-01-01'
from public.profiles p
where p.schedule_id is not null
on conflict (user_id, effective_from) do nothing;

-- ---------------------------------------------------------------------
-- Trigger: catat setiap perubahan schedule_id
-- ---------------------------------------------------------------------
create or replace function public.log_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date;
begin
  if tg_op = 'INSERT' then
    if new.schedule_id is null then return new; end if;
    v_from := date '1900-01-01';
  else
    if new.schedule_id is not distinct from old.schedule_id then return new; end if;
    v_from := (now() at time zone 'Asia/Jakarta')::date;

    -- Karyawan yang belum punya riwayat sama sekali (jadwal lama tak tercatat):
    -- simpan jadwal lamanya dulu supaya hari-hari sebelum hari ini tetap memakainya.
    if old.schedule_id is not null and not exists (
      select 1 from public.employee_schedule_history where user_id = new.id
    ) then
      insert into public.employee_schedule_history (user_id, schedule_id, effective_from)
      values (new.id, old.schedule_id, date '1900-01-01');
    end if;
  end if;

  insert into public.employee_schedule_history (user_id, schedule_id, effective_from)
  values (new.id, new.schedule_id, v_from)
  on conflict (user_id, effective_from) do update set schedule_id = excluded.schedule_id;

  return new;
end;
$$;

drop trigger if exists trg_log_schedule_change on public.profiles;
create trigger trg_log_schedule_change
  after insert or update of schedule_id on public.profiles
  for each row execute function public.log_schedule_change();
