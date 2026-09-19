import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  sanitizeAsset,
  validateEvidenceRegistry,
  validateNormalizedCandidates,
  validateUnresolvedResults,
} from '../supabase/functions/_shared/research-validators.js'

const migrationUrl=new URL('../supabase/migrations/20260919190000_focus_simple_maintenance_research.sql',import.meta.url)
const blockerFixUrl=new URL('../supabase/migrations/20260919191000_fix_simple_maintenance_review_blockers.sql',import.meta.url)

const evidence = () => ({
  id:'e1',title:'Owner guide',canonicalUrl:'https://manuals.example.com/guide',
  exactExcerpt:'Replace engine oil every 7,500 miles.',accessedAt:new Date().toISOString(),
  applicability:'2020 example vehicle',sourceClass:'manufacturer',section:'Maintenance',
  locationVerified:false,verificationStatus:'provider_citation_unconfirmed',
})

const domain = accessedAt => ({
  domain:'example.com',sourceClass:'manufacturer',includeSubdomains:true,allowedPathPrefixes:['/'],
  termsReviewedOn:accessedAt.slice(0,10),robotsReviewedOn:accessedAt.slice(0,10),
})

test('provider identity is exactly year, make, model, engine size, and optional transmission', () => {
  const input={
    modelYear:2020,make:'Honda',model:'Civic',engine:'1.5L',transmission:'Manual',
    trim:'EX',drivetrain:'FWD',fuel:'Gasoline',market:'US',vehicleType:'Passenger car',
    vin:'1HGCM82633A004352',notes:'private',userId:'private',costs:[99],
  }
  assert.deepEqual(sanitizeAsset(input),{
    modelYear:2020,make:'Honda',model:'Civic',engine:'1.5L',transmission:'Manual',
  })
  assert.deepEqual(sanitizeAsset({...input,transmission:null}),{
    modelYear:2020,make:'Honda',model:'Civic',engine:'1.5L',
  })
  assert.throws(()=>sanitizeAsset({...input,engine:null}),{code:'IDENTITY_UNCONFIRMED'})
})

test('provider result validators reject unknown fields and fractional intervals', () => {
  const item=evidence()
  const registry=validateEvidenceRegistry([item],[domain(item.accessedAt)],[{canonicalUrl:item.canonicalUrl}],new Date(item.accessedAt))
  const candidate={name:'Engine oil',action:'replace',profile:'normal',dueSemantics:'whichever_first',intervalMiles:7500,evidenceIds:['e1'],uncertainty:'low',conflict:false}
  assert.deepEqual(validateNormalizedCandidates([candidate],registry),[candidate])
  assert.throws(()=>validateEvidenceRegistry([{...item,unexpected:'x'}],[domain(item.accessedAt)],[{canonicalUrl:item.canonicalUrl}],new Date(item.accessedAt)),{code:'INVALID_EVIDENCE'})
  assert.throws(()=>validateNormalizedCandidates([{...candidate,unexpected:'x'}],registry),{code:'INVALID_CANDIDATE'})
  assert.throws(()=>validateNormalizedCandidates([{...candidate,intervalMiles:7500.5}],registry),{code:'INVALID_CANDIDATE'})
  assert.throws(()=>validateUnresolvedResults([{name:'Coolant',reason:'No supported interval.',unexpected:'x'}]),{code:'INVALID_UNRESOLVED'})
})

test('additive migration narrows snapshots and uses one alias-aware source policy everywhere', () => {
  const baseSql=readFileSync(migrationUrl,'utf8')
  const fixSql=readFileSync(blockerFixUrl,'utf8')
  const sql=`${baseSql}\n${fixSql}`
  assert.match(sql,/create or replace function private\.my_stuff_research_source_matches_make_v1/i)
  assert.match(sql,/unnest\(d\.manufacturer_aliases\)/i)
  assert.match(sql,/create or replace function private\.my_stuff_research_policy_is_current_v1/i)
  assert.match(sql,/create or replace function public\.enqueue_my_stuff_research_v3/i)
  assert.match(sql,/create or replace function private\.settle_my_stuff_research_job_v4/i)
  assert.match(sql,/IDENTITY_INCOMPLETE/i)
  assert.match(sql,/v_item\.engine_displacement_liters is null[\s\S]+IDENTITY_INCOMPLETE/i)
  assert.match(sql,/jsonb_build_object\(\s*'modelYear'[^;]+'make'[^;]+'model'[^;]+'engine'[^;]+'transmission'/is)
  assert.doesNotMatch(sql,/jsonb_build_object\(\s*'modelYear'[^;]+'trim'|'drivetrain'\s*,\s*v_item|'fuel'\s*,\s*v_item|'market'\s*,\s*v_item|'vehicleType'\s*,\s*v_item/is)
  assert.doesNotMatch(fixSql,/coalesce\([^;]*(?:v_item\.engine\b|v_item\.engine_model)/i)
  assert.match(fixSql,/my_stuff_research_source_matches_make_v1\(d\.domain,v_job\.request_snapshot->>'make'\)/i)
  assert.match(sql,/private\.my_stuff_research_source_matches_make_v1\(d\.domain,j\.request_snapshot->>'make'\)/i)
  assert.match(sql,/private\.my_stuff_research_source_matches_make_v1\(domain,v_job\.request_snapshot->>'make'\)/i)
  assert.match(fixSql,/exception when unique_violation[\s\S]+select \* into v_existing[\s\S]+v_existing\.item_id<>p_item_id[\s\S]+v_existing\.confirmed_fingerprint<>p_confirmed_fingerprint/i)
  assert.match(sql,/revoke execute on function private\.my_stuff_research_source_matches_make_v1\(text,text\) from public,anon,authenticated,service_role/i)
})
