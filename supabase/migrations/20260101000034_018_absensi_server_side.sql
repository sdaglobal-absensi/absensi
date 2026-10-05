-- =====================================================================
-- 018 — ABSENSI DINILAI SERVER (waktu, jarak GPS, status telat)
--
-- MASALAH: sebelumnya jam check-in/out (new Date() di HP), jarak ke kantor,
-- dan status telat/tepat waktu dihitung di browser lalu di-insert langsung.
-- Siapa pun bisa mengubah jam HP atau memanggil API Supabase langsung
-- untuk memalsukan datanya.
--
-- PERBAIKAN: trigger BEFORE INSERT/UPDATE pada public.attendance yang, untuk
-- request langsung dari karyawan (role DB `authenticated` dan auth.uid() =
-- user_id), memaksa:
--   * check_in / check_out = now() milik server,
--   * check_in_distance_m / check_out_distance_m = hitung haversine di server
--     terhadap kantor aktif terdekat milik tenant (lat/lng dari klien),
--   * check_in_status = hasil hitung server dari jadwal (+ tukar shift) dan
--     zona waktu kantor, sama dengan logika lama di employee-absensi.js,
--   * kolom check-in tidak bisa diubah lagi lewat update, check-out hanya
--     bisa diisi sekali, tanggal harus hari ini/kemarin menurut zona waktu.
-- Fungsi SECURITY DEFINER (mis. apply_attendance_correction) berjalan sebagai
-- owner (current_user <> 'authenticated'), jadi TIDAK terkena trigger ini;
-- begitu juga edit admin atas baris orang lain.
--
-- Perilaku yang sengaja dipertahankan: absen di luar radius tetap diterima
-- (ditinjau admin) — hanya angka jaraknya yang kini tepercaya.
--
-- Aman dijalankan ulang. Rollback: lihat 018z_rollback_absensi_server_side.sql
-- =====================================================================

begin;

-- Akurasi GPS yang dilaporkan perangkat (meter) — disimpan sebagai bukti
-- tambahan; akurasi buruk bisa ditinjau admin.
alter table public.attendance add column if not exists check_in_accuracy_m  numeric;
alter table public.attendance add column if not exists check_out_accuracy_m numeric;

-- Jarak haversine dalam meter.
create or replace function public.geo_distance_m(lat1 double precision, lng1 double precision,
                                                 lat2 double precision, lng2 double precision)
returns double precision language sql immutable parallel safe as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Jarak ke kantor aktif terdekat dalam tenant karyawan (null kalau tak ada koordinat/kantor).
-- Helper ini dipanggil dari trigger yang berjalan sebagai `authenticated`, jadi
-- diberi GRANT; guard di dalamnya memastikan klien hanya bisa menanyakan
-- tenant-nya sendiri (bukan menebak koordinat kantor usaha lain).
create or replace function public._nearest_office_distance(p_tenant uuid, p_lat double precision, p_lng double precision)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v numeric;
begin
  if auth.uid() is not null
     and p_tenant is distinct from (select tenant_id from public.profiles where id = auth.uid()) then
    return null;
  end if;
  select round(min(public.geo_distance_m(p_lat, p_lng, o.lat, o.lng))::numeric) into v
    from public.office_locations o
   where o.tenant_id = p_tenant and o.is_active
     and p_lat is not null and p_lng is not null;
  return v;
end;
$$;
revoke execute on function public._nearest_office_distance(uuid, double precision, double precision) from public, anon;
grant execute on function public._nearest_office_distance(uuid, double precision, double precision) to authenticated;

-- Zona waktu kantor tempat karyawan ditempatkan (default Asia/Jakarta).
create or replace function public._user_timezone(p_user uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    return 'Asia/Jakarta';
  end if;
  select o.timezone into v from public.profiles p
    join public.office_locations o on o.tenant_id = p.tenant_id and o.name = p.lokasi_kerja
   where p.id = p_user limit 1;
  return coalesce(v, 'Asia/Jakarta');
end;
$$;
revoke execute on function public._user_timezone(uuid) from public, anon;
grant execute on function public._user_timezone(uuid) to authenticated;

-- Status telat dihitung dari jadwal. Mengembalikan null kalau tak ada acuan
-- (hari libur / baris jadwal tidak ada) — sama seperti getLateCutoff() lama.
create or replace function public._late_status(p_user uuid, p_date date, p_at timestamptz)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := public._user_timezone(p_user);
  v_sched uuid;
  v_tol int := 0;
  v_day record;
  v_cutoff timestamptz;
begin
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    return null;  -- klien hanya boleh menanyakan jadwalnya sendiri
  end if;
  select coalesce(
           (select so.schedule_id from public.schedule_overrides so
             where so.user_id = p_user and so.work_date = p_date),
           (select p.schedule_id from public.profiles p where p.id = p_user))
    into v_sched;

  if v_sched is null then
    -- Tanpa jadwal: acuan bawaan aplikasi 08:15 (selaras dengan klien lama).
    v_cutoff := ((p_date::timestamp + time '08:15') at time zone v_tz);
    return case when p_at > v_cutoff then 'telat' else 'tepat_waktu' end;
  end if;

  select coalesce(ws.late_tolerance_minutes, 0) into v_tol
    from public.work_schedules ws where ws.id = v_sched;

  select d.is_working_day, d.start_time into v_day
    from public.work_schedule_days d
   where d.schedule_id = v_sched and d.day_of_week = extract(dow from p_date)::int;

  if v_day.is_working_day is not true or v_day.start_time is null then
    return null;
  end if;

  v_cutoff := ((p_date::timestamp + v_day.start_time) at time zone v_tz) + make_interval(mins => v_tol);
  return case when p_at > v_cutoff then 'telat' else 'tepat_waktu' end;
end;
$$;
revoke execute on function public._late_status(uuid, date, timestamptz) from public, anon;
grant execute on function public._late_status(uuid, date, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- TRIGGER UTAMA
-- ---------------------------------------------------------------------
create or replace function public.tg_attendance_server_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  v_tenant uuid;
  v_tz text;
  v_local_today date;
begin
  -- Hanya request langsung karyawan atas barisnya sendiri. Fungsi ini sengaja
  -- SECURITY INVOKER: di dalam fungsi SECURITY DEFINER lain (mis.
  -- apply_attendance_correction) current_user = owner, bukan `authenticated`,
  -- sehingga jam hasil koreksi yang disetujui TIDAK ditimpa. Edit admin atas
  -- baris orang lain juga dilewati (auth.uid() <> user_id).
  if current_user <> 'authenticated' then
    return new;
  end if;
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    return new;
  end if;

  select tenant_id into v_tenant from public.profiles where id = new.user_id;  -- RLS: baris sendiri boleh dibaca
  v_tz := public._user_timezone(new.user_id);
  v_local_today := (now() at time zone v_tz)::date;

  if tg_op = 'INSERT' then
    if new.date < v_local_today - 1 or new.date > v_local_today then
      raise exception 'Tanggal absensi tidak valid (harus hari ini atau kemarin).';
    end if;

    if new.check_in is not null then
      new.check_in := now();
      new.check_in_distance_m := public._nearest_office_distance(v_tenant, new.check_in_lat, new.check_in_lng);
      new.check_in_status := public._late_status(new.user_id, new.date, new.check_in);
    else
      new.check_in_lat := null; new.check_in_lng := null; new.check_in_distance_m := null;
      new.check_in_status := null; new.check_in_photo_url := null; new.check_in_accuracy_m := null;
    end if;

    if new.check_out is not null then
      new.check_out := now();
      new.check_out_distance_m := public._nearest_office_distance(v_tenant, new.check_out_lat, new.check_out_lng);
    else
      new.check_out_lat := null; new.check_out_lng := null; new.check_out_distance_m := null;
      new.check_out_photo_url := null; new.check_out_accuracy_m := null;
    end if;
    return new;
  end if;

  -- UPDATE oleh pemilik: sisi check-in dikunci; check-out hanya sekali.
  new.user_id := old.user_id;
  new.date := old.date;
  new.check_in := old.check_in;
  new.check_in_lat := old.check_in_lat;
  new.check_in_lng := old.check_in_lng;
  new.check_in_distance_m := old.check_in_distance_m;
  new.check_in_photo_url := old.check_in_photo_url;
  new.check_in_status := old.check_in_status;
  new.check_in_accuracy_m := old.check_in_accuracy_m;

  if old.check_out is not null then
    new.check_out := old.check_out;
    new.check_out_lat := old.check_out_lat;
    new.check_out_lng := old.check_out_lng;
    new.check_out_distance_m := old.check_out_distance_m;
    new.check_out_photo_url := old.check_out_photo_url;
    new.check_out_accuracy_m := old.check_out_accuracy_m;
  elsif new.check_out is not null then
    new.check_out := now();
    new.check_out_distance_m := public._nearest_office_distance(v_tenant, new.check_out_lat, new.check_out_lng);
  end if;
  return new;
end;
$$;

drop trigger if exists ad_attendance_server_guard on public.attendance;
create trigger ad_attendance_server_guard
  before insert or update on public.attendance
  for each row execute function public.tg_attendance_server_guard();

commit;

-- UJI MANUAL (jalankan sebagai karyawan lewat API, bukan SQL Editor):
--   1. Insert attendance dengan check_in = '2020-01-01' -> tersimpan now().
--   2. Insert dengan check_in_distance_m = 0 padahal jauh -> tertimpa hitungan server.
--   3. Update check_in sesudah insert -> nilai lama tetap.
--   4. Ajukan koreksi absen & setujui -> jam hasil koreksi tetap (bukan now()).
