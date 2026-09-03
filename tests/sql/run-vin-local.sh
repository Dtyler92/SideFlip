#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_vin_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/vin-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260903203000_add_vin_decode_cache_and_rate_limits.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/vin-assertions.sql"
printf 'PostgreSQL VIN RPC, grants, key rotation, and cleanup behavior passed\n'
