#!/usr/bin/env bash
set -euo pipefail
DB="sideflip_trade_up_backend_test_$$"
COLLISION_DB="sideflip_trade_up_collision_test_$$"
cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
  sudo -u postgres dropdb --if-exists "$COLLISION_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sudo -u postgres createdb "$DB"
run() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB"; }
run < tests/sql/trade-up-goals-backend-fixture.sql
run < supabase/migrations/20260803190000_trade_up_goals.sql
run < supabase/migrations/20260803195329_link_existing_trade_up_project.sql
run < supabase/migrations/20260807210000_enforce_freemium_goal_limit.sql
run < supabase/migrations/20260910162500_restore_admin_pro_entitlements.sql
run < tests/sql/trade-up-goals-backend-historical-setup.sql
run < supabase/migrations/20260916120000_authoritative_trade_up_goal_enforcement.sql
run < tests/sql/trade-up-goals-backend-assertions.sql
run < tests/sql/trade-up-goals-authorization-assertions.sql
run < tests/sql/trade-up-goals-backend-concurrency-setup.sql

# Both RPCs take the owner advisory lock before project/goal/ledger rows.  The
# old opposite order deadlocked this exact sale-versus-completion interleaving.
sale_a="begin; set local role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true); select public.record_trade_up_sale('25100000-0000-4000-8000-000000000002',100,100); select pg_sleep(2); commit;"
sale_b="begin; set local role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true); select public.update_trade_up_goal('25000000-0000-4000-8000-000000000002','completed',100,'sale-vs-completion'); commit;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "$sale_a" >/tmp/sideflip-goal-sale-a.log 2>&1 & sale_a_pid=$!
sleep 0.25
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "$sale_b" >/tmp/sideflip-goal-sale-b.log 2>&1 & sale_b_pid=$!
wait "$sale_a_pid"; sale_a_status=$?
wait "$sale_b_pid"; sale_b_status=$?
if [[ $sale_a_status -ne 0 || $sale_b_status -ne 0 ]]; then
  printf 'Sale/completion serialization failed: sale=%s completion=%s\n' "$sale_a_status" "$sale_b_status" >&2
  exit 1
fi

# The completion loser must block on the owner advisory lock, then observe that
# the winner completed the Goal. Only the winner may persist an idempotency row.
completion_a="begin; set local role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true); select public.update_trade_up_goal('22000000-0000-4000-8000-000000000002','completed',100,'concurrent-complete-a'); select pg_sleep(2); commit;"
completion_b="begin; set local role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true); select public.update_trade_up_goal('22000000-0000-4000-8000-000000000002','completed',100,'concurrent-complete-b'); commit;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "$completion_a" >/tmp/sideflip-goal-completion-a.log 2>&1 & completion_a_pid=$!
sleep 0.25
set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "$completion_b" >/tmp/sideflip-goal-completion-b.log 2>&1 & completion_b_pid=$!
wait "$completion_a_pid"; completion_a_status=$?
wait "$completion_b_pid"; completion_b_status=$?
set -e
if [[ $completion_a_status -ne 0 || $completion_b_status -eq 0 ]]; then
  printf 'Concurrent completion statuses were unexpected: winner=%s loser=%s\n' "$completion_a_status" "$completion_b_status" >&2
  exit 1
fi

# The entitlement row share lock makes an in-flight Pro mutation linearize
# before a concurrent downgrade; all later mutations observe Free access.
downgrade_a="begin; set local role authenticated; select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true); select public.update_trade_up_goal('41000000-0000-4000-8000-000000000004',null,12,'before-concurrent-downgrade'); select pg_sleep(2); commit;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "$downgrade_a" >/tmp/sideflip-goal-downgrade-a.log 2>&1 & downgrade_a_pid=$!
sleep 0.25
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB" -c "delete from public.user_entitlements where user_id='44444444-4444-4444-8444-444444444444';" >/tmp/sideflip-goal-downgrade-b.log 2>&1 & downgrade_b_pid=$!
wait "$downgrade_a_pid"
wait "$downgrade_b_pid"
run < tests/sql/trade-up-goals-backend-concurrency-assertions.sql
rm -f /tmp/sideflip-goal-sale-a.log /tmp/sideflip-goal-sale-b.log /tmp/sideflip-goal-completion-a.log /tmp/sideflip-goal-completion-b.log /tmp/sideflip-goal-downgrade-a.log /tmp/sideflip-goal-downgrade-b.log

# A legacy key present in two operation namespaces is not safe to canonicalize.
# The migration must abort atomically with a deterministic collision error.
sudo -u postgres createdb "$COLLISION_DB"
collision_run() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$COLLISION_DB"; }
collision_run < tests/sql/trade-up-goals-backend-fixture.sql
collision_run < supabase/migrations/20260803190000_trade_up_goals.sql
collision_run < supabase/migrations/20260803195329_link_existing_trade_up_project.sql
collision_run < supabase/migrations/20260807210000_enforce_freemium_goal_limit.sql
collision_run < supabase/migrations/20260910162500_restore_admin_pro_entitlements.sql
collision_run < tests/sql/trade-up-goals-backend-historical-setup.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$COLLISION_DB" -c "insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id) values('70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','personal_contribution',1,'collision','historical-goal');"
set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$COLLISION_DB" < supabase/migrations/20260916120000_authoritative_trade_up_goal_enforcement.sql >/tmp/sideflip-goal-collision.log 2>&1
collision_status=$?
set -e
collision_log="$(</tmp/sideflip-goal-collision.log)"
if [[ $collision_status -eq 0 || "$collision_log" != *"Historical Trade-Up mutation ID collision"* ]]; then
  printf 'Historical collision migration did not abort as expected\n' >&2
  exit 1
fi
rm -f /tmp/sideflip-goal-collision.log
printf 'PostgreSQL Trade-Up Goal backend enforcement passed\n'
