# Database Verification Report: PostgreSQL 16 Migrations, FOR UPDATE SKIP LOCKED & RLS

This report details the execution and verification of database migrations, concurrent worker job claiming with `FOR UPDATE SKIP LOCKED`, heartbeat expiry reclaim, and Row-Level Security (RLS) tenant isolation on a real PostgreSQL 16 instance.

## 1. Environment & Connection Setup

- **Database Engine**: PostgreSQL 16.15 (Homebrew / aarch64-apple-darwin25.6.0)
- **Database Name**: `repostory_test`
- **Host / Port**: `localhost:5432`
- **Sanitized Connection String**: `postgresql://app_user:REDACTED@localhost:5432/repostory_test`
- **Auth Schema Compatibility**: Provided standard `auth.uid()` function mapping to JWT claims (`request.jwt.claim.sub` or `request.jwt.claims->>'sub'`) for local Supabase-compatible RLS evaluation.

## 2. Migration Execution (001 - 005)

All migration files in `supabase/migrations/` were applied in sequential order using `psql`:

```bash
# Apply migrations sequentially
psql -d repostory_test -f supabase/migrations/001_repo_story.sql
psql -d repostory_test -f supabase/migrations/002_job_queue.sql
psql -d repostory_test -f supabase/migrations/003_auth_and_rls.sql
psql -d repostory_test -f supabase/migrations/004_cache_store.sql
psql -d repostory_test -f supabase/migrations/005_organizations_and_rbac.sql
```

### Migration Output Summary
- `001_repo_story.sql`: Created `repo_story_jobs`, `repo_story_results`, `repo_story_explanations`, `repo_story_diagrams`, and associated indexes. Enabled RLS.
- `002_job_queue.sql`: Created `repo_story_job_queue`, status indexes, and atomic `claim_queue_job(p_worker_id, p_timeout_seconds)` PL/pgSQL function utilizing `FOR UPDATE SKIP LOCKED`.
- `003_auth_and_rls.sql`: Created RLS policies for `repo_story_jobs`, `repo_story_results`, `repo_story_diagrams`, and `repo_story_explanations` keyed on `owner_id = auth.uid()::text`.
- `004_cache_store.sql`: Created `repo_story_cache` table and expiry indexes.
- `005_organizations_and_rbac.sql`: Created `organizations`, `org_role` enum, `organization_memberships`, linked `org_id` foreign keys, and installed non-recursive `SECURITY DEFINER` access functions (`public.is_org_member`, `public.is_org_admin`) and RLS policies.

Verified relations:
```text
 Schema |           Name           | Type  |   Owner    
--------+--------------------------+-------+------------
 public | organization_memberships | table | repostory
 public | organizations            | table | repostory
 public | repo_story_cache         | table | repostory
 public | repo_story_diagrams      | table | repostory
 public | repo_story_explanations  | table | repostory
 public | repo_story_job_queue     | table | repostory
 public | repo_story_jobs          | table | repostory
 public | repo_story_results       | table | repostory
```

---

## 3. High-Contention Barrier Tests (PostgreSQL 16)

The contention harness (`scripts/verify-contention.sh`) executes two high-contention test scenarios with atomic `claim_queue_job` via `FOR UPDATE SKIP LOCKED`.

### Test 1: 1 Single Job, 10 Concurrent Workers Behind Synchronized Barrier
- **Setup**: 10 distinct worker processes are spawned and wait on a synchronized filesystem barrier. Upon barrier release, all 10 workers simultaneously fire `claim_queue_job('worker-' || w, 120)` to claim the single available job.
- **Audit Verification**:
```text
Test 1 Claims Recorded in claim_audit_log:
worker-2|job-single-contention|2026-11-09 21:56:56.170203+05:30

Duplicate Check Query:
SELECT job_id, count(*) FROM public.claim_audit_log GROUP BY job_id HAVING count(*) > 1;
Zero duplicate rows returned (GROUP BY job_id HAVING count(*) > 1 is empty).
Total claims for 1 job: 1 (expected: 1)
```

### Test 2: 50 Queued Jobs, 5 Concurrent Worker Processes
- **Setup**: 50 queued jobs inserted into `repo_story_job_queue`. 5 worker processes execute claims concurrently until the queue is completely drained.
- **Audit Verification**:
```text
Total claims recorded for 50 jobs: 50
Total distinct jobs claimed: 50
Claims per worker distribution:
worker-1: 10
worker-2: 10
worker-3: 10
worker-4: 10
worker-5: 10

Duplicate Check Query:
SELECT job_id, count(*) FROM public.claim_audit_log GROUP BY job_id HAVING count(*) > 1;
Zero duplicate rows returned (GROUP BY job_id HAVING count(*) > 1 is empty).

Maximum attempts across all 50 jobs: 1 (expected: 1)
```

**Verification Result**: In both extreme contention scenarios, zero double-claims occurred, zero deadlocks occurred, and all jobs completed with exactly `attempts = 1`.

---

## 4. Heartbeat Expiry & Reclaim Test

### Test Description
Simulated a crashed worker by advancing a running job's heartbeat back past the timeout threshold:
```sql
UPDATE repo_story_job_queue 
SET heartbeat_at = NOW() - INTERVAL '300 seconds'
WHERE job_id = 'job-1';
```

### Claim Execution
```sql
SELECT job_id, worker_id, attempts, status FROM claim_queue_job('worker-reclaimer', 120);
```

### Actual Output
```text
 job_id |    worker_id     | attempts | status  
--------+------------------+----------+---------
 job-1  | worker-reclaimer |        2 | running
(1 row)
```

**Verification Result:** The expired job was successfully reclaimed by `worker-reclaimer`, `attempts` incremented from 1 to 2, and the job status was maintained as `running`.

---

## 5. Row-Level Security (RLS) Verification

A non-superuser role `repostory_test_user` was created without table ownership to evaluate RLS policy enforcement.

### Test A: Read and Update Isolation on `repo_story_jobs`
```sql
-- Step 1: Set identity as user-A
SET request.jwt.claims = '{"sub": "user-A"}';
INSERT INTO repo_story_jobs (job_id, analysis_id, repository_url, branch, owner_id, cache_key, status, stage, progress, message, created_at, updated_at, expires_at, retry_count)
VALUES ('job-user-A', 'analysis-A', 'https://github.com/octocat/Hello-World', 'main', 'user-A', 'cache-A', 'queued', 'queued', 0, 'queued', now(), now(), now() + interval '1 day', 0);

SELECT job_id, owner_id, status FROM repo_story_jobs;
-- Output:
--    job_id   | owner_id | status 
-- ------------+----------+--------
--  job-user-A | user-A   | queued
-- (1 row)

-- Step 2: Switch identity to user-B
SET request.jwt.claims = '{"sub": "user-B"}';

-- Query as user-B
SELECT job_id, owner_id, status FROM repo_story_jobs;
-- Output:
-- (0 rows) -- Successfully isolated

-- Attempt to update user-A's job as user-B
UPDATE repo_story_jobs SET message = 'tampered by B' WHERE job_id = 'job-user-A';
-- Output:
-- UPDATE 0 -- Cannot modify another user's job
```

### Test B: RLS Check Violation on Spoofed Insert
```sql
SET request.jwt.claims = '{"sub": "user-B"}';

INSERT INTO repo_story_jobs (job_id, analysis_id, repository_url, branch, owner_id, cache_key, status, stage, progress, message, created_at, updated_at, expires_at, retry_count)
VALUES ('job-fraud', 'analysis-fraud', 'https://github.com/octocat/Hello-World', 'main', 'user-A', 'cache-fraud', 'queued', 'queued', 0, 'queued', now(), now(), now() + interval '1 day', 0);
```

### Actual Output
```text
ERROR: new row violates row-level security policy for table "repo_story_jobs"
```

### Test C: Organization Multi-Tenant RBAC Isolation
```sql
-- Query organizations under user-A claims (member of org-1 Acme Corp)
SET request.jwt.claims = '{"sub": "user-A"}';
SELECT id, name FROM organizations;
-- Output:
--   id   |   name    
-- -------+-----------
--  org-1 | Acme Corp
-- (1 row)

-- Query organizations under user-B claims (member of org-2 Beta LLC)
SET request.jwt.claims = '{"sub": "user-B"}';
SELECT id, name FROM organizations;
-- Output:
--   id   |   name   
-- -------+----------
--  org-2 | Beta LLC
-- (1 row)
```

**Verification Result:** RLS strictly isolates rows between tenants, prevents cross-user reads and updates, and rejects unauthorized inserts.
