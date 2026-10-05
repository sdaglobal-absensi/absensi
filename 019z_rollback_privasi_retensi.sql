begin;
drop function if exists public.has_accepted_privacy(text);
drop function if exists public.accept_privacy(text);
drop table if exists public.data_retention_settings;
drop table if exists public.privacy_consents;
commit;
