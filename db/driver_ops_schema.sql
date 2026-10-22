-- RS Water driver backend: own data in the website's PostgreSQL database (alrawdah_db), schema driver_ops.
-- Used when the backend runs with DRIVER_DATABASE_URL (see backend/VPS_DRIVER_DEPLOYMENT.md).
-- Same tables/columns as supabase-migrations/20261020_driver_dispatch.sql and
-- 20261021_driver_delivery_records.sql, without Supabase roles, RLS or PostgREST.
-- Idempotent: safe to run more than once. Apply it as the driver_ops role:
--   DRIVER_DATABASE_URL=... node scripts/apply-driver-schema.js
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in; no extension needed).
--
-- ---------------------------------------------------------------------------------------------
-- ONE-TIME ROLE SETUP (run once by the owner as the postgres superuser, e.g.
--   sudo -u postgres psql -d alrawdah_db
-- then paste the statements below with a freshly generated password, e.g. from
--   openssl rand -base64 32 | tr -d '/+=' ).
-- The role can use only its own schema: it gets no privilege on the website's tables.
--
--   create role driver_ops login password '<generated>';
--   grant connect on database alrawdah_db to driver_ops;
--   create schema if not exists driver_ops authorization driver_ops;
--   grant usage, create on schema driver_ops to driver_ops;
--   alter role driver_ops set search_path = driver_ops;
--   -- Keep it out of the website's schema (PUBLIC may still have USAGE/CREATE on it):
--   revoke all on schema public from driver_ops;
--   -- PostgreSQL 14 and older only: PUBLIC can create objects in schema public. If the
--   -- website does not rely on that, remove it for everyone:
--   --   revoke create on schema public from public;
--
-- Check that the role cannot read website data (both must return false; adapt the table name):
--   select has_table_privilege('driver_ops', 'public.orders', 'select'),
--          has_schema_privilege('driver_ops', 'public', 'create');
-- If the first one is true, a website table was granted to PUBLIC; revoke it for driver_ops'
-- sake with: revoke all on public.<table> from public;  (only if the website does not need it)
-- ---------------------------------------------------------------------------------------------

-- The schema normally already exists (created above, owned by driver_ops). The check avoids
-- needing CREATE on the database when it does.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'driver_ops') then
    execute 'create schema if not exists driver_ops';
  end if;
end $$;

set search_path = driver_ops;

create or replace function driver_ops.update_modified_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Dispatch console route plans: one ordered list of order ids per driver per day.
-- driver_id is text without a FK: drivers are the backend's CONFIGURED_DRIVERS.
create table if not exists driver_ops.driver_route_plans (
  id uuid default gen_random_uuid() primary key,
  driver_id text not null,
  plan_date date not null,
  order_ids jsonb not null default '[]'::jsonb,
  source text not null default 'dispatch-console',
  created_by text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  constraint driver_route_plans_driver_date_unique unique (driver_id, plan_date),
  constraint driver_route_plans_order_ids_array check (jsonb_typeof(order_ids) = 'array')
);

create index if not exists driver_route_plans_plan_date_idx on driver_ops.driver_route_plans(plan_date);

-- Latest shift / GPS state per driver so it survives backend restarts.
create table if not exists driver_ops.driver_sessions (
  driver_id text primary key,
  shift_status text check (shift_status in ('ON_DUTY', 'OFF_DUTY')),
  shift_started_at timestamp with time zone,
  shift_ended_at timestamp with time zone,
  gps_sharing boolean,
  last_latitude double precision,
  last_longitude double precision,
  last_accuracy double precision,
  last_location_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- GPS history (at most one row per driver per 20 s).
create table if not exists driver_ops.driver_locations (
  id uuid default gen_random_uuid() primary key,
  driver_id uuid not null,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  recorded_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create index if not exists driver_locations_driver_recorded_idx on driver_ops.driver_locations(driver_id, recorded_at desc);

drop trigger if exists update_driver_route_plans_modtime on driver_ops.driver_route_plans;
drop trigger if exists update_driver_sessions_modtime on driver_ops.driver_sessions;
create trigger update_driver_route_plans_modtime before update on driver_ops.driver_route_plans
  for each row execute procedure driver_ops.update_modified_column();
create trigger update_driver_sessions_modtime before update on driver_ops.driver_sessions
  for each row execute procedure driver_ops.update_modified_column();

-- Invoices / receipts issued on delivery. order_id is text: website orders live in the website.
create table if not exists driver_ops.invoices (
  id uuid default gen_random_uuid() primary key,
  invoice_number text not null,
  order_id text not null,
  order_source text not null check (order_source in ('operations', 'website')),
  driver_id text,
  customer_name text,
  customer_phone text,
  customer_address text,
  items jsonb not null default '[]'::jsonb,
  subtotal_excl_vat numeric(12, 2) not null default 0,
  vat_amount numeric(12, 2) not null default 0,
  total_incl_vat numeric(12, 2) not null default 0,
  currency text not null default 'AED',
  payment_method text check (payment_method in ('cash', 'card', 'prepaid')),
  amount_paid numeric(12, 2) not null default 0,
  issued_at timestamp with time zone not null default now(),
  pdf_bucket text,
  pdf_path text,
  created_at timestamp with time zone default now(),
  constraint invoices_invoice_number_unique unique (invoice_number),
  constraint invoices_order_id_unique unique (order_id),
  constraint invoices_items_array check (jsonb_typeof(items) = 'array')
);

create index if not exists invoices_driver_issued_idx on driver_ops.invoices(driver_id, issued_at desc);
create index if not exists invoices_issued_idx on driver_ops.invoices(issued_at desc);

-- One counter row per calendar year (Asia/Dubai). The row lock taken by the upsert
-- serialises concurrent callers, so numbers are unique and sequential within a year.
create table if not exists driver_ops.invoice_counters (
  year integer primary key,
  last_value bigint not null default 0,
  updated_at timestamp with time zone default now()
);

create or replace function driver_ops.next_invoice_number()
returns text
language plpgsql
set search_path = driver_ops
as $$
declare
  invoice_year integer := extract(year from (now() at time zone 'Asia/Dubai'))::integer;
  next_value bigint;
begin
  insert into driver_ops.invoice_counters as counters (year, last_value, updated_at)
  values (invoice_year, 1, now())
  on conflict (year) do update
    set last_value = counters.last_value + 1,
        updated_at = now()
  returning last_value into next_value;

  return format('INV-%s-%s', invoice_year, lpad(next_value::text, 6, '0'));
end;
$$;

revoke all on function driver_ops.next_invoice_number() from public;

-- Every delivery attempt (delivered or failed) with payment, signature and proof references.
create table if not exists driver_ops.delivery_attempts (
  id uuid default gen_random_uuid() primary key,
  order_id text not null,
  order_source text check (order_source in ('operations', 'website')),
  driver_id text not null,
  outcome text not null check (outcome in ('DELIVERED', 'FAILED')),
  reason_code text,
  note text,
  payment_method text check (payment_method in ('cash', 'card', 'prepaid')),
  cash_collected numeric(12, 2) not null default 0,
  card_amount numeric(12, 2) not null default 0,
  card_reference text,
  empty_bottles_returned integer not null default 0,
  signature_bucket text,
  signature_path text,
  proof_bucket text,
  proof_path text,
  latitude double precision,
  longitude double precision,
  attempted_at timestamp with time zone not null default now(),
  -- Idempotency-Key sent by the driver app; a retried or replayed request reuses it.
  client_request_id text,
  created_at timestamp with time zone default now()
);

alter table driver_ops.delivery_attempts add column if not exists client_request_id text;

create index if not exists delivery_attempts_driver_attempted_idx on driver_ops.delivery_attempts(driver_id, attempted_at);
create index if not exists delivery_attempts_attempted_idx on driver_ops.delivery_attempts(attempted_at desc);
create index if not exists delivery_attempts_order_idx on driver_ops.delivery_attempts(order_id);
-- One attempt per driver request: a replay with the same key cannot insert a second row.
create unique index if not exists delivery_attempts_driver_request_idx
  on driver_ops.delivery_attempts(driver_id, client_request_id)
  where client_request_id is not null;
