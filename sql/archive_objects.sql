-- Supabase archive objects: staging tables + RPC functions
-- Safe for concurrent runs; avoids reserved-word pitfalls; quotes CamelCase tables

-- Staging tables
create table if not exists public.transactions_archive_staging (
  id bigserial primary key,
  run_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.charge_requests_archive_staging (
  id bigserial primary key,
  run_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Optional: indexes to speed reads/cleanup
create index if not exists idx_transactions_archive_staging_run_id on public.transactions_archive_staging(run_id);
create index if not exists idx_charge_requests_archive_staging_run_id on public.charge_requests_archive_staging(run_id);

-- Function: move_old_transactions_batch_json
create or replace function public.move_old_transactions_batch_json(
  cutoff timestamptz,
  batch_size integer,
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Return the IDs moved in this batch (JS only uses length)
  return query
  with to_move as (
    select t.id
    from public."Transactions" t
    where t.created_at < cutoff
    order by t.id
    limit batch_size
    for update skip locked
  ),
  ins as (
    insert into public.transactions_archive_staging(run_id, payload)
    select in_run_id, to_jsonb(t)
    from public."Transactions" t
    join to_move m on m.id = t.id
    returning 1
  ),
  del as (
    delete from public."Transactions" t
    using to_move m
    where t.id = m.id
    returning t.id
  )
  select id from del;
end;
$$;

grant execute on function public.move_old_transactions_batch_json(timestamptz, integer, uuid) to service_role;

-- Function: move_old_chargerequests_batch_json
create or replace function public.move_old_chargerequests_batch_json(
  cutoff timestamptz,
  batch_size integer,
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with to_move as (
    select c.id
    from public."ChargeRequests" c
    where c.requested_at < cutoff
    order by c.id
    limit batch_size
    for update skip locked
  ),
  ins as (
    insert into public.charge_requests_archive_staging(run_id, payload)
    select in_run_id, to_jsonb(c)
    from public."ChargeRequests" c
    join to_move m on m.id = c.id
    returning 1
  ),
  del as (
    delete from public."ChargeRequests" c
    using to_move m
    where c.id = m.id
    returning c.id
  )
  select id from del;
end;
$$;

grant execute on function public.move_old_chargerequests_batch_json(timestamptz, integer, uuid) to service_role;

-- Two-phase archive API: stage first, delete after upload succeeds

-- Stage only: copy to staging; do not delete source rows
create or replace function public.stage_old_transactions_batch_json(
  cutoff timestamptz,
  batch_size integer,
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with to_move as (
    select t.id
    from public."Transactions" t
    where t.created_at < cutoff
    order by t.id
    limit batch_size
    for update skip locked
  )
  insert into public.transactions_archive_staging(run_id, payload)
  select in_run_id, to_jsonb(t)
  from public."Transactions" t
  join to_move m on m.id = t.id
  returning (payload->>'id')::bigint;
end;
$$;

grant execute on function public.stage_old_transactions_batch_json(timestamptz, integer, uuid) to service_role;

-- Finalize: delete source rows that were staged in this run
create or replace function public.finalize_delete_transactions_by_run(
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  delete from public."Transactions" t
  using public.transactions_archive_staging s
  where s.run_id = in_run_id
    and t.id = (s.payload->>'id')::bigint
  returning t.id;
end;
$$;

grant execute on function public.finalize_delete_transactions_by_run(uuid) to service_role;

-- ChargeRequests: stage only
create or replace function public.stage_old_chargerequests_batch_json(
  cutoff timestamptz,
  batch_size integer,
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with to_move as (
    select c.id
    from public."ChargeRequests" c
    where c.requested_at < cutoff
    order by c.id
    limit batch_size
    for update skip locked
  )
  insert into public.charge_requests_archive_staging(run_id, payload)
  select in_run_id, to_jsonb(c)
  from public."ChargeRequests" c
  join to_move m on m.id = c.id
  returning (payload->>'id')::bigint;
end;
$$;

grant execute on function public.stage_old_chargerequests_batch_json(timestamptz, integer, uuid) to service_role;

-- ChargeRequests: finalize
create or replace function public.finalize_delete_chargerequests_by_run(
  in_run_id uuid
)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  delete from public."ChargeRequests" c
  using public.charge_requests_archive_staging s
  where s.run_id = in_run_id
    and c.id = (s.payload->>'id')::bigint
  returning c.id;
end;
$$;

grant execute on function public.finalize_delete_chargerequests_by_run(uuid) to service_role;
