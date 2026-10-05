-- =====================================================================
-- PRIORITAS TINGGI #4 — REIMBURSEMENT / KLAIM BIAYA
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-010. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. Karyawan mengajukan klaim: jenis biaya, tanggal, nominal, keterangan
--      dan FOTO NOTA (bucket privat baru 'expense-receipts').
--   2. Atasan menyetujui lewat rantai approval unit (jumlah tingkat =
--      pengaturan approval 'izin'). Tabel approval SENDIRI.
--   3. Saat disetujui, server menetapkan periode gaji pembayarannya
--      (bulan berjalan, atau periode terbuka berikutnya kalau sudah final).
--   4. Slip gaji periode itu menambahkan "Reimbursement" ke take home pay
--      (tidak ikut dasar PPh21). Saat periode difinalisasi klaim berstatus
--      'paid'; saat kunci dibuka kembali 'approved'.
--
-- Paket: fitur baru 'reimburse' (butuh 'payroll') -> Bisnis, Enterprise, Internal.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.expense_claims (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id()
               references public.tenants(id) on delete restrict,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  category     text not null check (category in ('transport', 'makan', 'akomodasi', 'bbm_parkir', 'perlengkapan', 'komunikasi', 'lainnya')),
  expense_date date not null,
  amount       numeric not null check (amount >= 1000 and amount <= 100000000 and amount = trunc(amount)),
  description  text not null check (length(btrim(description)) > 0),
  receipt_path text not null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'paid')),
  pay_period   text check (pay_period is null or pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  paid_at      timestamptz,
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  review_notes text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_expense_tenant_user on public.expense_claims (tenant_id, user_id, created_at desc);
create index if not exists idx_expense_status on public.expense_claims (tenant_id, status);
create index if not exists idx_expense_period on public.expense_claims (tenant_id, pay_period, user_id);

create table if not exists public.expense_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete restrict,
  claim_id       uuid not null references public.expense_claims(id) on delete cascade,
  step_order     integer not null,
  approver_ids   uuid[] not null,
  approver_names text,
  status         text not null default 'waiting' check (status in ('waiting', 'pending', 'approved', 'rejected')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  notes          text,
  unique (claim_id, step_order)
);
create index if not exists idx_expense_appr_claim on public.expense_approvals (claim_id);

drop trigger if exists aa_tenant_immutable on public.expense_claims;
create trigger aa_tenant_immutable before update on public.expense_claims
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. STORAGE: bucket privat foto nota
--    Path: <tenant_id>/<user_id>/<nama-file>.jpg|png|webp
-- ---------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('expense-receipts', 'expense-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false, file_size_limit = 5242880,
        allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
exception when others then
  raise notice 'Bucket expense-receipts tidak bisa dibuat lewat SQL (%). Buat manual di Dashboard > Storage: nama expense-receipts, PRIVATE, batas 5 MB, jenis image/jpeg,png,webp.', sqlerrm;
end $$;

drop policy if exists "receipt_insert_own" on storage.objects;
create policy "receipt_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'expense-receipts'
    and name ~* '\.(jpe?g|png|webp)$'
    and (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists "receipt_select_tenant" on storage.objects;
create policy "receipt_select_tenant" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'expense-receipts'
    and (storage.foldername(name))[1] = (select public.current_tenant_id())::text
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or public.is_super()
      or public.has_menu_access('reimburse-approval')
      or public.has_menu_access('slip-gaji')
    )
  );
-- Sengaja tanpa policy update/delete: nota tidak bisa diganti / dihapus dari aplikasi.

-- ---------------------------------------------------------------------
-- 3. GERBANG PAKET (fitur 'reimburse', butuh 'payroll')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('reimburse', 'Reimbursement / Klaim Biaya',
   'Klaim biaya dengan foto nota, disetujui atasan, lalu masuk sebagai tambahan di slip gaji', '{payroll}', 56)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('reimburse', 'reimburse'), ('reimburse-approval', 'reimburse')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['reimburse']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('reimburse' = any(features));

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.expense_claims enable row level security;
alter table public.expense_approvals enable row level security;

drop policy if exists tenant_isolation on public.expense_claims;
create policy tenant_isolation on public.expense_claims as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.expense_approvals;
create policy tenant_isolation on public.expense_approvals as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.expense_claims;
create policy feature_gate on public.expense_claims as restrictive for all to authenticated
  using ((select public.tenant_has_feature('reimburse')))
  with check ((select public.tenant_has_feature('reimburse')));
drop policy if exists feature_gate on public.expense_approvals;
create policy feature_gate on public.expense_approvals as restrictive for all to authenticated
  using ((select public.tenant_has_feature('reimburse')))
  with check ((select public.tenant_has_feature('reimburse')));

create or replace function public.expense_is_approver(p_claim uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.expense_approvals a
                  where a.claim_id = p_claim and auth.uid() = any (a.approver_ids));
$$;
create or replace function public.expense_is_owner(p_claim uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.expense_claims c
                  where c.id = p_claim and c.user_id = auth.uid());
$$;
grant execute on function public.expense_is_approver(uuid) to authenticated;
grant execute on function public.expense_is_owner(uuid) to authenticated;

-- Klaim: pemilik, approver, pengelola klaim, dan pengelola slip gaji
-- (supaya slip bisa menambahkannya). Tulis hanya lewat fungsi server,
-- kecuali INSERT pengajuan milik sendiri.
drop policy if exists expense_select on public.expense_claims;
create policy expense_select on public.expense_claims for select
  using (
    user_id = auth.uid()
    or public.is_super()
    or public.has_menu_access('reimburse-approval')
    or public.has_menu_access('slip-gaji')
    or public.expense_is_approver(id)
  );
drop policy if exists expense_insert on public.expense_claims;
create policy expense_insert on public.expense_claims for insert
  with check (
    user_id = auth.uid() and status = 'pending' and pay_period is null
    and public.has_menu_access('reimburse')
    and receipt_path like (public.current_tenant_id()::text || '/' || auth.uid()::text || '/%')
  );

drop policy if exists expense_appr_select on public.expense_approvals;
create policy expense_appr_select on public.expense_approvals for select
  using (
    auth.uid() = any (approver_ids)
    or public.is_super()
    or public.has_menu_access('reimburse-approval')
    or public.expense_is_owner(claim_id)
  );

-- ---------------------------------------------------------------------
-- 5. VALIDASI + PEMBENTUK TAHAP APPROVAL
-- ---------------------------------------------------------------------
create or replace function public.tg_expense_validate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.expense_date > (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal biaya tidak boleh di masa depan';
  end if;
  if new.expense_date < (now() at time zone 'Asia/Jakarta')::date - 90 then
    raise exception 'Biaya lebih dari 90 hari lalu tidak bisa diklaim';
  end if;
  return new;
end;
$$;
drop trigger if exists ab_expense_validate on public.expense_claims;
create trigger ab_expense_validate before insert on public.expense_claims
  for each row execute function public.tg_expense_validate();

create or replace function public.tg_expense_build_steps()
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

  for r in select * from public.resolve_approval_chain(new.user_id, v_levels, 'reimburse-approval') loop
    insert into public.expense_approvals (tenant_id, claim_id, step_order, approver_ids, approver_names, status)
    values (new.tenant_id, new.id, r.r_step, r.r_ids, r.r_names, case when r.r_step = 1 then 'pending' else 'waiting' end);
    v_count := v_count + 1;

    if r.r_step = 1 and v_has_notify then
      perform public.notify_users(
        r.r_ids, 'expense_needed', 'Klaim biaya menunggu persetujuanmu',
        coalesce(v_name, 'Seseorang') || ' mengajukan klaim Rp ' || to_char(new.amount, 'FM999G999G999G999') || '.',
        'expense', new.id);
    end if;
  end loop;

  if v_count = 0 and v_role = 'super_admin' then
    perform public.expense_finalize_approval(new.id, null, 'Disetujui otomatis (tidak ada approver di atasnya)');
  end if;
  return new;
end;
$$;
drop trigger if exists zz_expense_build_steps on public.expense_claims;
create trigger zz_expense_build_steps after insert on public.expense_claims
  for each row execute function public.tg_expense_build_steps();

-- ---------------------------------------------------------------------
-- 6. NOTIFIKASI: perluas CHECK tabel notifications (termasuk 009 & 010)
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
                  'expense_needed', 'expense_decided'));
alter table public.notifications add constraint notifications_request_type_check
  check (request_type is null or request_type in ('leave', 'overtime', 'koreksi', 'announcement', 'field_work', 'loan', 'expense'));

-- ---------------------------------------------------------------------
-- 7. PERSETUJUAN FINAL: tetapkan periode gaji pembayaran
-- ---------------------------------------------------------------------
create or replace function public.expense_open_period(p_tenant uuid, p_from text)
returns text language plpgsql security definer stable set search_path = public as $$
declare v text := p_from;
begin
  while exists (select 1 from public.payroll_periods where tenant_id = p_tenant and period = v) loop
    v := to_char((v || '-01')::date + interval '1 month', 'YYYY-MM');
  end loop;
  return v;
end;
$$;
revoke execute on function public.expense_open_period(uuid, text) from public, anon, authenticated;

create or replace function public.expense_finalize_approval(p_claim uuid, p_by uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare v_c public.expense_claims%rowtype;
begin
  select * into v_c from public.expense_claims where id = p_claim for update;
  update public.expense_claims
     set status = 'approved',
         pay_period = public.expense_open_period(v_c.tenant_id, to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM')),
         reviewed_by = p_by, reviewed_at = now(), review_notes = p_notes, updated_at = now()
   where id = p_claim;
  update public.expense_approvals set status = 'approved'
   where claim_id = p_claim and status in ('waiting', 'pending');
end;
$$;
revoke execute on function public.expense_finalize_approval(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. KEPUTUSAN
-- ---------------------------------------------------------------------
create or replace function public.decide_expense(p_claim uuid, p_decision text, p_notes text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_req  public.expense_claims%rowtype;
  v_step public.expense_approvals%rowtype;
  v_next integer;
  v_has_notify boolean := to_regprocedure('public.notify_user(uuid,text,text,text,text,uuid)') is not null;
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Keputusan tidak valid'; end if;

  select * into v_req from public.expense_claims where id = p_claim for update;
  if not found or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Klaim tidak ditemukan';
  end if;
  if v_req.status <> 'pending' then raise exception 'Klaim ini sudah diproses'; end if;
  if v_req.user_id = auth.uid() then raise exception 'Tidak boleh memutuskan klaim sendiri'; end if;

  select * into v_step from public.expense_approvals
   where claim_id = p_claim and status = 'pending' order by step_order limit 1 for update;

  if not public.is_super() and (v_step.id is null or not (auth.uid() = any (v_step.approver_ids))) then
    raise exception 'Bukan giliran Anda untuk memutuskan klaim ini';
  end if;

  if v_step.id is not null then
    update public.expense_approvals
       set status = p_decision, decided_by = auth.uid(), decided_at = now(), notes = p_notes
     where id = v_step.id;
  end if;

  if p_decision = 'rejected' then
    update public.expense_claims
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes, updated_at = now()
     where id = p_claim;
    update public.expense_approvals set status = 'rejected'
     where claim_id = p_claim and status in ('waiting', 'pending') and id is distinct from v_step.id;
  else
    select min(step_order) into v_next from public.expense_approvals
     where claim_id = p_claim and status = 'waiting';
    if v_next is not null and not public.is_super() then
      update public.expense_approvals set status = 'pending' where claim_id = p_claim and step_order = v_next;
      if v_has_notify then
        perform public.notify_users(
          (select approver_ids from public.expense_approvals where claim_id = p_claim and step_order = v_next),
          'expense_needed', 'Klaim biaya menunggu persetujuanmu',
          (select full_name from public.profiles where id = v_req.user_id) || ' mengajukan klaim Rp '
            || to_char(v_req.amount, 'FM999G999G999G999') || '.',
          'expense', p_claim);
      end if;
      return 'pending';
    end if;
    perform public.expense_finalize_approval(p_claim, auth.uid(), p_notes);
  end if;

  if v_has_notify then
    perform public.notify_user(
      v_req.user_id, 'expense_decided',
      case when p_decision = 'approved' then 'Klaim biaya disetujui' else 'Klaim biaya ditolak' end,
      case when p_notes is not null and btrim(p_notes) <> '' then p_notes else null end,
      'expense', p_claim);
  end if;
  return p_decision;
end;
$$;
revoke execute on function public.decide_expense(uuid, text, text) from public, anon;
grant execute on function public.decide_expense(uuid, text, text) to authenticated;

create or replace function public.cancel_expense(p_claim uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_req public.expense_claims%rowtype;
begin
  select * into v_req from public.expense_claims where id = p_claim for update;
  if not found or v_req.user_id <> auth.uid() or v_req.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Klaim tidak ditemukan';
  end if;
  if v_req.status <> 'pending' then raise exception 'Hanya klaim yang masih menunggu yang bisa dibatalkan'; end if;
  update public.expense_claims set status = 'cancelled', reviewed_at = now(), updated_at = now() where id = p_claim;
  update public.expense_approvals set status = 'rejected' where claim_id = p_claim and status in ('waiting', 'pending');
end;
$$;
revoke execute on function public.cancel_expense(uuid) from public, anon;
grant execute on function public.cancel_expense(uuid) to authenticated;

-- HR / Super Admin: pindahkan periode bayar klaim yang sudah disetujui
-- tapi belum masuk slip final.
create or replace function public.set_expense_period(p_claim uuid, p_period text)
returns void language plpgsql security definer set search_path = public as $$
declare v_c public.expense_claims%rowtype;
begin
  if not (public.is_super() or public.my_role() in ('super_admin_hr', 'admin_hr')) then
    raise exception 'Hanya Super Admin / Admin HR yang boleh mengubah periode bayar';
  end if;
  if p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Format periode harus YYYY-MM'; end if;
  select * into v_c from public.expense_claims where id = p_claim for update;
  if not found or v_c.tenant_id is distinct from public.current_tenant_id() then raise exception 'Klaim tidak ditemukan'; end if;
  if v_c.status <> 'approved' then raise exception 'Hanya klaim disetujui yang belum dibayar yang bisa dipindah'; end if;
  if exists (select 1 from public.payroll_periods where tenant_id = v_c.tenant_id and period = p_period) then
    raise exception 'Periode % sudah difinalisasi', p_period;
  end if;
  update public.expense_claims set pay_period = p_period, updated_at = now() where id = p_claim;
end;
$$;
revoke execute on function public.set_expense_period(uuid, text) from public, anon;
grant execute on function public.set_expense_period(uuid, text) to authenticated;

-- HR / Super Admin: batalkan klaim yang sudah disetujui tapi belum dibayar.
create or replace function public.void_expense(p_claim uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_c public.expense_claims%rowtype;
begin
  if not (public.is_super() or public.my_role() in ('super_admin_hr', 'admin_hr')) then
    raise exception 'Hanya Super Admin / Admin HR yang boleh membatalkan klaim disetujui';
  end if;
  select * into v_c from public.expense_claims where id = p_claim for update;
  if not found or v_c.tenant_id is distinct from public.current_tenant_id() then raise exception 'Klaim tidak ditemukan'; end if;
  if v_c.status <> 'approved' then raise exception 'Hanya klaim disetujui yang belum dibayar yang bisa dibatalkan'; end if;
  update public.expense_claims
     set status = 'cancelled', review_notes = coalesce(nullif(btrim(p_notes), ''), review_notes), updated_at = now()
   where id = p_claim;
end;
$$;
revoke execute on function public.void_expense(uuid, text) from public, anon;
grant execute on function public.void_expense(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. SINKRON DENGAN SLIP GAJI
--    Slip karyawan dibekukan (insert payroll_slips) -> klaim periode itu 'paid'
--    Periode dibuka kuncinya (slip dihapus)         -> kembali 'approved'
-- ---------------------------------------------------------------------
create or replace function public.tg_slip_expense_paid()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.expense_claims
     set status = 'paid', paid_at = now(), updated_at = now()
   where tenant_id = new.tenant_id and user_id = new.user_id
     and pay_period = new.period and status = 'approved';
  return new;
end;
$$;
drop trigger if exists zz_slip_expense_paid on public.payroll_slips;
create trigger zz_slip_expense_paid after insert on public.payroll_slips
  for each row execute function public.tg_slip_expense_paid();

create or replace function public.tg_slip_expense_unpaid()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.expense_claims
     set status = 'approved', paid_at = null, updated_at = now()
   where tenant_id = old.tenant_id and user_id = old.user_id
     and pay_period = old.period and status = 'paid';
  return old;
end;
$$;
drop trigger if exists zz_slip_expense_unpaid on public.payroll_slips;
create trigger zz_slip_expense_unpaid after delete on public.payroll_slips
  for each row execute function public.tg_slip_expense_unpaid();

-- ---------------------------------------------------------------------
-- 10. HAK MENU
--    reimburse          : semua role (klaim pribadi)
--    reimburse-approval : Admin HR, Super Admin HR, Admin approval
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'reimburse', true), ('admin_hr', 'reimburse', true),
  ('admin_approval', 'reimburse', true), ('karyawan', 'reimburse', true),
  ('super_admin_hr', 'reimburse-approval', true), ('admin_hr', 'reimburse-approval', true),
  ('admin_approval', 'reimburse-approval', true), ('karyawan', 'reimburse-approval', false)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('reimburse', 'reimburse-approval')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): versi 010 + 'reimburse'.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse'];
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
--   drop trigger if exists zz_slip_expense_paid on public.payroll_slips;
--   drop trigger if exists zz_slip_expense_unpaid on public.payroll_slips;
--   drop table if exists public.expense_approvals, public.expense_claims cascade;
--   drop policy if exists "receipt_insert_own" on storage.objects;
--   drop policy if exists "receipt_select_tenant" on storage.objects;
--   delete from public.role_permissions where menu_id in ('reimburse','reimburse-approval');
--   delete from public.role_permission_defaults where menu_id in ('reimburse','reimburse-approval');
--   delete from public.menu_features where menu_id in ('reimburse','reimburse-approval');
--   update public.plans set features = array_remove(features, 'reimburse');
--   delete from public.feature_catalog where kode = 'reimburse';
-- =====================================================================
