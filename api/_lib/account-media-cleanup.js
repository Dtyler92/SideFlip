const PRIVATE_MEDIA_BUCKET = 'my-stuff-media'
const STORAGE_PAGE_SIZE = 1000
const MAX_PREFIX_DEPTH = 8
const MAX_LIST_CALLS = 1000

function childPath(prefix, name) {
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new Error('Storage returned an invalid object path segment')
  }
  return `${prefix}/${name}`
}

function pageSignature(entries) {
  return entries.map(entry => `${entry.id || ''}:${entry.metadata == null ? 'folder' : 'file'}:${entry.name}`).join('\n')
}

async function drainPrefix(bucket, prefix, depth, traversal) {
  if (depth > MAX_PREFIX_DEPTH) throw new Error('Private media path exceeds the bounded hierarchy')

  let previousPage = null
  for (;;) {
    traversal.listCalls += 1
    if (traversal.listCalls > MAX_LIST_CALLS) throw new Error('Private media cleanup exceeded its bounded traversal')

    const { data, error } = await bucket.list(prefix, { limit: STORAGE_PAGE_SIZE, offset: 0 })
    if (error) throw error
    if (data != null && !Array.isArray(data)) throw new Error('Storage returned an invalid list response')

    const entries = data || []
    if (!entries.length) return
    for (const entry of entries) childPath(prefix, entry?.name)

    const signature = pageSignature(entries)
    if (signature === previousPage) throw new Error('Private media cleanup made no progress')
    previousPage = signature

    const folders = entries.filter(entry => !entry.id && entry.metadata == null)
    const files = entries.filter(entry => entry.id || entry.metadata != null)

    for (const folder of folders) {
      await drainPrefix(bucket, childPath(prefix, folder.name), depth + 1, traversal)
    }

    if (files.length) {
      const paths = files.map(file => childPath(prefix, file.name))
      const { error: removeError } = await bucket.remove(paths)
      if (removeError) throw removeError
    }

    // Removing objects shifts subsequent results forward. Re-list this prefix
    // from offset zero until the service confirms it is empty. Repeated pages
    // and a shared call budget fail closed instead of spinning indefinitely.
  }
}

export async function removeUserPrivateMedia(storage, userId) {
  const bucket = storage.from(PRIVATE_MEDIA_BUCKET)
  await drainPrefix(bucket, userId, 0, { listCalls: 0 })
}
