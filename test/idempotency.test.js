const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  isMissingColumnError,
  isUniqueViolationError,
  parseIdempotencyKey,
} = require('../src/delivery-record-service');
const { computeDaySummary, dedupeDeliveryAttempts } = require('../src/day-summary-service');
const { createDriverReportService, upsertJournalDelivery, upsertJournalFailure } = require('../src/driver-report-service');

function memoryStorage() {
  const objects = new Map();
  const uploads = [];
  return {
    objects,
    uploads,
    storage: {
      async getBucket() { return { data: { id: 'test' }, error: null }; },
      async createBucket() { return { data: {}, error: null }; },
      from() {
        return {
          async download(objectPath) {
            if (!objects.has(objectPath)) return { data: null, error: { message: 'Not found' } };
            return { data: new Blob([objects.get(objectPath)]), error: null };
          },
          async upload(objectPath, value) {
            uploads.push(objectPath);
            objects.set(objectPath, Buffer.from(value));
            return { data: { path: objectPath }, error: null };
          },
        };
      },
    },
  };
}

test('a missing or empty Idempotency-Key means no key (app v1.0.0)', () => {
  assert.deepEqual(parseIdempotencyKey(undefined), { key: null });
  assert.deepEqual(parseIdempotencyKey(''), { key: null });
});

test('valid Idempotency-Keys are accepted unchanged', () => {
  const keys = [
    'mfz1abc-3k9x2q1p',
    // The random key lib/http.ts has always attached to POSTs.
    '1729500000000-0.123456789',
    '1729500000000-1.5e-7',
    'a.b_c:d-E',
    'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH),
  ];
  for (const key of keys) assert.deepEqual(parseIdempotencyKey(key), { key });
});

test('malformed Idempotency-Keys are rejected', () => {
  const keys = ['x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1), 'has space', 'a, b', 'slash/key', 'ü', ' ', ['a', 'b']];
  for (const key of keys) {
    assert.equal(parseIdempotencyKey(key).code, 'INVALID_IDEMPOTENCY_KEY', JSON.stringify(key));
  }
});

test('missing client_request_id column errors are recognised', () => {
  const column = 'client_request_id';
  assert.equal(isMissingColumnError({ code: '42703', message: 'column delivery_attempts.client_request_id does not exist' }, column), true);
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'client_request_id' column of 'delivery_attempts' in the schema cache" }, column), true);
  assert.equal(isMissingColumnError({ code: '42703', message: 'column delivery_attempts.other does not exist' }, column), false);
  assert.equal(isMissingColumnError({ code: 'PGRST205', message: "Could not find the table 'public.delivery_attempts' in the schema cache" }, column), false);
  assert.equal(isMissingColumnError(null, column), false);
});

test('unique violations are recognised', () => {
  assert.equal(isUniqueViolationError({ code: '23505' }), true);
  assert.equal(isUniqueViolationError({ code: '23503' }), false);
  assert.equal(isUniqueViolationError(null), false);
});

function attempt(extra) {
  return {
    driver_id: 'driver-1',
    order_id: 'ORDER-1',
    outcome: 'FAILED',
    reason_code: 'WRONG_ADDRESS',
    attempted_at: '2026-10-21T07:00:00Z',
    ...extra,
  };
}

test('attempt rows with the same driver, order, outcome and key collapse to the first', () => {
  const rows = [
    attempt({ id: 1, client_request_id: 'k1' }),
    attempt({ id: 2, client_request_id: 'k1', attempted_at: '2026-10-21T07:05:00Z' }),
    attempt({ id: 3, client_request_id: 'k2' }),
    attempt({ id: 4, client_request_id: 'k1', order_id: 'ORDER-2' }),
    attempt({ id: 5, client_request_id: 'k1', driver_id: 'driver-2' }),
    attempt({ id: 6, client_request_id: 'k1', outcome: 'DELIVERED' }),
    attempt({ id: 7 }),
    attempt({ id: 8 }),
    attempt({ id: 9, client_request_id: null }),
  ];
  assert.deepEqual(dedupeDeliveryAttempts(rows).map((row) => row.id), [1, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(dedupeDeliveryAttempts(undefined), []);
});

test('a replayed failure counts once in the day summary', () => {
  const summary = computeDaySummary({
    journal: { deliveries: [], exceptions: [] },
    attempts: [
      attempt({ client_request_id: 'k1' }),
      attempt({ client_request_id: 'k1', reason_code: 'OTHER', attempted_at: '2026-10-21T07:05:00Z' }),
    ],
  });
  assert.equal(summary.failedDeliveries, 1);
  assert.deepEqual(summary.failedByReason, { WRONG_ADDRESS: 1 });
  assert.equal(summary.failedStops[0].attemptedAt, '2026-10-21T07:00:00Z');
});

test('a journal failure with the same order and key is not written again', () => {
  const journal = { exceptions: [] };
  const original = { orderId: 'ORDER-1', status: 'FAILED', reasonCode: 'WRONG_ADDRESS', attemptedAt: '07:00', requestKey: 'k1' };
  assert.equal(upsertJournalFailure(journal, original), true);
  assert.equal(upsertJournalFailure(journal, { ...original, attemptedAt: '07:05' }), false);
  assert.deepEqual(journal.exceptions, [original]);
});

test('journal failures without a matching key keep one entry per order, newest wins', () => {
  const journal = { exceptions: [{ status: 'NOTE', orderId: 'ORDER-1', note: 'Gate closed' }] };
  upsertJournalFailure(journal, { orderId: 'ORDER-1', status: 'FAILED', attemptedAt: '07:00', requestKey: 'k1' });
  assert.equal(upsertJournalFailure(journal, { orderId: 'ORDER-1', status: 'FAILED', attemptedAt: '08:00', requestKey: 'k2' }), true);
  assert.equal(upsertJournalFailure(journal, { orderId: 'ORDER-1', status: 'FAILED', attemptedAt: '09:00' }), true);
  assert.equal(upsertJournalFailure(journal, { orderId: 'ORDER-2', status: 'FAILED', attemptedAt: '09:30', requestKey: 'k1' }), true);
  assert.deepEqual(journal.exceptions.map((item) => [item.status, item.orderId, item.attemptedAt || null]), [
    ['NOTE', 'ORDER-1', null],
    ['FAILED', 'ORDER-1', '09:00'],
    ['FAILED', 'ORDER-2', '09:30'],
  ]);
});

test('a journal delivery with the same order and key is not written again', () => {
  const journal = {};
  const original = { orderId: 'ORDER-1', completedAt: '07:00', cashCollected: 10, requestKey: 'k1' };
  assert.equal(upsertJournalDelivery(journal, original), true);
  assert.equal(upsertJournalDelivery(journal, { ...original, completedAt: '07:05', cashCollected: 20 }), false);
  assert.deepEqual(journal.deliveries, [original]);
});

test('journal deliveries without a matching key replace the order entry', () => {
  const journal = { deliveries: [{ orderId: 'ORDER-1', completedAt: '07:00' }] };
  assert.equal(upsertJournalDelivery(journal, { orderId: 'ORDER-1', completedAt: '07:05' }), true);
  assert.equal(upsertJournalDelivery(journal, { orderId: 'ORDER-1', completedAt: '07:10', requestKey: 'k1' }), true);
  assert.equal(upsertJournalDelivery(journal, { orderId: 'ORDER-2', completedAt: '07:20', requestKey: 'k1' }), true);
  assert.deepEqual(journal.deliveries.map((item) => [item.orderId, item.completedAt]), [
    ['ORDER-1', '07:10'],
    ['ORDER-2', '07:20'],
  ]);
});

test('replayed keyed completions and failures leave the journal and day report unchanged', async () => {
  const { storage, uploads } = memoryStorage();
  const service = createDriverReportService({ supabase: { storage }, apiBaseUrl: 'http://localhost', signingSecret: 's', bucket: 'b' });
  const driver = { id: 'driver-3', name: 'Driver 3' };
  const date = '2026-10-21';
  const completion = { completedAt: `${date}T05:00:00.000Z`, paymentMethod: 'cash', cashCollected: 10, amountDue: 10, requestKey: 'complete-1' };
  const failure = { attemptedAt: `${date}T06:00:00.000Z`, reasonCode: 'WRONG_ADDRESS', reasonLabel: 'Wrong address', requestKey: 'fail-1' };

  await service.recordCompletion(driver, { orderId: 'ORD-0001' }, completion);
  await service.recordFailure(driver, { orderId: 'ORD-0002' }, failure);
  const before = await service.readJournal(driver, date);
  const writes = uploads.length;

  await service.recordCompletion(driver, { orderId: 'ORD-0001' }, { ...completion, completedAt: `${date}T05:10:00.000Z` });
  await service.recordFailure(driver, { orderId: 'ORD-0002' }, { ...failure, attemptedAt: `${date}T06:10:00.000Z` });
  assert.equal(uploads.length, writes);
  assert.deepEqual(await service.readJournal(driver, date), before);

  const report = await service.generateReport(driver, date);
  assert.equal(report.completedDeliveries, 1);
  assert.equal(report.failedDeliveries, 1);
  assert.equal(report.cashCollected, 10);
});
