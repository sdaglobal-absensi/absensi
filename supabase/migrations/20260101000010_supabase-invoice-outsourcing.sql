-- =====================================================================
-- INVOICE OUTSOURCING — Cocokkan tagihan PT vendor outsourcing dengan
-- acuan internal (Total Pendapatan di Slip Gaji yang sudah difinalisasi).
-- Jalankan sekali di Supabase SQL Editor (aman dijalankan ulang).
--
-- Butuh supabase-schema.sql DAN supabase-jenis-hubungan-kerja.sql sudah
-- pernah dijalankan lebih dulu (perlu kolom profiles.jenis_hubungan_kerja
-- dan tabel payroll_slips/payroll_periods).
--
-- Cara kerja: satu baris = satu input manual "nominal tagihan vendor" (+
-- No. Invoice, catatan) untuk satu karyawan outsourcing pada satu periode
-- 'YYYY-MM'. Angka pembandingnya (Total Pendapatan) TIDAK disimpan di sini
-- -- selalu dibaca langsung dari payroll_slips.snapshot milik periode yang
-- sama, supaya kalau slip itu suatu saat dibuka-kunci lalu difinalisasi
-- ulang, halaman Invoice Outsourcing otomatis ikut memakai angka terbaru.
-- =====================================================================

create table if not exists public.outsourcing_invoices (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  period                  text not null,  -- format 'YYYY-MM', sama seperti payroll_slips.period
  nominal_tagihan_vendor  numeric not null default 0,
  no_invoice              text,
  catatan                 text,
  updated_by              uuid references public.profiles(id),
  updated_at              timestamptz not null default now(),
  unique (user_id, period)
);

comment on table public.outsourcing_invoices is
  'Input manual nominal tagihan PT vendor outsourcing per karyawan per periode, untuk dicocokkan dengan Total Pendapatan di payroll_slips (Slip Gaji yang sudah difinalisasi).';

create index if not exists idx_outsourcing_invoices_period on public.outsourcing_invoices(period);

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY — sama persis pola payroll_adjustments: staff saja
-- yang boleh baca/tulis (data ini murni keperluan finansial internal,
-- bukan sesuatu yang perlu dilihat karyawan outsourcing sendiri lewat app).
-- ---------------------------------------------------------------------
alter table public.outsourcing_invoices enable row level security;

drop policy if exists "outsourcing_invoices_select" on public.outsourcing_invoices;
create policy "outsourcing_invoices_select" on public.outsourcing_invoices
  for select using ( public.is_staff() );

drop policy if exists "outsourcing_invoices_write" on public.outsourcing_invoices;
create policy "outsourcing_invoices_write" on public.outsourcing_invoices
  for all using ( public.is_staff() and public.has_menu_access('invoice-outsourcing') )
  with check ( public.is_staff() and public.has_menu_access('invoice-outsourcing') );

-- ---------------------------------------------------------------------
-- Hak menu default untuk 'invoice-outsourcing': disamakan dengan default
-- 'slip-gaji' -- Super Admin HR menyala, Admin HR/Karyawan/Admin mati dulu
-- (Super Admin bisa nyalakan manual lewat Pengaturan Sistem).
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, menu_id, enabled) values
  ('admin_hr', 'invoice-outsourcing', false),
  ('super_admin_hr', 'invoice-outsourcing', true),
  ('admin_approval', 'invoice-outsourcing', false),
  ('karyawan', 'invoice-outsourcing', false)
on conflict (role, menu_id) do nothing;
