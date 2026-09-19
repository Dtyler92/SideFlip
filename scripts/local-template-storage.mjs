import { spawnSync } from 'node:child_process'
// No URL, credentials, linked Supabase config, remote host, or arbitrary database.
export function localTemplateStorage(database) {
  if (!/^sideflip_manufacturer_template_test_[0-9]+$/.test(database || '')) throw Error('Refusing non-disposable local database')
  const literal = x => "'" + String(x).replaceAll("'", "''") + "'"
  const json = x => literal(JSON.stringify(x)) + '::jsonb'
  function query(sql, role, owner) {
    const result = spawnSync('sudo', ['-u', 'postgres', 'env', '-i', 'PATH=/usr/bin:/bin', 'psql', '-XAtq', '-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], {
      input: `set role ${role}; set request.jwt.claim.sub=${literal(owner)}; ${sql}`,
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw Error(result.stderr || 'Local PostgreSQL operation failed')
    return result.stdout.trim()
  }
  return {
    append: async (owner, record) => query(`select public.store_manufacturer_template_version(${literal(owner)}::uuid,${json(record)});`, 'service_role', owner),
    read: async (owner, id) => {
      const text = query(`select row_to_json(t) from public.manufacturer_template_versions t where id=${literal(id)}::uuid and owner_id=${literal(owner)}::uuid;`, 'authenticated', owner)
      return text ? JSON.parse(text) : null
    },
  }
}
