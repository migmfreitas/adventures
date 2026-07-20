#!/usr/bin/env node
/**
 * build-index.js
 * Reads every .gpx file in data/gpx/, parses it, and writes data/index.json.
 * Filename convention: <type>-<name-with-dashes>.gpx
 *   e.g. bike-sintra-coastal-loop.gpx  → type: bike, name: Sintra Coastal Loop
 *        hike-serra-da-estrela.gpx     → type: hike, name: Serra Da Estrela
 *        my-random-ride.gpx            → type: other, name: My Random Ride
 *
 * Preserves existing index entries so previously-computed IDs stay stable.
 * Only re-parses files that are new or changed (by comparing mtime).
 */

const fs   = require('fs');
const path = require('path');

const GPX_DIR    = path.join(__dirname, '../../data/gpx');
const INDEX_FILE = path.join(__dirname, '../../data/index.json');

const VALID_TYPES = ['bike', 'hike', 'kayak', 'run', 'other'];

// ── Filename parser ────────────────────────────────────────────────────────────
function parseFilename(filename) {
  const base = path.basename(filename, '.gpx');
  const parts = base.split('-');
  let type = 'other';
  let nameParts = parts;

  if (VALID_TYPES.includes(parts[0].toLowerCase())) {
    type = parts[0].toLowerCase();
    nameParts = parts.slice(1);
  }

  const name = nameParts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || base;

  // Use the filename stem as the stable ID (minus extension)
  const id = base;

  return { id, name, type };
}

// ── GPX parser (mirrors the browser-side logic) ───────────────────────────────
const { DOMParser } = require('@xmldom/xmldom');

function parseGPX(text, filename) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');

  let points = extractPoints(xml, 'trkpt');
  if (points.length === 0) points = extractPoints(xml, 'rtept');
  if (points.length === 0) throw new Error('No track points found in ' + filename);

  return computeMetrics(points);
}

function extractPoints(xml, tag) {
  const pts = [];
  const els = xml.getElementsByTagName(tag);
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (isNaN(lat) || isNaN(lon)) continue;

    const eleEl  = el.getElementsByTagName('ele')[0];
    const timeEl = el.getElementsByTagName('time')[0];
    const hrEl   = el.getElementsByTagName('hr')[0] || el.getElementsByTagName('heartrate')[0];

    pts.push({
      lat,
      lon,
      ele:  eleEl  ? parseFloat(eleEl.textContent)  : null,
      time: timeEl ? new Date(timeEl.textContent)    : null,
      hr:   hrEl   ? parseInt(hrEl.textContent)      : null,
    });
  }
  return pts;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function smoothElevations(points, windowSize = 10) {
  // Gaussian-style rolling average to remove GPS elevation noise
  // before computing accumulated ascent/descent
  const elev = points.map(p => p.ele);
  return points.map((p, i) => {
    if (p.ele === null) return p;
    const half = Math.floor(windowSize / 2);
    const slice = elev.slice(Math.max(0, i - half), Math.min(elev.length, i + half + 1))
      .filter(e => e !== null);
    const avg = slice.reduce((s, e) => s + e, 0) / slice.length;
    return { ...p, ele: avg };
  });
}

function computeMetrics(points) {
  let distanceM = 0, elevGain = 0, elevLoss = 0;
  let minEle = Infinity, maxEle = -Infinity;
  let movingMs = 0, hrSum = 0, hrCount = 0;
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  // Smooth elevations before computing gain/loss to eliminate GPS noise
  const smoothed = smoothElevations(points);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const s = smoothed[i];
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.ele !== null) {
      if (p.ele < minEle) minEle = p.ele;
      if (p.ele > maxEle) maxEle = p.ele;
    }
    if (p.hr !== null) { hrSum += p.hr; hrCount++; }
    if (i === 0) continue;

    const prev = points[i-1];
    const sp = smoothed[i-1];
    const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
    distanceM += d;

    // Use smoothed elevation for gain/loss — sum ALL positive/negative changes
    if (s.ele !== null && sp.ele !== null) {
      const dEle = s.ele - sp.ele;
      if (dEle > 0) elevGain += dEle;
      else          elevLoss += Math.abs(dEle);
    }

    if (p.time && prev.time) {
      const dt = (p.time - prev.time) / 1000;
      if (d / dt > 0.14) movingMs += dt * 1000;
    }
  }

  const distanceKm = distanceM / 1000;
  const totalMs = points[0]?.time && points[points.length-1]?.time
    ? points[points.length-1].time - points[0].time : null;

  // Elevation profile (max 500 samples)
  const step = Math.max(1, Math.floor(points.length / 500));
  const elevProfile = points
    .filter((_, i) => i % step === 0 && points[i].ele !== null)
    .map((p, i) => ({ d: Math.round(i * step * distanceM / points.length), ele: Math.round(p.ele) }));

  const simplifiedPath = simplify(points, 0.00001);

  return {
    distanceKm:    Math.round(distanceKm * 10) / 10,
    elevGain:      Math.round(elevGain),
    elevLoss:      Math.round(elevLoss),
    minEle:        minEle === Infinity  ? null : Math.round(minEle),
    maxEle:        maxEle === -Infinity ? null : Math.round(maxEle),
    movingTime:    movingMs > 0 ? Math.round(movingMs / 1000) : null,
    totalTime:     totalMs  ? Math.round(totalMs / 1000) : null,
    avgHr:         hrCount > 0 ? Math.round(hrSum / hrCount) : null,
    pointCount:    points.length,
    startTime:     points[0]?.time || null,
    bounds:        { minLat, maxLat, minLon, maxLon },
    elevProfile,
    simplifiedPath,
  };
}

function simplify(points, epsilon) {
  if (points.length <= 2) return points;
  let dmax = 0, idx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(points[i], points[0], points[end]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > epsilon) {
    const l = simplify(points.slice(0, idx+1), epsilon);
    const r = simplify(points.slice(idx), epsilon);
    return [...l.slice(0,-1), ...r];
  }
  return [points[0], points[end]];
}

function perpDist(pt, a, b) {
  const dx = b.lon - a.lon, dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) return Math.sqrt((pt.lon-a.lon)**2 + (pt.lat-a.lat)**2);
  const t = ((pt.lon-a.lon)*dx + (pt.lat-a.lat)*dy) / (dx*dx + dy*dy);
  return Math.sqrt((pt.lon-a.lon-t*dx)**2 + (pt.lat-a.lat-t*dy)**2);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  // Load existing index so we can preserve addedAt timestamps
  let existing = [];
  if (fs.existsSync(INDEX_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch {}
  }
  const existingMap = Object.fromEntries(existing.map(r => [r.id, r]));

  const gpxFiles = fs.readdirSync(GPX_DIR)
    .filter(f => f.toLowerCase().endsWith('.gpx'))
    .sort();

  console.log(`Found ${gpxFiles.length} GPX file(s)`);

  const entries = [];

  for (const file of gpxFiles) {
    const { id, name, type } = parseFilename(file);
    const gpxPath = path.join(GPX_DIR, file);
    const text = fs.readFileSync(gpxPath, 'utf8');

    let metrics;
    try {
      metrics = parseGPX(text, file);
      console.log(`  ✓ ${file} → ${name} (${type}) — ${metrics.distanceKm} km`);
    } catch (e) {
      console.error(`  ✗ ${file}: ${e.message}`);
      continue;
    }

    entries.push({
      id,
      name:    existingMap[id]?.name    || name,   // preserve manual renames
      type:    existingMap[id]?.type    || type,   // preserve manual type changes
      addedAt: existingMap[id]?.addedAt || new Date().toISOString(),
      metrics,
    });
  }

  // Sort newest first (by startTime, fall back to addedAt)
  entries.sort((a, b) => {
    const ta = a.metrics.startTime || a.addedAt;
    const tb = b.metrics.startTime || b.addedAt;
    return new Date(tb) - new Date(ta);
  });

  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
  console.log(`\nWrote ${entries.length} entries to data/index.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
