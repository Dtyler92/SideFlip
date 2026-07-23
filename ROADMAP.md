# SideFlip Product Roadmap

## ✅ Shipped (V1)
- Project tracking (photo, title, category, purchase price)
- Expense logging with categories
- Profit / loss / ROI calculator
- Category-specific fields (VIN, hull, engine model/serial, model/serial)
- Notes per project
- Edit photo on existing projects
- 14 flip categories (car, mower, boat, motorcycle, ATV, bicycle, watch, electronics, gaming, tools, exercise, instruments, furniture, other)
- Penny/BookReel editorial design (warm, premium)
- Auth (email sign up / sign in via Supabase)
- 7-day free trial (card required)
- Plan selector on signup (annual pushed)
- Stripe checkout with promo code support
- Stripe webhook (auto-activates subscriptions)
- Pricing: $5.99/mo · $59/yr (Save 17%)
- Influencer discount codes via Stripe coupons (1-year duration, renews at full rate)
- Live at sideflip.org

---

## 🔜 Next Up (V1.1) — Priority Order

### 1. Email Branding (noreply@sideflip.org)
- Set up Resend.com for transactional email
- Branded confirmation, welcome, and trial-ending emails
- "Your trial ends in 2 days" reminder email (big conversion driver)
- **Effort:** ~3 hours

### 2. Data Sync to Cloud
- Currently data lives in localStorage (device only)
- Move projects + expenses to Supabase so data follows the user across devices
- **Effort:** ~1 day

### 3. App Store Submission (iOS + Android)
- **Login-only** — no sign up, no pricing, no Subscribe button inside the app
- Sign up happens at sideflip.org (avoids Apple's 30% IAP cut — how Spotify/Netflix do it)
- Add line under login: "New user? Visit sideflip.org to create an account"
- Apple App Store ($99/yr developer account) + Google Play ($25 one-time)
- PWA already works on mobile — just needs store packaging (Capacitor)
- **Effort:** ~2 days

### 4. Influencer Referral Links (Auto-Discount)
- Unique URL per influencer: `sideflip.org/?ref=TOMSREFURB`
- Landing page auto-applies their discount code at Stripe checkout
- No code for the user to remember or type
- Track clicks + conversions per influencer in dashboard
- Stripe Connect handles automatic 30% rev share payout
- **Effort:** ~1 day

---

## 🗺️ Future (V2)

### 5. Influencer Dashboard
- Dedicated portal for influencers to see their referrals + earnings
- Monthly payout summary
- Shareable referral link (not just code)

### 6. Profit Analytics Dashboard
- Charts: profit over time, best categories, average ROI per category
- "Your best flip ever" highlight
- Monthly/yearly summary

### 7. Export to PDF / CSV
- One-tap export of all projects for tax purposes
- Per-project PDF receipts (useful for high-value flips)

### 8. Push Notifications (PWA)
- "You've had this project for 30 days — time to flip it?"
- Trial ending reminders
- Milestone alerts ("You've made $1,000 flipping!")

### 9. Marketplace Integration
- Direct link to list on Facebook Marketplace / eBay / Craigslist from within the app
- Pre-fill listing title and price based on project data

### 10. Photo Multiple Uploads
- Currently 1 photo per project
- Allow up to 10 photos (before/after, parts, receipts)

---

## 💡 Influencer Marketing Plan
- Target: YouTube/TikTok/Instagram flippers (5k–100k followers)
- Deal: Free lifetime access + custom code + 30% rev share year 1
- Code duration: 1 year only — renews at full $59 after
- Tracking: Stripe Connect (automatic splits)
- Pitch template saved separately
