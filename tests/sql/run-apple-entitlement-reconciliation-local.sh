#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_apple_reconciliation_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/analytics-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260806190000_add_freemium_entitlements.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260807020000_add_apple_entitlement_event_safety.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260807110000_add_account_deletion_state_machine.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260807120000_add_stripe_event_safety.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260809020000_add_product_analytics_outbox.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260916170000_add_apple_entitlement_reconciliation.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/apple-entitlement-reconciliation-assertions.sql"

# A direct concurrent Auth deletion holds the entitlement row/cascade lock. The
# reconciliation must wait, observe that the row vanished, and return false
# without appending a repair version.
"${PSQL[@]}" <<'SQL'
insert into auth.users(id) values('44444444-4444-4444-8444-444444444444');
insert into public.profiles(id) values('44444444-4444-4444-8444-444444444444');
select public.apply_apple_entitlement_event(
  '44444444-4444-4444-8444-444444444444','orig-concurrent-delete','tx-delete',null,
  '2026-09-16T16:00:00Z','grace_period','com.sideflip.app.pro.monthly',
  '2026-08-01T00:00:00Z','2026-09-25T00:00:00Z'
);
SQL

sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB" -c \
  "begin; delete from public.profiles where id='44444444-4444-4444-8444-444444444444'; delete from auth.users where id='44444444-4444-4444-8444-444444444444'; select pg_sleep(1); commit;" \
  >/dev/null &
delete_pid=$!
sleep 0.2
result=$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -qAt "$DB" -c \
  "set statement_timeout='5s'; select public.reconcile_verified_apple_entitlement('44444444-4444-4444-8444-444444444444','orig-concurrent-delete','tx-delete','2026-09-16T16:00:00Z','grace_period','2026-09-30T00:00:00Z','2026-09-16T17:00:00Z');")
wait "$delete_pid"
if [[ "$result" != "f" ]]; then
  printf 'Concurrent deletion reconciliation returned %q, expected f\n' "$result" >&2
  exit 1
fi
version_count=$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -qAt "$DB" -c \
  "select count(*) from public.apple_entitlement_reconciliation_versions where original_transaction_id='orig-concurrent-delete';")
if [[ "$version_count" != "0" ]]; then
  printf 'Concurrent deletion appended %s repair versions\n' "$version_count" >&2
  exit 1
fi

printf 'PostgreSQL Apple entitlement reconciliation behavior passed\n'
