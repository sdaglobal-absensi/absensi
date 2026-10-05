-- =====================================================================
-- MIGRASI: ROLE BARU "Admin" (nilai di database: admin_approval)
--          + ubah role dari Struktur Organisasi (bukan lagi Data Karyawan)
--
-- Untuk database yang SUDAH berjalan. Aman dijalankan berulang (idempotent).
-- Jalankan sekali di Supabase > SQL Editor. Instalasi baru tidak perlu file
-- ini: perubahannya sudah termasuk di supabase-schema.sql dan
-- supabase-org-approval.sql.
--
-- Yang berubah:
--   1. Role 'admin_approval' diizinkan di profiles & role_permissions.
--   2. Toggle menu default untuk role itu (pribadi + Approval Izin/Lembur).
--   3. ROLE TIDAK BISA lagi diubah lewat tabel profiles (Data Karyawan) kecuali
--      oleh Super Admin. Akun baru selalu 'karyawan'.
--   4. Role Admin ikut dihitung sebagai approver di rantai unit
--      (resolve_approval_chain). Fallback "tanpa unit" TIDAK berubah.
--   5. Approver boleh membaca profil pemohon yang ada di rantainya saja.
--   6. Fungsi set_member_role: Ubah Role di Struktur Organisasi.
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

-- 3. Role tidak bisa diubah lewat Data Karyawan ---------------------------
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all
  -- USING: baris mana yg boleh disentuh. Semua baris boleh disentuh oleh siapa
  -- pun yg punya akses menu "Data Karyawan" (untuk edit field selain role).
  using ( public.is_super() or public.has_menu_access('karyawan') )
  with check (
    -- WITH CHECK: ROLE tidak bisa diubah lewat Data Karyawan. Akun baru selalu
    -- 'karyawan' (trigger handle_new_user), dan role diubah lewat fungsi
    -- set_member_role (halaman Struktur Organisasi -> Ubah Role) supaya yang
    -- hanya punya akses Data Karyawan tidak salah memberi role.
    -- - super_admin (is_super): bebas.
    -- - lainnya dgn menu "Data Karyawan": role harus TETAP sama dengan role
    --   sebelumnya (role_of(id)), atau baris baru (role_of null) dgn 'karyawan'.
    public.is_super()
    or (
      public.has_menu_access('karyawan')
      and (
        role = public.role_of(id)
        or ( public.role_of(id) is null and role = 'karyawan' )
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

-- 6. Ubah role dari Struktur Organisasi -------------------------------------
-- ---------------------------------------------------------------------
-- 9b. FUNGSI: set_member_role — ubah role dari halaman Struktur Organisasi
--     (Data Karyawan TIDAK lagi mengatur role: akun baru selalu 'karyawan').
--     Harus punya hak 'struktur-kelola'. Kewenangan:
--       Super Admin              : semua role.
--       Super Admin HR / Admin HR: karyawan, admin_approval (label UI: Admin),
--                                  admin_hr, super_admin_hr -- TIDAK boleh
--                                  menyentuh/menetapkan super_admin.
--       lainnya (mis. Karyawan/Admin yang diberi hak kelola): hanya
--                                  karyawan <-> admin_approval.
--     Tidak boleh mengubah role diri sendiri.
-- ---------------------------------------------------------------------
create or replace function public.set_member_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller text := public.my_role();
  v_old    text;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not public.has_menu_access('struktur-kelola') then
    raise exception 'Tidak punya akses mengelola struktur organisasi';
  end if;
  if p_role not in ('karyawan', 'admin_approval', 'admin_hr', 'super_admin_hr', 'super_admin') then
    raise exception 'Role tidak valid';
  end if;
  if p_user = auth.uid() then
    raise exception 'Tidak bisa mengubah role diri sendiri';
  end if;

  select role into v_old from public.profiles where id = p_user;
  if v_old is null then raise exception 'Karyawan tidak ditemukan'; end if;
  if v_old = p_role then return; end if;

  if v_caller = 'super_admin' then
    null; -- bebas
  elsif v_caller in ('super_admin_hr', 'admin_hr') then
    if p_role = 'super_admin' or v_old = 'super_admin' then
      raise exception 'Role Super Admin hanya bisa diatur oleh Super Admin';
    end if;
  else
    if p_role not in ('karyawan', 'admin_approval') or v_old not in ('karyawan', 'admin_approval') then
      raise exception 'Role ini hanya bisa diatur oleh Admin HR ke atas';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user;
end;
$$;

revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;
