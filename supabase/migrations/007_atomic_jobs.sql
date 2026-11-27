-- Migration 007: Atomic Job Creation Unique Index
-- Prevents duplicate concurrent analysis jobs for the same owner and cache key

create unique index if not exists repo_story_jobs_active_unique_idx
  on public.repo_story_jobs (owner_id, cache_key)
  where status in ('queued', 'fetching', 'analyzing', 'explaining');
