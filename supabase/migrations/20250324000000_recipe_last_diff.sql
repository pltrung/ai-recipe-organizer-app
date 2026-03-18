alter table public.recipes
  add column if not exists last_diff jsonb;

alter table public.recipes
  add column if not exists versions jsonb not null default '[]'::jsonb;

comment on column public.recipes.last_diff is 'Latest merge: AI + structured diff vs previous version';
comment on column public.recipes.versions is 'Rolling history of diff summaries (max 10)';
