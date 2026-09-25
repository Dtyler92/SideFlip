# Maintenance Integrity V4 wire and rollout contract

## Release order

### Phase 1 — additive install only

Apply only `20260924120000_maintenance_integrity_v4.sql`, after the complete historical stack and paid-research shutdown. It installs nullable columns, constraints, indexes, new tables, and disabled V4 RPCs. `feature_enabled` remains `false`.

Production's migration ledger contains remote-only history, so a normal `supabase db push` from this checkout is forbidden. Build the hash-pinned, owner-only Management API payload with `scripts/build-maintenance-integrity-v4-management-payload.py`. The builder requires SHA-256 `fdf0947ab38b55cc91e696466e2f542b90a6e142c068782658297e145d2542d5`, ledger head `20260923120000`, PostgreSQL owner execution, an exclusive advisory-locked release window, no concurrent migration activity, and absent Phase 1 objects. The payload applies the unchanged migration, records only version `20260924120000`, and verifies that `feature_enabled=false`, `legacy_retired=false`, the test clock is empty, and no My Stuff trigger exists on `storage.objects`.

Do not resubmit after a timeout or ambiguous transport response. Keep the exclusive release window closed and classify the result with a read-only ledger/object query first.

Phase 1 is state-preserving. It does not unarchive items, enable or disable definitions, label legacy lifecycle rows, reconcile duplicates, replace existing trigger functions, install a trigger on `storage.objects`, revoke any released-client path, or activate V4. Legacy writes retain their prior defaults and behavior.

The deterministic test clock must be empty before and after installation. It can only be populated in disposable databases named `sideflip_maintenance_v4_<pid>` and is inaccessible to browser and service roles.

```sql
select case when to_regclass('private.my_stuff_maintenance_test_clock_v4') is null then 0
            else (select count(*) from private.my_stuff_maintenance_test_clock_v4) end;
```

Then ship compatible PWA, iOS, and Android clients and deploy the deletion worker. The reusable core is `api/_lib/my-stuff-deletion-worker.js`; `scripts/maintenance-deletion-worker.mjs` is the standalone entry point. The PWA deployment uses the same core through the cron-authenticated `api/_lib/maintenance-deletion-handler.js`, co-located in the existing dynamic server function to stay within Vercel's function budget. Phase 1 contains no activation RPC. Readiness is **not currently enforceable** and `service_role` cannot attest it.

### Future owner-only reconciliation and cutover

`docs/maintenance-integrity-v4-enforcement.sql.template` and `docs/maintenance-integrity-v4-cutover.sql.template` are intentionally blocked templates, not migrations. They live outside `supabase/migrations` so a normal migration push cannot apply them.

After releases exist, the owner must generate a new timestamped migration that hardcodes the exact PWA deployment ID, minimum iOS build, minimum Android build, worker deployment digest, and independently verified evidence. That migration must require `current_user` to be `postgres` or the current database owner. It must perform reviewed archive/duplicate reconciliation and legacy enforcement in the migration itself, with no caller strings, readiness booleans, browser execution, or `service_role` execution grant.

The approved release may commit, push, install Phase 1 through the exact reviewed payload, and deploy compatible clients and the worker. It may not activate V4 or apply either blocked cutover template.

## Common mutation rules

- `p_mutation_id` is a stable owner-scoped retry key. The request hash contains every business field and excludes `p_device_now` telemetry.
- Under the object advisory lock, an existing mutation is resolved before the fresh device-clock check. A delayed replay—even more than five minutes later with a newly transmitted `p_device_now`—returns the exact stored result. Reusing the key with altered business payload fails.
- A fresh mutation accepts exactly five minutes of skew (`<= 300` seconds); greater skew fails with `DEVICE_CLOCK_SKEW`.
- Server time determines `received_at`, `submitted_at`, and the 24-hour correction deadline.

## Completion and recurrence

`complete_my_stuff_maintenance_v4(uuid p_definition_id, jsonb p_completion, timestamptz p_device_now, text p_mutation_id) -> jsonb`

`service_performed_on` is stored in a dedicated `date` column. Optional `service_timezone` is validated against PostgreSQL timezone names (default `UTC`) and is stored separately; reads use the date column, so the business date is stable in extreme positive and negative session timezones. Mileage, hours, cycles, current readings, details, attachments, and linked expense remain optional and atomic.

When `planned_occurrence_id` is supplied, the same transaction creates the service occurrence/revision/audit/readings/optional expense, marks the planned occurrence completed, appends one `my_stuff_occurrence_status_events` completion event, and calls `materialize_my_stuff_next_occurrence_v3`. Mutation replay returns before repeating any effect.

Window edits and later corrections retain expected revision plus canonical SHA-256 conflict checks. Historical rows remain append-correctable, and original snapshots are never rewritten.

## Deletion worker contract

Owner RPCs:

```text
request_my_stuff_deletion_v4(text, uuid, text) -> jsonb
get_my_stuff_deletion_status_v4(uuid) -> jsonb
```

Service-role-only worker RPCs:

```text
claim_my_stuff_deletions_v4(text worker_id, integer batch_size, integer lease_seconds) -> jsonb
ack_my_stuff_deletion_storage_v4(uuid request_id, text worker_id, uuid lease_token,
                                 integer expected, integer deleted, integer remaining, text error) -> jsonb
finalize_my_stuff_deletion_v4(uuid request_id, text worker_id, uuid lease_token) -> jsonb
```

Claims use `FOR UPDATE SKIP LOCKED`, a bounded batch, worker identity, opaque lease token, deadline, and attempt count. Expired `leased`, `deleting_database`, and `verifying_storage` phases are recoverable. Every success/failure acknowledgement and finalization is worker/token/deadline fenced; stale tokens cannot finalize work. The deployed worker limits request count, Storage list page size, total objects, and delete batch size. Production accepts either the dedicated `MAINTENANCE_DELETION_CRON_SECRET` or the shared Vercel `CRON_SECRET`; Vercel Cron continues to use the shared secret while the dedicated secret permits isolated worker readiness checks without rotating analytics dispatch authentication.

The worker uses only the Supabase Storage API. It recursively paginates and deletes exactly `my-stuff-media/<uid>/items/<item-id>/...`, rejects the historical `<uid>/<item-id>/...` path, and performs an empty readback before storage acknowledgement. Item finalization removes the database item (closing the existing owner-write policy), enters `verifying_storage`, and requires a second exact-prefix drain/readback before `complete`; an upload raced between the first readback and database deletion is therefore removed rather than orphaned. SQL never deletes from `storage.objects`. Failures converge through a new lease. The Vercel wrapper accepts only a platform cron `GET` carrying an exact configured bearer secret, returns bounded aggregate counts, and never exposes per-request errors.

Definition deletion physically detaches and retains service occurrences, their revisions/audits/corrections/linked expenses/attachments, and nullable provisional `my_stuff_service_history`. Before deleting definition-owned planned/version/evidence rows, it copies every direct reference plus a complete occurrence graph snapshot into owner-readable `my_stuff_deleted_definition_history_v4`; exact detached/deleted counts reconcile to the pre-delete count. Item deletion remains asynchronous. Phase 1 does not revoke the old direct deletion path.

## Reports and verification

The V4 report remains server-generated, bounded, path-free, correction-chain complete, and SHA-256 identified. The SQL harness runs the actual `20260903190000_add_private_my_stuff_media.sql` and `20260907040000_harden_legacy_public_privileges.sql` migrations; only unavailable local extension services are stubbed. It preserves RED pre-migration checks, historical correction/revision/hash coverage, multi-axis due state, atomic expense behavior, recurrence, replay, timezone, lease recovery, concurrency, and report checks.
