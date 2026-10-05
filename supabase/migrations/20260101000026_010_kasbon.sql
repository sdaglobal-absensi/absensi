-- =====================================================================
-- PRIORITAS TINGGI #3 — KASBON / PINJAMAN KARYAWAN
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-009. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. Karyawan mengajukan pinjaman: nominal, tenor (bulan), potong mulai
--      periode gaji berapa, dan keperluannya.
--   2. Atasan menyetujui lewat rantai approval unit (jumlah tingkat =
--      pengaturan approval 'izin' usaha itu). Tabel approval SENDIRI.
--   3. Saat disetujui, server membuat jadwal cicilan (loan_installments),
--      satu baris per periode gaji (YYYY-MM).
--   4. Slip gaji periode itu otomatis memotong cicilan yang terjadwal
--      (kolom "Potongan Kasbon"). Saat periode difinalisasi cicilan
--      ditandai LUNAS; saat periode dibuka kuncinya, kembali TERJADWAL.
--   5. Pinjaman otomatis berstatus 'lunas' kalau semua cicilan terbayar.
--
-- Paket: fitur baru 'kasbon' (butuh 'payroll') -> Bisnis, Enterprise, Internal.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.employee_loans (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id()
               references public.tenants(id) on delete restrict,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  amount       numeric not null check (amount >= 10000 and amount <= 1000000000 and amount = trunc(amount)),
  tenor        integer not null check (tenor between 1 and 24),
  start_period text not null check (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  purpose      text not null check (length(btrim(purpose)) > 0),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'cancelled', 'lunas', 'stopped')),
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  review_notes text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_loans_tenant_user on public.employee_loans (tenant_id, user_id, created_at desc);
create index if not exists idx_loans_status on public.employee_loans (tenant_id, status);

create table if not exists public.loan_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete restrict,
  loan_id        uuid not null references public.employee_loans(id) on delete cascade,
  step_order     integer not null,
  approver_ids   uuid[] not null,
  approver_names text,
  status         text not null default 'waiting' check (status in ('waiting', 'pending', 'approved', 'rejected')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  notes          text,
  unique (loan_id, step_order)
);
create index if not exists idx_loan_appr_loan on public.loan_approvals (loan_id);

create table if not exists public.loan_installments (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  loan_id   uuid not null references public.employee_loans(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  seq       integer not null,
  period    text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount    numeric not null check (amount >= 0),
  status    text not null default 'scheduled' check (status in ('scheduled', 'paid', 'cancelled')),
  paid_at   timestamptz,
  unique (loan_id, seq)
);
create index if not exists idx_loan_inst_period on public.loan_installments (tenant_id, period, user_id);

drop trigger if exists aa_tenant_immutable on public.employee_loans;
create trigger aa_tenant_immutable before update on public.employee_loans
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. GERBANG PAKET (fitur 'kasbon', butuh 'payroll')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('kasbon', 'Kasbon / Pinjaman Karyawan',
   'Pengajuan pinjaman dengan cicilan yang otomatis dipotong di slip gaji', '{payroll}', 55)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('kasbon', 'kasbon'), ('kasbon-approval', 'kasbon')
on conflict (menu_id) do nothing;

-- Tambahkan ke paket Bisnis, Enterprise, Internal (tidak menimpa edit manual lain).
update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['kasbon']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('kasbon' = any(features));

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.employee_loans enable row level security;
alter table public.loan_approvals enable row level security;
alter table public.loan_installments enable row level security;

drop policy if exists tenant_isolation on public.employee_loans;
create policy tenant_isolation on public.employee_loans as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.loan_approvals;
create policy tenant_isolation on public.loan_approvals as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.loan_installments;
create policy tenant_isolation on public.loan_installments as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.employee_loans;
create policy feature_gate on public.employee_loans as restrictive for all to authenticated
  using ((select public.tenant_has_feature('kasbon')))
  with check ((select public.tenant_has_feature('kasbon')));
drop policy if exists feature_gate on public.loan_approvals;
create policy feature_gate on public.loan_approvals as restrictive for all to authenticated
  using ((select public.tenant_has_feature('kasbon')))
  with check ((select public.tenant_has_feature('kasbon')));
drop policy if exists feature_gate on public.loan_installments;
create policy feature_gate on public.loan_installments as restrictive for all to authenticated
  using ((select public.tenant_has_feature('kasbon')))
  with check ((select public.tenant_has_feature('kasbon')));

create or replace function public.loan_is_approver(p_loan uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.loan_approvals a
                  where a.loan_id = p_loan and auth.uid() = any (a.approver_ids));
$$;
create or replace function public.loan_is_owner(p_loan uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.employee_loans l
                  where l.id = p_loan and l.user_id = auth.uid());
$$;
grant execute on function public.loan_is_approver(uuid) to authenticated;
grant execute on function public.loan_is_owner(uuid) to authenticated;

-- Karyawan hanya membuat pengajuan untuk dirinya (status selalu 'pending').
-- Semua perubahan status lewat fungsi security definer di bawah.
drop policy if exists loans_select on public.employee_loans;
create policy loans_select on public.employee_loans for select
  using (
    user_id = auth.uid()
    or public.is_super()
    or public.has_menu_access('kasbon-approval')
    or public.loan_is_approver(id)
  );
drop policy if exists loans_insert on public.employee_loans;
create policy loans_insert on public.employee_loans for insert
  with check (user_id = auth.uid() and status = 'pending' and public.has_menu_access('kasbon'));

drop policy if exists loan_appr_select on public.loan_approvals;
create policy loan_appr_select on public.loan_approvals for select
  using (
    auth.uid() = any (approver_ids)
    or public.is_super()
    or public.has_menu_access('kasbon-approval')
    or public.loan_is_owner(loan_id)
  );

-- Cicilan: pemilik, pengelola kasbon, dan pengelola slip gaji (supaya
-- slip bisa memotongnya). Tanpa policy tulis -> hanya fungsi server.
drop policy if exists loan_inst_select on public.loan_installments;
create policy loan_inst_select on public.loan_installments for select
  using (
    user_id = auth.uid()
    or public.is_super()
    or public.has_menu_access('kasbon-approval')
    or public.has_menu_access('slip-gaji')
  );

-- ---------------------------------------------------------------------
-- 4. VALIDASI PENGAJUAN + PEMBENTUK TAHAP APPROVAL
-- ---------------------------------------------------------------------
create or replace function public.tg_loan_validate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Satu karyawan hanya boleh punya satu kasbon berjalan / menunggu.
  if exists (select 1 from public.employee_loans
              where user_id = new.user_id and tenant_id = new.tenant_id
                and status in ('pending', 'approved')) then
    raise exception 'Masih ada kasbon yang berjalan atau menunggu persetujuan';
  end if;
  return new;
end;
$$;
drop trigger if exists ab_loan_validate on public.employee_loans;
create trigger ab_loan_validate before insert on public.employee_loans
  for each row execute function public.tg_loan_validate();

create or replace function public.tg_loan_build_steps()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_levels integer;
  v_name   text;
  v_role   text;
  v_count  integer := 0;
  v_has_notify boolean := to_regprocedure('public.notify_users(uuid[],text,text,text,text,uuid)') is not null;
  r record;
begin
  select full_name, role into v_name, v_role from public.profiles where id = new.user_id;
  select coalesce((select levels from public.approval_settings
                    where tenant_id = new.tenant_id and request_type = 'izin'), 1) into v_levels;

  for r in select * from public.resolve_approval_chain(new.user_id, v_levels, 'kasbon-approval') loop
    insert into public.loan_approvals (tenant_id, loan_id, step_order, approver_ids, approver_names, status)
    values (new.tenant_id, new.id, r.r_step, r.r_ids, r.r_names, case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;

    if r.r_step = 1 and v_has_notify then
      perform public.notify_users(
        r.r_ids, 'loan_needed', 'Pengajuan kasbon menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' mengajukan kasbon Rp ' || to_char(new.amount, 'FM999G999G999G999') || '.',
        'loan', new.id);
    end if;
  end loop;

  -- Tanpa approver: hanya Super Admin yang disetujui otomatis.
  if v_count = 0 and v_role = 'super_admin' then
    perform public.loan_finalize_approval(new.id, null, 'Disetujui otomatis (tidak ada approver di atasnya)');
  end if;
  return new;
end;
$$;
drop trigger if exists zz_loan_build_steps on public.employee_loans;
create trigger zz_loan_build_steps after insert on public.employee_loans
  for each row execute function public.tg_loan_build_steps();

-- ---------------------------------------------------------------------
-- 5. NOTIFIKASI: perluas CHECK tabel notifications
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
                  'field_work_needed', 'field_work_decided', 'loan_needed', 'loan_decided'));
alter table public.notifications add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement', 'field_work', 'loan'));

-- ---------------------------------------------------------------------
-- 6. PERSETUJUAN FINAL: membuat jadwal cicilan
-- ---------------------------------------------------------------------
create or replace function public.loan_finalize_approval(p_loan uuid, p_by uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_loan  public.employee_loans%rowtype;
  v_start text;
  v_base  numeric;
  i integer;
begin
  select * into v_loan from public.employee_loans where id = p_loan for update;
  v_start := v_loan.start_period;
  -- Periode awal sudah difinalisasi? Geser ke periode berikutnya yang masih terbuka.
  while exists (select 1 from public.payroll_periods where tenant_id = v_loan.tenant_id and period = v_start) loop
    v_start := to_char((v_start || '-01')::date + interval '1 month', 'YYYY-MM');
  end loop;

  v_base := floor(v_loan.amount / v_loan.tenor);
  for i in 1 .. v_loan.tenor loop
    insert into public.loan_installments (tenant_id, loan_id, user_id, seq, period, amount)
    values (v_loan.tenant_id, v_loan.id, v_loan.user_id, i,
            to_char((v_start || '-01')::date + ((i - 1) || ' month')::interval, 'YYYY-MM'),
            case when i = v_loan.tenor then v_loan.amount - v_base * (v_loan.tenor - 1) else v_base end)
    on conflict (loan_id, seq) do nothing;
  end loop;

  update public.employee_loans
     set status = 'approved', start_period = v_start, reviewed_by = p_by, reviewed_at = now(),
         review_notes = p_notes, updated_at = now()
   where id = p_loan;
  update public.loan_approvals set status = 'approved'
   where loan_id = p_loan and status in ('waiting', 'pending');
end;
$$;
revoke execute on function public.loan_finalize_approval(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. KEPUTUSAN (satu-satunya jalan menyetujui / menolak)
-- ---------------------------------------------------------------------
create or replace function public.decide_loan(p_loan uuid, p_decision text, p_notes text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_req  public.employee_loans%rowtype;
  v_step public.loan_approvals%rowtype;
  v_next integer;
  v_has_notify boolean := to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  select * into v_req from public.employee_loans where id = p_loan for update;
  if not found or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_req.status <> 'pending' then raise exception 'Pengajuan ini sudah diproses'; end if;
  if v_req.user_id = auth.uid() then raise exception 'Tidak boleh memutuskan pengajuan sendiri'; end if;

  select * into v_step from public.loan_approvals
   where loan_id = p_loan and status = 'pending' order by step_order limit 1 for update;

  if not public.is_super() and (v_step.id is null or not (auth.uid() = any (v_step.approver_ids))) then
    raise exception 'Bukan giliran Anda untuk memutuskan pengajuan ini';
  end if;

  if v_step.id is not null then
    update public.loan_approvals
       set status = p_decision, decided_by = auth.uid(), decided_at = now(), notes = p_notes
     where id = v_step.id;
  end if;

  if p_decision = 'rejected' then
    update public.employee_loans
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes, updated_at = now()
     where id = p_loan;
    update public.loan_approvals set status = 'rejected'
     where loan_id = p_loan and status in ('waiting', 'pending') and id is distinct from v_step.id;
  else
    select min(step_order) into v_next from public.loan_approvals
     where loan_id = p_loan and status = 'waiting';
    if v_next is not null and not public.is_super() then
      update public.loan_approvals set status = 'pending' where loan_id = p_loan and step_order = v_next;
      if v_has_notify then
        perform public.notify_users(
          (select approver_ids from public.loan_approvals where loan_id = p_loan and step_order = v_next),
          'loan_needed', 'Pengajuan kasbon menunggu persetujuanmu',
          (select full_name from public.profiles where id = v_req.user_id) || ' mengajukan kasbon Rp '
            || to_char(v_req.amount, 'FM999G999G999G999') || '.',
          'loan', p_loan);
      end if;
      return 'pending';
    end if;
    perform public.loan_finalize_approval(p_loan, auth.uid(), p_notes);
  end if;

  if v_has_notify then
    perform public.notify_user(
      v_req.user_id, 'loan_decided',
      case when p_decision = 'approved' then 'Kasbon disetujui' else 'Kasbon ditolak' end,
      case when p_notes is not null and btrim(p_notes) <> '' then p_notes else null end,
      'loan', p_loan);
  end if;
  return p_decision;
end;
$$;
revoke execute on function public.decide_loan(uuid, text, text) from public, anon;
grant execute on function public.decide_loan(uuid, text, text) to authenticated;

-- Pemohon membatalkan pengajuannya sendiri SELAMA masih menunggu.
create or replace function public.cancel_loan(p_loan uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_req public.employee_loans%rowtype;
begin
  select * into v_req from public.employee_loans where id = p_loan for update;
  if not found or v_req.user_id <> auth.uid() or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_req.status <> 'pending' then raise exception 'Hanya pengajuan yang masih menunggu yang bisa dibatalkan'; end if;
  update public.employee_loans set status = 'cancelled', reviewed_at = now(), updated_at = now() where id = p_loan;
  update public.loan_approvals set status = 'rejected' where loan_id = p_loan and status in ('waiting', 'pending');
end;
$$;
revoke execute on function public.cancel_loan(uuid) from public, anon;
grant execute on function public.cancel_loan(uuid) to authenticated;

-- HR / Super Admin menghentikan pinjaman berjalan (mis. dilunasi tunai, atau
-- karyawan keluar). Cicilan yang BELUM dipotong dibatalkan; yang sudah
-- dipotong tetap tercatat.
create or replace function public.stop_loan(p_loan uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_req public.employee_loans%rowtype;
begin
  if not (public.is_super() or public.my_role() in ('super_admin_hr', 'admin_hr')) then
    raise exception 'Hanya Super Admin / Admin HR yang boleh menghentikan kasbon';
  end if;
  select * into v_req from public.employee_loans where id = p_loan for update;
  if not found or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Pengajuan tidak ditemukan';
  end if;
  if v_req.status <> 'approved' then raise exception 'Hanya kasbon yang sedang berjalan yang bisa dihentikan'; end if;
  update public.loan_installments set status = 'cancelled' where loan_id = p_loan and status = 'scheduled';
  update public.employee_loans
     set status = 'stopped', review_notes = coalesce(nullif(btrim(p_notes), ''), review_notes), updated_at = now()
   where id = p_loan;
end;
$$;
revoke execute on function public.stop_loan(uuid, text) from public, anon;
grant execute on function public.stop_loan(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. SINKRON DENGAN SLIP GAJI
--    Slip karyawan dibekukan (insert payroll_slips)  -> cicilan periode itu LUNAS
--    Periode dibuka kuncinya (slip dihapus)          -> cicilan kembali TERJADWAL
-- ---------------------------------------------------------------------
create or replace function public.loan_refresh_status(p_loan uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.employee_loans l set status = 'lunas', updated_at = now()
   where l.id = p_loan and l.status = 'approved'
     and not exists (select 1 from public.loan_installments i where i.loan_id = l.id and i.status = 'scheduled');
  update public.employee_loans l set status = 'approved', updated_at = now()
   where l.id = p_loan and l.status = 'lunas'
     and exists (select 1 from public.loan_installments i where i.loan_id = l.id and i.status = 'scheduled');
end;
$$;
revoke execute on function public.loan_refresh_status(uuid) from public, anon, authenticated;

create or replace function public.tg_slip_loan_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    update public.loan_installments
       set status = 'paid', paid_at = now()
     where tenant_id = new.tenant_id and user_id = new.user_id and period = new.period and status = 'scheduled'
    returning loan_id
  loop
    perform public.loan_refresh_status(r.loan_id);
  end loop;
  return new;
end;
$$;
drop trigger if exists zz_slip_loan_paid on public.payroll_slips;
create trigger zz_slip_loan_paid after insert on public.payroll_slips
  for each row execute function public.tg_slip_loan_paid();

create or replace function public.tg_slip_loan_unpaid()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    update public.loan_installments
       set status = 'scheduled', paid_at = null
     where tenant_id = old.tenant_id and user_id = old.user_id and period = old.period and status = 'paid'
    returning loan_id
  loop
    perform public.loan_refresh_status(r.loan_id);
  end loop;
  return old;
end;
$$;
drop trigger if exists zz_slip_loan_unpaid on public.payroll_slips;
create trigger zz_slip_loan_unpaid after delete on public.payroll_slips
  for each row execute function public.tg_slip_loan_unpaid();

-- ---------------------------------------------------------------------
-- 9. HAK MENU
--    kasbon          : semua role (pengajuan pribadi)
--    kasbon-approval : Admin HR, Super Admin HR, Admin approval
--                      (karyawan mati; Super Admin selalu lolos)
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'kasbon', true), ('admin_hr', 'kasbon', true),
  ('admin_approval', 'kasbon', true), ('karyawan', 'kasbon', true),
  ('super_admin_hr', 'kasbon-approval', true), ('admin_hr', 'kasbon-approval', true),
  ('admin_approval', 'kasbon-approval', true), ('karyawan', 'kasbon-approval', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('kasbon', 'kasbon-approval')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): menu pribadi karyawan (versi 009 + 'kasbon').
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon'];
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
-- ROLLBACK (manual):
--   drop trigger if exists zz_slip_loan_paid on public.payroll_slips;
--   drop trigger if exists zz_slip_loan_unpaid on public.payroll_slips;
--   drop table if exists public.loan_installments, public.loan_approvals, public.employee_loans cascade;
--   delete from public.role_permissions where menu_id in ('kasbon','kasbon-approval');
--   delete from public.role_permission_defaults where menu_id in ('kasbon','kasbon-approval');
--   delete from public.menu_features where menu_id in ('kasbon','kasbon-approval');
--   update public.plans set features = array_remove(features, 'kasbon');
--   delete from public.feature_catalog where kode = 'kasbon';
-- =====================================================================
