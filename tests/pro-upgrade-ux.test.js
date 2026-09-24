import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isMyStuffItemLockedAfterProLoss } from '../src/myStuff/mutation.js'

const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

test('Free downgrade preserves the deterministic oldest My Stuff item and locks newer records', () => {
  const items = [
    { id: 'newest', created_at: '2026-09-08T12:00:00Z' },
    { id: 'oldest', created_at: '2026-08-01T12:00:00Z' },
    { id: 'middle', created_at: '2026-09-01T12:00:00Z' },
  ]
  assert.equal(isMyStuffItemLockedAfterProLoss(items[1], items, 'free'), false)
  assert.equal(isMyStuffItemLockedAfterProLoss(items[0], items, 'free'), true)
  assert.equal(isMyStuffItemLockedAfterProLoss(items[2], items, 'free'), true)
  assert.equal(isMyStuffItemLockedAfterProLoss(items[0], items, 'pro'), false)
})

test('My Stuff list visibly locks newer records and uses the requested service-interval copy', () => {
  const page = source('src/pages/MyStuff.jsx')
  const css = source('src/pages/myStuff.css')
  assert.match(page, /Keep track of service intervals for your items/)
  assert.match(page, /isMyStuffItemLockedAfterProLoss/)
  assert.match(page, /mystuff-item-locked/)
  assert.match(page, /SideFlip Pro required/)
  assert.match(css, /\.mystuff-item-locked/)
  const detail = source('src/pages/MyStuffDetail.jsx')
  assert.match(detail, /accessPlan !== plan/)
  assert.match(detail, /setItem\(null\)/)
  assert.doesNotMatch(page, /Your existing items and their history always remain available/)
})

test('Pro actions use a reusable upgrade screen with Dismiss and no suppression state', () => {
  const prompt = source('src/components/UpgradePrompt.jsx')
  assert.match(prompt, /role="dialog"/)
  assert.match(prompt, /aria-modal="true"/)
  assert.match(prompt, />Dismiss</)
  assert.match(prompt, /Upgrade to SideFlip Pro/)
  assert.match(prompt, /previousFocus/)
  assert.match(prompt, /event\.key === 'Tab'/)
  assert.match(prompt, /\.focus\(\)/)
  assert.doesNotMatch(prompt, /localStorage|sessionStorage|suppress/i)

  for (const page of ['src/pages/MyStuff.jsx', 'src/pages/MyStuffCreate.jsx', 'src/pages/MyStuffDetail.jsx', 'src/pages/NewProject.jsx', 'src/pages/ProjectDetail.jsx', 'src/pages/Goals.jsx']) {
    assert.match(source(page), /UpgradePrompt/)
  }
})

test('Free photo limit opens the SideFlip upgrade screen without a browser confirm dialog', () => {
  const gallery = source('src/components/ProjectPhotoGallery.jsx')
  assert.doesNotMatch(gallery, /confirm\(`Free projects include/)
  assert.match(gallery, /plan === 'free'.*onUpgrade/s)
})

test('entitlements refresh on a timer so expiry does not wait for focus', () => {
  const auth = source('src/context/AuthContext.jsx')
  assert.match(auth, /expires_at/)
  assert.match(auth, /setTimeout\(refreshEntitlement/)
})
