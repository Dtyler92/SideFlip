#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_my_stuff_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
V2_MIGRATION="$ROOT/supabase/migrations/20260903220000_add_my_stuff_v2.sql"
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
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v2-preflight.sql"
"${PSQL[@]}" < "$V2_MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v2-assertions.sql"

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

# V2 transfer races: same request converges; different Free projects cannot both win.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB" <<'SQL'
insert into public.projects(id,user_id,title,category) values
('a0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000000','Same transfer','car'),
('b0000000-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000000','Free race one','tool'),
('b0000000-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000000','Free race two','boat');
SQL
run_transfer() {
  local user="$1" project="$2" mutation="$3" log="$4"
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq "$DB" >"$log" 2>&1 <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub','$user',false) as claim \gset
select public.transfer_project_to_my_stuff_v2('$project','{}','$mutation');
SQL
}
run_transfer 'aaaaaaaa-0000-4000-8000-000000000000' 'a0000000-0000-4000-8000-000000000001' 'same-transfer-key' "/tmp/${DB}_same_transfer_1.log" & p1=$!
run_transfer 'aaaaaaaa-0000-4000-8000-000000000000' 'a0000000-0000-4000-8000-000000000001' 'same-transfer-key' "/tmp/${DB}_same_transfer_2.log" & p2=$!
wait "$p1"; wait "$p2"
transfer_count="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from public.my_stuff_project_transfers where user_id='aaaaaaaa-0000-4000-8000-000000000000'")"
transfer_ids="$(grep -h -E '^[0-9a-f-]{36}$' "/tmp/${DB}_same_transfer_1.log" "/tmp/${DB}_same_transfer_2.log" | sort -u | wc -l)"
if [[ "$transfer_count" != "1" || "$transfer_ids" != "1" ]]; then
  printf 'same-key concurrent project transfer was not idempotent\n' >&2
  exit 1
fi
run_transfer 'bbbbbbbb-0000-4000-8000-000000000000' 'b0000000-0000-4000-8000-000000000001' 'free-transfer-race-1' "/tmp/${DB}_transfer_race_1.log" & p1=$!
run_transfer 'bbbbbbbb-0000-4000-8000-000000000000' 'b0000000-0000-4000-8000-000000000002' 'free-transfer-race-2' "/tmp/${DB}_transfer_race_2.log" & p2=$!
set +e
wait "$p1"; s1=$?
wait "$p2"; s2=$?
set -e
if [[ "$s1" -eq "$s2" ]]; then
  printf 'expected exactly one different-key Free transfer to succeed\n' >&2
  exit 1
fi
transfer_count="$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from public.my_stuff_project_transfers where user_id='bbbbbbbb-0000-4000-8000-000000000000'")"
if [[ "$transfer_count" != "1" ]]; then
  printf 'expected one Free transfer after race, got %s\n' "$transfer_count" >&2
  exit 1
fi

printf 'PostgreSQL My Stuff V1/V2 behavior passed (quota and idempotency races included)\n'
