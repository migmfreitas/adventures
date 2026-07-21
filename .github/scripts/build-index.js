#!/usr/bin/env node
/**
 * build-index.js
 *
 * Folder structure drives everything:
 *   data/gpx/<type>/<group>/<filename>.gpx   → grouped route
 *   data/gpx/<type>/<filename>.gpx           → ungrouped route
 *
 * Valid types: bike, hike, kayak, run, other
 *
 * Filename → name:
 *   stage-1---porto-to-vagueira.gpx  →  "Stage 1 - Porto To Vagueira"
 *   (triple dash becomes " - ", remaining dashes become spaces, Title Case)
 *
 * Group name: folder name, dashes→spaces, Title Case
 *   eurovelo-1-portugal  →  "Eurovelo 1 Portugal"
 */

const fs   = require('fs');
const path = require('path');

const GPX_DIR        = path.join(__dirname, '../../data/gpx');
const INDEX_FILE     = path.join(__dirname, '../../data/index.json');
const COLLECTIONS_FILE = path.join(__dirname, '../../data/collections.json');

const VALID_TYPES = new Set(['bike', 'hike', 'kayak', 'run', 'other']);

// ── Name helpers ──────────────────────────────────────────────────────────────
function toTitleCase(str) {
  // Capitalize first letter of each word, but only after true word boundaries
  // (spaces, hyphens, dashes) — not after accented chars like é, ã, ç etc.
  return str.replace(/(^|[\s\-–])\S/g, c => c.toUpperCase());
}

function filenameToName(filename) {
  const base = path.basename(filename, '.gpx');
  // Strip leading number prefix: "01 - Stage 1..." or "01. Stage 1..." → "Stage 1..."
  const stripped = base.replace(/^\d+\s*[-–.\s]\s*/, '');
  // Already has spaces — just Title Case; otherwise convert dashes to spaces
  const spaced = stripped.includes(' ') ? stripped : stripped.replace(/-/g, ' ');
  return toTitleCase(spaced.trim());
}

function filenameSortKey(filename) {
  const base = path.basename(filename, '.gpx');
  const match = base.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : Infinity;
}

function folderToName(folder) {
  return toTitleCase(folder.replace(/-/g, ' '));
}

function makeId(type, group, filename) {
  const base = path.basename(filename, '.gpx');
  const parts = [type, group, base].filter(Boolean);
  return parts.join('/').replace(/[^a-z0-9/._-]/gi, '-').toLowerCase();
}

function makeGpxPath(type, group, filename) {
  // Preserve original filename with spaces/capitals for the actual fetch path
  const parts = ['data/gpx', type, group, filename].filter(Boolean);
  return parts.join('/');
}

// ── GPX parser ────────────────────────────────────────────────────────────────
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
  const pts = [], els = xml.getElementsByTagName(tag);
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (isNaN(lat) || isNaN(lon)) continue;
    const eleEl  = el.getElementsByTagName('ele')[0];
    const timeEl = el.getElementsByTagName('time')[0];
    const hrEl   = el.getElementsByTagName('hr')[0] || el.getElementsByTagName('heartrate')[0];
    pts.push({
      lat, lon,
      ele:  eleEl  ? parseFloat(eleEl.textContent)  : null,
      time: timeEl ? new Date(timeEl.textContent)    : null,
      hr:   hrEl   ? parseInt(hrEl.textContent)      : null,
    });
  }
  return pts;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function computeMetrics(points) {
  let distanceM=0, elevGain=0, elevLoss=0;
  let minEle=Infinity, maxEle=-Infinity;
  let movingMs=0, hrSum=0, hrCount=0;
  let minLat=Infinity, maxLat=-Infinity, minLon=Infinity, maxLon=-Infinity;

  for (let i=0; i<points.length; i++) {
    const p=points[i];
    if(p.lat<minLat)minLat=p.lat; if(p.lat>maxLat)maxLat=p.lat;
    if(p.lon<minLon)minLon=p.lon; if(p.lon>maxLon)maxLon=p.lon;
    if(p.ele!==null){ if(p.ele<minEle)minEle=p.ele; if(p.ele>maxEle)maxEle=p.ele; }
    if(p.hr!==null){ hrSum+=p.hr; hrCount++; }
    if(i===0) continue;
    const prev=points[i-1];
    const d=haversine(prev.lat,prev.lon,p.lat,p.lon);
    distanceM+=d;
    if(p.ele!==null&&prev.ele!==null){ const dEle=p.ele-prev.ele; if(dEle>0)elevGain+=dEle; else elevLoss+=Math.abs(dEle); }
    if(p.time&&prev.time){ const dt=(p.time-prev.time)/1000; if(d/dt>0.14)movingMs+=dt*1000; }
  }

  const distanceKm = distanceM/1000;
  const totalMs = points[0]?.time&&points[points.length-1]?.time ? points[points.length-1].time-points[0].time : null;

  // Elevation profile (up to 2000 samples)
  const MAX_PROFILE=2000;
  const elevRaw=[];
  let runDist=0;
  for(let i=0;i<points.length;i++){
    if(i>0) runDist+=haversine(points[i-1].lat,points[i-1].lon,points[i].lat,points[i].lon);
    if(points[i].ele!==null) elevRaw.push({d:Math.round(runDist),ele:Math.round(points[i].ele)});
  }
  const elevStep=Math.max(1,Math.floor(elevRaw.length/MAX_PROFILE));
  const elevProfile=elevRaw.filter((_,i)=>i%elevStep===0);

  return {
    distanceKm:  Math.round(distanceKm*10)/10,
    elevGain:    Math.round(elevGain),
    elevLoss:    Math.round(elevLoss),
    minEle:      minEle===Infinity?null:Math.round(minEle),
    maxEle:      maxEle===-Infinity?null:Math.round(maxEle),
    movingTime:  movingMs>0?Math.round(movingMs/1000):null,
    totalTime:   totalMs?Math.round(totalMs/1000):null,
    avgHr:       hrCount>0?Math.round(hrSum/hrCount):null,
    pointCount:  points.length,
    startTime:   points[0]?.time||null,
    bounds:      {minLat,maxLat,minLon,maxLon},
    elevProfile,
    simplifiedPath: simplify(points,0.00001),
  };
}

function simplify(points,epsilon){
  if(points.length<=2)return points;
  let dmax=0,idx=0;
  const end=points.length-1;
  for(let i=1;i<end;i++){ const d=perpDist(points[i],points[0],points[end]); if(d>dmax){dmax=d;idx=i;} }
  if(dmax>epsilon){ const l=simplify(points.slice(0,idx+1),epsilon),r=simplify(points.slice(idx),epsilon); return[...l.slice(0,-1),...r]; }
  return[points[0],points[end]];
}
function perpDist(pt,a,b){
  const dx=b.lon-a.lon,dy=b.lat-a.lat;
  if(dx===0&&dy===0)return Math.sqrt((pt.lon-a.lon)**2+(pt.lat-a.lat)**2);
  const t=((pt.lon-a.lon)*dx+(pt.lat-a.lat)*dy)/(dx*dx+dy*dy);
  return Math.sqrt((pt.lon-a.lon-t*dx)**2+(pt.lat-a.lat-t*dy)**2);
}

// ── Scan folder structure ─────────────────────────────────────────────────────
function scanGpxFiles() {
  // Returns [{type, group, groupName, file, id, name}]
  const results = [];

  if (!fs.existsSync(GPX_DIR)) { console.warn('data/gpx/ not found'); return results; }

  const allEntries = fs.readdirSync(GPX_DIR, {withFileTypes:true});
  console.log('Contents of data/gpx/:', allEntries.map(e => e.name + (e.isDirectory() ? '/' : '')));

  const typeDirs = allEntries.filter(d => d.isDirectory() && VALID_TYPES.has(d.name.toLowerCase()));
  console.log('Type dirs found:', typeDirs.map(d => d.name));

  for (const typeDir of typeDirs) {
    const type = typeDir.name.toLowerCase();
    const typePath = path.join(GPX_DIR, typeDir.name);
    const entries = fs.readdirSync(typePath, {withFileTypes:true});
    console.log(`  Contents of ${typeDir.name}/:`, entries.map(e => e.name + (e.isDirectory() ? '/' : '')));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const isUngrouped = entry.name.toLowerCase() === 'ungrouped';
        const group = isUngrouped ? null : entry.name;
        const groupName = group ? folderToName(group) : null;
        const groupPath = path.join(typePath, entry.name);
        const files = fs.readdirSync(groupPath)
          .filter(f => f.toLowerCase().endsWith('.gpx'))
          .sort((a, b) => filenameSortKey(a) - filenameSortKey(b) || a.localeCompare(b));
        console.log(`    Contents of ${group}/: ${files.length} GPX file(s)`);
        for (const file of files) {
          results.push({
            type, group, groupName,
            file:    path.join(groupPath, file),
            id:      makeId(type, group, file),
            gpxPath: makeGpxPath(type, group, file),
            name:    filenameToName(file),
          });
        }
      } else if (entry.name.toLowerCase().endsWith('.gpx')) {
        results.push({
          type, group: null, groupName: null,
          file:    path.join(typePath, entry.name),
          id:      makeId(type, null, entry.name),
          gpxPath: makeGpxPath(type, null, entry.name),
          name:    filenameToName(entry.name),
        });
      }
    }
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load collections.json for ordering and display names
  let collections = [];
  if (fs.existsSync(COLLECTIONS_FILE)) {
    try { collections = JSON.parse(fs.readFileSync(COLLECTIONS_FILE,'utf8')); } catch {}
  }
  // Map from folder name (case-insensitive) → { name, description, order }
  const collectionMap = new Map();
  collections.forEach((c, i) => {
    collectionMap.set(c.folder.toLowerCase(), { name: c.name, description: c.description||'', order: i });
  });

  // Load existing to preserve addedAt
  let existing = [];
  if (fs.existsSync(INDEX_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(INDEX_FILE,'utf8')); } catch {}
  }
  const existingMap = Object.fromEntries(existing.map(r=>[r.id,r]));

  const gpxFiles = scanGpxFiles();
  console.log(`Found ${gpxFiles.length} GPX file(s)`);

  const entries = [];
  for (const {type,group,groupName,file,id,gpxPath,name} of gpxFiles) {
    let metrics;
    try {
      const text = fs.readFileSync(file,'utf8');
      metrics = parseGPX(text, path.basename(file));
      console.log(`  ✓ ${path.relative(GPX_DIR,file)} → ${name} (${type}${groupName?' / '+groupName:''}) — ${metrics.distanceKm} km`);
    } catch(e) {
      console.error(`  ✗ ${path.relative(GPX_DIR,file)}: ${e.message}`);
      continue;
    }

    // Override group display name from collections.json if defined
    const col = group ? collectionMap.get(group.toLowerCase()) : null;
    const resolvedGroupName = col ? col.name : groupName;

    entries.push({
      id,
      name:        existingMap[id]?.name || name,
      type,
      group:       group || null,
      groupName:   resolvedGroupName || null,
      description: col?.description || null,
      gpxPath,
      addedAt:     existingMap[id]?.addedAt || new Date().toISOString(),
      metrics,
    });
  }

  // Sort: grouped routes ordered by collections.json, then within group by filename prefix
  // Ungrouped routes sorted by startTime descending
  const grouped   = entries.filter(e => e.group);
  const ungrouped = entries.filter(e => !e.group).sort((a, b) => {
    const ta = a.metrics.startTime || a.addedAt;
    const tb = b.metrics.startTime || b.addedAt;
    return new Date(tb) - new Date(ta);
  });

  // Sort grouped by collection order (unlisted collections go after listed ones)
  grouped.sort((a, b) => {
    const orderA = collectionMap.get(a.group?.toLowerCase())?.order ?? Infinity;
    const orderB = collectionMap.get(b.group?.toLowerCase())?.order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    // Within same collection, preserve filename prefix order (already sorted by scanGpxFiles)
    return 0;
  });

  const sorted = [...grouped, ...ungrouped];

  fs.writeFileSync(INDEX_FILE, JSON.stringify(sorted, null, 2));
  console.log(`\nWrote ${sorted.length} entries to data/index.json`);
}

main().catch(e=>{console.error(e);process.exit(1);});
