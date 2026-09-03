\set ON_ERROR_STOP on

-- Privileges: only service_role can execute the RPCs or read cache state.
do $$
begin
  if not has_function_privilege('service_role', 'public.claim_vin_decode_request(uuid,integer,integer)', 'EXECUTE') then raise exception 'service claim grant missing'; end if;
  if not has_function_privilege('service_role', 'public.store_vin_decode_cache(integer,text,jsonb,text[],timestamptz)', 'EXECUTE') then raise exception 'service store grant missing'; end if;
  if not has_function_privilege('service_role', 'public.cleanup_vin_decode_state(integer,integer,text)', 'EXECUTE') then raise exception 'service cleanup grant missing'; end if;
  if has_function_privilege('anon', 'public.cleanup_vin_decode_state(integer,integer,text)', 'EXECUTE') then raise exception 'anon can clean VIN state'; end if;
  if has_function_privilege('authenticated', 'public.cleanup_vin_decode_state(integer,integer,text)', 'EXECUTE') then raise exception 'authenticated can clean VIN state'; end if;
  if has_function_privilege('anon', 'public.is_valid_vin_decoded_fields(jsonb)', 'EXECUTE') then raise exception 'anon can call VIN cache validator'; end if;
  if has_function_privilege('authenticated', 'public.is_valid_vin_decoded_fields(jsonb)', 'EXECUTE') then raise exception 'authenticated can call VIN cache validator'; end if;
  if has_table_privilege('anon', 'public.vin_decode_cache', 'SELECT') then raise exception 'anon can read VIN cache'; end if;
  if has_table_privilege('authenticated', 'public.vin_decode_cache', 'SELECT') then raise exception 'authenticated can read VIN cache'; end if;
end $$;

-- Cleanup ordering is backed by a matching btree index, so bounded batches do
-- not require an unbounded scan as the limiter table grows.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class table_class
    join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_catalog.pg_index index_meta on index_meta.indrelid = table_class.oid
    join pg_catalog.pg_class index_class on index_class.oid = index_meta.indexrelid
    where namespace.nspname = 'public'
      and table_class.relname = 'vin_decode_rate_limits'
      and index_class.relname = 'vin_decode_rate_limits_updated_at_user_id_idx'
      and pg_catalog.pg_get_indexdef(index_class.oid) like '%USING btree (updated_at, user_id)%'
  ) then raise exception 'rate-limit cleanup index missing or has wrong column order'; end if;
end $$;

-- Null and range checks must fail explicitly instead of SQL three-valued fallthrough.
do $$
begin
  begin perform public.claim_vin_decode_request('11111111-1111-4111-8111-111111111111', null, 60); raise exception 'null limit accepted'; exception when others then if sqlerrm = 'null limit accepted' then raise; end if; end;
  begin perform public.claim_vin_decode_request('11111111-1111-4111-8111-111111111111', 2, null); raise exception 'null window accepted'; exception when others then if sqlerrm = 'null window accepted' then raise; end if; end;
end $$;

set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_vin_decode_request('11111111-1111-4111-8111-111111111111', 2, 3600);
  if result->>'decision' <> 'allowed' then raise exception 'first claim denied'; end if;
  result := public.claim_vin_decode_request('11111111-1111-4111-8111-111111111111', 2, 3600);
  if result->>'decision' <> 'allowed' then raise exception 'second claim denied'; end if;
  result := public.claim_vin_decode_request('11111111-1111-4111-8111-111111111111', 2, 3600);
  if result->>'decision' <> 'rate_limited' or (result->>'retry_after_seconds')::integer not between 1 and 3600 then raise exception 'rate limit result invalid: %', result; end if;
end $$;
reset role;

-- The same HMAC under two key versions is distinct, and warning-bearing useful
-- decodes are cacheable. Fatal code 400 remains rejected.
do $$
declare hash text := repeat('a', 64);
begin
  if not public.store_vin_decode_cache(1, hash, '{"make":"VOLKSWAGEN","model":"Golf"}', array['1','14'], clock_timestamp() + interval '30 days') then raise exception 'v1 cache write failed'; end if;
  if not public.store_vin_decode_cache(2, hash, '{"make":"VOLKSWAGEN","model":"Golf"}', array['14'], clock_timestamp() + interval '30 days') then raise exception 'v2 cache write failed'; end if;
  if (select count(*) from public.vin_decode_cache where vin_hmac = hash) <> 2 then raise exception 'key versions collided'; end if;
  begin
    perform public.store_vin_decode_cache(2, repeat('b',64), '{"make":"bad"}', array['400'], clock_timestamp() + interval '1 day');
    raise exception 'fatal code cached';
  exception when others then
    if sqlerrm = 'fatal code cached' then raise; end if;
  end;
end $$;

-- The database accepts only the service cache schema, even if a future caller
-- bypasses or regresses route-level validation.
do $$
declare
  field_name text;
  hash_counter integer := 10;
begin
  begin
    perform public.store_vin_decode_cache(2, repeat('5',64), '{"make":"HONDA","privateNote":"hostile"}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'unknown cache field accepted';
  exception when others then if sqlerrm = 'unknown cache field accepted' then raise; end if; end;
  begin
    perform public.store_vin_decode_cache(2, repeat('6',64), '{"make":42}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'wrong cache text type accepted';
  exception when others then if sqlerrm = 'wrong cache text type accepted' then raise; end if; end;
  begin
    perform public.store_vin_decode_cache(2, repeat('7',64), '{"make":"HONDA","modelYear":-1}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'out-of-range model year accepted';
  exception when others then if sqlerrm = 'out-of-range model year accepted' then raise; end if; end;
  begin
    perform public.store_vin_decode_cache(2, repeat('8',64), '{"make":"HONDA","engineCylinders":999}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'out-of-range cylinders accepted';
  exception when others then if sqlerrm = 'out-of-range cylinders accepted' then raise; end if; end;
  begin
    perform public.store_vin_decode_cache(2, repeat('9',64), '{"make":"HONDA","displacementLiters":999}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'out-of-range displacement accepted';
  exception when others then if sqlerrm = 'out-of-range displacement accepted' then raise; end if; end;
  foreach field_name in array array['make','model','trim','bodyClass','vehicleType','manufacturer','plantCountry','fuelTypePrimary','driveType','transmissionStyle'] loop
    begin
      perform public.store_vin_decode_cache(
        2,
        lpad(hash_counter::text, 64, '0'),
        jsonb_build_object('make', 'HONDA') || jsonb_build_object(field_name, 42),
        '{}',
        clock_timestamp() + interval '1 day'
      );
      raise exception 'wrong cache text type accepted for %', field_name;
    exception when others then
      if sqlerrm = format('wrong cache text type accepted for %s', field_name) then raise; end if;
    end;
    hash_counter := hash_counter + 1;
  end loop;
  begin
    insert into public.vin_decode_cache(hmac_key_version, vin_hmac, decoded_fields, nhtsa_error_codes, expires_at)
    values (2, repeat('4',64), '{"make":"HONDA","privateNote":"hostile direct write"}', '{}', clock_timestamp() + interval '1 day');
    raise exception 'direct invalid cache write accepted';
  exception when others then if sqlerrm = 'direct invalid cache write accepted' then raise; end if; end;
end $$;

-- Seed more stale rows than one cleanup batch to prove bounded retention.
insert into public.vin_decode_cache(hmac_key_version, vin_hmac, decoded_fields, nhtsa_error_codes, expires_at)
values
  (2, repeat('c',64), '{"make":"A"}', '{}', clock_timestamp() - interval '3 hours'),
  (2, repeat('d',64), '{"make":"B"}', '{}', clock_timestamp() - interval '2 hours'),
  (2, repeat('e',64), '{"make":"C"}', '{}', clock_timestamp() - interval '1 hour');
insert into public.vin_decode_rate_limits(user_id, window_started_at, request_count, updated_at)
values
  ('22222222-2222-4222-8222-222222222222', clock_timestamp() - interval '9 days', 1, clock_timestamp() - interval '9 days'),
  ('33333333-3333-4333-8333-333333333333', clock_timestamp() - interval '8 days', 1, clock_timestamp() - interval '8 days'),
  ('44444444-4444-4444-8444-444444444444', clock_timestamp() - interval '7 days 1 hour', 1, clock_timestamp() - interval '7 days 1 hour');

do $$
declare result jsonb;
begin
  result := public.cleanup_vin_decode_state(2, 1, repeat('a',64));
  if result <> '{"invalid_cache_deleted":1,"expired_cache_deleted":2,"stale_rate_limits_deleted":2}'::jsonb then raise exception 'unexpected bounded cleanup: %', result; end if;
  if exists (select 1 from public.vin_decode_cache where hmac_key_version=1 and vin_hmac=repeat('a',64)) then raise exception 'retired v1 cache key not quarantined'; end if;
  if not exists (select 1 from public.vin_decode_cache where hmac_key_version=2 and vin_hmac=repeat('a',64)) then raise exception 'active v2 cache key deleted'; end if;
  if (select count(*) from public.vin_decode_cache where expires_at <= clock_timestamp()) <> 1 then raise exception 'cleanup exceeded or missed bounded cache retention'; end if;
  if (select count(*) from public.vin_decode_rate_limits where updated_at < clock_timestamp() - interval '7 days') <> 1 then raise exception 'cleanup exceeded or missed bounded rate retention'; end if;
end $$;
