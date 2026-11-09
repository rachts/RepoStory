#!/usr/bin/env bash
set -eo pipefail

PSQL="/opt/homebrew/opt/postgresql@16/bin/psql -d repostory_test -qtAX"

echo "=== Real Contention Verification Suite (PostgreSQL 16) ==="

# Create audit log table to track all claim events
$PSQL -c "
CREATE TABLE IF NOT EXISTS public.claim_audit_log (
  id serial primary key,
  worker_id text not null,
  job_id text not null,
  claimed_at timestamptz default now()
);
"

# ------------------------------------------------------------------------------
# Test 1: 1 Job, 10 Workers behind a synchronized barrier
# ------------------------------------------------------------------------------
echo -e "\n--- Test 1: 1 Single Job, 10 Workers Synchronized Behind Barrier ---"
$PSQL -c "TRUNCATE TABLE public.repo_story_job_queue; TRUNCATE TABLE public.claim_audit_log;"

$PSQL -c "
INSERT INTO public.repo_story_job_queue (id, job_id, status, attempts, max_attempts, available_at, created_at, updated_at)
VALUES ('q-single', 'job-single-contention', 'queued', 0, 3, NOW(), NOW(), NOW());
"

BARRIER_FILE="/tmp/contention_barrier_1"
rm -f "$BARRIER_FILE"

pids=()
for w in $(seq 1 10); do
  (
    # Wait for the barrier release
    while [ ! -f "$BARRIER_FILE" ]; do
      sleep 0.005
    done
    # Simultaneous claim attempt
    res=$($PSQL -c "SELECT job_id FROM claim_queue_job('worker-$w', 120);")
    if [ -n "$res" ]; then
      $PSQL -c "INSERT INTO public.claim_audit_log (worker_id, job_id) VALUES ('worker-$w', '$res');"
    fi
  ) &
  pids+=($!)
done

# Release barrier
touch "$BARRIER_FILE"

for pid in "${pids[@]}"; do
  wait "$pid"
done
rm -f "$BARRIER_FILE"

echo "Test 1 Claims Recorded in claim_audit_log:"
$PSQL -c "SELECT worker_id, job_id, claimed_at FROM public.claim_audit_log;"

echo -e "\nDuplicate Check Query for Test 1:"
DUPS_1=$($PSQL -c "SELECT job_id, count(*) FROM public.claim_audit_log GROUP BY job_id HAVING count(*) > 1;")
if [ -n "$DUPS_1" ]; then
  echo "FAIL: Duplicate claims detected in Test 1: $DUPS_1"
  exit 1
else
  echo "Zero duplicate rows returned (GROUP BY job_id HAVING count(*) > 1 is empty)."
fi

TOTAL_CLAIMS_1=$($PSQL -c "SELECT count(*) FROM public.claim_audit_log;")
echo "Total claims for 1 job: $TOTAL_CLAIMS_1 (expected: 1)"
if [ "$TOTAL_CLAIMS_1" -ne 1 ]; then
  echo "FAIL: Expected exactly 1 claim, got $TOTAL_CLAIMS_1"
  exit 1
fi

# ------------------------------------------------------------------------------
# Test 2: 50 Jobs, 5 Workers
# ------------------------------------------------------------------------------
echo -e "\n--- Test 2: 50 Jobs, 5 Concurrent Workers ---"
$PSQL -c "TRUNCATE TABLE public.repo_story_job_queue; TRUNCATE TABLE public.claim_audit_log;"

echo "Inserting 50 queued jobs..."
$PSQL -c "
INSERT INTO public.repo_story_job_queue (id, job_id, status, attempts, max_attempts, available_at, created_at, updated_at)
SELECT 'q-' || g, 'job-' || g, 'queued', 0, 3, NOW(), NOW(), NOW()
FROM generate_series(1, 50) AS g;
"

BARRIER_FILE_2="/tmp/contention_barrier_2"
rm -f "$BARRIER_FILE_2"

pids_2=()
for w in $(seq 1 5); do
  (
    while [ ! -f "$BARRIER_FILE_2" ]; do
      sleep 0.005
    done
    while true; do
      res=$($PSQL -c "SELECT job_id FROM claim_queue_job('worker-$w', 120);")
      if [ -n "$res" ]; then
        $PSQL -c "INSERT INTO public.claim_audit_log (worker_id, job_id) VALUES ('worker-$w', '$res');"
      else
        break
      fi
    done
  ) &
  pids_2+=($!)
done

touch "$BARRIER_FILE_2"

for pid in "${pids_2[@]}"; do
  wait "$pid"
done
rm -f "$BARRIER_FILE_2"

echo "Total claims recorded for 50 jobs:"
$PSQL -c "SELECT count(*) FROM public.claim_audit_log;"

echo "Total distinct jobs claimed:"
$PSQL -c "SELECT count(DISTINCT job_id) FROM public.claim_audit_log;"

echo "Claims per worker distribution:"
$PSQL -c "SELECT worker_id, count(*) FROM public.claim_audit_log GROUP BY worker_id ORDER BY worker_id;"

echo -e "\nDuplicate Check Query for Test 2:"
echo "SELECT job_id, count(*) FROM public.claim_audit_log GROUP BY job_id HAVING count(*) > 1;"
DUPS_2=$($PSQL -c "SELECT job_id, count(*) FROM public.claim_audit_log GROUP BY job_id HAVING count(*) > 1;")
if [ -n "$DUPS_2" ]; then
  echo "FAIL: Duplicate claims detected in Test 2: $DUPS_2"
  exit 1
else
  echo "Zero duplicate rows returned (GROUP BY job_id HAVING count(*) > 1 is empty)."
fi

echo -e "\nMax Attempts Verification:"
MAX_ATTEMPTS=$($PSQL -c "SELECT max(attempts) FROM public.repo_story_job_queue;")
echo "Maximum attempts across all 50 jobs: $MAX_ATTEMPTS (expected: 1)"
if [ "$MAX_ATTEMPTS" -ne 1 ]; then
  echo "FAIL: Expected max attempts to be 1, got $MAX_ATTEMPTS"
  exit 1
fi

echo -e "\n=== All Contention Tests Passed Successfully ==="
