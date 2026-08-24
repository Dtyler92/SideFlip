# SideFlip Build 17 Apple Privacy and Security Audit

Date: 2026-08-24

## Scope

- Exact submitted EAS build `cf325213-1c44-4687-83fb-fdb4a5dc78c0`
- Source commit `64d21071baea7c20c5c1c61b49df39823c8edb8f`
- iOS version `1.0.0`, build `17`, bundle `com.sideflip.app`
- Live `https://sideflip.org` privacy, terms, support, and relevant APIs
- SideFlip native, web/API, entitlement, analytics, and account-deletion source
- Read-only production Supabase catalog metadata

## Executive finding

No confirmed critical vulnerability was found, and no finding requires automatic withdrawal of Build 17. The strongest current App Review risk was inconsistent public legal copy: Stripe-only payment language, unconditional web trial language, missing Apple purchase disclosures, and Stripe-only support instructions. Corrected pages and low-risk web security headers have been prepared and validated locally but not deployed.

Apple approval cannot be guaranteed. App Review may still test the app, account, products, metadata, and backend independently.

## Build 17 controls verified

- Apple subscription product IDs are `com.sideflip.app.pro.monthly` and `com.sideflip.app.pro.annual`.
- StoreKit prices come from the user's storefront; purchase controls stay disabled until valid Apple prices load.
- Purchase requests include the authenticated SideFlip UUID as `appAccountToken`.
- Transactions are sent to SideFlip's authenticated server endpoint for verification and are finished only after verification.
- Restore Purchases is visible and validates active Apple purchases server-side.
- Account deletion is visible in Settings, requires typing `DELETE`, and uses a second destructive confirmation.
- Product analytics defaults off and requires authenticated server-confirmed consent.
- PostHog session replay, advertising tracking, surveys, remote feature flags, push tracking, logs, and automatic lifecycle capture are disabled.
- Analytics uses event/property allowlists and excludes project text, project amounts, photos, credentials, signed purchase payloads, and arbitrary URLs.
- All explicit app endpoints use HTTPS.
- No tracked service-role key, Stripe secret, Apple private key, service-account credential, or other private production credential was found.

## Approved live checks

Unauthenticated requests were rejected as expected:

- `GET /api/entitlement` -> 401
- `POST /api/verify-apple-purchase` -> 400 invalid verification request
- `POST /api/delete-account` -> 400 missing typed confirmation
- `GET /api/analytics-preference` -> 401
- `POST /api/update-profile-preferences` -> 401

Production metadata confirmed:

- SideFlip Supabase project is active and healthy.
- `user_entitlements`, `account_deletion_tombstones`, Apple/analytics support tables, projects, expenses, receipts, goals, and ledger tables exist.
- Apple entitlement, deletion, analytics, and hardening migrations through 2026-08-10 are applied.
- Anonymous and authenticated roles do not have UPDATE column privilege on `profiles.subscription_id`, `profiles.subscription_status`, or `profiles.stripe_customer_id`.
- Auth deletion cascades are confirmed for profiles, receipts, goals, ledger rows, and entitlements. A second catalog query for the complete legacy project/expense foreign-key chain returned HTTP 403, so a controlled deletion test remains the correct final proof for those legacy tables.

## Corrected current-review legal posture

Prepared changes:

- Identify Tourbillion LLC as SideFlip's operator.
- Describe account/session/preferences, project content, identifiers, financial tracking, goals, receipts, and purchase history.
- Disclose Apple purchase processing, SideFlip verification identifiers, and Apple subscription management.
- Distinguish Apple IAP from Stripe web subscriptions.
- Do not promise an Apple trial unless Apple presents an eligible offer.
- Add Apple and Vercel to the processor list; expand Supabase to authentication/database/storage.
- Preserve accurate Anthropic disclosure for listing generation.
- Explain consent-based analytics and excluded sensitive fields.
- Explain public non-expiring photo URLs accurately.
- Explain provider-retained billing/legal records, deletion tombstones, and asynchronous analytics deletion.
- Add Apple billing, deletion, and privacy guidance to Support.
- Add `X-Content-Type-Options`, anti-framing, referrer protection, and restrictive geolocation/microphone browser policy headers.

## App Store Connect privacy-label checklist

The actual App Store Connect answers still require screenshot verification. Build 17 source supports the following declarations:

- Tracking: **No**
- Contact Info -> Email Address: linked, App Functionality
- User Content -> Photos or Videos: linked, App Functionality
- User Content -> Other User Content: linked, App Functionality
- Financial Info -> Other Financial Info: linked, App Functionality
- Purchases -> Purchase History: linked, App Functionality and Analytics
- Identifiers -> User ID: linked, App Functionality and Analytics
- Identifiers -> Device ID/pseudonymous device identifier: linked, Analytics, only when enabled
- Usage Data -> Product Interaction: linked, Analytics, only when enabled
- Usage Data -> Other Usage Data: linked, Analytics, only when enabled

Do not declare payment-card details as collected by SideFlip merely because Apple or Stripe processes them. Do not declare cross-app tracking unless implementation changes.

## Future binary hardening

Recommended for the next binary, not Build 17:

1. Replace generic AsyncStorage session persistence with a SecureStore-backed Supabase adapter.
2. Strictly validate authentication callback scheme, host, path, event, issuer, and expected flow; prefer PKCE and universal links where feasible.
3. Add permanent Privacy, Terms, and Support links to authenticated Settings.
4. Add first-use disclosure before sending project content to Anthropic and send a strict minimal DTO rather than raw expense objects.
5. Set Expo image-picker `microphonePermission: false` and inspect the final archive's merged `Info.plist`.
6. Complete the forgot-password flow with a recovery-state route and new-password form.
7. Move project photos to private storage with authorized signed URLs and delete underlying objects when users remove photos. This remains deferred to the share-pages release.
8. Upgrade Expo/Metro and affected web dependencies in a separately tested release cycle.

## Backend follow-up requiring separate approval

The account-deletion endpoint records legacy Stripe identifiers but does not cancel an active Stripe subscription before deleting Auth access. A web subscriber could lose authenticated portal access while billing continues. Before changing billing code, choose one approved policy:

- Cancel active legacy Stripe subscriptions before irreversible account deletion and verify provider success; or
- Block deletion until the user manages the web subscription, while providing a supported recovery route.

Retain the minimal deletion tombstone either way so delayed provider events cannot recreate an account.

## Validation

- Web/API automated tests: 66/66 passed
- Submitted native tests: 47/47 passed in the independent audit
- Production Vite build: passed
- Corrected Privacy, Terms, and Support HTML parsing: passed
- Corrected Privacy page visual render: passed
- `vercel.json` parse: passed
- `git diff --check`: passed
- No migration, deployment, App Store edit, submission replacement, or billing change was performed
