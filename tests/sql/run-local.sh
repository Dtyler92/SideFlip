#!/usr/bin/env bash
set -euo pipefail
DB="sideflip_analytics_test_$$"
cleanup() { sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -u postgres createdb "$DB"
run() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB"; }
run < tests/sql/analytics-fixture.sql
run < supabase/migrations/20260806190000_add_freemium_entitlements.sql
run < supabase/migrations/20260807020000_add_apple_entitlement_event_safety.sql
run < supabase/migrations/20260807110000_add_account_deletion_state_machine.sql
run < supabase/migrations/20260807120000_add_stripe_event_safety.sql
run < supabase/migrations/20260809020000_add_product_analytics_outbox.sql
run < tests/sql/analytics-assertions.sql
printf 'PostgreSQL analytics migration behavior passed\n'
