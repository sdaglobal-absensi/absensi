-- =====================================================================
-- 003z_rollback_tahap3.sql — MUNDUR dari Tahap 3 (hanya bila perlu)
--
-- Mengembalikan aturan foto Storage seperti sebelum Tahap 3 (semua user
-- login boleh baca & upload di bucket attendance-photos). Audit log TIDAK
-- dihapus (data tetap aman dan trigger tetap jalan; tidak mengganggu).
--
-- Setelah menjalankan ini, WAJIB juga:
--   1. Dashboard > Storage > attendance-photos > Edit > aktifkan "Public bucket"
--      (supaya URL foto lama yang tersimpan di database terbuka lagi).
--   2. Upload kembali versi JS Tahap 2 (js/core.js, employee-absensi.js,
--      employee-profil.js, admin-absensi.js) — JS Tahap 3 menyimpan PATH,
--      bukan URL. Foto yang diunggah selama Tahap 3 baru terbaca oleh JS
--      Tahap 3 (di database tersimpan sebagai path).
--
-- PERINGATAN KEAMANAN: setelah mundur, foto kembali dapat dibaca siapa pun
-- yang tahu URL-nya. Jangan nyalakan public_mode dalam kondisi ini.
-- =====================================================================
begin;
drop policy if exists "photo_insert_own_tenant" on storage.objects;
drop policy if exists "photo_select_tenant"     on storage.objects;
drop policy if exists "photo_upload_own"        on storage.objects;
drop policy if exists "photo_read_all"          on storage.objects;

create policy "photo_upload_own" on storage.objects
  for insert with check (bucket_id = 'attendance-photos' and auth.role() = 'authenticated');
create policy "photo_read_all" on storage.objects
  for select using (bucket_id = 'attendance-photos');
commit;
