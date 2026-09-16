\set ON_ERROR_STOP on

-- Newer grace evidence must win regardless of whether it shortens or lengthens
-- the prior grace deadline; older renewal evidence remains ledger-only.
do $$
declare applied boolean; current_expiry timestamptz;
begin
  select apply_apple_entitlement_event(
    '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',null,
    '2026-09-16T10:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-20T00:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'initial grace state was not applied'; end if;

  select apply_apple_entitlement_event(
    '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',null,
    '2026-09-16T09:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-30T00:00:00Z'
  ) into applied;
  if applied is not false then raise exception 'older renewal state unexpectedly won'; end if;

  select apply_apple_entitlement_event(
    '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',null,
    '2026-09-16T11:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-18T00:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'newer shorter grace state did not win'; end if;

  select apply_apple_entitlement_event(
    '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',null,
    '2026-09-16T12:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-25T00:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'newer longer grace state did not win'; end if;

  select expires_at into current_expiry from public.user_entitlements
  where original_transaction_id='orig-ordering';
  if current_expiry <> '2026-09-25T00:00:00Z' then raise exception 'wrong ordered grace expiry: %', current_expiry; end if;
end $$;

-- Duplicate repair versions both extension and contraction and is replay-safe.
do $$
declare applied boolean; current_expiry timestamptz; version_count integer;
begin
  select apply_apple_entitlement_event(
    '22222222-2222-4222-8222-222222222222','orig-repair','tx-repair',null,
    '2026-09-16T10:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-20T00:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'repair fixture was not applied'; end if;

  select reconcile_verified_apple_entitlement(
    '22222222-2222-4222-8222-222222222222','orig-repair','tx-repair',
    '2026-09-16T10:00:00Z','grace_period','2026-09-24T00:00:00Z','2026-09-16T13:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'longer duplicate repair failed'; end if;

  select reconcile_verified_apple_entitlement(
    '22222222-2222-4222-8222-222222222222','orig-repair','tx-repair',
    '2026-09-16T10:00:00Z','grace_period','2026-09-24T00:00:00Z','2026-09-16T13:01:00Z'
  ) into applied;
  if applied is not false then raise exception 'duplicate repair replay was not ignored'; end if;

  select reconcile_verified_apple_entitlement(
    '22222222-2222-4222-8222-222222222222','orig-repair','tx-repair',
    '2026-09-16T10:00:00Z','grace_period','2026-09-22T00:00:00Z','2026-09-16T13:02:00Z'
  ) into applied;
  if applied is not true then raise exception 'shorter duplicate repair failed'; end if;

  select expires_at into current_expiry from public.user_entitlements where original_transaction_id='orig-repair';
  if current_expiry <> '2026-09-22T00:00:00Z' then raise exception 'entitlement repair mismatch: %', current_expiry; end if;
  select expires_at into current_expiry from public.apple_entitlement_events
  where original_transaction_id='orig-repair' and provider_signed_at='2026-09-16T10:00:00Z';
  if current_expiry <> '2026-09-22T00:00:00Z' then raise exception 'event ledger repair mismatch: %', current_expiry; end if;
  select count(*) into version_count from public.apple_entitlement_reconciliation_versions
  where original_transaction_id='orig-repair';
  if version_count <> 2 then raise exception 'expected two repair versions, got %', version_count; end if;
end $$;

-- At equal provider time terminal precedence cannot be undone by repair or an
-- access event. Ownership, tombstones, missing rows, and invalid input fail closed.
do $$
declare applied boolean; current_status text;
begin
  select apply_apple_entitlement_event(
    '33333333-3333-4333-8333-333333333333','orig-terminal','tx-terminal',null,
    '2026-09-16T14:00:00Z','grace_period','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-25T00:00:00Z'
  ) into applied;
  select apply_apple_entitlement_event(
    '33333333-3333-4333-8333-333333333333','orig-terminal','tx-terminal',null,
    '2026-09-16T14:00:00Z','expired','com.sideflip.app.pro.monthly',
    '2026-08-01T00:00:00Z','2026-09-16T14:00:00Z'
  ) into applied;
  if applied is not true then raise exception 'equal-time terminal event did not win'; end if;

  select reconcile_verified_apple_entitlement(
    '33333333-3333-4333-8333-333333333333','orig-terminal','tx-terminal',
    '2026-09-16T14:00:00Z','grace_period','2026-09-30T00:00:00Z','2026-09-16T15:00:00Z'
  ) into applied;
  if applied is not false then raise exception 'repair overwrote equal-time terminal state'; end if;
  select status into current_status from public.user_entitlements where original_transaction_id='orig-terminal';
  if current_status <> 'expired' then raise exception 'terminal state was lost'; end if;

  select reconcile_verified_apple_entitlement(
    '11111111-1111-4111-8111-111111111111','missing','missing',
    '2026-09-16T14:00:00Z','active','2026-09-30T00:00:00Z','2026-09-16T15:00:00Z'
  ) into applied;
  if applied is not false then raise exception 'missing row did not return false'; end if;

  begin
    perform reconcile_verified_apple_entitlement(
      '33333333-3333-4333-8333-333333333333','orig-repair','tx-repair',
      '2026-09-16T10:00:00Z','grace_period','2026-09-30T00:00:00Z','2026-09-16T15:00:00Z');
    raise exception 'ownership conflict did not error';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'APPLE_TRANSACTION_ALREADY_BOUND' then raise; end if;
  end;

  begin
    perform reconcile_verified_apple_entitlement(
      '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',
      '2026-09-16T12:00:00Z','refunded','2026-09-30T00:00:00Z','2026-09-16T15:00:00Z');
    raise exception 'invalid status did not error';
  exception when invalid_parameter_value then null;
  end;

  insert into public.account_deletion_tombstones(user_id,apple_original_transaction_ids)
  values('11111111-1111-4111-8111-111111111111',array['orig-ordering']);
  begin
    perform reconcile_verified_apple_entitlement(
      '11111111-1111-4111-8111-111111111111','orig-ordering','tx-ordering',
      '2026-09-16T12:00:00Z','grace_period','2026-10-01T00:00:00Z','2026-09-16T15:00:00Z');
    raise exception 'tombstone fence did not error';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'APPLE_EVENT_FOR_DELETED_ACCOUNT' then raise; end if;
  end;
end $$;

-- RPC/table privileges are service-only.
do $$
begin
  if has_function_privilege('anon', 'public.reconcile_verified_apple_entitlement(uuid,text,text,timestamptz,text,timestamptz,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reconcile_verified_apple_entitlement(uuid,text,text,timestamptz,text,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'client role can execute Apple reconciliation';
  end if;
  if not has_function_privilege('service_role', 'public.reconcile_verified_apple_entitlement(uuid,text,text,timestamptz,text,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'service role cannot execute Apple reconciliation';
  end if;
end $$;
