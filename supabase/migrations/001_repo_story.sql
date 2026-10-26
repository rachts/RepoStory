create table if not exists public.repo_story_jobs (
  job_id text primary key,
  analysis_id text,
  repository_url text not null,
  branch text not null,
  requested_branch text,
  owner_id text not null,
  cache_key text not null,
  status text not null,
  stage text not null,
  progress integer not null,
  message text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  retry_count integer not null,
  explanation_requested boolean not null default false,
  cancellation_requested boolean,
  error jsonb,
  coverage jsonb
);

create index if not exists repo_story_jobs_owner_cache_idx
  on public.repo_story_jobs (owner_id, cache_key, updated_at desc);
create index if not exists repo_story_jobs_expiry_idx
  on public.repo_story_jobs (expires_at);
create index if not exists repo_story_jobs_analysis_idx
  on public.repo_story_jobs (analysis_id);

create table if not exists public.repo_story_results (
  analysis_id text primary key,
  owner_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.repo_story_explanations (
  analysis_id text primary key,
  owner_id text not null,
  explanation jsonb,
  unavailable jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.repo_story_diagrams (
  diagram_id text primary key,
  analysis_id text not null,
  owner_id text not null,
  diagram jsonb not null,
  original_diagram jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists repo_story_diagrams_analysis_idx
  on public.repo_story_diagrams (analysis_id);

alter table public.repo_story_jobs enable row level security;
alter table public.repo_story_results enable row level security;
alter table public.repo_story_explanations enable row level security;
alter table public.repo_story_diagrams enable row level security;

-- The server uses SUPABASE_SECRET_KEY, which bypasses RLS. No public policies
-- are created because repository data and session ownership are server-only.
