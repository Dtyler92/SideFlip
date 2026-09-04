# VIN decode operations

These migrations are review-only. Do not apply them to Production until the API-function consolidation branch is merged and the deployment is explicitly approved; `/api/decode-vin` depends on that consolidation to stay within the Vercel top-level function quota.

## Bounded retention job

`20260903210000_schedule_vin_decode_cleanup.sql` runs after the VIN schema migration and installs the operational gate. It requires `pg_cron`, replaces any same-name job, and creates exactly one active hourly job:

```sql
select public.cleanup_vin_decode_state(500, null, null);
```

Each call deletes at most 500 expired cache rows and 500 rate-limit rows whose `updated_at` is older than seven days. It never scans or deletes an unbounded set in one transaction. The migration contains no credential and does not change RPC grants; the cleanup RPC remains executable only by `service_role` (and PostgreSQL owner/superuser contexts such as the cron worker).

The migration fails and rolls back if `pg_cron` cannot be installed, the bounded cleanup function or cron API is missing, an existing job cannot be removed, or the final job is missing, altered, inactive, or duplicated. Do not mark the database migration complete or deploy the VIN route if this gate fails.

### Post-migration verification SQL

Run as the database owner immediately after applying the migrations:

```sql
select jobid, jobname, schedule, command, active, database, username
from cron.job
where jobname = 'sideflip-vin-state-cleanup';
```

Expected: exactly one row with schedule `17 * * * *`, command `select public.cleanup_vin_decode_state(500, null, null);`, and `active = true`. Use this assertion to make an incorrect state fail the verification step:

```sql
do $$
begin
  if (
    select count(*)
    from cron.job
    where jobname = 'sideflip-vin-state-cleanup'
      and schedule = '17 * * * *'
      and command = 'select public.cleanup_vin_decode_state(500, null, null);'
      and active
  ) <> 1
  or (select count(*) from cron.job where jobname = 'sideflip-vin-state-cleanup') <> 1 then
    raise exception 'VIN cleanup cron job verification failed';
  end if;
end
$$;
```

Monitor `cron.job_run_details` for this `jobid`, checking `status`, `return_message`, and timestamps for failed or missing runs. PostgreSQL Cron does not retain the cleanup function's returned JSON deletion counts. To measure a suspected backlog, a database operator must invoke the bounded function directly (or add separate durable metrics). If a direct invocation reports 500 deleted cache or limiter rows, backlog remains; repeat it manually at a controlled cadence rather than raising the 1,000-row hard bound.

Operational fallback and bounded backlog measurement for a service/database operator while diagnosing a failed scheduled run:

```sql
select public.cleanup_vin_decode_state(500, null, null);
```

The fallback is not a substitute for restoring and re-verifying the hourly job.

The route uses the same RPC with a batch of 100 and an exact `(hmac_key_version, vin_hmac)` pair to quarantine a malformed cache row before obtaining a fresh decode. No raw VIN is passed or stored.

## HMAC key rotation and retirement

- `VIN_CACHE_HMAC_KEY_VERSION` is the positive integer version used for new writes.
- `VIN_CACHE_HMAC_SECRET` is the active secret (minimum 32 UTF-8 bytes).
- `VIN_CACHE_HMAC_PREVIOUS_KEYS` is an optional JSON object mapping prior numeric versions to prior secrets, for example `{"1":"<old-secret>"}`.
- To rotate, deploy a higher active version and secret while listing the prior key in `VIN_CACHE_HMAC_PREVIOUS_KEYS`. Reads of a prior-version row are copied under the active version.
- Keep the prior key available for at least the 30-day cache TTL, then remove it. Once removed, the route cannot derive or query that version's HMAC; remaining rows expire and the bounded cleanup job removes them.
- Never reuse a key version for different secret material. Never log or place HMAC secrets in SQL, client code, or migration history.

## Disposable local verification

```bash
npm run test:vin:postgres
```

The harness creates a temporary PostgreSQL database, applies the VIN schema and operational migration twice, exercises actual scheduling, RPC execution, grants, limits, retention, key-version isolation, and asserts that replay leaves exactly one deterministic hourly job. When the local host lacks the `pg_cron` package, its fixture supplies a minimal compatible `cron` catalog/API while the production migration retains mandatory extension installation and fail-closed semantics. The harness drops the database on exit.
