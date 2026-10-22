// Applies backend/db/driver_ops_schema.sql to DRIVER_DATABASE_URL (idempotent). No other side effects.
//   DRIVER_DATABASE_URL=postgresql://driver_ops:...@127.0.0.1:5432/alrawdah_db node scripts/apply-driver-schema.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'driver_ops_schema.sql');

async function main() {
  const connectionString = String(process.env.DRIVER_DATABASE_URL || '').trim();
  if (!connectionString) {
    console.error('DRIVER_DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }

  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const client = new Client({ connectionString, application_name: 'rswater-driver-schema' });
  await client.connect();
  try {
    // One simple-protocol call runs the whole file; wrapped so a failure leaves nothing half-applied.
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log(`Applied ${path.relative(process.cwd(), SCHEMA_FILE)}`);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Driver schema apply failed:', error.message);
  process.exitCode = 1;
});
