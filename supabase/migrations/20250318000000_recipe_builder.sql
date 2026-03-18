-- Recipe Builder: drafts + dashboard sorting
alter table public.recipes
  add column if not exists needs_user_input boolean not null default false;

alter table public.recipes
  add column if not exists updated_at timestamptz not null default now();

update public.recipes set updated_at = created_at where updated_at is null;

create index if not exists recipes_updated_at_idx on public.recipes (updated_at desc);
