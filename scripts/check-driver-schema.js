// Verifies that the driver_ops schema in DRIVER_DATABASE_URL has every table, column and the
// next_invoice_number() function the backend uses. Read-only; exits 1 when something is missing.
//   DRIVER_DATABASE_URL=postgresql://driver_ops:...@127.0.0.1:5432/alrawdah_db node scripts/check-driver-schema.js
require('dotenv').config();

const { Client } = require('pg');

const SCHEMA = 'driver_ops';
const TABLES = {
  driver_route_plans: ['id', 'driver_id', 'plan_date', 'order_ids', 'source', 'created_by', 'created_at', 'updated_at'],
  driver_sessions: ['driver_id', 'shift_status', 'shift_started_at', 'shift_ended_at', 'gps_sharing', 'last_latitude', 'last_longitude', 'last_accuracy', 'last_location_at', 'updated_at'],
  driver_locations: ['id', 'driver_id', 'lat', 'lng', 'accuracy', 'recorded_at'],
  invoices: ['id', 'invoice_number', 'order_id', 'order_source', 'driver_id', 'customer_name', 'customer_phone', 'customer_address', 'items', 'subtotal_excl_vat', 'vat_amount', 'total_incl_vat', 'currency', 'payment_method', 'amount_paid', 'issued_at', 'pdf_bucket', 'pdf_path', 'created_at'],
  invoice_counters: ['year', 'last_value', 'updated_at'],
  delivery_attempts: ['id', 'order_id', 'order_source', 'driver_id', 'outcome', 'reason_code', 'note', 'payment_method', 'cash_collected', 'card_amount', 'card_reference', 'empty_bottles_returned', 'signature_bucket', 'signature_path', 'proof_bucket', 'proof_path', 'latitude', 'longitude', 'attempted_at', 'client_request_id'],
};
const INDEXES = ['delivery_attempts_driver_request_idx'];

async function main() {
  const connectionString = String(process.env.DRIVER_DATABASE_URL || '').trim();
  if (!connectionString) {
    console.error('DRIVER_DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString, application_name: 'rswater-driver-schema-check' });
  await client.connect();
  let missing = 0;
  try {
    const { rows: columnRows } = await client.query(
      'select table_name, column_name from information_schema.columns where table_schema = $1',
      [SCHEMA],
    );
    const columnsByTable = new Map();
    columnRows.forEach((row) => {
      if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
      columnsByTable.get(row.table_name).add(row.column_name);
    });

    for (const [table, columns] of Object.entries(TABLES)) {
      const present = columnsByTable.get(table);
      if (!present) {
        console.error(`missing table ${SCHEMA}.${table}`);
        missing += 1;
        continue;
      }
      const absent = columns.filter((column) => !present.has(column));
      if (absent.length) {
        console.error(`missing columns in ${SCHEMA}.${table}: ${absent.join(', ')}`);
        missing += 1;
      } else {
        console.log(`ok ${SCHEMA}.${table}`);
      }
    }

    const { rows: indexRows } = await client.query('select indexname from pg_indexes where schemaname = $1', [SCHEMA]);
    const indexes = new Set(indexRows.map((row) => row.indexname));
    for (const index of INDEXES) {
      if (indexes.has(index)) console.log(`ok index ${index}`);
      else {
        console.error(`missing index ${SCHEMA}.${index}`);
        missing += 1;
      }
    }

    const { rows: functionRows } = await client.query(
      "select to_regprocedure('driver_ops.next_invoice_number()') is not null as present, "
        + "has_function_privilege(current_user, 'driver_ops.next_invoice_number()', 'execute') as executable",
    ).catch(() => ({ rows: [{ present: false, executable: false }] }));
    if (functionRows[0]?.present && functionRows[0]?.executable) console.log('ok function driver_ops.next_invoice_number()');
    else {
      console.error('missing (or not executable) function driver_ops.next_invoice_number()');
      missing += 1;
    }
  } finally {
    await client.end();
  }

  if (missing) {
    console.error(`${missing} problem(s) found. Apply backend/db/driver_ops_schema.sql with scripts/apply-driver-schema.js.`);
    process.exitCode = 1;
  } else {
    console.log('driver_ops schema is complete.');
  }
}

main().catch((error) => {
  console.error('Driver schema check failed:', error.message);
  process.exitCode = 1;
});
