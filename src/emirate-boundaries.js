// Emirate boundary polygons for automatic routing. Without EMIRATE_BOUNDARIES_URL the bundled
// data-static/uae-emirates.geojson.json (the same file the dispatch console serves at /api/emirates)
// is used; with it, the URL is fetched and the bundled file is the fallback when that fails.
const fs = require('fs/promises');
const path = require('path');

const EMIRATE_ORDER = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
const BUNDLED_EMIRATES_FILE = path.join(__dirname, '..', 'data-static', 'uae-emirates.geojson.json');
const FETCH_TIMEOUT_MS = 10_000;

// FeatureCollection -> Map(Emirate_En -> geometry). Throws unless every emirate is present with a
// Polygon / MultiPolygon geometry.
function parseEmirateBoundaries(payload, emirates = EMIRATE_ORDER) {
  const boundaries = new Map((payload?.features || []).map((feature) => [feature?.properties?.Emirate_En, feature?.geometry]));
  const invalid = emirates.filter((emirate) => {
    const geometry = boundaries.get(emirate);
    return !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length;
  });
  if (invalid.length) throw new Error(`Emirate boundary feed is incomplete (${invalid.join(', ')})`);
  return boundaries;
}

function createEmirateBoundaryLoader({
  url = '',
  fetchImpl = fetch,
  bundledFile = BUNDLED_EMIRATES_FILE,
  emirates = EMIRATE_ORDER,
  timeoutMs = FETCH_TIMEOUT_MS,
  logger = console,
} = {}) {
  let cached;

  async function loadBundled() {
    return parseEmirateBoundaries(JSON.parse(await fs.readFile(bundledFile, 'utf8')), emirates);
  }

  async function loadRemote() {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Emirate boundary feed returned ${response.status}`);
    return parseEmirateBoundaries(await response.json(), emirates);
  }

  // Cached for the process lifetime once loaded (the bundled file is identical to the feed).
  return async function getEmirateBoundaries() {
    if (cached) return cached;
    if (url) {
      try {
        cached = await loadRemote();
        return cached;
      } catch (error) {
        logger.warn(`Emirate boundaries from ${url} unavailable (${error?.message || error}); using the bundled file.`);
      }
    }
    cached = await loadBundled();
    return cached;
  };
}

module.exports = { BUNDLED_EMIRATES_FILE, EMIRATE_ORDER, createEmirateBoundaryLoader, parseEmirateBoundaries };
