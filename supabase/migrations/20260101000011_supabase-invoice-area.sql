-- =====================================================================
-- INVOICE OUTSOURCING PER AREA — tarif per vendor + invoice per area.
-- Jalankan sekali di Supabase SQL Editor (aman dijalankan ulang).
--
-- Butuh supabase-master-pt.sql dan supabase-invoice-outsourcing.sql sudah
-- dijalankan lebih dulu.
--
-- 1) master_pt: tambah Management Fee %, PPN %, PPh 23 %, rekening, dan
--    nama penandatangan. Tiap vendor bisa beda; 0 = baris itu tidak
--    ditampilkan di invoice.
--    Rumus (sesuai invoice vendor):
--      Management Fee = Total Gaji Karyawan x fee%
--      PPN            = Management Fee x ppn%
--      Total          = Total Gaji + Management Fee + PPN
--      PPh 23         = Management Fee x pph23%
--      Total Tagihan  = Total - PPh 23
-- 2) outsourcing_area_invoices: satu baris = satu invoice untuk satu
--    vendor + satu area (profiles.lokasi_kerja) + satu periode. Menyimpan
--    No. Invoice, tanggal, dan nominal tagihan yang benar-benar tertulis
--    di invoice vendor (untuk dibandingkan dengan hitungan aplikasi).
--    Tabel lama outsourcing_invoices (per karyawan) tidak dihapus.
-- =====================================================================

alter table public.master_pt
  add column if not exists fee_persen        numeric not null default 0 check (fee_persen   >= 0),
  add column if not exists ppn_persen        numeric not null default 0 check (ppn_persen   >= 0),
  add column if not exists pph23_persen      numeric not null default 0 check (pph23_persen >= 0),
  add column if not exists bank_rekening     text,
  add column if not exists nama_penandatangan text;

create table if not exists public.outsourcing_area_invoices (
  id                      uuid primary key default gen_random_uuid(),
  vendor                  text not null,   -- = master_pt.nama = profiles.unit_pt
  area                    text not null,   -- = profiles.lokasi_kerja ('' jika belum diisi)
  period                  text not null,   -- 'YYYY-MM', sama seperti payroll_slips.period
  no_invoice              text,
  tanggal_invoice         date,
  nominal_tagihan_vendor  numeric not null default 0,
  catatan                 text,
  updated_by              uuid references public.profiles(id),
  updated_at              timestamptz not null default now(),
  unique (vendor, area, period)
);

create index if not exists idx_outsourcing_area_invoices_period
  on public.outsourcing_area_invoices(period);

alter table public.outsourcing_area_invoices enable row level security;

drop policy if exists "outsourcing_area_invoices_select" on public.outsourcing_area_invoices;
create policy "outsourcing_area_invoices_select" on public.outsourcing_area_invoices
  for select using ( public.is_staff() );

drop policy if exists "outsourcing_area_invoices_write" on public.outsourcing_area_invoices;
create policy "outsourcing_area_invoices_write" on public.outsourcing_area_invoices
  for all using ( public.is_staff() and public.has_menu_access('invoice-outsourcing') )
  with check ( public.is_staff() and public.has_menu_access('invoice-outsourcing') );
