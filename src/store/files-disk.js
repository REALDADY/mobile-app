// File store on the VPS disk. Logical buckets (delivery-proofs, delivery-invoices,
// driver-day-reports, driver-customer-requests) are top-level folders under rootDir, so the
// { bucket, path } references stored in the database and sent to the website stay identical
// to the Supabase Storage ones. Files are never served statically: only through HMAC-signed
// download URLs (see signedUrl / verifySignedUrl and the existing report / invoice links).
const crypto = require('crypto');
const fs = require('fs/promises');
const nodePath = require('path');

const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,200}$/;
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};
const DEFAULT_SIGNED_URL_SECONDS = 24 * 60 * 60;

function invalidPath(message) {
  const error = new Error(message);
  error.code = 'INVALID_FILE_PATH';
  return error;
}

function contentTypeFor(objectPath) {
  return CONTENT_TYPES[nodePath.extname(String(objectPath || '')).toLowerCase()] || 'application/octet-stream';
}

// Throws for anything that is not a plain relative path of safe segments: '..', '.', empty
// segments, absolute paths, backslashes, NUL bytes and characters outside [A-Za-z0-9._-].
function assertSafeObjectPath(objectPath) {
  const value = String(objectPath ?? '');
  if (!value || value.length > 1024) throw invalidPath('File path is empty or too long');
  if (value.includes('\0')) throw invalidPath('File path contains a NUL byte');
  if (value.includes('\\')) throw invalidPath('File path contains a backslash');
  if (value.startsWith('/') || nodePath.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw invalidPath('File path must be relative');
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') throw invalidPath('File path must not contain . or .. segments');
    if (!SEGMENT_RE.test(segment)) throw invalidPath('File path contains an invalid segment');
  }
  return segments;
}

function assertSafeBucket(bucket) {
  const value = String(bucket ?? '');
  if (!BUCKET_RE.test(value) || value === '.' || value === '..') throw invalidPath('Invalid bucket name');
  return value;
}

function createDiskFileStore({ rootDir, signingSecret = '', apiBaseUrl = '' }) {
  if (!rootDir) throw new Error('createDiskFileStore requires rootDir');
  const root = nodePath.resolve(rootDir);
  const baseUrl = String(apiBaseUrl || '').replace(/\/$/, '');

  function resolveFile(bucket, objectPath) {
    const safeBucket = assertSafeBucket(bucket);
    const segments = assertSafeObjectPath(objectPath);
    const fullPath = nodePath.resolve(root, safeBucket, ...segments);
    // Defence in depth on top of the segment checks.
    if (!fullPath.startsWith(root + nodePath.sep)) throw invalidPath('File path escapes the file store');
    return fullPath;
  }

  async function ensureBucket(bucket) {
    await fs.mkdir(nodePath.join(root, assertSafeBucket(bucket)), { recursive: true });
  }

  // Atomic: the bytes go to a temp file in the same directory, then rename (overwrite) or
  // link (upsert: false, fails when the file exists) puts them in place in one step.
  async function upload(bucket, objectPath, bytes, { upsert = false } = {}) {
    const target = resolveFile(bucket, objectPath);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    const temp = nodePath.join(nodePath.dirname(target), `.${nodePath.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const handle = await fs.open(temp, 'wx', 0o640);
    try {
      await handle.writeFile(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (upsert) {
        await fs.rename(temp, target);
      } else {
        try {
          await fs.link(temp, target);
        } catch (error) {
          if (error.code === 'EEXIST') {
            const exists = new Error('The resource already exists');
            exists.code = 'EEXIST';
            exists.statusCode = 409;
            throw exists;
          }
          throw error;
        }
        await fs.unlink(temp).catch(() => {});
      }
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    return { bucket, path: objectPath, contentType: contentTypeFor(objectPath) };
  }

  // Buffer, or null when the file does not exist (or the path is invalid).
  async function download(bucket, objectPath) {
    let target;
    try {
      target = resolveFile(bucket, objectPath);
    } catch {
      return null;
    }
    try {
      return await fs.readFile(target);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }

  async function exists(bucket, objectPath) {
    try {
      const stat = await fs.stat(resolveFile(bucket, objectPath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  // Never throws (like supabase.storage remove): resolves to { error } for the caller to ignore.
  async function remove(bucket, objectPaths) {
    let firstError = null;
    for (const objectPath of objectPaths || []) {
      try {
        await fs.unlink(resolveFile(bucket, objectPath));
      } catch (error) {
        if (error.code !== 'ENOENT' && !firstError) firstError = error;
      }
    }
    return { error: firstError };
  }

  function signatureFor(bucket, objectPath, expires) {
    return crypto.createHmac('sha256', signingSecret).update(`file:${bucket}/${objectPath}:${expires}`).digest('base64url');
  }

  function signedUrl(bucket, objectPath, lifetimeSeconds = DEFAULT_SIGNED_URL_SECONDS, now = Date.now()) {
    if (!signingSecret) return null;
    assertSafeBucket(bucket);
    assertSafeObjectPath(objectPath);
    const expires = Math.floor(now / 1000) + lifetimeSeconds;
    const query = new URLSearchParams({ path: objectPath, expires: String(expires), signature: signatureFor(bucket, objectPath, expires) });
    return `${baseUrl}/api/files/${encodeURIComponent(bucket)}/download?${query.toString()}`;
  }

  function verifySignedUrl(bucket, objectPath, expires, signature, now = Date.now()) {
    if (!signingSecret || !signature) return false;
    try {
      assertSafeBucket(bucket);
      assertSafeObjectPath(objectPath);
    } catch {
      return false;
    }
    const safeExpires = Number(expires);
    if (!Number.isInteger(safeExpires) || safeExpires < Math.floor(now / 1000)) return false;
    const expected = Buffer.from(signatureFor(bucket, objectPath, safeExpires));
    const provided = Buffer.from(String(signature));
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  }

  return {
    kind: 'disk',
    rootDir: root,
    ensureBucket,
    upload,
    download,
    exists,
    remove,
    contentType: contentTypeFor,
    signedUrl,
    verifySignedUrl,
  };
}

module.exports = { assertSafeObjectPath, contentTypeFor, createDiskFileStore };
