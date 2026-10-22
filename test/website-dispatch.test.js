const test = require('node:test');
const assert = require('node:assert/strict');
const { BUNDLED_EMIRATES_FILE, EMIRATE_ORDER, createEmirateBoundaryLoader, parseEmirateBoundaries } = require('../src/emirate-boundaries');
const { CUSTOMER_ID_RE, createWebsiteDispatchProxy, websiteDispatchBaseUrl } = require('../src/website-dispatch-proxy');

const quietLogger = { warn() {}, error() {} };

function featureCollection(emirates = EMIRATE_ORDER, type = 'Polygon') {
  return {
    type: 'FeatureCollection',
    features: emirates.map((name, index) => ({
      type: 'Feature',
      properties: { Emirate_En: name },
      geometry: { type, coordinates: [[[50 + index, 24], [51 + index, 24], [51 + index, 25], [50 + index, 24]]] },
    })),
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// --- Emirate boundaries ---

test('the bundled emirates file passes validation', async () => {
  const boundaries = await createEmirateBoundaryLoader({ url: '', logger: quietLogger })();
  assert.deepEqual([...EMIRATE_ORDER].sort(), [...boundaries.keys()].filter((name) => EMIRATE_ORDER.includes(name)).sort());
  EMIRATE_ORDER.forEach((name) => assert.ok(['Polygon', 'MultiPolygon'].includes(boundaries.get(name).type)));
  assert.match(BUNDLED_EMIRATES_FILE, /data-static[\\/]uae-emirates\.geojson\.json$/);
});

test('without EMIRATE_BOUNDARIES_URL the bundled file is used and nothing is fetched', async () => {
  let fetches = 0;
  const load = createEmirateBoundaryLoader({ url: '', fetchImpl: async () => { fetches += 1; }, logger: quietLogger });
  const first = await load();
  assert.equal(first.size >= 7, true);
  assert.equal(await load(), first, 'cached');
  assert.equal(fetches, 0);
});

test('with EMIRATE_BOUNDARIES_URL the feed is used when valid', async () => {
  const calls = [];
  const load = createEmirateBoundaryLoader({
    url: 'http://console.local/api/emirates',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, featureCollection()); },
    logger: quietLogger,
  });
  const boundaries = await load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://console.local/api/emirates');
  assert.ok(calls[0].options.signal, 'request has a timeout');
  assert.deepEqual(boundaries.get('Dubai').coordinates[0][0], [51, 24], 'geometry comes from the feed, not the bundle');
});

test('a failing, erroring or incomplete feed falls back to the bundled file', async () => {
  const bundled = await createEmirateBoundaryLoader({ url: '', logger: quietLogger })();
  const failures = [
    async () => { throw new Error('connect ECONNREFUSED'); },
    async () => jsonResponse(502, { error: 'bad gateway' }),
    async () => jsonResponse(200, featureCollection(EMIRATE_ORDER.slice(1))),
    async () => jsonResponse(200, featureCollection(EMIRATE_ORDER, 'Point')),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
  ];
  for (const fetchImpl of failures) {
    const warnings = [];
    const load = createEmirateBoundaryLoader({ url: 'http://console.local/api/emirates', fetchImpl, logger: { warn: (message) => warnings.push(message) } });
    const boundaries = await load();
    assert.deepEqual(boundaries.get('Dubai'), bundled.get('Dubai'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /using the bundled file/);
  }
});

test('parseEmirateBoundaries rejects missing or non-polygon emirates', () => {
  assert.equal(parseEmirateBoundaries(featureCollection(EMIRATE_ORDER, 'MultiPolygon')).size, 7);
  assert.throws(() => parseEmirateBoundaries(featureCollection(EMIRATE_ORDER.slice(0, 6))), /incomplete \(Fujairah\)/);
  assert.throws(() => parseEmirateBoundaries({}), /incomplete/);
  assert.throws(() => parseEmirateBoundaries(featureCollection(EMIRATE_ORDER, 'LineString')), /incomplete/);
});

// --- Website dispatch pass-through ---

function fakeReq({ headers = {}, params = {}, originalUrl = '/api/admin/website-dispatch/overview' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { params, originalUrl, ip: '127.0.0.1', get: (name) => lower[name.toLowerCase()] };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function runRoute(proxy, handler, req) {
  const res = fakeRes();
  let passed = false;
  await proxy.requireKey(req, res, () => { passed = true; });
  if (passed) await proxy[handler](req, res);
  return res;
}

function proxyWith(fetchImpl, options = {}) {
  return createWebsiteDispatchProxy({
    overviewUrl: 'http://127.0.0.1:4001/api/dispatch/overview',
    apiKeys: ['admin-key', 'driver-key', ''],
    fetchImpl,
    logger: quietLogger,
    ...options,
  });
}

test('websiteDispatchBaseUrl strips /overview like the write base URL default', () => {
  assert.equal(websiteDispatchBaseUrl('http://127.0.0.1:4001/api/dispatch/overview'), 'http://127.0.0.1:4001/api/dispatch');
  assert.equal(websiteDispatchBaseUrl('http://127.0.0.1:4001/api/dispatch/overview/'), 'http://127.0.0.1:4001/api/dispatch');
});

test('website dispatch proxy requires a matching key in either header and never bypasses loopback', async () => {
  let fetches = 0;
  const proxy = proxyWith(async () => { fetches += 1; return jsonResponse(200, { orders: [] }); });

  for (const headers of [{}, { 'x-api-key': 'wrong' }, { 'x-dispatch-read-key': 'admin-key-x' }, { authorization: 'Bearer admin-key' }, { 'x-api-key': '' }]) {
    const res = await runRoute(proxy, 'overview', fakeReq({ headers }));
    assert.equal(res.statusCode, 401, JSON.stringify(headers));
    assert.deepEqual(res.body, { error: 'Unauthorized' });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(fetches, 0);

  for (const headers of [{ 'x-dispatch-read-key': 'driver-key' }, { 'x-api-key': 'admin-key' }, { 'x-api-key': 'nope', 'x-dispatch-read-key': 'driver-key' }]) {
    const res = await runRoute(proxy, 'overview', fakeReq({ headers }));
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
  }

  const noKeys = createWebsiteDispatchProxy({ overviewUrl: 'http://x/overview', apiKeys: ['', undefined], fetchImpl: async () => jsonResponse(200, {}), logger: quietLogger });
  assert.equal((await runRoute(noKeys, 'overview', fakeReq({ headers: { 'x-api-key': '' } }))).statusCode, 401);
});

test('website dispatch proxy passes status, JSON body and query through, forwarding the read key', async () => {
  const calls = [];
  const proxy = proxyWith(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(207, { orders: [{ id: 'W-1' }], generatedAt: 'now' });
  }, { readKey: 'website-read-key' });
  const res = await runRoute(proxy, 'overview', fakeReq({
    headers: { 'x-api-key': 'admin-key' },
    originalUrl: '/api/admin/website-dispatch/overview?date=2026-10-22',
  }));
  assert.equal(res.statusCode, 207);
  assert.deepEqual(res.body, { orders: [{ id: 'W-1' }], generatedAt: 'now' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls[0].url, 'http://127.0.0.1:4001/api/dispatch/overview?date=2026-10-22');
  assert.equal(calls[0].options.headers['x-dispatch-read-key'], 'website-read-key');
  assert.ok(calls[0].options.signal, 'request has a timeout');

  const withoutReadKey = proxyWith(async (url, options) => { calls.push({ url, options }); return jsonResponse(404, { error: 'Not found' }); });
  const notFound = await runRoute(withoutReadKey, 'overview', fakeReq({ headers: { 'x-api-key': 'driver-key' } }));
  assert.equal(notFound.statusCode, 404);
  assert.deepEqual(notFound.body, { error: 'Not found' });
  assert.equal('x-dispatch-read-key' in calls[1].options.headers, false);
});

test('website dispatch proxy validates customer ids before calling the website', async () => {
  const calls = [];
  const proxy = proxyWith(async (url) => { calls.push(url); return jsonResponse(200, { orders: [] }); });
  const auth = { 'x-dispatch-read-key': 'admin-key' };

  for (const id of ['3f6c1a52-8a3e-4c41-9a1e-2f0b7f3d9c10', 'CUST-1001', 'a.b_c:d-1']) {
    const res = await runRoute(proxy, 'customerOrders', fakeReq({ headers: auth, params: { id }, originalUrl: `/api/admin/website-dispatch/customers/${id}/orders` }));
    assert.equal(res.statusCode, 200, id);
  }
  assert.deepEqual(calls, [
    'http://127.0.0.1:4001/api/dispatch/customers/3f6c1a52-8a3e-4c41-9a1e-2f0b7f3d9c10/orders',
    'http://127.0.0.1:4001/api/dispatch/customers/CUST-1001/orders',
    'http://127.0.0.1:4001/api/dispatch/customers/a.b_c%3Ad-1/orders',
  ]);

  for (const id of ['', '../overview', 'a/b', 'a b', 'x'.repeat(81), 'id?x=1', '%2e%2e']) {
    const res = await runRoute(proxy, 'customerOrders', fakeReq({ headers: auth, params: { id } }));
    assert.equal(res.statusCode, 400, JSON.stringify(id));
    assert.deepEqual(res.body, { error: 'Invalid customer id' });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(calls.length, 3);
  assert.equal(CUSTOMER_ID_RE.test('x'.repeat(80)), true);
});

test('website dispatch proxy answers 503 when the website is unreachable and 502 on non-JSON', async () => {
  const down = proxyWith(async () => { throw new TypeError('fetch failed'); });
  const unreachable = await runRoute(down, 'overview', fakeReq({ headers: { 'x-api-key': 'admin-key' } }));
  assert.equal(unreachable.statusCode, 503);
  assert.deepEqual(unreachable.body, { error: 'The website dispatch API is unreachable' });
  assert.equal(unreachable.headers['cache-control'], 'no-store');

  const timedOut = proxyWith(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }), { timeoutMs: 20 });
  assert.equal((await runRoute(timedOut, 'overview', fakeReq({ headers: { 'x-api-key': 'admin-key' } }))).statusCode, 503);

  const html = proxyWith(async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  const invalid = await runRoute(html, 'customerOrders', fakeReq({ headers: { 'x-api-key': 'admin-key' }, params: { id: 'CUST-1' } }));
  assert.equal(invalid.statusCode, 502);
});
