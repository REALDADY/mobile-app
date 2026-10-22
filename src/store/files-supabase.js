// File store on Supabase Storage (the original behaviour), with the same interface as
// ./files-disk.js. Buckets are created on first use with the options the caller passes.
function createSupabaseFileStore(supabase) {
  const bucketPromises = new Map();

  function ensureBucket(bucket, options = {}) {
    if (!bucketPromises.has(bucket)) {
      const promise = (async () => {
        const { data, error } = await supabase.storage.getBucket(bucket);
        if (data && !error) return;
        const { error: createError } = await supabase.storage.createBucket(bucket, { public: false, ...options });
        if (createError && !/already exists|duplicate/i.test(String(createError.message || ''))) throw createError;
      })().catch((error) => {
        bucketPromises.delete(bucket);
        throw error;
      });
      bucketPromises.set(bucket, promise);
    }
    return bucketPromises.get(bucket);
  }

  async function upload(bucket, objectPath, bytes, options = {}) {
    const { error } = await supabase.storage.from(bucket).upload(objectPath, bytes, options);
    if (error) throw error;
    return { bucket, path: objectPath, contentType: options.contentType || null };
  }

  // Buffer, or null when the object is missing or the download failed (as callers treated it).
  async function download(bucket, objectPath) {
    const { data, error } = await supabase.storage.from(bucket).download(objectPath);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async function exists(bucket, objectPath) {
    const slash = objectPath.lastIndexOf('/');
    const folder = slash >= 0 ? objectPath.slice(0, slash) : '';
    const name = objectPath.slice(slash + 1);
    const { data, error } = await supabase.storage.from(bucket).list(folder, { search: name, limit: 100 });
    if (error) return false;
    return (data || []).some((entry) => entry.name === name);
  }

  // Never throws for storage errors: resolves to { error } like supabase-js.
  async function remove(bucket, objectPaths) {
    const { error } = await supabase.storage.from(bucket).remove(objectPaths);
    return { error: error || null };
  }

  return {
    kind: 'supabase',
    ensureBucket,
    upload,
    download,
    exists,
    remove,
    contentType: () => null,
    signedUrl: () => null,
    verifySignedUrl: () => false,
  };
}

module.exports = { createSupabaseFileStore };
