// Driver/dispatch persistence in the website's PostgreSQL database, schema driver_ops
// (backend/db/driver_ops_schema.sql). Same interface and row shapes as ./supabase.js: every
// method resolves to { data, error } and database errors (42P01, 42703, 42883, 23505, ...) are
// returned, not thrown, so server.js degrades exactly as it does with Supabase.
const {
  DELIVERY_ATTEMPT_COLUMNS,
  DELIVERY_ATTEMPT_WRITE_COLUMNS,
  DRIVER_SESSION_COLUMNS,
  DRIVER_SESSION_WRITE_COLUMNS,
  INVOICE_COLUMNS,
  INVOICE_WRITE_COLUMNS,
} = require('./columns');

const DRIVER_SCHEMA = 'driver_ops';
// plan_date is read as text: node-postgres turns a date into a local-midnight Date object.
const ROUTE_PLAN_SELECT = 'driver_id, plan_date::text as plan_date, order_ids, source, created_by, updated_at';
const JSONB_COLUMNS = new Set(['order_ids', 'items']);
// numeric columns arrive as strings from node-postgres but as numbers from PostgREST.
const NUMERIC_COLUMNS = new Set(['subtotal_excl_vat', 'vat_amount', 'total_incl_vat', 'amount_paid', 'cash_collected', 'card_amount']);

// Makes a node-postgres row look like the PostgREST row Supabase returns.
function normalizeRow(row) {
  if (!row) return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) result[key] = value.toISOString();
    else if (NUMERIC_COLUMNS.has(key) && value != null) result[key] = Number(value);
    else result[key] = value;
  }
  return result;
}

function toParam(column, value) {
  if (value === undefined) return null;
  return JSONB_COLUMNS.has(column) ? JSON.stringify(value ?? []) : value;
}

// Picks the allowed columns present in row, in a stable order.
function writableEntries(row, allowedColumns) {
  return allowedColumns.filter((column) => Object.prototype.hasOwnProperty.call(row, column) && row[column] !== undefined)
    .map((column) => [column, toParam(column, row[column])]);
}

function placeholders(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(', ');
}

// query(textOrConfig, values) => Promise<{ rows, rowCount }> — pg Pool#query or a test double.
function createPostgresStore({ query }) {
  if (typeof query !== 'function') throw new Error('createPostgresStore requires a query function');

  async function run(text, values = [], options = {}) {
    try {
      const config = options.timeoutMs ? { text, values, query_timeout: options.timeoutMs } : { text, values };
      const result = await query(config);
      return { rows: (result?.rows || []).map(normalizeRow), rowCount: result?.rowCount ?? 0, error: null };
    } catch (error) {
      return { rows: [], rowCount: 0, error };
    }
  }

  async function many(text, values, options) {
    const { rows, error } = await run(text, values, options);
    return { data: error ? null : rows, error };
  }

  async function maybeOne(text, values) {
    const { rows, error } = await run(text, values);
    return { data: error ? null : rows[0] || null, error };
  }

  // Like Supabase .single(): no row is an error.
  async function one(text, values) {
    const { data, error } = await maybeOne(text, values);
    if (error) return { data: null, error };
    if (!data) return { data: null, error: { code: 'NO_ROWS', message: 'The statement returned no row' } };
    return { data, error: null };
  }

  async function none(text, values) {
    const { error } = await run(text, values);
    return { data: null, error };
  }

  return {
    kind: 'postgres',
    schemaLabel: `PostgreSQL table ${DRIVER_SCHEMA}`,

    // --- driver_sessions / driver_locations ---
    loadDriverSessions(driverIds, { timeoutMs } = {}) {
      return many(
        `select ${DRIVER_SESSION_COLUMNS} from driver_sessions where driver_id = any($1::text[])`,
        [driverIds],
        { timeoutMs },
      );
    },

    upsertDriverSession(driverId, patch) {
      const entries = writableEntries(patch, DRIVER_SESSION_WRITE_COLUMNS);
      const columns = ['driver_id', ...entries.map(([column]) => column)];
      const updates = entries.map(([column]) => `${column} = excluded.${column}`);
      return none(
        `insert into driver_sessions (${columns.join(', ')}) values (${placeholders(columns.length)}) `
          + `on conflict (driver_id) do ${updates.length ? `update set ${updates.join(', ')}` : 'nothing'}`,
        [driverId, ...entries.map(([, value]) => value)],
      );
    },

    insertDriverLocation(row) {
      return none(
        'insert into driver_locations (driver_id, lat, lng, accuracy, recorded_at) values ($1, $2, $3, $4, $5)',
        [row.driver_id, row.lat, row.lng, row.accuracy ?? null, row.recorded_at ?? new Date().toISOString()],
      );
    },

    // --- driver_route_plans ---
    listRoutePlans(planDate) {
      return many(`select ${ROUTE_PLAN_SELECT} from driver_route_plans where plan_date = $1 order by driver_id asc`, [planDate]);
    },

    updateRoutePlanOrders(driverId, planDate, orderIds, updatedAt) {
      return none(
        'update driver_route_plans set order_ids = $1::jsonb, updated_at = $2 where driver_id = $3 and plan_date = $4',
        [JSON.stringify(orderIds), updatedAt, driverId, planDate],
      );
    },

    deleteRoutePlan(driverId, planDate) {
      return many('delete from driver_route_plans where driver_id = $1 and plan_date = $2 returning driver_id', [driverId, planDate]);
    },

    upsertRoutePlan(row) {
      return one(
        'insert into driver_route_plans (driver_id, plan_date, order_ids, source, created_by, updated_at) '
          + 'values ($1, $2, $3::jsonb, $4, $5, $6) '
          + 'on conflict (driver_id, plan_date) do update set order_ids = excluded.order_ids, source = excluded.source, '
          + 'created_by = excluded.created_by, updated_at = excluded.updated_at '
          + `returning ${ROUTE_PLAN_SELECT}`,
        [row.driver_id, row.plan_date, JSON.stringify(row.order_ids || []), row.source || 'dispatch-console', row.created_by ?? null, row.updated_at ?? new Date().toISOString()],
      );
    },

    // --- delivery_attempts ---
    // A replay with the same (driver_id, client_request_id) fails with 23505 from the unique
    // index, exactly like the Supabase insert; the caller decides what that means.
    insertDeliveryAttempt(row) {
      const entries = writableEntries(row, DELIVERY_ATTEMPT_WRITE_COLUMNS);
      return none(
        `insert into delivery_attempts (${entries.map(([column]) => column).join(', ')}) values (${placeholders(entries.length)})`,
        entries.map(([, value]) => value),
      );
    },

    findDeliveryAttemptByKey(driverId, requestKey) {
      return maybeOne(
        `select ${DELIVERY_ATTEMPT_COLUMNS} from delivery_attempts where driver_id = $1 and client_request_id = $2 order by attempted_at asc limit 1`,
        [driverId, requestKey],
      );
    },

    listDeliveryAttempts({ start, end, driverId, outcome, withKey }) {
      const values = [start, end];
      const filters = ['attempted_at >= $1', 'attempted_at < $2'];
      if (driverId) filters.push(`driver_id = $${values.push(driverId)}`);
      if (outcome) filters.push(`outcome = $${values.push(outcome)}`);
      const columns = withKey ? `${DELIVERY_ATTEMPT_COLUMNS}, client_request_id` : DELIVERY_ATTEMPT_COLUMNS;
      return many(`select ${columns} from delivery_attempts where ${filters.join(' and ')} order by attempted_at asc limit 2000`, values);
    },

    // --- invoices ---
    findInvoiceByOrder(orderId, driverId) {
      return driverId
        ? maybeOne(`select ${INVOICE_COLUMNS} from invoices where order_id = $1 and driver_id = $2`, [orderId, driverId])
        : maybeOne(`select ${INVOICE_COLUMNS} from invoices where order_id = $1`, [orderId]);
    },

    findInvoiceById(invoiceId) {
      return maybeOne(`select ${INVOICE_COLUMNS} from invoices where id = $1`, [invoiceId]);
    },

    listInvoices({ start, end, driverId }) {
      const values = [start, end];
      const filters = ['issued_at >= $1', 'issued_at < $2'];
      if (driverId) filters.push(`driver_id = $${values.push(driverId)}`);
      return many(`select ${INVOICE_COLUMNS} from invoices where ${filters.join(' and ')} order by issued_at asc limit 2000`, values);
    },

    async nextInvoiceNumber() {
      const { data, error } = await maybeOne('select next_invoice_number() as invoice_number', []);
      return { data: error ? null : data?.invoice_number ?? null, error };
    },

    insertInvoice(row) {
      const entries = writableEntries(row, INVOICE_WRITE_COLUMNS);
      return one(
        `insert into invoices (${entries.map(([column]) => column).join(', ')}) values (${placeholders(entries.length)}) returning ${INVOICE_COLUMNS}`,
        entries.map(([, value]) => value),
      );
    },

    setInvoicePdf(invoiceId, bucket, objectPath) {
      return one(`update invoices set pdf_bucket = $1, pdf_path = $2 where id = $3 returning ${INVOICE_COLUMNS}`, [bucket, objectPath, invoiceId]);
    },

    async close() {},
  };
}

// The real pool. search_path is set at connection start so every unqualified table and
// next_invoice_number() resolve inside driver_ops (never the website's public schema).
function createPostgresPool({ connectionString, Pool = require('pg').Pool, max = 5 }) {
  const pool = new Pool({
    connectionString,
    max,
    options: `-c search_path=${DRIVER_SCHEMA}`,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'rswater-driver-api',
  });
  pool.on('error', (error) => {
    console.error('PostgreSQL pool error', { message: error?.message || String(error), status: error?.code });
  });
  return pool;
}

module.exports = { DRIVER_SCHEMA, createPostgresPool, createPostgresStore, normalizeRow };
