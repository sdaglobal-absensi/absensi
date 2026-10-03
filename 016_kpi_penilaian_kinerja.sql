-- =====================================================================
-- PRIORITAS RENDAH/MENENGAH #9 — PENILAIAN KINERJA (KPI)
-- =====================================================================
-- Jalankan di Supabase SQL Editor SETELAH 001-015. Aman dijalankan ulang.
--
-- Cara kerja:
--   1. HR membuat PERIODE PENILAIAN (mis. "Semester 1 2026"), mengisi KRITERIA
--      beserta bobotnya (ada kriteria bawaan), lalu klik "Buat Penilaian":
--      satu penilaian dibuat untuk tiap karyawan aktif (bisa per departemen).
--      Penilai otomatis = atasan tingkat 1 di Struktur Organisasi yang punya
--      menu 'Penilaian Tim'; kalau tidak ada, HR memilih penilai manual.
--   2. Penilai memberi nilai 1-5 per kriteria + komentar. Nilai akhir =
--      rata-rata tertimbang (bobot kriteria). Boleh diubah selama periode masih
--      'berjalan'.
--   3. HR mempublikasikan periode -> karyawan melihat hasil penilaiannya
--      sendiri di 'Penilaian Kinerja Saya'. Belum dipublikasikan = tidak terlihat.
--   4. Kriteria terkunci begitu ada penilaian yang sudah dikirim / periode
--      dipublikasikan, supaya nilai tidak bergeser.
--
-- Paket : fitur baru 'kpi' -> Bisnis, Enterprise, Internal (ubah di bawah kalau
--         ingin hanya Enterprise).
-- Menu  : kpi-kelola (HR: Super Admin HR, Admin HR) | kpi-nilai (penilai: HR +
--         Admin approval) | kpi-saya (semua role). Super Admin selalu bisa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------
create table if not exists public.kpi_cycles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id()
               references public.tenants(id) on delete restrict,
  name         text not null check (length(btrim(name)) between 1 and 120),
  period_start date not null,
  period_end   date not null,
  status       text not null default 'open' check (status in ('open', 'published')),
  created_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint kpi_cycles_dates_chk check (period_end >= period_start)
);
create index if not exists idx_kpi_cycles_tenant on public.kpi_cycles (tenant_id, period_start desc);

create table if not exists public.kpi_criteria (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default public.current_tenant_id()
              references public.tenants(id) on delete restrict,
  cycle_id    uuid not null references public.kpi_cycles(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 100),
  description text check (description is null or length(description) <= 300),
  weight      numeric not null check (weight > 0 and weight <= 1000),
  sort_order  integer not null default 0
);
create index if not exists idx_kpi_criteria_cycle on public.kpi_criteria (cycle_id, sort_order);

create table if not exists public.kpi_reviews (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete restrict,
  cycle_id        uuid not null references public.kpi_cycles(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  user_name       text,                 -- salinan nama/departemen: penilai tidak selalu boleh membaca profil bawahan
  user_department text,
  reviewer_id     uuid references public.profiles(id) on delete set null,
  reviewer_name   text,
  status          text not null default 'pending' check (status in ('pending', 'submitted')),
  overall_score   numeric(4, 2),
  comments        text check (comments is null or length(comments) <= 1000),
  submitted_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (cycle_id, user_id)
);
create index if not exists idx_kpi_reviews_cycle on public.kpi_reviews (cycle_id, status);
create index if not exists idx_kpi_reviews_reviewer on public.kpi_reviews (reviewer_id, status);
create index if not exists idx_kpi_reviews_user on public.kpi_reviews (user_id);

create table if not exists public.kpi_scores (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete restrict,
  review_id    uuid not null references public.kpi_reviews(id) on delete cascade,
  criterion_id uuid not null references public.kpi_criteria(id) on delete cascade,
  score        smallint not null check (score between 1 and 5),
  note         text check (note is null or length(note) <= 500),
  unique (review_id, criterion_id)
);
create index if not exists idx_kpi_scores_review on public.kpi_scores (review_id);

do $$
declare t text;
begin
  foreach t in array array['kpi_cycles', 'kpi_criteria', 'kpi_reviews', 'kpi_scores'] loop
    execute format('drop trigger if exists aa_tenant_immutable on public.%I', t);
    execute format('create trigger aa_tenant_immutable before update on public.%I for each row execute function public.tg_tenant_immutable()', t);
  end loop;
end $$;

-- Kriteria hanya boleh diubah selagi belum ada nilai terkirim & periode belum dipublikasikan.
create or replace function public.tg_kpi_criteria_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cycle uuid := coalesce(new.cycle_id, old.cycle_id);
begin
  if tg_op = 'INSERT' and not exists (select 1 from public.kpi_cycles where id = new.cycle_id and tenant_id = new.tenant_id) then
    raise exception 'Periode penilaian tidak ditemukan';
  end if;
  if exists (select 1 from public.kpi_reviews where cycle_id = v_cycle and status = 'submitted')
     or exists (select 1 from public.kpi_cycles where id = v_cycle and status = 'published') then
    raise exception 'Kriteria terkunci: sudah ada penilaian yang dikirim atau periode sudah dipublikasikan';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists kpi_criteria_lock on public.kpi_criteria;
create trigger kpi_criteria_lock before insert or update or delete on public.kpi_criteria
  for each row execute function public.tg_kpi_criteria_lock();

-- ---------------------------------------------------------------------
-- 2. GERBANG PAKET (fitur 'kpi')
-- ---------------------------------------------------------------------
insert into public.feature_catalog (kode, nama, deskripsi, requires, sort_order) values
  ('kpi', 'Penilaian Kinerja (KPI)',
   'Periode penilaian, kriteria berbobot, penilaian oleh atasan, dan hasil yang bisa dilihat karyawan', '{}', 61)
on conflict (kode) do nothing;

insert into public.menu_features (menu_id, feature) values
  ('kpi-kelola', 'kpi'), ('kpi-nilai', 'kpi'), ('kpi-saya', 'kpi')
on conflict (menu_id) do nothing;

update public.plans
   set features = (select array_agg(distinct f order by f) from unnest(features || array['kpi']) f)
 where kode in ('bisnis', 'enterprise', 'internal') and not ('kpi' = any(features));

-- ---------------------------------------------------------------------
-- 3. FUNGSI PEMBANTU HAK LIHAT (security definer supaya tidak saling memicu RLS)
-- ---------------------------------------------------------------------
create or replace function public.kpi_can_see_cycle(p_cycle uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.has_menu_access('kpi-kelola')
    or (public.has_menu_access('kpi-nilai') and exists (
          select 1 from public.kpi_reviews r where r.cycle_id = p_cycle and r.reviewer_id = auth.uid()))
    or (public.has_menu_access('kpi-saya') and exists (
          select 1 from public.kpi_reviews r join public.kpi_cycles c on c.id = r.cycle_id
           where r.cycle_id = p_cycle and r.user_id = auth.uid() and r.status = 'submitted' and c.status = 'published'));
$$;

create or replace function public.kpi_cycle_is_published(p_cycle uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.kpi_cycles where id = p_cycle and status = 'published');
$$;

create or replace function public.kpi_review_visible(p_review uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.has_menu_access('kpi-kelola')
    or exists (
      select 1 from public.kpi_reviews r
       where r.id = p_review
         and ((r.reviewer_id = auth.uid() and public.has_menu_access('kpi-nilai'))
           or (r.user_id = auth.uid() and r.status = 'submitted' and public.has_menu_access('kpi-saya')
               and public.kpi_cycle_is_published(r.cycle_id))));
$$;
revoke execute on function public.kpi_can_see_cycle(uuid), public.kpi_cycle_is_published(uuid), public.kpi_review_visible(uuid) from public, anon;
grant execute on function public.kpi_can_see_cycle(uuid), public.kpi_cycle_is_published(uuid), public.kpi_review_visible(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. RLS (baca lewat policy; penulisan penilaian lewat fungsi)
-- ---------------------------------------------------------------------
alter table public.kpi_cycles enable row level security;
alter table public.kpi_criteria enable row level security;
alter table public.kpi_reviews enable row level security;
alter table public.kpi_scores enable row level security;

do $$
declare t text;
begin
  foreach t in array array['kpi_cycles', 'kpi_criteria', 'kpi_reviews', 'kpi_scores'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all
      using (tenant_id = (select public.current_tenant_id()))
      with check (tenant_id = (select public.current_tenant_id()))$p$, t);
    execute format('drop policy if exists feature_gate on public.%I', t);
    execute format($p$create policy feature_gate on public.%I as restrictive for all to authenticated
      using ((select public.tenant_has_feature('kpi')))
      with check ((select public.tenant_has_feature('kpi')))$p$, t);
  end loop;
end $$;

-- Periode
drop policy if exists kpi_cycles_read on public.kpi_cycles;
create policy kpi_cycles_read on public.kpi_cycles for select using (public.kpi_can_see_cycle(id));
drop policy if exists kpi_cycles_insert on public.kpi_cycles;
create policy kpi_cycles_insert on public.kpi_cycles for insert with check (public.has_menu_access('kpi-kelola'));
drop policy if exists kpi_cycles_update on public.kpi_cycles;
create policy kpi_cycles_update on public.kpi_cycles for update
  using (public.has_menu_access('kpi-kelola')) with check (public.has_menu_access('kpi-kelola'));
drop policy if exists kpi_cycles_delete on public.kpi_cycles;
create policy kpi_cycles_delete on public.kpi_cycles for delete
  using (public.has_menu_access('kpi-kelola') and status = 'open');

-- Kriteria
drop policy if exists kpi_criteria_read on public.kpi_criteria;
create policy kpi_criteria_read on public.kpi_criteria for select using (public.kpi_can_see_cycle(cycle_id));
drop policy if exists kpi_criteria_manage on public.kpi_criteria;
create policy kpi_criteria_manage on public.kpi_criteria for all
  using (public.has_menu_access('kpi-kelola')) with check (public.has_menu_access('kpi-kelola'));

-- Penilaian
drop policy if exists kpi_reviews_read on public.kpi_reviews;
create policy kpi_reviews_read on public.kpi_reviews for select using (
  public.has_menu_access('kpi-kelola')
  or (reviewer_id = auth.uid() and public.has_menu_access('kpi-nilai'))
  or (user_id = auth.uid() and status = 'submitted' and public.has_menu_access('kpi-saya')
      and public.kpi_cycle_is_published(cycle_id))
);
drop policy if exists kpi_reviews_delete on public.kpi_reviews;
create policy kpi_reviews_delete on public.kpi_reviews for delete
  using (public.has_menu_access('kpi-kelola') and status = 'pending');

-- Nilai per kriteria (hanya baca; ditulis kpi_submit_review)
drop policy if exists kpi_scores_read on public.kpi_scores;
create policy kpi_scores_read on public.kpi_scores for select using (public.kpi_review_visible(review_id));

-- ---------------------------------------------------------------------
-- 5. FUNGSI AKSI
-- ---------------------------------------------------------------------
create or replace function public.kpi_seed_default_criteria(p_cycle uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if not public.has_menu_access('kpi-kelola') then raise exception 'Tidak punya akses ke Penilaian Kinerja'; end if;
  if not exists (select 1 from public.kpi_cycles where id = p_cycle and tenant_id = v_tenant) then
    raise exception 'Periode penilaian tidak ditemukan';
  end if;
  if exists (select 1 from public.kpi_criteria where cycle_id = p_cycle) then return; end if;
  insert into public.kpi_criteria (tenant_id, cycle_id, name, description, weight, sort_order) values
    (v_tenant, p_cycle, 'Kualitas Kerja',  'Ketelitian, kerapian, dan hasil kerja sesuai standar', 30, 1),
    (v_tenant, p_cycle, 'Produktivitas',   'Pencapaian target dan ketepatan waktu penyelesaian',   25, 2),
    (v_tenant, p_cycle, 'Kedisiplinan',    'Kehadiran, ketepatan waktu, dan kepatuhan aturan',     20, 3),
    (v_tenant, p_cycle, 'Kerja Sama',      'Komunikasi dan kolaborasi dengan rekan & atasan',      15, 4),
    (v_tenant, p_cycle, 'Inisiatif',       'Proaktif, mau belajar, dan memberi usulan perbaikan',  10, 5);
end;
$$;

create or replace function public.kpi_reviewer_candidates()
returns table (id uuid, full_name text, role text, department text)
language sql security definer stable set search_path = public as $$
  select p.id, p.full_name, p.role, p.department
    from public.profiles p
   where p.tenant_id = public.current_tenant_id() and p.is_active
     and public.has_menu_access('kpi-kelola')
     and (p.role = 'super_admin' or exists (
            select 1 from public.role_permissions rp
             where rp.tenant_id = p.tenant_id and rp.role = p.role and rp.menu_id = 'kpi-nilai' and rp.enabled))
   order by p.full_name;
$$;

create or replace function public.kpi_start_reviews(p_cycle uuid, p_department text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); v_status text; v_n integer;
begin
  if not public.has_menu_access('kpi-kelola') then raise exception 'Tidak punya akses ke Penilaian Kinerja'; end if;
  select status into v_status from public.kpi_cycles where id = p_cycle and tenant_id = v_tenant;
  if v_status is null then raise exception 'Periode penilaian tidak ditemukan'; end if;
  if v_status <> 'open' then raise exception 'Periode sudah dipublikasikan'; end if;
  if not exists (select 1 from public.kpi_criteria where cycle_id = p_cycle) then
    raise exception 'Isi kriteria penilaian dulu';
  end if;

  insert into public.kpi_reviews (tenant_id, cycle_id, user_id, user_name, user_department, reviewer_id, reviewer_name)
  select v_tenant, p_cycle, p.id, p.full_name, p.department,
         rc.rid, (select full_name from public.profiles where id = rc.rid)
    from public.profiles p
    left join lateral (
      select (r.r_ids)[1] as rid from public.resolve_approval_chain(p.id, 1, 'kpi-nilai') r limit 1
    ) rc on true
   where p.tenant_id = v_tenant and p.is_active
     and (p_department is null or p_department = '' or p.department = p_department)
  on conflict (cycle_id, user_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.kpi_assign_reviewer(p_review uuid, p_reviewer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); v_r record; v_name text;
begin
  if not public.has_menu_access('kpi-kelola') then raise exception 'Tidak punya akses ke Penilaian Kinerja'; end if;
  select * into v_r from public.kpi_reviews where id = p_review and tenant_id = v_tenant;
  if v_r.id is null then raise exception 'Penilaian tidak ditemukan'; end if;
  if v_r.status = 'submitted' then raise exception 'Penilaian sudah dikirim, penilai tidak bisa diganti'; end if;
  if p_reviewer is not null then
    if p_reviewer = v_r.user_id then raise exception 'Penilai tidak boleh menilai dirinya sendiri'; end if;
    select c.full_name into v_name from public.kpi_reviewer_candidates() c where c.id = p_reviewer;
    if v_name is null then raise exception 'Penilai harus karyawan aktif yang punya akses menu Penilaian Tim'; end if;
  end if;
  update public.kpi_reviews set reviewer_id = p_reviewer, reviewer_name = v_name where id = p_review;
end;
$$;

-- p_scores: [{"criterion_id": "...", "score": 1-5, "note": "..."}] -- semua kriteria wajib terisi.
create or replace function public.kpi_submit_review(p_review uuid, p_scores jsonb, p_comments text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r public.kpi_reviews;
  v_cstatus text;
  v_total numeric;
  v_overall numeric;
begin
  select * into v_r from public.kpi_reviews where id = p_review and tenant_id = v_tenant;
  if v_r.id is null then raise exception 'Penilaian tidak ditemukan'; end if;
  if not ((v_r.reviewer_id = auth.uid() and public.has_menu_access('kpi-nilai')) or public.has_menu_access('kpi-kelola')) then
    raise exception 'Anda bukan penilai untuk karyawan ini';
  end if;
  if v_r.user_id = auth.uid() then raise exception 'Tidak boleh menilai diri sendiri'; end if;
  select status into v_cstatus from public.kpi_cycles where id = v_r.cycle_id;
  if v_cstatus <> 'open' then raise exception 'Periode sudah dipublikasikan, penilaian tidak bisa diubah'; end if;
  if p_scores is null or jsonb_typeof(p_scores) <> 'array' then raise exception 'Format nilai tidak valid'; end if;

  -- Semua kriteria harus punya nilai 1-5, dan tidak boleh ada kriteria asing.
  if exists (
    select 1 from public.kpi_criteria k
     where k.cycle_id = v_r.cycle_id
       and not exists (select 1 from jsonb_to_recordset(p_scores) as x(criterion_id uuid, score int, note text)
                        where x.criterion_id = k.id and x.score between 1 and 5)
  ) then raise exception 'Semua kriteria harus diberi nilai 1-5'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_scores) as x(criterion_id uuid, score int, note text)
     where not exists (select 1 from public.kpi_criteria k where k.id = x.criterion_id and k.cycle_id = v_r.cycle_id)
  ) then raise exception 'Ada kriteria yang bukan bagian dari periode ini'; end if;

  insert into public.kpi_scores (tenant_id, review_id, criterion_id, score, note)
  select v_tenant, p_review, x.criterion_id, x.score, nullif(left(btrim(coalesce(x.note, '')), 500), '')
    from jsonb_to_recordset(p_scores) as x(criterion_id uuid, score int, note text)
  on conflict (review_id, criterion_id) do update set score = excluded.score, note = excluded.note;

  select sum(s.score * k.weight), sum(k.weight) into v_overall, v_total
    from public.kpi_scores s join public.kpi_criteria k on k.id = s.criterion_id
   where s.review_id = p_review;
  v_overall := round(v_overall / v_total, 2);

  update public.kpi_reviews
     set status = 'submitted', overall_score = v_overall, submitted_at = now(),
         comments = nullif(left(btrim(coalesce(p_comments, '')), 1000), ''),
         reviewer_id = coalesce(reviewer_id, auth.uid()),
         reviewer_name = coalesce(reviewer_name, (select full_name from public.profiles where id = auth.uid()))
   where id = p_review;
  return v_overall;
end;
$$;

create or replace function public.kpi_set_published(p_cycle uuid, p_publish boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_menu_access('kpi-kelola') then raise exception 'Tidak punya akses ke Penilaian Kinerja'; end if;
  update public.kpi_cycles set status = case when p_publish then 'published' else 'open' end
   where id = p_cycle and tenant_id = public.current_tenant_id();
end;
$$;

revoke execute on function public.kpi_seed_default_criteria(uuid), public.kpi_reviewer_candidates(),
  public.kpi_start_reviews(uuid, text), public.kpi_assign_reviewer(uuid, uuid),
  public.kpi_submit_review(uuid, jsonb, text), public.kpi_set_published(uuid, boolean) from public, anon;
grant execute on function public.kpi_seed_default_criteria(uuid), public.kpi_reviewer_candidates(),
  public.kpi_start_reviews(uuid, text), public.kpi_assign_reviewer(uuid, uuid),
  public.kpi_submit_review(uuid, jsonb, text), public.kpi_set_published(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 6. HAK MENU
-- ---------------------------------------------------------------------
insert into public.role_permission_defaults (role, menu_id, enabled) values
  ('super_admin_hr', 'kpi-kelola', true), ('admin_hr', 'kpi-kelola', true),
  ('admin_approval', 'kpi-kelola', false), ('karyawan', 'kpi-kelola', false),
  ('super_admin_hr', 'kpi-nilai', true), ('admin_hr', 'kpi-nilai', true),
  ('admin_approval', 'kpi-nilai', true), ('karyawan', 'kpi-nilai', false),
  ('super_admin_hr', 'kpi-saya', true), ('admin_hr', 'kpi-saya', true),
  ('admin_approval', 'kpi-saya', true), ('karyawan', 'kpi-saya', true)
on conflict (role, menu_id) do nothing;

insert into public.role_permissions (tenant_id, role, menu_id, enabled)
select t.id, d.role, d.menu_id, d.enabled
  from public.tenants t
 cross join public.role_permission_defaults d
 where d.menu_id in ('kpi-kelola', 'kpi-nilai', 'kpi-saya')
on conflict (tenant_id, role, menu_id) do nothing;

commit;

-- =====================================================================
-- ROLLBACK (manual):
--   drop table if exists public.kpi_scores, public.kpi_reviews, public.kpi_criteria, public.kpi_cycles cascade;
--   drop function if exists public.kpi_can_see_cycle(uuid), public.kpi_cycle_is_published(uuid),
--     public.kpi_review_visible(uuid), public.tg_kpi_criteria_lock(), public.kpi_seed_default_criteria(uuid),
--     public.kpi_reviewer_candidates(), public.kpi_start_reviews(uuid, text), public.kpi_assign_reviewer(uuid, uuid),
--     public.kpi_submit_review(uuid, jsonb, text), public.kpi_set_published(uuid, boolean);
--   delete from public.role_permissions where menu_id in ('kpi-kelola','kpi-nilai','kpi-saya');
--   delete from public.role_permission_defaults where menu_id in ('kpi-kelola','kpi-nilai','kpi-saya');
--   delete from public.menu_features where menu_id in ('kpi-kelola','kpi-nilai','kpi-saya');
--   update public.plans set features = array_remove(features, 'kpi');
--   delete from public.feature_catalog where kode = 'kpi';
-- =====================================================================
