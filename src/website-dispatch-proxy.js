// Key-protected pass-through to the website's dispatch read API, for the dispatch console on the
// office PC (on the VPS the website's /api/dispatch/* is only reachable from loopback).
//   GET /api/admin/website-dispatch/overview               -> {base}/overview
//   GET /api/admin/website-dispatch/customers/:id/orders   -> {base}/customers/:id/orders
// No loopback bypass: every request needs x-dispatch-read-key or x-api-key.
const crypto = require('crypto');

const CUSTOMER_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/; // covers UUIDs too
const PROXY_TIMEOUT_MS = 10_000;

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

function createWebsiteDispatchProxy({ overviewUrl, apiKeys = [], readKey = '', fetchImpl = fetch, timeoutMs = PROXY_TIMEOUT_MS, logger = console }) {
  const baseUrl = websiteDispatchBaseUrl(overviewUrl);
  const keys = apiKeys.filter(Boolean);

  function requireKey(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    const provided = [req.get('x-dispatch-read-key'), req.get('x-api-key')].filter(Boolean);
    const allowed = provided.some((candidate) => keys.some((key) => keyMatches(key, candidate)));
    if (!allowed) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }

  async function forward(req, res, websitePath) {
    res.setHeader('Cache-Control', 'no-store');
    const queryIndex = String(req.originalUrl || '').indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const headers = { Accept: 'application/json', 'user-agent': 'delivery-driver-operations/1.0' };
    if (readKey) headers['x-dispatch-read-key'] = readKey;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${websitePath}${query}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
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

  return { baseUrl, requireKey, overview, customerOrders };
}

module.exports = { CUSTOMER_ID_RE, createWebsiteDispatchProxy, websiteDispatchBaseUrl };
