# App Store privacy answers for SideFlip analytics

Use these only after the PostHog-enabled build is uploaded and its archive privacy report is checked.

## Data linked to the user

Collected for **Analytics** only:

- **Purchases – Purchase History:** verified subscription lifecycle, plan, billing interval, subscription amount/currency, and payment outcome. No card or billing-address data.
- **Identifiers – User ID:** pseudonymous Supabase account UUID. No email is sent to PostHog.
- **Identifiers – Device ID:** PostHog's pseudonymous installation/device identifier.
- **Usage Data – Product Interaction:** explicit app opens, normalized screen names, feature/funnel actions, and bounded campaign/referral attribution.

## Not collected by analytics

- Precise or coarse location
- Name, email, phone, or physical address
- Contacts
- Photos or image URLs
- Project descriptions or generated listing text
- Raw VINs or record IDs
- Project purchase prices, expenses, sale prices, or profit
- Payment-card or billing-address details
- Apple signed transactions or Stripe payloads
- Crash logs, stack traces, console logs, or performance diagnostics

## Tracking

- **Data used to track you:** No
- **App Tracking Transparency prompt required:** No
- No cross-company advertising profiles, ad targeting, data broker sharing, or third-party ad SDKs.

## Required configuration/evidence

- Session replay off
- Autocapture, lifecycle capture, exception capture, surveys, feature flags, push telemetry, and external dependency loading off
- PostHog IP/geolocation enrichment disabled in project settings
- Analytics opt-out reconciled to the authenticated account
- Retention set to 12 months
- Final iOS archive privacy report reviewed before submission
