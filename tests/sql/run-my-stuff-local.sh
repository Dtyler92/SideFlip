#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_my_stuff_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f /tmp/${DB}_*.log
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-fixture.sql"
"${PSQL[@]}" < "$MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-assertions.sql"

# Two real database sessions race Free-account creation. Exactly one may commit.
run_create() {
  local mutation="$1" log="$2"
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB" >"$log" 2>&1 <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
select public.create_my_stuff_item('$mutation','other',null,null,0,0,'$mutation');
SQL
}
run_create concurrency-1 "/tmp/${DB}_concurrency_1.log" & p1=$!
run_create concurrency-2 "/tmp/${DB}_concurrency_2.log" & p2=$!
set +e
wait "$p1"; s1=$?
wait "$p2"; s2=$?
set -e

if [[ "$s1" -eq 0 && "$s2" -eq 0 ]]; then
  printf 'both concurrent Free creates unexpectedly succeeded\n' >&2
  exit 1
fi
if [[ "$s1" -ne 0 && "$s2" -ne 0 ]]; then
  printf 'both concurrent Free creates failed\n' >&2
  cat "/tmp/${DB}_concurrency_1.log" "/tmp/${DB}_concurrency_2.log" >&2
  exit 1
fi
count="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from public.my_stuff_items where user_id='55555555-5555-4555-8555-555555555555'")"
if [[ "$count" != "1" ]]; then
  printf 'expected one concurrent item, got %s\n' "$count" >&2
  exit 1
fi

# Same-key concurrent item retries must both succeed and resolve one row.
run_same_item() {
  local log="$1"
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq "$DB" >"$log" 2>&1 <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',false) as claim \gset
select public.create_my_stuff_item('same retry','other',null,null,0,0,'same-item-key');
SQL
}
run_same_item "/tmp/${DB}_same_item_1.log" & p1=$!
run_same_item "/tmp/${DB}_same_item_2.log" & p2=$!
wait "$p1"; wait "$p2"
same_count="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from public.my_stuff_items where user_id='66666666-6666-4666-8666-666666666666' and client_mutation_id='same-item-key'")"
same_ids="$(cat "/tmp/${DB}_same_item_1.log" "/tmp/${DB}_same_item_2.log" | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l)"
if [[ "$same_count" != "1" || "$same_ids" != "1" ]]; then
  printf 'same-key concurrent item retry was not idempotent\n' >&2
  exit 1
fi

# Same-key concurrent schedule creation must resolve one schedule.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false);
select public.create_my_stuff_item('maintenance race','equipment',null,null,0,0,'maintenance-race-item');
SQL
item_id="$(sudo -u postgres psql -X -Atq "$DB" -c "select id from public.my_stuff_items where user_id='77777777-7777-4777-8777-777777777777' and client_mutation_id='maintenance-race-item'")"
run_same_schedule() {
  local log="$1"
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq "$DB" >"$log" 2>&1 <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false) as claim \gset
select public.create_my_stuff_schedule('$item_id','Race schedule','mileage',100,null,0,'same-schedule-key');
SQL
}
run_same_schedule "/tmp/${DB}_same_schedule_1.log" & p1=$!
run_same_schedule "/tmp/${DB}_same_schedule_2.log" & p2=$!
wait "$p1"; wait "$p2"
schedule_count="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from public.my_stuff_schedules where user_id='77777777-7777-4777-8777-777777777777' and client_mutation_id='same-schedule-key'")"
schedule_ids="$(cat "/tmp/${DB}_same_schedule_1.log" "/tmp/${DB}_same_schedule_2.log" | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l)"
if [[ "$schedule_count" != "1" || "$schedule_ids" != "1" ]]; then
  printf 'same-key concurrent schedule retry was not idempotent\n' >&2
  exit 1
fi
schedule_id="$(sudo -u postgres psql -X -Atq "$DB" -c "select id from public.my_stuff_schedules where user_id='77777777-7777-4777-8777-777777777777' and client_mutation_id='same-schedule-key'")"

# Same-key concurrent maintenance completion must not double-advance.
run_same_maintenance() {
  local log="$1"
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq "$DB" >"$log" 2>&1 <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false) as claim \gset
select public.complete_my_stuff_maintenance('$schedule_id','2026-08-24T12:00:00Z',100,0,null,'same-maintenance-key');
SQL
}
run_same_maintenance "/tmp/${DB}_same_maintenance_1.log" & p1=$!
run_same_maintenance "/tmp/${DB}_same_maintenance_2.log" & p2=$!
wait "$p1"; wait "$p2"
maintenance_state="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*)||':'||(select next_due_value from public.my_stuff_schedules where id='$schedule_id') from public.my_stuff_service_logs where user_id='77777777-7777-4777-8777-777777777777' and client_mutation_id='same-maintenance-key'")"
maintenance_ids="$(cat "/tmp/${DB}_same_maintenance_1.log" "/tmp/${DB}_same_maintenance_2.log" | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l)"
if [[ "$maintenance_state" != "1:200" || "$maintenance_ids" != "1" ]]; then
  printf 'same-key concurrent maintenance retry was not idempotent: %s\n' "$maintenance_state" >&2
  exit 1
fi

printf 'PostgreSQL My Stuff migration behavior passed (Free quota and idempotency races included)\n'
