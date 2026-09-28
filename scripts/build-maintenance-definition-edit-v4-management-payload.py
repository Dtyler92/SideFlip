#!/usr/bin/env python3
"""Build, but never submit, the exact V4 definition-edit migration payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

VERSION = "20260924130000"
NAME = "add_maintenance_definition_edit_v4"
EXPECTED_SHA256 = "60374c3124d7d3006bb86c57fa70bc384de86bba53ec9d00f2d4d0cb828674fc"
EXPECTED_LEDGER_HEAD = "20260924120000"
LOCK_NAME = "sideflip-exclusive-database-release-window"
DELIMITER = "$sideflip_maintenance_definition_edit_v4$"
SIGNATURE = "public.update_my_stuff_maintenance_definition_v4(uuid,jsonb,timestamp with time zone,text)"
STATE_SIGNATURE = "public.get_my_stuff_maintenance_state_v4(uuid)"
SETUP_SIGNATURE = "public.setup_my_stuff_maintenance_preset_v4(uuid,jsonb,jsonb,timestamp with time zone,text)"
EXPORT_SIGNATURE = "public.get_my_stuff_maintenance_integrity_export_v4(uuid,integer,text)"
REPORT_SIGNATURE = "public.get_my_stuff_maintenance_report_v4(uuid,integer,timestamp with time zone,uuid)"


def migration_body(text: str) -> str:
    stripped = text.strip()
    prefix, suffix = "begin;", "commit;"
    if not stripped.lower().startswith(prefix) or not stripped.lower().endswith(suffix):
        raise SystemExit("migration must have one outer transaction")
    body = stripped[len(prefix): -len(suffix)].strip()
    if not body or "commit;" in body.lower() or "begin;" in body.lower():
        raise SystemExit("migration contains an unexpected nested transaction boundary")
    return body + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="owner-only JSON payload path")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    path = root / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
    migration = path.read_text(encoding="utf-8")
    digest = hashlib.sha256(migration.encode()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"migration hash mismatch: expected {EXPECTED_SHA256}, got {digest}")
    if DELIMITER in migration:
        raise SystemExit("ledger dollar-quote delimiter collides with migration body")
    body = migration_body(migration)

    lock_check = f"""if not exists (
    select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted
      and classid=(((hashtextextended('{LOCK_NAME}',0) >> 32) & 4294967295)::oid)
      and objid=((hashtextextended('{LOCK_NAME}',0) & 4294967295)::oid)
  ) then raise exception 'EXCLUSIVE_DATABASE_RELEASE_LOCK_LOST'; end if;"""
    concurrency_check = """if exists (
    select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
      and backend_type='client backend' and state<>'idle'
      and (application_name ~* '(supabase[-_ ]?cli|migration|migrate)'
        or query ~* '(supabase_migrations[.]schema_migrations|alter[[:space:]]+table|create[[:space:]]+(table|or[[:space:]]+replace[[:space:]]+function)|drop[[:space:]]+(table|function)|grant[[:space:]]|revoke[[:space:]])')
  ) then raise exception 'CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED'; end if;"""
    query = f"""begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('{LOCK_NAME}',0)) then raise exception 'EXCLUSIVE_DATABASE_RELEASE_LOCK_UNAVAILABLE'; end if;
end
$lock$;
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$
begin
  if current_user<>'postgres' or session_user<>'postgres' then raise exception 'MANAGEMENT_APPLY_OWNER_REQUIRED'; end if;
  perform private.assert_my_stuff_test_clock_empty_v4();
  {lock_check}
  {concurrency_check}
  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '{EXPECTED_LEDGER_HEAD}' then raise exception 'REMOTE_MIGRATION_LEDGER_HEAD_MISMATCH'; end if;
  if exists(select 1 from supabase_migrations.schema_migrations where version='{VERSION}') then raise exception 'DEFINITION_EDIT_ALREADY_RECORDED'; end if;
  if to_regprocedure('{SIGNATURE}') is not null then raise exception 'DEFINITION_EDIT_OBJECT_ALREADY_PRESENT'; end if;
  if to_regprocedure('{EXPORT_SIGNATURE}') is not null then raise exception 'INTEGRITY_EXPORT_OBJECT_ALREADY_PRESENT'; end if;
  if to_regprocedure('{STATE_SIGNATURE}') is null then raise exception 'PHASE1_STATE_RPC_MISSING'; end if;
  if to_regprocedure('{SETUP_SIGNATURE}') is null then raise exception 'PHASE1_SETUP_RPC_MISSING'; end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='my_stuff_maintenance_baselines' and column_name='anchor_mode') then raise exception 'BASELINE_ANCHOR_MODE_ALREADY_PRESENT'; end if;
  if not exists(select 1 from private.my_stuff_integrity_rollout_v4 where singleton and feature_enabled=false and legacy_retired=false) then raise exception 'PHASE1_NOT_INSTALLED_AND_DISABLED'; end if;
end
$guard$;
{body}insert into supabase_migrations.schema_migrations(version,name,statements)
values ('{VERSION}','{NAME}',array[{DELIMITER}{migration}{DELIMITER}]::text[]);
do $post$
declare fn oid:=to_regprocedure('{SIGNATURE}'); state_fn oid:=to_regprocedure('{STATE_SIGNATURE}'); setup_fn oid:=to_regprocedure('{SETUP_SIGNATURE}'); export_fn oid:=to_regprocedure('{EXPORT_SIGNATURE}'); report_fn oid:=to_regprocedure('{REPORT_SIGNATURE}');
begin
  perform private.assert_my_stuff_test_clock_empty_v4();
  {lock_check}
  {concurrency_check}
  if fn is null
     or state_fn is null
     or setup_fn is null
     or export_fn is null
     or report_fn is null
     or not (pg_get_functiondef(report_fn) ~ 'remaining_count\\s*:=\\s*\\(?remaining_count\\s*-\\s*returned_count\\)?')
     or position('planned_occurrence_id' in pg_get_functiondef(state_fn))=0
     or position('anchor_mode' in pg_get_functiondef(setup_fn))=0
     or position('current_hours' in pg_get_functiondef(setup_fn))=0
     or position('current_cycles' in pg_get_functiondef(setup_fn))=0
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='my_stuff_maintenance_baselines' and column_name='anchor_mode')
     or to_regclass('private.my_stuff_integrity_export_manifest_v4') is null
     or has_table_privilege('authenticated','private.my_stuff_integrity_export_manifest_v4','SELECT')
     or has_table_privilege('anon','private.my_stuff_integrity_export_manifest_v4','SELECT')
     or has_table_privilege('service_role','private.my_stuff_integrity_export_manifest_v4','SELECT')
     or (select count(*) from supabase_migrations.schema_migrations where version='{VERSION}')<>1
     or (select max(version) from supabase_migrations.schema_migrations) is distinct from '{VERSION}'
     or not exists(select 1 from private.my_stuff_integrity_rollout_v4 where singleton and feature_enabled=false and legacy_retired=false)
     or not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE')
     or has_function_privilege('service_role',fn,'EXECUTE')
     or not has_function_privilege('authenticated',setup_fn,'EXECUTE')
     or has_function_privilege('anon',setup_fn,'EXECUTE')
     or has_function_privilege('service_role',setup_fn,'EXECUTE')
     or not has_function_privilege('authenticated',state_fn,'EXECUTE')
     or has_function_privilege('anon',state_fn,'EXECUTE')
     or has_function_privilege('service_role',state_fn,'EXECUTE')
     or not has_function_privilege('authenticated',export_fn,'EXECUTE')
     or has_function_privilege('anon',export_fn,'EXECUTE')
     or has_function_privilege('service_role',export_fn,'EXECUTE')
     or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid in(fn,state_fn,setup_fn,export_fn,report_fn) and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'DEFINITION_EDIT_POSTCONDITION_FAILED';
  end if;
end
$post$;
commit;
select jsonb_build_object(
  'candidate_rows',(select count(*) from supabase_migrations.schema_migrations where version='{VERSION}'),
  'ledger_head',(select max(version) from supabase_migrations.schema_migrations),
  'function_present',to_regprocedure('{SIGNATURE}') is not null,
  'state_function_present',to_regprocedure('{STATE_SIGNATURE}') is not null,
  'state_authenticated_execute',has_function_privilege('authenticated','{STATE_SIGNATURE}','EXECUTE'),
  'state_anon_execute',has_function_privilege('anon','{STATE_SIGNATURE}','EXECUTE'),
  'state_service_role_execute',has_function_privilege('service_role','{STATE_SIGNATURE}','EXECUTE'),
  'state_returns_planned_occurrence',position('planned_occurrence_id' in pg_get_functiondef(to_regprocedure('{STATE_SIGNATURE}'))) > 0,
  'baseline_anchor_mode_present',exists(select 1 from information_schema.columns where table_schema='public' and table_name='my_stuff_maintenance_baselines' and column_name='anchor_mode'),
  'setup_function_present',to_regprocedure('{SETUP_SIGNATURE}') is not null,
  'export_function_present',to_regprocedure('{EXPORT_SIGNATURE}') is not null,
  'report_after_page_remaining',pg_get_functiondef(to_regprocedure('{REPORT_SIGNATURE}')) ~ 'remaining_count\\s*:=\\s*\\(?remaining_count\\s*-\\s*returned_count\\)?',
  'export_manifest_present',to_regclass('private.my_stuff_integrity_export_manifest_v4') is not null,
  'feature_enabled',(select feature_enabled from private.my_stuff_integrity_rollout_v4 where singleton),
  'legacy_retired',(select legacy_retired from private.my_stuff_integrity_rollout_v4 where singleton),
  'authenticated_execute',has_function_privilege('authenticated','{SIGNATURE}','EXECUTE'),
  'anon_execute',has_function_privilege('anon','{SIGNATURE}','EXECUTE'),
  'service_role_execute',has_function_privilege('service_role','{SIGNATURE}','EXECUTE')
);
"""
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"query": query}, handle, separators=(",", ":"))
            handle.write("\n")
    except Exception:
        output.unlink(missing_ok=True)
        raise
    print(f"prepared {output} sha256={digest} version={VERSION}")


if __name__ == "__main__":
    main()
