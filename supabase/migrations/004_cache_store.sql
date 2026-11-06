-- Migration 004: Cache Store for Trees and File Contents
create table if not exists public.repo_story_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists repo_story_cache_expires_idx on public.repo_story_cache (expires_at);

alter table public.repo_story_cache enable row level security;
