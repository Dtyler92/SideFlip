#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_entitlement_parity_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260904120000_normalize_stripe_entitlement_authority.sql"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/entitlement-parity-fixture.sql"
"${PSQL[@]}" < "$MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/entitlement-parity-assertions.sql"

printf 'PostgreSQL entitlement parity behavior passed\n'
