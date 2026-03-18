-- Per-source history for full re-synthesis from combined raw corpus
alter table public.recipes
  add column if not exists sources jsonb not null default '[]'::jsonb;

alter table public.recipes
  add column if not exists raw_texts jsonb not null default '[]'::jsonb;

alter table public.recipes
  add column if not exists needs_review boolean not null default false;

comment on column public.recipes.sources is 'Parallel to raw_texts: URL or label per capture';
comment on column public.recipes.raw_texts is 'Raw page text per source; join with --- for AI synthesis';
