#!/usr/bin/env bash
# LOCAL DISPOSABLE ONLY. Never reads linked Supabase configuration or credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260923120000_retire_paid_maintenance_research.sql"
DBS=()
TMP_FILES=()
PSQL_BASE=(sudo -u postgres env -i PATH=/usr/bin:/bin psql -h /var/run/postgresql -p 5432 -U postgres -X -v ON_ERROR_STOP=1 -q)
cleanup(){
  for file in "${TMP_FILES[@]:-}"; do rm -f "$file"; done
  for db in "${DBS[@]:-}"; do
    sudo -u postgres env -i PATH=/usr/bin:/bin dropdb -h /var/run/postgresql -p 5432 --if-exists "$db" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

psql_db(){ local db="$1"; shift; "${PSQL_BASE[@]}" "$db" "$@"; }

create_db(){
  local db="$1"
  DBS+=("$db")
  sudo -u postgres env -i PATH=/usr/bin:/bin createdb -h /var/run/postgresql -p 5432 "$db"
}

apply_core(){
  local db="$1" mode="$2" tmp
  tmp="$(mktemp)"
  TMP_FILES+=("$tmp")
  psql_db "$db" < "$ROOT/tests/sql/my-stuff-fixture.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260824190000_add_my_stuff.sql"
  psql_db "$db" < "$ROOT/tests/sql/my-stuff-v3-preflight.sql"
  for migration in \
    20260903220000_add_my_stuff_v2.sql \
    20260905120000_add_my_stuff_expenses_research_v3.sql \
    20260905190000_fix_v3_project_transfer_purchase_date.sql \
    20260905200000_add_project_transmission.sql \
    20260905201000_validate_project_transmission.sql \
    20260905202000_transfer_my_stuff_to_project.sql \
    20260906010000_fix_project_transfer_model_year.sql \
    20260906150000_add_airplanes_and_fix_transferred_project_delete.sql; do
    psql_db "$db" < "$ROOT/supabase/migrations/$migration"
  done
  psql_db "$db" < "$ROOT/tests/sql/maintenance-research-extension-stubs.sql"
  python3 -c "from pathlib import Path; import sys; text=Path(sys.argv[1]).read_text(); text=text.replace('create extension if not exists pgmq;','-- pgmq supplied by local stub').replace('create extension if not exists pg_cron;','-- pg_cron supplied by local stub').replace('create extension if not exists pg_net;','-- pg_net supplied by local stub'); Path(sys.argv[2]).write_text(text)" \
    "$ROOT/supabase/migrations/20260907120000_enable_grounded_maintenance_research.sql" "$tmp"
  psql_db "$db" < "$tmp"
  psql_db "$db" < "$ROOT/supabase/migrations/20260908120000_convert_maintenance_research_to_xai.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260908193500_raise_maintenance_research_job_caps.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260908194500_raise_global_maintenance_research_budget.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260916190000_fix_research_settlement_json_precedence.sql"

  if [[ "$mode" == full ]]; then
    psql_db "$db" < "$ROOT/supabase/migrations/20260916210000_add_finite_research_proposal_review.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260916220000_apply_finite_research_milestones.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260917120000_add_private_manufacturer_templates.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260917160000_gate_document_maintenance_proposals.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260918120000_atomic_document_research_jobs.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260918130000_fix_document_preflight_and_active_owner.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260918140000_document_dispatch_local.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260918150000_document_transport_quarantine.sql"
    psql_db "$db" < "$ROOT/supabase/migrations/20260919164000_fix_research_activation_after_budget_raise.sql"
  fi

  psql_db "$db" < "$ROOT/supabase/migrations/20260919190000_focus_simple_maintenance_research.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260919191000_fix_simple_maintenance_review_blockers.sql"
  psql_db "$db" < "$ROOT/supabase/migrations/20260922190000_fix_research_retry_budget_and_web_evidence.sql"
}

seed_success(){
  local db="$1" mode="$2"
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-seed-base.sql"
  if [[ "$mode" == full ]]; then
    psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-seed-document.sql"
  fi
}

assert_phase_one_fail_closed(){
  local db="$1"
  psql_db "$db" <<'SQL'
do $$begin
 if not exists(select 1 from private.my_stuff_research_runtime_config where singleton and enabled=false) then raise exception 'phase one did not disable runtime'; end if;
 if exists(select 1 from cron.job where jobname='sideflip-maintenance-research-worker') then raise exception 'phase one did not remove cron'; end if;
end$$;
SQL
}

run_success_base_with_lock(){
  local db="sideflip_shutdown_base_$$" red_log start_ms end_ms elapsed_ms locker
  create_db "$db"
  apply_core "$db" base
  seed_success "$db" base

  red_log="$(mktemp)"
  TMP_FILES+=("$red_log")
  if psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql" >"$red_log" 2>&1; then
    echo 'expected RED shutdown assertions to fail before migration' >&2
    return 1
  fi

  sudo -u postgres env -i PATH=/usr/bin:/bin psql -h /var/run/postgresql -p 5432 -U postgres -X -v ON_ERROR_STOP=1 -q "$db" \
    -c "begin; select pg_advisory_xact_lock(hashtextextended('research-provider-global',0)); select pg_sleep(2); commit;" >/dev/null &
  locker=$!
  sleep 0.25
  start_ms="$(date +%s%3N)"
  psql_db "$db" < "$MIGRATION"
  end_ms="$(date +%s%3N)"
  wait "$locker"
  elapsed_ms=$((end_ms-start_ms))
  if (( elapsed_ms < 1400 )); then
    echo "global-lock serialization was not observed (${elapsed_ms}ms)" >&2
    return 1
  fi
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"

  local denial_log
  denial_log="$(mktemp)"
  TMP_FILES+=("$denial_log")
  if "${PSQL_BASE[@]}" "$db" \
    -c "set session authorization authenticated" \
    -c "select public.enqueue_my_stuff_research_v3('90000000-0000-4000-8000-000000000001',repeat('a',64),'retired-client')" \
    >"$denial_log" 2>&1; then
    echo 'authenticated old client unexpectedly executed retired enqueue' >&2
    return 1
  fi
  if [[ "$(<"$denial_log")" != *'permission denied for function enqueue_my_stuff_research_v3'* ]]; then
    echo 'authenticated old client failed for a reason other than the execute ACL' >&2
    return 1
  fi

  # Direct replay exercises the no-active-jobs path and proves release/cancel
  # idempotency independently of the production migration-ledger uniqueness gate.
  psql_db "$db" < "$MIGRATION"
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"
  printf 'base stack RED/GREEN, old-client denial, idempotent replay, and global-lock serialization passed (%sms)\n' "$elapsed_ms"
}

run_success_full(){
  local db="sideflip_shutdown_full_$$"
  create_db "$db"
  apply_core "$db" full
  seed_success "$db" full
  psql_db "$db" < "$MIGRATION"
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"
  printf 'full document stack queued/READY reconciliation passed\n'
}

run_running_abort(){
  local db="sideflip_shutdown_running_$$" log
  create_db "$db"
  apply_core "$db" base
  seed_success "$db" base
  psql_db "$db" <<'SQL'
update private.my_stuff_research_jobs
set status='running',lease_owner='active-worker',lease_token='90000000-0000-4000-8000-000000000097',lease_expires_at=now()+interval '5 minutes',attempt_count=1
where id='90000000-0000-4000-8000-000000000011';
SQL
  log="$(mktemp)"; TMP_FILES+=("$log")
  if psql_db "$db" < "$MIGRATION" >"$log" 2>&1; then
    echo 'running execution did not abort shutdown migration' >&2
    return 1
  fi
  if [[ "$(<"$log")" != *RESEARCH_EXECUTION_RECONCILIATION_REQUIRED* ]]; then
    echo 'running abort returned the wrong error' >&2
    return 1
  fi
  assert_phase_one_fail_closed "$db"
  printf 'running execution abort preserved phase-one fail-closed state\n'
}

run_remote_unknown_abort(){
  local db="sideflip_shutdown_remote_$$" log
  create_db "$db"
  apply_core "$db" full
  seed_success "$db" full
  psql_db "$db" <<'SQL'
update private.my_stuff_document_executions
set state='attempted',source='{"sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","selectedPages":[1]}'::jsonb,
    transport_state='abort_requested_remote_unknown'
where job_id='90000000-0000-4000-8000-000000000013';
SQL
  log="$(mktemp)"; TMP_FILES+=("$log")
  if psql_db "$db" < "$MIGRATION" >"$log" 2>&1; then
    echo 'remote-unknown execution did not abort shutdown migration' >&2
    return 1
  fi
  if [[ "$(<"$log")" != *RESEARCH_EXECUTION_RECONCILIATION_REQUIRED* ]]; then
    echo 'remote-unknown abort returned the wrong error' >&2
    return 1
  fi
  assert_phase_one_fail_closed "$db"
  printf 'remote-unknown document execution abort preserved fail-closed state\n'
}

run_document_inconsistency_abort(){
  local db="sideflip_shutdown_inconsistent_$$" log
  create_db "$db"
  apply_core "$db" full
  seed_success "$db" full
  psql_db "$db" <<'SQL'
update private.my_stuff_research_jobs
set status='document_queued',lease_owner=null,lease_token=null,lease_expires_at=null
where id='90000000-0000-4000-8000-000000000013';
SQL
  log="$(mktemp)"; TMP_FILES+=("$log")
  if psql_db "$db" < "$MIGRATION" >"$log" 2>&1; then
    echo 'document inconsistency did not abort shutdown migration' >&2
    return 1
  fi
  if [[ "$(<"$log")" != *DOCUMENT_RECONCILIATION_SCHEMA_INCONSISTENT* ]]; then
    echo 'document inconsistency abort returned the wrong error' >&2
    return 1
  fi
  assert_phase_one_fail_closed "$db"
  printf 'document inconsistency abort preserved fail-closed state\n'
}

assert_queued_unchanged_after_abort(){
  local db="$1"
  psql_db "$db" <<'SQL'
do $$begin
 if not exists(select 1 from private.my_stuff_research_jobs where id='90000000-0000-4000-8000-000000000011' and status='queued' and queue_msg_id is not null) then raise exception 'queued job changed despite phase-two abort'; end if;
 if (select count(*) from private.my_stuff_research_budget_ledger where job_id='90000000-0000-4000-8000-000000000011' and kind='release')>1 then raise exception 'phase-two abort duplicated release'; end if;
end$$;
SQL
  assert_phase_one_fail_closed "$db"
}

run_release_identity_cases(){
  local variant db log sql
  for variant in one_cent wrong_month wrong_user wrong_attempt; do
    db="sideflip_shutdown_release_${variant}_$$"
    create_db "$db"
    apply_core "$db" base
    seed_success "$db" base
    case "$variant" in
      one_cent) sql="insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values('90000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111',date '2026-08-01','release',1049,0)" ;;
      wrong_month) sql="insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values('90000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111',date '2026-09-01','release',1050,0)" ;;
      wrong_user) sql="insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values('90000000-0000-4000-8000-000000000011','22222222-2222-4222-8222-222222222222',date '2026-08-01','release',1050,0)" ;;
      wrong_attempt) sql="insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values('90000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111',date '2026-08-01','release',1050,1)" ;;
    esac
    psql_db "$db" -c "$sql"
    log="$(mktemp)"; TMP_FILES+=("$log")
    if psql_db "$db" < "$MIGRATION" >"$log" 2>&1; then
      echo "$variant release mismatch did not abort shutdown migration" >&2
      return 1
    fi
    if [[ "$(<"$log")" != *RESEARCH_RELEASE_INCONSISTENT* ]]; then
      echo "$variant release mismatch returned the wrong error" >&2
      return 1
    fi
    assert_queued_unchanged_after_abort "$db"
  done

  db="sideflip_shutdown_release_exact_$$"
  create_db "$db"
  apply_core "$db" base
  seed_success "$db" base
  psql_db "$db" -c "insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values('90000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111',date '2026-08-01','release',1050,0)"
  psql_db "$db" < "$MIGRATION"
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"
  psql_db "$db" < "$MIGRATION"
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"
  printf 'release one-cent/month/user/attempt mismatches abort; exact release and terminal replay pass\n'
}

run_queue_identity_cases(){
  local variant db log setup expected
  for variant in missing swapped malformed delete_false; do
    db="sideflip_shutdown_queue_${variant}_$$"
    create_db "$db"
    apply_core "$db" base
    seed_success "$db" base
    case "$variant" in
      missing) setup="delete from pgmq.messages where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id='90000000-0000-4000-8000-000000000011')" ;;
      swapped) setup="update pgmq.messages set message=jsonb_build_object('job_id','22222222-2222-4222-8222-222222222222','schema_version',1) where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id='90000000-0000-4000-8000-000000000011')" ;;
      malformed) setup="update pgmq.messages set message=jsonb_build_object('job_id','90000000-0000-4000-8000-000000000011','schema_version',1,'unexpected',true) where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id='90000000-0000-4000-8000-000000000011')" ;;
      delete_false) setup="create or replace function pgmq.delete(queue_name text,msg_id bigint) returns boolean language plpgsql as \$\$begin return false; end\$\$" ;;
    esac
    psql_db "$db" -c "$setup"
    log="$(mktemp)"; TMP_FILES+=("$log")
    if psql_db "$db" < "$MIGRATION" >"$log" 2>&1; then
      echo "$variant queue case did not abort shutdown migration" >&2
      return 1
    fi
    expected=RESEARCH_QUEUE_MESSAGE_INCONSISTENT
    [[ "$variant" == delete_false ]] && expected=RESEARCH_QUEUE_DELETE_FAILED
    if [[ "$(<"$log")" != *"$expected"* ]]; then
      echo "$variant queue case returned the wrong error" >&2
      return 1
    fi
    assert_queued_unchanged_after_abort "$db"
  done
  printf 'missing/swapped/malformed queue identity and false deletion abort atomically\n'
}

run_management_payload_rehearsal(){
  local db="sideflip_shutdown_management_$$" payload query ambiguous log start_ms end_ms elapsed_ms locker
  create_db "$db"
  apply_core "$db" base
  seed_success "$db" base
  psql_db "$db" <<'SQL'
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations(version,name,statements)
values('20260922190000','fix_research_retry_budget_and_web_evidence',null);
SQL
  payload="$(mktemp)"; rm -f "$payload"; TMP_FILES+=("$payload")
  query="$(mktemp)"; TMP_FILES+=("$query")
  ambiguous="$(mktemp)"; TMP_FILES+=("$ambiguous")
  log="$(mktemp)"; TMP_FILES+=("$log")
  python3 "$ROOT/scripts/build-paid-research-shutdown-management-payload.py" --output "$payload" >/dev/null
  python3 -c "import json,sys; open(sys.argv[2],'w',encoding='utf-8').write(json.load(open(sys.argv[1],encoding='utf-8'))['query'])" "$payload" "$query"
  python3 -c "import sys; open(sys.argv[2],'w',encoding='utf-8').write(open(sys.argv[1],encoding='utf-8').read()+'\nselect 1/0;\n')" "$query" "$ambiguous"

  sudo -u postgres env -i PATH=/usr/bin:/bin psql -h /var/run/postgresql -p 5432 -U postgres -X -v ON_ERROR_STOP=1 -q "$db" \
    -c "select pg_advisory_lock(hashtextextended('sideflip-exclusive-database-release-window',0)); select pg_sleep(2); select pg_advisory_unlock(hashtextextended('sideflip-exclusive-database-release-window',0));" >/dev/null &
  locker=$!
  sleep 0.25
  start_ms="$(date +%s%3N)"
  if psql_db "$db" < "$ambiguous" >"$log" 2>&1; then
    echo 'simulated non-2xx Management response unexpectedly succeeded' >&2
    return 1
  fi
  end_ms="$(date +%s%3N)"
  wait "$locker"
  elapsed_ms=$((end_ms-start_ms))
  if (( elapsed_ms < 1400 )); then
    echo "Management session-lock serialization was not observed (${elapsed_ms}ms)" >&2
    return 1
  fi
  if [[ "$(<"$log")" != *'division by zero'* ]]; then
    echo 'Management ambiguity simulation failed for the wrong reason' >&2
    return 1
  fi

  # This is the mandatory immediate ledger/object readback after an ambiguous
  # response: it proves that the earlier committed release actually completed.
  psql_db "$db" < "$ROOT/tests/sql/paid-research-shutdown-assertions.sql"
  psql_db "$db" <<'SQL'
do $$begin
 if (select count(*) from supabase_migrations.schema_migrations where version='20260923120000')<>1 then raise exception 'candidate ledger row missing'; end if;
 if exists(select 1 from supabase_migrations.schema_migrations where version='20260922233000') then raise exception 'excluded ledger row present'; end if;
 if (select encode(digest(statements[1],'sha256'),'hex') from supabase_migrations.schema_migrations where version='20260923120000')<>'410a86ee3a1e424606a1fc089d16603c16f0f7930cee78277aa6bedae401d759' then raise exception 'ledger body hash mismatch'; end if;
end$$;
SQL
  printf 'exact Management SQL, session-lock timing, ambiguous non-2xx, and immediate readback passed (%sms)\n' "$elapsed_ms"
}

run_management_concurrency_abort(){
  local db="sideflip_shutdown_management_concurrent_$$" payload query log worker
  create_db "$db"
  apply_core "$db" base
  seed_success "$db" base
  psql_db "$db" <<'SQL'
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);
insert into supabase_migrations.schema_migrations(version,name,statements)
values('20260922190000','fix_research_retry_budget_and_web_evidence',null);
SQL
  payload="$(mktemp)"; rm -f "$payload"; TMP_FILES+=("$payload")
  query="$(mktemp)"; TMP_FILES+=("$query")
  log="$(mktemp)"; TMP_FILES+=("$log")
  python3 "$ROOT/scripts/build-paid-research-shutdown-management-payload.py" --output "$payload" >/dev/null
  python3 -c "import json,sys; open(sys.argv[2],'w',encoding='utf-8').write(json.load(open(sys.argv[1],encoding='utf-8'))['query'])" "$payload" "$query"
  sudo -u postgres env -i PATH=/usr/bin:/bin PGAPPNAME=migration-agent psql -h /var/run/postgresql -p 5432 -U postgres -X -q "$db" -c 'select pg_sleep(3)' >/dev/null &
  worker=$!
  sleep 0.25
  if psql_db "$db" < "$query" >"$log" 2>&1; then
    echo 'concurrent migration activity did not abort Management payload' >&2
    return 1
  fi
  wait "$worker"
  if [[ "$(<"$log")" != *CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED* ]]; then
    echo 'concurrent migration gate returned the wrong error' >&2
    return 1
  fi
  psql_db "$db" <<'SQL'
do $$begin
 if exists(select 1 from supabase_migrations.schema_migrations where version='20260923120000') then raise exception 'candidate ledger row survived concurrency abort'; end if;
 if not exists(select 1 from private.my_stuff_research_runtime_config where singleton and enabled=true) then raise exception 'preflight concurrency abort changed runtime'; end if;
end$$;
SQL
  printf 'fresh pg_stat_activity concurrent-migration gate passed\n'
}

run_success_base_with_lock
run_success_full
run_running_abort
run_remote_unknown_abort
run_document_inconsistency_abort
run_release_identity_cases
run_queue_identity_cases
run_management_payload_rehearsal
run_management_concurrency_abort
printf 'Paid maintenance research shutdown rehearsal passed\n'
