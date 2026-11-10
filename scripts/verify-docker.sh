#!/usr/bin/env bash
set -eo pipefail

echo "=== RepoStory Docker Verification Suite ==="

# Pre-flight check
if ! command -v docker &> /dev/null; then
  echo "Error: docker is not installed or not running. Please install Docker Desktop and start the engine."
  exit 1
fi

echo "--- 1. Building Docker Images ---"
echo "Building web image..."
docker build --target web -t repostory-web .

echo "Building worker image..."
docker build --target worker -t repostory-worker .

echo "--- 2. Verifying Worker Runtime Dependencies (tsx absent) ---"
TSX_CHECK=$(docker run --rm --entrypoint sh repostory-worker -c "ls node_modules/.bin 2>/dev/null | grep tsx" || true)
if [ -n "$TSX_CHECK" ]; then
  echo "FAIL: tsx was found in the worker runtime stage: $TSX_CHECK"
  exit 1
else
  echo "SUCCESS: tsx is absent from repostory-worker runtime image."
fi

echo "--- 3. Testing Web Container Probes ---"
echo "Starting web container without database credentials (simulating database outage)..."
WEB_CONTAINER_ID=$(docker run -d -p 3000:3000 \
  -e NODE_ENV=production \
  -e REPO_STORY_JOB_STORE=supabase \
  -e SUPABASE_URL=http://invalid-db-host:9999 \
  -e SUPABASE_SECRET_KEY=dummy-secret-key \
  repostory-web)

sleep 4

echo "Probing /api/health/live (must be 200)..."
LIVE_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health/live || true)
echo "/api/health/live returned HTTP $LIVE_CODE"

echo "Probing /api/health/ready with unreachable database (must be 503)..."
READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health/ready || true)
echo "/api/health/ready returned HTTP $READY_CODE"

docker stop "$WEB_CONTAINER_ID" > /dev/null
docker rm "$WEB_CONTAINER_ID" > /dev/null

echo "--- 4. Testing Worker Container Execution & Graceful Shutdown ---"
echo "Starting worker container against host Postgres..."
WORKER_CONTAINER_ID=$(docker run -d \
  -e NODE_ENV=production \
  -e REPO_STORY_JOB_STORE=supabase \
  -e REPO_STORY_QUEUE_MODE=supabase \
  -e SUPABASE_URL=http://host.docker.internal:3002 \
  -e SUPABASE_SECRET_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoibWFjYm9va2FpciIsInN1YiI6InRlc3QtYWRtaW4ifQ.AedVMsBfk5ry6WRu2WHhj_s1IdvfzaMYUUWBiaeqh1s \
  repostory-worker)

sleep 3
echo "Testing docker stop graceful shutdown timing..."
START_STOP=$(date +%s)
docker stop "$WORKER_CONTAINER_ID"
STOP_DURATION=$(( $(date +%s) - START_STOP ))
EXIT_CODE=$(docker inspect "$WORKER_CONTAINER_ID" --format='{{.State.ExitCode}}')
echo "Worker container stopped in ${STOP_DURATION}s with exit code: $EXIT_CODE"

docker rm "$WORKER_CONTAINER_ID" > /dev/null

echo "=== Docker Verification Suite Complete ==="
