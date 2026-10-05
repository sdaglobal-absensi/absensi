-- Rollback 018: kembali ke perilaku lama (waktu/jarak/status dari klien).
begin;
drop trigger if exists ad_attendance_server_guard on public.attendance;
drop function if exists public.tg_attendance_server_guard();
drop function if exists public._late_status(uuid, date, timestamptz);
drop function if exists public._user_timezone(uuid);
drop function if exists public._nearest_office_distance(uuid, double precision, double precision);
drop function if exists public.geo_distance_m(double precision, double precision, double precision, double precision);
-- Kolom akurasi dibiarkan (data tambahan, tidak mengganggu).
commit;
