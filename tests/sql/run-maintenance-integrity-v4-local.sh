#!/usr/bin/env bash
# LOCAL DISPOSABLE ONLY. Never reads linked configuration or credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="sideflip_maintenance_v4_$$"
TMP="$(mktemp)"
PSQL=(sudo -u postgres env -i PATH=/usr/bin:/bin psql -h /var/run/postgresql -p 5432 -U postgres -X -v ON_ERROR_STOP=1 -q "$DB")
cleanup(){ local rc=$?; rm -f "$TMP"; sudo -u postgres env -i PATH=/usr/bin:/bin dropdb -h /var/run/postgresql -p 5432 --if-exists "$DB" >/dev/null 2>&1 || true; return "$rc"; }
trap cleanup EXIT
sudo -u postgres env -i PATH=/usr/bin:/bin createdb -h /var/run/postgresql -p 5432 "$DB"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-fixture.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260803190000_trade_up_goals.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-freemium-preflight.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260806190000_add_freemium_entitlements.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-freemium-helper.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/my-stuff-v3-preflight.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-storage-stub.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260903190000_add_private_my_stuff_media.sql"
for m in \
  20260903220000_add_my_stuff_v2.sql \
  20260905120000_add_my_stuff_expenses_research_v3.sql \
  20260905190000_fix_v3_project_transfer_purchase_date.sql \
  20260905200000_add_project_transmission.sql \
  20260905201000_validate_project_transmission.sql \
  20260905202000_transfer_my_stuff_to_project.sql \
  20260906010000_fix_project_transfer_model_year.sql \
  20260906150000_add_airplanes_and_fix_transferred_project_delete.sql; do
  "${PSQL[@]}" < "$ROOT/supabase/migrations/$m"
done
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260907040000_harden_legacy_public_privileges.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-research-extension-stubs.sql"
python3 -c "from pathlib import Path; import sys; text=Path(sys.argv[1]).read_text().replace('create extension if not exists pgmq;','-- local pgmq stub').replace('create extension if not exists pg_cron;','-- local cron stub').replace('create extension if not exists pg_net;','-- local net stub'); Path(sys.argv[2]).write_text(text)" "$ROOT/supabase/migrations/20260907120000_enable_grounded_maintenance_research.sql" "$TMP"
"${PSQL[@]}" < "$TMP"
for m in \
  20260908120000_convert_maintenance_research_to_xai.sql \
  20260908193500_raise_maintenance_research_job_caps.sql \
  20260908194500_raise_global_maintenance_research_budget.sql \
  20260916163000_persist_my_stuff_vehicle_series.sql \
  20260916190000_fix_research_settlement_json_precedence.sql \
  20260916210000_add_finite_research_proposal_review.sql \
  20260916220000_apply_finite_research_milestones.sql \
  20260917120000_add_private_manufacturer_templates.sql \
  20260917140000_add_owner_maintenance_preferences.sql \
  20260917150000_add_provisional_service_history.sql \
  20260917160000_gate_document_maintenance_proposals.sql \
  20260918120000_atomic_document_research_jobs.sql \
  20260918130000_fix_document_preflight_and_active_owner.sql \
  20260918140000_document_dispatch_local.sql \
  20260918150000_document_transport_quarantine.sql \
  20260919164000_fix_research_activation_after_budget_raise.sql \
  20260919190000_focus_simple_maintenance_research.sql \
  20260919191000_fix_simple_maintenance_review_blockers.sql \
  20260922190000_fix_research_retry_budget_and_web_evidence.sql; do
  "${PSQL[@]}" < "$ROOT/supabase/migrations/$m"
done
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260923120000_retire_paid_maintenance_research.sql"
# Seed archive/duplicate state after the final historical stack and before V4.
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-seed.sql"
# RED: the V4 RPC does not exist before the candidate migration.
if "${PSQL[@]}" -c "select public.get_my_stuff_maintenance_report_v4('00000000-0000-0000-0000-000000000000')" >/dev/null 2>&1; then
  echo 'expected V4 RED probe to fail before migration' >&2; exit 1
fi
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260924120000_maintenance_integrity_v4.sql"
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-assertions.sql"
# Two independent authenticated sessions race the same canonical completion and correction.
"${PSQL[@]}" -c "insert into private.my_stuff_maintenance_test_clock_v4(singleton,server_now) values(true,'2026-09-25 12:00:00Z');"
CONCURRENT_SQL="set session authorization authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false); select public.complete_my_stuff_maintenance_v4((select id from public.my_stuff_maintenance_definitions where name='Oil and filter change'),'{\"service_performed_on\":\"2026-09-25\",\"service_mileage\":12000,\"current_mileage\":13000}'::jsonb,'2026-09-25 12:00:00Z','v4-concurrent-complete');"
"${PSQL[@]}" -c "$CONCURRENT_SQL" >/dev/null & p1=$!
"${PSQL[@]}" -c "$CONCURRENT_SQL" >/dev/null & p2=$!
wait "$p1"; wait "$p2"
CONCURRENT_HASH="$("${PSQL[@]}" -Atc "select encode(digest(private.my_stuff_original_snapshot_v4(id)::text,'sha256'),'hex') from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete'")"
CONCURRENT_CORRECTION="set session authorization authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false); select public.correct_my_stuff_completion_v4((select id from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete'),'{\"notes\":\"concurrent correction\"}'::jsonb,'same correction',0,'$CONCURRENT_HASH','2026-09-25 12:00:00Z','v4-concurrent-correct');"
"${PSQL[@]}" -c "$CONCURRENT_CORRECTION" >/dev/null & p1=$!
"${PSQL[@]}" -c "$CONCURRENT_CORRECTION" >/dev/null & p2=$!
wait "$p1"; wait "$p2"
RACE_HASH="$("${PSQL[@]}" -Atc "select encode(digest(private.my_stuff_effective_snapshot_v4(id)::text,'sha256'),'hex') from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete'")"
RACE_SQL_A="set session authorization authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false); select public.correct_my_stuff_completion_v4((select id from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete'),'{\"notes\":\"race A\"}'::jsonb,'race winner',1,'$RACE_HASH','2026-09-25 12:00:00Z','v4-revision-race-a');"
RACE_SQL_B="set session authorization authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false); select public.correct_my_stuff_completion_v4((select id from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete'),'{\"notes\":\"race B\"}'::jsonb,'race winner',1,'$RACE_HASH','2026-09-25 12:00:00Z','v4-revision-race-b');"
"${PSQL[@]}" -c "$RACE_SQL_A" >/dev/null 2>&1 & p1=$!
"${PSQL[@]}" -c "$RACE_SQL_B" >/dev/null 2>&1 & p2=$!
s1=0; s2=0; wait "$p1" || s1=$?; wait "$p2" || s2=$?
if { [ "$s1" -eq 0 ] && [ "$s2" -eq 0 ]; } || { [ "$s1" -ne 0 ] && [ "$s2" -ne 0 ]; }; then echo 'expected exactly one optimistic revision race winner' >&2; exit 1; fi
"${PSQL[@]}" -c "do \$\$begin if (select count(*) from public.my_stuff_service_occurrences where client_mutation_id='v4-concurrent-complete')<>1 then raise exception 'concurrent completion duplicated'; end if; if (select count(*) from public.my_stuff_completion_corrections where client_mutation_id='v4-concurrent-correct')<>1 then raise exception 'concurrent correction duplicated'; end if; if (select count(*) from public.my_stuff_completion_corrections where client_mutation_id in ('v4-revision-race-a','v4-revision-race-b'))<>1 then raise exception 'optimistic revision race did not have one winner'; end if; end\$\$; delete from private.my_stuff_maintenance_test_clock_v4; select private.assert_my_stuff_test_clock_empty_v4();"
# The future cutover template must be unappliable until exact release evidence is
# hard-coded by the database owner.
if "${PSQL[@]}" < "$ROOT/docs/maintenance-integrity-v4-enforcement.sql.template" >/dev/null 2>&1; then
  echo 'blocked cutover template unexpectedly applied' >&2; exit 1
fi
"${PSQL[@]}" < "$ROOT/tests/sql/maintenance-integrity-v4-enforcement-assertions.sql"
"${PSQL[@]}" < "$ROOT/supabase/migrations/20260924120000_maintenance_integrity_v4.sql" >/dev/null 2>&1 && { echo 'migration unexpectedly replayed despite intentionally one-shot additive DDL' >&2; exit 1; } || true
printf 'Maintenance integrity V4 RED/GREEN full-stack SQL rehearsal passed\n'
