// Pure helpers for delivery completion / failure records (payment method, signature,
// failure reasons, day ranges). No Supabase or network access so the rules can be unit-tested;
// server.js does the loading and persistence.

const DELIVERY_PAYMENT_METHODS = ['cash', 'card', 'prepaid'];
const FAILURE_REASONS = {
  CUSTOMER_NOT_AVAILABLE: 'Customer not available',
  WRONG_ADDRESS: 'Wrong address',
  CUSTOMER_REFUSED: 'Customer refused',
  PAYMENT_ISSUE: 'Payment issue',
  ACCESS_PROBLEM: 'Access problem',
  VEHICLE_ISSUE: 'Vehicle issue',
  OTHER: 'Other',
};
const MAX_SIGNATURE_BYTES = 300 * 1024;
const MAX_CARD_REFERENCE_LENGTH = 64;
const MAX_FAILURE_NOTE_LENGTH = 500;
const MAX_AMOUNT = 100000;
const AMOUNT_TOLERANCE = 0.01;
const DUBAI_UTC_OFFSET = '+04:00';
const MAX_IDEMPOTENCY_KEY_LENGTH = 100;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]+$/;

function invalid(message, code) {
  return { error: message, code };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isMissingFunctionError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42883' || code === 'PGRST202') return true;
  return /could not find the function/i.test(String(error.message || ''));
}

function isMissingColumnError(error, column) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  if (column && !message.includes(column)) return false;
  if (code === '42703' || code === 'PGRST204') return true;
  return /column .* does not exist/i.test(message) || /could not find the .* column/i.test(message);
}

function isUniqueViolationError(error) {
  return String(error?.code || '') === '23505';
}

// Optional Idempotency-Key header of the complete / fail endpoints. Absent (or empty) means
// no key, so app v1.0.0 keeps today's behaviour. Returns { key } or { error, code }.
function parseIdempotencyKey(value) {
  if (value == null || value === '') return { key: null };
  if (typeof value !== 'string' || value.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_RE.test(value)) {
    return invalid(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters of letters, digits, '.', '_', ':' or '-'`,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }
  return { key: value };
}

// Parses the optional payment fields of a completion body. Absent fields stay undefined so
// app v1.0.0 (which only sends cashCollected) keeps today's behaviour.
// Returns { paymentMethod, cardAmount, cardReference } or { error, code }.
function parseCompletionPayment(body = {}) {
  let paymentMethod;
  if (body.paymentMethod != null && body.paymentMethod !== '') {
    paymentMethod = String(body.paymentMethod).trim().toLowerCase();
    if (!DELIVERY_PAYMENT_METHODS.includes(paymentMethod)) {
      return invalid('paymentMethod must be one of cash, card or prepaid', 'INVALID_PAYMENT_METHOD');
    }
  }

  let cardAmount = 0;
  if (body.cardAmount != null && body.cardAmount !== '') {
    cardAmount = Number(body.cardAmount);
    if (!Number.isFinite(cardAmount) || cardAmount < 0 || cardAmount > MAX_AMOUNT) {
      return invalid('Invalid card amount', 'INVALID_CARD_AMOUNT');
    }
  }

  let cardReference = null;
  if (body.cardReference != null && body.cardReference !== '') {
    if (typeof body.cardReference !== 'string' && typeof body.cardReference !== 'number') {
      return invalid('cardReference must be text', 'INVALID_CARD_REFERENCE');
    }
    cardReference = String(body.cardReference).trim();
    if (cardReference.length > MAX_CARD_REFERENCE_LENGTH) {
      return invalid(`cardReference must be at most ${MAX_CARD_REFERENCE_LENGTH} characters`, 'INVALID_CARD_REFERENCE');
    }
    if (!cardReference) cardReference = null;
  }

  return { paymentMethod, cardAmount: roundMoney(cardAmount), cardReference };
}

// Decides the payment method and validates the collected amounts.
// - requestedMethod: parsed paymentMethod (undefined = default)
// - isCod: order is cash on delivery; null when unknown (default then follows cashCollected)
// - amountDue: amount the driver must collect (0 when nothing is due)
// - enforce: false skips the amount checks (website orders completed by app v1.0.0)
// Returns { paymentMethod, amountPaid, covered } or { error, code }.
function resolveCompletionPayment({
  requestedMethod,
  isCod,
  amountDue = 0,
  cashCollected = 0,
  cardAmount = 0,
  totalAmount = 0,
  enforce = true,
}) {
  const due = roundMoney(Math.max(0, Number(amountDue) || 0));
  const cash = roundMoney(Number(cashCollected) || 0);
  const card = roundMoney(Number(cardAmount) || 0);
  const defaultMethod = isCod === true || (isCod == null && cash > 0) ? 'cash' : 'prepaid';
  const paymentMethod = requestedMethod || defaultMethod;
  const cashCovers = cash + AMOUNT_TOLERANCE >= due;
  const cardCovers = card + AMOUNT_TOLERANCE >= due;

  if (enforce && due > 0) {
    if (cash > 0 && card > 0 && !cashCovers && !cardCovers) {
      return invalid(
        `Split cash and card payments are not supported. Collect the full AED ${due.toFixed(2)} by cash or by card.`,
        'MIXED_PAYMENT_UNSUPPORTED',
      );
    }
    if (paymentMethod === 'cash' && !cashCovers) {
      return invalid(`Cash collected must cover the AED ${due.toFixed(2)} amount due`, 'PAYMENT_INSUFFICIENT');
    }
    if (paymentMethod === 'card' && !cardCovers) {
      return invalid(`Card amount must cover the AED ${due.toFixed(2)} amount due`, 'PAYMENT_INSUFFICIENT');
    }
    if (paymentMethod === 'prepaid') {
      return invalid(`This order has AED ${due.toFixed(2)} due on delivery; choose cash or card`, 'PAYMENT_DUE');
    }
  }

  const amountPaid = paymentMethod === 'cash'
    ? cash
    : paymentMethod === 'card'
      ? card
      : roundMoney(Number(totalAmount) || 0);
  const covered = paymentMethod === 'cash' ? cashCovers : paymentMethod === 'card' ? cardCovers : due <= 0;
  return { paymentMethod, amountPaid, covered };
}

// Accepts a PNG/JPEG data URL or raw base64. Returns { bytes, mimeType, extension },
// { error, code } or null when nothing was supplied.
function decodeSignature(value, maxBytes = MAX_SIGNATURE_BYTES) {
  const raw = typeof value === 'object' && value !== null ? value.base64 : value;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return invalid('Signature must be a base64 PNG image', 'INVALID_SIGNATURE');
  const trimmed = raw.trim();
  const dataUrlMatch = trimmed.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.+)$/is);
  if (/^data:/i.test(trimmed) && !dataUrlMatch) return invalid('Signature must be a PNG or JPEG image', 'INVALID_SIGNATURE');
  let base64 = String(dataUrlMatch?.[2] || trimmed).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return invalid('Signature must be a base64 PNG image', 'INVALID_SIGNATURE');
  // Reject before decoding anything far larger than the limit.
  if (base64.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    return invalid(`Signature must be at most ${Math.round(maxBytes / 1024)} KB`, 'SIGNATURE_TOO_LARGE');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) return invalid(`Signature must be at most ${Math.round(maxBytes / 1024)} KB`, 'SIGNATURE_TOO_LARGE');
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) return invalid('Signature must be a PNG or JPEG image', 'INVALID_SIGNATURE');
  return { bytes, mimeType: isPng ? 'image/png' : 'image/jpeg', extension: isPng ? 'png' : 'jpg' };
}

function optionalCoordinate(value, min, max) {
  if (value == null || value === '') return { value: null };
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return { error: true };
  return { value: number };
}

// Validates the body of POST /api/driver/deliveries/:orderId/fail (everything except the
// assignment token and proof photo, which server.js checks).
// Returns { reasonCode, reasonLabel, note, latitude, longitude } or { error, code }.
function validateFailureRequest(body = {}) {
  const reasonCode = String(body.reasonCode || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(FAILURE_REASONS, reasonCode)) {
    return invalid(`reasonCode must be one of ${Object.keys(FAILURE_REASONS).join(', ')}`, 'INVALID_REASON_CODE');
  }
  if (body.note != null && typeof body.note !== 'string') return invalid('note must be text', 'INVALID_NOTE');
  const note = String(body.note || '').trim();
  if (note.length > MAX_FAILURE_NOTE_LENGTH) {
    return invalid(`note must be at most ${MAX_FAILURE_NOTE_LENGTH} characters`, 'INVALID_NOTE');
  }
  if (reasonCode === 'OTHER' && !note) return invalid('A note is required when the reason is OTHER', 'NOTE_REQUIRED');

  const latitude = optionalCoordinate(body.latitude, -90, 90);
  const longitude = optionalCoordinate(body.longitude, -180, 180);
  if (latitude.error || longitude.error) return invalid('Invalid coordinates', 'INVALID_COORDINATES');
  if ((latitude.value == null) !== (longitude.value == null)) {
    return invalid('latitude and longitude must be sent together', 'INVALID_COORDINATES');
  }

  return {
    reasonCode,
    reasonLabel: FAILURE_REASONS[reasonCode],
    note: note || null,
    latitude: latitude.value,
    longitude: longitude.value,
  };
}

// Asia/Dubai has no DST, so a calendar day is a fixed UTC+4 window.
function dubaiDayRange(date) {
  const start = new Date(`${date}T00:00:00${DUBAI_UTC_OFFSET}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Removes stops that the driver already reported as FAILED today.
// failedAttempts: [{ orderId, attemptedAt }]. A planned stop comes back when the dispatcher
// saved the plan after the failure (plan.updatedAt later than the attempt), i.e. re-planned it.
function excludeFailedStops(stops = [], failedAttempts = [], ownPlan = null) {
  if (!failedAttempts.length) return stops;
  const latestFailure = new Map();
  failedAttempts.forEach((attempt) => {
    const orderId = String(attempt?.orderId ?? '').trim();
    if (!orderId) return;
    const time = new Date(attempt.attemptedAt).getTime() || 0;
    latestFailure.set(orderId, Math.max(latestFailure.get(orderId) || 0, time));
  });
  const planUpdatedAt = new Date(ownPlan?.updatedAt || 0).getTime() || 0;
  return stops.filter((stop) => {
    const failedAt = latestFailure.get(String(stop?.orderId ?? stop?.id ?? '').trim());
    if (failedAt == null) return true;
    return Boolean(stop.planned) && planUpdatedAt > failedAt;
  });
}

module.exports = {
  DELIVERY_PAYMENT_METHODS,
  FAILURE_REASONS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_SIGNATURE_BYTES,
  decodeSignature,
  dubaiDayRange,
  excludeFailedStops,
  isMissingColumnError,
  isMissingFunctionError,
  isUniqueViolationError,
  parseCompletionPayment,
  parseIdempotencyKey,
  resolveCompletionPayment,
  roundMoney,
  validateFailureRequest,
};
