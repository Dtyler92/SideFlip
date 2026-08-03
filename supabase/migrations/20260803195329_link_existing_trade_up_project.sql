-- Allow an existing active SideFlip project to be linked to an active Trade-Up Goal.
-- The allocation is tracking-only; SideFlip does not hold or process resale funds.

begin;

create or replace function public.link_trade_up_project(
  p_project_id uuid,
  p_goal_id uuid,
  p_goal_funding numeric,
  p_mutation_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects%rowtype;
  v_goal_status text;
  v_available numeric;
  v_existing_id uuid;
  v_existing_goal_id uuid;
  v_existing_goal_funding numeric;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;

  select id, goal_id, goal_funding_amount into v_existing_id, v_existing_goal_id, v_existing_goal_funding
  from public.projects
  where user_id = v_user_id and trade_up_mutation_id = p_mutation_id;
  if v_existing_id is not null then
    if v_existing_id = p_project_id and v_existing_goal_id = p_goal_id
       and v_existing_goal_funding = coalesce(p_goal_funding, 0) then return v_existing_id; end if;
    raise exception 'Mutation ID already used for another project link';
  end if;

  select status into v_goal_status
  from public.trade_up_goals
  where id = p_goal_id and user_id = v_user_id
  for update;
  if v_goal_status is null then raise exception 'Goal not found'; end if;
  if v_goal_status <> 'active' then raise exception 'Goal is not active'; end if;

  select * into v_project
  from public.projects
  where id = p_project_id and user_id = v_user_id
  for update;
  if v_project.id is null then raise exception 'Project not found'; end if;

  select id, goal_id, goal_funding_amount into v_existing_id, v_existing_goal_id, v_existing_goal_funding
  from public.projects
  where user_id = v_user_id and trade_up_mutation_id = p_mutation_id;
  if v_existing_id is not null then
    if v_existing_id = p_project_id and v_existing_goal_id = p_goal_id
       and v_existing_goal_funding = coalesce(p_goal_funding, 0) then return v_existing_id; end if;
    raise exception 'Mutation ID already used for another project link';
  end if;

  if v_project.status <> 'active' then raise exception 'Only active projects can be added to a goal'; end if;
  if v_project.goal_id is not null then raise exception 'Project already belongs to a Trade-Up Goal'; end if;
  if v_project.traded_from_project_id is not null or coalesce(v_project.trade_credit_amount, 0) <> 0 then
    raise exception 'Trade-linked projects cannot be reassigned';
  end if;
  if coalesce(p_goal_funding, 0) < 0 then raise exception 'Goal funds used cannot be negative'; end if;
  if coalesce(p_goal_funding, 0) > coalesce(v_project.purchase_price, 0) then
    raise exception 'Goal funds used cannot exceed the project purchase price';
  end if;

  select coalesce(sum(amount), 0) into v_available
  from public.goal_ledger
  where goal_id = p_goal_id and user_id = v_user_id;
  if coalesce(p_goal_funding, 0) > v_available then
    raise exception 'Goal funds used cannot exceed the amount available toward the goal';
  end if;

  if coalesce(p_goal_funding, 0) > 0 then
    insert into public.goal_ledger(goal_id, user_id, project_id, type, amount, note, client_mutation_id)
    values(
      p_goal_id,
      v_user_id,
      p_project_id,
      'goal_purchase',
      -p_goal_funding,
      'Goal funds allocated to existing project ' || v_project.title,
      p_mutation_id || ':funding'
    );
  end if;

  update public.projects
  set goal_id = p_goal_id,
      goal_funding_amount = coalesce(p_goal_funding, 0),
      out_of_pocket_amount = coalesce(v_project.purchase_price, 0) - coalesce(p_goal_funding, 0),
      trade_up_mutation_id = p_mutation_id
  where id = p_project_id and user_id = v_user_id;

  return p_project_id;
end;
$$;

revoke all on function public.link_trade_up_project(uuid, uuid, numeric, text) from public;
grant execute on function public.link_trade_up_project(uuid, uuid, numeric, text) to authenticated;

commit;
