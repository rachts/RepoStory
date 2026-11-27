-- Migration 005: Add heartbeat_at to repo_story_jobs for stuck-job recovery
alter table if exists public.repo_story_jobs
  add column if not exists heartbeat_at timestamptz;

create index if not exists repo_story_jobs_heartbeat_idx
  on public.repo_story_jobs (status, heartbeat_at);
