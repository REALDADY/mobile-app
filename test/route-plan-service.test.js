const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUTE_PLAN_MAX_ORDERS,
  buildDriverRoute,
  dubaiDateKey,
  isMissingTableError,
  normalizeOrderId,
  removeOrdersFromOtherPlans,
  resolvePlanDate,
  validatePlanOrderIds,
} = require('../src/route-plan-service');

const DRIVER_A = '00000000-0000-4000-8000-000000000001';
const DRIVER_B = '00000000-0000-4000-8000-000000000002';

function stop(orderId, extra = {}) {
  return { id: orderId, orderId, orderNumber: orderId, status: 'ASSIGNED', source: 'operations', ...extra };
}

function ids(route) {
  return route.stops.map((entry) => entry.orderId);
}

test('keeps planned stops in plan order without re-sequencing', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['ORD-3', 'ORD-1', 'ORD-2'] }],
    automaticStops: [stop('ORD-1'), stop('ORD-2'), stop('ORD-3')],
  });
  assert.deepEqual(ids(route), ['ORD-3', 'ORD-1', 'ORD-2']);
  assert.equal(route.routeSource, 'dispatch-plan');
  assert.ok(route.stops.every((entry) => entry.planned === true));
});

test('resolves planned orders from the candidate pool even when not in the automatic list', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['web-123', 'ORD-9'] }],
    automaticStops: [],
    candidateStops: [stop('ORD-9'), stop('web-123', { source: 'website', orderStatus: 'confirmed' })],
  });
  assert.deepEqual(ids(route), ['web-123', 'ORD-9']);
  assert.equal(route.stops[0].source, 'website');
});

test('skips delivered, cancelled and unknown planned ids', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['ORD-1', 'web-done', 'web-cancel', 'ORD-missing', 'ORD-2'] }],
    automaticStops: [stop('ORD-2')],
    candidateStops: [
      stop('ORD-1'),
      stop('web-done', { source: 'website', orderStatus: 'delivered' }),
      stop('web-cancel', { source: 'website', orderStatus: 'CANCELLED' }),
    ],
  });
  assert.deepEqual(ids(route), ['ORD-1', 'ORD-2']);
});

test('undeliverable own planned ids do not reappear in the automatic part', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['web-done'] }],
    automaticStops: [stop('web-done', { orderStatus: 'DELIVERED' }), stop('ORD-5')],
  });
  assert.deepEqual(ids(route), ['ORD-5']);
  assert.equal(route.routeSource, 'automatic');
});

test('appends unplanned automatic stops after planned ones, in automatic order', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['ORD-4'] }],
    automaticStops: [stop('ORD-2'), stop('ORD-4'), stop('ORD-1'), stop('ORD-3')],
  });
  assert.deepEqual(ids(route), ['ORD-4', 'ORD-2', 'ORD-1', 'ORD-3']);
  assert.deepEqual(route.stops.map((entry) => entry.planned), [true, false, false, false]);
});

test("excludes orders in another driver's plan from the automatic list", () => {
  const plans = [
    { driverId: DRIVER_B, orderIds: ['ORD-2', 'web-7'] },
  ];
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans,
    automaticStops: [stop('ORD-1'), stop('ORD-2'), stop('web-7'), stop('ORD-3')],
  });
  assert.deepEqual(ids(route), ['ORD-1', 'ORD-3']);
  assert.equal(route.routeSource, 'automatic');
});

test('own plan wins over the other-driver exclusion for the same driver', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [
      { driverId: DRIVER_A, orderIds: ['ORD-2'] },
      { driverId: DRIVER_B, orderIds: ['ORD-1'] },
    ],
    automaticStops: [stop('ORD-1'), stop('ORD-2'), stop('ORD-3')],
  });
  assert.deepEqual(ids(route), ['ORD-2', 'ORD-3']);
});

test('assigns 1-based sequence and routeSequence over the final list', () => {
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: ['ORD-3', 'ORD-1'] }],
    automaticStops: [stop('ORD-1', { routeSequence: 1 }), stop('ORD-2', { routeSequence: 2 }), stop('ORD-3', { routeSequence: 3 })],
  });
  assert.deepEqual(route.stops.map((entry) => entry.sequence), [1, 2, 3]);
  assert.deepEqual(route.stops.map((entry) => entry.routeSequence), [1, 2, 3]);
  assert.deepEqual(ids(route), ['ORD-3', 'ORD-1', 'ORD-2']);
});

test('without any plan the automatic list is returned unchanged with planned=false', () => {
  const automaticStops = [stop('ORD-2'), stop('ORD-1')];
  const route = buildDriverRoute({ driverId: DRIVER_A, plans: [], automaticStops });
  assert.equal(route.routeSource, 'automatic');
  assert.deepEqual(ids(route), ['ORD-2', 'ORD-1']);
  assert.deepEqual(route.stops.map((entry) => entry.planned), [false, false]);
  assert.deepEqual(route.stops.map((entry) => entry.sequence), [1, 2]);
  assert.equal(automaticStops[0].planned, undefined, 'input stops are not mutated');
});

test('order ids are compared after String() + trim', () => {
  assert.equal(normalizeOrderId('  ORD-1 '), 'ORD-1');
  assert.equal(normalizeOrderId(42), '42');
  assert.equal(normalizeOrderId(null), '');
  const route = buildDriverRoute({
    driverId: DRIVER_A,
    plans: [{ driverId: DRIVER_A, orderIds: [' 42 '] }],
    automaticStops: [{ id: 42, orderId: 42, status: 'ASSIGNED' }],
  });
  assert.equal(route.stops.length, 1);
  assert.equal(route.stops[0].planned, true);
});

test('date defaults to today in Asia/Dubai using the injected clock', () => {
  // 21:30 UTC on 2026-10-20 is already 01:30 on 2026-10-21 in Dubai (UTC+4).
  const lateUtc = new Date('2026-10-20T21:30:00Z');
  assert.equal(dubaiDateKey(lateUtc), '2026-10-21');
  assert.deepEqual(resolvePlanDate(undefined, lateUtc), { date: '2026-10-21' });
  assert.deepEqual(resolvePlanDate('', lateUtc), { date: '2026-10-21' });

  const earlyUtc = new Date('2026-10-20T19:59:59Z');
  assert.deepEqual(resolvePlanDate(null, earlyUtc), { date: '2026-10-20' });
});

test('explicit plan dates are validated', () => {
  assert.deepEqual(resolvePlanDate('2026-10-25'), { date: '2026-10-25' });
  assert.ok(resolvePlanDate('2026-02-30').error);
  assert.ok(resolvePlanDate('20-10-2026').error);
  assert.ok(resolvePlanDate('2026-10-20T00:00:00Z').error);
});

test('validates plan order ids', () => {
  assert.deepEqual(validatePlanOrderIds(['ORD-1', ' web-2 ']), { orderIds: ['ORD-1', 'web-2'] });
  assert.deepEqual(validatePlanOrderIds([]), { orderIds: [] });
  assert.ok(validatePlanOrderIds('ORD-1').error);
  assert.ok(validatePlanOrderIds([1]).error);
  assert.ok(validatePlanOrderIds(['ORD-1', '  ']).error);
  assert.ok(validatePlanOrderIds(['ORD-1', 'ORD-1']).error);
  assert.ok(validatePlanOrderIds(['ORD-1', ' ORD-1']).error);
  const tooMany = Array.from({ length: ROUTE_PLAN_MAX_ORDERS + 1 }, (_, index) => `ORD-${index}`);
  assert.ok(validatePlanOrderIds(tooMany).error);
  assert.ok(validatePlanOrderIds(tooMany.slice(0, ROUTE_PLAN_MAX_ORDERS)).orderIds);
});

test("removes newly planned orders from other drivers' plans", () => {
  const updates = removeOrdersFromOtherPlans([
    { driverId: DRIVER_A, orderIds: ['ORD-1'] },
    { driverId: DRIVER_B, orderIds: ['ORD-1', 'ORD-2', 'ORD-3'] },
    { driverId: 'other', orderIds: ['ORD-9'] },
  ], DRIVER_A, ['ORD-3', 'ORD-1']);
  assert.deepEqual(updates, [
    { driverId: DRIVER_B, orderIds: ['ORD-2'], removedOrderIds: ['ORD-1', 'ORD-3'] },
  ]);
});

test('recognises PostgREST missing-table errors', () => {
  assert.equal(isMissingTableError({ code: '42P01', message: 'relation "public.driver_sessions" does not exist' }), true);
  assert.equal(isMissingTableError({ code: 'PGRST205', message: "Could not find the table 'public.driver_route_plans' in the schema cache" }), true);
  assert.equal(isMissingTableError({ message: 'relation "driver_route_plans" does not exist' }), true);
  assert.equal(isMissingTableError({ code: '42703', message: 'column driver_sessions.foo does not exist' }), false);
  assert.equal(isMissingTableError({ code: '23503', message: 'violates foreign key constraint' }), false);
  assert.equal(isMissingTableError(null), false);
});
