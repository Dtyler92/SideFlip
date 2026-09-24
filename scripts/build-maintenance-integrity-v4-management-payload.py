#!/usr/bin/env python3
"""Build, but never submit, the exact Phase 1 Management API payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

VERSION = "20260924120000"
NAME = "maintenance_integrity_v4"
EXPECTED_SHA256 = "fdf0947ab38b55cc91e696466e2f542b90a6e142c068782658297e145d2542d5"
EXPECTED_LEDGER_HEAD = "20260923120000"
LOCK_NAME = "sideflip-exclusive-database-release-window"
DELIMITER = "$sideflip_maintenance_v4_phase1$"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="owner-only JSON payload path")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    migration_path = root / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
    migration = migration_path.read_text(encoding="utf-8")
    digest = hashlib.sha256(migration.encode()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"migration hash mismatch: expected {EXPECTED_SHA256}, got {digest}")
    if DELIMITER in migration:
        raise SystemExit("ledger dollar-quote delimiter collides with migration body")

    lock_check = f"""
  if not exists (
    select 1 from pg_locks
    where locktype='advisory' and pid=pg_backend_pid() and granted
      and classid=(((hashtextextended('{LOCK_NAME}',0) >> 32) & 4294967295)::oid)
      and objid=((hashtextextended('{LOCK_NAME}',0) & 4294967295)::oid)
  ) then raise exception 'EXCLUSIVE_DATABASE_RELEASE_LOCK_LOST'; end if;
"""
    concurrency_check = """
  if exists (
    select 1 from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid()
      and backend_type='client backend' and state<>'idle'
      and (
        application_name ~* '(supabase[-_ ]?cli|migration|migrate)'
        or query ~* '(supabase_migrations[.]schema_migrations|alter[[:space:]]+table|create[[:space:]]+(table|or[[:space:]]+replace[[:space:]]+function)|drop[[:space:]]+(table|function)|grant[[:space:]]|revoke[[:space:]])'
      )
  ) then raise exception 'CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED'; end if;
"""
    guard = f"""select pg_advisory_lock(hashtextextended('{LOCK_NAME}',0));
begin;
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$
begin
  if current_user<>'postgres' or session_user<>'postgres' then raise exception 'MANAGEMENT_APPLY_OWNER_REQUIRED'; end if;
{lock_check}{concurrency_check}  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '{EXPECTED_LEDGER_HEAD}' then raise exception 'REMOTE_MIGRATION_LEDGER_HEAD_MISMATCH'; end if;
  if exists(select 1 from supabase_migrations.schema_migrations where version='{VERSION}') then raise exception 'PHASE1_ALREADY_RECORDED'; end if;
  if to_regclass('private.my_stuff_maintenance_test_clock_v4') is not null or to_regclass('private.my_stuff_integrity_rollout_v4') is not null then raise exception 'PHASE1_OBJECTS_ALREADY_PRESENT'; end if;
end
$guard$;
commit;
"""
    ledger = f"""
begin;
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $mid$
begin
{lock_check}{concurrency_check}  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '{EXPECTED_LEDGER_HEAD}'
     or exists(select 1 from supabase_migrations.schema_migrations where version='{VERSION}') then
    raise exception 'REMOTE_MIGRATION_LEDGER_CHANGED_DURING_RELEASE';
  end if;
  if not exists(select 1 from private.my_stuff_integrity_rollout_v4 where singleton and feature_enabled=false and legacy_retired=false) then raise exception 'PHASE1_NOT_DISABLED'; end if;
  if exists(select 1 from private.my_stuff_maintenance_test_clock_v4) then raise exception 'PRODUCTION_TEST_CLOCK_NOT_EMPTY'; end if;
end
$mid$;
insert into supabase_migrations.schema_migrations(version,name,statements)
values ('{VERSION}','{NAME}',array[{DELIMITER}{migration}{DELIMITER}]::text[]);
do $post$
begin
{lock_check}{concurrency_check}  if (select count(*) from supabase_migrations.schema_migrations where version='{VERSION}')<>1
     or (select max(version) from supabase_migrations.schema_migrations) is distinct from '{VERSION}'
     or not exists(select 1 from private.my_stuff_integrity_rollout_v4 where singleton and feature_enabled=false and legacy_retired=false)
     or exists(select 1 from private.my_stuff_maintenance_test_clock_v4)
     or exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects' and not t.tgisinternal and t.tgname ilike '%my_stuff%') then
    raise exception 'PHASE1_OBJECT_POSTCONDITION_FAILED';
  end if;
end
$post$;
commit;
select jsonb_build_object(
  'candidate_rows',(select count(*) from supabase_migrations.schema_migrations where version='{VERSION}'),
  'ledger_head',(select max(version) from supabase_migrations.schema_migrations),
  'feature_enabled',(select feature_enabled from private.my_stuff_integrity_rollout_v4 where singleton),
  'legacy_retired',(select legacy_retired from private.my_stuff_integrity_rollout_v4 where singleton),
  'test_clock_rows',(select count(*) from private.my_stuff_maintenance_test_clock_v4),
  'storage_trigger_rows',(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects' and not t.tgisinternal and t.tgname ilike '%my_stuff%')
);
select pg_advisory_unlock(hashtextextended('{LOCK_NAME}',0));
"""
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"query": guard + migration + ledger}, handle, separators=(",", ":"))
            handle.write("\n")
    except Exception:
        output.unlink(missing_ok=True)
        raise
    print(f"prepared {output} sha256={digest} version={VERSION}")


if __name__ == "__main__":
    main()
