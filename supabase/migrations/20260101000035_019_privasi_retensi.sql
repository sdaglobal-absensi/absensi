-- =====================================================================
-- 019 — PERSETUJUAN PRIVASI (UU PDP) + RETENSI FOTO ABSENSI
--
-- 1. privacy_consents : catatan persetujuan kebijakan privasi per user per
--    versi (bukti consent). Ditulis hanya lewat RPC accept_privacy().
-- 2. data_retention_settings : lama simpan foto absensi per usaha (bulan).
--    NULL = simpan selamanya. Dipakai Edge Function `retention-cleanup`.
--
-- Versi kebijakan aktif ada di klien (js/privacy.js -> PRIVACY_VERSION) dan
-- harus dinaikkan setiap isi privacy.html berubah material, supaya semua
-- pengguna diminta setuju ulang.
-- Aman dijalankan ulang. Rollback: 019z_rollback_privasi_retensi.sql
-- =====================================================================
begin;

create table if not exists public.privacy_consents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade default public.current_tenant_id(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  version     text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, version)
);
create index if not exists idx_privacy_consents_user on public.privacy_consents (user_id, accepted_at desc);

alter table public.privacy_consents enable row level security;
drop policy if exists privacy_consents_select_own on public.privacy_consents;
create policy privacy_consents_select_own on public.privacy_consents
  for select using (user_id = auth.uid() or public.is_super());
-- Tanpa policy insert/update/delete: hanya RPC di bawah (security definer).

create or replace function public.accept_privacy(p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if coalesce(trim(p_version), '') = '' then raise exception 'Versi kebijakan kosong'; end if;
  insert into public.privacy_consents (tenant_id, user_id, version)
    select p.tenant_id, p.id, p_version from public.profiles p where p.id = auth.uid()
  on conflict (user_id, version) do nothing;
end;
$$;
revoke execute on function public.accept_privacy(text) from public, anon;
grant execute on function public.accept_privacy(text) to authenticated;

create or replace function public.has_accepted_privacy(p_version text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.privacy_consents where user_id = auth.uid() and version = p_version);
$$;
revoke execute on function public.has_accepted_privacy(text) from public, anon;
grant execute on function public.has_accepted_privacy(text) to authenticated;

-- Retensi foto absensi per usaha.
create table if not exists public.data_retention_settings (
  tenant_id               uuid primary key references public.tenants(id) on delete cascade,
  photo_retention_months  integer check (photo_retention_months is null or photo_retention_months between 1 and 120),
  updated_at              timestamptz not null default now()
);
alter table public.data_retention_settings enable row level security;
drop policy if exists retention_select on public.data_retention_settings;
create policy retention_select on public.data_retention_settings
  for select using (tenant_id = public.current_tenant_id() and public.is_super());
drop policy if exists retention_write on public.data_retention_settings;
create policy retention_write on public.data_retention_settings
  for all using (tenant_id = public.current_tenant_id() and public.is_super())
  with check (tenant_id = public.current_tenant_id() and public.is_super());

commit;

-- Contoh: simpan foto absensi 12 bulan untuk usaha Anda (jalankan sebagai Super Admin / SQL Editor):
--   insert into public.data_retention_settings (tenant_id, photo_retention_months)
--   values ('<uuid-tenant>', 12)
--   on conflict (tenant_id) do update set photo_retention_months = excluded.photo_retention_months, updated_at = now();
