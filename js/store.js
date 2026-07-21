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

  /** Derive groups from index entries */
  async loadGroups() {
    const routes = await this.loadIndex();
    const seen   = new Map(); // groupId → {id, name, routes[]}
    for (const r of routes) {
      if (!r.group) continue;
      const key = r.type + '/' + r.group;
      if (!seen.has(key)) {
        seen.set(key, { id: key, name: r.groupName || r.group, type: r.type, routes: [] });
      }
      seen.get(key).routes.push(r.id);
    }
    return [...seen.values()];
  },

  async loadGPX(id) {
    // id is now type/group/filename or type/filename
    const res = await fetch(`data/gpx/${id}.gpx`);
    if (!res.ok) throw new Error(`GPX file not found: data/gpx/${id}.gpx`);
    return res.text();
  },
};
