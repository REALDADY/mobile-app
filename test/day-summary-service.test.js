const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDaySummary } = require('../src/day-summary-service');
const { createDriverReportService } = require('../src/driver-report-service');

function journal(extra = {}) {
  return {
    driverId: 'driver-1',
    driverName: 'Driver 1',
    date: '2026-10-20',
    deliveries: [
      { orderId: 'A', paymentMethod: 'cash', amountDue: 52.5, cashCollected: 60, itemsQuantity: 3, emptyBottlesReturned: 2, invoiceNumber: 'INV-2026-000001' },
      { orderId: 'B', paymentMethod: 'cash', amountDue: 20, cashCollected: 15, itemsQuantity: 1, emptyBottlesReturned: 0, invoiceNumber: 'INV-2026-000002' },
      { orderId: 'C', paymentMethod: 'card', amountDue: 0, cashCollected: 0, cardAmount: 31.5, itemsQuantity: 2, emptyBottlesReturned: 1 },
      { orderId: 'D', paymentMethod: 'prepaid', amountDue: 0, cashCollected: 0, itemsQuantity: null, emptyBottlesReturned: 1 },
    ],
    exceptions: [
      { orderId: 'E', status: 'FAILED', reasonCode: 'CUSTOMER_NOT_AVAILABLE', failureNote: '', attemptedAt: '2026-10-20T07:00:00Z' },
      { orderId: 'F', status: 'FAILED', reasonCode: 'CUSTOMER_NOT_AVAILABLE', failureNote: 'No answer', attemptedAt: '2026-10-20T08:00:00Z' },
      { orderId: 'G', status: 'FAILED', reasonCode: 'WRONG_ADDRESS', attemptedAt: '2026-10-20T09:00:00Z' },
      { orderId: 'A', status: 'FAILED', reasonCode: 'ACCESS_PROBLEM', attemptedAt: '2026-10-20T05:00:00Z' },
      { orderId: 'X', status: 'NOT COMPLETED', note: 'still open' },
    ],
    ...extra,
  };
}

test('aggregates cash expected vs collected, card, prepaid and bottles', () => {
  const summary = computeDaySummary({ journal: journal() });
  assert.equal(summary.deliveriesCompleted, 4);
  assert.equal(summary.cashExpected, 72.5);
  assert.equal(summary.cashCollected, 75);
  assert.equal(summary.cashDifference, 2.5);
  assert.equal(summary.cashCount, 2);
  assert.equal(summary.cardTotal, 31.5);
  assert.equal(summary.cardCount, 1);
  assert.equal(summary.prepaidCount, 1);
  assert.equal(summary.bottlesDelivered, 6);
  assert.equal(summary.stopsWithUnknownItems, 1);
  assert.equal(summary.emptiesReturned, 4);
  assert.equal(summary.invoicesIssued, 2);
  assert.equal(summary.currency, 'AED');
});

test('counts failures by reason, ignoring stops delivered later', () => {
  const summary = computeDaySummary({ journal: journal() });
  assert.equal(summary.failedDeliveries, 3);
  assert.deepEqual(summary.failedByReason, { CUSTOMER_NOT_AVAILABLE: 2, WRONG_ADDRESS: 1 });
  assert.deepEqual(summary.failedStops.map((stop) => stop.orderId), ['E', 'F', 'G']);
  assert.equal(summary.failedStops[1].note, 'No answer');
});

test('legacy journal entries without payment method count as cash with unknown due', () => {
  const summary = computeDaySummary({ journal: { deliveries: [
    { orderId: 'A', cashCollected: 525 },
    { orderId: 'B', cashCollected: 0 },
  ], exceptions: [] } });
  assert.equal(summary.cashCount, 1);
  assert.equal(summary.prepaidCount, 1);
  assert.equal(summary.cashExpected, 0);
  assert.equal(summary.cashCollected, 525);
  assert.equal(summary.stopsWithUnknownDue, 1);
});

test('delivery_attempts rows fill in stops missing from the journal', () => {
  const summary = computeDaySummary({
    journal: { deliveries: [{ orderId: 'A', paymentMethod: 'cash', amountDue: 10, cashCollected: 10 }], exceptions: [] },
    attempts: [
      { order_id: 'A', outcome: 'DELIVERED', payment_method: 'cash', cash_collected: 10 },
      { order_id: 'B', outcome: 'DELIVERED', payment_method: 'card', card_amount: 25, empty_bottles_returned: 2 },
      { order_id: 'C', outcome: 'FAILED', reason_code: 'VEHICLE_ISSUE', attempted_at: '2026-10-20T10:00:00Z' },
    ],
  });
  assert.equal(summary.deliveriesCompleted, 2);
  assert.equal(summary.cashCollected, 10);
  assert.equal(summary.cardTotal, 25);
  assert.equal(summary.emptiesReturned, 2);
  assert.deepEqual(summary.failedByReason, { VEHICLE_ISSUE: 1 });
});

test('empty day', () => {
  const summary = computeDaySummary();
  assert.equal(summary.deliveriesCompleted, 0);
  assert.equal(summary.failedDeliveries, 0);
  assert.equal(summary.cashDifference, 0);
});

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
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
            objects.set(objectPath, Buffer.from(value));
            return { data: { path: objectPath }, error: null };
          },
        };
      },
    },
  };
}

test('day report records payments and failures and renders the PDF', async () => {
  const { storage, objects } = memoryStorage();
  const service = createDriverReportService({ supabase: { storage }, apiBaseUrl: 'http://localhost', signingSecret: 's', bucket: 'b' });
  const driver = { id: '00000000-0000-4000-8000-000000000001', name: 'Driver 1' };
  const date = '2026-10-20';
  const stops = [
    { orderId: 'ORD-0001', customerName: 'A Customer', address: 'Villa 1', routeSequence: 1 },
    { orderId: 'ORD-0002', customerName: 'B Customer', address: 'Villa 2', routeSequence: 2 },
    { orderId: 'ORD-0003', customerName: 'C Customer', address: 'Villa 3', routeSequence: 3 },
  ];
  await service.recordAssignments(driver, stops, `${date}T04:00:00.000Z`);
  await service.recordCompletion(driver, { orderId: 'ORD-0001' }, {
    completedAt: `${date}T05:00:00.000Z`,
    cashCollected: 52.5,
    paymentMethod: 'cash',
    amountDue: 52.5,
    itemsQuantity: 3,
    emptyBottlesReturned: 2,
    invoiceNumber: 'INV-2026-000001',
  });
  await service.recordFailure(driver, { orderId: 'ORD-0002' }, {
    attemptedAt: `${date}T06:00:00.000Z`,
    reasonCode: 'CUSTOMER_NOT_AVAILABLE',
    reasonLabel: 'Customer not available',
    note: 'No answer at the door',
  });

  const stored = await service.readJournal(driver, date);
  assert.equal(stored.deliveries[0].customerName, 'A Customer');
  assert.equal(stored.deliveries[0].routeSequence, 1);
  assert.equal(stored.deliveries[0].invoiceNumber, 'INV-2026-000001');
  assert.equal(stored.exceptions.length, 1);
  assert.equal(stored.exceptions[0].customerName, 'B Customer');

  const report = await service.generateReport(driver, date);
  assert.equal(report.completedDeliveries, 1);
  assert.equal(report.failedDeliveries, 1);
  assert.equal(report.cashExpected, 52.5);
  assert.equal(report.cashCollected, 52.5);
  // ORD-0003 is still open; ORD-0002 is listed as failed, not also as "not completed".
  assert.equal(report.exceptions, 2);
  const pdf = objects.get(`reports/${driver.id}/${date}.pdf`);
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
});

test('a day with only failed stops can still be reported', async () => {
  const { storage } = memoryStorage();
  const service = createDriverReportService({ supabase: { storage }, apiBaseUrl: 'http://localhost', signingSecret: 's', bucket: 'b' });
  const driver = { id: 'driver-2', name: 'Driver 2' };
  await assert.rejects(service.generateReport(driver, '2026-10-20'), { statusCode: 409 });
  await service.recordFailure(driver, { orderId: 'ORD-0009' }, { attemptedAt: '2026-10-20T06:00:00.000Z', reasonCode: 'VEHICLE_ISSUE' });
  const report = await service.generateReport(driver, '2026-10-20');
  assert.equal(report.failedDeliveries, 1);
});
