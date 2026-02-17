-- KMN Chat Builder persistence schema
create table if not exists public.builder_states (
  bot text primary key,
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_memory (
  user_id text primary key,
  memory_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  user_id text not null,
  session_id text not null,
  node_id text,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.builder_states enable row level security;
alter table public.user_memory enable row level security;
alter table public.analytics_events enable row level security;

-- Demo policy: open access for anon (for personal project).
-- For production, restrict by auth.uid() / owner column.
drop policy if exists "builder_states_open_select" on public.builder_states;
create policy "builder_states_open_select"
on public.builder_states for select
using (true);

drop policy if exists "builder_states_open_insert" on public.builder_states;
create policy "builder_states_open_insert"
on public.builder_states for insert
with check (true);

drop policy if exists "builder_states_open_update" on public.builder_states;
create policy "builder_states_open_update"
on public.builder_states for update
using (true)
with check (true);

drop policy if exists "user_memory_open_select" on public.user_memory;
create policy "user_memory_open_select"
on public.user_memory for select
using (true);

drop policy if exists "user_memory_open_insert" on public.user_memory;
create policy "user_memory_open_insert"
on public.user_memory for insert
with check (true);

drop policy if exists "user_memory_open_update" on public.user_memory;
create policy "user_memory_open_update"
on public.user_memory for update
using (true)
with check (true);

drop policy if exists "analytics_events_open_select" on public.analytics_events;
create policy "analytics_events_open_select"
on public.analytics_events for select
using (true);

drop policy if exists "analytics_events_open_insert" on public.analytics_events;
create policy "analytics_events_open_insert"
on public.analytics_events for insert
with check (true);
