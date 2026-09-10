import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { requireJpegBlob } from '../src/media/jpeg.js'

const source = readFileSync(new URL('../src/supabase.js', import.meta.url), 'utf8')

test('project photo uploads always store browser-decodable JPEG output', () => {
  assert.match(source, /const path = `\$\{userId\}\/\$\{objectId\}\.jpg`/)
  assert.match(source, /contentType: 'image\/jpeg'/)
  assert.match(source, /canvas\.toBlob\([\s\S]*'image\/jpeg'/)
  assert.match(source, /requireJpegBlob\(blob\)/)
  assert.doesNotMatch(source, /blob \|\| file/)
  assert.doesNotMatch(source, /replace\('heic', 'jpg'\)/)
})

test('JPEG validation rejects null and non-JPEG canvas fallbacks', () => {
  assert.throws(() => requireJpegBlob(null), /Could not convert this image to JPEG/)
  assert.throws(() => requireJpegBlob(new Blob(['png'], { type: 'image/png' })), /Could not convert this image to JPEG/)
  const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
  assert.equal(requireJpegBlob(jpeg), jpeg)
})

test('unsupported or unreadable image formats fail clearly instead of hanging', () => {
  assert.match(source, /reader\.onerror\s*=/)
  assert.match(source, /img\.onerror\s*=/)
  assert.match(source, /if \(!context\)/)
})
