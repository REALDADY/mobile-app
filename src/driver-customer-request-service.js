const crypto = require('crypto');

const DEFAULT_BUCKET = 'driver-customer-requests';
const INDEX_PATH = 'customer-requests.json';

function createDriverCustomerRequestService({ supabase, bucket = DEFAULT_BUCKET }) {
  let bucketPromise;
  let writeQueue = Promise.resolve();

  async function ensureBucket() {
    if (!bucketPromise) {
      bucketPromise = (async () => {
        const { data, error } = await supabase.storage.getBucket(bucket);
        if (data && !error) return;
        const { error: createError } = await supabase.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: 2 * 1024 * 1024,
          allowedMimeTypes: ['application/json'],
        });
        if (createError && !/already exists|duplicate/i.test(String(createError.message || ''))) throw createError;
      })().catch((error) => {
        bucketPromise = undefined;
        throw error;
      });
    }
    return bucketPromise;
  }

  async function readIndex() {
    await ensureBucket();
    const { data, error } = await supabase.storage.from(bucket).download(INDEX_PATH);
    if (error || !data) return { version: 1, requests: [] };
    try {
      const parsed = JSON.parse(await data.text());
      return Array.isArray(parsed.requests) ? parsed : { version: 1, requests: [] };
    } catch {
      return { version: 1, requests: [] };
    }
  }

  async function writeIndex(index) {
    const payload = Buffer.from(JSON.stringify(index, null, 2));
    const { error } = await supabase.storage.from(bucket).upload(INDEX_PATH, payload, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: true,
    });
    if (error) throw error;
  }

  function mutate(operation) {
    const current = writeQueue.catch(() => undefined).then(async () => {
      const index = await readIndex();
      const result = await operation(index);
      await writeIndex(index);
      return result;
    });
    writeQueue = current;
    return current;
  }

  async function submit(input) {
    return mutate(async (index) => {
      if (index.requests.some((request) => request.phone === input.phone && request.status === 'PENDING_APPROVAL')) {
        const error = new Error('A customer request with this phone number is already pending approval');
        error.statusCode = 409;
        error.isValidationError = true;
        throw error;
      }
      const now = new Date().toISOString();
      const request = {
        id: `CCR-${crypto.randomUUID()}`,
        driverId: input.driverId,
        driverName: input.driverName,
        customerName: input.customerName,
        phone: input.phone,
        email: input.email || '',
        notes: input.notes || '',
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy,
        address: input.address,
        capturedAddress: input.capturedAddress || input.address,
        city: input.city || '',
        status: 'PENDING_APPROVAL',
        submittedAt: now,
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: '',
        customerId: null,
      };
      index.requests.unshift(request);
      index.requests = index.requests.slice(0, 5000);
      return request;
    });
  }

  async function list({ driverId, status } = {}) {
    const index = await readIndex();
    return index.requests
      .filter((request) => !driverId || request.driverId === driverId)
      .filter((request) => !status || request.status === status)
      .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  }

  async function decide({ id, approved, reason, reviewedBy, activate }) {
    return mutate(async (index) => {
      const request = index.requests.find((candidate) => candidate.id === id);
      if (!request) {
        const error = new Error('Customer request not found');
        error.statusCode = 404;
        error.isValidationError = true;
        throw error;
      }
      if (request.status !== 'PENDING_APPROVAL') {
        const error = new Error(`This customer request is already ${String(request.status).toLowerCase().replaceAll('_', ' ')}`);
        error.statusCode = 409;
        error.isValidationError = true;
        throw error;
      }

      const customer = approved ? await activate(request) : null;
      request.status = approved ? 'APPROVED' : 'REJECTED';
      request.reviewedAt = new Date().toISOString();
      request.reviewedBy = reviewedBy || 'Dispatcher';
      request.rejectionReason = approved ? '' : reason;
      request.customerId = customer?.id || null;
      return request;
    });
  }

  return { submit, list, decide };
}

module.exports = { createDriverCustomerRequestService };
