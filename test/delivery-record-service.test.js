const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FAILURE_REASONS,
  MAX_SIGNATURE_BYTES,
  decodeSignature,
  dubaiDayRange,
  excludeFailedStops,
  isMissingFunctionError,
  parseCompletionPayment,
  resolveCompletionPayment,
  validateFailureRequest,
} = require('../src/delivery-record-service');

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('the old v1.0.0 body parses to defaults', () => {
  assert.deepEqual(parseCompletionPayment({ assignmentToken: 't', emptyBottlesReturned: 1, cashCollected: 10 }), {
    paymentMethod: undefined,
    cardAmount: 0,
    cardReference: null,
  });
});

test('payment fields are validated', () => {
  assert.equal(parseCompletionPayment({ paymentMethod: 'CARD' }).paymentMethod, 'card');
  assert.equal(parseCompletionPayment({ paymentMethod: 'wallet' }).code, 'INVALID_PAYMENT_METHOD');
  assert.equal(parseCompletionPayment({ cardAmount: -1 }).code, 'INVALID_CARD_AMOUNT');
  assert.equal(parseCompletionPayment({ cardAmount: 'abc' }).code, 'INVALID_CARD_AMOUNT');
  assert.equal(parseCompletionPayment({ cardReference: 'x'.repeat(65) }).code, 'INVALID_CARD_REFERENCE');
  assert.equal(parseCompletionPayment({ cardReference: { a: 1 } }).code, 'INVALID_CARD_REFERENCE');
  assert.equal(parseCompletionPayment({ cardReference: ` ${'x'.repeat(64)} ` }).cardReference.length, 64);
});

test('COD defaults to cash and keeps the existing cash rule and message', () => {
  const ok = resolveCompletionPayment({ isCod: true, amountDue: 52.5, cashCollected: 52.5, totalAmount: 52.5 });
  assert.deepEqual(ok, { paymentMethod: 'cash', amountPaid: 52.5, covered: true });
  const withinTolerance = resolveCompletionPayment({ isCod: true, amountDue: 52.5, cashCollected: 52.49 });
  assert.equal(withinTolerance.paymentMethod, 'cash');
  const short = resolveCompletionPayment({ isCod: true, amountDue: 52.5, cashCollected: 50 });
  assert.equal(short.error, 'Cash collected must cover the AED 52.50 amount due');
  assert.equal(short.code, 'PAYMENT_INSUFFICIENT');
});

test('non-COD defaults to prepaid without amount checks', () => {
  assert.deepEqual(resolveCompletionPayment({ isCod: false, amountDue: 0, cashCollected: 0, totalAmount: 30 }), {
    paymentMethod: 'prepaid',
    amountPaid: 30,
    covered: true,
  });
});

test('card must cover the amount due', () => {
  assert.equal(resolveCompletionPayment({ requestedMethod: 'card', isCod: true, amountDue: 40, cardAmount: 40 }).paymentMethod, 'card');
  assert.equal(resolveCompletionPayment({ requestedMethod: 'card', isCod: true, amountDue: 40, cardAmount: 39.99 }).covered, true);
  const short = resolveCompletionPayment({ requestedMethod: 'card', isCod: true, amountDue: 40, cardAmount: 30 });
  assert.equal(short.code, 'PAYMENT_INSUFFICIENT');
  assert.match(short.error, /Card amount must cover the AED 40\.00/);
  assert.equal(resolveCompletionPayment({ requestedMethod: 'card', isCod: true, amountDue: 40 }).code, 'PAYMENT_INSUFFICIENT');
});

test('split partial cash + card payments are rejected', () => {
  const split = resolveCompletionPayment({ requestedMethod: 'cash', isCod: true, amountDue: 40, cashCollected: 20, cardAmount: 20 });
  assert.equal(split.code, 'MIXED_PAYMENT_UNSUPPORTED');
  // One side covering the full amount is fine.
  assert.equal(resolveCompletionPayment({ requestedMethod: 'card', isCod: true, amountDue: 40, cashCollected: 5, cardAmount: 40 }).paymentMethod, 'card');
});

test('prepaid cannot be chosen while money is due', () => {
  assert.equal(resolveCompletionPayment({ requestedMethod: 'prepaid', isCod: true, amountDue: 10 }).code, 'PAYMENT_DUE');
});

test('enforce=false skips amount checks (website orders from app v1.0.0)', () => {
  assert.deepEqual(resolveCompletionPayment({ isCod: null, amountDue: 0, cashCollected: 12, enforce: false }), {
    paymentMethod: 'cash',
    amountPaid: 12,
    covered: true,
  });
  assert.equal(resolveCompletionPayment({ isCod: null, cashCollected: 0, enforce: false }).paymentMethod, 'prepaid');
  assert.equal(resolveCompletionPayment({ isCod: true, amountDue: 50, cashCollected: 1, enforce: false }).covered, false);
});

test('signatures: data URL or raw base64 PNG, size limit, type check', () => {
  const png = Buffer.concat([PNG_HEADER, Buffer.alloc(100, 1)]);
  const fromDataUrl = decodeSignature(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(fromDataUrl.mimeType, 'image/png');
  assert.equal(fromDataUrl.bytes.length, png.length);
  assert.equal(decodeSignature(png.toString('base64')).extension, 'png');
  assert.equal(decodeSignature({ base64: png.toString('base64') }).mimeType, 'image/png');
  assert.equal(decodeSignature(undefined), null);
  assert.equal(decodeSignature(''), null);
  assert.equal(decodeSignature(Buffer.from('hello world').toString('base64')).code, 'INVALID_SIGNATURE');
  assert.equal(decodeSignature('data:image/gif;base64,R0lGOD').code, 'INVALID_SIGNATURE');
  assert.equal(decodeSignature('not base64 !!').code, 'INVALID_SIGNATURE');
  assert.equal(decodeSignature(42).code, 'INVALID_SIGNATURE');
  const tooLarge = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_SIGNATURE_BYTES, 1)]);
  assert.equal(decodeSignature(tooLarge.toString('base64')).code, 'SIGNATURE_TOO_LARGE');
  const atLimit = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_SIGNATURE_BYTES - PNG_HEADER.length, 1)]);
  assert.equal(decodeSignature(atLimit.toString('base64')).bytes.length, MAX_SIGNATURE_BYTES);
});

test('failure reasons are validated and OTHER needs a note', () => {
  assert.deepEqual(Object.keys(FAILURE_REASONS), [
    'CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'CUSTOMER_REFUSED', 'PAYMENT_ISSUE', 'ACCESS_PROBLEM', 'VEHICLE_ISSUE', 'OTHER',
  ]);
  const ok = validateFailureRequest({ reasonCode: 'customer_not_available', latitude: '25.2', longitude: 55.3 });
  assert.equal(ok.reasonCode, 'CUSTOMER_NOT_AVAILABLE');
  assert.equal(ok.reasonLabel, 'Customer not available');
  assert.equal(ok.note, null);
  assert.equal(ok.latitude, 25.2);
  assert.equal(validateFailureRequest({ reasonCode: 'RESCHEDULED' }).code, 'INVALID_REASON_CODE');
  assert.equal(validateFailureRequest({}).code, 'INVALID_REASON_CODE');
  assert.equal(validateFailureRequest({ reasonCode: 'OTHER' }).code, 'NOTE_REQUIRED');
  assert.equal(validateFailureRequest({ reasonCode: 'OTHER', note: '   ' }).code, 'NOTE_REQUIRED');
  assert.equal(validateFailureRequest({ reasonCode: 'OTHER', note: 'Gate locked' }).note, 'Gate locked');
  assert.equal(validateFailureRequest({ reasonCode: 'OTHER', note: 'x'.repeat(501) }).code, 'INVALID_NOTE');
  assert.equal(validateFailureRequest({ reasonCode: 'WRONG_ADDRESS', latitude: 200, longitude: 1 }).code, 'INVALID_COORDINATES');
  assert.equal(validateFailureRequest({ reasonCode: 'WRONG_ADDRESS', latitude: 25 }).code, 'INVALID_COORDINATES');
});

test('dubaiDayRange is a UTC+4 calendar day', () => {
  assert.deepEqual(dubaiDayRange('2026-10-20'), { start: '2026-10-19T20:00:00.000Z', end: '2026-10-20T20:00:00.000Z' });
});

test('failed stops are removed unless the dispatcher re-planned them afterwards', () => {
  const stops = [
    { orderId: 'ORD-1', planned: true },
    { orderId: 'ORD-2', planned: false },
    { orderId: 'ORD-3', planned: true },
  ];
  const failures = [
    { orderId: 'ORD-1', attemptedAt: '2026-10-20T06:00:00Z' },
    { orderId: 'ORD-2', attemptedAt: '2026-10-20T06:00:00Z' },
  ];
  assert.deepEqual(excludeFailedStops(stops, failures, null).map((stop) => stop.orderId), ['ORD-3']);
  assert.deepEqual(excludeFailedStops(stops, failures, { updatedAt: '2026-10-20T05:00:00Z' }).map((stop) => stop.orderId), ['ORD-3']);
  assert.deepEqual(excludeFailedStops(stops, failures, { updatedAt: '2026-10-20T07:00:00Z' }).map((stop) => stop.orderId), ['ORD-1', 'ORD-3']);
  assert.equal(excludeFailedStops(stops, []), stops);
});

test('missing RPC functions are recognised', () => {
  assert.equal(isMissingFunctionError({ code: 'PGRST202' }), true);
  assert.equal(isMissingFunctionError({ code: '42883' }), true);
  assert.equal(isMissingFunctionError({ message: 'Could not find the function public.next_invoice_number without parameters' }), true);
  assert.equal(isMissingFunctionError({ code: '23505' }), false);
  assert.equal(isMissingFunctionError(null), false);
});
