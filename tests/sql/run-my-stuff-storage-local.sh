#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_my_stuff_storage_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260903190000_add_private_my_stuff_media.sql"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-storage-fixture.sql"
"${PSQL[@]}" < "$MIGRATION"
"${PSQL[@]}" < "$MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-storage-assertions.sql"

printf 'PostgreSQL My Stuff private storage double-apply and policy behavior passed\n'
