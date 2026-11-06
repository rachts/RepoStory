-- Migration 002: Durable Job Queue with FOR UPDATE SKIP LOCKED
create table if not exists public.repo_story_job_queue (
  id text not null,
  job_id text primary key,
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  worker_id text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz not null default now(),
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists repo_story_job_queue_status_idx
  on public.repo_story_job_queue (status, available_at, heartbeat_at);

-- Atomic job claiming using FOR UPDATE SKIP LOCKED
create or replace function public.claim_queue_job(
  p_worker_id text,
  p_timeout_seconds integer default 120
)
returns setof public.repo_story_job_queue
language plpgsql
security definer
as $$
declare
  v_item public.repo_story_job_queue;
begin
  select * into v_item
  from public.repo_story_job_queue
  where (
    (status = 'queued' and available_at <= now())
    or (status = 'running' and (heartbeat_at is null or heartbeat_at < now() - (p_timeout_seconds || ' seconds')::interval))
  )
  order by available_at asc
  limit 1
  for update skip locked;

  if found then
    update public.repo_story_job_queue
    set status = 'running',
        worker_id = p_worker_id,
        attempts = v_item.attempts + 1,
        locked_at = now(),
        heartbeat_at = now(),
        updated_at = now()
    where job_id = v_item.job_id
    returning * into v_item;

    return next v_item;
  end if;

  return;
end;
$$;

alter table public.repo_story_job_queue enable row level security;
