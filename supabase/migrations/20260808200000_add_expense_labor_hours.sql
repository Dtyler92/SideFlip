begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.expenses
  add column if not exists labor_hours numeric(10,2);

comment on column public.expenses.labor_hours is
  'User-entered labor time for this expense, normalized upward to the nearest quarter hour. Nullable for legacy clients and historical rows.';

create or replace function public.normalize_expense_labor_hours()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.labor_hours is null then
    return new;
  end if;

  if new.labor_hours <= 0 or new.labor_hours > 10000 then
    raise exception 'Labor hours must be greater than zero and no more than 10000';
  end if;

  new.labor_hours := ceil(new.labor_hours * 4) / 4;
  return new;
end;
$$;

revoke all on function public.normalize_expense_labor_hours() from public, anon, authenticated;

drop trigger if exists normalize_expense_labor_hours_trigger on public.expenses;
create trigger normalize_expense_labor_hours_trigger
before insert or update of labor_hours on public.expenses
for each row execute function public.normalize_expense_labor_hours();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.expenses'::regclass
      and conname = 'expenses_labor_hours_quarter_hour_check'
  ) then
    alter table public.expenses
      add constraint expenses_labor_hours_quarter_hour_check
      check (
        labor_hours is null
        or (
          labor_hours > 0
          and labor_hours <= 10000
          and labor_hours * 4 = trunc(labor_hours * 4)
        )
      );
  end if;
end;
$$;

commit;
