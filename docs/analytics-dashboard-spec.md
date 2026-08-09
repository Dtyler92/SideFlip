# SideFlip PostHog dashboards

## Required deployment configuration

Client-visible, non-secret ingestion configuration:

- Web: `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST=https://us.i.posthog.com`
- Native/EAS: `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com`
- Server capture/outbox: `POSTHOG_KEY`, `POSTHOG_HOST=https://us.i.posthog.com`

Server-only secrets/identifiers:

- `CRON_SECRET` — protects the outbox/deletion dispatcher.
- `POSTHOG_PROJECT_ID` — numeric SideFlip Production project ID.
- `POSTHOG_PERSONAL_API_KEY` — a dedicated service key with only `person:write`. It is used only by the documented persons bulk-deletion endpoint and must never use a broad personal token.

The public project ingestion key is intentionally not treated as a credential. Never expose `CRON_SECRET` or `POSTHOG_PERSONAL_API_KEY` through `VITE_` or `EXPO_PUBLIC_` variables.

Production Vercel is linked to project `sideflip`; the detached analytics worktree lacking `.vercel/project.json` does not mean production is unlinked. The five public-ingestion PostHog variables were configured for Production on 2026-08-09 but are not active until an approved deployment. `CRON_SECRET` and the scoped deletion-service key remain separate release gates.

Provider: PostHog US Cloud. Use explicit capture only. Keep session replay, heatmaps, surveys, and broad autocapture disabled. Disable IP/geolocation enrichment. Apply a short retention period. Never expose a dashboard publicly.

## 1. Activation

1. **Signup activation funnel (30-day window):** `signup_started` → `signup_completed` → `onboarding_completed` → `project_created` → `expense_added` → `project_marked_sold`.
2. **Onboarding completion:** unique `onboarding_started` versus `onboarding_completed`, split by `platform`.
3. **First-value funnel:** `signup_completed` → `project_created` → `expense_added`, split by `platform` and person property `first_utm_source`.
4. **Goal activation:** `goal_created` → `project_created` where `is_goal_linked=true` → `goal_completed`.

## 2. Engagement and adoption

1. DAU/WAU/MAU from unique people performing `app_opened`.
2. Unique screen visitors from `screen_viewed`, split by `screen` and `platform`.
3. Weekly feature adoption for `expense_added`, `ai_listing_succeeded`, `goal_created`, and `project_marked_sold`.
4. AI success ratio: `ai_listing_succeeded` divided by `ai_listing_requested`; show `ai_listing_failed` by `error_type`.
5. Project lifecycle: unique `project_created`, `expense_added`, and `project_marked_sold`.

## 3. Free-to-Pro conversion

1. **Apple funnel:** `paywall_viewed` → `plan_selected` → `apple_purchase_started` → server `subscription_started`. Use 14 days and split by `plan` or `billing_period`.
2. **Web Stripe funnel:** `paywall_viewed` → `plan_selected` → `stripe_checkout_started` → `checkout_completed` → server `subscription_started` → server `subscription_payment_succeeded`. Use 14 days.
3. **Restore funnel:** `apple_restore_started` → `apple_restore_completed` → `apple_entitlement_activated` where `is_restore=true`.
4. Paid revenue: sum `amount_minor` on `subscription_payment_succeeded`, divide by 100, and split by `currency`. Split count by `payment_type=initial|renewal`.
5. Show conversion and paid revenue by `platform`, `plan`, and `billing_interval`.

`subscription_started` means verified Pro entitlement and may include a trial. Only `subscription_payment_succeeded` with a positive provider-paid amount is paid revenue.

## 4. Attribution

1. Signup completions by person property `first_utm_source`, then `first_utm_medium`, `first_utm_campaign`, and `first_referral_code`.
2. Initial paid conversions (`subscription_payment_succeeded`, `payment_type=initial`) by first-touch properties.
3. Initial paid conversions by last-touch properties.
4. Referral funnel: `attribution_captured` → `signup_completed` → `subscription_payment_succeeded`, filtered to people with a referral property.

Never use raw URLs or referrers. UTM and referral values are bounded before capture.

## 5. Retention

1. New users: `signup_completed`; returning event: `app_opened`; daily intervals through day 30. Read Day 1, Day 7, and Day 30.
2. Activated users: `project_created`; returning event: `app_opened`; daily intervals through day 30.
3. Goal users: `goal_created`; returning event: `app_opened`; weekly intervals through week 8.
4. Split retention by `platform` and person property `first_utm_source` when sample size permits.

## 6. Churn and reliability

1. Weekly unique `subscription_cancellation_scheduled`, `subscription_ended`, `subscription_payment_failed`, `subscription_refunded`, and `subscription_revoked`.
2. Churn ratio: `subscription_ended` divided by active unique subscribers; annotate that this is product churn, not accounting MRR churn.
3. Client failure trend: `stripe_checkout_failed`, `apple_purchase_failed`, `apple_purchase_verification_failed`, `apple_entitlement_activation_failed`, `apple_restore_failed`, and `ai_listing_failed`, split by bounded `error_type`.
4. Trial health: `subscription_trial_ending` versus `subscription_payment_succeeded` with `payment_type=initial`.

## Data-quality checks before trusting dashboards

- Test anonymous-to-identified merging on web and iOS.
- Verify client purchase callbacks never create server conversion events.
- Replay one Stripe event and one Apple transaction; each server event count must remain one.
- Confirm TestFlight sandbox Apple events report `environment=sandbox` only where allowed.
- Opt out on one device, sign in on another fresh device, and verify no identified or server event is accepted.
- Confirm `analytics_outbox` rows transition `pending` → `processing` → `delivered`; alert on `dead_letter`.
- Verify no event contains email, project text, image data/URLs, VINs, provider IDs, signed Apple data, Stripe objects, credentials, access tokens, or project financial values.

## Naming and access

Create six private dashboards prefixed `SideFlip —`. Pin Activation and Conversion. Give owner access only. Do not send development or fixture events into the production project.