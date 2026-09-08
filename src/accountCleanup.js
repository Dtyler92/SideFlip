const SIDEFLIP_STORAGE_PREFIXES = Object.freeze([
  'sideflip_',
  'sf_',
  'flipledger_',
  'ph_sideflip',
])

function clearOwnedKeys(storage) {
  if (!storage) return
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && SIDEFLIP_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

export async function clearSideFlipBrowserData(browser = typeof window === 'undefined' ? {} : window) {
  const failures = []
  for (const [name, storage] of [['localStorage', browser.localStorage], ['sessionStorage', browser.sessionStorage]]) {
    try { clearOwnedKeys(storage) } catch { failures.push(name) }
  }
  if (failures.length) throw new Error(`Could not clear ${failures.join(' and ')}.`)
  return true
}
