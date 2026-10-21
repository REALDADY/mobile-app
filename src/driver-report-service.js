const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { computeDaySummary } = require('./day-summary-service');

const DEFAULT_BUCKET = 'driver-day-reports';
const INDEX_PATH = 'reports-index.json';
const UAE_TIME_ZONE = 'Asia/Dubai';

// Journal entries carry the request's Idempotency-Key (requestKey) when the app sent one. A
// write for the same order + outcome + key is a replay of a request already journaled: the
// original entry is kept and nothing is written. Otherwise there is one entry per order and the
// newest wins. Both return true when the journal changed.
function upsertJournalDelivery(journal, delivery) {
  journal.deliveries ||= [];
  const existingIndex = journal.deliveries.findIndex((item) => item.orderId === delivery.orderId);
  const existing = existingIndex >= 0 ? journal.deliveries[existingIndex] : null;
  if (delivery.requestKey && existing?.requestKey === delivery.requestKey) return false;
  if (existing) journal.deliveries[existingIndex] = delivery;
  else journal.deliveries.push(delivery);
  return true;
}

function upsertJournalFailure(journal, exception) {
  const isOrderFailure = (item) => item?.status === 'FAILED' && item.orderId === exception.orderId;
  const exceptions = journal.exceptions || [];
  if (exception.requestKey && exceptions.some((item) => isOrderFailure(item) && item.requestKey === exception.requestKey)) {
    return false;
  }
  journal.exceptions = exceptions.filter((item) => !isOrderFailure(item));
  journal.exceptions.push(exception);
  return true;
}

function createDriverReportService({ supabase, apiBaseUrl, signingSecret, bucket = DEFAULT_BUCKET }) {
  const locks = new Map();
  let bucketPromise;

  function withLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    locks.set(key, current);
    return current.finally(() => {
      if (locks.get(key) === current) locks.delete(key);
    });
  }

  function dateKey(value = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: UAE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function reportId(driverId, reportDate) {
    return `${String(driverId).replace(/[^A-Za-z0-9-]/g, '_')}--${reportDate}`;
  }

  function journalPath(driverId, reportDate) {
    return `journals/${String(driverId).replace(/[^A-Za-z0-9-]/g, '_')}/${reportDate}.json`;
  }

  function pdfPath(driverId, reportDate) {
    return `reports/${String(driverId).replace(/[^A-Za-z0-9-]/g, '_')}/${reportDate}.pdf`;
  }

  async function ensureBucket() {
    if (!bucketPromise) {
      bucketPromise = (async () => {
        const { data, error } = await supabase.storage.getBucket(bucket);
        if (data && !error) return;
        const { error: createError } = await supabase.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: 10 * 1024 * 1024,
          allowedMimeTypes: ['application/json', 'application/pdf'],
        });
        if (createError && !/already exists|duplicate/i.test(String(createError.message || ''))) throw createError;
      })().catch((error) => {
        bucketPromise = undefined;
        throw error;
      });
    }
    return bucketPromise;
  }

  async function readJson(path, fallback) {
    await ensureBucket();
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) return structuredClone(fallback);
    try {
      return JSON.parse(await data.text());
    } catch {
      return structuredClone(fallback);
    }
  }

  async function writeJson(path, value) {
    await ensureBucket();
    const payload = Buffer.from(JSON.stringify(value, null, 2));
    const { error } = await supabase.storage.from(bucket).upload(path, payload, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: true,
    });
    if (error) throw error;
  }

  function emptyJournal(driver, reportDate) {
    return {
      version: 1,
      driverId: driver.id,
      driverName: driver.name || 'Driver',
      date: reportDate,
      firstActivityAt: null,
      lastActivityAt: null,
      firstLocationAt: null,
      lastLocationAt: null,
      lastLocation: null,
      distanceMeters: 0,
      locationSamples: 0,
      assignedStops: {},
      deliveries: [],
      exceptions: [],
    };
  }

  function touchJournal(journal, timestamp) {
    journal.firstActivityAt ||= timestamp;
    journal.lastActivityAt = timestamp;
  }

  function optionalNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function safeStop(stop = {}) {
    return {
      orderId: String(stop.orderId || stop.id || ''),
      orderNumber: String(stop.orderNumber || stop.orderId || stop.id || ''),
      customerName: String(stop.customerName || 'Customer'),
      address: String(stop.address || 'Address not recorded'),
      latitude: Number.isFinite(Number(stop.latitude)) ? Number(stop.latitude) : null,
      longitude: Number.isFinite(Number(stop.longitude)) ? Number(stop.longitude) : null,
      routeSequence: Number.isFinite(Number(stop.routeSequence)) ? Number(stop.routeSequence) : null,
      deliveryInstructions: String(stop.deliveryInstructions || ''),
      deliverySlot: String(stop.deliverySlot || ''),
      source: String(stop.source || 'operations'),
    };
  }

  async function recordAssignments(driver, stops, recordedAt = new Date().toISOString()) {
    const reportDate = dateKey(new Date(recordedAt));
    return withLock(journalPath(driver.id, reportDate), async () => {
      const path = journalPath(driver.id, reportDate);
      const journal = await readJson(path, emptyJournal(driver, reportDate));
      journal.driverName = driver.name || journal.driverName;
      for (const rawStop of stops || []) {
        const stop = safeStop(rawStop);
        if (!stop.orderId) continue;
        journal.assignedStops[stop.orderId] = {
          ...(journal.assignedStops[stop.orderId] || {}),
          ...stop,
          assignedAt: journal.assignedStops[stop.orderId]?.assignedAt || recordedAt,
        };
      }
      touchJournal(journal, recordedAt);
      await writeJson(path, journal);
      return journal;
    });
  }

  function distanceMeters(a, b) {
    const radius = 6371000;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const deltaLat = (b.lat - a.lat) * Math.PI / 180;
    const deltaLng = (b.lng - a.lng) * Math.PI / 180;
    const value = Math.sin(deltaLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  async function recordLocation(driver, location) {
    const timestamp = location.recorded_at || new Date().toISOString();
    const reportDate = dateKey(new Date(timestamp));
    return withLock(journalPath(driver.id, reportDate), async () => {
      const path = journalPath(driver.id, reportDate);
      const journal = await readJson(path, emptyJournal(driver, reportDate));
      const point = { lat: Number(location.lat), lng: Number(location.lng), recordedAt: timestamp };
      if (journal.lastLocation) {
        const elapsedSeconds = Math.max(1, (new Date(timestamp).getTime() - new Date(journal.lastLocation.recordedAt).getTime()) / 1000);
        const segment = distanceMeters(journal.lastLocation, point);
        const plausibleLimit = Math.max(250, elapsedSeconds * 60);
        if (segment <= plausibleLimit) journal.distanceMeters = Number(journal.distanceMeters || 0) + segment;
      }
      journal.firstLocationAt ||= timestamp;
      journal.lastLocationAt = timestamp;
      journal.lastLocation = point;
      journal.locationSamples = Number(journal.locationSamples || 0) + 1;
      journal.driverName = driver.name || journal.driverName;
      touchJournal(journal, timestamp);
      await writeJson(path, journal);
      return journal;
    });
  }

  async function recordCompletion(driver, stop, completion = {}) {
    const completedAt = completion.completedAt || new Date().toISOString();
    const reportDate = dateKey(new Date(completedAt));
    return withLock(journalPath(driver.id, reportDate), async () => {
      const path = journalPath(driver.id, reportDate);
      const journal = await readJson(path, emptyJournal(driver, reportDate));
      const snapshot = safeStop(stop);
      const assigned = journal.assignedStops[snapshot.orderId] || {};
      if (assigned.customerName && snapshot.customerName === 'Customer') snapshot.customerName = assigned.customerName;
      if (assigned.address && snapshot.address === 'Address not recorded') snapshot.address = assigned.address;
      if (assigned.orderNumber && snapshot.orderNumber === snapshot.orderId) snapshot.orderNumber = assigned.orderNumber;
      if (snapshot.routeSequence == null && assigned.routeSequence != null) snapshot.routeSequence = assigned.routeSequence;
      const delivery = {
        ...assigned,
        ...snapshot,
        completedAt,
        status: String(completion.status || 'DELIVERED').toUpperCase(),
        note: String(completion.note || snapshot.deliveryInstructions || ''),
        emptyBottlesReturned: Number(completion.emptyBottlesReturned || 0),
        cashCollected: Number(completion.cashCollected || 0),
        paymentMethod: completion.paymentMethod || null,
        cardAmount: Number(completion.cardAmount || 0),
        cardReference: completion.cardReference || null,
        amountDue: optionalNumber(completion.amountDue),
        itemsQuantity: optionalNumber(completion.itemsQuantity),
        invoiceNumber: completion.invoiceNumber || null,
        ...(completion.requestKey ? { requestKey: completion.requestKey } : {}),
      };
      if (!upsertJournalDelivery(journal, delivery)) return journal;
      journal.assignedStops[snapshot.orderId] = { ...assigned, ...snapshot };
      journal.driverName = driver.name || journal.driverName;
      touchJournal(journal, completedAt);
      await writeJson(path, journal);
      return journal;
    });
  }

  // Failed delivery attempts are day exceptions; the order status itself never changes.
  async function recordFailure(driver, stop, failure = {}) {
    const attemptedAt = failure.attemptedAt || new Date().toISOString();
    const reportDate = dateKey(new Date(attemptedAt));
    return withLock(journalPath(driver.id, reportDate), async () => {
      const path = journalPath(driver.id, reportDate);
      const journal = await readJson(path, emptyJournal(driver, reportDate));
      const snapshot = safeStop(stop);
      const assigned = journal.assignedStops[snapshot.orderId] || {};
      if (assigned.customerName && snapshot.customerName === 'Customer') snapshot.customerName = assigned.customerName;
      if (assigned.address && snapshot.address === 'Address not recorded') snapshot.address = assigned.address;
      if (assigned.orderNumber && snapshot.orderNumber === snapshot.orderId) snapshot.orderNumber = assigned.orderNumber;
      const reasonLabel = String(failure.reasonLabel || failure.reasonCode || 'Failed');
      const failureNote = String(failure.note || '');
      const exception = {
        orderId: snapshot.orderId,
        orderNumber: snapshot.orderNumber,
        customerName: snapshot.customerName,
        address: snapshot.address,
        status: 'FAILED',
        reasonCode: String(failure.reasonCode || 'OTHER'),
        reasonLabel,
        failureNote,
        note: `${snapshot.orderNumber} - ${snapshot.customerName} - failed: ${reasonLabel}${failureNote ? ` (${failureNote})` : ''}`,
        attemptedAt,
        ...(failure.requestKey ? { requestKey: failure.requestKey } : {}),
      };
      if (!upsertJournalFailure(journal, exception)) return journal;
      journal.driverName = driver.name || journal.driverName;
      touchJournal(journal, attemptedAt);
      await writeJson(path, journal);
      return journal;
    });
  }

  async function readJournal(driver, reportDate = dateKey()) {
    return readJson(journalPath(driver.id, reportDate), emptyJournal(driver, reportDate));
  }

  function formatAed(value) {
    return `AED ${Number(value || 0).toFixed(2)}`;
  }

  function paymentLabel(delivery) {
    const method = String(delivery.paymentMethod || '').toLowerCase();
    if (method === 'card') return `Card ${formatAed(delivery.cardAmount)}`;
    if (method === 'prepaid') return 'Prepaid';
    if (method === 'cash' || Number(delivery.cashCollected || 0) > 0) return `Cash ${formatAed(delivery.cashCollected)}`;
    return 'Prepaid';
  }

  function formatTime(value) {
    if (!value) return 'Not recorded';
    return new Intl.DateTimeFormat('en-AE', { timeZone: UAE_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Not recorded';
    const totalMinutes = Math.round(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  function drawReport(journal, generatedAt, summary = computeDaySummary({ journal })) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: {
        Title: `Driver End-of-Day Report - ${journal.driverName} - ${journal.date}`,
        Author: 'Delivery Operations',
        Subject: 'Driver end-of-day delivery summary',
      } });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const violet = '#6656D9';
      const ink = '#171A24';
      const slate = '#6F7684';
      const line = '#E4E6EA';
      const green = '#158765';
      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - 84;

      const newPageIfNeeded = (height) => {
        if (doc.y + height > doc.page.height - 60) doc.addPage();
      };
      const label = (text, x, y) => doc.font('Helvetica-Bold').fontSize(7).fillColor(slate).text(text, x, y, { characterSpacing: 0.6 });

      doc.save().roundedRect(0, 0, pageWidth, 112, 0).fill(violet).restore();
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').text('DELIVERY OPERATIONS', 42, 30);
      doc.font('Helvetica-Bold').fontSize(24).text('End-of-Day Delivery Report', 42, 51);
      doc.font('Helvetica').fontSize(9).fillColor('#E7E3FF').text('Driver Operations', 42, 84);
      doc.y = 136;

      const startedAt = journal.firstLocationAt || journal.firstActivityAt;
      const endedAt = journal.lastLocationAt || journal.lastActivityAt;
      const duration = startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : NaN;
      const metrics = [
        ['COMPLETED', String(journal.deliveries.length)],
        ['EXCEPTIONS', String(journal.exceptions.length)],
        ['GPS DISTANCE', journal.locationSamples > 1 ? `${(Number(journal.distanceMeters || 0) / 1000).toFixed(1)} km` : 'Not recorded'],
        ['ACTIVE TIME', formatDuration(duration)],
      ];
      const metricWidth = (contentWidth - 24) / 4;
      metrics.forEach(([name, value], index) => {
        const x = 42 + index * (metricWidth + 8);
        doc.roundedRect(x, 136, metricWidth, 55, 7).fillAndStroke('#F6F5FC', '#E6E2F8');
        label(name, x + 10, 148);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(value, x + 10, 164, { width: metricWidth - 20 });
      });
      doc.y = 214;

      const metadataY = doc.y;
      label('DRIVER', 42, metadataY);
      label('DRIVER ID', 226, metadataY);
      label('REPORT DATE', 410, metadataY);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(journal.driverName, 42, metadataY + 13, { width: 170 });
      doc.font('Helvetica').fontSize(8).fillColor(ink).text(journal.driverId, 226, metadataY + 13, { width: 170 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(journal.date, 410, metadataY + 13, { width: 120 });
      doc.x = 42;
      doc.y = metadataY + 48;
      doc.moveTo(42, doc.y).lineTo(pageWidth - 42, doc.y).strokeColor(line).stroke();
      doc.y += 18;

      doc.font('Helvetica-Bold').fontSize(15).fillColor(ink).text('Completed deliveries');
      doc.moveDown(0.55);
      if (!journal.deliveries.length) {
        doc.font('Helvetica').fontSize(10).fillColor(slate).text('No completed deliveries were recorded for this date.');
      }
      journal.deliveries
        .slice()
        .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime())
        .forEach((delivery, index) => {
          const addressHeight = doc.heightOfString(delivery.address || 'Address not recorded', { width: 330, fontSize: 9 });
          const noteHeight = delivery.note ? doc.heightOfString(delivery.note, { width: 455, fontSize: 8 }) + 17 : 0;
          const blockHeight = Math.max(72, 72 + addressHeight + noteHeight);
          newPageIfNeeded(blockHeight + 12);
          const y = doc.y;
          doc.roundedRect(42, y, contentWidth, blockHeight, 7).fillAndStroke('#FFFFFF', line);
          doc.circle(60, y + 21, 10).fill(violet);
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(String(index + 1), 54, y + 17, { width: 12, align: 'center' });
          doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(delivery.orderNumber || delivery.orderId, 78, y + 13, { width: 235 });
          doc.font('Helvetica-Bold').fontSize(9).fillColor(green).text(formatTime(delivery.completedAt), pageWidth - 135, y + 13, { width: 75, align: 'right' });
          doc.font('Helvetica').fontSize(9).fillColor(slate).text(delivery.customerName || 'Customer', 78, y + 29, { width: 235 });
          doc.font('Helvetica').fontSize(9).fillColor(ink).text(delivery.address || 'Address not recorded', 78, y + 45, { width: 420 });
          const paymentLine = [
            paymentLabel(delivery),
            `Empties returned ${Number(delivery.emptyBottlesReturned || 0)}`,
            delivery.invoiceNumber ? `Invoice ${delivery.invoiceNumber}` : null,
          ].filter(Boolean).join('  |  ');
          doc.font('Helvetica').fontSize(8).fillColor(slate).text(paymentLine, 78, y + 49 + addressHeight, { width: 420 });
          if (delivery.note) {
            const noteY = y + 65 + addressHeight;
            doc.font('Helvetica-Bold').fontSize(7).fillColor(violet).text('NOTES / EXCEPTIONS', 78, noteY);
            doc.font('Helvetica').fontSize(8).fillColor(slate).text(delivery.note, 78, noteY + 11, { width: 455 });
          }
          doc.y = y + blockHeight + 10;
        });

      newPageIfNeeded(170);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(ink).text('Cash & bottles', 42);
      doc.moveDown(0.5);
      const cashMetrics = [
        ['CASH EXPECTED', formatAed(summary.cashExpected)],
        ['CASH COLLECTED', formatAed(summary.cashCollected)],
        ['DIFFERENCE', `${summary.cashDifference > 0 ? '+' : ''}${summary.cashDifference.toFixed(2)}`],
        ['CARD', `${formatAed(summary.cardTotal)} (${summary.cardCount})`],
        ['PREPAID STOPS', String(summary.prepaidCount)],
        ['BOTTLES DELIVERED', String(summary.bottlesDelivered)],
        ['EMPTIES RETURNED', String(summary.emptiesReturned)],
        ['INVOICES ISSUED', String(summary.invoicesIssued)],
      ];
      const cashY = doc.y;
      cashMetrics.forEach(([name, value], index) => {
        const x = 42 + (index % 4) * (metricWidth + 8);
        const boxY = cashY + Math.floor(index / 4) * 63;
        const mismatch = name === 'DIFFERENCE' && Math.abs(summary.cashDifference) >= 0.01;
        doc.roundedRect(x, boxY, metricWidth, 55, 7).fillAndStroke(mismatch ? '#FFF4F2' : '#F6F5FC', mismatch ? '#F5D3CC' : '#E6E2F8');
        label(name, x + 10, boxY + 12);
        doc.font('Helvetica-Bold').fontSize(12).fillColor(mismatch ? '#B4412E' : ink).text(value, x + 10, boxY + 28, { width: metricWidth - 20 });
      });
      doc.x = 42;
      doc.y = cashY + 126;
      if (summary.stopsWithUnknownDue) {
        doc.font('Helvetica').fontSize(8).fillColor(slate)
          .text(`${summary.stopsWithUnknownDue} cash stop(s) had no recorded amount due and are not included in cash expected.`, 42, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
      }

      newPageIfNeeded(105);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(ink).text('Day notes and exceptions', 42);
      doc.moveDown(0.5);
      if (journal.exceptions.length) {
        journal.exceptions.forEach((exception) => {
          if (exception.status === 'FAILED') {
            newPageIfNeeded(30);
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#B4412E')
              .text(`- FAILED ${formatTime(exception.attemptedAt)}: ${exception.orderNumber || exception.orderId} - ${exception.customerName || 'Customer'} - ${exception.reasonLabel || exception.reasonCode}`, 42, doc.y, { width: contentWidth });
            if (exception.failureNote) doc.font('Helvetica').fontSize(8).fillColor(slate).text(`  ${exception.failureNote}`, 42, doc.y, { width: contentWidth });
            return;
          }
          doc.font('Helvetica').fontSize(9).fillColor(ink).text(`- ${exception.note || exception.status || 'Exception recorded'}`, 42, doc.y, { width: contentWidth });
        });
      } else {
        doc.roundedRect(42, doc.y, contentWidth, 43, 7).fillAndStroke('#EFF9F5', '#D5EFE5');
        doc.font('Helvetica-Bold').fontSize(9).fillColor(green).text('No failed deliveries, delays, or exceptions were recorded.', 55, doc.y + 15);
        doc.y += 55;
      }

      const range = doc.bufferedPageRange();
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        doc.font('Helvetica').fontSize(7).fillColor('#8A909B')
          .text(`Generated ${formatTime(generatedAt)} UAE time | Dispatch Console`, 42, doc.page.height - 60, { width: 380, lineBreak: false });
        doc.text(`Page ${index + 1} of ${range.count}`, pageWidth - 130, doc.page.height - 60, { width: 88, align: 'right', lineBreak: false });
      }
      doc.end();
    });
  }

  async function readIndex() {
    const value = await readJson(INDEX_PATH, { version: 1, reports: [] });
    return Array.isArray(value.reports) ? value : { version: 1, reports: [] };
  }

  function signatureFor(id, expires) {
    return crypto.createHmac('sha256', signingSecret).update(`${id}:${expires}`).digest('base64url');
  }

  function signedDownloadUrl(id, lifetimeSeconds = 3600) {
    const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    const signature = signatureFor(id, expires);
    return `${apiBaseUrl}/api/driver/reports/${encodeURIComponent(id)}/download?expires=${expires}&signature=${encodeURIComponent(signature)}`;
  }

  function verifyDownload(id, expires, signature) {
    const safeExpires = Number(expires);
    if (!Number.isInteger(safeExpires) || safeExpires < Math.floor(Date.now() / 1000) || !signature) return false;
    const expected = signatureFor(id, safeExpires);
    const provided = String(signature);
    return expected.length === provided.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  function publicMetadata(metadata) {
    return { ...metadata, objectPath: undefined, downloadUrl: signedDownloadUrl(metadata.id) };
  }

  async function generateReport(driver, requestedDate) {
    const reportDate = requestedDate || dateKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('Invalid report date');
    const lockKey = `report:${driver.id}:${reportDate}`;
    return withLock(lockKey, async () => {
      const journal = await readJson(journalPath(driver.id, reportDate), emptyJournal(driver, reportDate));
      const failedOrderIds = new Set((journal.exceptions || [])
        .filter((exception) => exception.status === 'FAILED')
        .map((exception) => exception.orderId));
      if (!journal.deliveries.length && !failedOrderIds.size) {
        const error = new Error('Complete at least one delivery before generating the end-of-day report');
        error.statusCode = 409;
        error.isValidationError = true;
        throw error;
      }
      const generatedAt = new Date().toISOString();
      const completedOrderIds = new Set(journal.deliveries.map((delivery) => delivery.orderId));
      const unfinishedStops = Object.values(journal.assignedStops || {})
        .filter((stop) => stop.orderId && !completedOrderIds.has(stop.orderId) && !failedOrderIds.has(stop.orderId))
        .map((stop) => ({
          orderId: stop.orderId,
          status: 'NOT COMPLETED',
          note: `${stop.orderNumber || stop.orderId} - ${stop.address || 'address not recorded'} was still open when the day was closed.`,
        }));
      const reportJournal = { ...journal, exceptions: [...(journal.exceptions || []), ...unfinishedStops] };
      const summary = computeDaySummary({ journal });
      const pdf = await drawReport(reportJournal, generatedAt, summary);
      const objectPath = pdfPath(driver.id, reportDate);
      const { error } = await supabase.storage.from(bucket).upload(objectPath, pdf, {
        contentType: 'application/pdf',
        cacheControl: '0',
        upsert: true,
      });
      if (error) throw error;

      const metadata = {
        id: reportId(driver.id, reportDate),
        driverId: driver.id,
        driverName: driver.name || journal.driverName,
        date: reportDate,
        generatedAt,
        completedDeliveries: journal.deliveries.length,
        exceptions: reportJournal.exceptions.length,
        failedDeliveries: summary.failedDeliveries,
        cashExpected: summary.cashExpected,
        cashCollected: summary.cashCollected,
        cardTotal: summary.cardTotal,
        emptiesReturned: summary.emptiesReturned,
        distanceKm: journal.locationSamples > 1 ? Number((Number(journal.distanceMeters || 0) / 1000).toFixed(1)) : null,
        activeMinutes: (journal.firstLocationAt || journal.firstActivityAt) && (journal.lastLocationAt || journal.lastActivityAt)
          ? Math.max(0, Math.round((new Date(journal.lastLocationAt || journal.lastActivityAt).getTime() - new Date(journal.firstLocationAt || journal.firstActivityAt).getTime()) / 60000))
          : null,
        objectPath,
      };
      await withLock(INDEX_PATH, async () => {
        const index = await readIndex();
        index.reports = [metadata, ...index.reports.filter((item) => item.id !== metadata.id)]
          .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.generatedAt).localeCompare(String(a.generatedAt)))
          .slice(0, 2500);
        await writeJson(INDEX_PATH, index);
      });
      return publicMetadata(metadata);
    });
  }

  async function listReports(driverId) {
    const index = await readIndex();
    return index.reports.filter((report) => !driverId || report.driverId === driverId).map(publicMetadata);
  }

  async function downloadReport(id) {
    const index = await readIndex();
    const metadata = index.reports.find((report) => report.id === id);
    if (!metadata) return null;
    const { data, error } = await supabase.storage.from(bucket).download(metadata.objectPath);
    if (error || !data) return null;
    return { metadata, bytes: Buffer.from(await data.arrayBuffer()) };
  }

  return {
    dateKey,
    recordAssignments,
    recordLocation,
    recordCompletion,
    recordFailure,
    readJournal,
    generateReport,
    listReports,
    downloadReport,
    verifyDownload,
  };
}

module.exports = { createDriverReportService, upsertJournalDelivery, upsertJournalFailure };
