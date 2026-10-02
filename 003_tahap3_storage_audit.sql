-- =====================================================================
-- 003_tahap3_storage_audit.sql — TAHAP 3: storage foto privat per usaha
-- (tenant) + audit log.
--
-- Jalankan SETELAH 001 dan 002. Aman dijalankan ulang (idempotent).
-- Seluruh file berjalan dalam SATU transaksi.
--
-- YANG DILAKUKAN
--   1. Aturan baca/tulis foto di Storage (bucket `attendance-photos`):
--        path baru : <tenant_id>/<user_id>/<profile|in|out>/<waktu>.jpg
--        - upload hanya ke folder usaha sendiri DAN folder akun sendiri,
--          hanya ekstensi gambar (jpg/jpeg/png/webp)
--        - foto profil : dibaca semua anggota usaha yang sama
--        - foto absensi: dibaca pemiliknya + yang punya menu "Monitor Absensi"
--        - path LAMA (<user_id>/in|out/… dan profile-photos/<user_id>/…)
--          tidak perlu dipindah: usaha pemiliknya dicari lewat profil.
--      Aturan lama `photo_read_all` (siapa pun boleh baca) DIHAPUS.
--      CATATAN: aturan ini baru "mengunci" setelah bucket diubah menjadi
--      PRIVAT di Dashboard (lihat README-TAHAP-3.md, langkah 6).
--   2. Tabel `audit_log` + trigger di tabel-tabel penting. Tidak bisa
--      diubah/dihapus dari aplikasi; hanya Super Admin (atau role yang
--      diberi menu "audit-log") yang bisa membacanya.
--   3. Fungsi `audit_write()` untuk Edge Function (catat pembuatan akun &
--      reset PIN).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. PRASYARAT
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.tenants') is null or to_regprocedure('public.current_tenant_id()') is null then
    raise exception 'Jalankan 001_multi_tenant.sql dulu.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'login_type') then
    raise exception 'Jalankan 002_tahap2_akun.sql dulu.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. STORAGE FOTO
-- ---------------------------------------------------------------------
-- photo_info(nama_objek) -> (tenant_id, owner_id, kind) atau 0 baris
-- kalau path tidak dikenali. SECURITY DEFINER karena path lama dicocokkan
-- ke tabel profiles (usaha pemilik foto lama = usaha profil pemiliknya).
create or replace function public.photo_info(p_name text)
returns table (tenant_id uuid, owner_id uuid, kind text)
language plpgsql stable security definer set search_path = public as $$
declare
  s  text[] := string_to_array(p_name, '/');
  re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  n  integer := coalesce(array_length(s, 1), 0);
begin
  -- baru: <tenant>/<user>/<profile|in|out>/<file>
  if n = 4 and s[1] ~ re and s[2] ~ re and s[3] in ('profile', 'in', 'out') then
    return query select s[1]::uuid, s[2]::uuid, s[3];
    return;
  end if;
  -- lama: <user>/<in|out>/<file>
  if n = 3 and s[1] ~ re and s[2] in ('in', 'out') then
    return query select p.tenant_id, p.id, s[2] from public.profiles p where p.id = s[1]::uuid;
    return;
  end if;
  -- lama: profile-photos/<user>/<file>
  if n = 3 and s[1] = 'profile-photos' and s[2] ~ re then
    return query select p.tenant_id, p.id, 'profile'::text from public.profiles p where p.id = s[2]::uuid;
    return;
  end if;
end;
$$;
revoke all on function public.photo_info(text) from public;
grant execute on function public.photo_info(text) to authenticated;

-- Batas ukuran & jenis file di level bucket (bila SQL Editor boleh;
-- kalau tidak, atur manual di Dashboard > Storage > bucket > Edit).
do $$
begin
  update storage.buckets
     set file_size_limit = 5242880,
         allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
   where id = 'attendance-photos';
  if not found then
    raise notice 'Bucket attendance-photos belum ada — buat dulu di Dashboard > Storage (lihat README-TAHAP-3.md).';
  end if;
exception when others then
  raise notice 'Batas ukuran/jenis file bucket tidak bisa diatur lewat SQL (%). Atur manual di Dashboard.', sqlerrm;
end $$;

drop policy if exists "photo_upload_own"        on storage.objects;
drop policy if exists "photo_read_all"          on storage.objects;
drop policy if exists "photo_insert_own_tenant" on storage.objects;
drop policy if exists "photo_select_tenant"     on storage.objects;

-- UPLOAD: hanya ke <usaha sendiri>/<akun sendiri>/<profile|in|out>/<file gambar>
create policy "photo_insert_own_tenant" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attendance-photos'
    and name ~* '\.(jpe?g|png|webp)$'
    and exists (
      select 1 from public.photo_info(name) i
      where i.tenant_id = (select public.current_tenant_id())
        and i.owner_id  = (select auth.uid())
        and name like (i.tenant_id::text || '/%')   -- hanya format baru yang boleh ditulis
    )
  );

-- BACA: usaha sama, dan (foto profil | milik sendiri | punya menu Monitor Absensi)
create policy "photo_select_tenant" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attendance-photos'
    and exists (
      select 1 from public.photo_info(name) i
      where i.tenant_id = (select public.current_tenant_id())
        and (
          i.kind = 'profile'
          or i.owner_id = (select auth.uid())
          or public.has_menu_access('absensi-monitor')
        )
    )
  );
-- Sengaja TIDAK ada policy update/delete: foto tidak bisa diganti/dihapus dari aplikasi.

-- ---------------------------------------------------------------------
-- 2. AUDIT LOG
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null default public.current_tenant_id(),
  at          timestamptz not null default now(),
  actor_id    uuid,            -- tanpa FK: log tetap utuh walau akunnya dihapus
  actor_name  text,
  actor_role  text,
  action      text not null,   -- insert | update | delete | account.create | account.reset_pin | ...
  table_name  text,
  record_id   text,
  summary     text,
  old_data    jsonb,
  new_data    jsonb
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'audit_log_tenant_fk') then
    alter table public.audit_log
      add constraint audit_log_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_audit_log_tenant_at    on public.audit_log (tenant_id, at desc);
create index if not exists idx_audit_log_tenant_table on public.audit_log (tenant_id, table_name, at desc);
create index if not exists idx_audit_log_tenant_actor on public.audit_log (tenant_id, actor_id, at desc);

alter table public.audit_log enable row level security;

drop policy if exists tenant_isolation on public.audit_log;
create policy tenant_isolation on public.audit_log as restrictive for select
  using (tenant_id = (select public.current_tenant_id()));

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using ( public.is_super() or public.has_menu_access('audit-log') );
-- Tanpa policy insert/update/delete + hak tabel dicabut: aplikasi tidak bisa menulis/mengubah log.

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Pagar kedua: kalau suatu hari ada yang memberi hak tulis, UPDATE/DELETE
-- dari sesi aplikasi tetap ditolak (SQL Editor / service role: auth.uid() null).
create or replace function public.tg_audit_log_immutable()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    raise exception 'Audit log tidak boleh diubah atau dihapus';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists aa_audit_log_immutable on public.audit_log;
create trigger aa_audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.tg_audit_log_immutable();

-- Pencatat otomatis. Hanya mencatat aksi oleh USER LOGIN (auth.uid() terisi).
-- Aksi "sistem" (seed usaha baru, migrasi di SQL Editor, service role) tidak
-- dicatat supaya log tidak penuh derau; Edge Function mencatat sendiri lewat
-- audit_write(). Untuk UPDATE hanya kolom yang berubah yang disimpan.
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_old    jsonb;
  v_new    jsonb;
  v_o      jsonb := '{}'::jsonb;
  v_n      jsonb := '{}'::jsonb;
  v_tenant uuid;
  v_name   text;
  v_role   text;
  v_rec    text;
  k        text;
  v_noise  constant text[] := array['updated_at', 'created_at'];
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;

  begin
    if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
    if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

    v_tenant := nullif(coalesce(v_new->>'tenant_id', v_old->>'tenant_id',
                  case when tg_table_name = 'tenants' then coalesce(v_new->>'id', v_old->>'id') end), '')::uuid;
    if v_tenant is null then return coalesce(new, old); end if;

    v_rec := coalesce(v_new->>'id', v_old->>'id', v_new->>'user_id', v_old->>'user_id');

    if tg_op = 'UPDATE' then
      for k in select jsonb_object_keys(v_new) loop
        if k = any (v_noise) then continue; end if;
        if (v_old->k) is distinct from (v_new->k) then
          v_o := v_o || jsonb_build_object(k, v_old->k);
          v_n := v_n || jsonb_build_object(k, v_new->k);
        end if;
      end loop;
      if v_n = '{}'::jsonb then return new; end if;  -- tidak ada perubahan berarti
    elsif tg_op = 'INSERT' then
      v_n := v_new - v_noise;
      v_o := null;
    else
      v_o := v_old - v_noise;
      v_n := null;
    end if;

    select p.full_name, p.role into v_name, v_role from public.profiles p where p.id = v_actor;

    insert into public.audit_log (tenant_id, actor_id, actor_name, actor_role, action, table_name, record_id, old_data, new_data)
    values (v_tenant, v_actor, v_name, v_role, lower(tg_op), tg_table_name, v_rec, v_o, v_n);
  exception when others then
    -- Gagal mencatat tidak boleh menggagalkan pekerjaan user.
    raise warning 'audit gagal untuk %.%: %', tg_table_schema, tg_table_name, sqlerrm;
  end;

  return coalesce(new, old);
end;
$$;

-- Pasang trigger. (tabel yang belum ada di project ini dilewati)
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('profiles',                       'insert or update or delete'),
      ('role_permissions',               'insert or update or delete'),
      ('tenants',                        'update'),
      ('wage_history',                   'insert or update or delete'),
      ('salary_history',                 'insert or update or delete'),
      ('payroll_periods',                'insert or update or delete'),
      ('payroll_slips',                  'insert or update or delete'),
      ('payroll_settings',               'insert or update or delete'),
      ('payroll_adjustments',            'insert or update or delete'),
      ('employee_allowances',            'insert or update or delete'),
      ('allowance_types',                'insert or update or delete'),
      ('late_penalty_rules',             'insert or update or delete'),
      ('job_levels',                     'insert or update or delete'),
      ('departments',                    'insert or update or delete'),
      ('work_schedules',                 'insert or update or delete'),
      ('work_schedule_days',             'insert or update or delete'),
      ('employee_schedule_history',      'insert or update or delete'),
      ('holidays',                       'insert or update or delete'),
      ('office_locations',               'insert or update or delete'),
      ('org_units',                      'insert or update or delete'),
      ('org_unit_members',               'insert or update or delete'),
      ('approval_settings',              'insert or update or delete'),
      ('special_leave_rules',            'insert or update or delete'),
      ('leave_balances',                 'insert or update or delete'),
      ('master_pt',                      'insert or update or delete'),
      ('outsourcing_invoices',           'insert or update or delete'),
      ('outsourcing_area_invoices',      'insert or update or delete'),
      ('leave_requests',                 'insert or update or delete'),
      ('overtime_requests',              'insert or update or delete'),
      ('attendance_correction_requests', 'insert or update or delete'),
      ('request_approvals',              'update'),
      ('profile_change_requests',        'insert or update or delete'),
      ('push_settings',                  'update'),
      ('attendance',                     'delete')   -- check-in/out harian sengaja tidak dicatat
    ) as x(tbl, ops)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('drop trigger if exists zz_audit on public.%I', r.tbl);
    execute format('create trigger zz_audit after %s on public.%I for each row execute function public.tg_audit()',
                   r.ops, r.tbl);
  end loop;
end $$;

-- Pencatat manual untuk Edge Function (service role). Tidak bisa dipanggil
-- dari aplikasi (anon/authenticated dicabut).
create or replace function public.audit_write(
  p_tenant  uuid,
  p_actor   uuid,
  p_action  text,
  p_table   text,
  p_record  text,
  p_summary text,
  p_data    jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_role text;
begin
  if p_tenant is null or p_action is null then return; end if;
  select full_name, role into v_name, v_role from public.profiles where id = p_actor and tenant_id = p_tenant;
  insert into public.audit_log (tenant_id, actor_id, actor_name, actor_role, action, table_name, record_id, summary, new_data)
  values (p_tenant, p_actor, v_name, v_role, p_action, p_table, p_record, left(p_summary, 500), p_data);
end;
$$;
revoke all on function public.audit_write(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.audit_write(uuid, uuid, text, text, text, text, jsonb) to service_role;

-- Catatan "siapa mengunduh data": dipanggil aplikasi setiap kali ada ekspor
-- besar (Ekspor & Backup, Export Absensi). Hanya untuk yang berhak membuka
-- menu terkait; pelaku selalu = user yang login (tidak bisa memalsukan).
create or replace function public.log_export(p_summary text, p_data jsonb default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); v_tenant uuid := public.current_tenant_id(); v_name text; v_role text;
begin
  if v_actor is null or v_tenant is null then return; end if;
  if not (public.is_super() or public.has_menu_access('ekspor-backup') or public.has_menu_access('absensi-monitor')) then
    raise exception 'Tidak berhak';
  end if;
  select full_name, role into v_name, v_role from public.profiles where id = v_actor;
  insert into public.audit_log (tenant_id, actor_id, actor_name, actor_role, action, summary, new_data)
  values (v_tenant, v_actor, v_name, v_role, 'export', left(coalesce(p_summary, 'Ekspor data'), 500), p_data);
end;
$$;
revoke all on function public.log_export(text, jsonb) from public, anon;
grant execute on function public.log_export(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3. PEMERIKSAAN AKHIR
-- ---------------------------------------------------------------------
do $$
declare v_trg integer;
begin
  select count(*) into v_trg from pg_trigger where tgname = 'zz_audit' and not tgisinternal;
  if to_regclass('public.audit_log') is null then raise exception 'audit_log gagal dibuat'; end if;
  raise notice 'OK — Tahap 3 (SQL) terpasang: audit_log + % trigger audit + aturan foto per usaha.', v_trg;
  raise notice 'LANGKAH BERIKUTNYA: deploy 2 Edge Function, upload file aplikasi, tes, BARU privatkan bucket (README-TAHAP-3.md).';
end $$;

commit;
