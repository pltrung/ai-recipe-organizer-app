-- Tips + grouped ingredients (core / optional) stored as jsonb
alter table public.recipes
  add column if not exists tips jsonb not null default '[]';

-- Existing flat ingredient arrays remain valid; app reads both shapes
