import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { removeUserPrivateMedia } from '../api/_lib/account-media-cleanup.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function storageFixture({
  fileCount = 1001,
  failListOnce = false,
  failRemoveOnce = false,
  removeMakesProgress = true,
} = {}) {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    id: `object-${index}`,
    name: `${String(index).padStart(4, '0')}.jpg`,
    metadata: { mimetype: 'image/jpeg' },
  }))
  const entries = new Map([
    [USER_ID, [{ id: null, name: 'items', metadata: null }]],
    [`${USER_ID}/items`, [{ id: null, name: '33333333-3333-4333-8333-333333333333', metadata: null }]],
    [`${USER_ID}/items/33333333-3333-4333-8333-333333333333`, [{ id: null, name: 'photos', metadata: null }]],
    [`${USER_ID}/items/33333333-3333-4333-8333-333333333333/photos`, files],
  ])
  const listCalls = []
  const removeCalls = []
  let shouldFailList = failListOnce
  let shouldFail = failRemoveOnce

  const storage = {
    from(bucket) {
      assert.equal(bucket, 'my-stuff-media')
      return {
        async list(prefix, options) {
          listCalls.push({ prefix, options })
          if (shouldFailList) {
            shouldFailList = false
            return { data: null, error: new Error('synthetic list failure') }
          }
          const visible = (entries.get(prefix) || []).filter(entry => {
            if (entry.id || entry.metadata != null) return true
            const childPrefix = `${prefix}/${entry.name}`
            return [...entries].some(([candidate, values]) =>
              (candidate === childPrefix || candidate.startsWith(`${childPrefix}/`)) &&
              values.some(value => value.id || value.metadata != null))
          })
          return { data: visible.slice(options.offset, options.offset + options.limit), error: null }
        },
        async remove(paths) {
          removeCalls.push(paths)
          if (shouldFail) {
            shouldFail = false
            return { data: null, error: new Error('synthetic remove failure') }
          }
          if (removeMakesProgress) {
            for (const path of paths) {
              const slash = path.lastIndexOf('/')
              const prefix = path.slice(0, slash)
              const name = path.slice(slash + 1)
              entries.set(prefix, (entries.get(prefix) || []).filter(entry => entry.name !== name))
            }
          }
          return { data: paths, error: null }
        },
      }
    },
  }

  return { storage, entries, listCalls, removeCalls }
}

test('private-media cleanup recursively drains more than one page from offset zero', async () => {
  const fixture = storageFixture()
  await removeUserPrivateMedia(fixture.storage, USER_ID)

  assert.equal(fixture.entries.get(`${USER_ID}/items/33333333-3333-4333-8333-333333333333/photos`).length, 0)
  assert.deepEqual(fixture.removeCalls.map(paths => paths.length), [1000, 1])
  const leafLists = fixture.listCalls.filter(call => call.prefix.endsWith('/photos'))
  assert.ok(leafLists.length >= 3)
  assert.ok(leafLists.every(call => call.options.offset === 0 && call.options.limit === 1000))
})

test('private-media cleanup fails closed on Storage errors and succeeds on retry', async () => {
  const fixture = storageFixture({ fileCount: 2, failRemoveOnce: true })

  await assert.rejects(removeUserPrivateMedia(fixture.storage, USER_ID), /synthetic remove failure/)
  assert.equal(fixture.entries.get(`${USER_ID}/items/33333333-3333-4333-8333-333333333333/photos`).length, 2)

  await removeUserPrivateMedia(fixture.storage, USER_ID)
  assert.equal(fixture.entries.get(`${USER_ID}/items/33333333-3333-4333-8333-333333333333/photos`).length, 0)
})

test('private-media cleanup checks list errors', async () => {
  const fixture = storageFixture({ fileCount: 2, failListOnce: true })
  await assert.rejects(removeUserPrivateMedia(fixture.storage, USER_ID), /synthetic list failure/)
  assert.equal(fixture.removeCalls.length, 0)
})

test('private-media cleanup detects a successful remove response that makes no progress', async () => {
  const fixture = storageFixture({ fileCount: 2, removeMakesProgress: false })
  await assert.rejects(removeUserPrivateMedia(fixture.storage, USER_ID), /made no progress/)
  assert.equal(fixture.removeCalls.length, 1)
})

test('private-media cleanup rejects hierarchy deeper than its traversal bound', async () => {
  const entries = new Map()
  let prefix = USER_ID
  for (let depth = 0; depth < 10; depth += 1) {
    entries.set(prefix, [{ id: null, name: `level-${depth}`, metadata: null }])
    prefix = `${prefix}/level-${depth}`
  }
  entries.set(prefix, [{ id: 'too-deep', name: 'file.jpg', metadata: {} }])
  const storage = {
    from() {
      return {
        async list(path) { return { data: entries.get(path) || [], error: null } },
        async remove() { throw new Error('remove must not be reached') },
      }
    },
  }

  await assert.rejects(removeUserPrivateMedia(storage, USER_ID), /bounded hierarchy/)
})

test('account deletion integrates both checked storage cleanups before Auth deletion', () => {
  const source = readFileSync(new URL('../api/delete-account.js', import.meta.url), 'utf8')
  const projects = source.indexOf('removeUserPhotos(user.id)')
  const privateMedia = source.indexOf('removeUserPrivateMedia(supabase.storage, user.id)')
  const auth = source.indexOf('auth.admin.deleteUser')

  assert.ok(projects >= 0 && privateMedia >= 0 && auth >= 0)
  assert.ok(projects < auth && privateMedia < auth)
  assert.match(source, /await removeUserPrivateMedia\(supabase\.storage, user\.id\)/)
})
