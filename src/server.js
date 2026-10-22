const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createDriverReportService } = require('./driver-report-service');
const { createDriverCustomerRequestService } = require('./driver-customer-request-service');
const {
  buildDriverRoute,
  dubaiDateKey,
  isMissingTableError,
  normalizeOrderId,
  removeOrdersFromOtherPlans,
  resolvePlanDate,
  validatePlanOrderIds,
} = require('./route-plan-service');
const {
  buildInvoiceShareText,
  companyFromEnv,
  computeInvoiceTotals,
  renderInvoicePdf,
  signedInvoiceUrl,
  verifyInvoiceDownload,
} = require('./invoice-service');
const {
  FAILURE_REASONS,
  decodeSignature,
  dubaiDayRange,
  excludeFailedStops,
  isMissingColumnError,
  isMissingFunctionError,
  isUniqueViolationError,
  parseCompletionPayment,
  parseIdempotencyKey,
  resolveCompletionPayment,
  validateFailureRequest,
} = require('./delivery-record-service');
const { computeDaySummary, dedupeDeliveryAttempts } = require('./day-summary-service');
const { createDriverStorage, resolveSupabaseConfig } = require('./store');
const { createEmirateBoundaryLoader } = require('./emirate-boundaries');
const { createWebsiteDispatchProxy } = require('./website-dispatch-proxy');
require('dotenv').config();

const app = express();

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
// null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent: the driver/dispatch features then
// run on DRIVER_DATABASE_URL (or memory-only) and the legacy customer endpoints answer 503.
const SUPABASE_CONFIG = resolveSupabaseConfig(process.env);
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DRIVER_API_KEY = process.env.DRIVER_API_KEY;
const DRIVER_LOGIN_USERNAME = process.env.DRIVER_LOGIN_USERNAME || '';
const DRIVER_LOGIN_PASSWORD = process.env.DRIVER_LOGIN_PASSWORD || '';
const DRIVER_LOGIN_ID = process.env.DRIVER_LOGIN_ID || '00000000-0000-4000-8000-000000000001';
const DRIVER_LOGIN_NAME = process.env.DRIVER_LOGIN_NAME || 'Driver';
const DRIVER_LOGIN_COUNT = Math.max(1, Math.min(20, Number.parseInt(process.env.DRIVER_LOGIN_COUNT || '7', 10) || 7));
const DRIVER_SESSION_SECRET = process.env.DRIVER_SESSION_SECRET || DRIVER_API_KEY || '';
const DELIVERY_PROOF_BUCKET = process.env.DELIVERY_PROOF_BUCKET || 'delivery-proofs';
const DRIVER_REPORT_BUCKET = process.env.DRIVER_REPORT_BUCKET || 'driver-day-reports';
const DRIVER_CUSTOMER_REQUEST_BUCKET = process.env.DRIVER_CUSTOMER_REQUEST_BUCKET || 'driver-customer-requests';
const INVOICE_BUCKET = process.env.INVOICE_BUCKET || 'delivery-invoices';
const REQUIRE_DELIVERY_SIGNATURE = String(process.env.REQUIRE_DELIVERY_SIGNATURE || '').toLowerCase() === 'true';
// INVOICE_COMPANY_NAME / _TRN / _ADDRESS / _PHONE / _EMAIL; without a TRN invoices print as RECEIPT.
const INVOICE_COMPANY = companyFromEnv(process.env);
const MAX_DELIVERY_PROOF_BYTES = 5 * 1024 * 1024;
const CONFIGURED_DRIVERS = Array.from({ length: DRIVER_LOGIN_COUNT }, (_, index) => ({
  id: index === 0 ? DRIVER_LOGIN_ID : `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  username: `${DRIVER_LOGIN_USERNAME}${index + 1}`,
  name: `${DRIVER_LOGIN_NAME} ${index + 1}`,
}));
const WEBSITE_DISPATCH_URL = process.env.WEBSITE_DISPATCH_URL || 'http://localhost:4000/api/dispatch/overview';
const WEBSITE_DISPATCH_WRITE_BASE_URL = (process.env.WEBSITE_DISPATCH_WRITE_BASE_URL
  || WEBSITE_DISPATCH_URL.replace(/\/overview\/?$/, '')).replace(/\/$/, '');
const WEBSITE_DISPATCH_WRITE_KEY = process.env.WEBSITE_DISPATCH_WRITE_KEY || '';
// Optional: without it the bundled data-static/uae-emirates.geojson.json is used (also the fallback).
const EMIRATE_BOUNDARIES_URL = String(process.env.EMIRATE_BOUNDARIES_URL || '').trim();
const EMIRATE_ORDER = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
const API_BASE_URL = (process.env.API_BASE_URL || process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const PAYMENT_RELAY_BASE_URL = (process.env.NGENIUS_REDIRECT_URL || API_BASE_URL).replace(/\/$/, '');
const APP_SCHEME = process.env.APP_SCHEME || 'alrawdahsprings';
const PAYMENT_COMPLETE_REDIRECT_URL = process.env.CUSTOMER_APP_REDIRECT_URL || `${APP_SCHEME}://payment-complete`;
const PAYMENT_CANCEL_REDIRECT_URL = process.env.CUSTOMER_APP_CANCEL_URL || `${APP_SCHEME}://payment-cancel`;
const CHECKOUT_COMPLETE_REDIRECT_URL = process.env.CUSTOMER_APP_CHECKOUT_REDIRECT_URL || `${APP_SCHEME}://checkout-complete`;
const NGENIUS_BASE_URL = (process.env.NGENIUS_BASE_URL || 'https://api-gateway.ngenius-payments.com').replace(/\/$/, '');
const NGENIUS_API_KEY = process.env.NGENIUS_API_KEY || process.env.NI_API_KEY;
const NGENIUS_OUTLET_ID = process.env.NGENIUS_OUTLET_ID || process.env.NI_OUTLET_ID;

function assertHttpUrl(name, value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL.`);
  }
}

assertHttpUrl('NGENIUS_BASE_URL', NGENIUS_BASE_URL);

if (IS_PRODUCTION && !(process.env.API_BASE_URL || process.env.BASE_URL)) {
  throw new Error('Missing API_BASE_URL for production payment redirects.');
}

if (IS_PRODUCTION) {
  assertHttpUrl('API_BASE_URL', API_BASE_URL);
  assertHttpUrl('NGENIUS_REDIRECT_URL', PAYMENT_RELAY_BASE_URL);
}

const supabase = SUPABASE_CONFIG ? createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
}) : null;
// Driver/dispatch persistence: driver_ops schema + disk files when DRIVER_DATABASE_URL is set,
// otherwise Supabase tables + Storage (see src/store/index.js).
const driverStorage = createDriverStorage({
  env: process.env,
  supabase,
  apiBaseUrl: API_BASE_URL,
  signingSecret: DRIVER_SESSION_SECRET,
});
const driverStore = driverStorage.store;
const driverFiles = driverStorage.files;
console.log(`Driver data storage: ${driverStorage.mode}${driverStorage.filesDir ? ` (files in ${driverStorage.filesDir})` : ''}${supabase ? '' : '; Supabase not configured'}`);
if (driverStorage.mode === 'none') {
  console.warn('Neither DRIVER_DATABASE_URL nor Supabase is configured: route plans, sessions, invoices and delivery attempts are not persisted.');
}
const driverReports = createDriverReportService({
  files: driverFiles,
  apiBaseUrl: API_BASE_URL,
  signingSecret: DRIVER_SESSION_SECRET,
  bucket: DRIVER_REPORT_BUCKET,
});
const driverCustomerRequests = createDriverCustomerRequestService({
  files: driverFiles,
  bucket: DRIVER_CUSTOMER_REQUEST_BUCKET,
});

// Legacy customer-app endpoints (products, auth, orders, wallet, payments, notifications, ...)
// exist only on Supabase.
function requireSupabase(_req, res, next) {
  if (supabase) return next();
  return res.status(503).json({ error: 'This endpoint needs Supabase, which is not configured on this server', code: 'SUPABASE_NOT_CONFIGURED' });
}

const NO_OPERATIONS_ORDERS = Object.freeze({ data: [], error: null });

const ALLOWED_ORDER_STATUSES = new Set(['PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']);
const ALLOWED_PAYMENT_METHODS = new Set(['cod', 'wallet', 'card']);
const ALLOWED_PUSH_PLATFORMS = new Set(['ios', 'android', 'web', 'unknown']);
const ALLOWED_APP_TYPES = new Set(['customer', 'driver', 'admin', 'unknown']);
const ALLOWED_NOTIFICATION_AUDIENCES = new Set(['all', 'customers', 'drivers', 'specificUsers']);
const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'DISPATCH', 'FINANCE', 'SUPPORT', 'READ_ONLY']);
const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const latestDriverLocations = new Map();
const driverShiftStates = new Map();
const driverGpsSharingStates = new Map();

function getDriverShiftState(driverId) {
  return driverShiftStates.get(driverId) || {
    status: 'ON_DUTY',
    startedAt: null,
    endedAt: null,
  };
}

// --- Driver dispatch persistence (driver_route_plans, driver_sessions, driver_locations) ---
// Production may run this code before supabase-migrations/20261020_driver_dispatch.sql is applied.
// A missing table is warned about once per process, then skipped (memory-only behaviour) and
// re-checked every few minutes so a later migration is picked up without a restart.
const DRIVER_OPS_SCHEMA_FILE = 'backend/db/driver_ops_schema.sql';
const DISPATCH_MIGRATION_FILE = driverStore.kind === 'supabase' ? 'supabase-migrations/20261020_driver_dispatch.sql' : DRIVER_OPS_SCHEMA_FILE;
const DISPATCH_TABLE_RECHECK_MS = 5 * 60 * 1000;
const DRIVER_LOCATION_HISTORY_INTERVAL_MS = 20_000;
const DRIVER_SESSION_LOAD_TIMEOUT_MS = 2_500;
const missingDispatchTables = new Map();
const warnedMissingDispatchTables = new Set();
const driverSessionLoads = new Map();
const driverSessionWrites = new Map();
const lastDriverLocationInsertAt = new Map();
const loggedDriverLocationErrors = new Set();

function dispatchTableAvailable(table) {
  const retryAt = missingDispatchTables.get(table);
  return !retryAt || retryAt <= Date.now();
}

// migrationFile names the migration in the warning; a missing RPC function (next_invoice_number)
// is treated like a missing table of the same migration.
function markDispatchTableResult(table, error, migrationFile = DISPATCH_MIGRATION_FILE) {
  if (!error) {
    missingDispatchTables.delete(table);
    return false;
  }
  if (!isMissingTableError(error) && !isMissingFunctionError(error)) return false;
  missingDispatchTables.set(table, Date.now() + DISPATCH_TABLE_RECHECK_MS);
  if (!warnedMissingDispatchTables.has(table)) {
    warnedMissingDispatchTables.add(table);
    console.warn(`${driverStore.schemaLabel}.${table} is missing; continuing without it. Apply ${migrationFile} to enable it.`);
  }
  return true;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function applyDriverSessionRecord(record) {
  const driverId = String(record.driver_id || '');
  if (!driverId) return;
  const shiftStatus = ['ON_DUTY', 'OFF_DUTY'].includes(record.shift_status) ? record.shift_status : null;
  if (!driverShiftStates.has(driverId) && shiftStatus) {
    driverShiftStates.set(driverId, {
      status: shiftStatus,
      startedAt: toIsoOrNull(record.shift_started_at),
      endedAt: toIsoOrNull(record.shift_ended_at),
    });
  }
  if (!driverGpsSharingStates.has(driverId) && typeof record.gps_sharing === 'boolean') {
    driverGpsSharingStates.set(driverId, record.gps_sharing);
  }
  const lat = finiteOrNull(record.last_latitude);
  const lng = finiteOrNull(record.last_longitude);
  if (!latestDriverLocations.has(driverId) && record.gps_sharing !== false && shiftStatus !== 'OFF_DUTY'
    && lat != null && lng != null) {
    latestDriverLocations.set(driverId, {
      driver_id: driverId,
      lat,
      lng,
      accuracy: finiteOrNull(record.last_accuracy),
      recorded_at: toIsoOrNull(record.last_location_at) || toIsoOrNull(record.updated_at),
    });
  }
}

// Fills the in-memory caches from driver_sessions for drivers that have no cached shift yet
// (e.g. after a restart). Loads each driver at most once per process; never throws.
async function ensureDriverSessionsLoaded(driverIds) {
  const uniqueIds = [...new Set((driverIds || []).map((id) => String(id || '')).filter(Boolean))];
  const idsToLoad = uniqueIds.filter((id) => !driverShiftStates.has(id) && !driverSessionLoads.has(id));
  if (idsToLoad.length && dispatchTableAvailable('driver_sessions')) {
    const load = (async () => {
      const { data, error } = await driverStore.loadDriverSessions(idsToLoad, { timeoutMs: DRIVER_SESSION_LOAD_TIMEOUT_MS });
      if (markDispatchTableResult('driver_sessions', error)) return;
      if (error) throw error;
      (data || []).forEach(applyDriverSessionRecord);
    })().catch((error) => logError('Driver session load failed', error));
    idsToLoad.forEach((id) => driverSessionLoads.set(id, load));
  }
  await Promise.all(uniqueIds.map((id) => driverSessionLoads.get(id)).filter(Boolean));
}

async function flushDriverSessionWrites(driverId, entry) {
  try {
    while (entry.pending) {
      const patch = entry.pending;
      entry.pending = null;
      const { error } = await driverStore.upsertDriverSession(driverId, { ...patch, updated_at: new Date().toISOString() });
      if (markDispatchTableResult('driver_sessions', error)) {
        entry.pending = null;
        break;
      }
      if (error) logError('Driver session persistence failed', error);
    }
  } catch (error) {
    logError('Driver session persistence failed', error);
  } finally {
    entry.running = false;
    if (!entry.pending && driverSessionWrites.get(driverId) === entry) driverSessionWrites.delete(driverId);
  }
}

// Write-through to driver_sessions without blocking the request. Writes for one driver are
// serialised and coalesced, so the last state always wins and frequent GPS pings do not pile up.
function persistDriverSession(driverId, patch) {
  if (!driverId || !dispatchTableAvailable('driver_sessions')) return;
  let entry = driverSessionWrites.get(driverId);
  if (!entry) {
    entry = { pending: null, running: false };
    driverSessionWrites.set(driverId, entry);
  }
  entry.pending = { ...entry.pending, ...patch };
  if (entry.running) return;
  entry.running = true;
  flushDriverSessionWrites(driverId, entry);
}

const CLEARED_DRIVER_SESSION_LOCATION = {
  last_latitude: null,
  last_longitude: null,
  last_accuracy: null,
  last_location_at: null,
};

// Appends GPS history (at most one row per driver per 20 s). Fire-and-forget.
function recordDriverLocationPoint(driverId, location) {
  if (!UUID_RE.test(String(driverId || '')) || !dispatchTableAvailable('driver_locations')) return;
  const now = Date.now();
  if (now - (lastDriverLocationInsertAt.get(driverId) || 0) < DRIVER_LOCATION_HISTORY_INTERVAL_MS) return;
  lastDriverLocationInsertAt.set(driverId, now);

  Promise.resolve()
    .then(() => driverStore.insertDriverLocation({
      driver_id: driverId,
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      recorded_at: toIsoOrNull(location.recorded_at) || new Date(now).toISOString(),
    }))
    .then(({ error }) => {
      if (!error || markDispatchTableResult('driver_locations', error)) return;
      // e.g. 23503 when the driver_id FK to users is still present for configured drivers.
      // Back off for this driver and log each error code once per process.
      lastDriverLocationInsertAt.set(driverId, now + DISPATCH_TABLE_RECHECK_MS);
      const errorKey = String(error.code || error.message || 'unknown');
      if (!loggedDriverLocationErrors.has(errorKey)) {
        loggedDriverLocationErrors.add(errorKey);
        logError('Driver location history insert failed', error);
      }
    })
    .catch((error) => logError('Driver location history insert failed', error));
}

function routePlansUnavailableError() {
  const error = new Error(`Driver route plans are unavailable until ${DISPATCH_MIGRATION_FILE} is applied to the database.`);
  error.isRoutePlanUnavailable = true;
  return error;
}

function mapRoutePlanRecord(record) {
  return {
    driverId: String(record.driver_id),
    date: String(record.plan_date || '').slice(0, 10),
    orderIds: Array.isArray(record.order_ids) ? record.order_ids.map(normalizeOrderId).filter(Boolean) : [],
    source: record.source || null,
    createdBy: record.created_by || null,
    updatedAt: record.updated_at || null,
  };
}

async function loadRoutePlans(planDate) {
  const { data, error } = await driverStore.listRoutePlans(planDate);
  if (markDispatchTableResult('driver_route_plans', error)) throw routePlansUnavailableError();
  if (error) throw error;
  return (data || []).map(mapRoutePlanRecord);
}

// Route plans for driver-facing reads: any failure falls back to automatic routing.
async function loadRoutePlansForDriverRoute(planDate) {
  if (!dispatchTableAvailable('driver_route_plans')) return [];
  try {
    return await loadRoutePlans(planDate);
  } catch (error) {
    if (!error?.isRoutePlanUnavailable) logError('Route plan lookup failed; using automatic routing', error);
    return [];
  }
}

async function listAllAuthUsers() {
  if (!supabase) return [];
  const users = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const batch = data?.users || [];
    users.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }

  return users;
}

function buildAddressDisplay(record = {}) {
  return [
    record.building,
    record.apartment,
    record.address,
    record.city,
  ].filter(Boolean).join(', ');
}

function isExpoPushToken(token) {
  return /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(String(token || '').trim());
}

function normalizePushPlatform(platform) {
  const value = String(platform || 'unknown').toLowerCase();
  return ALLOWED_PUSH_PLATFORMS.has(value) ? value : 'unknown';
}

function normalizeAppType(appType) {
  const value = String(appType || 'unknown').toLowerCase();
  return ALLOWED_APP_TYPES.has(value) ? value : 'unknown';
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function fireAndForgetNotification(task) {
  Promise.resolve()
    .then(task)
    .catch((error) => logError('Push notification failed', error));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireApiKey(allowedKeys) {
  const configuredKeys = allowedKeys.filter(Boolean);

  return (req, res, next) => {
    if (configuredKeys.length === 0) {
      if (!IS_PRODUCTION) {
        console.warn('Admin/driver API key is not configured; allowing request in development mode.');
        return next();
      }

      return res.status(503).json({ error: 'Operations API key is not configured' });
    }

    const providedKey = req.get('x-api-key');
    if (providedKey && configuredKeys.some((key) => safeCompare(key, providedKey))) return next();

    return res.status(401).json({ error: 'Unauthorized' });
  };
}

const requireAdmin = requireApiKey([ADMIN_API_KEY]);
const requireOperationsAccess = requireApiKey([ADMIN_API_KEY, DRIVER_API_KEY]);

function requireDispatchReadOnly(req, res, next) {
  const remoteAddress = req.ip || req.socket?.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
  if (isLoopback) return next();
  return requireOperationsAccess(req, res, next);
}

function safeCompare(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected));
  const actualBuffer = Buffer.from(String(actual));
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function requireCustomerAuth(req, res, next) {
  if (!supabase) return requireSupabase(req, res, next);
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return res.status(401).json({ error: 'Invalid or expired session' });

    req.authUser = data.user;
    return next();
  } catch (error) {
    logError('Customer auth failed', error);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireSameCustomer(req, res, userId) {
  if (!UUID_RE.test(String(userId || ''))) {
    res.status(400).json({ error: 'Invalid user id' });
    return null;
  }

  if (!req.authUser?.id || req.authUser.id !== userId) {
    res.status(403).json({ error: 'You are not allowed to access this account' });
    return null;
  }

  return userId;
}

async function requireDriverAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const localDriver = verifyConfiguredDriverToken(token);
    if (localDriver) {
      req.authUser = {
        id: localDriver.id,
        phone: '',
        user_metadata: { name: localDriver.name, username: localDriver.username, role: 'DRIVER' },
      };
      req.driverProfile = { id: localDriver.id, name: localDriver.name, role: 'DRIVER' };
      return next();
    }
    // Supabase driver accounts only exist when Supabase is configured.
    if (!supabase) return res.status(401).json({ error: 'Invalid or expired session' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return res.status(401).json({ error: 'Invalid or expired session' });

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, name, role')
      .eq('id', data.user.id)
      .single();

    if (profileError || !profile || profile.role !== 'DRIVER') {
      return res.status(403).json({ error: 'Driver access required' });
    }

    req.authUser = data.user;
    req.driverProfile = profile;
    return next();
  } catch (error) {
    logError('Driver auth failed', error);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function createConfiguredDriverToken(driver) {
  const payload = Buffer.from(JSON.stringify({
    id: driver.id,
    name: driver.name,
    username: driver.username,
    exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', DRIVER_SESSION_SECRET).update(payload).digest('base64url');
  return `driver.${payload}.${signature}`;
}

function verifyConfiguredDriverToken(token) {
  if (!DRIVER_SESSION_SECRET || !token.startsWith('driver.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, providedSignature] = parts;
  const expectedSignature = crypto.createHmac('sha256', DRIVER_SESSION_SECRET).update(payload).digest('base64url');
  if (!safeCompare(expectedSignature, providedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const driver = CONFIGURED_DRIVERS.find((candidate) => candidate.id === parsed.id && candidate.username === parsed.username);
    if (!driver || Number(parsed.exp) <= Math.floor(Date.now() / 1000)) return null;
    return { ...parsed, name: driver.name };
  } catch {
    return null;
  }
}

function createDeliveryAssignmentToken({ orderId, driverId, source }) {
  const payload = Buffer.from(JSON.stringify({
    orderId,
    driverId,
    source,
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', DRIVER_SESSION_SECRET).update(payload).digest('base64url');
  return `assignment.${payload}.${signature}`;
}

function verifyDeliveryAssignmentToken(token, { orderId, driverId }) {
  if (!DRIVER_SESSION_SECRET || typeof token !== 'string' || !token.startsWith('assignment.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, providedSignature] = parts;
  const expectedSignature = crypto.createHmac('sha256', DRIVER_SESSION_SECRET).update(payload).digest('base64url');
  if (!safeCompare(expectedSignature, providedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.orderId !== orderId || parsed.driverId !== driverId || Number(parsed.exp) <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseStoredOrderNotes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { deliveryInstructions: String(value) };
  }
}

function ensureDeliveryProofBucket() {
  return driverFiles.ensureBucket(DELIVERY_PROOF_BUCKET, {
    fileSizeLimit: MAX_DELIVERY_PROOF_BYTES,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
}

async function uploadDeliveryProof({ orderId, driverId, proofPhoto }) {
  const suppliedMimeType = String(proofPhoto?.mimeType || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  const rawPhoto = String(proofPhoto?.base64 || '').trim();
  const dataUrlMatch = rawPhoto.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/is);
  const embeddedMimeType = dataUrlMatch?.[1]?.toLowerCase().replace('image/jpg', 'image/jpeg');
  let base64 = String(dataUrlMatch?.[2] || rawPhoto).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(embeddedMimeType || suppliedMimeType) || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw validationError('A valid proof-of-delivery photo is required');
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 1024 || bytes.length > MAX_DELIVERY_PROOF_BYTES) {
    throw validationError('Proof photo must be between 1 KB and 5 MB');
  }

  const detectedMimeType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'image/png'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'image/webp'
        : null;
  if (!detectedMimeType) throw validationError('Proof photo must be a JPEG, PNG, or WebP image');

  await ensureDeliveryProofBucket();
  const mimeType = detectedMimeType;
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const safeOrderId = orderId.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `${safeOrderId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  await driverFiles.upload(DELIVERY_PROOF_BUCKET, path, bytes, {
    contentType: mimeType,
    cacheControl: '3600',
    upsert: false,
    metadata: { orderId, driverId },
  });
  return { bucket: DELIVERY_PROOF_BUCKET, path, mimeType, size: bytes.length };
}

function polygonsForGeometry(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function pointInRing(ring, point) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLongitude, currentLatitude] = ring[current];
    const [previousLongitude, previousLatitude] = ring[previous];
    const crossesLatitude = (currentLatitude > point.latitude) !== (previousLatitude > point.latitude);
    const intersectionLongitude = ((previousLongitude - currentLongitude) * (point.latitude - currentLatitude))
      / ((previousLatitude - currentLatitude) || Number.EPSILON) + currentLongitude;
    if (crossesLatitude && point.longitude < intersectionLongitude) inside = !inside;
  }
  return inside;
}

function geometryContainsPoint(geometry, point) {
  return polygonsForGeometry(geometry).some((polygon) => {
    if (!polygon.length || !pointInRing(polygon[0], point)) return false;
    return !polygon.slice(1).some((hole) => pointInRing(hole, point));
  });
}

function pointToSegmentDistance(point, start, end) {
  const longitudeScale = Math.cos(point.latitude * Math.PI / 180);
  const pointX = point.longitude * longitudeScale;
  const startX = start[0] * longitudeScale;
  const endX = end[0] * longitudeScale;
  const segmentX = endX - startX;
  const segmentY = end[1] - start[1];
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  const projection = lengthSquared
    ? Math.max(0, Math.min(1, (((pointX - startX) * segmentX) + ((point.latitude - start[1]) * segmentY)) / lengthSquared))
    : 0;
  return Math.hypot(pointX - (startX + projection * segmentX), point.latitude - (start[1] + projection * segmentY));
}

function distanceToGeometry(geometry, point) {
  if (geometryContainsPoint(geometry, point)) return 0;
  let closest = Number.POSITIVE_INFINITY;
  for (const polygon of polygonsForGeometry(geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        closest = Math.min(closest, pointToSegmentDistance(point, ring[index - 1], ring[index]));
      }
    }
  }
  return closest;
}

const getEmirateBoundaries = createEmirateBoundaryLoader({ url: EMIRATE_BOUNDARIES_URL, emirates: EMIRATE_ORDER });

function emirateForPoint(boundaries, point) {
  const containing = EMIRATE_ORDER.find((emirate) => geometryContainsPoint(boundaries.get(emirate), point));
  if (containing) return containing;
  return EMIRATE_ORDER.reduce((closest, emirate) => (
    distanceToGeometry(boundaries.get(emirate), point) < distanceToGeometry(boundaries.get(closest), point) ? emirate : closest
  ));
}

function optimizeStopOrder(stops, origin) {
  const remaining = [...stops];
  const optimized = [];
  let current = origin || (remaining[0] ? { latitude: remaining[0].latitude, longitude: remaining[0].longitude } : null);
  while (remaining.length) {
    let nextIndex = 0;
    if (current) {
      let closest = Number.POSITIVE_INFINITY;
      remaining.forEach((stop, index) => {
        const distance = Math.hypot(stop.latitude - current.latitude, (stop.longitude - current.longitude) * Math.cos(current.latitude * Math.PI / 180));
        if (distance < closest) {
          closest = distance;
          nextIndex = index;
        }
      });
    }
    const [next] = remaining.splice(nextIndex, 1);
    optimized.push(next);
    current = { latitude: next.latitude, longitude: next.longitude };
  }
  return optimized;
}

function hasStopCoordinates(stop) {
  return stop.latitude != null && stop.longitude != null
    && Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude);
}

// Every active stop known to the backend: website dispatch feed + active Supabase orders.
// Stops without usable coordinates are kept with latitude/longitude null so that dispatch
// plans can still reference them; the automatic split below only uses positioned stops.
async function loadActiveDispatchStops() {
  const [websiteResult, operationsResult, catalog] = await Promise.all([
    fetch(WEBSITE_DISPATCH_URL, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Website dispatch feed returned ${response.status}`);
        return response.json();
      })
      .catch(() => ({ orders: [] })),
    // Without Supabase the operations source contributes nothing (website feed only).
    supabase
      ? supabase
        .from('orders')
        .select('*, user:users(name, phone, email, address, building, apartment, city, location_lat, location_lng), items:order_items(*)')
        .in('status', ['PENDING', 'OUT_FOR_DELIVERY'])
        .order('created_at', { ascending: true })
      : NO_OPERATIONS_ORDERS,
    supabase ? getProductCatalogMap() : new Map(),
  ]);

  if (operationsResult.error) throw operationsResult.error;

  const websiteStops = (websiteResult.orders || []).flatMap((order) => {
    const hasCoordinates = order.latitude != null && order.longitude != null
      && Number.isFinite(Number(order.latitude)) && Number.isFinite(Number(order.longitude));
    const latitude = hasCoordinates ? Number(order.latitude) : null;
    const longitude = hasCoordinates ? Number(order.longitude) : null;
    return [{
      id: order.id,
      orderId: order.id,
      orderNumber: order.orderNumber || order.id,
      customerName: order.customerName || 'Customer',
      customerPhone: order.customerPhone || '',
      address: order.address || '',
      latitude,
      longitude,
      status: 'ASSIGNED',
      cashDue: String(order.paymentMethod || '').toLowerCase() === 'cash_on_delivery'
        && String(order.paymentStatus || '').toLowerCase() !== 'paid'
        ? Number(order.totalAmount || order.total || 0)
        : 0,
      totalAmount: Number(order.totalAmount || order.total || 0),
      paymentMethod: order.paymentMethod || '',
      paymentStatus: order.paymentStatus || '',
      orderStatus: order.status || '',
      referral: order.referral || {},
      deliveryDate: order.deliveryDate || '',
      deliverySlot: order.deliverySlot || '',
      deliveryInstructions: order.deliveryNotes || order.deliveryInstructions || '',
      items: Array.isArray(order.items) ? order.items.map((item) => ({
        id: item.id,
        productId: item.productId || '',
        name: [item.productName || item.name || 'Order item', item.productSize].filter(Boolean).join(' · '),
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
        subtotal: Number(item.totalPrice ?? item.lineSubtotal ?? item.subtotal ?? 0),
        depositTotal: Number(item.depositTotal || 0),
      })) : [],
      source: 'website',
    }];
  });

  const operationsStops = (operationsResult.data || []).flatMap((order) => {
    const customer = order.user || {};
    const notes = parseStoredOrderNotes(order.notes);
    const rawLatitude = Number(order.latitude ?? customer.location_lat);
    const rawLongitude = Number(order.longitude ?? customer.location_lng);
    const hasCoordinates = Number.isFinite(rawLatitude) && Number.isFinite(rawLongitude);
    const latitude = hasCoordinates ? rawLatitude : null;
    const longitude = hasCoordinates ? rawLongitude : null;
    return [{
      id: order.id,
      orderId: order.id,
      orderNumber: order.id,
      customerName: customer.name || 'Customer',
      customerPhone: customer.phone || '',
      address: order.delivery_address || buildAddressDisplay(customer),
      latitude,
      longitude,
      status: 'ASSIGNED',
      cashDue: order.payment_method === 'cod' ? Number(order.total_amount || 0) : 0,
      totalAmount: Number(order.total_amount || 0),
      paymentMethod: String(order.payment_method || '').toUpperCase(),
      paymentStatus: String(order.payment_status || '').toUpperCase(),
      deliverySlot: order.delivery_slot || '',
      deliveryInstructions: notes.deliveryInstructions || '',
      items: (order.items || []).map((item) => {
        const productId = item.product_code || item.product_id || '';
        const product = catalog.get(String(productId));
        const quantity = Number(item.quantity || 0);
        const subtotal = Number(item.subtotal || 0);
        return {
          id: item.id,
          productId,
          name: product?.name || productId || 'Order item',
          quantity,
          unitPrice: quantity > 0 ? Number((subtotal / quantity).toFixed(2)) : Number(product?.price || 0),
          subtotal,
          usedCredits: Number(item.used_credits || 0),
        };
      }),
      source: 'operations',
    }];
  });

  return [...websiteStops, ...operationsStops];
}

// activeStopsPromise lets callers share one loadActiveDispatchStops() call.
async function getConfiguredDriverRoute(driverId, activeStopsPromise) {
  const driverIndex = CONFIGURED_DRIVERS.findIndex((driver) => driver.id === driverId);
  if (driverIndex < 0) return [];

  const [activeStops, boundaries] = await Promise.all([
    activeStopsPromise || loadActiveDispatchStops(),
    getEmirateBoundaries(),
  ]);

  const positionedDrivers = CONFIGURED_DRIVERS.flatMap((driver) => {
    const location = latestDriverLocations.get(driver.id);
    const latitude = Number(location?.lat);
    const longitude = Number(location?.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [{ id: driver.id, latitude, longitude }]
      : [];
  });

  const plannedForDriver = activeStops.filter(hasStopCoordinates).filter((stop) => {
    if (positionedDrivers.length) {
      const closestDriver = positionedDrivers.reduce((closest, candidate) => {
        const closestDistance = Math.hypot(stop.latitude - closest.latitude, stop.longitude - closest.longitude);
        const candidateDistance = Math.hypot(stop.latitude - candidate.latitude, stop.longitude - candidate.longitude);
        return candidateDistance < closestDistance ? candidate : closest;
      });
      return closestDriver.id === driverId;
    }

    const emirate = emirateForPoint(boundaries, { latitude: stop.latitude, longitude: stop.longitude });
    return CONFIGURED_DRIVERS[EMIRATE_ORDER.indexOf(emirate) % CONFIGURED_DRIVERS.length]?.id === driverId;
  });

  const location = latestDriverLocations.get(driverId);
  const optimized = optimizeStopOrder(plannedForDriver, location ? { latitude: Number(location.lat), longitude: Number(location.lng) } : null);
  return optimized.map((stop, index) => ({ ...stop, routeSequence: index + 1 }));
}

function buildRedirectUrl(targetUrl, params = {}) {
  const query = new URLSearchParams(params);
  return `${targetUrl}${query.toString() ? `?${query.toString()}` : ''}`;
}

function getPublicErrorMessage(error, fallback = 'Request failed') {
  if (error?.isValidationError) return error.message;
  if (error?.message === 'Unsupported phone provider') {
    return 'SMS OTP is not enabled in Supabase Auth. Enable the phone provider before requesting codes.';
  }
  return IS_PRODUCTION ? fallback : (error?.message || fallback);
}

function validationError(message) {
  const error = new Error(message);
  error.isValidationError = true;
  return error;
}

function normalizeUaePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('971') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+971${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith('5')) return `+971${digits}`;
  return String(phone || '').trim();
}

const reverseGeocodeCache = new Map();
async function reverseGeocodeUae(latitude, longitude) {
  const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  if (reverseGeocodeCache.has(cacheKey)) return reverseGeocodeCache.get(cacheKey);
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Delivery-Driver-Operations/1.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Reverse geocoding returned ${response.status}`);
  const payload = await response.json();
  const addressParts = payload.address || {};
  const result = {
    address: String(payload.display_name || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`),
    city: String(addressParts.city || addressParts.town || addressParts.village || addressParts.county || addressParts.state || ''),
    country: String(addressParts.country || 'United Arab Emirates'),
  };
  if (reverseGeocodeCache.size >= 500) reverseGeocodeCache.delete(reverseGeocodeCache.keys().next().value);
  reverseGeocodeCache.set(cacheKey, result);
  return result;
}

function assertUaeCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 22 || latitude > 27 || longitude < 51 || longitude > 57) {
    throw validationError('Capture a valid GPS location inside the UAE');
  }
}

async function activateDriverCreatedCustomer(request) {
  if (!supabase) {
    const error = new Error('Customer accounts cannot be created: Supabase is not configured on this server');
    error.statusCode = 503;
    error.isValidationError = true;
    throw error;
  }
  const authUsers = await listAllAuthUsers();
  const duplicate = authUsers.find((user) => normalizeUaePhone(user.phone || user.user_metadata?.phone) === request.phone);
  if (duplicate) throw validationError('A customer account already exists with this phone number');

  const email = request.email || phoneProfileEmail(request.phone);
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    phone: request.phone,
    email,
    user_metadata: { phone: request.phone, name: request.customerName, role: 'CUSTOMER', source: 'driver_request' },
    email_confirm: true,
    phone_confirm: true,
  });
  if (authError) {
    if (isDuplicateAuthUserError(authError)) throw validationError('A customer account already exists with this phone number or email');
    throw authError;
  }
  if (!authData?.user?.id) throw new Error('Could not create customer account');

  const profile = {
    id: authData.user.id,
    email,
    phone: request.phone,
    name: request.customerName,
    role: 'CUSTOMER',
    address: request.address,
    city: request.city || '',
    location_lat: request.latitude,
    location_lng: request.longitude,
  };
  let result = await supabase.from('users').insert(profile).select().single();
  if (result.error?.code === '42703') {
    delete profile.phone;
    result = await supabase.from('users').insert(profile).select().single();
  }
  if (result.error) {
    await supabase.auth.admin.deleteUser(authData.user.id).catch(() => undefined);
    throw result.error;
  }
  return result.data;
}

function phoneProfileEmail(phone) {
  return `${phone.replace(/\D/g, '')}@phone.rswater.ae`;
}

function isDuplicateAuthUserError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('already') || message.includes('registered') || message.includes('duplicate');
}

function isSchemaSetupError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '');
  return code === '42P01' || code === '42703' || message.includes('does not exist') || message.includes('schema cache');
}

async function ensurePhoneAuthUser(phone, role) {
  const { error } = await supabase.auth.admin.createUser({
    phone,
    email: phoneProfileEmail(phone),
    user_metadata: { phone, role },
    email_confirm: true,
  });

  if (error && !isDuplicateAuthUserError(error)) throw error;
}

function logError(context, error) {
  console.error(context, {
    message: error?.message || String(error),
    status: error?.status || error?.code,
  });
}

function generateOrderId() {
  return crypto.randomUUID();
}

async function getBottleCredits(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('bottle_credits')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data?.bottle_credits || 0;
}

async function getCustomerBalances(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('wallet_balance, bottle_credits, loyalty_points')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return {
    walletBalance: Number(data?.wallet_balance || 0),
    bottleCredits: Number(data?.bottle_credits || 0),
    loyaltyPoints: Number(data?.loyalty_points || 0),
  };
}

function calculateDeliveryFee(_itemsTotalAfterCoupons) {
  return 0;
}

function mapProductRecord(product) {
  return {
    id: product.code || product.id,
    dbId: product.id,
    code: product.code || null,
    name: product.name,
    category: product.description || 'Water',
    description: product.description || '',
    imageUrl: product.image_url || null,
    price: Number(product.price || 0),
    is5Gallon: Boolean(product.is_5_gallon),
    depositRequired: Number(product.deposit_required || 0),
    stock: Number(product.stock || 0),
  };
}

async function loadCatalogProducts() {
  let { data, error } = await supabase
    .from('products')
    .select('id, code, name, description, image_url, price, is_5_gallon, deposit_required, stock')
    .order('created_at', { ascending: true });

  if (error?.message?.includes('products.code')) {
    const fallback = await supabase
      .from('products')
      .select('id, name, description, image_url, price, is_5_gallon, deposit_required, stock')
      .order('created_at', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw error;
  return (data || []).map(mapProductRecord);
}

async function getProductCatalogMap() {
  const products = await loadCatalogProducts();
  const catalog = new Map();
  products.forEach((product) => {
    catalog.set(String(product.id), product);
    catalog.set(String(product.dbId), product);
    if (product.code) catalog.set(String(product.code), product);
  });
  return catalog;
}

function mapCouponPackRecord(pack) {
  return {
    id: pack.code || pack.id,
    dbId: pack.id,
    label: pack.label,
    price: Number(pack.price || 0),
    baseCoupons: Number(pack.base_coupons || 0),
    bonusCoupons: Number(pack.bonus_coupons || 0),
    totalCoupons: Number(pack.base_coupons || 0) + Number(pack.bonus_coupons || 0),
  };
}

async function loadCouponPacks() {
  const { data, error } = await supabase
    .from('coupon_packs')
    .select('id, code, label, price, base_coupons, bonus_coupons, is_active')
    .eq('is_active', true)
    .order('price', { ascending: false });

  if (error) throw error;
  return (data || []).map(mapCouponPackRecord);
}

async function getCouponPack(packId) {
  const cleanPackId = String(packId || '').trim();
  const packs = await loadCouponPacks();
  return packs.find((pack) => pack.id === cleanPackId || pack.dbId === cleanPackId) || null;
}

async function validateOrderItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must include at least one item');
  }

  const catalog = await getProductCatalogMap();

  return items.map((item) => {
    const productId = String(item.productId || '').trim();
    const catalogProduct = catalog.get(productId);
    const quantity = Number(item.quantity);

    if (!catalogProduct) {
      throw validationError(`Unknown product: ${productId}`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw validationError(`Invalid quantity for ${productId}`);
    }

    const expectedSubtotal = catalogProduct.price * quantity;
    const subtotal = Number(item.subtotal);
    if (!Number.isFinite(subtotal) || Math.abs(subtotal - expectedSubtotal) > 0.01) {
      throw validationError(`Invalid subtotal for ${productId}`);
    }

    const requestedCoupons = Math.max(0, Number(item.usedCredits || item.couponsToUse || 0));
    if (!Number.isInteger(requestedCoupons) || requestedCoupons > quantity || (requestedCoupons > 0 && !catalogProduct.is5Gallon)) {
      throw validationError(`Invalid 5-gallon coupons for ${productId}`);
    }

    const usedCredits = catalogProduct.is5Gallon ? requestedCoupons : 0;

    return { productId, quantity, subtotal: expectedSubtotal, usedCredits, catalogProduct };
  });
}

function calculateOrderPricing(items) {
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const couponDiscount = items.reduce((sum, item) => sum + (item.usedCredits * item.catalogProduct.price), 0);
  const goodsSubtotal = Number(Math.max(0, subtotal - couponDiscount).toFixed(2));
  const deliveryFee = calculateDeliveryFee(goodsSubtotal);
  const taxableAmount = Number((goodsSubtotal + deliveryFee).toFixed(2));
  const vat = Number((taxableAmount * 0.05).toFixed(2));
  const total = Number((taxableAmount + vat).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    couponDiscount: Number(couponDiscount.toFixed(2)),
    goodsSubtotal,
    deliveryFee,
    vat,
    total,
  };
}

function normalizeOrderPayload(orderPayload = {}) {
  const emptyBottlesReturned = Number(orderPayload.emptyBottlesReturned ?? orderPayload.empty_bottles_returned ?? 0);

  return {
    ...orderPayload,
    address: String(
      orderPayload.address ||
      orderPayload.deliveryAddress ||
      orderPayload.delivery_address ||
      ''
    ).trim(),
    deliveryInstructions: String(orderPayload.deliveryInstructions || orderPayload.notes || '').trim(),
    emptyBottlesReturned: Number.isInteger(emptyBottlesReturned) && emptyBottlesReturned > 0 ? emptyBottlesReturned : 0,
    items: Array.isArray(orderPayload.items) ? orderPayload.items : [],
  };
}

async function createOrderInSupabase({ userId, amount, paymentMethod, orderPayload, initialStatus = 'PENDING' }) {
  const normalizedOrderPayload = normalizeOrderPayload(orderPayload);
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < 0) {
    throw validationError('Invalid order amount');
  }
  const normalizedPaymentMethod = String(paymentMethod || 'cod').toLowerCase();
  if (!ALLOWED_PAYMENT_METHODS.has(normalizedPaymentMethod)) {
    throw validationError('Invalid payment method');
  }

  if (!normalizedOrderPayload.address) {
    throw validationError('Delivery address is required');
  }

  const items = await validateOrderItems(normalizedOrderPayload.items);
  const usedCreditsTotal = items.reduce((sum, item) => sum + item.usedCredits, 0);
  const fiveGallonQuantity = items.reduce((sum, item) => (
    sum + (item.catalogProduct.is5Gallon ? item.quantity : 0)
  ), 0);
  if (normalizedOrderPayload.emptyBottlesReturned > fiveGallonQuantity) {
    throw validationError('Returned empty bottles cannot exceed ordered 5-gallon bottles');
  }

  const pricing = calculateOrderPricing(items);
  const expectedTotal = pricing.total;
  const earnedLoyaltyPoints = normalizedPaymentMethod === 'card' ? 0 : Math.floor(expectedTotal);

  if (Math.abs(safeAmount - expectedTotal) > 0.01) {
    throw validationError(`Invalid order total. Expected ${expectedTotal.toFixed(2)} AED`);
  }

  const balances = await getCustomerBalances(userId);
  if (usedCreditsTotal > 0 && balances.bottleCredits < usedCreditsTotal) {
    throw validationError('Insufficient 5-gallon coupons');
  }
  if (normalizedPaymentMethod === 'wallet' && balances.walletBalance < expectedTotal) {
    throw validationError('Insufficient wallet balance');
  }

  const { data: order, error } = await supabase.from('orders').insert({
    id: generateOrderId(),
    user_id: userId,
    total_amount: expectedTotal,
    payment_method: normalizedPaymentMethod,
    payment_status: normalizedPaymentMethod === 'wallet' ? 'PAID' : 'UNPAID',
    delivery_address: normalizedOrderPayload.address,
    status: initialStatus,
    delivery_slot: normalizedOrderPayload.deliverySlot || null,
    notes: JSON.stringify({
      pricing,
      deliveryInstructions: normalizedOrderPayload.deliveryInstructions || '',
      emptyBottlesReturned: normalizedOrderPayload.emptyBottlesReturned || 0,
    }),
  }).select().single();

  if (error) throw error;

  if (items.length) {
    const { error: itemsError } = await supabase.from('order_items').insert(
      items.map((item) => ({
        order_id: order.id,
        // product IDs like "1.5L" are not UUIDs — send null to avoid postgres type error
        product_id: item.catalogProduct.dbId,
        product_code: item.catalogProduct.code || item.productId,
        quantity: item.quantity,
        subtotal: item.subtotal,
        used_credits: item.usedCredits,
      }))
    );

    if (itemsError) {
      await supabase.from('orders').delete().eq('id', order.id);
      throw itemsError;
    }
  }

  const balanceUpdate = {
    bottle_credits: balances.bottleCredits - usedCreditsTotal,
    wallet_balance: normalizedPaymentMethod === 'wallet'
      ? Number((balances.walletBalance - expectedTotal).toFixed(2))
      : balances.walletBalance,
    loyalty_points: balances.loyaltyPoints + earnedLoyaltyPoints,
  };

  let balanceQuery = supabase
    .from('users')
    .update(balanceUpdate)
    .eq('id', userId);

  if (usedCreditsTotal > 0) {
    balanceQuery = balanceQuery.gte('bottle_credits', usedCreditsTotal);
  }
  if (normalizedPaymentMethod === 'wallet' && expectedTotal > 0) {
    balanceQuery = balanceQuery.gte('wallet_balance', expectedTotal);
  }

  const { data: updatedBalances, error: balanceError } = await balanceQuery
    .select('wallet_balance, bottle_credits, loyalty_points')
    .single();

  if (balanceError) {
    await supabase.from('orders').delete().eq('id', order.id);
    throw validationError('Insufficient wallet balance or 5-gallon coupons. Please refresh and try again.');
  }

  return {
    ...order,
    balances: {
      walletBalance: Number(updatedBalances?.wallet_balance || 0),
      bottleCredits: Number(updatedBalances?.bottle_credits || 0),
      loyaltyPoints: Number(updatedBalances?.loyalty_points || 0),
    },
    earnedLoyaltyPoints,
  };
}

function parseAllowedOrigins() {
  const configured = (process.env.FRONTEND_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length) return configured;
  if (IS_PRODUCTION) return [];

  return [
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:8081',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:8081',
  ];
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const rateLimitBuckets = new Map();

function createRateLimiter({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const entry = rateLimitBuckets.get(key);

    if (!entry || entry.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }

    return next();
  };
}

const generalRateLimit = createRateLimiter({ windowMs: 60_000, max: 300, keyPrefix: 'general' });
const sensitiveRateLimit = createRateLimiter({ windowMs: 60_000, max: 30, keyPrefix: 'sensitive' });
const paymentRateLimit = createRateLimiter({ windowMs: 60_000, max: 20, keyPrefix: 'payment' });

app.use(generalRateLimit);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

    if (!IS_PRODUCTION && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '8mb' }));

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'rswater-api',
    environment: NODE_ENV,
  });
});

// --- Products ---
app.get('/api/products', requireSupabase, async (req, res) => {
  try {
    res.json(await loadCatalogProducts());
  } catch (error) {
    logError('Products list error', error);
    res.status(500).json({ error: 'Could not load products' });
  }
});

app.post('/api/pricing/quote', requireSupabase, sensitiveRateLimit, async (req, res) => {
  try {
    const items = await validateOrderItems(req.body?.items || []);
    const pricing = calculateOrderPricing(items);
    res.json({
      ...pricing,
      items: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.catalogProduct.price,
        subtotal: item.subtotal,
        couponsApplied: item.usedCredits,
        lineTotal: Number((item.subtotal - (item.usedCredits * item.catalogProduct.price)).toFixed(2)),
      })),
    });
  } catch (error) {
    logError('Pricing quote error', error);
    res.status(400).json({ error: getPublicErrorMessage(error, 'Could not calculate pricing') });
  }
});

app.get('/api/coupon-packs', requireSupabase, async (_req, res) => {
  try {
    res.json(await loadCouponPacks());
  } catch (error) {
    logError('Coupon packs list error', error);
    if (isSchemaSetupError(error)) {
      return res.status(503).json({ error: 'Coupon packs database setup is required' });
    }
    res.status(500).json({ error: 'Could not load coupon packs' });
  }
});

// --- Auth / User ---
app.post('/api/auth/otp/request', requireSupabase, sensitiveRateLimit, async (req, res) => {
  const phone = normalizeUaePhone(req.body?.phone);
  if (!/^\+9715\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid UAE mobile number required' });
  }

  try {
    await ensurePhoneAuthUser(phone, 'CUSTOMER');
    const { error } = await supabase.auth.signInWithOtp({
      phone,
      options: {
        shouldCreateUser: true,
        data: { phone, role: 'CUSTOMER' },
      },
    });

    if (error) {
      logError('OTP provider request failed', error);
      return res.status(400).json({ error: getPublicErrorMessage(error, 'Could not send OTP') });
    }
    res.json({ phone, message: 'OTP sent' });
  } catch (error) {
    logError('OTP request error', error);
    res.status(500).json({ error: 'Could not send OTP' });
  }
});

app.post('/api/auth/otp/verify', requireSupabase, sensitiveRateLimit, async (req, res) => {
  const phone = normalizeUaePhone(req.body?.phone);
  const token = String(req.body?.token || '').trim();

  if (!/^\+9715\d{8}$/.test(phone)) return res.status(400).json({ error: 'Valid UAE mobile number required' });
  if (!/^\d{6}$/.test(token)) return res.status(400).json({ error: 'Valid 6-digit OTP required' });

  try {
    const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error || !data?.session || !data?.user) {
      return res.status(401).json({ error: getPublicErrorMessage(error, 'Invalid or expired OTP') });
    }

    const profileEmail = data.user.email || phoneProfileEmail(phone);
    const profileName = data.user.user_metadata?.name || 'New Customer';
    const { error: profileError } = await supabase.from('users').upsert({
      id: data.user.id,
      email: profileEmail,
      role: 'CUSTOMER',
      name: profileName,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (profileError) {
      logError('OTP profile upsert failed', profileError);
      return res.status(500).json({ error: 'Could not prepare customer profile' });
    }

    res.json({
      user: {
        id: data.user.id,
        phone,
        name: profileName,
        isProfileComplete: profileName !== 'New Customer',
      },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      },
    });
  } catch (error) {
    logError('OTP verify error', error);
    res.status(500).json({ error: 'Could not verify OTP' });
  }
});

app.post('/api/auth/refresh', requireSupabase, sensitiveRateLimit, async (req, res) => {
  const refreshToken = String(req.body?.refreshToken || '').trim();
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) {
      return res.status(401).json({ error: getPublicErrorMessage(error, 'Session expired') });
    }

    res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
    });
  } catch (error) {
    logError('Token refresh error', error);
    res.status(401).json({ error: 'Session expired' });
  }
});

app.get('/api/auth/me', requireSupabase, requireCustomerAuth, async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('id, name')
      .eq('id', req.authUser.id)
      .single();

    if (error) throw error;

    res.json({
      id: req.authUser.id,
      phone: req.authUser.phone || req.authUser.user_metadata?.phone || '',
      name: profile?.name || req.authUser.user_metadata?.name || undefined,
    });
  } catch (error) {
    logError('Session profile error', error);
    res.status(500).json({ error: 'Could not load session' });
  }
});

app.post('/api/driver/auth/login', sensitiveRateLimit, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!DRIVER_LOGIN_USERNAME || !DRIVER_LOGIN_PASSWORD || !DRIVER_SESSION_SECRET) {
    return res.status(503).json({ error: 'Driver username login is not configured' });
  }
  const driver = CONFIGURED_DRIVERS.find((candidate) => safeCompare(candidate.username, username));
  if (!username || !password || !driver || !safeCompare(DRIVER_LOGIN_PASSWORD, password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  driverShiftStates.set(driver.id, {
    status: 'ON_DUTY',
    startedAt: new Date().toISOString(),
    endedAt: null,
  });
  driverGpsSharingStates.set(driver.id, true);

  return res.json({
    driver: { id: driver.id, phone: '', name: driver.name },
    session: { accessToken: createConfiguredDriverToken(driver) },
  });
});

app.post('/api/driver/auth/otp/request', sensitiveRateLimit, async (req, res) => {
  res.status(410).json({ error: 'Driver SMS login is disabled. Use username and password.' });
});

app.post('/api/driver/auth/otp/verify', sensitiveRateLimit, async (req, res) => {
  res.status(410).json({ error: 'Driver SMS login is disabled. Use username and password.' });
});

app.get('/api/driver/reverse-geocode', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  try {
    assertUaeCoordinates(latitude, longitude);
    res.json(await reverseGeocodeUae(latitude, longitude));
  } catch (error) {
    logError('Driver reverse geocode error', error);
    res.status(error.isValidationError ? 400 : 502).json({ error: getPublicErrorMessage(error, 'Could not resolve this GPS location') });
  }
});

app.get('/api/driver/customer-requests', requireDriverAuth, async (req, res) => {
  try {
    res.json(await driverCustomerRequests.list({ driverId: req.authUser.id }));
  } catch (error) {
    logError('Driver customer request list error', error);
    res.status(500).json({ error: 'Could not load customer requests' });
  }
});

app.post('/api/driver/customer-requests', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  try {
    const customerName = truncateText(req.body?.customerName, 100);
    const phone = normalizeUaePhone(req.body?.phone);
    const email = truncateText(req.body?.email, 160).toLowerCase();
    const notes = truncateText(req.body?.notes, 500);
    const address = truncateText(req.body?.address, 500);
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const accuracy = Number(req.body?.accuracy);
    if (customerName.length < 2) throw validationError('Enter the customer name');
    if (!/^\+9715\d{8}$/.test(phone)) throw validationError('Enter a valid UAE mobile number');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationError('Enter a valid email address');
    assertUaeCoordinates(latitude, longitude);
    if (!address) throw validationError('Capture and confirm the customer address');

    const geocoded = await reverseGeocodeUae(latitude, longitude).catch(() => ({
      address: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      city: '',
    }));
    const request = await driverCustomerRequests.submit({
      driverId: req.authUser.id,
      driverName: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver',
      customerName,
      phone,
      email,
      notes,
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(accuracy, 5000) : null,
      address,
      capturedAddress: geocoded.address,
      city: geocoded.city,
    });

    fireAndForgetNotification(async () => {
      if (!supabase) return;
      const { data: admins } = await supabase.from('users').select('id').in('role', [...ADMIN_ROLES]);
      if (admins?.length) await sendPushToUsers(admins.map((admin) => admin.id), {
        title: 'New customer approval request',
        body: `${request.driverName} submitted ${request.customerName} for dispatcher review.`,
        data: { type: 'driver_customer_request', requestId: request.id },
      }, 'admin');
    });
    res.status(201).json(request);
  } catch (error) {
    logError('Driver customer request submission error', error);
    res.status(error.statusCode || (error.isValidationError ? 400 : 500)).json({ error: getPublicErrorMessage(error, 'Could not submit customer for approval') });
  }
});

app.get('/api/admin/customer-requests', requireDispatchReadOnly, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    res.json(await driverCustomerRequests.list({ status }));
  } catch (error) {
    logError('Dispatcher customer request list error', error);
    res.status(500).json({ error: 'Could not load customer approval requests' });
  }
});

app.post('/api/admin/customer-requests/:requestId/decision', sensitiveRateLimit, requireDispatchReadOnly, async (req, res) => {
  try {
    const approved = req.body?.decision === 'approve';
    if (!approved && req.body?.decision !== 'reject') throw validationError('Decision must be approve or reject');
    const reason = truncateText(req.body?.reason, 500);
    const reviewedBy = truncateText(req.body?.reviewedBy, 100) || 'Dispatcher';
    const request = await driverCustomerRequests.decide({
      id: String(req.params.requestId),
      approved,
      reason,
      reviewedBy,
      activate: activateDriverCreatedCustomer,
    });
    fireAndForgetNotification(() => sendPushToUser(request.driverId, {
      title: approved ? 'Customer approved' : 'Customer request rejected',
      body: approved
        ? `${request.customerName} is now an active customer.`
        : `${request.customerName} was not approved${reason ? `: ${reason}` : '.'}`,
      data: { type: 'driver_customer_request_decision', requestId: request.id, status: request.status },
    }, 'driver'));
    res.json(request);
  } catch (error) {
    logError('Dispatcher customer request decision error', error);
    res.status(error.statusCode || (error.isValidationError ? 400 : 500)).json({ error: getPublicErrorMessage(error, 'Could not review customer request') });
  }
});

app.post('/api/auth/register', sensitiveRateLimit, async (req, res) => {
  res.status(410).json({ error: 'Use phone OTP registration through /api/auth/otp/request.' });
});

app.post('/api/auth/login', sensitiveRateLimit, async (req, res) => {
  res.status(410).json({ error: 'Use /api/auth/otp/request and /api/auth/otp/verify for phone OTP login.' });
});

app.get('/api/orders', requireSupabase, requireCustomerAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, items:order_items(*)')
      .eq('user_id', req.authUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json((data || []).map((order) => ({
      id: order.id,
      status: order.status,
      total: Number(order.total_amount || 0),
      paymentMethod: order.payment_method,
      paymentStatus: order.payment_status,
      address: order.delivery_address,
      deliverySlot: order.delivery_slot,
      notes: order.notes,
      createdAt: order.created_at,
      items: (order.items || []).map((item) => ({
        productId: item.product_code || item.product_id,
        quantity: item.quantity,
        subtotal: Number(item.subtotal || 0),
        usedCredits: Number(item.used_credits || 0),
      })),
    })));
  } catch (error) {
    logError('List orders error', error);
    res.status(500).json({ error: 'Could not load orders' });
  }
});

app.post('/api/orders', requireSupabase, sensitiveRateLimit, requireCustomerAuth, async (req, res) => {
  const { userId: requestedUserId, amount, orderPayload, paymentMethod } = req.body;
  const userId = requireSameCustomer(req, res, requestedUserId);
  if (!userId) return;
  const normalizedOrderPayload = normalizeOrderPayload(orderPayload);

  if (!userId || amount === undefined || amount === null || !normalizedOrderPayload.address || !normalizedOrderPayload.items.length) {
    return res.status(400).json({
      error: 'Missing order details',
      missing: {
        userId: !userId,
        amount: amount === undefined || amount === null,
        address: !normalizedOrderPayload.address,
        items: !normalizedOrderPayload.items.length,
      },
    });
  }

  try {
    const order = await createOrderInSupabase({
      userId,
      amount,
      paymentMethod: paymentMethod || 'cod',
      orderPayload: normalizedOrderPayload,
      initialStatus: 'PENDING',
    });

    fireAndForgetNotification(() => sendPushToUser(userId, orderNotificationPayload('PENDING', order.id), 'customer'));
    res.status(201).json({ order });
  } catch (error) {
    logError('Create order error', error);
    res.status(400).json({ error: getPublicErrorMessage(error, 'Failed to create order') });
  }
});

// GET single user (for session refresh / balance sync)
app.get('/api/users/:id', requireSupabase, requireCustomerAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!requireSameCustomer(req, res, req.params.id)) return;

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/users/:id', requireSupabase, sensitiveRateLimit, requireCustomerAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!requireSameCustomer(req, res, req.params.id)) return;

  try {
    // Only allow updating safe fields
    const { name, nameAr, address, building, apartment, city, locationLat, locationLng } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (nameAr !== undefined) updateData.name_ar = nameAr;
    if (address !== undefined) updateData.address = address;
    if (building !== undefined) updateData.building = building;
    if (apartment !== undefined) updateData.apartment = apartment;
    if (city !== undefined) updateData.city = city;
    if (locationLat !== undefined) updateData.location_lat = locationLat;
    if (locationLng !== undefined) updateData.location_lng = locationLng;
    updateData.updated_at = new Date().toISOString();

    const { data: user, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/users/:id', requireSupabase, sensitiveRateLimit, requireCustomerAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!requireSameCustomer(req, res, req.params.id)) return;

  try {
    await supabase.from('users').delete().eq('id', req.params.id);
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    logError('Delete account error', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

app.get('/api/subscriptions', requireSupabase, requireCustomerAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.authUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    logError('List subscriptions error', error);
    res.status(500).json({ error: 'Could not load subscriptions' });
  }
});

app.post('/api/subscriptions', requireSupabase, sensitiveRateLimit, requireCustomerAuth, async (req, res) => {
  const productId = String(req.body?.productId || '').trim();
  const quantity = Number(req.body?.quantity || 1);
  const frequency = String(req.body?.frequency || 'weekly').trim().toLowerCase();
  const deliveryAddress = String(req.body?.deliveryAddress || '').trim();

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Invalid quantity' });
  if (!['weekly', 'biweekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
  if (!deliveryAddress) return res.status(400).json({ error: 'Delivery address is required' });

  try {
    const catalog = await getProductCatalogMap();
    const catalogProduct = catalog.get(productId);
    if (!catalogProduct) return res.status(400).json({ error: 'Invalid product' });

    const nextDeliveryDate = new Date();
    nextDeliveryDate.setDate(nextDeliveryDate.getDate() + (frequency === 'monthly' ? 30 : frequency === 'biweekly' ? 14 : 7));

    const { data, error } = await supabase
      .from('subscriptions')
      .insert({
        user_id: req.authUser.id,
        product_code: catalogProduct.code || catalogProduct.id,
        quantity,
        frequency,
        status: 'ACTIVE',
        next_delivery_date: nextDeliveryDate.toISOString().slice(0, 10),
        delivery_address: deliveryAddress,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    logError('Create subscription error', error);
    res.status(500).json({ error: 'Could not create subscription' });
  }
});

app.get('/api/driver/routes/today', requireDriverAuth, async (req, res) => {
  try {
    const driverId = req.authUser.id;
    const planDate = dubaiDateKey();
    const [{ data, error }, routePlans, , failedAttempts] = await Promise.all([
      supabase
        ? supabase
          .from('orders')
          .select('*, user:users(name, phone), items:order_items(*)')
          .eq('assigned_driver_id', driverId)
          .in('status', ['PENDING', 'OUT_FOR_DELIVERY'])
          .order('created_at', { ascending: true })
        : NO_OPERATIONS_ORDERS,
      loadRoutePlansForDriverRoute(planDate),
      ensureDriverSessionsLoaded([driverId, ...CONFIGURED_DRIVERS.map((driver) => driver.id)]),
      loadFailedAttemptsForDriver(driverId, planDate),
    ]);

    if (error && error.code !== '42703') throw error;

    const databaseRoute = (data || []).map((order, index) => ({
      id: order.id,
      orderId: order.id,
      orderNumber: order.id,
      customerName: order.user?.name || 'Customer',
      address: order.delivery_address || '',
      latitude: Number.isFinite(Number(order.latitude)) ? Number(order.latitude) : null,
      longitude: Number.isFinite(Number(order.longitude)) ? Number(order.longitude) : null,
      routeSequence: index + 1,
      status: 'ASSIGNED',
      cashDue: order.payment_method === 'cod' ? Number(order.total_amount || 0) : 0,
      totalAmount: Number(order.total_amount || 0),
      paymentMethod: String(order.payment_method || '').toUpperCase(),
      paymentStatus: String(order.payment_status || '').toUpperCase(),
      deliverySlot: order.delivery_slot || '',
      deliveryInstructions: parseStoredOrderNotes(order.notes).deliveryInstructions || '',
      items: (order.items || []).map((item) => ({
        id: item.id,
        productId: item.product_code || item.product_id || '',
        name: item.product_code || item.product_id || 'Order item',
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.quantity || 0) > 0 ? Number((Number(item.subtotal || 0) / Number(item.quantity)).toFixed(2)) : 0,
        subtotal: Number(item.subtotal || 0),
        usedCredits: Number(item.used_credits || 0),
      })),
      source: 'operations',
    }));
    // Only fetch the full active-order pool for plan lookups when this driver has a plan.
    const ownPlan = routePlans.find((plan) => plan.driverId === driverId);
    const activeStopsPromise = ownPlan?.orderIds.length ? loadActiveDispatchStops() : null;
    const candidateStopsPromise = activeStopsPromise
      ? activeStopsPromise.catch((loadError) => {
        logError('Route plan stop lookup failed', loadError);
        return [];
      })
      : Promise.resolve([]);
    const plannedRoute = await getConfiguredDriverRoute(driverId, activeStopsPromise || undefined);
    const combinedByOrder = new Map();

    plannedRoute.forEach((stop) => combinedByOrder.set(String(stop.orderId || stop.id), stop));
    databaseRoute.forEach((stop) => {
      const orderKey = String(stop.orderId || stop.id);
      combinedByOrder.set(orderKey, { ...combinedByOrder.get(orderKey), ...stop });
    });

    const combinedStops = [...combinedByOrder.values()];
    const routableStops = combinedStops.filter((stop) => (
      Number.isFinite(Number(stop.latitude)) && Number.isFinite(Number(stop.longitude))
    ));
    const unroutableStops = combinedStops.filter((stop) => (
      !Number.isFinite(Number(stop.latitude)) || !Number.isFinite(Number(stop.longitude))
    ));
    const currentLocation = latestDriverLocations.get(req.authUser.id);
    const optimizedStops = optimizeStopOrder(
      routableStops.map((stop) => ({
        ...stop,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
      })),
      currentLocation
        ? { latitude: Number(currentLocation.lat), longitude: Number(currentLocation.lng) }
        : null,
    );

    const { stops: routeStops, routeSource } = buildDriverRoute({
      driverId,
      plans: routePlans,
      automaticStops: [...optimizedStops, ...unroutableStops],
      candidateStops: await candidateStopsPromise,
    });

    // Stops this driver reported as FAILED today leave the list until the dispatcher re-plans them.
    const responseStops = excludeFailedStops(routeStops, failedAttempts, ownPlan).map((stop, index) => ({
      ...stop,
      sequence: index + 1,
      routeSequence: index + 1,
      routeSource,
      assignmentToken: createDeliveryAssignmentToken({
        orderId: String(stop.orderId || stop.id),
        driverId: req.authUser.id,
        source: stop.source || 'operations',
      }),
    }));
    await driverReports.recordAssignments(
      { id: req.authUser.id, name: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver' },
      responseStops,
    );
    // The body stays a bare array for app v1.0.0, so the route source is also sent as a header.
    res.set('X-Route-Source', routeSource);
    return res.json(responseStops);
  } catch (error) {
    logError('Driver route list error', error);
    res.status(500).json({ error: 'Could not load driver route' });
  }
});

app.get('/api/driver/shift', requireDriverAuth, async (req, res) => {
  await ensureDriverSessionsLoaded([req.authUser.id]);
  res.json(getDriverShiftState(req.authUser.id));
});

app.post('/api/driver/shift/start', sensitiveRateLimit, requireDriverAuth, (req, res) => {
  const shift = {
    status: 'ON_DUTY',
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  driverShiftStates.set(req.authUser.id, shift);
  driverGpsSharingStates.set(req.authUser.id, false);
  persistDriverSession(req.authUser.id, {
    shift_status: shift.status,
    shift_started_at: shift.startedAt,
    shift_ended_at: null,
    gps_sharing: false,
  });
  res.json(shift);
});

app.post('/api/driver/shift/end', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  await ensureDriverSessionsLoaded([req.authUser.id]);
  const previous = getDriverShiftState(req.authUser.id);
  const endedAt = previous.status === 'OFF_DUTY' && previous.endedAt
    ? previous.endedAt
    : new Date().toISOString();
  const shift = {
    status: 'OFF_DUTY',
    startedAt: previous.startedAt,
    endedAt,
  };

  driverShiftStates.set(req.authUser.id, shift);
  driverGpsSharingStates.set(req.authUser.id, false);
  latestDriverLocations.delete(req.authUser.id);
  persistDriverSession(req.authUser.id, {
    shift_status: shift.status,
    shift_started_at: shift.startedAt,
    shift_ended_at: shift.endedAt,
    gps_sharing: false,
    ...CLEARED_DRIVER_SESSION_LOCATION,
  });

  let dayReport = null;
  try {
    dayReport = await driverReports.generateReport({
      id: req.authUser.id,
      name: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver',
    });
  } catch (error) {
    if (error?.statusCode !== 409) logError('End-shift report generation error', error);
  }

  res.json({ ...shift, dayReport });
});

app.post('/api/driver/location/start', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  await ensureDriverSessionsLoaded([req.authUser.id]);
  if (getDriverShiftState(req.authUser.id).status === 'OFF_DUTY') {
    return res.status(409).json({ error: 'Start a shift before sharing GPS.', code: 'SHIFT_ENDED' });
  }
  driverGpsSharingStates.set(req.authUser.id, true);
  persistDriverSession(req.authUser.id, { gps_sharing: true });
  res.json({ sharing: true });
});

app.post('/api/driver/location/stop', sensitiveRateLimit, requireDriverAuth, (req, res) => {
  driverGpsSharingStates.set(req.authUser.id, false);
  latestDriverLocations.delete(req.authUser.id);
  persistDriverSession(req.authUser.id, { gps_sharing: false, ...CLEARED_DRIVER_SESSION_LOCATION });
  res.json({ sharing: false });
});

app.post('/api/driver/location', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Valid coordinates required' });

  await ensureDriverSessionsLoaded([req.authUser.id]);
  if (getDriverShiftState(req.authUser.id).status === 'OFF_DUTY') {
    return res.status(409).json({
      error: 'This shift has ended. Start a new shift before sharing GPS.',
      code: 'SHIFT_ENDED',
    });
  }
  if (driverGpsSharingStates.get(req.authUser.id) === false) {
    return res.status(409).json({
      error: 'GPS sharing is stopped. Enable it before sending a location.',
      code: 'GPS_SHARING_STOPPED',
    });
  }

  try {
    latestDriverLocations.set(req.authUser.id, {
      driver_id: req.authUser.id,
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      recorded_at: req.body?.recordedAt || new Date().toISOString(),
    });
    const location = latestDriverLocations.get(req.authUser.id);
    persistDriverSession(req.authUser.id, {
      last_latitude: lat,
      last_longitude: lng,
      last_accuracy: location.accuracy,
      last_location_at: toIsoOrNull(location.recorded_at) || new Date().toISOString(),
    });
    recordDriverLocationPoint(req.authUser.id, location);
    await driverReports.recordLocation(
      { id: req.authUser.id, name: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver' },
      latestDriverLocations.get(req.authUser.id),
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    logError('Driver location error', error);
    res.status(500).json({ error: 'Could not record driver location' });
  }
});

// --- Delivery records (invoices, delivery_attempts) ---
// Optional until supabase-migrations/20261021_driver_delivery_records.sql is applied: completion
// keeps working without invoices, failed-delivery endpoints answer 503. Uses the same
// warn-once / re-check helpers as the dispatch tables.
const DELIVERY_RECORDS_MIGRATION_FILE = driverStore.kind === 'supabase' ? 'supabase-migrations/20261021_driver_delivery_records.sql' : DRIVER_OPS_SCHEMA_FILE;

function deliveryRecordsUnavailableError() {
  const error = new Error(`Delivery records are unavailable until ${DELIVERY_RECORDS_MIGRATION_FILE} is applied to the database.`);
  error.isDeliveryRecordsUnavailable = true;
  return error;
}

function sendDeliveryRecordError(res, error, context, fallback) {
  if (error?.isDeliveryRecordsUnavailable) {
    return res.status(503).json({ error: error.message, code: 'DELIVERY_RECORDS_UNAVAILABLE' });
  }
  logError(context, error);
  return res.status(error?.isValidationError ? 400 : 500).json({ error: getPublicErrorMessage(error, fallback) });
}

function driverIdentity(req) {
  return {
    id: req.authUser.id,
    name: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver',
  };
}

async function driverNameFor(driverId) {
  const configured = CONFIGURED_DRIVERS.find((driver) => driver.id === driverId);
  if (configured) return configured.name;
  if (!UUID_RE.test(String(driverId || '')) || !supabase) return 'Driver';
  const { data } = await supabase.from('users').select('name').eq('id', driverId).maybeSingle();
  return data?.name || 'Driver';
}

// Stop snapshot for completion / failure records, from the same pool routes/today resolves
// planned and automatic stops from (website feed + active Supabase orders).
async function resolveDriverStop(orderId, source) {
  try {
    const activeStops = await loadActiveDispatchStops();
    const stop = activeStops.find((candidate) => normalizeOrderId(candidate.orderId ?? candidate.id) === orderId);
    if (stop) return { ...stop, resolved: true };
  } catch (error) {
    logError('Delivery stop lookup failed', error);
  }
  return {
    id: orderId,
    orderId,
    orderNumber: orderId,
    customerName: 'Customer',
    address: 'Address not recorded',
    source,
    items: [],
    resolved: false,
  };
}

function stopItemsQuantity(stop) {
  if (!Array.isArray(stop?.items) || !stop.items.length) return null;
  return stop.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function attemptLocation(req) {
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (req.body?.latitude != null && req.body?.longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return { latitude, longitude };
  }
  const location = latestDriverLocations.get(req.authUser.id);
  const lastLatitude = Number(location?.lat);
  const lastLongitude = Number(location?.lng);
  return Number.isFinite(lastLatitude) && Number.isFinite(lastLongitude)
    ? { latitude: lastLatitude, longitude: lastLongitude }
    : { latitude: null, longitude: null };
}

async function uploadDeliverySignature({ orderId, driverId, signature }) {
  await ensureDeliveryProofBucket();
  const safeOrderId = orderId.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `signatures/${safeOrderId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${signature.extension}`;
  await driverFiles.upload(DELIVERY_PROOF_BUCKET, path, signature.bytes, {
    contentType: signature.mimeType,
    cacheControl: '3600',
    upsert: false,
    metadata: { orderId, driverId, kind: 'signature' },
  });
  return { bucket: DELIVERY_PROOF_BUCKET, path, mimeType: signature.mimeType, size: signature.bytes.length };
}

// delivery_attempts.client_request_id stores the Idempotency-Key of the complete / fail request.
// A database whose table predates the column ignores keys (today's behaviour): warned once and
// re-checked like a missing table, tracked under a pseudo table name.
const ATTEMPT_KEY_COLUMN = 'delivery_attempts.client_request_id';

function markAttemptKeyColumnResult(error) {
  if (!error) {
    missingDispatchTables.delete(ATTEMPT_KEY_COLUMN);
    return false;
  }
  if (!isMissingColumnError(error, 'client_request_id')) return false;
  missingDispatchTables.set(ATTEMPT_KEY_COLUMN, Date.now() + DISPATCH_TABLE_RECHECK_MS);
  if (!warnedMissingDispatchTables.has(ATTEMPT_KEY_COLUMN)) {
    warnedMissingDispatchTables.add(ATTEMPT_KEY_COLUMN);
    console.warn(`${driverStore.schemaLabel.replace(' table ', ' column ')}.${ATTEMPT_KEY_COLUMN} is missing; Idempotency-Key headers are ignored. Apply ${DELIVERY_RECORDS_MIGRATION_FILE} to enable them.`);
  }
  return true;
}

function withoutAttemptKey(row) {
  const copy = { ...row };
  delete copy.client_request_id;
  return copy;
}

// Inserts a delivery_attempts row; a key is dropped (and the insert retried) when the column is
// missing. Returns the store's { error } for the caller to classify.
async function writeDeliveryAttempt(row) {
  let payload = row.client_request_id ? row : withoutAttemptKey(row);
  if (payload.client_request_id && !dispatchTableAvailable(ATTEMPT_KEY_COLUMN)) payload = withoutAttemptKey(payload);
  let { error } = await driverStore.insertDeliveryAttempt(payload);
  if (payload.client_request_id && markAttemptKeyColumnResult(error)) {
    ({ error } = await driverStore.insertDeliveryAttempt(withoutAttemptKey(payload)));
  }
  return { error };
}

// The attempt an earlier request with the same Idempotency-Key recorded, or null (no key, no
// such attempt, table or column missing, lookup failed).
async function findDeliveryAttemptByKey(driverId, requestKey) {
  if (!requestKey || !dispatchTableAvailable('delivery_attempts') || !dispatchTableAvailable(ATTEMPT_KEY_COLUMN)) return null;
  try {
    const { data, error } = await driverStore.findDeliveryAttemptByKey(driverId, requestKey);
    if (markDispatchTableResult('delivery_attempts', error, DELIVERY_RECORDS_MIGRATION_FILE)) return null;
    if (markAttemptKeyColumnResult(error)) return null;
    if (error) throw error;
    return data || null;
  } catch (error) {
    logError('Delivery attempt key lookup failed', error);
    return null;
  }
}

// Returns true when stored. Never throws: a missing table or insert error must not fail the caller.
async function insertDeliveryAttempt(row) {
  if (!dispatchTableAvailable('delivery_attempts')) return false;
  try {
    const { error } = await writeDeliveryAttempt(row);
    if (markDispatchTableResult('delivery_attempts', error, DELIVERY_RECORDS_MIGRATION_FILE)) return false;
    // A concurrent request with the same Idempotency-Key already stored this attempt.
    if (isUniqueViolationError(error)) return false;
    if (error) throw error;
    return true;
  } catch (error) {
    logError('Delivery attempt insert failed', error);
    return false;
  }
}

async function listDeliveryAttempts({ date, driverId, outcome }) {
  if (!dispatchTableAvailable('delivery_attempts')) throw deliveryRecordsUnavailableError();
  const { start, end } = dubaiDayRange(date);
  const runQuery = (withKey) => driverStore.listDeliveryAttempts({ start, end, driverId, outcome, withKey });
  const withKey = dispatchTableAvailable(ATTEMPT_KEY_COLUMN);
  let { data, error } = await runQuery(withKey);
  if (withKey && markAttemptKeyColumnResult(error)) ({ data, error } = await runQuery(false));
  if (markDispatchTableResult('delivery_attempts', error, DELIVERY_RECORDS_MIGRATION_FILE)) throw deliveryRecordsUnavailableError();
  if (error) throw error;
  return dedupeDeliveryAttempts(data || []);
}

// Today's FAILED attempts for routes/today. Any failure means "none" so routing never breaks.
async function loadFailedAttemptsForDriver(driverId, date) {
  try {
    const rows = await listDeliveryAttempts({ date, driverId, outcome: 'FAILED' });
    return rows.map((row) => ({ orderId: normalizeOrderId(row.order_id), attemptedAt: row.attempted_at }));
  } catch (error) {
    if (!error?.isDeliveryRecordsUnavailable) logError('Failed delivery lookup failed', error);
    return [];
  }
}

// Buckets whose files may be fetched through /api/files/:bucket/download (signed links).
const SIGNED_FILE_BUCKETS = new Set([DELIVERY_PROOF_BUCKET, DRIVER_CUSTOMER_REQUEST_BUCKET]);

// { bucket, path } as stored; with the disk file store also a signed download url, because
// those files are not reachable anywhere else. Supabase mode responses are unchanged.
function fileReference(bucket, objectPath) {
  const reference = { bucket, path: objectPath };
  if (driverFiles.kind !== 'disk' || !SIGNED_FILE_BUCKETS.has(bucket)) return reference;
  try {
    const url = driverFiles.signedUrl(bucket, objectPath);
    return url ? { ...reference, url } : reference;
  } catch {
    return reference;
  }
}

function mapDeliveryAttemptRecord(record) {
  return {
    id: record.id,
    orderId: String(record.order_id),
    orderSource: record.order_source || null,
    driverId: record.driver_id,
    outcome: record.outcome,
    reasonCode: record.reason_code || null,
    reasonLabel: record.reason_code ? FAILURE_REASONS[record.reason_code] || record.reason_code : null,
    note: record.note || null,
    paymentMethod: record.payment_method || null,
    cashCollected: Number(record.cash_collected || 0),
    cardAmount: Number(record.card_amount || 0),
    cardReference: record.card_reference || null,
    emptyBottlesReturned: Number(record.empty_bottles_returned || 0),
    proof: record.proof_path ? fileReference(record.proof_bucket, record.proof_path) : null,
    signature: record.signature_path ? fileReference(record.signature_bucket, record.signature_path) : null,
    latitude: finiteOrNull(record.latitude),
    longitude: finiteOrNull(record.longitude),
    attemptedAt: record.attempted_at,
  };
}

function ensureInvoiceBucket() {
  return driverFiles.ensureBucket(INVOICE_BUCKET, {
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf'],
  });
}

// { invoiceNumber, url, shareText }: the completion response and the per-delivery endpoint.
// url is a public HMAC-signed download link valid for 7 days.
function invoiceLink(record) {
  const url = signedInvoiceUrl({ apiBaseUrl: API_BASE_URL, secret: DRIVER_SESSION_SECRET, invoiceId: record.id });
  return {
    invoiceNumber: record.invoice_number,
    url,
    shareText: buildInvoiceShareText({ invoice: record, company: INVOICE_COMPANY, url }),
  };
}

function mapInvoiceRecord(record) {
  return {
    id: record.id,
    invoiceNumber: record.invoice_number,
    orderId: record.order_id,
    orderSource: record.order_source,
    driverId: record.driver_id,
    customerName: record.customer_name || '',
    customerPhone: record.customer_phone || '',
    customerAddress: record.customer_address || '',
    items: Array.isArray(record.items) ? record.items : [],
    subtotalExclVat: Number(record.subtotal_excl_vat || 0),
    vatAmount: Number(record.vat_amount || 0),
    totalInclVat: Number(record.total_incl_vat || 0),
    currency: record.currency || 'AED',
    paymentMethod: record.payment_method || null,
    amountPaid: Number(record.amount_paid || 0),
    issuedAt: record.issued_at,
    ...invoiceLink(record),
  };
}

async function findInvoiceByOrder(orderId, driverId) {
  if (!dispatchTableAvailable('invoices')) throw deliveryRecordsUnavailableError();
  const { data, error } = await driverStore.findInvoiceByOrder(orderId, driverId);
  if (markDispatchTableResult('invoices', error, DELIVERY_RECORDS_MIGRATION_FILE)) throw deliveryRecordsUnavailableError();
  if (error) throw error;
  return data || null;
}

async function listInvoices({ date, driverId }) {
  if (!dispatchTableAvailable('invoices')) throw deliveryRecordsUnavailableError();
  const { start, end } = dubaiDayRange(date);
  const { data, error } = await driverStore.listInvoices({ start, end, driverId });
  if (markDispatchTableResult('invoices', error, DELIVERY_RECORDS_MIGRATION_FILE)) throw deliveryRecordsUnavailableError();
  if (error) throw error;
  return (data || []).map(mapInvoiceRecord);
}

async function storeInvoicePdf(record, pdf) {
  await ensureInvoiceBucket();
  const year = String(record.invoice_number).match(/^INV-(\d{4})-/)?.[1] || String(new Date(record.issued_at).getUTCFullYear());
  const path = `${year}/${String(record.invoice_number).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
  await driverFiles.upload(INVOICE_BUCKET, path, pdf, {
    contentType: 'application/pdf',
    cacheControl: '0',
    upsert: true,
  });
  const { data, error: updateError } = await driverStore.setInvoicePdf(record.id, INVOICE_BUCKET, path);
  if (updateError) throw updateError;
  return data;
}

// Issues (or returns the existing) invoice for a completed delivery. Never throws: returns
// null when the tables are missing, the total is unknown or anything else fails.
async function issueDeliveryInvoice({ orderId, source, stop, driver, paymentMethod, amountPaid, total, vatAmount, issuedAt }) {
  if (!dispatchTableAvailable('invoices')) return null;
  try {
    const existing = await findInvoiceByOrder(orderId);
    if (existing) return invoiceLink(existing);
    if (total == null || !Number.isFinite(Number(total))) {
      console.warn(`Invoice skipped for ${source} order ${orderId}: the order total is unknown.`);
      return null;
    }

    const totals = computeInvoiceTotals({
      items: (stop.items || []).map((item) => {
        // Website item names arrive as "Product · Size".
        const [name, ...size] = String(item.name || 'Item').split(' · ');
        return {
          name,
          size: size.join(' · '),
          qty: item.quantity,
          unit_price: item.unitPrice,
          line_total: item.subtotal,
        };
      }),
      total,
      vatMode: source === 'website' ? 'inclusive' : 'added',
      vatAmount,
    });
    const { data: invoiceNumber, error: numberError } = await driverStore.nextInvoiceNumber();
    if (markDispatchTableResult('invoices', numberError, DELIVERY_RECORDS_MIGRATION_FILE)) return null;
    if (numberError) throw numberError;
    if (typeof invoiceNumber !== 'string' || !invoiceNumber) throw new Error('next_invoice_number() returned no number');

    const { data: inserted, error: insertError } = await driverStore.insertInvoice({
      invoice_number: invoiceNumber,
      order_id: orderId,
      order_source: source,
      driver_id: driver.id,
      customer_name: stop.customerName || null,
      customer_phone: stop.customerPhone || null,
      customer_address: stop.address || null,
      items: totals.items,
      subtotal_excl_vat: totals.subtotal_excl_vat,
      vat_amount: totals.vat_amount,
      total_incl_vat: totals.total_incl_vat,
      currency: 'AED',
      payment_method: paymentMethod,
      amount_paid: paymentMethod === 'prepaid' ? totals.total_incl_vat : amountPaid,
      issued_at: issuedAt,
    });
    if (markDispatchTableResult('invoices', insertError, DELIVERY_RECORDS_MIGRATION_FILE)) return null;
    if (insertError?.code === '23505') {
      // A concurrent completion won the unique(order_id) race; its invoice is the invoice.
      const raced = await findInvoiceByOrder(orderId);
      if (raced) return invoiceLink(raced);
    }
    if (insertError) throw insertError;

    let record = inserted;
    try {
      const pdf = await renderInvoicePdf({ ...inserted, driver_name: driver.name }, INVOICE_COMPANY);
      record = await storeInvoicePdf(inserted, pdf);
    } catch (pdfError) {
      // The download endpoint renders the PDF on demand when none is stored.
      logError('Invoice PDF storage failed', pdfError);
    }
    return invoiceLink(record);
  } catch (error) {
    if (!error?.isDeliveryRecordsUnavailable) logError('Invoice generation failed', error);
    return null;
  }
}

// True when today's dispatch plan for the driver still has deliverable stops besides the
// one just completed. Errors count as "remaining" so a day report is never generated early.
// closedOrderIds: stops that no longer count (failed today by this driver).
async function hasRemainingPlannedStops(driverId, completedOrderId, closedOrderIds = new Set()) {
  try {
    const plans = await loadRoutePlansForDriverRoute(dubaiDateKey());
    const ownPlan = plans.find((plan) => plan.driverId === driverId);
    const isOpen = (orderId) => orderId !== completedOrderId && !closedOrderIds.has(orderId);
    if (!ownPlan || !ownPlan.orderIds.some(isOpen)) return false;
    const { stops } = buildDriverRoute({ driverId, plans, candidateStops: await loadActiveDispatchStops() });
    return stops.some((plannedStop) => isOpen(normalizeOrderId(plannedStop.orderId ?? plannedStop.id)));
  } catch (error) {
    logError('Route plan remaining-stop check failed', error);
    return true;
  }
}

// --- Idempotent complete / fail (Idempotency-Key header) ---
// A retried or replayed request whose key already recorded an attempt gets that attempt's
// result again; the website, storage and the day journal are not touched a second time.
function sendIdempotencyKeyReused(res) {
  return res.status(422).json({
    error: 'This Idempotency-Key was already used for a different delivery request',
    code: 'IDEMPOTENCY_KEY_REUSED',
  });
}

function isReplayOf(attempt, orderId, outcome) {
  return normalizeOrderId(attempt.order_id) === orderId && attempt.outcome === outcome;
}

function failureResult(attempt) {
  return {
    orderId: String(attempt.order_id),
    outcome: 'FAILED',
    reasonCode: attempt.reason_code,
    attemptedAt: toIsoOrNull(attempt.attempted_at),
  };
}

async function completionReplayResult(attempt, driverId) {
  const orderId = String(attempt.order_id);
  let invoice = null;
  try {
    const record = await findInvoiceByOrder(orderId, driverId);
    if (record) invoice = invoiceLink(record);
  } catch (error) {
    if (!error?.isDeliveryRecordsUnavailable) logError('Replayed completion invoice lookup failed', error);
  }
  return {
    id: orderId,
    orderId,
    status: 'DELIVERED',
    completedAt: toIsoOrNull(attempt.attempted_at),
    proofStored: Boolean(attempt.proof_path),
    signatureStored: Boolean(attempt.signature_path),
    paymentMethod: attempt.payment_method || null,
    invoice,
    dayReport: null,
    replayed: true,
  };
}

async function finishDriverDayRecord(req, stop, completion) {
  const driver = driverIdentity(req);
  await driverReports.recordCompletion(driver, stop, completion);

  // Stops that failed today are closed for this driver until the dispatcher re-plans them.
  const failedOrderIds = new Set((await loadFailedAttemptsForDriver(req.authUser.id, dubaiDateKey()))
    .map((attempt) => attempt.orderId));
  const [plannedRoute, assignedOrders, remainingDispatchPlan] = await Promise.all([
    getConfiguredDriverRoute(req.authUser.id).catch(() => []),
    supabase
      ? supabase.from('orders')
        .select('id')
        .eq('assigned_driver_id', req.authUser.id)
        .in('status', ['PENDING', 'OUT_FOR_DELIVERY'])
      : NO_OPERATIONS_ORDERS,
    hasRemainingPlannedStops(req.authUser.id, normalizeOrderId(stop?.orderId ?? stop?.id), failedOrderIds),
  ]);
  const remainingRoute = plannedRoute.filter((routeStop) => !failedOrderIds.has(normalizeOrderId(routeStop.orderId ?? routeStop.id)));
  const remainingAssigned = assignedOrders.error
    ? 1
    : (assignedOrders.data || []).filter((order) => !failedOrderIds.has(normalizeOrderId(order.id))).length;
  if (remainingRoute.length || remainingAssigned || remainingDispatchPlan) return null;

  try {
    return await driverReports.generateReport(driver, driverReports.dateKey(new Date(completion.completedAt)));
  } catch (error) {
    logError('Automatic driver report generation failed', error);
    return null;
  }
}

app.post('/api/driver/deliveries/:orderId/complete', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  const idempotency = parseIdempotencyKey(req.get('Idempotency-Key'));
  if (idempotency.error) return res.status(400).json({ error: idempotency.error, code: idempotency.code });
  const requestKey = idempotency.key;

  const emptyBottlesReturned = Number(req.body?.emptyBottlesReturned || 0);
  const cashCollected = Number(req.body?.cashCollected || 0);
  if (!Number.isInteger(emptyBottlesReturned) || emptyBottlesReturned < 0 || emptyBottlesReturned > 999) {
    return res.status(400).json({ error: 'Invalid empty bottle count' });
  }
  if (!Number.isFinite(cashCollected) || cashCollected < 0 || cashCollected > 100000) {
    return res.status(400).json({ error: 'Invalid cash amount' });
  }
  // Optional fields (app v1.0.0 sends none of them): paymentMethod, cardAmount, cardReference, signature.
  const payment = parseCompletionPayment(req.body || {});
  if (payment.error) return res.status(400).json({ error: payment.error, code: payment.code });
  const signature = decodeSignature(req.body?.signature);
  if (signature?.error) return res.status(400).json({ error: signature.error, code: signature.code });
  if (!signature && REQUIRE_DELIVERY_SIGNATURE) {
    return res.status(400).json({ error: 'A customer signature is required to complete this delivery', code: 'SIGNATURE_REQUIRED' });
  }

  const assignment = verifyDeliveryAssignmentToken(req.body?.assignmentToken, {
    orderId,
    driverId: req.authUser.id,
  });
  if (!assignment || !['operations', 'website'].includes(assignment.source)) {
    return res.status(403).json({ error: 'This delivery is not assigned to the signed-in driver' });
  }

  let storedProof;
  let storedSignature;
  try {
    const replayed = await findDeliveryAttemptByKey(req.authUser.id, requestKey);
    if (replayed) {
      if (!isReplayOf(replayed, orderId, 'DELIVERED')) return sendIdempotencyKeyReused(res);
      return res.json(await completionReplayResult(replayed, req.authUser.id));
    }

    const driver = driverIdentity(req);
    const assignedStop = await resolveDriverStop(orderId, assignment.source);
    const location = attemptLocation(req);
    const attemptRow = (completedAt, decision) => ({
      order_id: orderId,
      order_source: assignment.source,
      driver_id: req.authUser.id,
      outcome: 'DELIVERED',
      payment_method: decision.paymentMethod,
      cash_collected: cashCollected,
      card_amount: payment.cardAmount,
      card_reference: payment.cardReference,
      empty_bottles_returned: emptyBottlesReturned,
      signature_bucket: storedSignature?.bucket || null,
      signature_path: storedSignature?.path || null,
      proof_bucket: storedProof?.bucket || null,
      proof_path: storedProof?.path || null,
      latitude: location.latitude,
      longitude: location.longitude,
      attempted_at: completedAt,
      client_request_id: requestKey,
    });

    if (assignment.source === 'website') {
      // Website totals are VAT-inclusive. The amount due is only known when the stop was
      // resolved from the feed, and is only enforced for apps that send paymentMethod
      // (app v1.0.0 keeps today's unchecked behaviour for website orders).
      const isCod = assignedStop.resolved
        ? String(assignedStop.paymentMethod || '').toLowerCase() === 'cash_on_delivery'
        : null;
      const amountDue = assignedStop.resolved ? Number(assignedStop.cashDue || 0) : null;
      const decision = resolveCompletionPayment({
        requestedMethod: payment.paymentMethod,
        isCod,
        amountDue: amountDue || 0,
        cashCollected,
        cardAmount: payment.cardAmount,
        totalAmount: assignedStop.totalAmount,
        enforce: Boolean(payment.paymentMethod) && assignedStop.resolved,
      });
      if (decision.error) return res.status(400).json({ error: decision.error, code: decision.code });

      storedProof = await uploadDeliveryProof({
        orderId,
        driverId: req.authUser.id,
        proofPhoto: req.body?.proofPhoto,
      });
      if (signature) storedSignature = await uploadDeliverySignature({ orderId, driverId: req.authUser.id, signature });
      const completedAt = new Date().toISOString();
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'delivery-driver-operations/1.0',
      };
      if (WEBSITE_DISPATCH_WRITE_KEY) headers['x-dispatch-write-key'] = WEBSITE_DISPATCH_WRITE_KEY;
      const websiteResponse = await fetch(`${WEBSITE_DISPATCH_WRITE_BASE_URL}/orders/${encodeURIComponent(orderId)}/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          driverId: req.authUser.id,
          completedAt,
          proof: storedProof,
          emptyBottlesReturned,
          cashCollected,
        }),
      });
      const websiteResult = await websiteResponse.json().catch(() => ({}));
      if (!websiteResponse.ok) throw validationError(websiteResult.error || 'Could not complete website delivery');
      if (websiteResult.alreadyCompleted) {
        await driverFiles.remove(storedProof.bucket, [storedProof.path]);
        storedProof = null;
        if (storedSignature) {
          await driverFiles.remove(storedSignature.bucket, [storedSignature.path]).catch(() => {});
          storedSignature = null;
        }
      }
      const resolvedCompletedAt = websiteResult.completedAt || completedAt;
      const invoice = await issueDeliveryInvoice({
        orderId,
        source: 'website',
        stop: assignedStop,
        driver,
        paymentMethod: decision.paymentMethod,
        amountPaid: decision.amountPaid,
        total: assignedStop.resolved ? Number(assignedStop.totalAmount || 0) : null,
        issuedAt: resolvedCompletedAt,
      });
      if (!websiteResult.alreadyCompleted) await insertDeliveryAttempt(attemptRow(resolvedCompletedAt, decision));
      const dayReport = await finishDriverDayRecord(req, assignedStop, {
        completedAt: resolvedCompletedAt,
        status: websiteResult.status || 'DELIVERED',
        emptyBottlesReturned,
        cashCollected,
        paymentMethod: decision.paymentMethod,
        cardAmount: payment.cardAmount,
        cardReference: payment.cardReference,
        amountDue: decision.paymentMethod === 'cash' ? amountDue : 0,
        itemsQuantity: stopItemsQuantity(assignedStop),
        invoiceNumber: invoice?.invoiceNumber || null,
        requestKey,
      });
      return res.json({
        ...websiteResult,
        completedAt: resolvedCompletedAt,
        proofStored: !websiteResult.alreadyCompleted,
        signatureStored: Boolean(storedSignature),
        paymentMethod: decision.paymentMethod,
        invoice,
        dayReport,
      });
    }

    // Operations orders live in Supabase; without it there are none to complete.
    if (!supabase) return res.status(404).json({ error: 'Order not found' });
    const { data: currentOrder, error: lookupError } = await supabase
      .from('orders')
      .select('id, status, total_amount, payment_method, payment_status, notes')
      .eq('id', orderId)
      .single();
    if (lookupError || !currentOrder) return res.status(404).json({ error: 'Order not found' });
    if (!['PENDING', 'OUT_FOR_DELIVERY'].includes(String(currentOrder.status || '').toUpperCase())) {
      return res.status(409).json({ error: `Order is already ${String(currentOrder.status || 'closed').toLowerCase()}` });
    }

    const totalDue = Number(currentOrder.total_amount || 0);
    const isCod = String(currentOrder.payment_method || '').toLowerCase() === 'cod';
    const decision = resolveCompletionPayment({
      requestedMethod: payment.paymentMethod,
      isCod,
      amountDue: isCod ? totalDue : 0,
      cashCollected,
      cardAmount: payment.cardAmount,
      totalAmount: totalDue,
    });
    if (decision.error) return res.status(400).json({ error: decision.error, code: decision.code });

    storedProof = await uploadDeliveryProof({
      orderId,
      driverId: req.authUser.id,
      proofPhoto: req.body?.proofPhoto,
    });
    if (signature) storedSignature = await uploadDeliverySignature({ orderId, driverId: req.authUser.id, signature });
    const completedAt = new Date().toISOString();
    const existingNotes = parseStoredOrderNotes(currentOrder.notes);
    const updateData = {
      status: 'DELIVERED',
      notes: JSON.stringify({
        ...existingNotes,
        deliveryProof: {
          bucket: storedProof.bucket,
          path: storedProof.path,
          mimeType: storedProof.mimeType,
          size: storedProof.size,
          driverId: req.authUser.id,
          capturedAt: completedAt,
        },
        ...(storedSignature ? {
          deliverySignature: {
            bucket: storedSignature.bucket,
            path: storedSignature.path,
            mimeType: storedSignature.mimeType,
            size: storedSignature.size,
            capturedAt: completedAt,
          },
        } : {}),
        deliveryPayment: {
          method: decision.paymentMethod,
          cashCollected,
          cardAmount: payment.cardAmount,
          cardReference: payment.cardReference,
        },
        emptyBottlesReturned,
        cashCollected,
        completedAt,
      }),
    };
    if (isCod && decision.covered && decision.paymentMethod !== 'prepaid') updateData.payment_status = 'PAID';

    const { data, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', orderId)
      .in('status', ['PENDING', 'OUT_FOR_DELIVERY'])
      .select()
      .single();

    if (error) throw error;
    fireAndForgetNotification(() => sendPushToUser(data.user_id, orderNotificationPayload('DELIVERED', data.id), 'customer'));
    const invoice = await issueDeliveryInvoice({
      orderId,
      source: 'operations',
      stop: assignedStop,
      driver,
      paymentMethod: decision.paymentMethod,
      amountPaid: decision.amountPaid,
      total: totalDue,
      vatAmount: existingNotes.pricing?.vat,
      issuedAt: completedAt,
    });
    await insertDeliveryAttempt(attemptRow(completedAt, decision));
    const dayReport = await finishDriverDayRecord(req, assignedStop, {
      completedAt,
      status: data.status,
      note: existingNotes.deliveryInstructions || '',
      emptyBottlesReturned,
      cashCollected,
      paymentMethod: decision.paymentMethod,
      cardAmount: payment.cardAmount,
      cardReference: payment.cardReference,
      amountDue: decision.paymentMethod === 'cash' && isCod ? totalDue : 0,
      itemsQuantity: stopItemsQuantity(assignedStop),
      invoiceNumber: invoice?.invoiceNumber || null,
      requestKey,
    });
    res.json({
      id: data.id,
      status: data.status,
      paymentStatus: data.payment_status,
      completedAt,
      proofStored: true,
      signatureStored: Boolean(storedSignature),
      paymentMethod: decision.paymentMethod,
      invoice,
      dayReport,
    });
  } catch (error) {
    if (storedProof?.path) {
      await driverFiles.remove(storedProof.bucket, [storedProof.path]).catch(() => {});
    }
    if (storedSignature?.path) {
      await driverFiles.remove(storedSignature.bucket, [storedSignature.path]).catch(() => {});
    }
    logError('Driver completion error', error);
    res.status(error?.isValidationError ? 400 : 500).json({ error: getPublicErrorMessage(error, 'Could not complete delivery') });
  }
});

// Failed delivery: recorded as a delivery_attempts row + day-report exception. The order status
// is not changed (there is no failed/rescheduled status) and the website is not called; the
// dispatcher re-plans the stop.
app.post('/api/driver/deliveries/:orderId/fail', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(orderId)) return res.status(400).json({ error: 'Invalid order id' });

  const idempotency = parseIdempotencyKey(req.get('Idempotency-Key'));
  if (idempotency.error) return res.status(400).json({ error: idempotency.error, code: idempotency.code });
  const requestKey = idempotency.key;

  const failure = validateFailureRequest(req.body || {});
  if (failure.error) return res.status(400).json({ error: failure.error, code: failure.code });

  const assignment = verifyDeliveryAssignmentToken(req.body?.assignmentToken, {
    orderId,
    driverId: req.authUser.id,
  });
  if (!assignment || !['operations', 'website'].includes(assignment.source)) {
    return res.status(403).json({ error: 'This delivery is not assigned to the signed-in driver' });
  }
  if (!dispatchTableAvailable('delivery_attempts')) return sendDeliveryRecordError(res, deliveryRecordsUnavailableError());

  let storedProof;
  try {
    const replayed = await findDeliveryAttemptByKey(req.authUser.id, requestKey);
    if (replayed) {
      if (!isReplayOf(replayed, orderId, 'FAILED')) return sendIdempotencyKeyReused(res);
      return res.status(201).json(failureResult(replayed));
    }

    if (assignment.source === 'operations') {
      if (!supabase) return res.status(404).json({ error: 'Order not found' });
      const { data: currentOrder, error: lookupError } = await supabase
        .from('orders')
        .select('id, status')
        .eq('id', orderId)
        .single();
      if (lookupError || !currentOrder) return res.status(404).json({ error: 'Order not found' });
      if (!['PENDING', 'OUT_FOR_DELIVERY'].includes(String(currentOrder.status || '').toUpperCase())) {
        return res.status(409).json({ error: `Order is already ${String(currentOrder.status || 'closed').toLowerCase()}` });
      }
    }

    if (req.body?.proofPhoto) {
      storedProof = await uploadDeliveryProof({ orderId, driverId: req.authUser.id, proofPhoto: req.body.proofPhoto });
    }
    const stop = await resolveDriverStop(orderId, assignment.source);
    const location = failure.latitude != null ? failure : attemptLocation(req);
    const attemptedAt = new Date().toISOString();
    const { error } = await writeDeliveryAttempt({
      order_id: orderId,
      order_source: assignment.source,
      driver_id: req.authUser.id,
      outcome: 'FAILED',
      reason_code: failure.reasonCode,
      note: failure.note,
      cash_collected: 0,
      card_amount: 0,
      empty_bottles_returned: 0,
      proof_bucket: storedProof?.bucket || null,
      proof_path: storedProof?.path || null,
      latitude: location.latitude,
      longitude: location.longitude,
      attempted_at: attemptedAt,
      client_request_id: requestKey,
    });
    if (markDispatchTableResult('delivery_attempts', error, DELIVERY_RECORDS_MIGRATION_FILE)) throw deliveryRecordsUnavailableError();
    if (isUniqueViolationError(error) && requestKey) {
      // A concurrent request with the same key won the insert; its attempt is the result.
      const raced = await findDeliveryAttemptByKey(req.authUser.id, requestKey);
      if (raced) {
        if (storedProof?.path) await driverFiles.remove(storedProof.bucket, [storedProof.path]).catch(() => {});
        storedProof = null;
        if (!isReplayOf(raced, orderId, 'FAILED')) return sendIdempotencyKeyReused(res);
        return res.status(201).json(failureResult(raced));
      }
    }
    if (error) throw error;

    try {
      await driverReports.recordFailure(driverIdentity(req), stop, {
        attemptedAt,
        reasonCode: failure.reasonCode,
        reasonLabel: failure.reasonLabel,
        note: failure.note,
        requestKey,
      });
    } catch (journalError) {
      logError('Failed delivery journal update failed', journalError);
    }
    return res.status(201).json({ orderId, outcome: 'FAILED', reasonCode: failure.reasonCode, attemptedAt });
  } catch (error) {
    if (storedProof?.path) {
      await driverFiles.remove(storedProof.bucket, [storedProof.path]).catch(() => {});
    }
    return sendDeliveryRecordError(res, error, 'Driver failed delivery error', 'Could not record failed delivery');
  }
});

app.get('/api/driver/deliveries/:orderId/invoice', requireDriverAuth, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const record = await findInvoiceByOrder(orderId, req.authUser.id);
    if (!record) return res.status(404).json({ error: 'No invoice was issued for this delivery', code: 'INVOICE_NOT_FOUND' });
    return res.json(invoiceLink(record));
  } catch (error) {
    return sendDeliveryRecordError(res, error, 'Driver invoice lookup error', 'Could not load invoice');
  }
});

app.get('/api/driver/invoices', requireDriverAuth, async (req, res) => {
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });
  try {
    return res.json({ date, invoices: await listInvoices({ date, driverId: req.authUser.id }) });
  } catch (error) {
    return sendDeliveryRecordError(res, error, 'Driver invoice list error', 'Could not load invoices');
  }
});

app.get('/api/driver/day-summary', requireDriverAuth, async (req, res) => {
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });
  try {
    const [journal, attempts] = await Promise.all([
      driverReports.readJournal(driverIdentity(req), date),
      listDeliveryAttempts({ date, driverId: req.authUser.id }).catch((error) => {
        if (!error?.isDeliveryRecordsUnavailable) logError('Day summary attempt lookup failed', error);
        return [];
      }),
    ]);
    return res.json(computeDaySummary({ journal, attempts }));
  } catch (error) {
    logError('Driver day summary error', error);
    return res.status(500).json({ error: 'Could not load day summary' });
  }
});

app.get('/api/invoices/:invoiceId/download', async (req, res) => {
  const invoiceId = String(req.params.invoiceId || '');
  if (!UUID_RE.test(invoiceId) || !verifyInvoiceDownload({
    secret: DRIVER_SESSION_SECRET,
    invoiceId,
    expires: req.query.expires,
    signature: req.query.signature,
  })) {
    return res.status(403).json({ error: 'This invoice link is invalid or has expired' });
  }
  try {
    if (!dispatchTableAvailable('invoices')) throw deliveryRecordsUnavailableError();
    const { data: record, error } = await driverStore.findInvoiceById(invoiceId);
    if (markDispatchTableResult('invoices', error, DELIVERY_RECORDS_MIGRATION_FILE)) throw deliveryRecordsUnavailableError();
    if (error) throw error;
    if (!record) return res.status(404).json({ error: 'Invoice not found' });

    let bytes;
    if (record.pdf_bucket && record.pdf_path) {
      bytes = await driverFiles.download(record.pdf_bucket, record.pdf_path).catch(() => null);
    }
    if (!bytes) {
      // No stored PDF (upload failed at completion): render now and store it in the background.
      const pdf = await renderInvoicePdf({ ...record, driver_name: await driverNameFor(record.driver_id) }, INVOICE_COMPANY);
      bytes = pdf;
      storeInvoicePdf(record, pdf).catch((storeError) => logError('Invoice PDF storage failed', storeError));
    }
    const safeName = String(record.invoice_number).replace(/[^A-Za-z0-9._-]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    return res.send(bytes);
  } catch (error) {
    return sendDeliveryRecordError(res, error, 'Invoice download error', 'Could not download invoice');
  }
});

app.get('/api/admin/invoices', requireOperationsAccess, async (req, res) => {
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });
  const driverId = req.query.driverId ? String(req.query.driverId).trim() : '';
  if (driverId.length > 80) return res.status(400).json({ error: 'Invalid driverId' });
  try {
    return res.json({ date, driverId: driverId || null, invoices: await listInvoices({ date, driverId: driverId || null }) });
  } catch (error) {
    return sendDeliveryRecordError(res, error, 'Admin invoice list error', 'Could not load invoices');
  }
});

app.get('/api/admin/delivery-attempts', requireOperationsAccess, async (req, res) => {
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });
  const outcome = req.query.outcome ? String(req.query.outcome).trim().toUpperCase() : '';
  if (outcome && !['DELIVERED', 'FAILED'].includes(outcome)) {
    return res.status(400).json({ error: 'outcome must be DELIVERED or FAILED' });
  }
  const driverId = req.query.driverId ? String(req.query.driverId).trim() : '';
  if (driverId.length > 80) return res.status(400).json({ error: 'Invalid driverId' });
  try {
    const attempts = await listDeliveryAttempts({ date, driverId: driverId || null, outcome: outcome || null });
    return res.json({ date, outcome: outcome || null, attempts: attempts.map(mapDeliveryAttemptRecord) });
  } catch (error) {
    return sendDeliveryRecordError(res, error, 'Admin delivery attempt list error', 'Could not load delivery attempts');
  }
});

app.get('/api/driver/reports', requireDriverAuth, async (req, res) => {
  try {
    res.json(await driverReports.listReports(req.authUser.id));
  } catch (error) {
    logError('Driver report list error', error);
    res.status(500).json({ error: 'Could not load driver reports' });
  }
});

app.post('/api/driver/reports/end-day', sensitiveRateLimit, requireDriverAuth, async (req, res) => {
  try {
    const report = await driverReports.generateReport({
      id: req.authUser.id,
      name: req.driverProfile?.name || req.authUser.user_metadata?.name || 'Driver',
    }, req.body?.date ? String(req.body.date) : undefined);
    res.status(201).json(report);
  } catch (error) {
    logError('Driver report generation error', error);
    res.status(error.statusCode || 500).json({ error: getPublicErrorMessage(error, 'Could not generate end-of-day report') });
  }
});

app.get('/api/driver/reports/:reportId/download', async (req, res) => {
  const reportId = String(req.params.reportId || '');
  if (!driverReports.verifyDownload(reportId, req.query.expires, req.query.signature)) {
    return res.status(403).json({ error: 'This report download link is invalid or has expired' });
  }
  try {
    const report = await driverReports.downloadReport(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const safeName = `driver-eod-${report.metadata.driverName}-${report.metadata.date}`.replace(/[^A-Za-z0-9._-]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', report.bytes.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    return res.send(report.bytes);
  } catch (error) {
    logError('Driver report download error', error);
    return res.status(500).json({ error: 'Could not download report' });
  }
});

// Proof photos, signatures and customer-request files kept by the disk file store. Only
// reachable with an HMAC-signed link (fileReference); Supabase Storage mode answers 404.
app.get('/api/files/:bucket/download', async (req, res) => {
  const bucket = String(req.params.bucket || '');
  const objectPath = String(req.query.path || '');
  if (driverFiles.kind !== 'disk' || !SIGNED_FILE_BUCKETS.has(bucket)) return res.status(404).json({ error: 'File not found' });
  if (!driverFiles.verifySignedUrl(bucket, objectPath, req.query.expires, req.query.signature)) {
    return res.status(403).json({ error: 'This file link is invalid or has expired' });
  }
  try {
    const bytes = await driverFiles.download(bucket, objectPath);
    if (!bytes) return res.status(404).json({ error: 'File not found' });
    const fileName = objectPath.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-');
    res.setHeader('Content-Type', driverFiles.contentType(objectPath));
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    return res.send(bytes);
  } catch (error) {
    logError('File download error', error);
    return res.status(500).json({ error: 'Could not download file' });
  }
});

app.get('/api/admin/driver-reports', requireDispatchReadOnly, async (_req, res) => {
  try {
    res.json(await driverReports.listReports());
  } catch (error) {
    logError('Admin driver report list error', error);
    res.status(500).json({ error: 'Could not load driver reports' });
  }
});

app.patch('/api/subscriptions/:id', requireSupabase, sensitiveRateLimit, requireCustomerAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });

  const updates = {};
  if (req.body?.status !== undefined) {
    const status = String(req.body.status).toUpperCase();
    if (!['ACTIVE', 'PAUSED', 'SKIPPED', 'CANCELLED'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.status = status;
  }
  if (req.body?.frequency !== undefined) {
    const frequency = String(req.body.frequency).toLowerCase();
    if (!['weekly', 'biweekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    updates.frequency = frequency;
  }
  if (req.body?.quantity !== undefined) {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Invalid quantity' });
    updates.quantity = quantity;
  }
  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.authUser.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    logError('Update subscription error', error);
    res.status(500).json({ error: 'Could not update subscription' });
  }
});

// --- Wallet & Credits ---
app.post('/api/users/:id/wallet/topup', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  if (IS_PRODUCTION) {
    return res.status(501).json({ error: 'Direct wallet top-up is disabled in production. Use the payment gateway flow.' });
  }

  const { amount } = req.body;
  const safeAmount = Number(amount);
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
  if (!requireSameCustomer(req, res, req.params.id)) return;
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const balances = await getCustomerBalances(req.params.id);
    const { data: user, error } = await supabase
      .from('users')
      .update({ wallet_balance: Number((balances.walletBalance + safeAmount).toFixed(2)) })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Top up failed' });
  }
});

// Buy 5-gallon coupon pack from wallet balance. Internal DB field remains bottle_credits for compatibility.
app.post('/api/users/:id/wallet/buy-credits', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
  if (!requireSameCustomer(req, res, req.params.id)) return;

  const { packId } = req.body;

  try {
    const pack = await getCouponPack(packId);
    if (!pack) return res.status(400).json({ error: 'Invalid coupon pack' });

    const balances = await getCustomerBalances(req.params.id);
    if (balances.walletBalance < pack.price) {
      return res.status(400).json({ error: `Insufficient wallet balance. Need ${pack.price} AED.` });
    }

    const totalCoupons = pack.totalCoupons;
    const { data: updated, error } = await supabase
      .from('users')
      .update({
        wallet_balance: Number((balances.walletBalance - pack.price).toFixed(2)),
        bottle_credits: balances.bottleCredits + totalCoupons,
      })
      .eq('id', req.params.id)
      .gte('wallet_balance', pack.price)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: 'Insufficient wallet balance or customer balance changed. Please refresh and try again.' });
    }
    fireAndForgetNotification(() => sendPushToUser(req.params.id, {
      title: 'Alrawdah Springs',
      body: 'Your 5-gallon coupons have been added.',
      data: { type: 'coupon', packId, totalCoupons },
    }, 'customer'));
    res.json({ user: updated, pack: { ...pack, totalCoupons } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to buy coupon pack' });
  }
});

// --- Push Notifications ---
app.post('/api/notifications/register-token', requireSupabase, sensitiveRateLimit, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = normalizePushPlatform(req.body?.platform);
  const appType = normalizeAppType(req.body?.appType);
  const deviceName = truncateText(req.body?.deviceName, 120);
  const deviceId = truncateText(req.body?.deviceId, 120);
  const bearerToken = getBearerToken(req);
  let userId = null;

  if (!isExpoPushToken(token)) {
    return res.status(400).json({ error: 'Invalid Expo push token' });
  }

  try {
    if (bearerToken) {
      const { data, error } = await supabase.auth.getUser(bearerToken);
      if (error || !data?.user?.id) return res.status(401).json({ error: 'Invalid or expired session' });
      const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('role')
        .eq('id', data.user.id)
        .single();
      if (profileError || !profile) return res.status(403).json({ error: 'Profile role required for push registration' });
      if (appType === 'customer' && profile.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer role required' });
      if (appType === 'driver' && profile.role !== 'DRIVER') return res.status(403).json({ error: 'Driver role required' });
      if (appType === 'admin' && !ADMIN_ROLES.has(profile.role)) return res.status(403).json({ error: 'Admin role required' });
      userId = data.user.id;
    } else {
      const apiKey = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
      const isDriverKey = DRIVER_API_KEY && apiKey && safeCompare(DRIVER_API_KEY, apiKey);
      const isAdminKey = ADMIN_API_KEY && apiKey && safeCompare(ADMIN_API_KEY, apiKey);
      if (!isDriverKey && !isAdminKey) return res.status(401).json({ error: 'Authentication required' });
      if (appType === 'driver' && UUID_RE.test(String(req.body?.userId || ''))) userId = req.body.userId;
      if (appType === 'admin' && UUID_RE.test(String(req.body?.userId || ''))) userId = req.body.userId;
    }

    const { error } = await supabase.from('push_tokens').upsert({
      user_id: userId,
      token,
      platform,
      app_type: appType,
      device_id: deviceId || null,
      device_name: deviceName || null,
      is_active: true,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    logError('Register push token error', error);
    res.status(500).json({ error: 'Could not register push token' });
  }
});

app.post('/api/notifications/unregister-token', requireSupabase, sensitiveRateLimit, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const bearerToken = getBearerToken(req);

  if (!isExpoPushToken(token)) return res.status(400).json({ error: 'Invalid Expo push token' });

  try {
    if (bearerToken) {
      const { data, error: authError } = await supabase.auth.getUser(bearerToken);
      if (authError || !data?.user?.id) return res.status(401).json({ error: 'Invalid or expired session' });
      const { error } = await supabase
        .from('push_tokens')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('token', token)
        .eq('user_id', data.user.id);
      if (error) throw error;
      return res.json({ success: true });
    }

    const apiKey = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const isOperationsKey = (DRIVER_API_KEY && apiKey && safeCompare(DRIVER_API_KEY, apiKey)) || (ADMIN_API_KEY && apiKey && safeCompare(ADMIN_API_KEY, apiKey));
    if (!isOperationsKey) return res.status(401).json({ error: 'Authentication required' });
    const { error } = await supabase
      .from('push_tokens')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('token', token);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    logError('Unregister push token error', error);
    res.status(500).json({ error: 'Could not unregister push token' });
  }
});

app.get('/api/notifications/history', requireSupabase, requireCustomerAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notification_recipients')
      .select('status, error, created_at, notification:notification_logs(title, body, audience, data, created_at)')
      .eq('user_id', req.authUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notification history' });
  }
});

app.post('/api/admin/notifications/send', requireSupabase, requireAdmin, async (req, res) => {
  const title = truncateText(req.body?.title, 100);
  const body = truncateText(req.body?.body, 220);
  const audience = String(req.body?.audience || 'all');
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};
  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';

  if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
  if (!ALLOWED_NOTIFICATION_AUDIENCES.has(audience)) return res.status(400).json({ error: 'Invalid audience' });
  if (audience === 'specificUsers' && !userIds.length) return res.status(400).json({ error: 'Select at least one user' });

  try {
    const { data: log, error: logErrorResult } = await supabase.from('notification_logs').insert({
      title,
      body,
      audience,
      data,
      sent_count: 0,
      failed_count: 0,
    }).select().single();
    if (logErrorResult) throw logErrorResult;

    const result = await sendPushToAudience(audience, { title, body, data, image }, userIds, log.id);
    await supabase.from('notification_logs').update({
      sent_count: result.sentCount,
      failed_count: result.failedCount,
    }).eq('id', log.id);

    res.json({ success: true, sentCount: result.sentCount, failedCount: result.failedCount });
  } catch (error) {
    logError('Admin notification send error', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.get('/api/admin/notifications/history', requireSupabase, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('notification_logs')
      .select('id, title, body, audience, data, sent_count, failed_count, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notification history' });
  }
});

app.get('/api/payment/complete', (req, res) => {
  res.redirect(buildRedirectUrl(PAYMENT_COMPLETE_REDIRECT_URL, req.query));
});

app.get('/api/payment/cancel', (_req, res) => {
  res.redirect(PAYMENT_CANCEL_REDIRECT_URL);
});

app.get('/api/payment/checkout-complete', (req, res) => {
  res.redirect(buildRedirectUrl(CHECKOUT_COMPLETE_REDIRECT_URL, req.query));
});

async function createPaymentTransaction({ reference, type, userId, amount, payload = {} }) {
  const safeAmount = Number(amount);
  const { data, error } = await supabase
    .from('payment_transactions')
    .insert({
      reference,
      type,
      user_id: userId,
      amount: safeAmount,
      currency: 'AED',
      status: 'PENDING',
      payload,
    })
    .select()
    .single();

  if (error) {
    logError('Payment ledger insert failed', error);
    throw validationError('Payment ledger is not configured. Please contact support.');
  }

  return data;
}

async function getPaymentTransaction(reference) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('reference', reference)
    .single();

  if (error) {
    logError('Payment ledger lookup failed', error);
    throw validationError('Payment reference was not found. Please restart payment.');
  }

  return data;
}

function assertPaymentTransactionMatches(transaction, { type, userId, amount }) {
  if (transaction.type !== type || transaction.user_id !== userId) {
    throw validationError('Payment reference does not match this customer.');
  }

  const ledgerAmount = Number(transaction.amount || 0);
  if (Math.abs(ledgerAmount - Number(amount)) > 0.01) {
    throw validationError('Payment amount mismatch');
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function deactivatePushTokens(tokens = []) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))];
  if (!uniqueTokens.length) return;

  const { error } = await supabase
    .from('push_tokens')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in('token', uniqueTokens);

  if (error) logError('Could not deactivate invalid push tokens', error);
}

async function fetchActivePushTokensForUsers(userIds = [], appType = null) {
  const cleanIds = [...new Set(userIds.filter((id) => UUID_RE.test(String(id || ''))))];
  if (!cleanIds.length) return [];

  let query = supabase
    .from('push_tokens')
    .select('token, user_id, app_type')
    .eq('is_active', true)
    .in('user_id', cleanIds);

  if (appType) query = query.eq('app_type', appType);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function fetchActivePushTokensForAudience(audience, userIds = []) {
  let query = supabase
    .from('push_tokens')
    .select('token, user_id, app_type')
    .eq('is_active', true);

  if (audience === 'customers') query = query.eq('app_type', 'customer');
  if (audience === 'drivers') query = query.eq('app_type', 'driver');
  if (audience === 'specificUsers') {
    const cleanIds = [...new Set(userIds.filter((id) => UUID_RE.test(String(id || ''))))];
    if (!cleanIds.length) return [];
    query = query.in('user_id', cleanIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function sendPushToTokens(tokenRows, payload, logId = null) {
  const rows = (tokenRows || []).filter((row) => isExpoPushToken(row.token));
  if (!rows.length) return { sentCount: 0, failedCount: 0 };

  const messages = rows.map((row) => ({
    to: row.token,
    sound: 'default',
    title: truncateText(payload.title, 100),
    body: truncateText(payload.body, 220),
    data: payload.data || {},
    ...(payload.image ? { richContent: { image: payload.image } } : {}),
  }));

  let sentCount = 0;
  let failedCount = 0;
  const invalidTokens = [];
  const recipientRows = [];

  for (const chunk of chunkArray(messages, 100)) {
    const response = await fetch(EXPO_PUSH_SEND_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chunk),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      failedCount += chunk.length;
      chunk.forEach((message) => {
        recipientRows.push({
          notification_log_id: logId,
          token: message.to,
          status: 'FAILED',
          error: `Expo Push API ${response.status}`,
        });
      });
      continue;
    }

    const tickets = Array.isArray(result.data) ? result.data : [];
    tickets.forEach((ticket, index) => {
      const original = rows[messages.indexOf(chunk[index])];
      if (ticket?.status === 'ok') {
        sentCount += 1;
        recipientRows.push({
          notification_log_id: logId,
          user_id: original?.user_id || null,
          token: chunk[index].to,
          status: 'SENT',
        });
      } else {
        failedCount += 1;
        const errorCode = ticket?.details?.error || ticket?.message || 'Unknown push error';
        if (errorCode === 'DeviceNotRegistered') invalidTokens.push(chunk[index].to);
        recipientRows.push({
          notification_log_id: logId,
          user_id: original?.user_id || null,
          token: chunk[index].to,
          status: 'FAILED',
          error: String(errorCode).slice(0, 500),
        });
      }
    });

    const receiptIds = tickets.filter((ticket) => ticket?.id).map((ticket) => ticket.id);
    if (receiptIds.length) {
      fetch(EXPO_PUSH_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: receiptIds }),
      })
        .then((receiptResponse) => receiptResponse.json())
        .then((receiptResult) => {
          const receipts = receiptResult?.data || {};
          const receiptInvalidTokens = [];
          Object.values(receipts).forEach((receipt) => {
            if (receipt?.details?.error === 'DeviceNotRegistered') {
              const ticketIndex = tickets.findIndex((ticket) => ticket.id && receipts[ticket.id] === receipt);
              if (ticketIndex >= 0 && chunk[ticketIndex]?.to) receiptInvalidTokens.push(chunk[ticketIndex].to);
            }
          });
          return deactivatePushTokens(receiptInvalidTokens);
        })
        .catch((error) => logError('Expo push receipt check failed', error));
    }
  }

  if (invalidTokens.length) await deactivatePushTokens(invalidTokens);
  if (recipientRows.length) {
    const { error } = await supabase.from('notification_recipients').insert(recipientRows);
    if (error) logError('Could not store notification recipients', error);
  }

  return { sentCount, failedCount };
}

async function sendPushToUsers(userIds, payload, appType = null) {
  if (!supabase) return { sentCount: 0, failedCount: 0 };
  const tokens = await fetchActivePushTokensForUsers(userIds, appType);
  return sendPushToTokens(tokens, payload);
}

async function sendPushToUser(userId, payload, appType = null) {
  return sendPushToUsers([userId], payload, appType);
}

async function sendPushToAudience(audience, payload, userIds = [], logId = null) {
  if (!supabase) return { sentCount: 0, failedCount: 0 };
  const tokens = await fetchActivePushTokensForAudience(audience, userIds);
  return sendPushToTokens(tokens, payload, logId);
}

function orderNotificationPayload(status, orderId) {
  const normalized = String(status || '').toUpperCase();
  const messages = {
    PENDING: 'Your order has been confirmed.',
    OUT_FOR_DELIVERY: 'Your order is out for delivery.',
    DELIVERED: 'Your order has been delivered. Thank you for choosing Alrawdah Springs.',
    CANCELLED: 'Your order has been cancelled.',
  };

  return {
    title: 'Alrawdah Springs',
    body: messages[normalized] || 'Your order has been updated.',
    data: { type: 'order', orderId, status: normalized },
  };
}

async function markPaymentTransaction(reference, status, fields = {}) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .update({
      status,
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('reference', reference)
    .select()
    .single();

  if (error) {
    logError('Payment ledger update failed', error);
    throw validationError('Payment ledger could not be updated. Please contact support.');
  }

  return data;
}

// --- Network International (N-Genius) Payment Gateway ---
app.post('/api/payment/ngenius/topup', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  const { amount, userId: requestedUserId } = req.body;
  const userId = requireSameCustomer(req, res, requestedUserId);
  if (!userId) return;

  const safeAmount = Number(amount);

  if (!Number.isFinite(safeAmount) || safeAmount <= 0 || !userId || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing amount or userId' });
  }

  try {
    const redirectUrl = buildRedirectUrl(`${PAYMENT_RELAY_BASE_URL}/api/payment/complete`, { amount: safeAmount, userId });
    const orderData = await createNGeniusOrder(safeAmount, redirectUrl);
    await createPaymentTransaction({
      reference: orderData.orderRef,
      type: 'wallet_topup',
      userId,
      amount: safeAmount,
      payload: { source: 'customer_app' },
    });
    res.json(orderData);
  } catch (error) {
    logError('N-Genius topup error', error);
    res.status(500).json({ error: 'Payment gateway failed' });
  }
});

app.post('/api/payment/ngenius/topup/confirm', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  const { amount, userId: requestedUserId, orderRef } = req.body;
  const userId = requireSameCustomer(req, res, requestedUserId);
  if (!userId) return;
  const safeAmount = Number(amount);

  if (!Number.isFinite(safeAmount) || safeAmount <= 0 || !userId || !UUID_RE.test(userId) || !orderRef) {
    return res.status(400).json({ error: 'Missing payment confirmation details' });
  }

  try {
    const transaction = await getPaymentTransaction(orderRef);
    assertPaymentTransactionMatches(transaction, { type: 'wallet_topup', userId, amount: safeAmount });

    if (transaction.status === 'PROCESSED') {
      const { data: existingUser, error: existingError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();
      if (existingError) throw existingError;
      return res.json({ user: existingUser, alreadyProcessed: true });
    }
    if (transaction.status !== 'PENDING') {
      return res.status(409).json({ error: 'Payment is already being processed. Please refresh shortly.' });
    }

    await markPaymentTransaction(orderRef, 'PROCESSING');

    const paymentStatus = await getNGeniusOrderStatus(orderRef);
    if (!isNGeniusPaymentPaid(paymentStatus)) {
      await markPaymentTransaction(orderRef, 'FAILED');
      return res.status(402).json({ error: 'Payment has not been completed' });
    }

    const gatewayAmount = Number(paymentStatus.amount || 0) / 100;
    if (gatewayAmount && Math.abs(gatewayAmount - safeAmount) > 0.01) {
      await markPaymentTransaction(orderRef, 'FAILED');
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const balances = await getCustomerBalances(userId);
    const { data: updated, error } = await supabase
      .from('users')
      .update({ wallet_balance: Number((balances.walletBalance + safeAmount).toFixed(2)) })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    await markPaymentTransaction(orderRef, 'PROCESSED', { processed_at: new Date().toISOString() });
    fireAndForgetNotification(() => sendPushToUser(userId, {
      title: 'Alrawdah Springs',
      body: 'Your wallet top-up was successful.',
      data: { type: 'wallet', amount: safeAmount },
    }, 'customer'));
    res.json({ user: updated });
  } catch (error) {
    if (orderRef) {
      await markPaymentTransaction(orderRef, 'PENDING').catch(() => undefined);
    }
    logError('N-Genius topup confirmation error', error);
    res.status(400).json({ error: getPublicErrorMessage(error, 'Payment confirmation failed') });
  }
});

// --- Orders (Backend Admin/Customer fallback) ---
app.post('/api/payment/ngenius/checkout', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  const { amount, userId: requestedUserId, orderPayload } = req.body;
  const userId = requireSameCustomer(req, res, requestedUserId);
  if (!userId) return;
  const normalizedOrderPayload = normalizeOrderPayload(orderPayload);

  if (!userId || amount === undefined || amount === null || !normalizedOrderPayload.address || !normalizedOrderPayload.items.length) {
    return res.status(400).json({
      error: 'Missing checkout details',
      missing: {
        userId: !userId,
        amount: amount === undefined || amount === null,
        address: !normalizedOrderPayload.address,
        items: !normalizedOrderPayload.items.length,
      },
    });
  }

  try {
    await validateCheckoutForPaymentInit({ userId, amount, orderPayload: normalizedOrderPayload });
    const redirectUrl = buildRedirectUrl(`${PAYMENT_RELAY_BASE_URL}/api/payment/checkout-complete`);
    const orderData = await createNGeniusOrder(amount, redirectUrl);
    await createPaymentTransaction({
      reference: orderData.orderRef,
      type: 'checkout',
      userId,
      amount,
      payload: { orderPayload: normalizedOrderPayload },
    });
    res.json(orderData);
  } catch (err) {
    logError('N-Genius checkout error', err);
    res.status(400).json({ error: getPublicErrorMessage(err, 'Checkout failed') });
  }
});

app.post('/api/payment/ngenius/checkout/confirm', requireSupabase, paymentRateLimit, requireCustomerAuth, async (req, res) => {
  const { amount, userId: requestedUserId, orderRef, orderPayload } = req.body;
  const userId = requireSameCustomer(req, res, requestedUserId);
  if (!userId) return;
  const normalizedOrderPayload = normalizeOrderPayload(orderPayload);

  if (!userId || amount === undefined || amount === null || !orderRef || !normalizedOrderPayload.address || !normalizedOrderPayload.items.length) {
    return res.status(400).json({ error: 'Missing checkout confirmation details' });
  }

  try {
    const transaction = await getPaymentTransaction(orderRef);
    assertPaymentTransactionMatches(transaction, { type: 'checkout', userId, amount });

    if (transaction.status === 'PROCESSED') {
      const { data: existingOrder, error: existingError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', transaction.order_id)
        .single();
      if (existingError) throw existingError;
      return res.status(200).json({ order: existingOrder, alreadyProcessed: true });
    }
    if (transaction.status !== 'PENDING') {
      return res.status(409).json({ error: 'Payment is already being processed. Please refresh shortly.' });
    }

    await markPaymentTransaction(orderRef, 'PROCESSING');

    await validateCheckoutForPaymentInit({ userId, amount, orderPayload: normalizedOrderPayload });
    const paymentStatus = await getNGeniusOrderStatus(orderRef);
    if (!isNGeniusPaymentPaid(paymentStatus)) {
      await markPaymentTransaction(orderRef, 'FAILED');
      return res.status(402).json({ error: 'Payment has not been completed' });
    }

    const gatewayAmount = Number(paymentStatus.amount || 0) / 100;
    if (gatewayAmount && Math.abs(gatewayAmount - Number(amount)) > 0.01) {
      await markPaymentTransaction(orderRef, 'FAILED');
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const order = await createOrderInSupabase({
      userId,
      amount,
      paymentMethod: 'card',
      orderPayload: normalizedOrderPayload,
      initialStatus: 'PENDING',
    });

    await supabase
      .from('orders')
      .update({ payment_status: 'PAID' })
      .eq('id', order.id);

    await markPaymentTransaction(orderRef, 'PROCESSED', {
      order_id: order.id,
      processed_at: new Date().toISOString(),
    });

    fireAndForgetNotification(async () => {
      await sendPushToUser(userId, {
        title: 'Alrawdah Springs',
        body: 'Your card payment was successful.',
        data: { type: 'wallet', orderId: order.id },
      }, 'customer');
      await sendPushToUser(userId, orderNotificationPayload('PENDING', order.id), 'customer');
    });
    res.status(201).json({ order: { ...order, payment_status: 'PAID' } });
  } catch (err) {
    if (orderRef) {
      await markPaymentTransaction(orderRef, 'PENDING').catch(() => undefined);
    }
    logError('N-Genius checkout confirmation error', err);
    res.status(400).json({ error: getPublicErrorMessage(err, 'Checkout confirmation failed') });
  }
});

async function validateCheckoutForPaymentInit({ userId, amount, orderPayload }) {
  if (!UUID_RE.test(userId)) {
    throw validationError('Invalid user id');
  }

  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < 0) {
    throw validationError('Invalid order amount');
  }

  if (!orderPayload.address) {
    throw validationError('Delivery address is required');
  }

  const items = await validateOrderItems(orderPayload.items);
  const pricing = calculateOrderPricing(items);
  const expectedTotal = pricing.total;

  if (Math.abs(safeAmount - expectedTotal) > 0.01) {
    throw validationError(`Invalid order total. Expected ${expectedTotal.toFixed(2)} AED`);
  }
}

async function createNGeniusOrder(amount, redirectUrl) {
  if (!NGENIUS_API_KEY || !NGENIUS_OUTLET_ID) {
    throw new Error('N-Genius payment credentials are not configured');
  }

  const accessToken = await createNGeniusAccessToken();

  const orderResp = await fetch(`${NGENIUS_BASE_URL}/transactions/outlets/${NGENIUS_OUTLET_ID}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/vnd.ni-payment.v2+json",
      "Accept": "application/vnd.ni-payment.v2+json"
    },
    body: JSON.stringify({
      action: "SALE",
      amount: { currencyCode: "AED", value: Math.round(amount * 100) },
      merchantAttributes: { redirectUrl, cancelUrl: `${PAYMENT_RELAY_BASE_URL}/api/payment/cancel`, skipConfirmationPage: true },
      paymentMethods: ["CARD"]
    })
  });

  if (!orderResp.ok) {
    logError('N-Genius order creation failed', { status: orderResp.status, message: await orderResp.text() });
    throw new Error(`N-Genius order creation failed (${orderResp.status})`);
  }

  const orderData = await orderResp.json();

  if (!orderData._links?.payment?.href) {
    logError('N-Genius response missing payment URL', { message: 'Missing payment href' });
    throw new Error('N-Genius did not return a payment URL');
  }

  return { paymentUrl: orderData._links.payment.href, orderRef: orderData.reference };
}

async function createNGeniusAccessToken() {
  const tokenResp = await fetch(`${NGENIUS_BASE_URL}/identity/auth/access-token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${NGENIUS_API_KEY}`,
      "Content-Type": "application/vnd.ni-identity.v1+json",
      "Accept": "application/vnd.ni-identity.v1+json"
    }
  });

  if (!tokenResp.ok) {
    logError('N-Genius auth failed', { status: tokenResp.status, message: await tokenResp.text() });
    throw new Error(`N-Genius authentication failed (${tokenResp.status})`);
  }

  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

async function getNGeniusOrderStatus(orderRef) {
  if (!NGENIUS_API_KEY || !NGENIUS_OUTLET_ID) {
    throw new Error('N-Genius payment credentials are not configured');
  }

  const accessToken = await createNGeniusAccessToken();
  const statusResp = await fetch(`${NGENIUS_BASE_URL}/transactions/outlets/${NGENIUS_OUTLET_ID}/orders/${encodeURIComponent(orderRef)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/vnd.ni-payment.v2+json"
    }
  });

  if (!statusResp.ok) {
    logError('N-Genius status check failed', { status: statusResp.status, message: await statusResp.text() });
    throw new Error(`N-Genius status check failed (${statusResp.status})`);
  }

  const orderData = await statusResp.json();
  const payment = orderData._embedded?.payment?.[0] || {};
  const amount = payment.amount?.value || orderData.amount?.value || 0;

  return {
    orderState: orderData._embedded?.payment?.[0]?.state || orderData.state,
    paymentState: payment.state,
    amount,
  };
}

function isNGeniusPaymentPaid(paymentStatus) {
  const states = [paymentStatus.orderState, paymentStatus.paymentState]
    .filter(Boolean)
    .map((state) => String(state).toUpperCase());
  return states.some((state) => ['CAPTURED', 'PURCHASED', 'AUTHORISED', 'AUTHORIZED', 'SUCCESS'].includes(state));
}

// --- Admin: website dispatch feed for the office-PC dispatch console ---
// Key-protected pass-through (x-dispatch-read-key or x-api-key = ADMIN_API_KEY / DRIVER_API_KEY).
const websiteDispatchProxy = createWebsiteDispatchProxy({
  overviewUrl: WEBSITE_DISPATCH_URL,
  apiKeys: [ADMIN_API_KEY, DRIVER_API_KEY],
  readKey: process.env.WEBSITE_DISPATCH_READ_KEY || '',
});
app.get('/api/admin/website-dispatch/overview', websiteDispatchProxy.requireKey, websiteDispatchProxy.overview);
app.get('/api/admin/website-dispatch/customers/:id/orders', websiteDispatchProxy.requireKey, websiteDispatchProxy.customerOrders);

// --- Admin: Drivers ---
app.get('/api/admin/dispatch/overview', requireDispatchReadOnly, async (req, res) => {
  try {
    // Without Supabase: configured drivers only, and no operations orders / customers.
    const [authUsers, driversResult, ordersResult, customersResult] = await Promise.all([
      listAllAuthUsers(),
      supabase
        ? supabase
          .from('users')
          .select('id, name, email, address, building, apartment, city, location_lat, location_lng')
          .eq('role', 'DRIVER')
          .order('name')
        : NO_OPERATIONS_ORDERS,
      supabase
        ? supabase
          .from('orders')
          .select('*, user:users(name, email, address, building, apartment, city, location_lat, location_lng)')
          .in('status', ['PENDING', 'OUT_FOR_DELIVERY'])
          .order('created_at', { ascending: true })
        : NO_OPERATIONS_ORDERS,
      supabase
        ? supabase
          .from('users')
          .select('id, name, email, address, building, apartment, city, location_lat, location_lng, created_at')
          .eq('role', 'CUSTOMER')
          .order('created_at', { ascending: false })
        : NO_OPERATIONS_ORDERS,
    ]);

    if (driversResult.error) throw driversResult.error;
    if (ordersResult.error) throw ordersResult.error;
    if (customersResult.error) throw customersResult.error;

    const palette = ['#6656d9', '#0c9f8f', '#df6c20', '#2779bd', '#b92b62', '#008ca8', '#6f42d9'];
    const authById = new Map(authUsers.map((user) => [user.id, user]));
    const authByEmail = new Map(authUsers.filter((user) => user.email).map((user) => [user.email.toLowerCase(), user]));

    const activeOrders = ordersResult.data || [];
    const driverRecords = [...(driversResult.data || [])];
    for (const configuredDriver of CONFIGURED_DRIVERS) {
      if (DRIVER_LOGIN_USERNAME && !driverRecords.some((driver) => driver.id === configuredDriver.id)) {
        driverRecords.push({
          id: configuredDriver.id,
          name: configuredDriver.name,
          email: null,
          address: null,
          building: null,
          apartment: null,
          city: 'UAE',
          location_lat: null,
          location_lng: null,
        });
      }
    }
    await ensureDriverSessionsLoaded(driverRecords.map((driver) => driver.id));
    const driverById = new Map(driverRecords.map((driver, index) => [driver.id, { ...driver, color: palette[index % palette.length] }]));
    const activeStopsByDriver = new Map();
    for (const order of activeOrders) {
      if (order.assigned_driver_id) {
        activeStopsByDriver.set(order.assigned_driver_id, (activeStopsByDriver.get(order.assigned_driver_id) || 0) + 1);
      }
    }

    const drivers = driverRecords.map((driver, index) => {
      const authUser = authById.get(driver.id) || (driver.email ? authByEmail.get(driver.email.toLowerCase()) : null);
      const location = latestDriverLocations.get(driver.id);
      const shift = getDriverShiftState(driver.id);
      const latitude = Number(location?.lat);
      const longitude = Number(location?.lng);
      return {
        id: driver.id,
        name: driver.name || driver.email || 'Driver',
        phone: authUser?.phone || authUser?.user_metadata?.phone || '',
        zoneName: driver.city || '',
        color: palette[index % palette.length],
        activeStops: activeStopsByDriver.get(driver.id) || 0,
        homeLatitude: driver.location_lat != null && Number.isFinite(Number(driver.location_lat)) ? Number(driver.location_lat) : null,
        homeLongitude: driver.location_lng != null && Number.isFinite(Number(driver.location_lng)) ? Number(driver.location_lng) : null,
        shiftStatus: shift.status,
        gpsSharing: driverGpsSharingStates.get(driver.id) !== false && Boolean(location),
        location: Number.isFinite(latitude) && Number.isFinite(longitude) ? {
          latitude,
          longitude,
          accuracy: Number.isFinite(Number(location.accuracy)) ? Number(location.accuracy) : null,
          recordedAt: location.recorded_at,
        } : null,
      };
    });

    const sequenceByDriver = new Map();
    const orders = activeOrders.map((order) => {
      const driver = order.assigned_driver_id ? driverById.get(order.assigned_driver_id) : null;
      const customer = order.user || {};
      const customerAuth = customer.email ? authByEmail.get(customer.email.toLowerCase()) : null;
      const latitude = Number(order.latitude ?? customer.location_lat);
      const longitude = Number(order.longitude ?? customer.location_lng);
      const nextSequence = order.assigned_driver_id
        ? (sequenceByDriver.get(order.assigned_driver_id) || 0) + 1
        : null;
      if (order.assigned_driver_id) sequenceByDriver.set(order.assigned_driver_id, nextSequence);

      return {
        id: order.id,
        orderNumber: order.id,
        total: Number(order.total_amount || 0),
        createdAt: order.created_at,
        customerName: customer.name || 'Customer',
        customerPhone: customerAuth?.phone || customerAuth?.user_metadata?.phone || '',
        address: order.delivery_address || buildAddressDisplay(customer),
        area: customer.city || '',
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        assignedDriverId: order.assigned_driver_id || null,
        driverName: driver?.name || driver?.email || null,
        driverColor: driver?.color || null,
        zoneName: driver?.city || customer.city || null,
        routeSequence: nextSequence,
        routeExcluded: false,
      };
    });

    const customers = (customersResult.data || []).map((customer) => {
      const authUser = authById.get(customer.id) || (customer.email ? authByEmail.get(customer.email.toLowerCase()) : null);
      const latitude = Number(customer.location_lat);
      const longitude = Number(customer.location_lng);
      const customerOrders = activeOrders.filter((order) => order.user_id === customer.id);
      return {
        id: customer.id,
        name: customer.name || customer.email || 'Customer',
        phone: authUser?.phone || authUser?.user_metadata?.phone || '',
        address: buildAddressDisplay(customer),
        area: customer.city || '',
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        lastOrderAt: customerOrders.at(-1)?.created_at || null,
        source: 'operations',
      };
    });

    res.json({ generatedAt: new Date().toISOString(), drivers, orders, customers });
  } catch (error) {
    logError('Read-only dispatch overview failed', error);
    res.status(500).json({ error: 'Could not load dispatch overview' });
  }
});

// --- Admin: Dispatch route plans ---
// driverId is the same id the dispatch overview returns for drivers and that requireDriverAuth
// puts on req.authUser.id: users.id for Supabase drivers, CONFIGURED_DRIVERS[].id otherwise.
async function findDispatchDriver(driverId) {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(driverId)) return null;
  const configuredDriver = CONFIGURED_DRIVERS.find((driver) => driver.id === driverId);
  if (configuredDriver) return { id: configuredDriver.id, name: configuredDriver.name };
  if (!UUID_RE.test(driverId) || !supabase) return null;

  const { data, error } = await supabase
    .from('users')
    .select('id, name, role')
    .eq('id', driverId)
    .maybeSingle();
  if (error) throw error;
  return data && data.role === 'DRIVER' ? { id: data.id, name: data.name } : null;
}

function sendRoutePlanError(res, error, fallback) {
  if (error?.isRoutePlanUnavailable) {
    return res.status(503).json({ error: error.message, code: 'ROUTE_PLANS_UNAVAILABLE' });
  }
  logError(fallback, error);
  return res.status(500).json({ error: fallback });
}

app.get('/api/admin/route-plans', requireOperationsAccess, async (req, res) => {
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });

  try {
    res.json({ date, plans: await loadRoutePlans(date) });
  } catch (error) {
    sendRoutePlanError(res, error, 'Could not load route plans');
  }
});

app.put('/api/admin/drivers/:driverId/route-plan', requireOperationsAccess, async (req, res) => {
  const driverId = String(req.params.driverId || '').trim();
  const { date, error: dateError } = resolvePlanDate(req.body?.date);
  if (dateError) return res.status(400).json({ error: dateError });
  const { orderIds, error: orderIdsError } = validatePlanOrderIds(req.body?.orderIds);
  if (orderIdsError) return res.status(400).json({ error: orderIdsError });

  try {
    const driver = await findDispatchDriver(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    // An order may only be planned for one driver per day: take it out of other plans first.
    // Not transactional; if a later step fails the console can simply resend the plan.
    const existingPlans = await loadRoutePlans(date);
    const otherPlanUpdates = removeOrdersFromOtherPlans(existingPlans, driverId, orderIds);
    const updatedAt = new Date().toISOString();
    for (const update of otherPlanUpdates) {
      const { error } = update.orderIds.length
        ? await driverStore.updateRoutePlanOrders(update.driverId, date, update.orderIds, updatedAt)
        : await driverStore.deleteRoutePlan(update.driverId, date);
      if (markDispatchTableResult('driver_route_plans', error)) throw routePlansUnavailableError();
      if (error) throw error;
    }

    const { data, error } = await driverStore.upsertRoutePlan({
      driver_id: driverId,
      plan_date: date,
      order_ids: orderIds,
      source: truncateText(req.body?.source, 40) || 'dispatch-console',
      created_by: truncateText(req.body?.createdBy, 120) || null,
      updated_at: updatedAt,
    });
    if (markDispatchTableResult('driver_route_plans', error)) throw routePlansUnavailableError();
    if (error) throw error;

    res.json({
      ...mapRoutePlanRecord(data),
      removedFromDrivers: otherPlanUpdates.map((update) => ({
        driverId: update.driverId,
        orderIds: update.removedOrderIds,
      })),
    });
  } catch (error) {
    sendRoutePlanError(res, error, 'Could not save route plan');
  }
});

app.delete('/api/admin/drivers/:driverId/route-plan', requireOperationsAccess, async (req, res) => {
  const driverId = String(req.params.driverId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(driverId)) return res.status(400).json({ error: 'Invalid driver id' });
  const { date, error: dateError } = resolvePlanDate(req.query.date);
  if (dateError) return res.status(400).json({ error: dateError });

  try {
    const { data, error } = await driverStore.deleteRoutePlan(driverId, date);
    if (markDispatchTableResult('driver_route_plans', error)) throw routePlansUnavailableError();
    if (error) throw error;
    res.json({ driverId, date, deleted: (data || []).length > 0 });
  } catch (error) {
    sendRoutePlanError(res, error, 'Could not clear route plan');
  }
});

app.get('/api/admin/drivers', requireSupabase, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('role', 'DRIVER')
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

app.post('/api/admin/orders/:id/assign', requireSupabase, requireAdmin, async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: 'driverId required' });

  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ assigned_driver_id: driverId, status: 'OUT_FOR_DELIVERY' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    fireAndForgetNotification(async () => {
      await sendPushToUser(data.user_id, orderNotificationPayload('OUT_FOR_DELIVERY', data.id), 'customer');
      await sendPushToUser(driverId, {
        title: 'New delivery assigned',
        body: 'A new delivery has been assigned to you.',
        data: { type: 'delivery', orderId: data.id, deliveryId: data.id },
      }, 'driver');
    });
    res.json(data);
  } catch (error) {
    logError('Assign driver error', error);
    res.status(500).json({ error: 'Failed to assign driver' });
  }
});

// --- Admin Endpoints ---
app.get('/api/admin/metrics', requireSupabase, requireAdmin, async (req, res) => {
  try {
    const [ordersResult, customersResult, deliveriesResult] = await Promise.all([
      supabase.from('orders').select('total_amount, status', { count: 'exact' }),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'CUSTOMER'),
      supabase.from('deliveries').select('bottles_damaged'),
    ]);

    if (ordersResult.error) throw ordersResult.error;
    if (customersResult.error) throw customersResult.error;
    if (deliveriesResult.error && deliveriesResult.error.code !== '42P01') throw deliveriesResult.error;

    const orders = ordersResult.data || [];
    const revenue = orders.reduce((sum, order) => (
      (order.status || '').toUpperCase() === 'CANCELLED'
        ? sum
        : sum + Number(order.total_amount || 0)
    ), 0);
    const damaged = (deliveriesResult.data || []).reduce((sum, delivery) => (
      sum + Number(delivery.bottles_damaged || 0)
    ), 0);

    res.json({
      revenue,
      deliveries: ordersResult.count || orders.length,
      customers: customersResult.count || 0,
      damaged,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

app.get('/api/admin/orders', requireSupabase, requireOperationsAccess, async (req, res) => {
  try {
    const [authUsersResult, ordersResult] = await Promise.all([
      listAllAuthUsers(),
      supabase.from('orders')
        .select('*, user:users(*), items:order_items(*)')
        .order('created_at', { ascending: false }),
    ]);

    if (ordersResult.error) throw ordersResult.error;

    const phoneByEmail = new Map(
      authUsersResult
        .filter((user) => user.email)
        .map((user) => [user.email.toLowerCase(), user.user_metadata?.phone || user.phone || ''])
    );

    const catalog = await getProductCatalogMap();
    const orders = (ordersResult.data || []).map((order) => {
      let notes = {};
      try {
        notes = order.notes ? JSON.parse(order.notes) : {};
      } catch {
        notes = { deliveryInstructions: order.notes || '' };
      }

      return {
      id: order.id,
      createdAt: order.created_at,
      totalAmount: order.total_amount,
      status: (order.status || 'PENDING').toUpperCase(),
      paymentMethod: order.payment_method || 'COD',
      paymentStatus: order.payment_status || 'UNPAID',
      deliveryAddress: order.delivery_address,
      deliverySlot: order.delivery_slot,
      deliveryInstructions: notes.deliveryInstructions || '',
      emptyBottlesReturned: Number(notes.emptyBottlesReturned || 0),
      user: order.user ? {
        id: order.user.id,
        name: order.user.name,
        email: order.user.email,
        phone: order.user.email ? (phoneByEmail.get(order.user.email.toLowerCase()) || '') : '',
        address: buildAddressDisplay(order.user),
        locationLat: order.user.location_lat,
        locationLng: order.user.location_lng,
      } : null,
      assigned_driver_id: order.assigned_driver_id || null,
      items: (order.items || []).map((item) => {
        const productId = item.product_code || item.product_id || '';
        const catalogProduct = catalog.get(String(productId));
        const quantity = Number(item.quantity || 0);
        const subtotal = Number(item.subtotal || 0);

        return {
          id: item.id,
          order_id: item.order_id,
          product_id: productId,
          productCode: productId,
          productName: catalogProduct?.name || productId || 'Unknown product',
          productCategory: catalogProduct?.category || '',
          unitPrice: quantity > 0 ? Number((subtotal / quantity).toFixed(2)) : Number(catalogProduct?.price || 0),
          quantity,
          subtotal,
          usedCredits: Number(item.used_credits || 0),
        };
      }),
    };
    });

    res.json(orders);
  } catch (error) {
    logError('Failed to fetch admin orders', error);
    res.status(500).json({ error: 'Failed to fetch admin orders' });
  }
});

app.put('/api/admin/orders/:id/status', requireSupabase, requireOperationsAccess, async (req, res) => {
  const { status } = req.body;
  // Normalize status to uppercase for backend consistency
  const normalizedStatus = status ? status.toUpperCase() : 'PENDING';
  // Map frontend status names to backend schema values
  const STATUS_MAP = {
    'ACTIVE': 'OUT_FOR_DELIVERY',
    'PROCESSING': 'PENDING',
    'DELIVERED': 'DELIVERED',
    'CANCELLED': 'CANCELLED',
    'PENDING': 'PENDING',
    'OUT_FOR_DELIVERY': 'OUT_FOR_DELIVERY',
  };
  const dbStatus = STATUS_MAP[normalizedStatus] || normalizedStatus;
  if (!ALLOWED_ORDER_STATUSES.has(dbStatus)) {
    return res.status(400).json({ error: 'Invalid order status' });
  }

  try {
    const { data: order, error } = await supabase.from('orders')
      .update({ status: dbStatus })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    fireAndForgetNotification(() => sendPushToUser(order.user_id, orderNotificationPayload(dbStatus, order.id), 'customer'));
    res.json(order);
  } catch (error) {
    logError('Failed to update order status', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Admin: Get all customers
app.get('/api/admin/customers', requireSupabase, requireAdmin, async (req, res) => {
  try {
    const [authUsers, usersResult, ordersResult] = await Promise.all([
      listAllAuthUsers(),
      supabase.from('users').select('*').eq('role', 'CUSTOMER').order('created_at', { ascending: false }),
      supabase.from('orders').select('id, user_id, status, created_at, total_amount'),
    ]);

    if (usersResult.error) throw usersResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const phoneByEmail = new Map(
      authUsers
        .filter((user) => user.email)
        .map((user) => [user.email.toLowerCase(), user.user_metadata?.phone || user.phone || ''])
    );

    const ordersByUserId = new Map();
    for (const order of ordersResult.data || []) {
      const bucket = ordersByUserId.get(order.user_id) || [];
      bucket.push(order);
      ordersByUserId.set(order.user_id, bucket);
    }

    const customers = (usersResult.data || []).map((customer) => {
      const customerOrders = ordersByUserId.get(customer.id) || [];
      const latestOrder = customerOrders
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

      return {
        id: customer.id,
        name: customer.name || 'Unknown',
        email: customer.email,
        phone: customer.email ? (phoneByEmail.get(customer.email.toLowerCase()) || '') : '',
        address: buildAddressDisplay(customer),
        locationLat: customer.location_lat,
        locationLng: customer.location_lng,
        credits: customer.bottle_credits || 0,
        walletBalance: customer.wallet_balance || 0,
        loyaltyPoints: customer.loyalty_points || 0,
        status: customerOrders.length > 0 ? 'ACTIVE' : 'INACTIVE',
        ordersCount: customerOrders.length,
        lastOrderAt: latestOrder?.created_at || null,
        avatar: (customer.name || 'U')
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() || '')
          .join('') || 'U',
      };
    });

    res.json(customers);
  } catch (error) {
    logError('Failed to fetch customers', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'CORS origin not allowed') {
    return res.status(403).json({ error: 'CORS origin not allowed' });
  }

  logError('Unhandled API error', err);
  return res.status(500).json({ error: 'Internal server error' });
});
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`RS Water Backend API listening on ${HOST}:${PORT} (${NODE_ENV})`);
});
