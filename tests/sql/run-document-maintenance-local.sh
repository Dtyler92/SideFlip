#!/usr/bin/env bash
# LOCAL DISPOSABLE ONLY. Never reads linked Supabase configuration or credentials.
set -euo pipefail
DB="sideflip_manufacturer_template_test_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_MIGRATION="$(mktemp)"
PSQL=(sudo -u postgres env -i PATH=/usr/bin:/bin psql -h /var/run/postgresql -p 5432 -U postgres -X -v ON_ERROR_STOP=1 -q "$DB")
cleanup(){ rm -f "$TMP_MIGRATION"; sudo -u postgres env -i PATH=/usr/bin:/bin dropdb -h /var/run/postgresql -p 5432 --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -u postgres env -i PATH=/usr/bin:/bin createdb -h /var/run/postgresql -p 5432 "$DB"
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
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-research-extension-stubs.sql"
python3 -c "from pathlib import Path; import sys; text=Path(sys.argv[1]).read_text(); text=text.replace('create extension if not exists pgmq;','-- pgmq supplied by local stub').replace('create extension if not exists pg_cron;','-- pg_cron supplied by local stub').replace('create extension if not exists pg_net;','-- pg_net supplied by local stub'); Path(sys.argv[2]).write_text(text)" "$ROOT/supabase/migrations/20260907120000_enable_grounded_maintenance_research.sql" "$TMP_MIGRATION"
"${PSQL[@]}" < "$TMP_MIGRATION"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-research-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260908120000_convert_maintenance_research_to_xai.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260916190000_fix_research_settlement_json_precedence.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260916210000_add_finite_research_proposal_review.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/xai-maintenance-assertions.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/manufacturer-proposals-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260916220000_apply_finite_research_milestones.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/manufacturer-finite-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260917120000_add_private_manufacturer_templates.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/manufacturer-template-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260917160000_gate_document_maintenance_proposals.sql"
env -i PATH="$PATH" HOME=/root node --experimental-default-type=module "$ROOT/tests/sql/document-maintenance-ingestion-local.mjs" "$DB"
printf 'PostgreSQL document proposal lifecycle passed (local only)\n'
