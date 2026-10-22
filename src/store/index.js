// Picks where the driver backend keeps its own data, from the environment:
//   DRIVER_DATABASE_URL set  -> 'postgres': driver_ops schema in the website's PostgreSQL
//                               database + files on disk under DRIVER_FILES_DIR.
//   else Supabase configured -> 'supabase': Supabase tables + Supabase Storage (unchanged).
//   else                     -> 'none': driver tables report as missing (memory-only
//                               behaviour, like an unapplied migration) + files on disk.
// Nothing here opens a network connection; pg connects lazily on the first query.
const path = require('path');
const { createPostgresPool, createPostgresStore } = require('./postgres');
const { createSupabaseStore } = require('./supabase');
const { createDiskFileStore } = require('./files-disk');
const { createSupabaseFileStore } = require('./files-supabase');

const DEFAULT_FILES_DIR = './data/files';

function assertHttpUrl(name, value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL.`);
  }
}

// { url, serviceKey } when Supabase is configured, null when both variables are absent.
// Half a configuration is almost certainly a mistake, so it still stops the server.
function resolveSupabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim();
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url && !serviceKey) return null;
  if (!url || !serviceKey) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither (Supabase is optional when DRIVER_DATABASE_URL is set).');
  }
  assertHttpUrl('SUPABASE_URL', url);
  return { url, serviceKey };
}

function selectStorageMode(env = process.env, { supabaseConfigured = false } = {}) {
  if (String(env.DRIVER_DATABASE_URL || '').trim()) return 'postgres';
  return supabaseConfigured ? 'supabase' : 'none';
}

function resolveFilesDir(env = process.env, cwd = process.cwd()) {
  return path.resolve(cwd, String(env.DRIVER_FILES_DIR || '').trim() || DEFAULT_FILES_DIR);
}

function missingStoreError() {
  const error = new Error('relation does not exist: no driver database is configured (set DRIVER_DATABASE_URL)');
  error.code = '42P01';
  return error;
}

// Every call answers "table missing", so server.js warns once and runs memory-only.
function createUnavailableStore() {
  const missing = async () => ({ data: null, error: missingStoreError() });
  return {
    kind: 'none',
    schemaLabel: 'Driver table',
    loadDriverSessions: missing,
    upsertDriverSession: missing,
    insertDriverLocation: missing,
    listRoutePlans: missing,
    updateRoutePlanOrders: missing,
    deleteRoutePlan: missing,
    upsertRoutePlan: missing,
    insertDeliveryAttempt: missing,
    findDeliveryAttemptByKey: missing,
    listDeliveryAttempts: missing,
    findInvoiceByOrder: missing,
    findInvoiceById: missing,
    listInvoices: missing,
    nextInvoiceNumber: missing,
    insertInvoice: missing,
    setInvoicePdf: missing,
    async close() {},
  };
}

// Returns { mode, store, files, filesDir, pool }.
function createDriverStorage({ env = process.env, supabase = null, Pool, apiBaseUrl = '', signingSecret = '', cwd } = {}) {
  const mode = selectStorageMode(env, { supabaseConfigured: Boolean(supabase) });
  const diskFiles = () => {
    const filesDir = resolveFilesDir(env, cwd);
    return { filesDir, files: createDiskFileStore({ rootDir: filesDir, apiBaseUrl, signingSecret }) };
  };

  if (mode === 'postgres') {
    const pool = createPostgresPool({ connectionString: String(env.DRIVER_DATABASE_URL).trim(), ...(Pool ? { Pool } : {}) });
    const store = createPostgresStore({ query: (config) => pool.query(config) });
    store.close = () => pool.end();
    return { mode, store, pool, ...diskFiles() };
  }
  if (mode === 'supabase') {
    return { mode, store: createSupabaseStore(supabase), files: createSupabaseFileStore(supabase), filesDir: null, pool: null };
  }
  return { mode, store: createUnavailableStore(), pool: null, ...diskFiles() };
}

module.exports = {
  DEFAULT_FILES_DIR,
  createDriverStorage,
  createUnavailableStore,
  resolveFilesDir,
  resolveSupabaseConfig,
  selectStorageMode,
};
