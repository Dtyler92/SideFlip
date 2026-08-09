# Analytics migration-first deployment gate

Do **not** deploy or route the analytics-aware backend before the two reviewed analytics migrations have been applied in order:

1. `20260809020000_add_product_analytics_outbox.sql`
2. `20260809030000_schedule_analytics_dispatch.sql`

This repository does not apply production migrations automatically. Never include `20260806200000_secure_freemium_goals_and_receipts.sql` in this release.

## Initial rollout release order

1. Review both analytics migrations and the matching backend together. Confirm the forbidden migration is excluded.
2. Apply only the two approved analytics migrations through the production change process while the old backend remains live. The outbox migration is additive and grants restricted RPCs only to `service_role`. The scheduler migration creates a dormant five-minute Supabase Cron path: without its named Vault secret it issues no HTTP request.
3. Verify `analytics_backend_readiness()` directly with the Supabase service role before routing any new backend code. Require `true` and both analytics migrations in migration history.
4. Deploy the matching backend/web release, then call `/api/analytics-readiness` with `ANALYTICS_READINESS_SECRET` (or `CRON_SECRET`) as a post-deploy route check.
5. Confirm `POSTHOG_KEY` is configured for capture and the dedicated `POSTHOG_PERSONAL_API_KEY` has only `person:write`, with `POSTHOG_PROJECT_ID` and `POSTHOG_API_HOST` configured only server-side.
6. Generate one new high-entropy dispatcher secret without printing it. Replace Vercel Production `CRON_SECRET` and create the matching encrypted Supabase Vault secret named `sideflip_analytics_cron_secret` in one controlled operation. Never put the value in migration history, shell history, logs, chat, or client variables.
7. Verify one Vault-backed Supabase Cron request returns 2xx, then inspect only dispatcher counts and backlog. Provider webhooks enqueue only; the worker performs PostHog network calls and drains repeated 25-row claims for up to 50 seconds per run.
8. Keep privacy settings intact: explicit events only; no autocapture, session recording, surveys, heatmaps, console/canvas capture, exception autocapture, broad enrichment, external dependency loading, or client-side feature-flag requests.
9. Trigger one controlled consented test event and one authoritative sandbox provider event.
10. Confirm deterministic replay does not increase counts.
11. Exercise analytics opt-out and confirm no queued or delivered follow-up event.
12. Exercise a dedicated test-account deletion and confirm the deletion job remains fenced and retryable until PostHog no longer returns that person.
13. Publish only the reviewed owner dashboard definitions.
14. Build native with Production-scoped Expo variables; inspect the generated iOS archive privacy report before TestFlight/App Store release.

A missing readiness RPC returns HTTP 503 after deployment. The initial rollout does not depend on that unreleased HTTP endpoint: it verifies the RPC directly between migration and backend routing. Checkout analytics also fails open after Stripe creates a session, but that fallback is not a substitute for the gate.
