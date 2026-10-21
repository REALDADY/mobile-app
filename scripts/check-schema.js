require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const checks = [
  { table: 'products', columns: 'id,code,name,price_aed,vat_rate,is_active' },
  { table: 'coupon_packs', columns: 'id,code,bottle_count,price_aed,is_active' },
  { table: 'orders', columns: 'id,total_amount,status,delivery_fee,vat_amount' },
  { table: 'payment_transactions', columns: 'id,order_id,status,provider,amount' },
  { table: 'push_tokens', columns: 'id,user_id,app_type,token' },
  { table: 'driver_locations', columns: 'id,driver_id,lat,lng,accuracy,recorded_at' },
  { table: 'deliveries', columns: 'id,order_id,driver_id,status' },
  // Optional until supabase-migrations/20261020_driver_dispatch.sql is applied; the API
  // falls back to automatic routing and memory-only driver state without them.
  { table: 'driver_route_plans', columns: 'id,driver_id,plan_date,order_ids,source,created_by,updated_at', optional: true },
  { table: 'driver_sessions', columns: 'driver_id,shift_status,shift_started_at,shift_ended_at,gps_sharing,last_latitude,last_longitude,last_accuracy,last_location_at,updated_at', optional: true },
];

let optionalMissing = false;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function checkTable(supabase, check) {
  const { error } = await supabase.from(check.table).select(check.columns).limit(1);
  if (!error) {
    console.log(`ok ${check.table}`);
    return;
  }

  const detail = error.message || error.details || 'unknown error';
  if (check.optional) {
    optionalMissing = true;
    console.warn(`warning optional ${check.table}: ${detail}`);
    return;
  }
  fail(`missing-or-invalid ${check.table}: ${detail}`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const check of checks) {
    await checkTable(supabase, check);
  }

  if (process.exitCode) {
    console.error('Run supabase-schema.sql, then supabase-production-hardening.sql for existing databases.');
  } else {
    console.log('Supabase schema is ready.');
  }
  if (optionalMissing) {
    console.warn('Optional driver dispatch tables are missing: run supabase-migrations/20261020_driver_dispatch.sql to enable route plans and persisted driver sessions.');
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Schema check failed.');
});
