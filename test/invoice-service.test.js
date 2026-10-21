const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildInvoiceShareText,
  companyFromEnv,
  computeInvoiceTotals,
  invoiceTitle,
  renderInvoicePdf,
  signedInvoiceUrl,
  verifyInvoiceDownload,
} = require('../src/invoice-service');

function reconciles(totals) {
  assert.equal(Math.round(totals.subtotal_excl_vat * 100) + Math.round(totals.vat_amount * 100), Math.round(totals.total_incl_vat * 100));
}

test("'added' VAT uses the item lines as the taxable amount when they reproduce the total", () => {
  const totals = computeInvoiceTotals({
    items: [{ name: '5 Gallon', qty: 2, unit_price: 7, line_total: 14 }, { name: '1.5L x 12', qty: 1, unit_price: 12.5, line_total: 12.5 }],
    total: 27.83, // 26.50 + 1.325 -> 1.33 VAT (same rounding as calculateOrderPricing)
    vatMode: 'added',
  });
  assert.equal(totals.subtotal_excl_vat, 26.5);
  assert.equal(totals.vat_amount, 1.33);
  assert.equal(totals.total_incl_vat, 27.83);
  assert.equal(totals.adjustment, 0);
  assert.equal(totals.items_basis, 'excl_vat');
  reconciles(totals);
});

test("'added' VAT derives the split from the total when coupons make the lines differ", () => {
  const totals = computeInvoiceTotals({
    items: [{ name: '5 Gallon', qty: 3, unit_price: 7, line_total: 21 }],
    total: 7.35, // two bottles paid with coupons: taxable 7.00 + VAT 0.35
    vatMode: 'added',
  });
  assert.equal(totals.subtotal_excl_vat, 7);
  assert.equal(totals.vat_amount, 0.35);
  assert.equal(totals.adjustment, -14);
  reconciles(totals);
});

test("'added' VAT prefers an explicit stored VAT amount", () => {
  const totals = computeInvoiceTotals({ items: [], total: 10.51, vatMode: 'added', vatAmount: 0.5 });
  assert.equal(totals.subtotal_excl_vat, 10.01);
  assert.equal(totals.vat_amount, 0.5);
  reconciles(totals);
});

test("'inclusive' VAT is total x 5/105 with exact reconciliation", () => {
  const totals = computeInvoiceTotals({
    items: [{ name: 'Water · 5 Gallon', qty: 1, unit_price: 10, line_total: 10 }],
    total: 10,
    vatMode: 'inclusive',
  });
  assert.equal(totals.vat_amount, 0.48); // 0.476... -> 0.48
  assert.equal(totals.subtotal_excl_vat, 9.52);
  assert.equal(totals.total_incl_vat, 10);
  assert.equal(totals.items_basis, 'incl_vat');
  assert.equal(totals.adjustment, 0);
  reconciles(totals);
});

test('totals reconcile for many awkward amounts in both modes', () => {
  for (let cents = 1; cents <= 20000; cents += 37) {
    const total = cents / 100;
    for (const vatMode of ['added', 'inclusive']) {
      const totals = computeInvoiceTotals({ items: [{ name: 'x', qty: 1, line_total: total }], total, vatMode });
      assert.equal(totals.total_incl_vat, total);
      reconciles(totals);
      assert.ok(totals.vat_amount >= 0 && totals.vat_amount <= total);
    }
  }
});

test('floating point line totals are rounded to cents', () => {
  const totals = computeInvoiceTotals({
    items: [{ name: 'a', qty: 3, unit_price: 0.1, line_total: 0.1 + 0.2 }],
    total: 0.32,
    vatMode: 'added',
  });
  assert.equal(totals.items[0].line_total, 0.3);
  reconciles(totals);
});

test('rejects unknown vat modes', () => {
  assert.throws(() => computeInvoiceTotals({ total: 1, vatMode: 'bogus' }), /vatMode/);
});

function sampleInvoice(extra = {}) {
  return {
    invoice_number: 'INV-2026-000042',
    order_id: 'ARS-20261020-1001',
    order_source: 'operations',
    driver_id: '00000000-0000-4000-8000-000000000001',
    driver_name: 'Driver 1',
    customer_name: 'Maha Al Mansoori',
    customer_phone: '+971500000000',
    customer_address: 'Villa 14, Al Ghail, Ras Al Khaimah',
    items: [{ name: '5 Gallon', size: '', qty: 2, unit_price: 7, line_total: 14 }],
    subtotal_excl_vat: 14,
    vat_amount: 0.7,
    total_incl_vat: 14.7,
    currency: 'AED',
    payment_method: 'cash',
    amount_paid: 20,
    issued_at: '2026-10-20T08:15:00.000Z',
    ...extra,
  };
}

test('renderInvoicePdf renders a TAX INVOICE when a TRN is configured', async () => {
  const company = companyFromEnv({ INVOICE_COMPANY_NAME: 'RS Water', INVOICE_COMPANY_TRN: '100000000000003', INVOICE_COMPANY_ADDRESS: 'Dubai' });
  assert.equal(invoiceTitle(company), 'TAX INVOICE');
  const pdf = await renderInvoicePdf(sampleInvoice(), company);
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
});

test('renderInvoicePdf renders a RECEIPT without a TRN (website, no items)', async () => {
  const company = companyFromEnv({});
  assert.equal(company.name, 'RS Water');
  assert.equal(invoiceTitle(company), 'RECEIPT');
  const pdf = await renderInvoicePdf(sampleInvoice({ order_source: 'website', items: [], payment_method: 'prepaid', total_incl_vat: 52.5, vat_amount: 2.5, subtotal_excl_vat: 50 }), company);
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
});

test('signed invoice links verify, expire and reject tampering', () => {
  const secret = 'test-secret';
  const invoiceId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  const now = Date.UTC(2026, 9, 20);
  const url = new URL(signedInvoiceUrl({ apiBaseUrl: 'https://api.example.test', secret, invoiceId, now }));
  assert.equal(url.pathname, `/api/invoices/${invoiceId}/download`);
  const expires = url.searchParams.get('expires');
  const signature = url.searchParams.get('signature');
  assert.equal(Number(expires), Math.floor(now / 1000) + 7 * 24 * 60 * 60);
  assert.equal(verifyInvoiceDownload({ secret, invoiceId, expires, signature, now }), true);
  assert.equal(verifyInvoiceDownload({ secret, invoiceId, expires, signature, now: now + 8 * 24 * 60 * 60 * 1000 }), false);
  assert.equal(verifyInvoiceDownload({ secret, invoiceId: '2b4e28ba-2fa1-41d2-883f-0016d3cca427', expires, signature, now }), false);
  assert.equal(verifyInvoiceDownload({ secret: 'other', invoiceId, expires, signature, now }), false);
  assert.equal(verifyInvoiceDownload({ secret, invoiceId, expires: Number(expires) + 1, signature, now }), false);
});

test('share text carries the amount and link', () => {
  const text = buildInvoiceShareText({ invoice: sampleInvoice(), company: companyFromEnv({}), url: 'https://x.test/i' });
  assert.match(text, /INV-2026-000042/);
  assert.match(text, /AED 20\.00 paid by cash/);
  assert.match(text, /https:\/\/x\.test\/i$/);
  const prepaid = buildInvoiceShareText({ invoice: sampleInvoice({ payment_method: 'prepaid' }), company: companyFromEnv({ INVOICE_COMPANY_TRN: '1' }), url: 'u' });
  assert.match(prepaid, /tax invoice/);
  assert.match(prepaid, /AED 14\.70 prepaid/);
});
