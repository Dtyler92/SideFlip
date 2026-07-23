export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px', fontFamily: 'Inter, sans-serif', color: '#1A1917', lineHeight: 1.7 }}>
      <div style={{ fontFamily: 'Playfair Display, serif', fontSize: 36, fontWeight: 800, marginBottom: 8 }}>
        <span style={{ color: '#1A1917' }}>Side</span><span style={{ color: '#C8402F' }}>Flip</span>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: '24px 0 8px' }}>Privacy Policy</h1>
      <p style={{ color: '#8C8880', marginBottom: 32 }}>Last updated: July 23, 2026</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>1. Information We Collect</h2>
      <p>We collect information you provide when you create an account (email address, password) and when you use the app (project names, photos, purchase prices, expenses, and sale prices). We also collect payment information through our payment processor, Stripe — we never store your card details directly.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>2. How We Use Your Information</h2>
      <p>We use your information to:</p>
      <ul>
        <li>Provide and improve the SideFlip service</li>
        <li>Process your subscription payments</li>
        <li>Send transactional emails (welcome, trial reminders, receipts)</li>
        <li>Respond to your support requests</li>
      </ul>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>3. Data Storage</h2>
      <p>Your data is stored securely on Supabase (database) and Supabase Storage (photos). Photos are stored on a private CDN and are only accessible to you. We use industry-standard encryption in transit and at rest.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>4. Third-Party Services</h2>
      <p>We use the following third-party services:</p>
      <ul>
        <li><strong>Stripe</strong> — payment processing (<a href="https://stripe.com/privacy" style={{ color: '#C8402F' }}>Privacy Policy</a>)</li>
        <li><strong>Supabase</strong> — database and file storage (<a href="https://supabase.com/privacy" style={{ color: '#C8402F' }}>Privacy Policy</a>)</li>
        <li><strong>Resend</strong> — transactional email (<a href="https://resend.com/privacy" style={{ color: '#C8402F' }}>Privacy Policy</a>)</li>
        <li><strong>Vercel</strong> — hosting (<a href="https://vercel.com/legal/privacy-policy" style={{ color: '#C8402F' }}>Privacy Policy</a>)</li>
      </ul>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>5. Data Retention</h2>
      <p>We retain your data for as long as your account is active. If you cancel your subscription and request account deletion, we will delete your data within 30 days. Contact us at tyler@tourbillionenergy.com to request deletion.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>6. Your Rights</h2>
      <p>You may request access to, correction of, or deletion of your personal data at any time by contacting us. We do not sell your personal information to third parties.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>7. Children's Privacy</h2>
      <p>SideFlip is not intended for children under 13. We do not knowingly collect personal information from children under 13.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>8. Changes to This Policy</h2>
      <p>We may update this policy from time to time. We will notify you of significant changes via email. Continued use of SideFlip after changes constitutes acceptance of the updated policy.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 32 }}>9. Contact</h2>
      <p>Questions about this policy? Email us at <a href="mailto:tyler@tourbillionenergy.com" style={{ color: '#C8402F' }}>tyler@tourbillionenergy.com</a>.</p>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #E8E4DE' }}>
        <a href="/" style={{ color: '#C8402F', fontWeight: 600, textDecoration: 'none' }}>← Back to SideFlip</a>
      </div>
    </div>
  )
}
