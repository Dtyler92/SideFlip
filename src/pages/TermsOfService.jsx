export default function TermsOfService() {
  const sectionStyle = { fontSize: 18, fontWeight: 700, marginTop: 32 }
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px', fontFamily: 'Inter, sans-serif', color: '#1A1917', lineHeight: 1.7 }}>
      <div style={{ fontFamily: 'Playfair Display, serif', fontSize: 36, fontWeight: 800, marginBottom: 8 }}>
        <span style={{ color: '#1A1917' }}>Side</span><span style={{ color: '#C8402F' }}>Flip</span>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: '24px 0 8px' }}>Terms of Service</h1>
      <p style={{ color: '#8C8880', marginBottom: 32 }}>Last updated: September 8, 2026</p>

      <h2 style={sectionStyle}>1. Acceptance of Terms</h2>
      <p>SideFlip is operated by Tourbillion LLC, a Pennsylvania limited liability company. By creating an account, affirmatively accepting these Terms, and using SideFlip ("the Service"), you agree to these Terms. If you do not agree, do not use the Service.</p>

      <h2 style={sectionStyle}>2. Description of Service</h2>
      <p>SideFlip is project-tracking and business-management software that helps individuals and small resale businesses record the costs, expenses, receipts, sales, and profit of items they independently buy, repair, and resell. SideFlip does not buy or sell users' goods, process marketplace transactions, hold customer funds, or provide investment or financial advice.</p>

      <h2 style={sectionStyle}>3. Account Registration</h2>
      <p>You must provide a valid email address to create an account. You are responsible for maintaining the confidentiality of your password and activity under your account. You must be at least 13 years old to use the Service.</p>

      <h2 style={sectionStyle}>4. Subscriptions and Billing</h2>
      <p>Subscription prices and billing periods are shown before purchase. Availability and pricing may vary by purchase channel and region.</p>
      <p><strong>Web subscriptions:</strong> Website purchases are processed by Stripe. SideFlip does not offer a free trial for web subscriptions. The selected subscription is charged immediately after checkout confirmation and renews automatically at the disclosed billing interval until canceled. Web subscriptions are managed through SideFlip Settings and Stripe's billing portal.</p>
      <p><strong>iPhone subscriptions:</strong> Purchases in the SideFlip iPhone app are processed by Apple and charged to your Apple ID. Apple subscriptions renew automatically unless canceled through Apple ID subscription settings before renewal. Any introductory offer is available only if Apple shows it and your Apple ID is eligible. Apple controls App Store billing, cancellation, and refund requests.</p>
      <p>Canceling a subscription prevents future renewal according to the provider's rules but does not delete your SideFlip account. Deleting a SideFlip account does not cancel an Apple or Stripe subscription. Except where required by law or provider rules, completed charges are non-refundable.</p>

      <h2 style={sectionStyle}>5. Acceptable Use</h2>
      <ul>
        <li>Do not use the Service for an unlawful purpose</li>
        <li>Do not upload content that infringes third-party rights</li>
        <li>Do not attempt unauthorized access to the Service or its systems</li>
        <li>Do not use the Service to track illegal transactions</li>
      </ul>

      <h2 style={sectionStyle}>6. Your Content</h2>
      <p>You retain ownership of content you upload. By uploading content, you grant Tourbillion LLC a limited license to store, process, and display it only as needed to provide the Service and fulfill features you request.</p>

      <h2 style={sectionStyle}>7. Disclaimer of Warranties</h2>
      <p>The Service is provided "as is" without warranties of any kind. We do not guarantee uninterrupted or error-free service or that data loss can never occur. Keep your own records of important financial information.</p>

      <h2 style={sectionStyle}>8. Limitation of Liability</h2>
      <p>To the maximum extent permitted by law, SideFlip, Tourbillion LLC, and their operators shall not be liable for indirect, incidental, special, or consequential damages arising from use of the Service, including loss of data or profits.</p>

      <h2 style={sectionStyle}>9. Account Termination and Deletion</h2>
      <p>We may suspend or terminate accounts that violate these Terms. Canceling a subscription and deleting an account are separate actions. You may delete your account through <strong>Settings → Delete Account</strong> in the iPhone app or by contacting support. Account deletion is permanent and is handled as described in the Privacy Policy.</p>

      <h2 style={sectionStyle}>10. Changes to Terms</h2>
      <p>We may update these Terms from time to time. We will post revised Terms and notify users of material changes when appropriate. Continued use after revised Terms take effect constitutes acceptance.</p>

      <h2 style={sectionStyle}>11. Governing Law</h2>
      <p>These Terms are governed by the laws of the Commonwealth of Pennsylvania, without regard to conflict-of-law principles.</p>

      <h2 style={sectionStyle}>12. Contact</h2>
      <p>Questions? Email <a href="mailto:tyler@tourbillionenergy.com" style={{ color: '#C8402F' }}>tyler@tourbillionenergy.com</a>.</p>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid #E8E4DE' }}>
        <a href="/" style={{ color: '#C8402F', fontWeight: 600, textDecoration: 'none' }}>← Back to SideFlip</a>
      </div>
    </div>
  )
}
