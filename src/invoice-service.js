// Pure invoice helpers: VAT totals, PDF rendering, signed download links and share text.
// No Supabase or network access here; server.js numbers, stores and serves the invoices.

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const UAE_TIME_ZONE = 'Asia/Dubai';
const VAT_RATE_PERCENT = 5;
const INVOICE_LINK_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const PAYMENT_METHOD_LABELS = { cash: 'Cash', card: 'Card', prepaid: 'Prepaid' };

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Math.sign(number) * Number.EPSILON) * 100) : 0;
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

function normalizeInvoiceItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const qty = Number(item?.qty ?? item?.quantity ?? 0);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
    const unitPrice = Number(item?.unit_price ?? item?.unitPrice ?? 0);
    const rawLineTotal = item?.line_total ?? item?.lineTotal ?? item?.subtotal;
    const lineTotal = rawLineTotal != null && Number.isFinite(Number(rawLineTotal))
      ? Number(rawLineTotal)
      : (Number.isFinite(unitPrice) ? unitPrice : 0) * safeQty;
    return {
      name: String(item?.name || 'Item').slice(0, 160),
      size: String(item?.size || '').slice(0, 60),
      qty: safeQty,
      unit_price: fromCents(toCents(unitPrice)),
      line_total: fromCents(toCents(lineTotal)),
    };
  });
}

// vatMode 'added': the order total is a taxable amount plus 5% VAT on top (operations orders).
//   When the item line totals reproduce the total that way, they are the taxable amount;
//   otherwise (coupons, deposits) the split is derived from the total. An explicit vatAmount
//   (e.g. the stored order pricing) wins when it is consistent with the total.
// vatMode 'inclusive': the total already contains VAT, VAT = total × 5/105 (website orders).
// The three numbers always reconcile exactly: subtotal_excl_vat + vat_amount = total_incl_vat.
function computeInvoiceTotals({ items = [], total, vatMode = 'added', vatAmount } = {}) {
  if (!['added', 'inclusive'].includes(vatMode)) throw new Error(`Unknown vatMode: ${vatMode}`);
  const normalizedItems = normalizeInvoiceItems(items);
  const itemsCents = normalizedItems.reduce((sum, item) => sum + toCents(item.line_total), 0);
  const totalCents = total == null || total === '' || !Number.isFinite(Number(total))
    ? (vatMode === 'added' ? itemsCents + Math.round(itemsCents * VAT_RATE_PERCENT / 100) : itemsCents)
    : toCents(total);
  if (totalCents < 0) throw new Error('Invoice total cannot be negative');

  let vatCents;
  const explicitVatCents = vatAmount != null && vatAmount !== '' && Number.isFinite(Number(vatAmount)) ? toCents(vatAmount) : null;
  if (explicitVatCents != null && explicitVatCents >= 0 && explicitVatCents <= totalCents) {
    vatCents = explicitVatCents;
  } else if (vatMode === 'added' && itemsCents > 0
    && itemsCents + Math.round(itemsCents * VAT_RATE_PERCENT / 100) === totalCents) {
    vatCents = totalCents - itemsCents;
  } else {
    vatCents = Math.round(totalCents * VAT_RATE_PERCENT / (100 + VAT_RATE_PERCENT));
  }
  const subtotalCents = totalCents - vatCents;
  // Line totals are VAT-exclusive for 'added' and VAT-inclusive for 'inclusive'; any gap to the
  // matching base (coupons, deposits, missing lines) is shown as an adjustment line.
  const basisCents = vatMode === 'added' ? subtotalCents : totalCents;
  return {
    items: normalizedItems,
    subtotal_excl_vat: fromCents(subtotalCents),
    vat_amount: fromCents(vatCents),
    total_incl_vat: fromCents(totalCents),
    vat_rate: VAT_RATE_PERCENT,
    items_basis: vatMode === 'added' ? 'excl_vat' : 'incl_vat',
    items_total: fromCents(itemsCents),
    adjustment: fromCents(basisCents - itemsCents),
  };
}

function companyFromEnv(env = process.env) {
  return {
    name: String(env.INVOICE_COMPANY_NAME || 'RS Water').trim() || 'RS Water',
    trn: String(env.INVOICE_COMPANY_TRN || '').trim(),
    address: String(env.INVOICE_COMPANY_ADDRESS || '').trim(),
    phone: String(env.INVOICE_COMPANY_PHONE || '').trim(),
    email: String(env.INVOICE_COMPANY_EMAIL || '').trim(),
  };
}

function invoiceTitle(company = {}) {
  return company.trn ? 'TAX INVOICE' : 'RECEIPT';
}

function formatAed(value) {
  return `AED ${Number(value || 0).toFixed(2)}`;
}

function formatDubaiDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-AE', {
    timeZone: UAE_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function paymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[String(method || '').toLowerCase()] || 'Not recorded';
}

// invoice: a row shaped like public.invoices (snake_case) plus optional driver_name.
function renderInvoicePdf(invoice, company = companyFromEnv()) {
  return new Promise((resolve, reject) => {
    const title = invoiceTitle(company);
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: {
      Title: `${title} ${invoice.invoice_number}`,
      Author: company.name,
      Subject: `${title} for order ${invoice.order_id}`,
    } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Same palette and fonts as the driver end-of-day report.
    const violet = '#6656D9';
    const ink = '#171A24';
    const slate = '#6F7684';
    const line = '#E4E6EA';
    const green = '#158765';
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 84;
    const right = pageWidth - 42;
    const label = (text, x, y, options = {}) => doc.font('Helvetica-Bold').fontSize(7).fillColor(slate)
      .text(text, x, y, { characterSpacing: 0.6, ...options });

    doc.save().rect(0, 0, pageWidth, 112).fill(violet).restore();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').text(company.name.toUpperCase(), 42, 30, { width: 300 });
    doc.font('Helvetica-Bold').fontSize(24).text(title, 42, 51, { width: 300 });
    const companyLines = [
      company.address,
      company.phone && `Tel ${company.phone}`,
      company.email,
      company.trn && `TRN ${company.trn}`,
    ].filter(Boolean);
    doc.font('Helvetica').fontSize(8).fillColor('#E7E3FF')
      .text(companyLines.join('\n') || ' ', 340, 30, { width: right - 340, align: 'right' });

    const metaY = 136;
    label('INVOICE NUMBER', 42, metaY);
    label('DATE', 226, metaY);
    label('ORDER', 410, metaY);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(invoice.invoice_number, 42, metaY + 13, { width: 175 });
    doc.font('Helvetica').fontSize(10).fillColor(ink).text(`${formatDubaiDateTime(invoice.issued_at)} (UAE)`, 226, metaY + 13, { width: 175 });
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(String(invoice.order_id || ''), 410, metaY + 13, { width: right - 410 });

    const customerY = metaY + 46;
    const customerLines = [invoice.customer_phone, invoice.customer_address].filter(Boolean).join('\n');
    const customerHeight = 44 + (customerLines ? doc.font('Helvetica').fontSize(9).heightOfString(customerLines, { width: contentWidth - 24 }) : 0);
    doc.roundedRect(42, customerY, contentWidth, customerHeight, 7).fillAndStroke('#F6F5FC', '#E6E2F8');
    label('BILL TO', 54, customerY + 11);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(invoice.customer_name || 'Customer', 54, customerY + 23, { width: contentWidth - 24 });
    if (customerLines) doc.font('Helvetica').fontSize(9).fillColor(slate).text(customerLines, 54, customerY + 38, { width: contentWidth - 24 });

    const columns = { item: 54, qty: 330, unit: 380, total: 460 };
    let y = customerY + customerHeight + 22;
    label('ITEM', columns.item, y);
    label('QTY', columns.qty, y, { width: 40, align: 'right' });
    label('UNIT PRICE', columns.unit, y, { width: 70, align: 'right' });
    label('AMOUNT', columns.total, y, { width: right - 12 - columns.total, align: 'right' });
    y += 14;
    doc.moveTo(42, y).lineTo(right, y).strokeColor(line).stroke();
    y += 8;

    const vatMode = invoice.order_source === 'website' ? 'inclusive' : 'added';
    const totals = computeInvoiceTotals({ items: invoice.items, total: invoice.total_incl_vat, vatMode, vatAmount: invoice.vat_amount });
    const rows = totals.items.map((item) => ({
      name: [item.name, item.size].filter(Boolean).join(' · '),
      qty: item.qty ? String(item.qty) : '',
      unit: item.qty ? Number(item.unit_price).toFixed(2) : '',
      amount: Number(item.line_total).toFixed(2),
    }));
    if (!rows.length) {
      rows.push({ name: `Water delivery - order ${invoice.order_id}`, qty: '', unit: '', amount: (totals.adjustment).toFixed(2) });
    } else if (Math.abs(totals.adjustment) >= 0.005) {
      rows.push({ name: totals.adjustment < 0 ? 'Discounts and coupons' : 'Other charges', qty: '', unit: '', amount: totals.adjustment.toFixed(2) });
    }
    rows.forEach((row) => {
      const rowHeight = Math.max(16, doc.font('Helvetica').fontSize(9).heightOfString(row.name, { width: columns.qty - columns.item - 12 }) + 6);
      if (y + rowHeight > doc.page.height - 200) {
        doc.addPage();
        y = 60;
      }
      doc.font('Helvetica').fontSize(9).fillColor(ink).text(row.name, columns.item, y, { width: columns.qty - columns.item - 12 });
      doc.text(row.qty, columns.qty, y, { width: 40, align: 'right' });
      doc.text(row.unit, columns.unit, y, { width: 70, align: 'right' });
      doc.text(row.amount, columns.total, y, { width: right - 12 - columns.total, align: 'right' });
      y += rowHeight;
      doc.moveTo(42, y - 3).lineTo(right, y - 3).strokeColor(line).stroke();
    });
    if (totals.items_basis === 'incl_vat') {
      doc.font('Helvetica').fontSize(7).fillColor(slate).text('Item prices include VAT.', columns.item, y + 2);
    }

    y += 18;
    const totalsX = 330;
    const totalLine = (name, value, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9).fillColor(ink)
        .text(name, totalsX, y, { width: 120 });
      doc.text(value, totalsX + 120, y, { width: right - 12 - totalsX - 120, align: 'right' });
      y += bold ? 20 : 15;
    };
    totalLine('Subtotal (excl. VAT)', formatAed(totals.subtotal_excl_vat));
    totalLine(`VAT ${VAT_RATE_PERCENT}%`, formatAed(totals.vat_amount));
    doc.moveTo(totalsX, y).lineTo(right, y).strokeColor(line).stroke();
    y += 6;
    totalLine('Total', formatAed(totals.total_incl_vat), true);

    y += 10;
    doc.roundedRect(42, y, contentWidth, 52, 7).fillAndStroke('#EFF9F5', '#D5EFE5');
    label('PAYMENT METHOD', 54, y + 11);
    label('AMOUNT PAID', 226, y + 11);
    label('DELIVERED BY', 410, y + 11);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(green).text(paymentMethodLabel(invoice.payment_method), 54, y + 25, { width: 160 });
    doc.text(formatAed(invoice.amount_paid), 226, y + 25, { width: 175 });
    doc.font('Helvetica').fontSize(10).fillColor(ink).text(invoice.driver_name || 'Driver', 410, y + 25, { width: right - 422 });
    y += 76;

    doc.font('Helvetica-Bold').fontSize(13).fillColor(violet).text('Thank you', 42, y, { width: contentWidth, align: 'center' });
    if (!company.trn) {
      doc.font('Helvetica').fontSize(7).fillColor(slate)
        .text('This receipt is not a tax invoice.', 42, y + 20, { width: contentWidth, align: 'center' });
    }

    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      doc.font('Helvetica').fontSize(7).fillColor('#8A909B')
        .text(`${company.name} | ${invoice.invoice_number}`, 42, doc.page.height - 60, { width: 380, lineBreak: false });
      doc.text(`Page ${index + 1} of ${range.count}`, pageWidth - 130, doc.page.height - 60, { width: 88, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// Download links are HMAC-signed like the driver report links; the "invoice:" prefix keeps
// an invoice signature from ever validating as a report signature and vice versa.
function invoiceSignature(secret, invoiceId, expires) {
  return crypto.createHmac('sha256', secret).update(`invoice:${invoiceId}:${expires}`).digest('base64url');
}

function signedInvoiceUrl({ apiBaseUrl, secret, invoiceId, lifetimeSeconds = INVOICE_LINK_LIFETIME_SECONDS, now = Date.now() }) {
  const expires = Math.floor(now / 1000) + lifetimeSeconds;
  const signature = invoiceSignature(secret, invoiceId, expires);
  return `${apiBaseUrl}/api/invoices/${encodeURIComponent(invoiceId)}/download?expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

function verifyInvoiceDownload({ secret, invoiceId, expires, signature, now = Date.now() }) {
  const safeExpires = Number(expires);
  if (!secret || !Number.isInteger(safeExpires) || safeExpires < Math.floor(now / 1000) || !signature) return false;
  const expected = invoiceSignature(secret, invoiceId, safeExpires);
  const provided = String(signature);
  return expected.length === provided.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

// Short WhatsApp/SMS-ready text.
function buildInvoiceShareText({ invoice, company = companyFromEnv(), url }) {
  const document = company.trn ? 'tax invoice' : 'receipt';
  const method = String(invoice.payment_method || '').toLowerCase();
  const paid = method === 'prepaid'
    ? `${formatAed(invoice.total_incl_vat)} prepaid`
    : Number(invoice.amount_paid || 0) > 0
      ? `${formatAed(invoice.amount_paid)} paid by ${paymentMethodLabel(method).toLowerCase()}`
      : `total ${formatAed(invoice.total_incl_vat)}`;
  return `${company.name}: your ${document} ${invoice.invoice_number} for order ${invoice.order_id} (${paid}). Download: ${url}`;
}

module.exports = {
  INVOICE_LINK_LIFETIME_SECONDS,
  VAT_RATE_PERCENT,
  buildInvoiceShareText,
  companyFromEnv,
  computeInvoiceTotals,
  invoiceTitle,
  normalizeInvoiceItems,
  renderInvoicePdf,
  signedInvoiceUrl,
  verifyInvoiceDownload,
};
