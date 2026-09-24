\set ON_ERROR_STOP on
-- The blocked cutover template made no changes. No activation or retirement RPC
-- exists, service_role cannot attest readiness, and every legacy path remains.
select public._v4_assert(to_regprocedure('private.activate_my_stuff_integrity_v4(text,text,text,boolean,boolean,boolean)') is null,'no activation RPC installed');
select public._v4_assert(to_regprocedure('private.retire_legacy_my_stuff_integrity_v4()') is null,'no retirement RPC installed');
select public._v4_assert((select not legacy_retired from private.my_stuff_integrity_rollout_v4 where singleton),'legacy retirement remains false');
select public._v4_assert(has_function_privilege('authenticated','public.record_my_stuff_service_with_expense_v3(uuid,uuid,uuid,jsonb,jsonb,text)','execute'),'legacy completion remains callable');
select public._v4_assert(has_function_privilege('authenticated','public.set_my_stuff_item_archived_v2(uuid,boolean,text,text)','execute'),'legacy archive remains callable');
select public._v4_assert(has_table_privilege('authenticated','public.my_stuff_items','delete'),'legacy direct item deletion remains available in Phase 1');
