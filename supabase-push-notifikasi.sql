-- =========================================================================
-- PUSH NOTIFIKASI — pengingat check-out otomatis
-- Jalankan file ini di Supabase SQL Editor SETELAH supabase-schema.sql.
-- Aman dijalankan berkali-kali (idempotent).
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. TABEL: push_subscriptions
--    Menyimpan "alamat" push notification browser/HP karyawan (didapat dari
--    PushManager.subscribe() di sisi client, lihat js/push.js). Satu
--    karyawan bisa punya lebih dari satu baris kalau dia login dari lebih
--    dari satu device/browser — semuanya akan dikirimi notifikasi.
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_own" on public.push_subscriptions;
create policy "push_subscriptions_own" on public.push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table public.push_subscriptions is
  'Endpoint Web Push milik tiap karyawan (bisa lebih dari satu device). Dipakai Edge Function checkout-reminder untuk mengirim notifikasi.';

-- ---------------------------------------------------------------------
-- 2. KOLOM: attendance.checkout_reminder_sent_at
--    Menandai sesi yang sudah dikirimi pengingat, supaya Edge Function
--    tidak mengirim notifikasi berkali-kali untuk sesi terbuka yang sama.
-- ---------------------------------------------------------------------
alter table public.attendance
  add column if not exists checkout_reminder_sent_at timestamptz;

comment on column public.attendance.checkout_reminder_sent_at is
  'Diisi otomatis oleh Edge Function checkout-reminder begitu pengingat push terkirim untuk sesi ini. NULL berarti belum pernah dikirimi.';
