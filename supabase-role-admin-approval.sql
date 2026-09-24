-- =====================================================================
-- MIGRASI: ROLE BARU "Admin" (nilai di database: admin_approval)
--
-- Untuk database yang SUDAH berjalan. Aman dijalankan berulang (idempotent).
-- Jalankan sekali di Supabase > SQL Editor. Instalasi baru tidak perlu file
-- ini: perubahannya sudah termasuk di supabase-schema.sql dan
-- supabase-org-approval.sql.
--
-- Yang berubah:
--   1. Role 'admin_approval' diizinkan di profiles & role_permissions.
--   2. Toggle menu default untuk role itu (pribadi + Approval Izin/Lembur).
--   3. Admin HR / Super Admin HR boleh menetapkan role ini di Data Karyawan.
--   4. Role Admin ikut dihitung sebagai approver di rantai unit
--      (resolve_approval_chain). Fallback "tanpa unit" TIDAK berubah.
--   5. Approver boleh membaca profil pemohon yang ada di rantainya saja.
--
-- Pengajuan yang SUDAH dibuat tidak berubah (approver-nya sudah tercatat).
-- =====================================================================

-- 1. Constraint role -----------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('super_admin','super_admin_hr','admin_hr','admin_approval','karyawan'));

alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check
  check (role in ('super_admin_hr', 'admin_hr', 'admin_approval', 'karyawan'));

-- 2. Toggle menu default -------------------------------------------------
-- Default role Admin (admin_approval): menu pribadi + Approval Izin
-- & Approval Lembur menyala; semua menu staff lain mati -- Super Admin bisa
-- menyalakan satu-satu lewat Pengaturan Sistem (mis. Approval Perubahan Data).
-- Role ini SENGAJA tidak masuk is_staff(): akses datanya murni lewat toggle
-- ini, jadi tidak otomatis bisa membaca data gaji/karyawan orang lain.
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_approval', 'profil', true),
  ('admin_approval', 'absensi', true),
  ('admin_approval', 'izin', true),
  ('admin_approval', 'lembur', true),
  ('admin_approval', 'riwayat', true),
  ('admin_approval', 'slip-gaji-saya', true),
  ('admin_approval', 'izin-approval', true),
  ('admin_approval', 'lembur-approval', true),
  ('admin_approval', 'profil-approval', false),
  ('admin_approval', 'karyawan', false),
  ('admin_approval', 'struktur-organisasi', false),
  ('admin_approval', 'struktur-kelola', false),
  ('admin_approval', 'absensi-monitor', false),
  ('admin_approval', 'kenaikan-upah', false),
  ('admin_approval', 'slip-gaji', false),
  ('admin_approval', 'laporan', false),
  ('admin_approval', 'master-level', false),
  ('admin_approval', 'master-tunjangan', false),
  ('admin_approval', 'master-denda', false),
  ('admin_approval', 'master-departemen', false),
  ('admin_approval', 'master-jadwal', false),
  ('admin_approval', 'master-libur', false),
  ('admin_approval', 'master-lokasi', false),
  ('admin_approval', 'pengaturan-sistem', false)
on conflict (role, menu_id) do nothing;

-- 3. Siapa boleh menetapkan role ------------------------------------------
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all
  -- USING: baris mana yg boleh disentuh (dibaca utk update/delete). Semua
  -- baris boleh disentuh oleh siapa pun yg punya akses menu "Data
  -- Karyawan", TERMASUK baris ber-role Super Admin -- supaya Admin HR/
  -- Super Admin HR tetap bisa mengedit field LAIN (nama, no HP, dst) punya
  -- akun Super Admin. Pembatasan supaya role-nya sendiri tidak ikut
  -- berubah ada di WITH CHECK di bawah, bukan di sini.
  using ( public.is_super() or public.has_menu_access('karyawan') )
  with check (
    -- WITH CHECK: nilai role BARU yang boleh disimpan.
    -- - super_admin: bebas (root, all akses).
    -- - super_admin_hr/admin_hr (staff) dgn menu "Data Karyawan": boleh
    --   menyimpan role 'karyawan', 'admin_hr', 'admin_approval', atau 'super_admin_hr' --
    --   TAPI TIDAK PERNAH boleh menaikkan siapa pun (termasuk dirinya) ke
    --   'super_admin'. is_super() di sini SENGAJA tetap hardcoded ke role
    --   super_admin saja supaya kemampuan membuat akun Super Admin baru
    --   selalu ada di satu role yang jelas & tidak pernah bisa mati lewat
    --   toggle menu "Data Karyawan".
    -- - PENGECUALIAN: kalau baris yg diedit SEBELUMNYA sudah 'super_admin'
    --   (role_of(id) = 'super_admin') dan field role yg disimpan TETAP
    --   'super_admin' (tidak diubah), izinkan juga -- ini yang membuat
    --   Admin HR/Super Admin HR bisa menyimpan perubahan field lain punya
    --   akun Super Admin tanpa bisa menurunkan/menaikkan role siapa pun
    --   ke/dari Super Admin.
    -- - karyawan biasa yg kebetulan diberi akses menu ini: tetap cuma
    --   boleh role 'karyawan'.
    public.is_super()
    or (
      public.has_menu_access('karyawan')
      and (
        ( public.my_role() in ('super_admin_hr','admin_hr') and role in ('karyawan','admin_hr','admin_approval','super_admin_hr') )
        or ( role = 'karyawan' )
        or ( role = 'super_admin' and public.role_of(id) = 'super_admin' )
      )
    )
  );

-- 4. Approver di rantai unit ----------------------------------------------
create or replace function public.resolve_approval_chain(p_user uuid, p_levels integer, p_menu text)
returns table (r_step integer, r_unit uuid, r_ids uuid[], r_names text)
language plpgsql security definer stable set search_path = public as $$
declare
  v_unit uuid;
  v_step integer := 0;
  v_used uuid[] := array[p_user];
  v_ids  uuid[];
  v_names text;
begin
  select m.unit_id into v_unit
  from public.org_unit_members m
  join public.org_units u on u.id = m.unit_id
  where m.user_id = p_user and m.is_primary and u.is_active
  limit 1;

  while v_unit is not null and v_step < p_levels loop
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.org_unit_members m
    join public.profiles p on p.id = m.user_id
    where m.unit_id = v_unit
      and p.is_active
      and p.id <> all (v_used)
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr', 'admin_approval')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );

    if v_ids is not null then
      v_step := v_step + 1;
      v_used := v_used || v_ids;
      r_step := v_step; r_unit := v_unit; r_ids := v_ids; r_names := v_names;
      return next;
    end if;

    select parent_id into v_unit from public.org_units where id = v_unit;
  end loop;

  -- Fallback: tidak ada approver sama sekali di rantai (atau belum punya unit
  -- utama) -> Super Admin + staff yang berhak approve (perilaku sebelum ada struktur).
  if v_step = 0 then
    select array_agg(p.id order by p.full_name), string_agg(p.full_name, ', ' order by p.full_name)
      into v_ids, v_names
    from public.profiles p
    where p.is_active
      and p.id <> p_user
      and (
        p.role = 'super_admin'
        or (
          p.role in ('super_admin_hr', 'admin_hr')
          and exists (
            select 1 from public.role_permissions rp
            where rp.role = p.role and rp.menu_id = p_menu and rp.enabled
          )
        )
      );
    if v_ids is not null then
      r_step := 1; r_unit := null; r_ids := v_ids; r_names := v_names;
      return next;
    end if;
  end if;

  return;
end;
$$;

revoke execute on function public.resolve_approval_chain(uuid, integer, text) from public, anon, authenticated;

-- 5. Baca profil pemohon ---------------------------------------------------
-- ---------------------------------------------------------------------
-- 11b. Approver boleh MEMBACA profil pemohon yang pengajuannya menunggu /
--      pernah melewati dirinya (untuk menampilkan nama & departemen di
--      halaman Approval). Terbatas ke pemohon di rantainya saja -- Admin
--      Approval tidak dianggap staff (is_staff), jadi tanpa ini nama
--      pemohon tidak terbaca.
-- ---------------------------------------------------------------------
create or replace function public.is_approver_of_user(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.request_approvals a
    where a.approver_ids @> array[auth.uid()]
      and (
        (a.request_type = 'leave' and exists (
          select 1 from public.leave_requests r where r.id = a.request_id and r.user_id = p_user))
        or (a.request_type = 'overtime' and exists (
          select 1 from public.overtime_requests r where r.id = a.request_id and r.user_id = p_user))
      )
  );
$$;

drop policy if exists "profiles_select_approver" on public.profiles;
create policy "profiles_select_approver" on public.profiles
  for select using ( public.is_approver_of_user(id) );
