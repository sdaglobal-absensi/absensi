-- =====================================================================
-- 020 — PELAPORAN ERROR DARI BROWSER (observabilitas ringan, tanpa pihak ketiga)
-- Error JS tak tertangani dikirim lewat RPC log_client_error() dan bisa
-- dibaca Super Admin. Dibatasi 20 laporan/user/jam; teks dipotong.
-- Aman dijalankan ulang. Rollback: drop table public.client_errors cascade;
-- =====================================================================
begin;

create table if not exists public.client_errors (
  id         bigint generated always as identity primary key,
  tenant_id  uuid references public.tenants(id) on delete cascade default public.current_tenant_id(),
  user_id    uuid references public.profiles(id) on delete set null,
  message    text not null,
  stack      text,
  page       text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_client_errors_created on public.client_errors (tenant_id, created_at desc);

alter table public.client_errors enable row level security;
drop policy if exists client_errors_select on public.client_errors;
create policy client_errors_select on public.client_errors
  for select using (tenant_id = public.current_tenant_id() and public.is_super());
-- Tanpa policy insert: hanya lewat RPC.

create or replace function public.log_client_error(p_message text, p_stack text, p_page text, p_ua text)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from public.client_errors
       where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 20 then
    return;
  end if;
  select tenant_id into v_tenant from public.profiles where id = auth.uid();
  insert into public.client_errors (tenant_id, user_id, message, stack, page, user_agent)
  values (v_tenant, auth.uid(), left(coalesce(p_message, '?'), 500), left(p_stack, 4000), left(p_page, 300), left(p_ua, 300));
end;
$$;
revoke execute on function public.log_client_error(text, text, text, text) from public, anon;
grant execute on function public.log_client_error(text, text, text, text) to authenticated;

commit;
-- Lihat error terbaru (Super Admin / SQL Editor):
--   select created_at, message, page from public.client_errors order by created_at desc limit 50;
