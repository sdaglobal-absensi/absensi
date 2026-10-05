-- =====================================================================
-- PERBAIKAN: Approval Koreksi Absen gagal dengan pesan
-- "Gagal memperbarui: Jenis pengajuan tidak valid"
--
-- PENYEBAB: fungsi decide_approval() didefinisikan ulang secara TERPISAH
-- oleh dua file migrasi yang tidak saling tahu satu sama lain:
--   - supabase-koreksi-absen.sql  -> menambahkan dukungan kind 'koreksi'
--   - supabase-cuti-khusus.sql    -> menambahkan potong/kembalikan saldo
--                                     Cuti Tahunan (leave_balances)
-- Karena keduanya sama-sama "CREATE OR REPLACE FUNCTION decide_approval",
-- yang terakhir dijalankan MENIMPA SELURUH ISI fungsi (bukan digabung).
-- Kalau supabase-cuti-khusus.sql dijalankan belakangan (seperti yang
-- kelihatannya terjadi di database kamu), dukungan kind 'koreksi' hilang
-- lagi -> approval Koreksi Absen jadi gagal dengan pesan di atas.
--
-- File ini menggabungkan KEDUA fitur itu jadi satu fungsi final, supaya
-- Approval Izin (termasuk potong saldo Cuti Tahunan) DAN Approval Koreksi
-- Absen sama-sama jalan. Jalankan SEKALI di Supabase SQL Editor, dan boleh
-- dijalankan ulang kapan pun dengan aman (idempotent). Jalankan ini PALING
-- TERAKHIR setelah supabase-schema.sql, supabase-org-approval.sql,
-- supabase-cuti-khusus.sql, dan supabase-koreksi-absen.sql.
-- =====================================================================

create or replace function public.decide_approval(
  p_kind text, p_request_id uuid, p_decision text, p_notes text default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_tbl    text;
  v_owner  uuid;
  v_status text;
  v_leave_category text;
  v_start  date;
  v_end    date;
  v_step   public.request_approvals%rowtype;
  v_next   public.request_approvals%rowtype;
  v_final  text := 'pending';
  v_days   integer;
  v_kuota  numeric;
  v_terpakai numeric;
  v_year   integer;
begin
  if v_uid is null then raise exception 'Belum login'; end if;
  if p_kind not in ('leave', 'overtime', 'koreksi') then raise exception 'Jenis pengajuan tidak valid'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  v_tbl := case p_kind
    when 'leave' then 'leave_requests'
    when 'overtime' then 'overtime_requests'
    else 'attendance_correction_requests'
  end;

  if p_kind = 'leave' then
    select user_id, status, leave_category, start_date, end_date
      into v_owner, v_status, v_leave_category, v_start, v_end
      from public.leave_requests where id = p_request_id for update;
  else
    execute format('select user_id, status from public.%I where id = $1 for update', v_tbl)
      into v_owner, v_status using p_request_id;
  end if;

  if v_owner is null then raise exception 'Pengajuan tidak ditemukan'; end if;
  if v_status <> 'pending' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_owner = v_uid then raise exception 'Tidak boleh memproses pengajuan sendiri'; end if;

  select * into v_step
  from public.request_approvals
  where request_type = p_kind and request_id = p_request_id and status = 'pending'
  order by step_order limit 1
  for update;

  if found then
    if not (v_uid = any (v_step.approver_ids) or public.is_super()) then
      raise exception 'Bukan giliran kamu untuk memproses pengajuan ini';
    end if;

    update public.request_approvals
      set status = p_decision, decided_by = v_uid, decided_at = now(), notes = p_notes,
          decided_by_name = (select full_name from public.profiles where id = v_uid)
      where id = v_step.id;

    if p_decision = 'rejected' then
      update public.request_approvals set status = 'skipped'
        where request_type = p_kind and request_id = p_request_id and status = 'waiting';
      v_final := 'rejected';
    else
      select * into v_next
      from public.request_approvals
      where request_type = p_kind and request_id = p_request_id and status = 'waiting'
      order by step_order limit 1;
      if found then
        update public.request_approvals set status = 'pending' where id = v_next.id;
      else
        v_final := 'approved';
      end if;
    end if;
  else
    -- Tidak ada tahap sama sekali (tidak ada approver ditemukan): hanya Super Admin.
    if not public.is_super() then
      raise exception 'Pengajuan ini belum punya approver. Hubungi Super Admin.';
    end if;
    v_final := p_decision;
  end if;

  -- Cuti Tahunan: potong saldo HANYA saat status akhir benar-benar 'approved'.
  -- Dicek ulang di sini (bukan cuma saat submit) supaya 2 pengajuan pending
  -- yang sama-sama disetujui tidak dobel memakai saldo yang sama.
  if v_final = 'approved' and p_kind = 'leave' and v_leave_category = 'tahunan' then
    v_days := (v_end - v_start) + 1;
    v_year := extract(year from v_start)::int;
    select kuota_hari, terpakai_hari into v_kuota, v_terpakai
      from public.leave_balances where user_id = v_owner and tahun = v_year
      for update;
    if v_kuota is null then
      raise exception 'Kuota Cuti Tahunan % belum diatur untuk karyawan ini. Hubungi admin.', v_year;
    end if;
    if v_terpakai + v_days > v_kuota then
      raise exception 'Sisa Cuti Tahunan karyawan ini tidak mencukupi (sisa % hari, pengajuan % hari) -- kemungkinan ada pengajuan lain yang sudah memakai saldo ini duluan', (v_kuota - v_terpakai), v_days;
    end if;
    update public.leave_balances set terpakai_hari = terpakai_hari + v_days
      where user_id = v_owner and tahun = v_year;
  end if;

  if v_final <> 'pending' then
    execute format(
      'update public.%I set status = $1, reviewed_by = $2, reviewed_at = now(), review_notes = $3 where id = $4',
      v_tbl
    ) using v_final, v_uid, p_notes, p_request_id;

    -- Koreksi Absen: terapkan jam yang diajukan ke tabel attendance begitu
    -- disetujui sampai tahap terakhir.
    if v_final = 'approved' and p_kind = 'koreksi' then
      perform public.apply_attendance_correction(p_request_id);
    end if;
  end if;

  return v_final;
end;
$$;
