-- Migration 005: Multi-tenant Organizations and RBAC

create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type org_role as enum ('viewer', 'analyst', 'admin');
  end if;
end $$;

create table if not exists organization_memberships (
  id text primary key,
  org_id text not null references organizations(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('viewer', 'analyst', 'admin')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

-- Add optional org_id to repo_story_jobs and repo_story_diagrams
alter table if exists repo_story_jobs
  add column if not exists org_id text references organizations(id) on delete cascade;

alter table if exists repo_story_diagrams
  add column if not exists org_id text references organizations(id) on delete cascade;

create index if not exists idx_jobs_org_id on repo_story_jobs(org_id);
create index if not exists idx_diagrams_org_id on repo_story_diagrams(org_id);
create index if not exists idx_org_memberships_user on organization_memberships(user_id);

-- Enable RLS
alter table organizations enable row level security;
alter table organization_memberships enable row level security;

-- Helper security definer functions to prevent RLS recursion
create or replace function public.is_org_member(check_org_id text)
returns boolean
language plpgsql
security definer
stable
as $$
begin
  return exists (
    select 1 from public.organization_memberships
    where org_id = check_org_id
      and user_id = auth.uid()::text
  );
end;
$$;

create or replace function public.is_org_admin(check_org_id text)
returns boolean
language plpgsql
security definer
stable
as $$
begin
  return exists (
    select 1 from public.organization_memberships
    where org_id = check_org_id
      and user_id = auth.uid()::text
      and role = 'admin'
  );
end;
$$;

-- Policies for organizations
drop policy if exists "Org members can read their organization" on organizations;
create policy "Org members can read their organization"
  on organizations for select
  using (
    public.is_org_member(id)
  );

-- Policies for organization_memberships
drop policy if exists "Org members can view member list" on organization_memberships;
create policy "Org members can view member list"
  on organization_memberships for select
  using (
    user_id = auth.uid()::text or public.is_org_member(org_id)
  );

drop policy if exists "Org admins can manage memberships" on organization_memberships;
create policy "Org admins can manage memberships"
  on organization_memberships for all
  using (
    public.is_org_admin(org_id)
  );
