#!/usr/bin/env python3
"""Build, but never submit, the exact Management API query payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

VERSION = "20260923120000"
NAME = "retire_paid_maintenance_research"
EXPECTED_SHA256 = "410a86ee3a1e424606a1fc089d16603c16f0f7930cee78277aa6bedae401d759"
EXPECTED_LEDGER_HEAD = "20260922190000"
EXCLUDED_VERSION = "20260922233000"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="owner-only JSON payload path")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    migration_path = root / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
    migration = migration_path.read_text(encoding="utf-8")
    digest = hashlib.sha256(migration.encode("utf-8")).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"migration hash mismatch: expected {EXPECTED_SHA256}, got {digest}")
    if "$sideflip_shutdown_migration$" in migration:
        raise SystemExit("ledger dollar-quote delimiter collides with migration body")

    concurrency_gate = """
  if exists (
    select 1
    from pg_stat_activity
    where datname=current_database()
      and pid<>pg_backend_pid()
      and backend_type='client backend'
      and state<>'idle'
      and (
        application_name ~* '(supabase[-_ ]?cli|migration|migrate)'
        or query ~* '(supabase_migrations[.]schema_migrations|alter[[:space:]]+table|create[[:space:]]+(table|or[[:space:]]+replace[[:space:]]+function)|drop[[:space:]]+(table|function)|grant[[:space:]]|revoke[[:space:]])'
      )
  ) then
    raise exception 'CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED';
  end if;
"""
    lock_assertion = """
  if not exists (
    select 1
    from pg_locks
    where locktype='advisory'
      and pid=pg_backend_pid()
      and granted
      and classid=(((hashtextextended('sideflip-exclusive-database-release-window',0) >> 32) & 4294967295)::oid)
      and objid=((hashtextextended('sideflip-exclusive-database-release-window',0) & 4294967295)::oid)
  ) then
    raise exception 'EXCLUSIVE_DATABASE_RELEASE_LOCK_LOST';
  end if;
"""

    guard = f"""
select pg_advisory_lock(hashtextextended('sideflip-exclusive-database-release-window',0));
begin;
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'MANAGEMENT_APPLY_OWNER_REQUIRED';
  end if;
{lock_assertion}{concurrency_gate}  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '{EXPECTED_LEDGER_HEAD}' then
    raise exception 'REMOTE_MIGRATION_LEDGER_HEAD_MISMATCH';
  end if;
  if exists (
    select 1 from supabase_migrations.schema_migrations
    where version in ('{VERSION}','{EXCLUDED_VERSION}')
  ) then
    raise exception 'REMOTE_MIGRATION_MANIFEST_MISMATCH';
  end if;
end
$guard$;
commit;
"""

    ledger = f"""
begin;
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $mid$
begin
{lock_assertion}{concurrency_gate}  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '{EXPECTED_LEDGER_HEAD}'
     or exists(select 1 from supabase_migrations.schema_migrations where version in ('{VERSION}','{EXCLUDED_VERSION}')) then
    raise exception 'REMOTE_MIGRATION_LEDGER_CHANGED_DURING_RELEASE';
  end if;
end
$mid$;
insert into supabase_migrations.schema_migrations(version,name,statements)
values (
  '{VERSION}',
  '{NAME}',
  array[$sideflip_shutdown_migration${migration}$sideflip_shutdown_migration$]::text[]
);
do $post$
declare
  v_document_lane_disabled boolean := true;
begin
{lock_assertion}{concurrency_gate}  if exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='my_stuff_research_runtime_config'
      and column_name='document_lane_enabled'
  ) then
    execute 'select document_lane_enabled=false from private.my_stuff_research_runtime_config where singleton'
      into v_document_lane_disabled;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version='{VERSION}')<>1
     or (select max(version) from supabase_migrations.schema_migrations) is distinct from '{VERSION}'
     or exists(select 1 from supabase_migrations.schema_migrations where version='{EXCLUDED_VERSION}')
     or not exists(select 1 from private.my_stuff_research_runtime_config where singleton and enabled=false)
     or not v_document_lane_disabled
     or exists(select 1 from cron.job where jobname='sideflip-maintenance-research-worker')
     or exists(select 1 from private.my_stuff_research_jobs where status in ('queued','running','document_queued','document_pending'))
     or exists(select 1 from pgmq.q_my_stuff_research_v1) then
    raise exception 'REMOTE_MIGRATION_OBJECT_POSTCONDITION_FAILED';
  end if;
end
$post$;
commit;
select jsonb_build_object(
  'candidate_rows',(select count(*) from supabase_migrations.schema_migrations where version='{VERSION}'),
  'ledger_head',(select max(version) from supabase_migrations.schema_migrations),
  'excluded_rows',(select count(*) from supabase_migrations.schema_migrations where version='{EXCLUDED_VERSION}'),
  'runtime_disabled',exists(select 1 from private.my_stuff_research_runtime_config where singleton and enabled=false),
  'research_cron_rows',(select count(*) from cron.job where jobname='sideflip-maintenance-research-worker'),
  'executable_jobs',(select count(*) from private.my_stuff_research_jobs where status in ('queued','running','document_queued','document_pending')),
  'queue_messages',(select count(*) from pgmq.q_my_stuff_research_v1)
);
select pg_advisory_unlock(hashtextextended('sideflip-exclusive-database-release-window',0));
"""

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(output, flags, 0o600)
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
