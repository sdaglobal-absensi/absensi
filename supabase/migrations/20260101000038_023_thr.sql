-- =====================================================================
-- 023 — THR (TUNJANGAN HARI RAYA)
--
-- Satu "Pembayaran THR" per tahun untuk SEMUA karyawan aktif (bukan per agama).
-- Slip THR TERPISAH dari slip gaji bulanan. Dasar upah = gaji pokok + tunjangan
-- tetap (Master Tunjangan). PPh21 memakai persentase khusus THR yang diisi
-- admin per pembayaran (bukan persentase Master Level).
--
-- Tabel:
--   thr_payments  satu baris = satu pembayaran THR (nama, tanggal acuan masa
--                 kerja, tanggal bayar, % PPh21, status draft/final)
--   thr_items     satu baris = THR satu karyawan (angka + snapshot rincian)
--
-- Menu: 'thr' (kelola, Super Admin HR) dan 'thr-saya' (karyawan lihat & cetak
-- slip THR miliknya sendiri). Keduanya mengikuti fitur paket 'payroll'.
--
-- Jalankan SETELAH 022. Aman dijalankan ulang (idempotent).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.thr_payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default public.current_tenant_id()
                     references public.tenants(id) on delete restrict,
  name               text not null check (length(btrim(name)) between 1 and 100),
  reference_date     date not null,                       -- tanggal acuan penghitungan masa kerja
  pay_date           date,                                -- tanggal THR dibayarkan
  pph21_persen       numeric(5,2) not null default 0 check (pph21_persen >= 0 and pph21_persen <= 100),
  include_tunjangan  boolean not null default true,       -- dasar upah: gaji pokok + tunjangan tetap
  pembulatan         text not null default 'bawah' check (pembulatan in ('bawah', 'atas15')),
  notes              text,
  status             text not null default 'draft' check (status in ('draft', 'final')),
  created_by         uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  finalized_by       uuid references public.profiles(id) on delete set null,
  finalized_at       timestamptz
);
create index if not exists idx_thr_payments_tenant on public.thr_payments (tenant_id, reference_date desc);

create table if not exists public.thr_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default public.current_tenant_id()
              references public.tenants(id) on delete restrict,
  thr_id      uuid not null references public.thr_payments(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  thr_bruto   numeric not null default 0,
  pph21       numeric not null default 0,
  thr_neto    numeric not null default 0,
  snapshot    jsonb not null,    -- rincian lengkap (masa kerja, dasar upah, rumus, peringatan) untuk slip
  unique (thr_id, user_id)
);
create index if not exists idx_thr_items_thr on public.thr_items (thr_id);
create index if not exists idx_thr_items_user on public.thr_items (user_id);

comment on table public.thr_payments is 'Satu pembayaran THR (mis. "THR 2027") untuk seluruh karyawan aktif. Status final = dikunci dan slip tampil ke karyawan.';
comment on table public.thr_items is 'THR per karyawan untuk satu pembayaran. snapshot menyimpan rincian perhitungan yang dipakai slip THR.';

drop trigger if exists aa_tenant_immutable on public.thr_payments;
create trigger aa_tenant_immutable before update on public.thr_payments
  for each row execute function public.tg_tenant_immutable();
drop trigger if exists aa_tenant_immutable on public.thr_items;
create trigger aa_tenant_immutable before update on public.thr_items
  for each row execute function public.tg_tenant_immutable();

-- ---------------------------------------------------------------------
-- 2. PENJAGA: THR yang sudah FINAL tidak boleh diubah/dihapus, kecuali Super
--    Admin (buka kunci). auth.uid() NULL (SQL editor / service role) diizinkan.
-- ---------------------------------------------------------------------
create or replace function public.thr_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_thr    uuid;
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'thr_payments' then
    if old.status = 'final' and not public.is_super() then
      raise exception 'THR ini sudah final. Hanya Super Admin yang bisa membuka kunci.';
    end if;
  else
    if tg_op = 'DELETE' then v_thr := old.thr_id; else v_thr := new.thr_id; end if;
    select status into v_status from public.thr_payments where id = v_thr;
    if v_status = 'final' and not public.is_super() then
      raise exception 'THR ini sudah final. Hanya Super Admin yang bisa membuka kunci.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_thr_payments_guard on public.thr_payments;
create trigger trg_thr_payments_guard before update or delete on public.thr_payments
  for each row execute function public.thr_guard();
drop trigger if exists trg_thr_items_guard on public.thr_items;
create trigger trg_thr_items_guard before insert or update or delete on public.thr_items
  for each row execute function public.thr_guard();

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table public.thr_payments enable row level security;
alter table public.thr_items enable row level security;

drop policy if exists tenant_isolation on public.thr_payments;
create policy tenant_isolation on public.thr_payments as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
drop policy if exists tenant_isolation on public.thr_items;
create policy tenant_isolation on public.thr_items as restrictive for all
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists feature_gate on public.thr_payments;
create policy feature_gate on public.thr_payments as restrictive for all to authenticated
  using ((select public.tenant_has_feature('payroll')))
  with check ((select public.tenant_has_feature('payroll')));
drop policy if exists feature_gate on public.thr_items;
create policy feature_gate on public.thr_items as restrictive for all to authenticated
  using ((select public.tenant_has_feature('payroll')))
  with check ((select public.tenant_has_feature('payroll')));

-- thr_payments: pengelola melihat semuanya; semua orang hanya yang sudah FINAL
-- (isinya cuma nama & tanggal, tidak ada angka gaji siapa pun).
drop policy if exists thr_payments_select on public.thr_payments;
create policy thr_payments_select on public.thr_payments for select
  using (status = 'final' or (public.is_staff() and public.has_menu_access('thr')));
drop policy if exists thr_payments_write on public.thr_payments;
create policy thr_payments_write on public.thr_payments for all
  using (public.is_staff() and public.has_menu_access('thr'))
  with check (public.is_staff() and public.has_menu_access('thr'));

-- thr_items: pengelola melihat semua; karyawan hanya miliknya sendiri dan hanya
-- kalau pembayarannya sudah FINAL.
drop policy if exists thr_items_select on public.thr_items;
create policy thr_items_select on public.thr_items for select
  using (
    (public.is_staff() and public.has_menu_access('thr'))
    or (user_id = auth.uid()
        and exists (select 1 from public.thr_payments p where p.id = thr_id and p.status = 'final'))
  );
drop policy if exists thr_items_write on public.thr_items;
create policy thr_items_write on public.thr_items for all
  using (public.is_staff() and public.has_menu_access('thr'))
  with check (public.is_staff() and public.has_menu_access('thr'));

-- ---------------------------------------------------------------------
-- 4. GERBANG PAKET + HAK MENU
-- ---------------------------------------------------------------------
insert into public.menu_features (menu_id, feature) values
  ('thr', 'payroll'), ('thr-saya', 'payroll')
on conflict (menu_id) do nothing;

-- 'thr' (kelola) mengikuti pola 'slip-gaji': hanya Super Admin HR secara bawaan.
-- 'thr-saya' (lihat slip THR sendiri) terbuka untuk semua role.
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'thr', true),  ('admin_hr', 'thr', false),
  ('admin_approval', 'thr', false), ('karyawan', 'thr', false),
  ('super_admin_hr', 'thr-saya', true), ('admin_hr', 'thr-saya', true),
  ('admin_approval', 'thr-saya', true), ('karyawan', 'thr-saya', true)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('thr', 'thr-saya')
on conflict (tenant_id, role, menu_id) do nothing;

-- Template UMKM ('ringkas'): versi 017 + 'thr-saya'.
create or replace function public.seed_tenant_template(p_tenant uuid, p_template text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_personal text[] := array['profil','absensi','izin','lembur','koreksi','riwayat','slip-gaji-saya','pengumuman','dinas-luar','kasbon','reimburse','dokumen','tukar-shift','kpi-saya','thr-saya'];
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
--   drop table if exists public.thr_items, public.thr_payments cascade;
--   drop function if exists public.thr_guard();
--   delete from public.role_permissions where menu_id in ('thr','thr-saya');
--   delete from public.role_permission_defaults where menu_id in ('thr','thr-saya');
--   delete from public.menu_features where menu_id in ('thr','thr-saya');
--   -- lalu jalankan ulang fungsi seed_tenant_template di 017 (tanpa 'thr-saya')
-- =====================================================================
