-- KMN Chat Builder persistence schema
create table if not exists public.builder_states (
  bot text primary key,
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.builder_states enable row level security;

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
