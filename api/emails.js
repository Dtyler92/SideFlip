import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = 'SideFlip <noreply@sideflip.org>'
const APP_URL = 'https://sideflip.org'

// ── Welcome email sent after successful signup + payment ──────
export async function sendWelcomeEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Welcome to SideFlip 🔧',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#FAFAF7;padding:40px 24px;">
        <div style="font-size:36px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px;">
          <span style="color:#1A1917;">Side</span><span style="color:#C8402F;">Flip</span>
        </div>
        <h1 style="font-size:22px;color:#1A1917;margin:24px 0 12px;">You're in. Let's track some flips. 🚜</h1>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Your 7-day free trial has started. Track every dollar you put into a project — parts, labor, purchase price — and see your profit the moment you sell.
        </p>
        <a href="${APP_URL}" style="display:inline-block;background:#C8402F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
          Open SideFlip →
        </a>
        <hr style="border:none;border-top:1px solid #E8E4DE;margin:36px 0;" />
        <p style="color:#8C8880;font-size:13px;line-height:1.6;">
          Questions? Reply to this email anytime.<br/>
          — Tyler, SideFlip
        </p>
      </div>
    `
  })
}

// ── Trial reminder — sent 5 days in (2 days left) ────────────
export async function sendTrialReminderEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Your SideFlip trial ends in 2 days',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#FAFAF7;padding:40px 24px;">
        <div style="font-size:36px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px;">
          <span style="color:#1A1917;">Side</span><span style="color:#C8402F;">Flip</span>
        </div>
        <h1 style="font-size:22px;color:#1A1917;margin:24px 0 12px;">Your trial ends in 2 days ⏰</h1>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:16px;">
          Your free trial wraps up on day 7. After that your card will be charged and you'll keep full access — no interruption.
        </p>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Want to cancel before then? Just reply to this email and we'll take care of it.
        </p>
        <a href="${APP_URL}" style="display:inline-block;background:#C8402F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
          Open SideFlip →
        </a>
        <hr style="border:none;border-top:1px solid #E8E4DE;margin:36px 0;" />
        <p style="color:#8C8880;font-size:13px;line-height:1.6;">
          Questions? Just reply — we're real people.<br/>
          — Tyler, SideFlip
        </p>
      </div>
    `
  })
}

// ── Win-back — canceled during free trial ─────────────────────
export async function sendTrialCanceledEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Sorry to see you go — SideFlip',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#FAFAF7;padding:40px 24px;">
        <div style="font-size:36px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px;">
          <span style="color:#1A1917;">Side</span><span style="color:#C8402F;">Flip</span>
        </div>
        <h1 style="font-size:22px;color:#1A1917;margin:24px 0 12px;">You canceled — no hard feelings 👋</h1>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:16px;">
          Your trial has been canceled and you won't be charged a thing.
        </p>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          If you ever want to come back and start tracking your flips, your account is still here. Just sign in and pick a plan — takes 30 seconds.
        </p>
        <a href="${APP_URL}" style="display:inline-block;background:#C8402F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
          Come Back Anytime →
        </a>
        <hr style="border:none;border-top:1px solid #E8E4DE;margin:36px 0;" />
        <p style="color:#8C8880;font-size:13px;line-height:1.6;">
          Was there something we could've done better? Just reply — I read every email.<br/>
          — Tyler, SideFlip
        </p>
      </div>
    `
  })
}

export async function sendPaymentFailedEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Action needed — SideFlip payment failed',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#FAFAF7;padding:40px 24px;">
        <div style="font-size:36px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px;">
          <span style="color:#1A1917;">Side</span><span style="color:#C8402F;">Flip</span>
        </div>
        <h1 style="font-size:22px;color:#1A1917;margin:24px 0 12px;">We couldn't process your payment</h1>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Your SideFlip subscription payment didn't go through. Please update your payment method to keep access to your projects.
        </p>
        <a href="${APP_URL}" style="display:inline-block;background:#C8402F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
          Update Payment →
        </a>
        <hr style="border:none;border-top:1px solid #E8E4DE;margin:36px 0;" />
        <p style="color:#8C8880;font-size:13px;">— Tyler, SideFlip</p>
      </div>
    `
  })
}
