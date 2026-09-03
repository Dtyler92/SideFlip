-- Durable, cross-instance rate and concurrency control for paid AI generation.
-- Apply before deploying the listing-description endpoint that calls these RPCs.

create table if not exists public.ai_generation_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  in_flight_until timestamptz,
  claim_token uuid,
  updated_at timestamptz not null default now()
);

alter table public.ai_generation_rate_limits enable row level security;
revoke all on table public.ai_generation_rate_limits from public, anon, authenticated;

create or replace function public.claim_ai_generation_request(
  p_user_id uuid,
  p_limit integer,
  p_window_seconds integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.ai_generation_rate_limits%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_user_id is null
    or p_limit < 1 or p_limit > 100
    or p_window_seconds < 1 or p_window_seconds > 3600
    or p_lease_seconds < 1 or p_lease_seconds > 120 then
    raise exception 'invalid generation rate-limit parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 94117));

  select * into v_row
  from public.ai_generation_rate_limits
  where user_id = p_user_id;

  if not found then
    insert into public.ai_generation_rate_limits (
      user_id, window_started_at, request_count, in_flight_until, claim_token, updated_at
    ) values (
      p_user_id, v_now, 1, v_now + (p_lease_seconds * interval '1 second'), v_token, v_now
    );
    return jsonb_build_object('decision', 'allowed', 'claim_token', v_token);
  end if;

  if v_row.in_flight_until is not null and v_row.in_flight_until > v_now then
    return jsonb_build_object('decision', 'in_flight');
  end if;

  if v_row.window_started_at + (p_window_seconds * interval '1 second') <= v_now then
    update public.ai_generation_rate_limits
    set window_started_at = v_now,
        request_count = 1,
        in_flight_until = v_now + (p_lease_seconds * interval '1 second'),
        claim_token = v_token,
        updated_at = v_now
    where user_id = p_user_id;
    return jsonb_build_object('decision', 'allowed', 'claim_token', v_token);
  end if;

  if v_row.request_count >= p_limit then
    return jsonb_build_object('decision', 'rate_limited');
  end if;

  update public.ai_generation_rate_limits
  set request_count = request_count + 1,
      in_flight_until = v_now + (p_lease_seconds * interval '1 second'),
      claim_token = v_token,
      updated_at = v_now
  where user_id = p_user_id;

  return jsonb_build_object('decision', 'allowed', 'claim_token', v_token);
end;
$$;

create or replace function public.renew_ai_generation_request(
  p_user_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_claim_token is null
    or p_lease_seconds < 1 or p_lease_seconds > 120 then
    raise exception 'invalid generation lease parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 94117));
  update public.ai_generation_rate_limits
  set in_flight_until = clock_timestamp() + (p_lease_seconds * interval '1 second'),
      updated_at = clock_timestamp()
  where user_id = p_user_id
    and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_ai_generation_request(
  p_user_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_generation_rate_limits
  set in_flight_until = null,
      claim_token = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id
    and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.claim_ai_generation_request(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.renew_ai_generation_request(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_ai_generation_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_generation_request(uuid, integer, integer, integer) to service_role;
grant execute on function public.renew_ai_generation_request(uuid, uuid, integer) to service_role;
grant execute on function public.release_ai_generation_request(uuid, uuid) to service_role;
