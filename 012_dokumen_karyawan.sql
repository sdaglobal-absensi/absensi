-- =====================================================================
-- PRIORITAS MENENGAH #5 — DOKUMEN KARYAWAN & PENGINGAT KONTRAK
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-011. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. Simpan KTP, KK, NPWP, kontrak, ijazah, sertifikat, BPJS, dll per
--      karyawan (PDF / foto) di bucket privat 'employee-docs'.
--   2. Tiap dokumen boleh punya tanggal berakhir (expires_at). Untuk
--      kontrak PKWT = tanggal kontrak habis. Kosong = tidak ada batas.
--   3. Sistem mengingatkan HR lewat lonceng pada H-30, H-7 dan saat sudah
--      lewat. Dokumen yang sudah diperpanjang (ada dokumen yang lebih baru
--      dengan jenis yang sama) otomatis tidak diingatkan lagi.
--   4. Karyawan bisa melihat dokumennya sendiri dan mengunggah dokumen
--      pribadi (KTP, ijazah, dst). KONTRAK hanya bisa diunggah/dihapus HR.
--
-- Hak menu:
--   dokumen        : semua role (Dokumen Saya)
--   dokumen-kelola : Admin HR, Super Admin HR (+ Super Admin) — kelola semua
-- Paket: fitur baru 'dokumen' -> Bisnis, Enterprise, Internal.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.employee_documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id()
               references public.tenants(id) on delete restrict,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  doc_type     text not null check (doc_type in ('ktp', 'kk', 'npwp', 'kontrak', 'ijazah', 'sertifikat', 'bpjs', 'lainnya')),
  title        text not null check (length(btrim(title)) between 1 and 150),
  doc_number   text check (doc_number is null or length(doc_number) <= 80),
  issued_date  date,
  expires_at   date,
  notes        text check (notes is null or length(notes) <= 500),
  file_path    text not null,
  file_name    text,
  uploaded_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  remind_stage smallint,            -- ambang terkecil yang sudah diingatkan: 30 / 7 / 0
  created_at   timestamptz not null default now(),
  constraint employee_documents_dates_chk check (issued_date is null or expires_at is null or expires_at >= issued_date)
);
create index if not exists idx_empdoc_tenant_user on public.employee_documents (tenant_id, user_id, created_at desc);
create index if not exists idx_empdoc_expiry on public.employee_documents (tenant_id, expires_at) where expires_at is not null;

comment on table public.employee_documents is
  'Dokumen karyawan (KTP, kontrak, ijazah, dst). File di bucket privat employee-docs, path <tenant>/<user>/<file>.';

drop trigger if exists aa_tenant_immutable on public.employee_documents;
create trigger aa_tenant_immutable before update on public.employee_documents
  for each row execute function public.tg_tenant_immutable();

-- Pemilik dokumen & tenant harus konsisten; tanggal berakhir diganti -> ingatkan ulang.
create or replace function public.tg_empdoc_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.profiles p where p.id = new.user_id and p.tenant_id = new.tenant_id) then
      raise exception 'Karyawan tidak ditemukan di usaha ini';
    end if;
    if split_part(new.file_path, '/', 1) <> new.tenant_id::text
       or split_part(new.file_path, '/', 2) <> new.user_id::text then
      raise exception 'Lokasi file tidak sesuai dengan pemilik dokumen';
    end if;
  else
    -- Hanya metadata yang boleh diubah; pemilik & file tetap.
    if new.user_id <> old.user_id or new.file_path <> old.file_path then
      raise exception 'Pemilik dan file dokumen tidak bisa diubah';
    end if;
    if new.expires_at is distinct from old.expires_at then
      new.remind_stage := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists ab_empdoc_guard on public.employee_documents;
create trigger ab_empdoc_guard before insert or update on public.employee_documents
  for each row execute function public.tg_empdoc_guard();

-- ---------------------------------------------------------------------
-- 2. STORAGE: bucket privat
--    Path: <tenant_id>/<user_id>/<nama-file>.pdf|jpg|png|webp
-- ---------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('employee-docs', 'employee-docs', false, 10485760,
          array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false, file_size_limit = 10485760,
        allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
exception when others then
  raise notice 'Bucket employee-docs tidak bisa dibuat lewat SQL (%). Buat manual di Dashboard > Storage: nama employee-docs, PRIVATE, batas 10 MB, jenis application/pdf, image/jpeg, image/png, image/webp.', sqlerrm;
end $$;

drop policy if exists "empdoc_insert" on storage.objects;
create policy "empdoc_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'employee-docs'
    and name ~* '\.(pdf|jpe?g|png|webp)$'
    and (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or public.has_menu_access('dokumen-kelola')
    )
  );

drop policy if exists "empdoc_select" on storage.objects;
create policy "empdoc_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'employee-docs'
    and (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or public.has_menu_access('dokumen-kelola')
    )
  );

-- Hapus file: HR bebas; karyawan hanya file miliknya yang BUKAN kontrak.
drop policy if exists "empdoc_delete" on storage.objects;
create policy "empdoc_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'employee-docs'
    and (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    and (
      public.has_menu_access('dokumen-kelola')
      or (
        (storage.foldername(name))[2] = (select auth.uid())::text
        and not exists (
          select 1 from public.employee_documents d
           where d.file_path = name and d.doc_type = 'kontrak'
        )
      )
    )
  );

-- ---------------------------------------------------------------------
-- 3. GERBANG PAKET (fitur 'dokumen')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('dokumen', 'Dokumen Karyawan & Pengingat Kontrak',
   'Simpan KTP, kontrak, ijazah, sertifikat per karyawan dan ingatkan HR sebelum kontrak/sertifikat habis', '{}', 57)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('dokumen', 'dokumen'), ('dokumen-kelola', 'dokumen')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['dokumen']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('dokumen' = any(features));

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.employee_documents enable row level security;

drop policy if exists tenant_isolation on public.employee_documents;
create policy tenant_isolation on public.employee_documents as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.employee_documents;
create policy feature_gate on public.employee_documents as restrictive for all to authenticated
  using ((select public.tenant_has_feature('dokumen')))
  with check ((select public.tenant_has_feature('dokumen')));

-- HR: semua dokumen satu usaha.
drop policy if exists empdoc_manage on public.employee_documents;
create policy empdoc_manage on public.employee_documents for all
  using (public.has_menu_access('dokumen-kelola'))
  with check (public.has_menu_access('dokumen-kelola'));

-- Karyawan: lihat semua dokumennya sendiri.
drop policy if exists empdoc_own_select on public.employee_documents;
create policy empdoc_own_select on public.employee_documents for select
  using (user_id = auth.uid());

-- Karyawan: unggah dokumen pribadi sendiri (bukan kontrak).
drop policy if exists empdoc_own_insert on public.employee_documents;
create policy empdoc_own_insert on public.employee_documents for insert
  with check (
    user_id = auth.uid()
    and uploaded_by = auth.uid()
    and doc_type <> 'kontrak'
    and public.has_menu_access('dokumen')
  );

-- Karyawan: hapus dokumen yang ia unggah sendiri (bukan kontrak).
drop policy if exists empdoc_own_delete on public.employee_documents;
create policy empdoc_own_delete on public.employee_documents for delete
  using (
    user_id = auth.uid()
    and uploaded_by = auth.uid()
    and doc_type <> 'kontrak'
    and public.has_menu_access('dokumen')
  );

-- ---------------------------------------------------------------------
-- 5. DOKUMEN YANG SEGERA BERAKHIR
--    "Sudah diperpanjang" = ada dokumen lain milik orang yang sama, jenis
--    sama (kontrak: judul bebas; selain kontrak: judul sama) dengan tanggal
--    berakhir lebih akhir, atau tanpa batas dan diunggah lebih baru.
-- ---------------------------------------------------------------------
create or replace function public.documents_expiring(p_days integer default 30)
returns table (
  id uuid, user_id uuid, doc_type text, title text,
  expires_at date, days_left integer
)
language sql stable set search_path = public as $$
  select d.id, d.user_id, d.doc_type, d.title, d.expires_at,
         (d.expires_at - (now() at time zone 'Asia/Jakarta')::date)::integer as days_left
    from public.employee_documents d
   where public.has_menu_access('dokumen-kelola')
     and d.expires_at is not null
     and d.expires_at <= (now() at time zone 'Asia/Jakarta')::date + greatest(p_days, 0)
     and not exists (
       select 1 from public.employee_documents n
        where n.user_id = d.user_id
          and n.doc_type = d.doc_type
          and n.id <> d.id
          and (d.doc_type = 'kontrak' or lower(btrim(n.title)) = lower(btrim(d.title)))
          and (
            n.expires_at > d.expires_at
            or (n.expires_at is null and n.created_at > d.created_at)
          )
     )
   order by d.expires_at, d.title;
$$;
grant execute on function public.documents_expiring(integer) to authenticated;

-- ---------------------------------------------------------------------
-- 6. NOTIFIKASI LONCENG
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.notifications'::regclass and contype = 'c'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.notifications add constraint notifications_type_check
  check (type in ('approval_needed', 'approval_decided', 'announcement',
                  'field_work_needed', 'field_work_decided', 'loan_needed', 'loan_decided',
                  'expense_needed', 'expense_decided', 'document_expiry'));
alter table public.notifications add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement', 'field_work', 'loan', 'expense', 'document'));

-- Inti pemindaian satu usaha. Tidak boleh dipanggil klien.
create or replace function public._docs_expiry_scan(p_tenant uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r       record;
  v_stage smallint;
  v_count integer := 0;
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_when  text;
begin
  if not ('dokumen' = any(public.effective_features(p_tenant))) then
    return 0;
  end if;

  for r in
    select d.id, d.user_id, d.doc_type, d.title, d.expires_at, d.remind_stage,
           (d.expires_at - v_today)::integer as days_left,
           p.full_name
      from public.employee_documents d
      join public.profiles p on p.id = d.user_id and p.is_active
     where d.tenant_id = p_tenant
       and d.expires_at is not null
       and d.expires_at <= v_today + 30
       and not exists (
         select 1 from public.employee_documents n
          where n.user_id = d.user_id and n.doc_type = d.doc_type and n.id <> d.id
            and (d.doc_type = 'kontrak' or lower(btrim(n.title)) = lower(btrim(d.title)))
            and (n.expires_at > d.expires_at or (n.expires_at is null and n.created_at > d.created_at))
       )
  loop
    v_stage := case when r.days_left <= 0 then 0 when r.days_left <= 7 then 7 else 30 end;
    if r.remind_stage is not null and r.remind_stage <= v_stage then
      continue;  -- tahap ini (atau yang lebih mendesak) sudah diingatkan
    end if;

    v_when := case
      when r.days_left < 0 then 'sudah lewat ' || (-r.days_left) || ' hari'
      when r.days_left = 0 then 'berakhir hari ini'
      else 'berakhir ' || r.days_left || ' hari lagi'
    end;

    insert into public.notifications (tenant_id, user_id, type, title, body, request_type, request_id)
    select p_tenant, u.id, 'document_expiry',
           case when r.doc_type = 'kontrak' then 'Kontrak ' else 'Dokumen ' end || r.full_name || ' ' || v_when,
           r.title || ' · tanggal berakhir ' || to_char(r.expires_at, 'DD-MM-YYYY'),
           'document', r.id
      from public.profiles u
     where u.tenant_id = p_tenant and u.is_active
       and (
         u.role = 'super_admin'
         or exists (
           select 1 from public.role_permissions rp
            where rp.tenant_id = p_tenant and rp.role = u.role
              and rp.menu_id = 'dokumen-kelola' and rp.enabled
         )
       );

    update public.employee_documents set remind_stage = v_stage where id = r.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke execute on function public._docs_expiry_scan(uuid) from public, anon, authenticated;

-- Dipanggil aplikasi saat HR membuka halaman Dokumen Karyawan / Dashboard.
create or replace function public.docs_expiry_scan()
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.has_menu_access('dokumen-kelola') then
    return 0;
  end if;
  return public._docs_expiry_scan(public.current_tenant_id());
end;
$$;
revoke execute on function public.docs_expiry_scan() from public, anon;
grant execute on function public.docs_expiry_scan() to authenticated;

-- Opsional: untuk dijadwalkan harian lewat pg_cron (semua usaha sekaligus).
create or replace function public.docs_expiry_scan_all()
returns integer language plpgsql security definer set search_path = public as $$
declare t record; v integer := 0;
begin
  for t in select id from public.tenants loop
    v := v + public._docs_expiry_scan(t.id);
  end loop;
  return v;
end;
$$;
revoke execute on function public.docs_expiry_scan_all() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. HAK MENU
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'dokumen', true), ('admin_hr', 'dokumen', true),
  ('admin_approval', 'dokumen', true), ('karyawan', 'dokumen', true),
  ('super_admin_hr', 'dokumen-kelola', true), ('admin_hr', 'dokumen-kelola', true),
  ('admin_approval', 'dokumen-kelola', false), ('karyawan', 'dokumen-kelola', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('dokumen', 'dokumen-kelola')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): versi 011 + 'dokumen'.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse','dokumen'];
begin
  if p_template = 'lengkap' then
    update public.tenants set role_mode = 'lengkap' where id = p_tenant;
  elsif p_template = 'ringkas' then
    update public.tenants set role_mode = 'ringkas' where id = p_tenant;
    update public.role_permissions
       set enabled = (role = 'karyawan' and menu_id = any(v_personal))
     where tenant_id = p_tenant;
    insert into public.role_permissions (tenant_id, role, menu_id, enabled)
    select p_tenant, 'karyawan', m, true from unnest(v_personal) m
    on conflict (tenant_id, role, menu_id) do update set enabled = true;
  else
    raise exception 'Template "%" tidak dikenal (pilih: lengkap / ringkas)', p_template;
  end if;
end;
$$;
revoke execute on function public.seed_tenant_template(uuid, text) from public, anon, authenticated;

commit;

-- =====================================================================
-- OPSIONAL — jadwalkan pemindaian harian (butuh ekstensi pg_cron):
--   select cron.schedule('docs-expiry', '0 1 * * *', $$select public.docs_expiry_scan_all()$$);  -- 08:00 WIB
-- Tanpa cron pun pengingat tetap muncul begitu HR membuka menu Dokumen Karyawan.
--
-- ROLLBACK (manual):
--   drop table if exists public.employee_documents cascade;
--   drop function if exists public.documents_expiring(integer), public.docs_expiry_scan(),
--                           public.docs_expiry_scan_all(), public._docs_expiry_scan(uuid);
--   drop policy if exists "empdoc_insert" on storage.objects;
--   drop policy if exists "empdoc_select" on storage.objects;
--   drop policy if exists "empdoc_delete" on storage.objects;
--   delete from public.role_permissions where menu_id in ('dokumen','dokumen-kelola');
--   delete from public.role_permission_defaults where menu_id in ('dokumen','dokumen-kelola');
--   delete from public.menu_features where menu_id in ('dokumen','dokumen-kelola');
--   update public.plans set features = array_remove(features, 'dokumen');
--   delete from public.feature_catalog where kode = 'dokumen';
-- =====================================================================
