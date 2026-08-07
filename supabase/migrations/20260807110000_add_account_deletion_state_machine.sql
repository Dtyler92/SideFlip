-- Account-deletion state machine. REVIEW ONLY; requires explicit production approval.
begin;

alter table public.account_deletion_tombstones
  add column deletion_lease_id uuid,
  add column deletion_lease_expires_at timestamptz;
alter table public.account_deletion_tombstones drop constraint account_deletion_tombstones_status_check;
alter table public.account_deletion_tombstones add constraint account_deletion_tombstones_status_check check (status in ('requested','processing','auth_deleting','completed','failed'));

create or replace function public.begin_account_deletion(
  p_user_id uuid, p_lease_id uuid,
  p_apple_original_transaction_ids text[], p_stripe_subscription_ids text[], p_stripe_customer_ids text[]
)
returns public.account_deletion_tombstones
language plpgsql security definer set search_path = public
as $$
declare v_row public.account_deletion_tombstones;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_row from public.account_deletion_tombstones where user_id = p_user_id for update;
  if found and v_row.status in ('completed','auth_deleting') then return v_row; end if;
  if found and v_row.status = 'processing' and v_row.deletion_lease_expires_at > now() then return v_row; end if;
  insert into public.account_deletion_tombstones as t (user_id,source,status,apple_original_transaction_ids,stripe_subscription_ids,stripe_customer_ids,provider_cleanup_status,last_error_code,deletion_lease_id,deletion_lease_expires_at)
  values (p_user_id,'in_app','processing',coalesce(p_apple_original_transaction_ids,'{}'::text[]),coalesce(p_stripe_subscription_ids,'{}'::text[]),coalesce(p_stripe_customer_ids,'{}'::text[]),jsonb_build_object('storage','pending','auth','pending'),null,p_lease_id,now()+interval '10 minutes')
  on conflict (user_id) do update set
    status='processing', apple_original_transaction_ids=coalesce((select array_agg(distinct x) from unnest(t.apple_original_transaction_ids || excluded.apple_original_transaction_ids) x),'{}'::text[]),
    stripe_subscription_ids=coalesce((select array_agg(distinct x) from unnest(t.stripe_subscription_ids || excluded.stripe_subscription_ids) x),'{}'::text[]),
    stripe_customer_ids=coalesce((select array_agg(distinct x) from unnest(t.stripe_customer_ids || excluded.stripe_customer_ids) x),'{}'::text[]),
    provider_cleanup_status=jsonb_build_object('storage','pending','auth','pending'),last_error_code=null,deletion_lease_id=p_lease_id,deletion_lease_expires_at=now()+interval '10 minutes'
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.begin_account_deletion(uuid,uuid,text[],text[],text[]) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid,uuid,text[],text[],text[]) to service_role;
commit;
