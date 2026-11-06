-- Migration 005: Multi-tenant Organizations and RBAC

create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type org_role as enum ('viewer', 'analyst', 'admin');

create table if not exists organization_memberships (
  id text primary key,
  org_id text not null references organizations(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('viewer', 'analyst', 'admin')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

-- Add optional org_id to analysis_jobs and analysis_diagrams
alter table analysis_jobs
  add column if not exists org_id text references organizations(id) on delete cascade;

alter table analysis_diagrams
  add column if not exists org_id text references organizations(id) on delete cascade;

create index if not exists idx_jobs_org_id on analysis_jobs(org_id);
create index if not exists idx_diagrams_org_id on analysis_diagrams(org_id);
create index if not exists idx_org_memberships_user on organization_memberships(user_id);

-- Enable RLS
alter table organizations enable row level security;
alter table organization_memberships enable row level security;

-- Policies for organizations
create policy "Org members can read their organization"
  on organizations for select
  using (
    exists (
      select 1 from organization_memberships
      where organization_memberships.org_id = organizations.id
        and organization_memberships.user_id = auth.uid()::text
    )
  );

-- Policies for organization_memberships
create policy "Org members can view member list"
  on organization_memberships for select
  using (
    exists (
      select 1 from organization_memberships as m
      where m.org_id = organization_memberships.org_id
        and m.user_id = auth.uid()::text
    )
  );

create policy "Org admins can manage memberships"
  on organization_memberships for all
  using (
    exists (
      select 1 from organization_memberships as m
      where m.org_id = organization_memberships.org_id
        and m.user_id = auth.uid()::text
        and m.role = 'admin'
    )
  );
