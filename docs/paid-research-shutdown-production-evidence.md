# Production paid-maintenance-research shutdown evidence

## Scope

Production project: `sueeubsglcnanecvltms`

Applied only migration `20260923120000_retire_paid_maintenance_research.sql` from commit `7b1f040`.

Migration SHA-256: `410a86ee3a1e424606a1fc089d16603c16f0f7930cee78277aa6bedae401d759`

The separately approved cleanup removed only:

- Edge Function `maintenance-research-worker`
- Edge Function secret `XAI_API_KEY`
- Vault secret `maintenance_research_worker_url`
- Vault secret `maintenance_research_worker_secret`

Shared Supabase secrets, unrelated functions, and the separate `MAINTENANCE_RESEARCH_WORKER_SECRET` Edge secret were not removed.

## Preflight

The immediate preflight passed all mandatory gates:

- Database/session identities: `postgres` / `postgres`
- Ledger head: `20260922190000`
- Candidate absent
- Excluded migration `20260922233000` absent
- Runtime singleton rows: `1`
- Running and queued jobs: `0`
- Attempted document executions: `0`
- Remote-unknown document executions: `0`
- Orphan/state mismatches: `0`
- Pending jobs without executions: `0`
- Concurrent migration activity: `0`
- Research cron rows before shutdown: `1`

The generated Management API payload was mode `0600` and the migration hash was independently confirmed before its single submission.

## Database apply and readback

The Management API returned HTTP `201`. Immediate independent readback established:

- Candidate ledger rows: `1`
- Stored migration-body SHA-256 matches the pinned hash
- Excluded migration rows: `0`
- Research runtime enabled: `false`
- Document lane enabled: `false`
- Research cron rows: `0`
- Executable jobs: `0`
- Queue messages: `0`
- Dangerous client/service execute grants: `0`
- Concurrent migration activity: `0`
- Operator activation raises exactly `RESEARCH_RETIRED`

The dangerous-grant readback includes the retired enqueue RPCs, proving authenticated execution is denied.

## Cleanup readback

After database verification:

- Edge Function list contains no `maintenance-research-worker`
- The retired endpoint returns HTTP `404` with `NOT_FOUND`
- Edge Function secret names contain no `XAI_API_KEY`
- Both targeted Vault secret names have count `0`
- Shared Supabase secret names remain present
- Database shutdown postconditions remained unchanged after cleanup

Production paid maintenance research is retired. Historical schedules and accounting records remain preserved by the migration.
