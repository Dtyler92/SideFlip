#!/usr/bin/env bash
# LOCAL DISPOSABLE ONLY. Never reads linked Supabase configuration or credentials.
set -euo pipefail
DB="sideflip_manufacturer_template_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_MIGRATION="$(mktemp)"
PSQL=(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q "$DB")
cleanup(){ rm -f "$TMP_MIGRATION"; sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -u postgres createdb "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v3-preflight.sql"
for migration in \
  20260903220000_add_my_stuff_v2.sql \
  20260905120000_add_my_stuff_expenses_research_v3.sql \
  20260905190000_fix_v3_project_transfer_purchase_date.sql \
  20260905200000_add_project_transmission.sql \
  20260905201000_validate_project_transmission.sql \
  20260905202000_transfer_my_stuff_to_project.sql \
  20260906010000_fix_project_transfer_model_year.sql \
  20260906150000_add_airplanes_and_fix_transferred_project_delete.sql; do
  "${PSQL[@]}" < "$ROOT/supabase/migrations/$migration"
done
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v3-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260917140000_add_owner_maintenance_preferences.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260917150000_add_provisional_service_history.sql"
# Run both assertions in one session so psql fixture variables survive.
python3 -c 'import pathlib,sys; [print(pathlib.Path(p).read_text()) for p in sys.argv[1:]]' "$ROOT/tests/sql/owner-maintenance-assertions.sql" "$ROOT/tests/sql/historical-service-assertions.sql" | "${PSQL[@]}"
printf "Owner maintenance SQL passed (disposable local only)\n"
