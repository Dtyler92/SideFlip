# My Stuff private media storage contract

My Stuff media uses the dedicated private `my-stuff-media` bucket. It must not use the public `project-photos` bucket or change existing project-photo behavior. This migration creates the bucket and `storage.objects` policies tied to existing owned `my_stuff_items`; attachment metadata and upload endpoints remain future application work and no upload UI is exposed.

## Object and upload contract

- Maximum object size: **15 MiB**.
- Allowed declared photo types: JPEG, PNG, WebP, HEIC, and HEIF.
- Allowed declared receipt/invoice/document types: PDF, Word `.doc`, and Word `.docx`. Image receipts use the photo types above.
- The first segment is the authenticated user's UUID. The second segment is exactly `items`; the third is the record-scoped My Stuff item UUID. The final filename is an opaque generated object UUID plus a lower-case allow-listed extension.
- The migration's anchored policy expression accepts only the shapes below. It rejects extra nesting, user-provided filenames, non-UUID item/object IDs, unsupported extensions, cross-owner names, and other buckets.

Enforced paths:

```text
<user-id>/items/<item-id>/photos/<object-id>.<jpg|jpeg|png|webp|heic|heif>
<user-id>/items/<item-id>/before-after/<before|after>/<object-id>.<jpg|jpeg|png|webp|heic|heif>
<user-id>/items/<item-id>/<receipts|invoices|documents>/<object-id>.<jpg|jpeg|png|webp|heic|heif|pdf|doc|docx>
```

The path grammar limits arbitrary owner-prefix namespaces without coupling this migration to an unavailable attachment table. Every policy also requires the path's `<item-id>` to match an existing `my_stuff_items` row owned by `auth.uid()`, so caller-prefixed paths for nonexistent or another user's item are denied. This does not cap the number or aggregate bytes of objects under an owner. Before enabling uploads, the application still needs an authoritative attachment metadata/API contract and race-safe object-count and aggregate-byte quotas. RLS is not a quota system.

### MIME and parser safety

`allowed_mime_types` is a **declared content type only** allow-list supplied to the Storage service; it is not proof of the bytes, and an extension is not proof either. Before parsing any document/image or accepting attachment metadata, a trusted backend must read a bounded prefix, validate magic-byte/file-signature data against the intended type, reject polyglots or mismatches, apply decompression/page/pixel limits, and use a hardened parser. Office files require ZIP/container validation, not an extension check. Upload the validated canonical MIME as `contentType`; never parse unvalidated client bytes.

## Authorization semantics

All four policies are limited to `authenticated`, `my-stuff-media`, the caller's UUID prefix, an existing caller-owned item, and the full path grammar:

- download/list/signing requires `SELECT`;
- a new upload or copy destination requires `INSERT`;
- upsert requires `INSERT`, `SELECT`, and `UPDATE`; do not assume an insert-only policy is enough;
- rename/move requires `SELECT` and `UPDATE`, and `WITH CHECK` denies a new cross-owner or cross-bucket destination;
- removal requires `SELECT` and `DELETE` through the Storage API.

Use the Storage API for object operations. Do not directly insert, update, or delete `storage.objects` from application code.

## Signed URL contract

Never persist a public or signed URL in attachment metadata. Store only bucket ID plus object name. Authorize the current caller against the item/attachment immediately before signing. Use a **60 seconds TTL** by default for an interactive view/download; only extend it to the minimum justified duration (hard maximum five minutes) for a known transfer. Do not log, place in analytics, or share signed URLs. Refresh after expiration rather than pre-generating URLs, and revoke practical access by deleting or replacing the object/metadata.

## Lifecycle cleanup contract

Storage and relational metadata cannot be changed atomically in one database transaction. Cleanup ownership therefore belongs to an idempotent server worker using service-role credentials and a durable cleanup job/outbox. Jobs use a deterministic object identity `(bucket_id, object_name)`, treat “already absent” as success, retry transient list/remove failures with bounded backoff, and retain terminal failure state for operations/alerting. Cleanup always calls the Storage API; it never deletes `storage.objects` directly.

### Attachment deletion

In the transaction that performs attachment deletion, hide/soft-delete the attachment and enqueue its exact object cleanup job. The worker removes the object through the Storage API, verifies it is absent, then marks the job complete and hard-deletes/tombstones metadata as the attachment design requires. A retry must target the same object name. Never delete an object selected only from a caller-supplied path.

### Item deletion

Before or in the authoritative item deletion transaction, lock/read all attachment metadata for that item, enqueue one cleanup identity per object, and make the item unavailable. Cascading metadata deletion must not erase the only copy of object names before jobs are durable. Item deletion completes asynchronously only after every object removal is confirmed; a partial batch remains retryable.

### Metadata-create failure after upload

Use a fresh object UUID for each upload. If upload succeeds but attachment metadata creation fails, immediately request Storage API removal. If that removal fails or the client loses the response, submit the deterministic object identity to the server cleanup queue. A duplicate metadata request must be idempotent and must not create another object.

### Abandoned uploads

Prefer a server-issued, expiring upload reservation bound to user ID, item ID, expected size/type, and one object name. A scheduled service-role sweeper removes expired reservations and objects with no matching attachment metadata after a conservative grace period (for example, 24 hours). It must paginate, re-check metadata/reservation state immediately before removal, and be idempotent. Never sweep solely by filename age while an active reservation exists.

### Replacement/upsert failure

Do not replace an attachment by upserting bytes over its existing object name. Upload a new object UUID, validate it, then transactionally switch metadata and enqueue the old object for cleanup. If the new upload or metadata switch fails, keep the old attachment authoritative and clean the new object. If a Storage API upsert/copy/rename response is lost, reconcile both source and destination object names plus metadata before retrying; retries must never delete the last known-good object.

### Account deletion

Account deletion remains server-side work. The existing leased account-deletion workflow now removes both the legacy project-photo prefix and only `<user-id>/` from `my-stuff-media` using service-role Storage API credentials before marking storage complete or deleting the Auth user.

The cleanup recursively enumerates the fixed `items/` hierarchy, rejects path segments or nesting outside its traversal bounds, and limits each attempt to 1,000 list calls. It lists up to 1,000 entries per call, removes exact object names in bounded batches, and continues until a fresh listing of the user's prefix is empty. Because deletion shifts later entries forward, it restarts each affected folder at offset zero after a removal batch. A repeated unchanged page, exhausted traversal budget, listing error, or removal error fails the deletion attempt before the Auth deletion fence; the tombstone remains retryable and a later account-deletion attempt drains the same prefix. Existing `project-photos` cleanup remains a separate checked step.

## Review and verification

The migration is review-only. Do not apply it without separate production approval. Static and cleanup behavior tests run with `npm test`; the disposable PostgreSQL harness runs with:

```sh
bash tests/sql/run-my-stuff-storage-local.sh
```

The fixture mirrors the current Supabase `storage.protect_delete` statement trigger: direct table deletes fail unless the Storage service database session has set `storage.allow_delete_query=true`. The harness first proves that direct delete protection, then sets the GUC to model the API's already-authorized metadata-delete phase and exercise RLS. It applies the migration twice and covers upload, upsert, copy, same-owner rename, nonexistent-item and other-owner-item write denials, cross-owner and cross-bucket denials, bounded paths, and anonymous denial.

This PostgreSQL simulation does not prove backing-object deletion, HTTP endpoint behavior, upload-byte/declared-MIME enforcement, or signed-token delivery by the real Storage API. Those require an approved local Supabase stack or non-production project. The SQL harness deliberately does not pretend that a direct table `DELETE` is an end-to-end Storage API removal.
