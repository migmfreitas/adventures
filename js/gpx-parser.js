/**
 * GPX Parser
 * Parses .gpx XML files and extracts all metrics
 */

const GPXParser = {

  parse(text, filename) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');

    // Try tracks first, then routes
    let points = this._extractTrackPoints(xml);
    if (points.length === 0) points = this._extractRoutePoints(xml);

    if (points.length === 0) throw new Error('No track or route points found in GPX file.');

    const name = this._extractName(xml) || filename.replace(/\.gpx$/i, '');
    const metrics = this._computeMetrics(points);

    return { name, points, metrics };
  },

  _extractTrackPoints(xml) {
    const pts = [];
    xml.querySelectorAll('trkpt').forEach(pt => {
      const p = this._parsePoint(pt);
      if (p) pts.push(p);
    });
    return pts;
  },

  _extractRoutePoints(xml) {
    const pts = [];
    xml.querySelectorAll('rtept').forEach(pt => {
      const p = this._parsePoint(pt);
      if (p) pts.push(p);
    });
    return pts;
  },

  _parsePoint(el) {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (isNaN(lat) || isNaN(lon)) return null;

    const eleEl = el.querySelector('ele');
    const timeEl = el.querySelector('time');
    const hrEl = el.querySelector('hr') || el.querySelector('heartrate');

    return {
      lat,
      lon,
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
      time: timeEl ? new Date(timeEl.textContent) : null,
      hr: hrEl ? parseInt(hrEl.textContent) : null,
    };
  },

  _extractName(xml) {
    const n = xml.querySelector('trk > name') || xml.querySelector('rte > name') || xml.querySelector('metadata > name');
    return n ? n.textContent.trim() : null;
  },

  _smoothedElevArray(points, windowSize = 10) {
    const elev = points.map(p => p.ele);
    return elev.map((e, i) => {
      if (e === null) return null;
      const half = Math.floor(windowSize / 2);
      const slice = elev
        .slice(Math.max(0, i - half), Math.min(elev.length, i + half + 1))
        .filter(v => v !== null);
      return slice.reduce((s, v) => s + v, 0) / slice.length;
    });
  },

  _computeMetrics(points) {
    let distanceM = 0;
    let elevGain = 0;
    let elevLoss = 0;
    let minEle = Infinity, maxEle = -Infinity;
    let movingMs = 0;
    let hrSum = 0, hrCount = 0;
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;

    const MAX_PROFILE = 500;
    const smoothedElev = this._smoothedElevArray(points);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      // Bounds
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;

      // Elevation (raw for min/max display)
      if (p.ele !== null) {
        if (p.ele < minEle) minEle = p.ele;
        if (p.ele > maxEle) maxEle = p.ele;
      }

      // HR
      if (p.hr !== null) { hrSum += p.hr; hrCount++; }

      if (i === 0) continue;

      const prev = points[i - 1];
      const d = this._haversine(prev.lat, prev.lon, p.lat, p.lon);
      distanceM += d;

      // Use smoothed elevation — sum ALL positive/negative changes
      const se  = smoothedElev[i];
      const sep = smoothedElev[i - 1];
      if (se !== null && sep !== null) {
        const dEle = se - sep;
        if (dEle > 0)  elevGain += dEle;
        else           elevLoss += Math.abs(dEle);
      }

      // Moving time (exclude stops: <0.5 km/h)
      if (p.time && prev.time) {
        const dt = (p.time - prev.time) / 1000; // seconds
        const speed = d / dt; // m/s
        if (speed > 0.14) movingMs += dt * 1000; // 0.14 m/s ≈ 0.5 km/h
      }
    }

    const distanceKm = distanceM / 1000;
    const totalMs = points[0]?.time && points[points.length - 1]?.time
      ? points[points.length - 1].time - points[0].time
      : null;

    // Elevation profile (downsampled)
    const step = Math.max(1, Math.floor(points.length / MAX_PROFILE));
    const elevProfile = points
      .filter((_, i) => i % step === 0 && points[i].ele !== null)
      .map((p, i) => ({ d: Math.round(i * step * distanceM / points.length), ele: Math.round(p.ele) }));

    // Simplified path for overview map (RDP)
    const simplified = this._simplify(points, 0.0001);

    return {
      distanceKm: Math.round(distanceKm * 10) / 10,
      elevGain: Math.round(elevGain),
      elevLoss: Math.round(elevLoss),
      minEle: minEle === Infinity ? null : Math.round(minEle),
      maxEle: maxEle === -Infinity ? null : Math.round(maxEle),
      movingTime: movingMs > 0 ? Math.round(movingMs / 1000) : null,
      totalTime: totalMs ? Math.round(totalMs / 1000) : null,
      avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
      pointCount: points.length,
      startTime: points[0]?.time || null,
      bounds: { minLat, maxLat, minLon, maxLon },
      elevProfile,
      simplifiedPath: simplified,
    };
  },

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /** Ramer–Douglas–Peucker simplification */
  _simplify(points, epsilon) {
    if (points.length <= 2) return points;
    const dmax = { val: 0, idx: 0 };
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
      const d = this._perpendicularDist(points[i], points[0], points[end]);
      if (d > dmax.val) { dmax.val = d; dmax.idx = i; }
    }
    if (dmax.val > epsilon) {
      const l = this._simplify(points.slice(0, dmax.idx + 1), epsilon);
      const r = this._simplify(points.slice(dmax.idx), epsilon);
      return [...l.slice(0, -1), ...r];
    }
    return [points[0], points[end]];
  },

  _perpendicularDist(pt, lineStart, lineEnd) {
    const dx = lineEnd.lon - lineStart.lon;
    const dy = lineEnd.lat - lineStart.lat;
    if (dx === 0 && dy === 0) {
      return Math.sqrt((pt.lon - lineStart.lon)**2 + (pt.lat - lineStart.lat)**2);
    }
    const t = ((pt.lon - lineStart.lon) * dx + (pt.lat - lineStart.lat) * dy) / (dx*dx + dy*dy);
    return Math.sqrt((pt.lon - lineStart.lon - t*dx)**2 + (pt.lat - lineStart.lat - t*dy)**2);
  },
};
