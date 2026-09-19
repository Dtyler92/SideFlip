-- Run against the disposable full legacy migration chain, never a linked database.
create function pg_temp.expect_error(q text, expected text) returns void language plpgsql as $$
begin
  begin execute q;
  exception when others then
    if sqlstate=expected then return; end if;
    raise exception 'Expected %, got %: %',expected,sqlstate,sqlerrm;
  end;
  raise exception 'Expected error %, query succeeded: %',expected,q;
end $$;
-- Earlier legacy behavioral suites may delete these fixture accounts.
insert into auth.users(id) values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222') on conflict do nothing;
create temp table template_input(record jsonb);
insert into template_input values ('{
 "template_key":"scion-xd-2012-wmg", "version":1,
 "source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 "source_document_id":"2012_Scion_xD_WMG.pdf", "source_version":null,"source_url":null,
 "source_authenticity":"user_uploaded_unverified","source_authenticity_evidence":null,
 "schema_version":"test-only-v1","validator_version":null,
 "applicability":{"year":2012,"make":"Scion","model":"xD","engine":null,"transmission":null,"market":"US"},
 "applicability_reviewed":false,"status":"needs_review","validation_report":{"passed":false},
 "payload":{"fixture":true,"rules":[],"unresolved":["SQL contract fixture, not extracted manufacturer data"]}
}');
grant select on template_input to service_role,authenticated,anon;
create temp table saved_ids(id uuid);
grant all on saved_ids to service_role;

-- This snapshot includes the actual legacy maintenance definitions, versions and history.
create temp table maintenance_before(name text primary key, rows jsonb);
do $$ declare r record; v jsonb; begin
 for r in select tablename from pg_tables where schemaname='public' and
   (tablename like 'my_stuff_%' or tablename like 'maintenance_%')
   and tablename<>'manufacturer_template_versions' loop
   execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t',r.tablename) into v;
   insert into maintenance_before values(r.tablename,v);
 end loop;
 assert (select count(*) from maintenance_before)>0,'No maintenance tables in preservation test';
end $$;

set role service_role;
insert into saved_ids select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record) from template_input;
do $$ begin
 assert (select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record) from template_input)=(select id from saved_ids),'Replay changed identity';
end $$;
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',jsonb_set(record,'{payload}','{"changed":true}')) from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',jsonb_set(record,'{source_sha256}','"bad"')) from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',jsonb_set(record,'{version}','3')) from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"version":2,"status":"reviewed"}') from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"version":2,"source_authenticity":"publisher_verified"}') from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"version":2,"source_document_id":"different.pdf"}') from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record #- '{applicability,engine}') from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"current_mileage":12345}') from template_input$q$,'22023');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',jsonb_set(record,'{payload}','{"service_history":[]}')) from template_input$q$,'22023');
select pg_temp.expect_error($q$update public.manufacturer_template_versions set status='reviewed'$q$,'42501');
select pg_temp.expect_error($q$delete from public.manufacturer_template_versions$q$,'42501');
select pg_temp.expect_error($q$insert into public.manufacturer_template_versions select * from public.manufacturer_template_versions$q$,'42501');
select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"version":2,"status":"reviewed","validator_version":"sql-fixture-only","applicability_reviewed":true,"validation_report":{"passed":true,"source_support_checked":true}}') from template_input;
select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111',record||'{"version":3,"status":"extraction_failed","source_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source_version":"new bytes; failed parsing"}') from template_input;
select public.store_manufacturer_template_version('22222222-2222-4222-8222-222222222222',record) from template_input;
reset role;
-- Even the table owner cannot update an immutable version.
select pg_temp.expect_error($q$update public.manufacturer_template_versions set status='reviewed'$q$,'55000');

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
do $$ begin
 assert (select count(*) from public.manufacturer_template_versions)=3,'Owner read missing or cross-owner leak';
 assert (select record#>'{applicability,engine}' from public.manufacturer_template_versions where version=2)='null'::jsonb,'Unknown engine guessed';
 assert (select record->>'source_authenticity' from public.manufacturer_template_versions where version=2)='user_uploaded_unverified','Source authenticity promoted';
 assert (select count(*) from public.find_my_manufacturer_templates('{"year":2012,"make":"Scion","model":"xD","market":"US"}'))=1,'Reviewed exact match missing';
 assert (select count(*) from public.find_my_manufacturer_templates('{"year":2012,"make":"Scion","model":"xD"}'))=0,'Unknown restricted market matched';
 assert (select count(*) from public.find_my_manufacturer_templates('{"year":2013,"make":"Scion","model":"xD","market":"US"}'))=0,'Wrong year matched';
 assert (select count(*) from public.find_my_manufacturer_templates('{"year":2012,"make":"Scion","model":"xD","market":null}'))=0,'Null restricted market matched';
end $$;
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('22222222-2222-4222-8222-222222222222',record) from template_input$q$,'42501');
select pg_temp.expect_error($q$update public.manufacturer_template_versions set owner_id='22222222-2222-4222-8222-222222222222'$q$,'42501');
select pg_temp.expect_error($q$delete from public.manufacturer_template_versions$q$,'42501');
select pg_temp.expect_error($q$insert into public.manufacturer_template_versions select * from public.manufacturer_template_versions$q$,'42501');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
do $$ begin
 assert (select count(*) from public.manufacturer_template_versions)=1,'Cross-user read leaked';
 assert (select count(*) from public.find_my_manufacturer_templates('{"year":2012,"make":"Scion","model":"xD","market":"US"}'))=0,'Cross-user retrieval leaked';
end $$;
select set_config('request.jwt.claim.sub','',false);
do $$ begin assert (select count(*) from public.manufacturer_template_versions)=0,'Missing auth leaked'; end $$;
reset role;
set role anon;
select pg_temp.expect_error($q$select * from public.manufacturer_template_versions$q$,'42501');
select pg_temp.expect_error($q$select * from public.find_my_manufacturer_templates('{}')$q$,'42501');
select pg_temp.expect_error($q$select public.store_manufacturer_template_version('11111111-1111-4111-8111-111111111111','{}')$q$,'42501');
reset role;

do $$ declare r record; v jsonb; begin
 assert (select relrowsecurity from pg_class where oid='public.manufacturer_template_versions'::regclass),'RLS disabled';
 assert not has_function_privilege('authenticated','public.store_manufacturer_template_version(uuid,jsonb)','EXECUTE'),'Browser RPC write enabled';
 assert has_function_privilege('service_role','public.store_manufacturer_template_version(uuid,jsonb)','EXECUTE'),'Backend writer missing';
 assert not has_table_privilege('authenticated','public.manufacturer_template_versions','INSERT,UPDATE,DELETE'),'Browser table mutation enabled';
 for r in select * from maintenance_before loop
   execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t',r.name) into v;
   assert v=r.rows,format('Existing maintenance changed: %s',r.name);
 end loop;
 assert (select count(*) from public.manufacturer_template_versions)=4,'Unexpected version count';
end $$;
-- Auth deletion may cascade private data; immutability must not strand deleted accounts.
insert into auth.users(id) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
select public.store_manufacturer_template_version('dddddddd-dddd-4ddd-8ddd-dddddddddddd',record) from template_input;
delete from auth.users where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
do $$ begin assert not exists(select 1 from public.manufacturer_template_versions where owner_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'Account deletion stranded private templates'; end $$;
\echo 'PASS private template persistence: replay, immutable revisions, owner isolation, ACLs, exact applicability, unknowns, authenticity, failure states, existing maintenance preservation, account deletion'
