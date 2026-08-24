export default function PrivacyPolicy() {
  const linkStyle = { color: '#C8402F' }
  const sectionStyle = { fontSize: 18, fontWeight: 700, marginTop: 32 }
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px', fontFamily: 'Inter, sans-serif', color: '#1A1917', lineHeight: 1.7 }}>
      <div style={{ fontFamily: 'Playfair Display, serif', fontSize: 36, fontWeight: 800, marginBottom: 8 }}>
        <span style={{ color: '#1A1917' }}>Side</span><span style={{ color: '#C8402F' }}>Flip</span>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: '24px 0 8px' }}>Privacy Policy</h1>
      <p style={{ color: '#8C8880', marginBottom: 32 }}>Last updated: August 24, 2026</p>

      <p>SideFlip is operated by Tourbillion LLC, a Pennsylvania limited liability company. This policy explains how Tourbillion LLC collects, uses, shares, retains, and deletes information when you use the SideFlip website or iPhone app. We do not sell personal information or share it with advertisers.</p>

      <h2 style={sectionStyle}>1. Information We Collect</h2>
      <ul>
        <li><strong>Account and authentication information</strong> — your email address, SideFlip account identifier, authentication and session information, and preferences such as currency, language, onboarding status, and analytics choice.</li>
        <li><strong>Project content</strong> — information you choose to enter, including project titles, categories, status, purchase and sale information, expenses, notes, item identifiers, photos, receipts, and Trade-Up Goal information.</li>
        <li><strong>Subscription and purchase records</strong> — purchase provider, product or plan, transaction identifiers, subscription status, and purchase and expiration dates. Apple processes payment credentials for iPhone purchases, and Stripe processes payment credentials for web purchases. SideFlip does not receive or store your complete card number or Apple ID password.</li>
        <li><strong>Usage analytics, when enabled</strong> — pseudonymous app interactions, app version, purchase or restore outcomes, and campaign or referral parameters.</li>
        <li><strong>Request and security information</strong> — hosting providers may process IP addresses, device or browser information, request metadata, and security logs.</li>
      </ul>
      <p>Analytics may use a generated device or session identifier and your SideFlip account ID after sign-in. They do not include project text, photos, project financial amounts, card details, credentials, or signed purchase data. Session replay, cross-app advertising tracking, surveys, and automatic push-notification tracking are disabled.</p>

      <h2 style={sectionStyle}>2. How We Use Information</h2>
      <ul>
        <li>Authenticate accounts and provide SideFlip features</li>
        <li>Store and synchronize projects, expenses, photos, receipts, and goals</li>
        <li>Verify subscriptions, restore purchases, and provide Pro access</li>
        <li>Send transactional email and provide support</li>
        <li>Create a sales-listing draft from project details when requested</li>
        <li>Prevent abuse, diagnose failures, and improve the service</li>
      </ul>

      <h2 style={sectionStyle}>3. Storage and Photos</h2>
      <p>Supabase stores account and project data and files. SideFlip currently serves project and receipt images through public, non-expiring URLs. The URLs are designed to be difficult to guess, but they are not access-controlled; anyone who has or obtains an image URL can view the image without signing in. We do not use photos for advertising or sell them.</p>

      <h2 style={sectionStyle}>4. Service Providers</h2>
      <ul>
        <li><strong>Supabase</strong> — authentication, database hosting, and file storage (<a href="https://supabase.com/privacy" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>Apple</strong> — iPhone purchases, verification, and subscription management (<a href="https://www.apple.com/legal/privacy/" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>Stripe</strong> — web subscription payments and billing management (<a href="https://stripe.com/privacy" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>Vercel</strong> — website and server API hosting (<a href="https://vercel.com/legal/privacy-policy" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>Resend</strong> — transactional email delivery (<a href="https://resend.com/privacy" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>Anthropic</strong> — creates a listing draft when requested using needed project details (<a href="https://www.anthropic.com/privacy" style={linkStyle}>Privacy Policy</a>)</li>
        <li><strong>PostHog</strong> — consent-based product analytics with session replay disabled (<a href="https://posthog.com/privacy" style={linkStyle}>Privacy Policy</a>)</li>
      </ul>
      <p>We require providers to process information only for the services they provide to SideFlip and protect it consistently with this policy and applicable law.</p>

      <h2 style={sectionStyle}>5. Retention and Account Deletion</h2>
      <p>We retain account and project information while your account remains active. You can initiate deletion through <strong>Settings → Delete Account</strong> in the iPhone app or contact support. The deletion process removes your SideFlip authentication account, profile, projects, expenses, goals, ledger records, and files stored under your account.</p>
      <p>Deleting your account does not cancel a subscription. Apple subscriptions must be managed through Apple ID subscription settings; web subscriptions must be managed through SideFlip Settings or with support before deletion. Providers may retain billing, transaction, fraud-prevention, security, or legal records under their own policies.</p>
      <p>SideFlip retains a minimal deletion-suppression record containing account and subscription identifiers only as needed to prevent delayed provider events from recreating a deleted account and to meet security or legal obligations. If analytics were enabled, SideFlip submits a deletion request for the associated PostHog identity and events; provider processing may be asynchronous.</p>

      <h2 style={sectionStyle}>6. Your Choices and Rights</h2>
      <p>You may disable analytics at any time in SideFlip Settings. You may request access to, correction of, or deletion of your information and ask questions about its use by contacting us. Where applicable, you may withdraw consent or object to certain processing.</p>

      <h2 style={sectionStyle}>7. Children's Privacy</h2>
      <p>SideFlip is not directed at children under 13, and we do not knowingly collect personal information from children under 13.</p>

      <h2 style={sectionStyle}>8. Security</h2>
      <p>SideFlip uses encrypted HTTPS connections, authenticated server endpoints, server-side subscription verification, access controls, and data-minimization measures. No service can guarantee absolute security; please use a unique password and contact us if you believe your account has been compromised.</p>

      <h2 style={sectionStyle}>9. Changes and Contact</h2>
      <p>We will post updates and notify users of significant changes when appropriate. Questions and privacy requests may be sent to <a href="mailto:tyler@tourbillionenergy.com" style={linkStyle}>tyler@tourbillionenergy.com</a>.</p>
      <p>Tourbillion LLC · Pennsylvania, United States</p>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #E8E4DE' }}>
        <a href="/" style={{ color: '#C8402F', fontWeight: 600, textDecoration: 'none' }}>← Back to SideFlip</a>
      </div>
    </div>
  )
}
