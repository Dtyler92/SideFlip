# VIN decode operations

This migration is review-only. Do not apply it to Production until the API-function consolidation branch is merged and the deployment is explicitly approved; `/api/decode-vin` depends on that consolidation to stay within the Vercel top-level function quota.

## Bounded retention job

After the migration is applied, schedule the service-only cleanup RPC hourly. Each call deletes at most 500 expired cache rows and 500 rate-limit rows whose `updated_at` is older than seven days. It never scans or deletes an unbounded set in one transaction.

For Supabase Cron, create the job as a database owner after confirming `pg_cron` is enabled:

```sql
select cron.schedule(
  'sideflip-vin-state-cleanup',
  '17 * * * *',
  $$select public.cleanup_vin_decode_state(500, null, null);$$
);
```

Operational fallback (service/database operator):

```sql
select public.cleanup_vin_decode_state(500, null, null);
```

Monitor the returned `expired_cache_deleted` and `stale_rate_limits_deleted` counts. A count of 500 means backlog remains; repeat at a controlled cadence rather than raising the 1,000-row hard bound.

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

The harness creates a temporary PostgreSQL database, applies the fixture and migration, exercises actual RPC execution/grants/limits/retention/key-version isolation, and drops the database on exit.
