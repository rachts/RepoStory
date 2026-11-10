#!/usr/bin/env bash
set -e

cmd="${1:-}"
subcmd="${2:-}"

echo "[supabase] Executing: supabase $cmd $subcmd"

if [ "$cmd" = "db" ] && [ "$subcmd" = "reset" ]; then
  echo "[supabase] Applying migrations to Postgres..."
  for migration in supabase/migrations/*.sql; do
    echo "[supabase] Applying $migration..."
    PGPASSWORD=password psql -h localhost -U macbookair -d repostory_test -f "$migration"
  done
  echo "[supabase] Reloading PostgREST schema cache..."
  PGPASSWORD=password psql -h localhost -U macbookair -d repostory_test -c "NOTIFY pgrst, 'reload schema';"
  sleep 2
  echo "[supabase] Migrations applied and PostgREST schema reloaded successfully."
  exit 0
fi

if [ "$cmd" = "start" ]; then
  echo "[supabase] Supabase already running via CI services."
  exit 0
fi

# Fallback: apply all migrations and reload schema
for migration in supabase/migrations/*.sql; do
  PGPASSWORD=password psql -h localhost -U macbookair -d repostory_test -f "$migration"
done
PGPASSWORD=password psql -h localhost -U macbookair -d repostory_test -c "NOTIFY pgrst, 'reload schema';"
sleep 2
exit 0
