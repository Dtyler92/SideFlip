// Actual CLI -> shared validator -> service RPC -> authenticated SQL readback.
import assert from 'node:assert/strict'
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const database = process.argv[2]
const storage = localTemplateStorage(database) // reject unsafe target before doing anything
const owner = '11111111-1111-4111-8111-111111111111'
const root = new URL('../../', import.meta.url)
const template = JSON.parse(readFileSync(new URL('tests/fixtures/scion-2012-xd-template.json', root)))
const input = {extraction: template, provenance: {documentId: template.source.id, sha256: template.source.sha256, sourceVersion: template.source.version, authenticity: 'user_uploaded_unverified'}, templateKey: 'cli-ingestion-scion', version: 1}
function sql(query) {
  const r = spawnSync('sudo', ['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'], {input: query, encoding:'utf8', maxBuffer: 16*1024*1024})
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim()
}
const tables = JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'manufacturer_template_versions';"))
const snapshots = () => Object.fromEntries(tables.map(t => [t, JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public."${t.replaceAll('"','""')}" t;`))]))
const before = snapshots()
const temp = mkdtempSync(join(tmpdir(), 'template-ingestion-'))
try {
  const file = join(temp, 'input.json')
  function cli(value, args = [], succeeds = true) {
    writeFileSync(file, JSON.stringify(value))
    const r = spawnSync(process.execPath, ['--experimental-default-type=module', new URL('scripts/import-manufacturer-template.mjs', root).pathname, '--input', file, ...args], {encoding:'utf8', maxBuffer: 8*1024*1024})
    assert.equal(r.status === 0, succeeds, r.stderr)
    return succeeds ? JSON.parse(r.stdout) : r.stderr
  }
  const args = ['--write','--local-db',database,'--owner',owner]
  assert.equal(cli(input).persisted, false)
  cli(input, ['--write','--local-db','production','--owner',owner], false)
  const first = cli(input, args).row
  assert.deepEqual(first.record.payload, template)
  assert.equal(first.record.status, 'needs_review')
  assert.equal(cli(input, args).row.id, first.id)
  const secondInput = structuredClone(input)
  secondInput.version = 2
  secondInput.identityReview = {reviewedBy:'local test operator', evidence:'explicit retained identity inspection test', applicability:template.applicability}
  const second = cli(secondInput, args).row
  assert.notEqual(second.id, first.id)
  assert.equal(second.record.applicability_reviewed, true)
  assert.equal(second.record.source_authenticity, 'user_uploaded_unverified')
  assert.deepEqual(await storage.read(owner, first.id), first)
  cli({...secondInput, version: 1}, args, false)
  for (const mutate of [x => {x.provenance.sha256='c'.repeat(64)}, x => {x.provenance.sourceVersion='wrong'}, x => {x.extraction.rules[0].condition={op:'bogus'}}, x => {x.extraction.rules[0].evidenceIds=[]}]) {
    const invalid = structuredClone(input); invalid.version=3; mutate(invalid); cli(invalid,args,false)
  }
  for(const mutate of [ti=>delete ti.mode,ti=>ti.mode='unknown',ti=>ti.mode=1,ti=>ti.instruction={},ti=>ti.interval={miles:5000}]) {
    const invalid=structuredClone(input);invalid.version=3;
    mutate(invalid.extraction.rules.find(r=>r.id==='reset-reminder').timing);
    assert.match(cli(invalid,args,false),/invalid monitor/);
  }
  assert.equal(sql("select count(*) from public.manufacturer_template_versions where template_key='cli-ingestion-scion';"), '2')
  assert.equal(await storage.read('22222222-2222-4222-8222-222222222222', first.id), null)
  assert.equal(sql(`set role authenticated; set request.jwt.claim.sub='${owner}'; select count(*) from public.find_my_manufacturer_templates('${JSON.stringify(template.applicability).replaceAll("'","''")}'::jsonb) where template_key='cli-ingestion-scion';`), '0')
  assert.deepEqual(snapshots(), before, 'Existing public records changed')
  console.log(JSON.stringify({result:'PASS', realCLI:true, realServiceRPC:true, authenticatedReadback:true, rules: first.record.payload.rules.length, evidence:first.record.payload.evidence.length, immutableVersions:2, preservedPublicTables:tables.length, invalidInputsNotStored:true, nativePayloadPath:'row.record.payload'}))
} finally {rmSync(temp,{recursive:true,force:true})}
