"""Run real settlement and first approval/apply races on the disposable fixture DB only."""
import json
import os
import concurrent.futures
import re
import subprocess
import sys
import time
from pathlib import Path

DB = sys.argv[1]
if not re.fullmatch(r"sideflip_maintenance_research_test_[0-9]+", DB):
    raise SystemExit("Disposable local database name required")
CMD = ["sudo", "-u", "postgres", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", DB]

def sql(text):
    result = subprocess.run(CMD, input=text, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout[-2500:])
    return result.stdout.strip()

fixture = Path(__file__).with_name("manufacturer-finite-assertions.sql").read_text()
approve = "select public.approve_my_stuff_research_v3(:'job',:'reviews','scion-approve') as approval \\gset"
apply = "select public.apply_my_stuff_research_v2(:'approval','scion-apply')::text as ids \\gset"
first, rest = fixture.split(approve, 1)
middle, last = rest.split(apply, 1)
# The actual fixture creates the item/job, leases, settles and reads proposals. No synthetic approvals.
print(sql(first))
setup = """
select id as item,vin_confirmation_fingerprint as fp from public.my_stuff_items where name='Uploaded Scion local test' \\gset
select id as job from private.my_stuff_research_jobs where item_id=:'item' \\gset
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select jsonb_agg(jsonb_build_object('proposal_id',x->>'id','content_hash',x->>'content_hash','acknowledgements','{"sourceApplicability":true,"taskAction":true,"headingSchedule":true,"notesConditions":true,"finiteHorizon":true}'::jsonb))::text as reviews from jsonb_array_elements(public.get_my_stuff_research_review_v2(:'job')->'proposals') x \\gset
"""
approval_setup = "select public.get_my_stuff_research_review_v2(:'job')->'approval'->>'id' as approval \\gset\n"

def race(label, prelude, operation):
    # Hold the first successful mutation uncommitted; prove second connection waits on its lock.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(sql, prelude + "begin; set application_name='finite-race-holder';\n" + operation + "; select pg_sleep(1.5); commit;")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if sql("select count(*) from pg_stat_activity where datname=current_database() and application_name='finite-race-holder' and wait_event='PgSleep';") == '1':
                break
            time.sleep(0.02)
        else:
            raise AssertionError(label + ': holder did not reach transaction barrier')
        two = pool.submit(sql, prelude + "set application_name='finite-race-waiter';\n" + operation + ";")
        blocked = False
        while time.monotonic() < deadline and not one.done():
            if sql("select count(*) from pg_stat_activity where datname=current_database() and application_name='finite-race-waiter' and wait_event_type='Lock';") == '1':
                blocked = True
                break
            time.sleep(0.02)
        a, b = one.result(), two.result()
        assert blocked, label + ': no observed concurrent lock wait'
        assert a == b, (label, a, b)
        print(label + ': separate connections, observed lock wait, identical result')

def persisted_readback(stage):
    raw = sql(setup + "select jsonb_build_object('review',public.get_my_stuff_research_review_v2(:'job'),'status',public.get_my_stuff_research_status_v1(:'item'),'item',(select to_jsonb(i) from public.my_stuff_items i where id=:'item'));")
    payload = json.loads(raw.splitlines()[-1])
    sealed = payload['review']['approval']
    stored = json.loads(sql("select snapshot from private.my_stuff_research_approvals where id='" + sealed['id'] + "';"))
    assert sealed['snapshot'] == stored, 'readback is exact persisted snapshot'
    native = os.environ.get('FINITE_NATIVE_MODEL')
    if native:
        check = """
import {pathToFileURL} from 'node:url';
const {finiteApprovalCanApply}=await import(pathToFileURL(process.argv[1]));
let raw='';for await(const c of process.stdin)raw+=c;
const p=JSON.parse(raw),r=p.review,s=p.status;
if(!finiteApprovalCanApply({...r,jobId:r.job_id,approvalId:r.approval_id},{...s,jobId:s.id,approvalId:s.approval_id},p.item))throw Error('Persisted SQL readback rejected by actual native gate');
console.log('actual native finiteApprovalCanApply accepted persisted SQL envelope');
"""
        result = subprocess.run(['node','--input-type=module','-e',check,native],input=json.dumps(payload),text=True,capture_output=True,timeout=20)
        assert result.returncode == 0, result.stderr
        print(stage + ': ' + result.stdout.strip())
    evidence = os.environ.get('FINITE_EVIDENCE_DIR')
    if evidence:
        Path(evidence).mkdir(parents=True,exist_ok=True)
        Path(evidence, 'persisted-finite-' + stage + '.json').write_text(json.dumps(payload,indent=2)+'\n')
    return sealed

race('first approval', setup, "select public.approve_my_stuff_research_v3(:'job',:'reviews','scion-approve')")
sealed_before = persisted_readback('approved')
print(sql(setup + approval_setup + middle))
race('first apply', setup + approval_setup, "select public.apply_my_stuff_research_v2(:'approval','scion-apply')")
assert persisted_readback('applied') == sealed_before, 'apply/reload retains exact seal'
ids_setup = "select public.apply_my_stuff_research_v2(:'approval','scion-apply')::text as ids \\gset\n"
print(sql(setup + approval_setup + ids_setup + last))
print(sql("select public._research_assert((select count(*)=1 from private.my_stuff_research_approvals where client_mutation_id='scion-approve'),'one raced approval'); select public._research_assert((select count(*)=1 from private.my_stuff_research_apply_records where client_mutation_id='scion-apply'),'one raced apply');"))
print('Finite settlement/review/approval/readback/apply/reload/concurrency lifecycle passed')
