# Paid maintenance research shutdown release manifest

**Prepared only. Do not apply without the exact approval at the end of this file.**

## Pinned artifact

- Canonical backend base: `345b81761a7524c411d0b5efa87934cf24134047`
- Candidate: `supabase/migrations/20260923120000_retire_paid_maintenance_research.sql`
- Version: `20260923120000`
- SHA-256: `410a86ee3a1e424606a1fc089d16603c16f0f7930cee78277aa6bedae401d759`
- Required live ledger head: `20260922190000`
- Explicitly excluded/unapproved: `20260922233000_lower_research_spend_caps.sql`
- Normal `supabase db push` is forbidden for this release because remote-only history and the excluded lower-cap migration make the local CLI manifest non-authoritative.

## Exclusive database-release window (mandatory)

This is an operational freeze, not a claim that PostgreSQL can make an intentional multi-commit release globally atomic. Before preflight, stop every other database migration agent, CI migration job, Supabase CLI process, SQL Editor operator, and automation capable of DDL or migration-ledger writes. Name one release operator, announce the freeze, and keep it in force until the candidate ledger and shutdown objects have been read back. Do not run `supabase db push`, `migration up`, or a second Management API query concurrently.

The generated Management API query takes `pg_advisory_lock(hashtextextended('sideflip-exclusive-database-release-window',0))` before its first transaction, verifies that session lock before and after the migration's intentional commits, performs fresh `pg_stat_activity` and migration-ledger checks before execution, before ledger insertion, and after insertion, and releases the lock only after immediate object readback. This protects the whole request only if the Management API executes the submitted SQL on one database session, as the disposable rehearsal verifies. A generic concurrent CLI or operator that does not cooperate with this advisory lock cannot be made transactionally impossible across the intentional commits; the release therefore **must stop all other migration agents and operators**. The activity checks are a fail-closed detection layer, not a substitute for that freeze.

## Read-only production preflight

Use the project reference derived from SideFlip's canonical deployed Supabase URL. Do not select a project from profile memory. With an authenticated Management API token, submit only this metadata/count query to `POST https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query`:

```sql
select jsonb_build_object(
  'current_user',current_user,
  'session_user',session_user,
  'ledger_head',(select max(version) from supabase_migrations.schema_migrations),
  'candidate_present',exists(select 1 from supabase_migrations.schema_migrations where version='20260923120000'),
  'excluded_present',exists(select 1 from supabase_migrations.schema_migrations where version='20260922233000'),
  'runtime_rows',(select count(*) from private.my_stuff_research_runtime_config),
  'running_jobs',(select count(*) from private.my_stuff_research_jobs where status='running'),
  'queued_jobs',(select count(*) from private.my_stuff_research_jobs where status in ('queued','document_queued')),
  'research_cron_rows',(select count(*) from cron.job where jobname='sideflip-maintenance-research-worker'),
  'document_table_present',to_regclass('private.my_stuff_document_executions') is not null,
  'concurrent_migration_activity',(
    select count(*) from pg_stat_activity
    where datname=current_database()
      and pid<>pg_backend_pid()
      and backend_type='client backend'
      and state<>'idle'
      and (
        application_name ~* '(supabase[-_ ]?cli|migration|migrate)'
        or query ~* '(supabase_migrations[.]schema_migrations|alter[[:space:]]+table|create[[:space:]]+(table|or[[:space:]]+replace[[:space:]]+function)|drop[[:space:]]+(table|function)|grant[[:space:]]|revoke[[:space:]])'
      )
  )
);
```

Hard gates: both identities are `postgres`; ledger head is exactly `20260922190000`; candidate and excluded versions are absent; runtime row count is exactly one; running count and concurrent migration activity are zero. Reconfirm the operational freeze immediately before submission. If the document table is present, run the following count-only query and require every uncertainty/inconsistency count to be zero before apply:

```sql
select jsonb_build_object(
  'attempted',(select count(*) from private.my_stuff_document_executions where state='attempted'),
  'remote_unknown',(select count(*) from private.my_stuff_document_executions where transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')),
  'orphan_or_state_mismatch',(
    select count(*)
    from private.my_stuff_document_executions e
    left join private.my_stuff_research_jobs j on j.id=e.job_id
    where j.id is null
       or (e.state='ready' and j.status<>'document_pending')
       or (e.state='completed' and j.status<>'document_complete')
       or (e.state='failed' and j.status<>'document_failed')
  ),
  'pending_without_execution',(
    select count(*)
    from private.my_stuff_research_jobs j
    left join private.my_stuff_document_executions e on e.job_id=j.id
    where j.status='document_pending' and e.job_id is null
  )
);
```

The migration independently repeats these guards. Its first transaction deliberately commits `enabled=false`, optional `document_lane_enabled=false`, and cron removal before its second guarded transaction. If reconciliation aborts, do not retry blindly: production remains fail-closed, the migration ledger remains unchanged, and the returned reconciliation error must be investigated.

## Exact Management API apply payload

Generate the owner-only payload offline; the builder verifies the pinned hash and never connects to Supabase:

```bash
python3 scripts/build-paid-research-shutdown-management-payload.py \
  --output "$TMPDIR/sideflip-paid-research-shutdown-management.json"
```

Inspect permissions (`0600`) and independently verify the migration hash. After explicit approval, submit that unchanged JSON exactly once with a normal explicit user agent to:

```text
POST https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN
Content-Type: application/json
User-Agent: supabase-cli/management-migration
```

The generated query:

1. takes and retains the session advisory lock for the exclusive release window, then asserts it remains held around every intentional commit;
2. asserts `current_user=session_user=postgres`;
3. locks and freshly asserts the exact ledger head, absence of both candidate and excluded versions, and absence of detected concurrent migration activity before execution and again before ledger insertion;
4. executes the hash-pinned migration unchanged, including its intentional two-transaction fail-closed boundary;
5. inserts only `20260923120000` into `supabase_migrations.schema_migrations`, storing the exact migration body in `statements`;
6. freshly asserts the new head, continued absence of `20260922233000`, disabled runtime/document lane, no cron, no executable job, and an empty queue;
7. returns a ledger/object readback and then releases the session advisory lock.

A non-2xx response, timeout, connection reset, or missing/malformed response body is ambiguous because phase one, phase two, or the ledger transaction may already have committed. **Do not resubmit.** While keeping the exclusive window closed, immediately run the complete read-only query in “Immediate post-DB verification” and classify the state from the candidate ledger row/hash plus every object count. If the candidate is absent but shutdown objects changed, the release is fail-closed and requires investigation; if the candidate and all object postconditions are exact, treat the migration as applied despite the transport result. Any other combination is a hard stop. Delete the local JSON payload only after this readback establishes the state.

## Immediate post-DB verification

Use one read-only Management API query. Return counts/booleans only—no application rows or secret values:

```sql
select jsonb_build_object(
  'candidate_rows',(select count(*) from supabase_migrations.schema_migrations where version='20260923120000'),
  'candidate_body_sha256',(
    select encode(extensions.digest(array_to_string(statements,E'\n'),'sha256'),'hex')
    from supabase_migrations.schema_migrations
    where version='20260923120000'
  ),
  'excluded_rows',(select count(*) from supabase_migrations.schema_migrations where version='20260922233000'),
  'enabled',(select enabled from private.my_stuff_research_runtime_config where singleton),
  'research_cron_rows',(select count(*) from cron.job where jobname='sideflip-maintenance-research-worker'),
  'executable_jobs',(select count(*) from private.my_stuff_research_jobs where status in ('queued','running','document_queued','document_pending')),
  'queue_messages',(select count(*) from pgmq.q_my_stuff_research_v1),
  'concurrent_migration_activity',(
    select count(*) from pg_stat_activity
    where datname=current_database()
      and pid<>pg_backend_pid()
      and backend_type='client backend'
      and state<>'idle'
      and (
        application_name ~* '(supabase[-_ ]?cli|migration|migrate)'
        or query ~* '(supabase_migrations[.]schema_migrations|alter[[:space:]]+table|create[[:space:]]+(table|or[[:space:]]+replace[[:space:]]+function)|drop[[:space:]]+(table|function)|grant[[:space:]]|revoke[[:space:]])'
      )
  ),
  'dangerous_execute_grants',(
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    cross join unnest(array['anon','authenticated','service_role']) role_name
    where n.nspname in ('public','private')
      and has_function_privilege(role_name,p.oid,'EXECUTE')
      and (
        (p.proname like '%my_stuff_research%' and not (n.nspname='public' and p.proname in ('get_my_stuff_research_status_v1','get_my_stuff_research_review_v1','get_my_stuff_research_review_v2')))
        or p.proname in ('enqueue_my_document_job_v1','prepare_document_job_v1','read_document_job_v1','claim_document_job_v1','claim_document_job_v1_atomic','lease_document_dispatch_v1','recover_document_dispatch_v1','reconcile_document_usage_v1','observe_document_transport_v1','get_document_transport_status_v1','authorize_document_transport_release_v1','finalize_document_job_v1','fail_document_preflight_v1','fail_document_job_v1','fail_document_job_v2','assert_document_job_v1','document_binding_v1','settle_document_accounting_v1')
      )
  )
);
```

Require: candidate rows `1`; candidate hash equals the pinned SHA-256; excluded rows `0`; enabled `false`; cron, executable jobs, queue messages, concurrent migration activity, and dangerous grants all `0`. If `document_lane_enabled` exists, separately require it to be `false`. Confirm an authenticated call to `enqueue_my_stuff_research_v3` is denied and an owner call to `private.activate_my_stuff_research_v1()` raises exactly `RESEARCH_RETIRED`. Only then may the release operator end the exclusive database-release window.

## Separately approved post-DB Edge Function and Vault cleanup

Only after every DB verification above passes:

1. Delete/undeploy the Supabase Edge Function **`maintenance-research-worker`**. Verify it is absent from the project function list and its old endpoint no longer executes (expected not-found response).
2. Remove the function-only Edge secret **`XAI_API_KEY`**. Do not remove shared `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` values used by other functions. Verify only secret-name absence; never print values.
3. Delete only Vault secrets named **`maintenance_research_worker_url`** and **`maintenance_research_worker_secret`**:

   ```sql
   select vault.delete_secret(id)
   from vault.secrets
   where name in ('maintenance_research_worker_url','maintenance_research_worker_secret');
   ```

4. Read back metadata only: the two Vault names count `0`; the Edge Function is absent; `XAI_API_KEY` is absent; runtime and document lane remain false; cron/queue/executable-job/dangerous-grant counts remain zero.

These cleanup steps are not included in the database-migration approval and require the separate sentence below.

## Exact approval text

> I approve applying only SideFlip migration `20260923120000_retire_paid_maintenance_research.sql` with SHA-256 `410a86ee3a1e424606a1fc089d16603c16f0f7930cee78277aa6bedae401d759` to production project `<SUPABASE_PROJECT_REF>`, only during the exclusive database-release window defined in this manifest, only if every other migration agent and operator is stopped, and only if the read-only preflight shows ledger head `20260922190000`, version `20260922233000` absent, one runtime singleton, and no running, attempted, in-flight, remote-unknown, inconsistent document execution, or detected concurrent migration activity. I understand the session advisory lock is held across intentional commits only if the Management API keeps one database session for the whole request, generic concurrent migration CLIs cannot be made transactionally impossible across those commits, and phase one remains fail-closed if guarded reconciliation aborts. I do not approve any other migration, deploy, function deletion, or secret change.

Separate cleanup approval, after verified DB shutdown:

> I approve deleting only the `maintenance-research-worker` Edge Function, the function-only `XAI_API_KEY` Edge secret, and Vault secrets `maintenance_research_worker_url` and `maintenance_research_worker_secret`, followed by the metadata-only readback in this manifest. I do not approve removal of shared Supabase secrets or any other deployment/change.
