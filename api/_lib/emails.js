import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = 'SideFlip <noreply@sideflip.org>'
const APP_URL = 'https://sideflip.org'
const SETTINGS_URL = `${APP_URL}/settings`
const SUPPORT_EMAIL = 'tyler@tourbillionenergy.com'

function formatDate(unixSeconds) {
  if (!unixSeconds) return 'the end of your trial'
  return new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(unixSeconds * 1000))
}

function formatPrice(unitAmount, currency = 'usd') {
  if (!Number.isFinite(unitAmount)) return 'your selected subscription price'
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase()
  }).format(unitAmount / 100)
}

function shell({ title, body, buttonText = 'Open SideFlip →', buttonUrl = APP_URL }) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#FAFAF7;padding:40px 24px;">
      <div style="font-size:36px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px;">
        <span style="color:#1A1917;">Side</span><span style="color:#C8402F;">Flip</span>
      </div>
      <h1 style="font-size:22px;color:#1A1917;margin:24px 0 12px;">${title}</h1>
      ${body}
      <a href="${buttonUrl}" style="display:inline-block;background:#C8402F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
        ${buttonText}
      </a>
      <hr style="border:none;border-top:1px solid #E8E4DE;margin:36px 0;" />
      <p style="color:#8C8880;font-size:13px;line-height:1.6;">
        Questions? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#C8402F;">${SUPPORT_EMAIL}</a>.<br/>
        — Tyler, SideFlip
      </p>
    </div>
  `
}

export async function sendWelcomeEmail(email, subscription = {}) {
  const price = formatPrice(subscription.unitAmount, subscription.currency)
  const interval = subscription.interval === 'year' ? 'year' : 'month'
  const chargeDate = formatDate(subscription.trialEnd)

  return resend.emails.send({
    from: FROM,
    to: email,
    subject: `Your SideFlip trial is active — first charge ${chargeDate}`,
    html: shell({
      title: 'Your 7-day free trial has started',
      body: `
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:16px;">
          You selected the <strong>SideFlip ${interval === 'year' ? 'annual' : 'monthly'} plan</strong>.
          Unless you cancel before <strong>${chargeDate}</strong>, your payment method will be charged
          <strong>${price}</strong> and the subscription will renew every ${interval} until canceled.
        </p>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          You can manage or cancel your subscription online at any time from SideFlip Settings.
          Cancel before the trial ends to avoid the first charge.
        </p>
      `,
      buttonText: 'Manage Subscription →',
      buttonUrl: SETTINGS_URL,
    })
  })
}

export async function sendTrialEndingEmail(email, subscription = {}) {
  const price = formatPrice(subscription.unitAmount, subscription.currency)
  const interval = subscription.interval === 'year' ? 'year' : 'month'
  const chargeDate = formatDate(subscription.trialEnd)

  return resend.emails.send({
    from: FROM,
    to: email,
    subject: `Reminder: Your SideFlip trial ends ${chargeDate}`,
    html: shell({
      title: 'Your SideFlip trial is ending soon',
      body: `
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:16px;">
          Your free trial ends on <strong>${chargeDate}</strong>. Unless you cancel before then,
          your payment method will be charged <strong>${price}</strong> and your subscription will
          renew every ${interval} until canceled.
        </p>
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          To avoid the charge, open Settings and cancel your subscription before the trial ends.
        </p>
      `,
      buttonText: 'Manage or Cancel Subscription →',
      buttonUrl: SETTINGS_URL,
    })
  })
}

export async function sendCancellationScheduledEmail(email, subscription = {}) {
  const accessEnd = formatDate(subscription.accessEnd)
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Your SideFlip subscription cancellation is confirmed',
    html: shell({
      title: 'Your cancellation is confirmed',
      body: `
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Your SideFlip subscription will not renew. You can continue using your paid access through
          <strong>${accessEnd}</strong>. No further renewal charge will be made unless you reactivate.
        </p>
      `,
      buttonText: 'View Account →',
      buttonUrl: SETTINGS_URL,
    })
  })
}

export async function sendTrialCanceledEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Your SideFlip trial cancellation is confirmed',
    html: shell({
      title: 'Your trial has been canceled',
      body: `
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Your SideFlip trial has been canceled and no subscription charge will be made.
          Your account remains available if you choose to subscribe in the future.
        </p>
      `,
      buttonText: 'Return to SideFlip →',
    })
  })
}

export async function sendPaymentFailedEmail(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Action needed — SideFlip payment failed',
    html: shell({
      title: "We couldn't process your payment",
      body: `
        <p style="color:#5C5850;font-size:15px;line-height:1.7;margin-bottom:24px;">
          Your SideFlip subscription payment did not go through. Please update your payment method
          through Settings to prevent an interruption in access.
        </p>
      `,
      buttonText: 'Update Payment Method →',
      buttonUrl: SETTINGS_URL,
    })
  })
}
