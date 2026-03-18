-- Recipe Cloud: recipes table
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  title text not null default '',
  description text not null default '',
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  estimated_time text not null default '',
  servings text not null default '',
  source_urls jsonb not null default '[]',
  source_platforms jsonb not null default '[]',
  raw_text text,
  created_at timestamptz not null default now()
);

-- Allow anonymous read/write for MVP (tighten with RLS when auth is required)
alter table public.recipes enable row level security;

create policy "Allow all for now"
  on public.recipes
  for all
  using (true)
  with check (true);

-- Index for listing by user and time
create index if not exists recipes_user_created_idx on public.recipes (user_id, created_at desc);
