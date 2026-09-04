#!/usr/bin/env bash
set -euo pipefail

DB="sideflip_vin_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")
SCHEDULE_MIGRATION="$ROOT/supabase/migrations/20260903210000_schedule_vin_decode_cleanup.sql"
LOCAL_SCHEDULE_MIGRATION="$(mktemp)"

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$LOCAL_SCHEDULE_MIGRATION"
}
trap cleanup EXIT

sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/vin-fixture.sql"

# This host lacks the pg_cron extension package. Keep the production migration
# intact and replace only extension installation in a temporary test copy; the
# fixture provides a compatible cron catalog/functions for behavioral checks.
python3 - "$SCHEDULE_MIGRATION" "$LOCAL_SCHEDULE_MIGRATION" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
extension = 'create extension if not exists pg_cron with schema pg_catalog;'
if source.lower().count(extension) != 1:
    raise SystemExit('expected exactly one pg_cron extension statement')
Path(sys.argv[2]).write_text(source.replace(extension, '-- pg_cron supplied by local fixture'))
PY

# Applying out of order must fail and leave no schedule behind.
if "${PSQL[@]}" < "$LOCAL_SCHEDULE_MIGRATION" >/dev/null 2>&1; then
  printf 'VIN cleanup schedule unexpectedly applied before VIN schema\n' >&2
  exit 1
fi
if [[ "$(sudo -u postgres psql -X -Atq "$DB" -c "select count(*) from cron.job")" != "0" ]]; then
  printf 'failed VIN cleanup schedule left partial cron state\n' >&2
  exit 1
fi

"${PSQL[@]}" < "$ROOT/supabase/migrations/20260903203000_add_vin_decode_cache_and_rate_limits.sql"
"${PSQL[@]}" < "$LOCAL_SCHEDULE_MIGRATION"
"${PSQL[@]}" < "$LOCAL_SCHEDULE_MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/vin-assertions.sql"
printf 'PostgreSQL VIN RPC, grants, key rotation, cleanup, and idempotent cron schedule behavior passed\n'
