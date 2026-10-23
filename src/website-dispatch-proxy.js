// Key-protected pass-through to the website's dispatch read API, for the dispatch console on the
// office PC (on the VPS the website's /api/dispatch/* is only reachable from loopback).
//   GET /api/admin/website-dispatch/overview               -> {base}/overview
//   GET /api/admin/website-dispatch/customers/:id/orders   -> {base}/customers/:id/orders
//   GET /api/admin/website-dispatch/products               -> {base}/products
//   POST /api/admin/website-dispatch/orders                -> {writeBase}/orders (+ server-side x-dispatch-write-key)
// No loopback bypass: every request needs x-dispatch-read-key or x-api-key.
const crypto = require('crypto');

const CUSTOMER_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/; // covers UUIDs too
const PROXY_TIMEOUT_MS = 10_000;
const ORDER_ENTRY_TIMEOUT_MS = 20_000;
const ORDER_BODY_LIMIT_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

// Same derivation as WEBSITE_DISPATCH_WRITE_BASE_URL's default: strip the trailing /overview.
function websiteDispatchBaseUrl(overviewUrl) {
  return String(overviewUrl || '').replace(/\/overview\/?$/, '').replace(/\/$/, '');
}

// Hashing first makes the comparison constant-time regardless of length.
function keyMatches(expected, provided) {
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(provided)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Reads a JSON object body of at most limitBytes. Mount it before the global express.json() parser:
// setting req._body makes that parser skip the request, so its 8 MB limit never applies here.
function readJsonBody({ limitBytes = ORDER_BODY_LIMIT_BYTES } = {}) {
  return function jsonBody(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    if (!JSON_CONTENT_TYPE_RE.test(String(req.get('content-type') || ''))) {
      return res.status(400).json({ error: 'Expected a JSON body' });
    }
    if (Number(req.get('content-length')) > limitBytes) {
      req.resume();
      return res.status(413).json({ error: 'Request body too large' });
    }

    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        res.status(413).json({ error: 'Request body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      res.status(400).json({ error: 'Could not read the request body' });
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Expected a JSON object' });
      }
      req.body = body;
      req._body = true;
      return next();
    });
    return undefined;
  };
}

function createWebsiteDispatchProxy({
  overviewUrl,
  writeBaseUrl = '',
  apiKeys = [],
  readKey = '',
  writeKey = '',
  fetchImpl = fetch,
  timeoutMs = PROXY_TIMEOUT_MS,
  orderEntryTimeoutMs = ORDER_ENTRY_TIMEOUT_MS,
  logger = console,
}) {
  const baseUrl = websiteDispatchBaseUrl(overviewUrl);
  const ordersUrl = `${String(writeBaseUrl || baseUrl).replace(/\/$/, '')}/orders`;
  const keys = apiKeys.filter(Boolean);

  function requireKey(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    const provided = [req.get('x-dispatch-read-key'), req.get('x-api-key')].filter(Boolean);
    const allowed = provided.some((candidate) => keys.some((key) => keyMatches(key, candidate)));
    if (!allowed) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }

  function forward(req, res, websitePath, requestTimeoutMs = timeoutMs) {
    const queryIndex = String(req.originalUrl || '').indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const headers = { Accept: 'application/json', 'user-agent': 'delivery-driver-operations/1.0' };
    if (readKey) headers['x-dispatch-read-key'] = readKey;
    return send(res, `${baseUrl}${websitePath}${query}`, { headers }, requestTimeoutMs);
  }

  // Outgoing headers are always built here; nothing the client sent (e.g. its own write key) is forwarded.
  async function send(res, url, init, requestTimeoutMs) {
    res.setHeader('Cache-Control', 'no-store');
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch (error) {
      logger.error('Website dispatch proxy failed', { message: error?.message || String(error) });
      return res.status(503).json({ error: 'The website dispatch API is unreachable' });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return res.status(502).json({ error: 'The website dispatch API returned an invalid response' });
    }
    return res.status(response.status).json(body);
  }

  function overview(req, res) {
    return forward(req, res, '/overview');
  }

  function customerOrders(req, res) {
    const customerId = String(req.params.id || '');
    if (!CUSTOMER_ID_RE.test(customerId)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'Invalid customer id' });
    }
    return forward(req, res, `/customers/${encodeURIComponent(customerId)}/orders`);
  }

  function products(req, res) {
    return forward(req, res, '/products', orderEntryTimeoutMs);
  }

  // Expects req.body from readJsonBody (mounted ahead of the global JSON parser).
  function createOrder(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected a JSON object' });
    }
    if (!writeKey) {
      logger.error('Website dispatch order proxy: WEBSITE_DISPATCH_WRITE_KEY is not set');
      return res.status(503).json({ error: 'Website order entry is not configured' });
    }
    const headers = {
      Accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'delivery-driver-operations/1.0',
      'x-dispatch-write-key': writeKey,
    };
    return send(res, ordersUrl, { method: 'POST', headers, body: JSON.stringify(req.body) }, orderEntryTimeoutMs);
  }

  return { baseUrl, ordersUrl, requireKey, overview, customerOrders, products, createOrder };
}

module.exports = {
  CUSTOMER_ID_RE,
  ORDER_BODY_LIMIT_BYTES,
  createWebsiteDispatchProxy,
  readJsonBody,
  websiteDispatchBaseUrl,
};
