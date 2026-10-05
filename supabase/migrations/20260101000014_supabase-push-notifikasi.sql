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

-- ---------------------------------------------------------------------
-- 3. TABEL: checkin_reminders_sent
--    Anti-kirim-dobel untuk pengingat "belum check-in". Berbeda dari
--    checkout_reminder_sent_at (yang nempel di baris attendance), pengingat
--    check-in dikirim SEBELUM baris attendance-nya ada sama sekali — jadi
--    butuh tabel log terpisah, dikunci per (user_id, date).
-- ---------------------------------------------------------------------
create table if not exists public.checkin_reminders_sent (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.checkin_reminders_sent enable row level security;

drop policy if exists "checkin_reminders_sent_own_read" on public.checkin_reminders_sent;
create policy "checkin_reminders_sent_own_read" on public.checkin_reminders_sent
  for select
  using (auth.uid() = user_id);

comment on table public.checkin_reminders_sent is
  'Log anti-dobel untuk pengingat push "belum check-in" — satu baris per karyawan per tanggal. Ditulis oleh Edge Function checkout-reminder (service role, bypass RLS).';

-- ---------------------------------------------------------------------
-- 4. KOLOM: attendance.checkout_before_reminder_sent_at
--    Anti-kirim-dobel untuk pengingat "sebentar lagi jam pulang" — dikirim
--    SEBELUM jam pulang tiba (beda dari checkout_reminder_sent_at yang
--    dikirim SESUDAH lewat jam pulang dan belum checkout).
-- ---------------------------------------------------------------------
alter table public.attendance
  add column if not exists checkout_before_reminder_sent_at timestamptz;

comment on column public.attendance.checkout_before_reminder_sent_at is
  'Diisi otomatis oleh Edge Function checkout-reminder begitu pengingat "sebentar lagi jam pulang" terkirim untuk sesi ini. NULL berarti belum pernah dikirimi.';

-- ---------------------------------------------------------------------
-- 5. TABEL: checkin_before_reminder_sent
--    Anti-kirim-dobel untuk pengingat "sebentar lagi jam masuk" — dikirim
--    SEBELUM jam masuk tiba. Perlu tabel log terpisah dengan alasan yang
--    sama seperti checkin_reminders_sent (belum ada baris attendance sama
--    sekali saat pengingat ini relevan).
-- ---------------------------------------------------------------------
create table if not exists public.checkin_before_reminder_sent (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.checkin_before_reminder_sent enable row level security;

drop policy if exists "checkin_before_reminder_sent_own_read" on public.checkin_before_reminder_sent;
create policy "checkin_before_reminder_sent_own_read" on public.checkin_before_reminder_sent
  for select
  using (auth.uid() = user_id);

comment on table public.checkin_before_reminder_sent is
  'Log anti-dobel untuk pengingat push "sebentar lagi jam masuk" — satu baris per karyawan per tanggal. Ditulis oleh Edge Function checkout-reminder (service role, bypass RLS).';

-- ---------------------------------------------------------------------
-- 6. TABEL: push_settings (satu baris global)
--    Saklar utama dari halaman "Pengaturan Sistem" (Super Admin): kalau
--    reminders_enabled = false, Edge Function checkout-reminder TIDAK
--    mengirim notifikasi apapun ke SIAPAPUN sama sekali (skip total),
--    walau karyawan yang bersangkutan sudah pernah klik "Aktifkan
--    Pengingat" di device-nya.
--
--    PENTING (batasan browser, bukan batasan tabel ini): saklar ini HANYA
--    mengendalikan pengiriman dari server. Setiap karyawan tetap WAJIB
--    klik "Aktifkan Pengingat" satu kali di device masing-masing supaya
--    browser-nya mengeluarkan izin notifikasi (Notification permission) --
--    ini aturan keamanan browser yang berlaku untuk SEMUA website, tidak
--    ada API yang mengizinkan pihak lain (termasuk Super Admin dari akun
--    lain) memberi izin notifikasi atas nama orang lain di device mereka.
--    Saklar ini tidak bisa "memaksa aktif" untuk karyawan yang belum
--    pernah klik tombol itu sama sekali.
-- ---------------------------------------------------------------------
create table if not exists public.push_settings (
  id                 integer primary key default 1,
  reminders_enabled  boolean not null default true,
  updated_by         uuid references public.profiles(id),
  updated_at         timestamptz not null default now(),
  constraint push_settings_single_row check (id = 1)
);

insert into public.push_settings (id, reminders_enabled) values (1, true) on conflict (id) do nothing;

alter table public.push_settings enable row level security;

-- SELECT dibuka untuk SEMUA user yang login (bukan cuma staff) -- halaman
-- Absensi tiap karyawan perlu baca ini untuk tahu apakah kartu "Aktifkan
-- Pengingat" boleh ditampilkan atau tidak (lihat renderPushOptIn() di
-- employee-absensi.js). Ini bukan data sensitif, cuma satu boolean.
-- UPDATE tetap dibatasi lewat push_settings_write di bawah.
drop policy if exists "push_settings_rw" on public.push_settings;
drop policy if exists "push_settings_select" on public.push_settings;
create policy "push_settings_select" on public.push_settings
  for select using ( auth.uid() is not null );

drop policy if exists "push_settings_write" on public.push_settings;
create policy "push_settings_write" on public.push_settings
  for all
  using ( public.is_super() or public.has_menu_access('pengaturan-sistem') )
  with check ( public.is_super() or public.has_menu_access('pengaturan-sistem') );

comment on table public.push_settings is
  'Saklar global on/off pengiriman semua notifikasi push absensi, dikontrol dari halaman Pengaturan Sistem. TIDAK menggantikan izin notifikasi browser tiap karyawan -- itu tetap harus diaktifkan sendiri oleh masing-masing karyawan sekali di device-nya (batasan keamanan browser).';
