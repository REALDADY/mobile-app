// Pure aggregation of a driver's day: day journal (driver-report-service) plus, optionally,
// delivery_attempts rows. The journal is the primary source; attempt rows only fill in stops
// that are missing from the journal (e.g. a journal write failed).

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Journal entries written before payment methods existed only carry cashCollected.
function deliveryPaymentMethod(delivery) {
  const method = String(delivery.paymentMethod || '').toLowerCase();
  if (['cash', 'card', 'prepaid'].includes(method)) return method;
  return Number(delivery.cashCollected || 0) > 0 ? 'cash' : 'prepaid';
}

function attemptToDelivery(attempt) {
  return {
    orderId: String(attempt.order_id),
    orderNumber: String(attempt.order_id),
    completedAt: attempt.attempted_at,
    paymentMethod: attempt.payment_method,
    cashCollected: Number(attempt.cash_collected || 0),
    cardAmount: Number(attempt.card_amount || 0),
    emptyBottlesReturned: Number(attempt.empty_bottles_returned || 0),
    amountDue: null,
    itemsQuantity: null,
    invoiceNumber: null,
  };
}

function attemptToFailure(attempt) {
  return {
    orderId: String(attempt.order_id),
    orderNumber: String(attempt.order_id),
    status: 'FAILED',
    reasonCode: attempt.reason_code || 'OTHER',
    note: attempt.note || '',
    attemptedAt: attempt.attempted_at,
  };
}

function computeDaySummary({ journal = {}, attempts = [] } = {}) {
  const deliveries = new Map();
  (journal.deliveries || []).forEach((delivery) => {
    if (delivery?.orderId) deliveries.set(String(delivery.orderId), delivery);
  });
  const failures = new Map();
  (journal.exceptions || []).filter((exception) => exception?.status === 'FAILED' && exception.orderId)
    .forEach((failure) => failures.set(String(failure.orderId), failure));

  (attempts || []).forEach((attempt) => {
    const orderId = String(attempt?.order_id || '');
    if (!orderId) return;
    const outcome = String(attempt.outcome || '').toUpperCase();
    if (outcome === 'DELIVERED' && !deliveries.has(orderId)) deliveries.set(orderId, attemptToDelivery(attempt));
    if (outcome === 'FAILED' && !failures.has(orderId)) failures.set(orderId, attemptToFailure(attempt));
  });

  // A stop that failed earlier and was delivered later counts as delivered only.
  const failedStops = [...failures.values()]
    .filter((failure) => !deliveries.has(String(failure.orderId)))
    .sort((a, b) => String(a.attemptedAt || '').localeCompare(String(b.attemptedAt || '')))
    .map((failure) => ({
      orderId: String(failure.orderId),
      orderNumber: String(failure.orderNumber || failure.orderId),
      customerName: failure.customerName || null,
      address: failure.address || null,
      reasonCode: failure.reasonCode || 'OTHER',
      reasonLabel: failure.reasonLabel || null,
      note: failure.failureNote ?? failure.note ?? '',
      attemptedAt: failure.attemptedAt || null,
    }));
  const failedByReason = {};
  failedStops.forEach((failure) => {
    failedByReason[failure.reasonCode] = (failedByReason[failure.reasonCode] || 0) + 1;
  });

  let cashExpected = 0;
  let cashCollected = 0;
  let cardTotal = 0;
  let cashCount = 0;
  let cardCount = 0;
  let prepaidCount = 0;
  let bottlesDelivered = 0;
  let emptiesReturned = 0;
  let invoicesIssued = 0;
  let stopsWithUnknownDue = 0;
  let stopsWithUnknownItems = 0;

  deliveries.forEach((delivery) => {
    const method = deliveryPaymentMethod(delivery);
    const amountDue = finiteOrNull(delivery.amountDue);
    cashCollected += Number(delivery.cashCollected || 0);
    if (method === 'cash') {
      cashCount += 1;
      if (amountDue == null) stopsWithUnknownDue += 1;
      else cashExpected += amountDue;
    } else if (method === 'card') {
      cardCount += 1;
      cardTotal += Number(delivery.cardAmount || 0);
    } else {
      prepaidCount += 1;
    }
    const itemsQuantity = finiteOrNull(delivery.itemsQuantity);
    if (itemsQuantity == null) stopsWithUnknownItems += 1;
    else bottlesDelivered += itemsQuantity;
    emptiesReturned += Number(delivery.emptyBottlesReturned || 0);
    if (delivery.invoiceNumber) invoicesIssued += 1;
  });

  return {
    date: journal.date || null,
    driverId: journal.driverId || null,
    driverName: journal.driverName || null,
    currency: 'AED',
    deliveriesCompleted: deliveries.size,
    failedDeliveries: failedStops.length,
    failedByReason,
    failedStops,
    cashExpected: money(cashExpected),
    cashCollected: money(cashCollected),
    cashDifference: money(cashCollected - cashExpected),
    cashCount,
    cardTotal: money(cardTotal),
    cardCount,
    prepaidCount,
    bottlesDelivered,
    emptiesReturned,
    invoicesIssued,
    stopsWithUnknownDue,
    stopsWithUnknownItems,
  };
}

module.exports = { computeDaySummary };
