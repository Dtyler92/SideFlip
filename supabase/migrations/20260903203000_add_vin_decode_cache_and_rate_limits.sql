-- REVIEW ONLY: additive VIN decode cache and per-user rate limiting.
-- Do not apply until separately reviewed and explicitly approved for Production.
begin;

create function public.is_valid_vin_decoded_fields(decoded_fields jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    jsonb_typeof(decoded_fields) = 'object'
    and decoded_fields - array[
      'modelYear','make','model','trim','bodyClass','vehicleType','manufacturer',
      'plantCountry','fuelTypePrimary','engineCylinders','displacementLiters',
      'driveType','transmissionStyle'
    ]::text[] = '{}'::jsonb
    and decoded_fields ?| array['modelYear','make','model']
    and (
      not decoded_fields ? 'modelYear' or case when jsonb_typeof(decoded_fields->'modelYear') = 'number' then
        (decoded_fields->>'modelYear')::numeric between 1881 and 2200
        and trunc((decoded_fields->>'modelYear')::numeric) = (decoded_fields->>'modelYear')::numeric
      else false end
    )
    and (
      not decoded_fields ? 'engineCylinders' or case when jsonb_typeof(decoded_fields->'engineCylinders') = 'number' then
        (decoded_fields->>'engineCylinders')::numeric between 1 and 32
        and trunc((decoded_fields->>'engineCylinders')::numeric) = (decoded_fields->>'engineCylinders')::numeric
      else false end
    )
    and (
      not decoded_fields ? 'displacementLiters' or case when jsonb_typeof(decoded_fields->'displacementLiters') = 'number' then
        (decoded_fields->>'displacementLiters')::numeric between 0.1 and 30
      else false end
    )
    and (not decoded_fields ? 'make' or (
      jsonb_typeof(decoded_fields->'make') = 'string' and length(decoded_fields->>'make') between 1 and 160
      and decoded_fields->>'make' = btrim(decoded_fields->>'make') and decoded_fields->>'make' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'model' or (
      jsonb_typeof(decoded_fields->'model') = 'string' and length(decoded_fields->>'model') between 1 and 160
      and decoded_fields->>'model' = btrim(decoded_fields->>'model') and decoded_fields->>'model' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'trim' or (
      jsonb_typeof(decoded_fields->'trim') = 'string' and length(decoded_fields->>'trim') between 1 and 160
      and decoded_fields->>'trim' = btrim(decoded_fields->>'trim') and decoded_fields->>'trim' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'bodyClass' or (
      jsonb_typeof(decoded_fields->'bodyClass') = 'string' and length(decoded_fields->>'bodyClass') between 1 and 160
      and decoded_fields->>'bodyClass' = btrim(decoded_fields->>'bodyClass') and decoded_fields->>'bodyClass' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'vehicleType' or (
      jsonb_typeof(decoded_fields->'vehicleType') = 'string' and length(decoded_fields->>'vehicleType') between 1 and 160
      and decoded_fields->>'vehicleType' = btrim(decoded_fields->>'vehicleType') and decoded_fields->>'vehicleType' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'manufacturer' or (
      jsonb_typeof(decoded_fields->'manufacturer') = 'string' and length(decoded_fields->>'manufacturer') between 1 and 160
      and decoded_fields->>'manufacturer' = btrim(decoded_fields->>'manufacturer') and decoded_fields->>'manufacturer' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'plantCountry' or (
      jsonb_typeof(decoded_fields->'plantCountry') = 'string' and length(decoded_fields->>'plantCountry') between 1 and 160
      and decoded_fields->>'plantCountry' = btrim(decoded_fields->>'plantCountry') and decoded_fields->>'plantCountry' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'fuelTypePrimary' or (
      jsonb_typeof(decoded_fields->'fuelTypePrimary') = 'string' and length(decoded_fields->>'fuelTypePrimary') between 1 and 160
      and decoded_fields->>'fuelTypePrimary' = btrim(decoded_fields->>'fuelTypePrimary') and decoded_fields->>'fuelTypePrimary' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'driveType' or (
      jsonb_typeof(decoded_fields->'driveType') = 'string' and length(decoded_fields->>'driveType') between 1 and 160
      and decoded_fields->>'driveType' = btrim(decoded_fields->>'driveType') and decoded_fields->>'driveType' !~ '[[:cntrl:]]'
    ))
    and (not decoded_fields ? 'transmissionStyle' or (
      jsonb_typeof(decoded_fields->'transmissionStyle') = 'string' and length(decoded_fields->>'transmissionStyle') between 1 and 160
      and decoded_fields->>'transmissionStyle' = btrim(decoded_fields->>'transmissionStyle') and decoded_fields->>'transmissionStyle' !~ '[[:cntrl:]]'
    ));
$$;

create table public.vin_decode_cache (
  hmac_key_version integer not null check (hmac_key_version > 0),
  vin_hmac text not null,
  decoded_fields jsonb not null,
  nhtsa_error_codes text[] not null default '{}'::text[],
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (hmac_key_version, vin_hmac),
  constraint vin_decode_cache_hmac_format check (vin_hmac ~ '^[0-9a-f]{64}$'),
  constraint vin_decode_cache_fields_contract check (public.is_valid_vin_decoded_fields(decoded_fields)),
  constraint vin_decode_cache_warning_codes check (
    nhtsa_error_codes <@ array['1','2','3','4','7','8','9','10','11','12','14']::text[]
  ),
  constraint vin_decode_cache_no_vin_field check (not (decoded_fields ?| array['vin','rawVin','normalizedVin'])),
  constraint vin_decode_cache_expiry_finite check (isfinite(expires_at))
);

create index vin_decode_cache_expiry_idx on public.vin_decode_cache(expires_at);
alter table public.vin_decode_cache enable row level security;
revoke all on table public.vin_decode_cache from public, anon, authenticated;
grant select on table public.vin_decode_cache to service_role;

create table public.vin_decode_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now()
);

create index vin_decode_rate_limits_updated_at_user_id_idx on public.vin_decode_rate_limits(updated_at, user_id);
alter table public.vin_decode_rate_limits enable row level security;
revoke all on table public.vin_decode_rate_limits from public, anon, authenticated;

create function public.claim_vin_decode_request(
  p_user_id uuid,
  p_limit integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.vin_decode_rate_limits%rowtype;
  v_retry_after integer;
begin
  if p_user_id is null
     or p_limit is null or p_limit < 1 or p_limit > 100
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid VIN decode rate-limit parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 86431));

  select * into v_row
  from public.vin_decode_rate_limits
  where user_id = p_user_id;

  if not found then
    insert into public.vin_decode_rate_limits(user_id, window_started_at, request_count, updated_at)
    values (p_user_id, v_now, 1, v_now);
    return jsonb_build_object('decision', 'allowed', 'retry_after_seconds', 0);
  end if;

  if v_row.window_started_at + (p_window_seconds * interval '1 second') <= v_now then
    update public.vin_decode_rate_limits
    set window_started_at = v_now, request_count = 1, updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('decision', 'allowed', 'retry_after_seconds', 0);
  end if;

  if v_row.request_count >= p_limit then
    v_retry_after := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + (p_window_seconds * interval '1 second') - v_now
    )))::integer);
    return jsonb_build_object('decision', 'rate_limited', 'retry_after_seconds', v_retry_after);
  end if;

  update public.vin_decode_rate_limits
  set request_count = request_count + 1, updated_at = v_now
  where user_id = p_user_id;
  return jsonb_build_object('decision', 'allowed', 'retry_after_seconds', 0);
end;
$$;

create function public.store_vin_decode_cache(
  p_hmac_key_version integer,
  p_vin_hmac text,
  p_decoded_fields jsonb,
  p_nhtsa_error_codes text[],
  p_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_hmac_key_version is null or p_hmac_key_version < 1
     or p_vin_hmac is null or p_vin_hmac !~ '^[0-9a-f]{64}$'
     or p_decoded_fields is null or not public.is_valid_vin_decoded_fields(p_decoded_fields)
     or p_nhtsa_error_codes is null
     or not (p_nhtsa_error_codes <@ array['1','2','3','4','7','8','9','10','11','12','14']::text[])
     or p_expires_at is null or not isfinite(p_expires_at)
     or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '90 days' then
    raise exception 'invalid VIN cache parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_hmac_key_version::text || ':' || p_vin_hmac, 86432));
  delete from public.vin_decode_cache
  where hmac_key_version = p_hmac_key_version
    and vin_hmac = p_vin_hmac
    and expires_at <= clock_timestamp();

  insert into public.vin_decode_cache(hmac_key_version, vin_hmac, decoded_fields, nhtsa_error_codes, expires_at)
  values (p_hmac_key_version, p_vin_hmac, p_decoded_fields, p_nhtsa_error_codes, p_expires_at)
  on conflict (hmac_key_version, vin_hmac) do nothing;
  return found;
end;
$$;

-- Run this service-only RPC on an hourly operational schedule. Each invocation
-- removes at most p_batch_limit expired cache rows and p_batch_limit limiter
-- rows older than seven days; an exact invalid cache key may also be quarantined.
create function public.cleanup_vin_decode_state(
  p_batch_limit integer default 500,
  p_invalid_hmac_key_version integer default null,
  p_invalid_vin_hmac text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invalid_deleted integer := 0;
  v_cache_deleted integer := 0;
  v_rate_deleted integer := 0;
begin
  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 1000
     or ((p_invalid_hmac_key_version is null) <> (p_invalid_vin_hmac is null))
     or (p_invalid_hmac_key_version is not null and p_invalid_hmac_key_version < 1)
     or (p_invalid_vin_hmac is not null and p_invalid_vin_hmac !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid VIN cleanup parameters';
  end if;

  if p_invalid_hmac_key_version is not null then
    delete from public.vin_decode_cache
    where hmac_key_version = p_invalid_hmac_key_version
      and vin_hmac = p_invalid_vin_hmac;
    get diagnostics v_invalid_deleted = row_count;
  end if;

  with expired as (
    select hmac_key_version, vin_hmac
    from public.vin_decode_cache
    where expires_at <= clock_timestamp()
    order by expires_at, hmac_key_version, vin_hmac
    limit p_batch_limit
    for update skip locked
  )
  delete from public.vin_decode_cache cache
  using expired
  where cache.hmac_key_version = expired.hmac_key_version
    and cache.vin_hmac = expired.vin_hmac;
  get diagnostics v_cache_deleted = row_count;

  with stale as (
    select user_id
    from public.vin_decode_rate_limits
    where updated_at < clock_timestamp() - interval '7 days'
    order by updated_at, user_id
    limit p_batch_limit
    for update skip locked
  )
  delete from public.vin_decode_rate_limits limiter
  using stale
  where limiter.user_id = stale.user_id;
  get diagnostics v_rate_deleted = row_count;

  return jsonb_build_object(
    'invalid_cache_deleted', v_invalid_deleted,
    'expired_cache_deleted', v_cache_deleted,
    'stale_rate_limits_deleted', v_rate_deleted
  );
end;
$$;

revoke all on function public.claim_vin_decode_request(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.store_vin_decode_cache(integer, text, jsonb, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.cleanup_vin_decode_state(integer, integer, text) from public, anon, authenticated;
revoke all on function public.is_valid_vin_decoded_fields(jsonb) from public, anon, authenticated;
grant execute on function public.claim_vin_decode_request(uuid, integer, integer) to service_role;
grant execute on function public.store_vin_decode_cache(integer, text, jsonb, text[], timestamptz) to service_role;
grant execute on function public.cleanup_vin_decode_state(integer, integer, text) to service_role;

commit;
