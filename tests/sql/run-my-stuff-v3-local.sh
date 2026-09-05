#!/usr/bin/env bash
set -euo pipefail
DB="sideflip_my_stuff_v3_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")
cleanup(){ sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v3-preflight.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260903220000_add_my_stuff_v2.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260905120000_add_my_stuff_expenses_research_v3.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v3-assertions.sql"
printf 'PostgreSQL My Stuff V3 behavior passed\n'
