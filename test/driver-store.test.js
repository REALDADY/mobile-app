const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { assertSafeObjectPath, contentTypeFor, createDiskFileStore } = require('../src/store/files-disk');
const { createPostgresStore, normalizeRow } = require('../src/store/postgres');
const { createDriverStorage, resolveFilesDir, resolveSupabaseConfig, selectStorageMode } = require('../src/store');
const { isMissingTableError, removeOrdersFromOtherPlans } = require('../src/route-plan-service');
const { isMissingColumnError, isMissingFunctionError, isUniqueViolationError } = require('../src/delivery-record-service');
const { createDriverReportService } = require('../src/driver-report-service');
const { createDriverCustomerRequestService } = require('../src/driver-customer-request-service');

async function tempDir() {
  return fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'driver-store-test-'));
}

// --- Disk file store ---

test('disk file store rejects path traversal, absolute paths, NUL bytes and bad buckets', async () => {
  const root = await tempDir();
  const files = createDiskFileStore({ rootDir: root });
  const badPaths = ['../escape.txt', 'a/../../escape.txt', '..', 'a/./b.txt', '/etc/passwd', 'C:/windows/x', 'a\\..\\b', 'a\0b.json', 'a//b.json', '', 'a/b c.json'];
  for (const badPath of badPaths) {
    assert.throws(() => assertSafeObjectPath(badPath), { code: 'INVALID_FILE_PATH' }, badPath);
    await assert.rejects(files.upload('delivery-proofs', badPath, Buffer.from('x')), { code: 'INVALID_FILE_PATH' }, badPath);
    assert.equal(await files.download('delivery-proofs', badPath), null);
    assert.equal(await files.exists('delivery-proofs', badPath), false);
  }
  for (const badBucket of ['..', '.', '../x', 'a/b', '']) {
    await assert.rejects(files.upload(badBucket, 'ok.json', Buffer.from('x')), { code: 'INVALID_FILE_PATH' }, badBucket);
  }
  // Nothing was written outside (or inside) the root.
  assert.deepEqual(await fs.readdir(root), []);
});

test('disk file store writes atomically, keeps bucket folders and reads / deletes / checks files', async () => {
  const root = await tempDir();
  const files = createDiskFileStore({ rootDir: root });
  const objectPath = 'ARS-1001/1729500000000-abcd.jpg';
  await files.ensureBucket('delivery-proofs');
  await files.upload('delivery-proofs', objectPath, Buffer.from('first'), { contentType: 'image/jpeg', upsert: false });

  assert.equal((await fs.readFile(path.join(root, 'delivery-proofs', objectPath))).toString(), 'first');
  assert.equal((await files.download('delivery-proofs', objectPath)).toString(), 'first');
  assert.equal(await files.exists('delivery-proofs', objectPath), true);
  assert.equal(await files.exists('delivery-proofs', 'ARS-1001'), false, 'a directory is not a file');

  // upsert: false never overwrites; upsert: true replaces in one step.
  await assert.rejects(files.upload('delivery-proofs', objectPath, Buffer.from('second')), { code: 'EEXIST' });
  assert.equal((await files.download('delivery-proofs', objectPath)).toString(), 'first');
  await files.upload('delivery-proofs', objectPath, Buffer.from('third'), { upsert: true });
  assert.equal((await files.download('delivery-proofs', objectPath)).toString(), 'third');

  // No temp files are left behind.
  assert.deepEqual(await fs.readdir(path.join(root, 'delivery-proofs', 'ARS-1001')), ['1729500000000-abcd.jpg']);

  assert.deepEqual(await files.remove('delivery-proofs', [objectPath, 'ARS-1001/missing.jpg']), { error: null });
  assert.equal(await files.exists('delivery-proofs', objectPath), false);
  assert.equal(await files.download('delivery-proofs', objectPath), null);
  assert.equal(await files.download('delivery-invoices', '2026/INV-2026-000001.pdf'), null);
});

test('disk file store infers content types', () => {
  assert.equal(contentTypeFor('a/b.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('signatures/x/1.png'), 'image/png');
  assert.equal(contentTypeFor('x.webp'), 'image/webp');
  assert.equal(contentTypeFor('2026/INV-2026-000001.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('customer-requests.json'), 'application/json');
  assert.equal(contentTypeFor('blob.bin'), 'application/octet-stream');
});

test('disk file store signs download URLs and rejects tampered or expired ones', async () => {
  const files = createDiskFileStore({ rootDir: await tempDir(), signingSecret: 'secret', apiBaseUrl: 'https://driver-api.example/' });
  const now = Date.UTC(2026, 9, 21, 8, 0, 0);
  const url = new URL(files.signedUrl('delivery-proofs', 'ARS-1001/1.jpg', 3600, now));
  assert.equal(url.origin, 'https://driver-api.example');
  assert.equal(url.pathname, '/api/files/delivery-proofs/download');
  const objectPath = url.searchParams.get('path');
  const expires = url.searchParams.get('expires');
  const signature = url.searchParams.get('signature');
  assert.equal(objectPath, 'ARS-1001/1.jpg');

  assert.equal(files.verifySignedUrl('delivery-proofs', objectPath, expires, signature, now), true);
  assert.equal(files.verifySignedUrl('delivery-proofs', 'ARS-1001/2.jpg', expires, signature, now), false);
  assert.equal(files.verifySignedUrl('delivery-invoices', objectPath, expires, signature, now), false);
  assert.equal(files.verifySignedUrl('delivery-proofs', objectPath, String(Number(expires) + 1), signature, now), false);
  assert.equal(files.verifySignedUrl('delivery-proofs', objectPath, expires, `${signature}x`, now), false);
  assert.equal(files.verifySignedUrl('delivery-proofs', objectPath, expires, signature, now + 3601 * 1000), false);
  assert.equal(files.verifySignedUrl('delivery-proofs', '../x.jpg', expires, signature, now), false);

  const unsigned = createDiskFileStore({ rootDir: await tempDir() });
  assert.equal(unsigned.signedUrl('delivery-proofs', 'a.jpg'), null);
  assert.equal(unsigned.verifySignedUrl('delivery-proofs', 'a.jpg', expires, signature, now), false);
});

test('report and customer-request services keep their JSON in the disk file store', async () => {
  const root = await tempDir();
  const files = createDiskFileStore({ rootDir: root });
  const reports = createDriverReportService({ files, apiBaseUrl: 'http://localhost', signingSecret: 's', bucket: 'driver-day-reports' });
  const driver = { id: '00000000-0000-4000-8000-000000000001', name: 'Driver 1' };
  await reports.recordAssignments(driver, [{ orderId: 'ARS-1', orderNumber: 'ARS-1', address: 'Villa 1' }], '2026-10-21T04:00:00.000Z');
  const journal = await reports.readJournal(driver, '2026-10-21');
  assert.equal(journal.assignedStops['ARS-1'].orderId, 'ARS-1');
  await fs.access(path.join(root, 'driver-day-reports', 'journals', '00000000-0000-4000-8000-000000000001', '2026-10-21.json'));

  const requests = createDriverCustomerRequestService({ files, bucket: 'driver-customer-requests' });
  const created = await requests.submit({ driverId: driver.id, driverName: 'Driver 1', customerName: 'A', phone: '+971501234567', latitude: 25, longitude: 55, address: 'Somewhere' });
  assert.equal((await requests.list({ driverId: driver.id }))[0].id, created.id);
  await fs.access(path.join(root, 'driver-customer-requests', 'customer-requests.json'));
});

// --- Adapter selection / Supabase optional ---

test('resolveSupabaseConfig makes Supabase optional but rejects half a configuration', () => {
  assert.equal(resolveSupabaseConfig({}), null);
  assert.equal(resolveSupabaseConfig({ SUPABASE_URL: '  ', SUPABASE_SERVICE_ROLE_KEY: '' }), null);
  assert.deepEqual(
    resolveSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }),
    { url: 'https://x.supabase.co', serviceKey: 'key' },
  );
  assert.deepEqual(
    resolveSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'legacy' }),
    { url: 'https://x.supabase.co', serviceKey: 'legacy' },
  );
  assert.throws(() => resolveSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co' }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => resolveSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: 'key' }), /SUPABASE_URL/);
  assert.throws(() => resolveSupabaseConfig({ SUPABASE_URL: 'ftp://x', SUPABASE_SERVICE_ROLE_KEY: 'key' }), /valid HTTP/);
});

test('selectStorageMode picks postgres, then supabase, then none', () => {
  assert.equal(selectStorageMode({ DRIVER_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/alrawdah_db' }, { supabaseConfigured: true }), 'postgres');
  assert.equal(selectStorageMode({ DRIVER_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/alrawdah_db' }), 'postgres');
  assert.equal(selectStorageMode({ DRIVER_DATABASE_URL: '   ' }, { supabaseConfigured: true }), 'supabase');
  assert.equal(selectStorageMode({}, { supabaseConfigured: true }), 'supabase');
  assert.equal(selectStorageMode({}), 'none');
});

test('createDriverStorage builds a driver_ops pool + disk files without connecting', async () => {
  const pools = [];
  class FakePool {
    constructor(config) {
      this.config = config;
      this.queries = [];
      this.ended = false;
      pools.push(this);
    }
    on() {}
    async query(config) {
      this.queries.push(config);
      return { rows: [{ invoice_number: 'INV-2026-000001' }], rowCount: 1 };
    }
    async end() { this.ended = true; }
  }
  const cwd = await tempDir();
  const storage = createDriverStorage({
    env: { DRIVER_DATABASE_URL: 'postgresql://driver_ops:pw@127.0.0.1:5432/alrawdah_db', DRIVER_FILES_DIR: 'files-here' },
    supabase: null,
    Pool: FakePool,
    signingSecret: 's',
    cwd,
  });
  assert.equal(storage.mode, 'postgres');
  assert.equal(storage.store.kind, 'postgres');
  assert.equal(storage.files.kind, 'disk');
  assert.equal(storage.filesDir, path.join(cwd, 'files-here'));
  assert.equal(pools.length, 1);
  assert.equal(pools[0].config.connectionString, 'postgresql://driver_ops:pw@127.0.0.1:5432/alrawdah_db');
  assert.match(pools[0].config.options, /search_path=driver_ops/);
  assert.equal(pools[0].queries.length, 0, 'no query until the store is used');

  assert.deepEqual(await storage.store.nextInvoiceNumber(), { data: 'INV-2026-000001', error: null });
  await storage.store.close();
  assert.equal(pools[0].ended, true);
});

test('createDriverStorage keeps Supabase when configured and degrades without any backend', async () => {
  const fakeSupabase = { storage: {}, from() { throw new Error('not called'); } };
  const supabaseMode = createDriverStorage({ env: {}, supabase: fakeSupabase });
  assert.equal(supabaseMode.mode, 'supabase');
  assert.equal(supabaseMode.store.kind, 'supabase');
  assert.equal(supabaseMode.files.kind, 'supabase');
  assert.equal(supabaseMode.store.schemaLabel, 'Supabase table public');

  const cwd = await tempDir();
  const none = createDriverStorage({ env: {}, supabase: null, cwd });
  assert.equal(none.mode, 'none');
  assert.equal(none.files.kind, 'disk');
  assert.equal(none.filesDir, resolveFilesDir({}, cwd));
  assert.equal(none.filesDir, path.join(cwd, 'data', 'files'));
  const { data, error } = await none.store.listRoutePlans('2026-10-21');
  assert.equal(data, null);
  assert.equal(isMissingTableError(error), true, 'treated like an unapplied migration');
});

// --- PostgreSQL store with an injected query function ---

function fakeQuery(responder = () => ({ rows: [], rowCount: 0 })) {
  const calls = [];
  const query = async (config) => {
    calls.push(config);
    const result = await responder(config, calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, query };
}

function pgError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('postgres store upserts a route plan as JSON and maps the row like PostgREST', async () => {
  const updatedAt = new Date('2026-10-21T08:00:00.000Z');
  const { calls, query } = fakeQuery(() => ({
    rows: [{ driver_id: 'd1', plan_date: '2026-10-21', order_ids: ['A-1', 'A-2'], source: 'dispatch-console', created_by: 'ops', updated_at: updatedAt }],
    rowCount: 1,
  }));
  const store = createPostgresStore({ query });
  const { data, error } = await store.upsertRoutePlan({
    driver_id: 'd1', plan_date: '2026-10-21', order_ids: ['A-1', 'A-2'], source: 'dispatch-console', created_by: 'ops', updated_at: updatedAt.toISOString(),
  });
  assert.equal(error, null);
  assert.deepEqual(data, { driver_id: 'd1', plan_date: '2026-10-21', order_ids: ['A-1', 'A-2'], source: 'dispatch-console', created_by: 'ops', updated_at: '2026-10-21T08:00:00.000Z' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^insert into driver_route_plans \(driver_id, plan_date, order_ids, source, created_by, updated_at\)/);
  assert.match(calls[0].text, /on conflict \(driver_id, plan_date\) do update set order_ids = excluded\.order_ids/);
  assert.match(calls[0].text, /plan_date::text as plan_date/);
  assert.deepEqual(calls[0].values, ['d1', '2026-10-21', '["A-1","A-2"]', 'dispatch-console', 'ops', '2026-10-21T08:00:00.000Z']);
});

test('postgres store removes claimed orders from other plans (update or delete) like server.js does', async () => {
  const { calls, query } = fakeQuery((config) => (
    config.text.startsWith('delete') ? { rows: [{ driver_id: 'd3' }], rowCount: 1 } : { rows: [], rowCount: 1 }
  ));
  const store = createPostgresStore({ query });
  const existing = [
    { driverId: 'd1', orderIds: ['A-1'] },
    { driverId: 'd2', orderIds: ['A-2', 'A-3'] },
    { driverId: 'd3', orderIds: ['A-4'] },
  ];
  const updates = removeOrdersFromOtherPlans(existing, 'd1', ['A-1', 'A-2', 'A-4']);
  for (const update of updates) {
    const { error } = update.orderIds.length
      ? await store.updateRoutePlanOrders(update.driverId, '2026-10-21', update.orderIds, '2026-10-21T08:00:00.000Z')
      : await store.deleteRoutePlan(update.driverId, '2026-10-21');
    assert.equal(error, null);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, 'update driver_route_plans set order_ids = $1::jsonb, updated_at = $2 where driver_id = $3 and plan_date = $4');
  assert.deepEqual(calls[0].values, ['["A-3"]', '2026-10-21T08:00:00.000Z', 'd2', '2026-10-21']);
  assert.equal(calls[1].text, 'delete from driver_route_plans where driver_id = $1 and plan_date = $2 returning driver_id');
  assert.deepEqual(calls[1].values, ['d3', '2026-10-21']);
  assert.deepEqual(await store.deleteRoutePlan('d3', '2026-10-21'), { data: [{ driver_id: 'd3' }], error: null });
});

test('postgres store calls next_invoice_number() and inserts invoices with numeric columns as numbers', async () => {
  const { calls, query } = fakeQuery((config) => {
    if (config.text.includes('next_invoice_number')) return { rows: [{ invoice_number: 'INV-2026-000042' }], rowCount: 1 };
    return {
      rows: [{ id: 'i1', invoice_number: 'INV-2026-000042', items: [{ name: 'Water' }], total_incl_vat: '105.00', vat_amount: '5.00', subtotal_excl_vat: '100.00', amount_paid: '105.00', issued_at: new Date('2026-10-21T09:00:00.000Z') }],
      rowCount: 1,
    };
  });
  const store = createPostgresStore({ query });
  assert.deepEqual(await store.nextInvoiceNumber(), { data: 'INV-2026-000042', error: null });
  assert.equal(calls[0].text, 'select next_invoice_number() as invoice_number');

  const { data, error } = await store.insertInvoice({
    invoice_number: 'INV-2026-000042', order_id: 'W-1', order_source: 'website', driver_id: 'd1', items: [{ name: 'Water' }],
    subtotal_excl_vat: 100, vat_amount: 5, total_incl_vat: 105, currency: 'AED', payment_method: 'cash', amount_paid: 105, issued_at: '2026-10-21T09:00:00.000Z',
  });
  assert.equal(error, null);
  assert.equal(data.total_incl_vat, 105);
  assert.equal(data.vat_amount, 5);
  assert.equal(data.issued_at, '2026-10-21T09:00:00.000Z');
  assert.match(calls[1].text, /^insert into invoices \(invoice_number, order_id, order_source, driver_id, items,/);
  assert.match(calls[1].text, /returning id, invoice_number/);
  assert.equal(calls[1].values[4], '[{"name":"Water"}]', 'jsonb is sent as JSON text');
});

test('postgres store returns database errors instead of throwing, so graceful degradation still works', async () => {
  const missingTable = createPostgresStore({ query: fakeQuery(() => pgError('42P01', 'relation "invoices" does not exist')).query });
  const tableResult = await missingTable.listInvoices({ start: 'a', end: 'b' });
  assert.equal(tableResult.data, null);
  assert.equal(isMissingTableError(tableResult.error), true);

  const missingFunction = createPostgresStore({ query: fakeQuery(() => pgError('42883', 'function next_invoice_number() does not exist')).query });
  const fnResult = await missingFunction.nextInvoiceNumber();
  assert.equal(fnResult.data, null);
  assert.equal(isMissingFunctionError(fnResult.error), true);

  const missingColumn = createPostgresStore({ query: fakeQuery(() => pgError('42703', 'column "client_request_id" of relation "delivery_attempts" does not exist')).query });
  const columnResult = await missingColumn.insertDeliveryAttempt({ order_id: 'A-1', driver_id: 'd1', outcome: 'FAILED', client_request_id: 'k1' });
  assert.equal(isMissingColumnError(columnResult.error, 'client_request_id'), true);

  const noRow = createPostgresStore({ query: fakeQuery(() => ({ rows: [], rowCount: 0 })).query });
  const pdfResult = await noRow.setInvoicePdf('i-missing', 'delivery-invoices', '2026/x.pdf');
  assert.equal(pdfResult.data, null);
  assert.ok(pdfResult.error);
  assert.deepEqual(await noRow.findInvoiceById('i-missing'), { data: null, error: null });
});

test('postgres store reports an idempotent attempt replay as 23505 and finds the original by key', async () => {
  const original = { id: 'a1', order_id: 'A-1', driver_id: 'd1', outcome: 'FAILED', reason_code: 'CUSTOMER_ABSENT', cash_collected: '0.00', card_amount: '0.00', attempted_at: new Date('2026-10-21T07:00:00.000Z') };
  let inserted = false;
  const { calls, query } = fakeQuery((config) => {
    if (config.text.startsWith('insert into delivery_attempts')) {
      if (inserted) return pgError('23505', 'duplicate key value violates unique constraint "delivery_attempts_driver_request_idx"');
      inserted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [original], rowCount: 1 };
  });
  const store = createPostgresStore({ query });
  const row = {
    order_id: 'A-1', order_source: 'website', driver_id: 'd1', outcome: 'FAILED', reason_code: 'CUSTOMER_ABSENT', note: null,
    cash_collected: 0, card_amount: 0, empty_bottles_returned: 0, attempted_at: '2026-10-21T07:00:00.000Z', client_request_id: 'key-1', unknown_column: 'ignored',
  };
  assert.deepEqual(await store.insertDeliveryAttempt(row), { data: null, error: null });
  const replay = await store.insertDeliveryAttempt(row);
  assert.equal(isUniqueViolationError(replay.error), true);
  assert.doesNotMatch(calls[0].text, /unknown_column/);
  assert.match(calls[0].text, /client_request_id\) values \(\$1, /);
  assert.equal(calls[0].values.at(-1), 'key-1');

  const { data } = await store.findDeliveryAttemptByKey('d1', 'key-1');
  assert.equal(data.id, 'a1');
  assert.equal(data.cash_collected, 0);
  assert.equal(data.attempted_at, '2026-10-21T07:00:00.000Z');
  const lookup = calls.at(-1);
  assert.match(lookup.text, /where driver_id = \$1 and client_request_id = \$2 order by attempted_at asc limit 1$/);
  assert.deepEqual(lookup.values, ['d1', 'key-1']);
});

test('postgres store builds attempt / session queries with optional filters and timeouts', async () => {
  const { calls, query } = fakeQuery(() => ({ rows: [], rowCount: 0 }));
  const store = createPostgresStore({ query });
  await store.listDeliveryAttempts({ start: 's', end: 'e', driverId: 'd1', outcome: 'FAILED', withKey: true });
  assert.match(calls[0].text, /attempted_at, client_request_id from delivery_attempts where attempted_at >= \$1 and attempted_at < \$2 and driver_id = \$3 and outcome = \$4 order by attempted_at asc limit 2000$/);
  assert.deepEqual(calls[0].values, ['s', 'e', 'd1', 'FAILED']);
  await store.listDeliveryAttempts({ start: 's', end: 'e', outcome: 'DELIVERED', withKey: false });
  assert.doesNotMatch(calls[1].text, /client_request_id/);
  assert.deepEqual(calls[1].values, ['s', 'e', 'DELIVERED']);

  await store.loadDriverSessions(['d1', 'd2'], { timeoutMs: 2500 });
  assert.equal(calls[2].query_timeout, 2500);
  assert.deepEqual(calls[2].values, [['d1', 'd2']]);

  await store.upsertDriverSession('d1', { gps_sharing: false, last_latitude: null, updated_at: 'now', bogus: 1 });
  assert.equal(calls[3].text, 'insert into driver_sessions (driver_id, gps_sharing, last_latitude, updated_at) values ($1, $2, $3, $4) on conflict (driver_id) do update set gps_sharing = excluded.gps_sharing, last_latitude = excluded.last_latitude, updated_at = excluded.updated_at');
  assert.deepEqual(calls[3].values, ['d1', false, null, 'now']);
});

test('normalizeRow converts Dates and numeric strings only', () => {
  assert.deepEqual(normalizeRow({ a: new Date('2026-01-01T00:00:00.000Z'), amount_paid: '12.50', note: '12.50', lat: 25.1, n: null }), {
    a: '2026-01-01T00:00:00.000Z', amount_paid: 12.5, note: '12.50', lat: 25.1, n: null,
  });
});
