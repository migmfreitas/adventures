/**
 * Store — file-based (GitHub Pages)
 * Groups are derived from index.json (group/groupName fields per route).
 * No separate groups.json needed.
 */

const Store = {
  _cache: null,

  async loadIndex() {
    if (this._cache) return this._cache;
    try {
      const res = await fetch('data/index.json?_=' + Date.now());
      if (!res.ok) throw new Error('index.json not found');
      this._cache = await res.json();
      return this._cache;
    } catch(e) {
      console.warn('Store.loadIndex:', e.message);
      return [];
    }
  },

  /** Derive groups from index entries, preserving index.json order */
  async loadGroups() {
    const routes = await this.loadIndex();
    const seen   = new Map();
    for (const r of routes) {
      if (!r.group) continue;
      const key = r.type + '/' + r.group;
      if (!seen.has(key)) {
        seen.set(key, {
          id:          key,
          name:        r.groupName || r.group,
          description: r.description || '',
          type:        r.type,
          routes:      [],
        });
      }
      seen.get(key).routes.push(r.id);
    }
    // Map preserves insertion order, which matches index.json order
    return [...seen.values()];
  },

  async loadGPX(id) {
    const index = await this.loadIndex();
    const route = index.find(r => r.id === id);
    // Use stored gpxPath if available (preserves original filename with spaces/caps)
    // otherwise fall back to constructing from id
    const path = route?.gpxPath || `data/gpx/${id}.gpx`;
    const res = await fetch(path);
    if (!res.ok) throw new Error(`GPX file not found: ${path}`);
    return res.text();
  },
};
