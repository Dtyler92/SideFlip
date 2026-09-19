// Runs after the original 26 acceptance groups; no network/provider calls.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
export async function reviewCorrections(c) {
 const {sql,asyncSql,q,json,rpcSql,fixture,jobs,source,counts,finalize,recordFor,owner,item,legacy,out,db,bundle,retainedExtraction,processLeasedJob,storage}=c
 const probes=[],regressions=[]
 const note=(name,evidence)=>{probes.push({name,evidence});console.log('INDEPENDENT '+name)}
 const pass=(name,evidence={})=>{regressions.push({name,evidence});console.log('CORRECTION '+name)}
 const denied=async statement=>{const message=await asyncSql(statement).then(()=>'',e=>e.message);assert.ok(message);return message.trim()}
 const failSql=(x,t,code='DOCUMENT_EXTRACTION_FAILED')=>'set role service_role;'+rpcSql('fail_document_job_v1',{p_binding:x.b,p_attempt_id:x.attemptId,p_cost_ticks:t,p_code:code})
 const preSql=x=>'set role service_role;'+rpcSql('fail_document_preflight_v1',{p_binding:x.b,p_attempt_id:x.attemptId})
 const claimSql=x=>'set role service_role;'+rpcSql('claim_document_job_v1',{p_binding:x.b,p_source:source})
 const state=x=>sql(`select state from private.my_stuff_document_executions where job_id=${q(x.b.jobId)}`)
 const zeroEffects=x=>assert.deepEqual(counts(x.b),{templates:0,settlements:0,releases:0})
 const usage=x=>JSON.parse(sql(`select jsonb_build_object('ticks',a.usage_ticks,'cents',a.usage_cents,'release',(select cents from private.my_stuff_research_budget_ledger where job_id=a.job_id and kind='release'),'attemptStatus',a.status) from private.my_stuff_research_attempts a where id=${q(x.attemptId)}`))
 const cancelSql=(x,u=owner)=>`set session authorization authenticated;set request.jwt.claim.sub=${q(u)};select public.cancel_my_stuff_research_v1(${q(x.b.jobId)},${q(randomUUID())})`
 sql(`set role authenticated;set request.jwt.claim.sub=${q(owner)};select public.cancel_my_stuff_research_v1(${q(legacy.id)},'corrections-retire-legacy-fixture')`)
 const z=await fixture()
 for(const b of [{...z.b,reservedCents:'25'},{...z.b,jobRevision:'1'},{...z.b,jobId:z.b.jobId.toUpperCase()},{...z.b,extra:true}]) await denied('set role service_role;'+rpcSql('claim_document_job_v1',{p_binding:b,p_source:source}))
 for(const s of [{...source,selectedPages:['561']},{...source,selectedPages:[0]},{...source,selectedPages:[1.5]},{...source,sourceSha256:123},{...source,extra:true}]) await denied('set role service_role;'+rpcSql('claim_document_job_v1',{p_binding:z.b,p_source:s}))
 assert.equal(state(z),'ready');note('JSON coercion and extra authority/source fields fail closed',{bindingCases:4,sourceCases:5})
 const sameFail=await fixture();await jobs.claim({binding:sameFail.b,source})
 await Promise.all(Array.from({length:5},()=>asyncSql(failSql(sameFail,1))))
 assert.deepEqual(counts(sameFail.b),{templates:0,settlements:1,releases:1});assert.equal(usage(sameFail).ticks,1)
 note('five competing failure settlements round one tick up once',usage(sameFail))
 assert.match(await denied(failSql(sameFail,2)),/DOCUMENT_FAILURE_CONFLICT/);note('conflicting failure replay denied',counts(sameFail.b))
 const cf=await fixture();await jobs.claim({binding:cf.b,source});const cfRecord=await recordFor(cf.b)
 const cfResults=await Promise.allSettled([asyncSql(finalize(cf.b,cf.attemptId,cfRecord)),asyncSql(failSql(cf,150000001))])
 const cfCounts=counts(cf.b);assert.equal(cfCounts.settlements,1);assert.equal(cfCounts.releases,1);assert.ok(cfCounts.templates<=1)
 note('finalize versus failure race has one terminal accounting effect',{results:cfResults.map(x=>x.status),counts:cfCounts})
 const ca=await fixture();await jobs.claim({binding:ca.b,source})
 assert.equal(await asyncSql(cancelSql(ca)),'t');await denied(finalize(ca.b,ca.attemptId,await recordFor(ca.b)))
 await asyncSql(failSql(ca,1));note('actual owner cancellation blocks append and retains known cost',{status:state(ca),usage:usage(ca)})
 const pf=await fixture();await jobs.claim({binding:pf.b,source})
 assert.equal(await asyncSql(failSql(pf,0,'DOCUMENT_SOURCE_UNAVAILABLE')),'f');zeroEffects(pf);assert.equal(state(pf),'attempted')
 await asyncSql(failSql(pf,150000001));assert.deepEqual(usage(pf),{ticks:150000001,cents:2,release:23,attemptStatus:'failed'})
 note('FIXED stale preflight cannot zero-settle claimed work',usage(pf))

 // Force genuine overlapping SQL transactions, observe the losing connection's
 // Lock wait, then commit the winning transition. Both orders are deterministic.
 async function waitFor(name,predicate){for(let n=0;n<200;n++){if(sql(`select exists(select 1 from pg_stat_activity where datname=current_database() and application_name=${q(name)} and ${predicate})`)==='t')return;await new Promise(r=>setTimeout(r,10))}assert.fail('no observed wait: '+name)}
 async function ordered(first,second){
  const id=randomUUID(),winner='correction-first-'+id,loser='correction-second-'+id
  const a=asyncSql(`set application_name=${q(winner)};begin;${first};select pg_sleep(3);commit;`).then(value=>({value}),error=>({error:error.message}))
  await waitFor(winner,"wait_event='PgSleep'")
  const b=asyncSql(`set application_name=${q(loser)};${second}`).then(value=>({value}),error=>({error:error.message}))
  await waitFor(loser,"wait_event_type='Lock'")
  return {first:await a,second:await b,observedLock:true}
 }
 // Two deliveries share an adopted binding: A stalls in acquisition, B has
 // acknowledged SQL claim and begins offline extraction before A fails.
 for(const ticks of [150000001,null]){
  const x=await fixture();let releaseA,releaseB,startedB,startedA,invoked=0
  const holdA=new Promise(r=>releaseA=r),holdB=new Promise(r=>releaseB=r)
  const acquired=new Promise(r=>startedA=r),extracting=new Promise(r=>startedB=r)
  const options={lease:x.lease,config:{documentLaneEnabled:true},documentLane:{jobs,storage}}
  const a=processLeasedJob({...options,documentLane:{...options.documentLane,acquireDocument:async()=>{startedA();await holdA;throw Error('offline acquisition failure')},extract:async()=>{assert.fail('A cannot extract')}}}).then(()=>assert.fail('A must fail'),e=>e)
  await acquired
  const b=processLeasedJob({...options,documentLane:{...options.documentLane,acquireDocument:async()=>bundle,extract:async()=>{invoked++;startedB();await holdB;throw Object.assign(Error('offline provider failure'),ticks===null?{}:{costInUsdTicks:ticks})}}}).then(()=>assert.fail('B must fail'),e=>e)
  await extracting;releaseA();await a
  assert.equal(await asyncSql(preSql(x)),'f');assert.equal(await asyncSql(failSql(x,0,'DOCUMENT_SOURCE_UNAVAILABLE')),'f')
  assert.equal(state(x),'attempted');zeroEffects(x);assert.equal(invoked,1)
  releaseB();await b
  assert.deepEqual(counts(x.b),{templates:0,settlements:1,releases:1})
  assert.deepEqual(usage(x),{ticks,cents:ticks===null?25:2,release:ticks===null?0:23,attemptStatus:'failed'})
  const saved=usage(x);assert.equal(await asyncSql(preSql(x)),'f');assert.deepEqual(usage(x),saved)
  pass('two deliveries: delayed acquisition loses to offline extraction '+(ticks===null?'unknown':'known'),{invoked,usage:saved})
 }
 for(const first of ['claim','preflight']){
  const x=await fixture();const r=await ordered(first==='claim'?claimSql(x):preSql(x),first==='claim'?preSql(x):claimSql(x))
  assert.ok(!r.first.error,JSON.stringify(r))
  if(first==='claim'){
   assert.equal(r.second.value,'f');assert.equal(state(x),'attempted');zeroEffects(x)
   await asyncSql(failSql(x,null));assert.equal(usage(x).release,0)
  }else{
   assert.equal(JSON.parse(r.second.value).claimed,false);assert.equal(state(x),'failed')
   await Promise.all(Array.from({length:5},()=>asyncSql(preSql(x))))
   assert.deepEqual(counts(x.b),{templates:0,settlements:1,releases:1});assert.equal(usage(x).release,25)
  }
  pass('observed claim/preflight lock race '+first+' first',r)
 }
 for(const first of ['cancel','preflight']){
  const x=await fixture();const r=await ordered(first==='cancel'?cancelSql(x):preSql(x),first==='cancel'?preSql(x):cancelSql(x))
  assert.ok(!r.first.error&&!r.second.error,JSON.stringify(r));assert.equal(state(x),'failed');assert.equal(usage(x).release,25)
  assert.equal(sql(`select cancellation_requested_at is not null from private.my_stuff_research_jobs where id=${q(x.b.jobId)}`),'t')
  assert.deepEqual(counts(x.b),{templates:0,settlements:1,releases:1});pass('observed cancellation/preflight race '+first+' first',r)
 }
 const claimedCancel=await fixture();await jobs.claim({binding:claimedCancel.b,source})
 await Promise.all([asyncSql(preSql(claimedCancel)),asyncSql(cancelSql(claimedCancel))]);zeroEffects(claimedCancel)
 await asyncSql(failSql(claimedCancel,null));assert.equal(usage(claimedCancel).release,0)
 pass('cancellation plus stale preflight after claim preserves unknown reservation',usage(claimedCancel))
 const complete=await fixture();await jobs.claim({binding:complete.b,source});const record=await recordFor(complete.b)
 const id=await asyncSql(finalize(complete.b,complete.attemptId,record));const completeUsage=usage(complete)
 assert.equal(await asyncSql(preSql(complete)),'f');assert.equal(await asyncSql(failSql(complete,0,'DOCUMENT_SOURCE_UNAVAILABLE')),'f')
 assert.equal(await asyncSql(finalize(complete.b,complete.attemptId,record)),id);assert.deepEqual(usage(complete),completeUsage)
 pass('completed replay never regresses or releases twice',{id,usage:completeUsage})
 const ready=await fixture()
 assert.match(await denied(failSql(ready,0)),/DOCUMENT_ATTEMPT_REQUIRED/);zeroEffects(ready)
 for(const ticks of [null,1])assert.match(await denied(failSql(ready,ticks,'DOCUMENT_SOURCE_UNAVAILABLE')),/DOCUMENT_PREFLIGHT_COST_INVALID/)
 for(const role of ['anon','authenticated']) await denied(`set session authorization ${role};select public.fail_document_preflight_v1(${json(ready.b)},${q(ready.attemptId)})`)
 await denied('set role service_role;'+rpcSql('fail_document_preflight_v1',{p_binding:{...ready.b,jobRevision:999},p_attempt_id:ready.attemptId}))
 await denied('set role service_role;'+rpcSql('fail_document_preflight_v1',{p_binding:ready.b,p_attempt_id:randomUUID()}))
 zeroEffects(ready);await jobs.claim({binding:ready.b,source});await asyncSql(failSql(ready,0));assert.equal(usage(ready).release,25)
 pass('separate stages: ready denies attempt accounting; claimed genuine known-zero allowed; forged preflight denied')

 // Fresh owner; use the actual authenticated enqueue and service lease, not a
 // hand-seeded job. Normalize only disposable prior-fixture budgets/queue first.
 sql(`update private.my_stuff_research_jobs set status='cancelled' where status in ('queued','running','awaiting_review','approved');
 update private.my_stuff_research_budget_ledger set month_start=(date_trunc('month',current_date)-interval '2 months')::date where month_start=date_trunc('month',current_date)::date;
 update private.my_stuff_research_runtime_config set enabled=true,document_lane_enabled=true,per_job_budget_cents=306,daily_user_job_cap=2,monthly_user_job_cap=10,monthly_user_budget_cents=2500,global_monthly_budget_cents=2500;
 update private.my_stuff_research_source_domains set terms_reviewed_on=current_date,robots_reviewed_on=current_date where lower(manufacturer)='honda';`)
 const fresh=randomUUID()
 sql(`insert into auth.users(id) values(${q(fresh)});insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at) values(${q(fresh)},'apple','active',now()+interval '30 days',now())`)
 const auth=`set session authorization authenticated;set request.jwt.claim.sub=${q(fresh)};`
 const items=[]
 for(let n=0;n<2;n++){
  const id=sql(auth+`select public.create_my_stuff_item_v2('{"name":"Fresh correction fixture","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}',${q('fresh-item-'+n)})`)
  sql(auth+`select public.confirm_my_stuff_vehicle_identity_v3(${q(id)},'{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}',${q('fresh-confirm-'+n)})`)
  items.push({id,fp:sql(`select vin_confirmation_fingerprint from public.my_stuff_items where id=${q(id)}`)})
 }
 const enqueue=(n,key)=>auth+`select public.enqueue_my_stuff_research_v3(${q(items[n].id)},${q(items[n].fp)},${q(key)})`
 const lease=()=>JSON.parse(sql(`set role service_role;select to_jsonb(private.lease_my_stuff_research_job_v4('correction-offline',300))`))
 const adopt=j=>JSON.parse(sql(`set role service_role;select public.prepare_document_job_v1(${q(j.id)},${q(j.lease_token)})`))
 const exec=b=>({b,attemptId:sql(`select attempt_id from private.my_stuff_document_executions where job_id=${q(b.jobId)}`)})
 const activeCount=()=>Number(sql(`select count(*) from private.my_stuff_research_jobs where user_id=${q(fresh)} and status in ('queued','running','awaiting_review','approved','document_pending')`))
 const firstId=sql(enqueue(0,'fresh-original'));const firstLease=lease();assert.equal(firstLease.id,firstId)
 const active=exec(adopt(firstLease))
 for(const stage of ['ready','attempted']){
  if(stage==='attempted')assert.equal(JSON.parse(await asyncSql(claimSql(active))).claimed,true)
  assert.equal(sql(enqueue(0,'fresh-original')),firstId)
  for(const n of [0,1])assert.match(await denied(enqueue(n,'blocked-'+stage+'-'+n)),/RESEARCH_ALREADY_ACTIVE/)
  assert.equal(activeCount(),1)
 }
 note('FIXED authenticated enqueue preserves active owner and exact replay while ready and attempted',{jobId:firstId,active:activeCount()})
 await asyncSql(failSql(active,150000001));assert.equal(activeCount(),0)
 const afterFailure=sql(enqueue(1,'after-failure'));assert.notEqual(afterFailure,firstId)
 const secondLease=lease();assert.equal(secondLease.id,afterFailure);const second=exec(adopt(secondLease))
 await asyncSql(claimSql(second));const secondRecord=await recordFor(second.b)
 // recordFor's base owner is not serialized as authority; SQL store uses binding owner.
 await asyncSql(finalize(second.b,second.attemptId,secondRecord));assert.equal(activeCount(),0)
 const ageTerminalFixtures=()=>sql(`update private.my_stuff_research_jobs set created_at=now()-interval '2 days' where user_id=${q(fresh)} and status in ('document_complete','document_failed')`)
 ageTerminalFixtures()
 const afterComplete=sql(enqueue(0,'after-complete'));assert.notEqual(afterComplete,afterFailure)
 assert.equal(sql(enqueue(0,'fresh-original')),firstId)
 pass('fresh actual enqueue lease adopt; both terminal states restore slot; original replay stays same',{firstId,afterFailure,afterComplete})
 // Adoption holds config FOR SHARE; enqueue holds config FOR UPDATE. Test both
 // orderings and observe lock wait rather than relying on scheduling luck.
 const raceLease=lease();assert.equal(raceLease.id,afterComplete)
 const adoptStatement=`set role service_role;select public.prepare_document_job_v1(${q(raceLease.id)},${q(raceLease.lease_token)})`
 const race=await ordered(adoptStatement,enqueue(1,'adopt-race-new'))
 assert.ok(!race.first.error);assert.match(race.second.error,/RESEARCH_ALREADY_ACTIVE/);assert.equal(activeCount(),1)
 const raceExec=exec(JSON.parse(race.first.value));await asyncSql(preSql(raceExec));ageTerminalFixtures()
 const nextId=sql(enqueue(0,'reverse-adopt'));const nextLease=lease();assert.equal(nextLease.id,nextId)
 // Catch the expected legacy-running unique violation, then replay the real
 // original enqueue to retain its config lock while adoption visibly waits.
 const reverseFirst=auth+`do $$begin perform public.enqueue_my_stuff_research_v3(${q(items[1].id)},${q(items[1].fp)},'reverse-race-new');raise exception 'EXPECTED_REJECTION';exception when others then if sqlerrm<>'RESEARCH_ALREADY_ACTIVE' then raise;end if;end$$;select public.enqueue_my_stuff_research_v3(${q(items[0].id)},${q(items[0].fp)},'reverse-adopt')`
 const reverse=await ordered(reverseFirst,`set role service_role;select public.prepare_document_job_v1(${q(nextLease.id)},${q(nextLease.lease_token)})`)
 assert.ok(!reverse.first.error&&!reverse.second.error,JSON.stringify(reverse));assert.equal(activeCount(),1)
 pass('adoption versus actual authenticated enqueue both observed lock orders',{race,reverse})
 await asyncSql(preSql(exec(JSON.parse(reverse.second.value))))
 // Predicate preserves every historical active state and excludes all terminal
 // states. Probe index behavior in rollback-only local transactions.
 for(const status of ['queued','running','awaiting_review','approved','document_pending','document_complete','document_failed']){
  const statement=`begin;update private.my_stuff_research_jobs set status=${q(status)} where id=${q(nextId)};${enqueue(1,'predicate-'+status)};rollback;`
  if(['document_complete','document_failed'].includes(status))await asyncSql(statement)
  else assert.match(await denied(statement),/RESEARCH_ALREADY_ACTIVE/)
 }
 pass('legacy active predicates preserved; document terminal predicates excluded')
 const metadata=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definer',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'publicExecute',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where grantee=0 and privilege_type='EXECUTE'))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%document%v1' and n.nspname in ('public','private')`))
 assert.equal(metadata.length,19);assert.ok(metadata.every(x=>!x.publicExecute));assert.ok(metadata.every(x=>x.config?.some(y=>y==='search_path=pg_catalog'||y.startsWith('search_path=pg_catalog,'))))
 note('catalog function owner definer searchpath PUBLIC ACL inspected',metadata)
 const acl=JSON.parse(sql(`select jsonb_build_object('anon',has_function_privilege('anon','public.fail_document_preflight_v1(jsonb,uuid)','execute'),'authenticated',has_function_privilege('authenticated','public.fail_document_preflight_v1(jsonb,uuid)','execute'),'service',has_function_privilege('service_role','public.fail_document_preflight_v1(jsonb,uuid)','execute'),'rls',(select relrowsecurity from pg_class where oid='private.my_stuff_document_executions'::regclass),'predicate',(select pg_get_expr(indpred,indrelid) from pg_index where indexrelid='private.my_stuff_research_one_active_user_uq'::regclass))`))
 assert.equal(acl.anon,false);assert.equal(acl.authenticated,false);assert.equal(acl.service,true);assert.equal(acl.rls,true);assert.match(acl.predicate,/document_pending/)
 pass('new RPC grants fixed search path execution RLS and active constraint verified',acl)
 assert.equal(probes.length,8)
 writeFileSync(out+'/adversarial-probes.json',JSON.stringify({database:db,probes,probeGroups:probes.length,providerRequests:0},null,2))
 writeFileSync(out+'/review-correction-regressions.json',JSON.stringify({result:'PASS',database:db,regressions,regressionGroups:regressions.length,providerRequests:0},null,2))
}
