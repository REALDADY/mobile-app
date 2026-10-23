const test = require('node:test');
const assert = require('node:assert/strict');
const { BUNDLED_EMIRATES_FILE, EMIRATE_ORDER, createEmirateBoundaryLoader, parseEmirateBoundaries } = require('../src/emirate-boundaries');
const { Readable } = require('node:stream');
const {
  CUSTOMER_ID_RE,
  ORDER_BODY_LIMIT_BYTES,
  createWebsiteDispatchProxy,
  readJsonBody,
  websiteDispatchBaseUrl,
} = require('../src/website-dispatch-proxy');

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

// --- Website order entry pass-through (products + orders) ---

function orderProxyWith(fetchImpl, options = {}) {
  return proxyWith(fetchImpl, { writeBaseUrl: 'http://127.0.0.1:4001/api/dispatch/', writeKey: 'server-write-key', ...options });
}

// A request stream like Express hands to middleware mounted before express.json().
function streamReq(raw, headers = {}) {
  const req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  req.get = (name) => lower[name.toLowerCase()];
  return req;
}

async function readBody(raw, headers = { 'content-type': 'application/json' }) {
  const req = streamReq(raw, headers);
  const res = fakeRes();
  const finished = new Promise((resolve) => {
    const json = res.json.bind(res);
    res.json = (body) => { json(body); resolve(); return res; };
    readJsonBody()(req, res, () => { req.nextCalled = true; resolve(); });
  });
  await finished;
  return { req, res };
}

test('products and orders pass-through require a matching key', async () => {
  let fetches = 0;
  const proxy = orderProxyWith(async () => { fetches += 1; return jsonResponse(200, {}); });
  for (const handler of ['products', 'createOrder']) {
    for (const headers of [{}, { 'x-api-key': 'wrong' }, { 'x-dispatch-write-key': 'server-write-key' }, { authorization: 'Bearer admin-key' }]) {
      const req = fakeReq({ headers, originalUrl: '/api/admin/website-dispatch/orders' });
      req.body = { items: [] };
      const res = await runRoute(proxy, handler, req);
      assert.equal(res.statusCode, 401, `${handler} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(fetches, 0);

  for (const headers of [{ 'x-api-key': 'admin-key' }, { 'x-dispatch-read-key': 'driver-key' }]) {
    const req = fakeReq({ headers, originalUrl: '/api/admin/website-dispatch/orders' });
    req.body = { items: [] };
    assert.equal((await runRoute(proxy, 'products', req)).statusCode, 200);
    assert.equal((await runRoute(proxy, 'createOrder', req)).statusCode, 200);
  }
});

test('products pass-through forwards GET /products with status, body and a 20 s timeout', async () => {
  const calls = [];
  const proxy = orderProxyWith(async (url, options) => { calls.push({ url, options }); return jsonResponse(200, { products: [{ id: 'P-1' }] }); }, { readKey: 'website-read-key' });
  const res = await runRoute(proxy, 'products', fakeReq({ headers: { 'x-api-key': 'admin-key' }, originalUrl: '/api/admin/website-dispatch/products?active=1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { products: [{ id: 'P-1' }] });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls[0].url, 'http://127.0.0.1:4001/api/dispatch/products?active=1');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.headers['x-dispatch-read-key'], 'website-read-key');
  assert.equal('x-dispatch-write-key' in calls[0].options.headers, false);
  assert.ok(calls[0].options.signal, 'request has a timeout');
});

test('orders pass-through injects the server write key and ignores a client-supplied one', async () => {
  const calls = [];
  const proxy = orderProxyWith(async (url, options) => { calls.push({ url, options }); return jsonResponse(201, { id: 'W-9' }); });
  const req = fakeReq({
    headers: { 'x-api-key': 'admin-key', 'x-dispatch-write-key': 'client-write-key', 'X-Dispatch-Write-Key': 'client-2' },
    originalUrl: '/api/admin/website-dispatch/orders?writeKey=client',
  });
  req.body = { customerId: 'CUST-1', items: [{ productId: 'P-1', quantity: 2 }], 'x-dispatch-write-key': 'in-body' };
  const res = await runRoute(proxy, 'createOrder', req);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { id: 'W-9' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4001/api/dispatch/orders', 'write base, no client query');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-dispatch-write-key'], 'server-write-key');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.equal(Object.values(calls[0].options.headers).includes('client-write-key'), false);
  assert.equal('x-api-key' in calls[0].options.headers, false, 'client auth is not forwarded');
  assert.deepEqual(JSON.parse(calls[0].options.body), req.body);
  assert.ok(calls[0].options.signal, 'request has a timeout');
});

test('orders pass-through returns the website status and body (201/200/400), 503 when unreachable or unconfigured', async () => {
  for (const [status, body] of [[201, { id: 'W-1' }], [200, { id: 'W-1', duplicate: true }], [400, { error: 'items is required' }]]) {
    const proxy = orderProxyWith(async () => jsonResponse(status, body));
    const req = fakeReq({ headers: { 'x-api-key': 'driver-key' } });
    req.body = { items: [] };
    const res = await runRoute(proxy, 'createOrder', req);
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.body, body);
  }

  const down = orderProxyWith(async () => { throw new TypeError('fetch failed'); });
  for (const handler of ['products', 'createOrder']) {
    const req = fakeReq({ headers: { 'x-api-key': 'admin-key' } });
    req.body = { items: [] };
    const res = await runRoute(down, handler, req);
    assert.equal(res.statusCode, 503, handler);
    assert.deepEqual(res.body, { error: 'The website dispatch API is unreachable' });
  }

  const timedOut = orderProxyWith(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }), { orderEntryTimeoutMs: 20 });
  const slowReq = fakeReq({ headers: { 'x-api-key': 'admin-key' } });
  slowReq.body = { items: [] };
  assert.equal((await runRoute(timedOut, 'createOrder', slowReq)).statusCode, 503);

  let fetches = 0;
  const noWriteKey = orderProxyWith(async () => { fetches += 1; return jsonResponse(201, {}); }, { writeKey: '' });
  const req = fakeReq({ headers: { 'x-api-key': 'admin-key' } });
  req.body = { items: [] };
  const unconfigured = await runRoute(noWriteKey, 'createOrder', req);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(fetches, 0);
});

test('orders write base defaults to the overview base and createOrder rejects a missing body', async () => {
  const calls = [];
  const proxy = proxyWith(async (url) => { calls.push(url); return jsonResponse(201, {}); }, { writeKey: 'k' });
  assert.equal(proxy.ordersUrl, 'http://127.0.0.1:4001/api/dispatch/orders');
  for (const body of [undefined, [], 'text']) {
    const req = fakeReq({ headers: { 'x-api-key': 'admin-key' } });
    req.body = body;
    assert.equal((await runRoute(proxy, 'createOrder', req)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('readJsonBody accepts JSON objects up to 64 KB and rejects larger or non-JSON bodies', async () => {
  const ok = await readBody(JSON.stringify({ items: [{ productId: 'P-1', quantity: 1 }] }), { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(ok.req.nextCalled, true);
  assert.deepEqual(ok.req.body, { items: [{ productId: 'P-1', quantity: 1 }] });
  assert.equal(ok.req._body, true, 'the global express.json() parser will skip it');

  const atLimit = JSON.stringify({ note: 'x'.repeat(ORDER_BODY_LIMIT_BYTES - 11) });
  assert.equal(Buffer.byteLength(atLimit), ORDER_BODY_LIMIT_BYTES);
  assert.equal((await readBody(atLimit)).req.nextCalled, true);

  const tooLarge = JSON.stringify({ note: 'x'.repeat(ORDER_BODY_LIMIT_BYTES) });
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'content-length': String(tooLarge.length) }]) {
    const { req, res } = await readBody(tooLarge, headers);
    assert.equal(res.statusCode, 413, JSON.stringify(headers));
    assert.deepEqual(res.body, { error: 'Request body too large' });
    assert.equal(req.nextCalled, undefined);
  }

  for (const [raw, headers] of [
    ['{"items":[]}', {}],
    ['{"items":[]}', { 'content-type': 'text/plain' }],
    ['items=1', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['{not json', { 'content-type': 'application/json' }],
    ['', { 'content-type': 'application/json' }],
    ['[1,2]', { 'content-type': 'application/json' }],
    ['"text"', { 'content-type': 'application/json' }],
    ['null', { 'content-type': 'application/json' }],
  ]) {
    const { req, res } = await readBody(raw, headers);
    assert.equal(res.statusCode, 400, `${raw} ${JSON.stringify(headers)}`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(req.nextCalled, undefined);
  }
});
