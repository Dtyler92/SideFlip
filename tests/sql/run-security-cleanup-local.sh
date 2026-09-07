#!/usr/bin/env bash
set -euo pipefail
DB="sideflip_security_cleanup_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")
cleanup(){ sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/security-cleanup-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260907040000_harden_legacy_public_privileges.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/security-cleanup-assertions.sql"
"${PSQL[@]}" -c "drop trigger on_auth_user_created on auth.users; drop function public.handle_new_user()"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260907040000_harden_legacy_public_privileges.sql"
printf 'PostgreSQL cleanup security behavior passed\n'
