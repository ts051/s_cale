create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  week_start integer not null default 1 check (week_start in (0, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.labels (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  color text not null,
  is_shared boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  start_time text not null,
  end_time text not null,
  is_shared boolean not null default false,
  is_all_day boolean not null default true,
  label_id bigint references public.labels(id) on delete set null,
  recurrence text check (recurrence in ('weekly', 'monthly', 'yearly') or recurrence is null),
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.labels enable row level security;
alter table public.events enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "labels_select_visible" on public.labels;
create policy "labels_select_visible"
on public.labels for select
to authenticated
using (is_shared = true or owner_id = auth.uid());

drop policy if exists "labels_insert_visible_scope" on public.labels;
create policy "labels_insert_visible_scope"
on public.labels for insert
to authenticated
with check (is_shared = true or owner_id = auth.uid());

drop policy if exists "labels_update_visible_scope" on public.labels;
create policy "labels_update_visible_scope"
on public.labels for update
to authenticated
using (is_shared = true or owner_id = auth.uid())
with check (is_shared = true or owner_id = auth.uid());

drop policy if exists "labels_delete_visible_scope" on public.labels;
create policy "labels_delete_visible_scope"
on public.labels for delete
to authenticated
using (is_shared = true or owner_id = auth.uid());

drop policy if exists "events_select_visible" on public.events;
create policy "events_select_visible"
on public.events for select
to authenticated
using (is_shared = true or owner_id = auth.uid());

drop policy if exists "events_insert_own" on public.events;
create policy "events_insert_own"
on public.events for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "events_update_visible" on public.events;
create policy "events_update_visible"
on public.events for update
to authenticated
using (is_shared = true or owner_id = auth.uid())
with check (is_shared = true or owner_id = auth.uid());

drop policy if exists "events_delete_visible" on public.events;
create policy "events_delete_visible"
on public.events for delete
to authenticated
using (is_shared = true or owner_id = auth.uid());
