#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { prepareTemplateIngestion, ingestTemplate } from '../supabase/functions/_shared/manufacturer-template-ingestion.js'
import { localTemplateStorage } from './local-template-storage.mjs'
try {
  const {values} = parseArgs({options: {input: {type: 'string'}, owner: {type: 'string'}, 'local-db': {type: 'string'}, write: {type: 'boolean', default: false}}, allowPositionals: false})
  if (!values.input) throw Error('Required --input extraction-envelope.json; default dry-run. Writes require --write --local-db sideflip_manufacturer_template_test_<digits> --owner UUID')
  const input = JSON.parse(readFileSync(values.input, 'utf8'))
  const record = prepareTemplateIngestion(input)
  if (!values.write) {
    if (values['local-db'] || values.owner) throw Error('Database/owner options require explicit --write')
    console.log(JSON.stringify({dryRun: true, persisted: false, record}))
  } else {
    const row = await ingestTemplate(input, {ownerId: values.owner, storage: localTemplateStorage(values['local-db'])})
    console.log(JSON.stringify({dryRun: false, persisted: true, row}))
  }
} catch (error) {
  console.error(JSON.stringify({persisted: false, error: error.message}))
  process.exitCode = 1
}
