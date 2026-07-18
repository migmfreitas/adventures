/**
 * Store — file-based (GitHub Pages)
 *
 * Routes live in data/index.json (array of route metadata + simplified path).
 * Full GPX point data is fetched on demand from data/gpx/<id>.gpx.
 *
 * Adding a route: the app generates two files for the user to commit:
 *   - data/gpx/<id>.gpx       (the original GPX, unchanged)
 *   - data/index.json         (updated manifest with new entry prepended)
 */

const Store = {

  _cache: null,   // in-memory cache of index.json after first fetch

  /** Load all route summaries from data/index.json */
  async loadIndex() {
    if (this._cache) return this._cache;
    try {
      const res = await fetch('data/index.json?_=' + Date.now());
      if (!res.ok) throw new Error('index.json not found');
      this._cache = await res.json();
      return this._cache;
    } catch (e) {
      console.warn('Store.loadIndex:', e.message);
      return [];
    }
  },

  /** Fetch the full GPX text for a route by id */
  async loadGPX(id) {
    const res = await fetch(`data/gpx/${id}.gpx`);
    if (!res.ok) throw new Error(`GPX file not found: data/gpx/${id}.gpx`);
    return res.text();
  },

  /**
   * Prepare the two files the user needs to commit when adding a route.
   * Returns { id, indexJson, gpxText, gpxFilename, indexFilename }
   */
  async prepareCommitFiles({ name, type, gpxText, metrics, simplifiedPath }) {
    const id = this._slug(name) + '-' + Date.now().toString(36);
    const existing = await this.loadIndex();

    const entry = {
      id,
      name,
      type,
      addedAt: new Date().toISOString(),
      metrics: {
        distanceKm:  metrics.distanceKm,
        elevGain:    metrics.elevGain,
        elevLoss:    metrics.elevLoss,
        minEle:      metrics.minEle,
        maxEle:      metrics.maxEle,
        movingTime:  metrics.movingTime,
        totalTime:   metrics.totalTime,
        avgHr:       metrics.avgHr,
        pointCount:  metrics.pointCount,
        startTime:   metrics.startTime,
        bounds:      metrics.bounds,
        elevProfile: metrics.elevProfile,
        simplifiedPath,
      },
    };

    const updated = [entry, ...existing];
    // Invalidate cache so the UI reflects the new entry after commit
    this._cache = null;

    return {
      id,
      entry,
      gpxText,
      gpxFilename:   `data/gpx/${id}.gpx`,
      indexFilename: 'data/index.json',
      indexJson:     JSON.stringify(updated, null, 2),
    };
  },

  _slug(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'route';
  },
};
