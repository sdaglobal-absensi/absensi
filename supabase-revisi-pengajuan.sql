-- =====================================================================
-- REVISI / PENGAJUAN ULANG untuk izin & lembur yang DITOLAK
-- Jalankan sekali di Supabase SQL Editor (aman dijalankan ulang).
--
-- Cara kerja: karyawan menekan "Ajukan Ulang" pada pengajuan yang ditolak,
-- lalu data dikirim sebagai pengajuan BARU (melewati alur approval dari awal)
-- yang menunjuk ke pengajuan lama lewat kolom revision_of. Pengajuan lama
-- TIDAK diubah sama sekali, jadi riwayat ditolak/disetujui + catatan
-- penolakan + tahap approvalnya tetap utuh.
-- =====================================================================

-- 1. Kolom penaut ke pengajuan yang direvisi
alter table public.leave_requests
  add column if not exists revision_of uuid references public.leave_requests(id) on delete set null;
alter table public.overtime_requests
  add column if not exists revision_of uuid references public.overtime_requests(id) on delete set null;

-- 2. Satu pengajuan ditolak hanya boleh punya SATU revisi
--    (kalau revisinya ditolak lagi, revisi berikutnya menaut ke revisi itu)
create unique index if not exists uq_leave_revision_of
  on public.leave_requests(revision_of) where revision_of is not null;
create unique index if not exists uq_overtime_revision_of
  on public.overtime_requests(revision_of) where revision_of is not null;

-- 3. Penjaga di server: revisi hanya untuk pengajuan MILIK SENDIRI yang
--    berstatus DITOLAK (tidak bisa dipalsukan lewat API).
create or replace function public.requests_check_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner  uuid;
  v_status text;
begin
  if new.revision_of is null then
    return new;
  end if;

  if tg_table_name = 'leave_requests' then
    select user_id, status into v_owner, v_status from public.leave_requests where id = new.revision_of;
  else
    select user_id, status into v_owner, v_status from public.overtime_requests where id = new.revision_of;
  end if;

  if v_owner is null then
    raise exception 'Pengajuan asal tidak ditemukan';
  end if;
  if v_owner <> new.user_id then
    raise exception 'Pengajuan asal bukan milikmu';
  end if;
  if v_status <> 'rejected' then
    raise exception 'Hanya pengajuan yang ditolak yang bisa diajukan ulang';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leave_check_revision on public.leave_requests;
create trigger trg_leave_check_revision
  before insert on public.leave_requests
  for each row execute function public.requests_check_revision();

drop trigger if exists trg_overtime_check_revision on public.overtime_requests;
create trigger trg_overtime_check_revision
  before insert on public.overtime_requests
  for each row execute function public.requests_check_revision();
