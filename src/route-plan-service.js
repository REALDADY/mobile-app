// Pure helpers for dispatch route plans. No Supabase or network access here so the
// merge rules can be unit-tested; server.js does the loading and persistence.

const UAE_TIME_ZONE = 'Asia/Dubai';
const ROUTE_PLAN_MAX_ORDERS = 200;
const ROUTE_PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNDELIVERABLE_STATUSES = new Set(['DELIVERED', 'CANCELLED', 'CANCELED', 'COMPLETED']);

// Order ids are used verbatim: Supabase `orders.id` and the website feed `order.id`.
// Only stringify + trim so ids from JSON bodies, JSONB and feeds compare equal.
function normalizeOrderId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function stopOrderId(stop) {
  return normalizeOrderId(stop?.orderId ?? stop?.id);
}

function dubaiDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: UAE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidPlanDate(value) {
  if (typeof value !== 'string' || !ROUTE_PLAN_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Returns { date } or { error }. Missing dates default to today in Asia/Dubai.
function resolvePlanDate(value, now = new Date()) {
  if (value == null || value === '') return { date: dubaiDateKey(now) };
  const date = String(value).trim();
  if (!isValidPlanDate(date)) return { error: 'date must be a valid YYYY-MM-DD date' };
  return { date };
}

// Returns { orderIds } or { error }.
function validatePlanOrderIds(value) {
  if (!Array.isArray(value)) return { error: 'orderIds must be an array of order ids' };
  if (value.length > ROUTE_PLAN_MAX_ORDERS) {
    return { error: `orderIds may contain at most ${ROUTE_PLAN_MAX_ORDERS} orders` };
  }

  const orderIds = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') return { error: 'orderIds must only contain strings' };
    const orderId = normalizeOrderId(entry);
    if (!orderId) return { error: 'orderIds must not contain empty values' };
    if (orderId.length > 120) return { error: 'orderIds contains an order id that is too long' };
    if (seen.has(orderId)) return { error: `Duplicate order id in plan: ${orderId}` };
    seen.add(orderId);
    orderIds.push(orderId);
  }
  return { orderIds };
}

function isMissingTableError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  const message = String(error.message || '');
  return /relation .* does not exist/i.test(message) || /could not find the table/i.test(message);
}

// Given every plan for a date, work out which other drivers' plans must lose the
// orders now planned for `driverId`. Returns [{ driverId, orderIds, removedOrderIds }].
function removeOrdersFromOtherPlans(plans, driverId, orderIds) {
  const claimed = new Set(orderIds.map(normalizeOrderId));
  return (plans || []).flatMap((plan) => {
    if (!plan || plan.driverId === driverId) return [];
    const current = (plan.orderIds || []).map(normalizeOrderId);
    const removedOrderIds = current.filter((orderId) => claimed.has(orderId));
    if (!removedOrderIds.length) return [];
    return [{
      driverId: plan.driverId,
      orderIds: current.filter((orderId) => !claimed.has(orderId)),
      removedOrderIds,
    }];
  });
}

function isDeliverableStop(stop) {
  if (!stop) return false;
  const statuses = [stop.orderStatus, stop.status].map((status) => String(status || '').toUpperCase());
  return !statuses.some((status) => UNDELIVERABLE_STATUSES.has(status));
}

// Builds the final stop list for one driver.
// - plans: every plan for the day, [{ driverId, orderIds }]
// - automaticStops: the stops the driver would get without plans, already in automatic order
// - candidateStops: every active stop known to the backend (used to resolve planned ids
//   that are not part of this driver's automatic list)
// Planned stops come first in plan order (never re-sequenced); remaining automatic stops
// follow, minus anything planned for this or another driver.
function buildDriverRoute({ driverId, plans = [], automaticStops = [], candidateStops = [] }) {
  const ownPlan = plans.find((plan) => plan && plan.driverId === driverId);
  const ownPlannedIds = (ownPlan?.orderIds || []).map(normalizeOrderId).filter(Boolean);
  const otherPlannedIds = new Set(plans
    .filter((plan) => plan && plan.driverId !== driverId)
    .flatMap((plan) => (plan.orderIds || []).map(normalizeOrderId)));

  const stopsById = new Map();
  candidateStops.forEach((stop) => {
    const orderId = stopOrderId(stop);
    if (orderId) stopsById.set(orderId, stop);
  });
  automaticStops.forEach((stop) => {
    const orderId = stopOrderId(stop);
    if (orderId) stopsById.set(orderId, { ...stopsById.get(orderId), ...stop });
  });

  const plannedIds = new Set();
  const plannedStops = [];
  ownPlannedIds.forEach((orderId) => {
    if (plannedIds.has(orderId)) return;
    const stop = stopsById.get(orderId);
    if (!isDeliverableStop(stop)) return;
    plannedIds.add(orderId);
    plannedStops.push({ ...stop, planned: true });
  });

  // Own planned ids that were skipped as undeliverable stay out of the automatic list too.
  const excludedIds = new Set([...ownPlannedIds, ...otherPlannedIds]);
  const automatic = automaticStops
    .filter((stop) => !excludedIds.has(stopOrderId(stop)))
    .map((stop) => ({ ...stop, planned: false }));

  const routeSource = plannedStops.length ? 'dispatch-plan' : 'automatic';
  const stops = [...plannedStops, ...automatic].map((stop, index) => ({
    ...stop,
    sequence: index + 1,
    routeSequence: index + 1,
  }));
  return { stops, routeSource };
}

module.exports = {
  ROUTE_PLAN_MAX_ORDERS,
  UAE_TIME_ZONE,
  buildDriverRoute,
  dubaiDateKey,
  isDeliverableStop,
  isMissingTableError,
  isValidPlanDate,
  normalizeOrderId,
  removeOrdersFromOtherPlans,
  resolvePlanDate,
  validatePlanOrderIds,
};
