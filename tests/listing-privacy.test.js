import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const privacy = readFileSync(new URL('../src/pages/PrivacyPolicy.jsx', import.meta.url), 'utf8')

test('privacy policy discloses listing-generation data sent to xAI', () => {
  assert.match(privacy, /xAI/)
  assert.match(privacy, /seller brief/i)
  assert.match(privacy, /project notes/i)
  assert.match(privacy, /expense descriptions/i)
  assert.match(privacy, /listing description/i)
})
