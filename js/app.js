/**
 * Adventure Log — Main App (with groups)
 */

const ACTIVITY_COLORS = {
  bike:  '#e07840', hike:  '#52c97a',
  kayak: '#4a9eff', run:   '#f5c842', other: '#b48aff',
};
const ACTIVITY_EMOJI = { bike:'🚴', hike:'🥾', kayak:'🛶', run:'🏃', other:'✦' };

// ── Map init ──────────────────────────────────────────────────────────────────
const map = L.map('map', { center:[39.5,-8.0], zoom:6, zoomControl:false });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);
L.control.zoom({ position:'bottomright' }).addTo(map);

// ── State ─────────────────────────────────────────────────────────────────────
let routes      = [];
let groups      = [];
let activeFilter = 'all';
let openGroupId  = null;
let polylines    = {};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  [routes, groups] = await Promise.all([Store.loadIndex(), Store.loadGroups()]);
  render();
  setTimeout(() => map.invalidateSize(), 200);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtKm(km) {
  return km >= 1000 ? (km/1000).toFixed(1)+'k' : Math.round(km)+'';
}

function groupRouteIds(group) { return new Set(group.routes || []); }
function allGroupedIds() {
  const s = new Set();
  groups.forEach(g => g.routes?.forEach(id => s.add(id)));
  return s;
}
function groupStats(group) {
  const ids = groupRouteIds(group), members = routes.filter(r => ids.has(r.id));
  return {
    km:     Math.round(members.reduce((s,r) => s+(r.metrics?.distanceKm||0), 0)*10)/10,
    gain:   members.reduce((s,r) => s+(r.metrics?.elevGain||0), 0),
    moving: members.reduce((s,r) => s+(r.metrics?.movingTime||0), 0),
    count:  members.length,
  };
}
function filteredRoutes() {
  return activeFilter === 'all' ? routes : routes.filter(r => r.type === activeFilter);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  renderSidebar();
  renderMap();
  updateStats();
}

function renderSidebar() {
  const list  = document.getElementById('routeList');
  const empty = document.getElementById('emptyState');
  [...list.querySelectorAll('.route-item,.group-item,.back-to-all,.ungrouped-label')].forEach(el => el.remove());

  const filtered = filteredRoutes();
  if (filtered.length === 0) { empty.style.display='flex'; return; }
  empty.style.display = 'none';

  if (openGroupId) {
    renderGroupOpen(list, filtered);
  } else {
    renderAllView(list, filtered);
  }
}

function renderAllView(list, filtered) {
  const groupedIds = allGroupedIds();
  groups.forEach(group => {
    const members = filtered.filter(r => groupRouteIds(group).has(r.id));
    if (members.length === 0) return;
    list.appendChild(makeGroupItem(group, members));
  });
  const ungrouped = filtered.filter(r => !groupedIds.has(r.id));
  ungrouped.forEach(r => list.appendChild(makeRouteItem(r)));
}

function renderGroupOpen(list, filtered) {
  const group = groups.find(g => g.id === openGroupId);
  if (!group) { openGroupId = null; renderAllView(list, filtered); return; }
  const ids     = groupRouteIds(group);
  const stats   = groupStats(group);
  const members = filtered.filter(r => ids.has(r.id));

  const back = document.createElement('div');
  back.className = 'back-to-all visible';
  back.innerHTML = '← All adventures';
  back.addEventListener('click', () => { openGroupId = null; render(); fitAllRoutes(); });
  list.appendChild(back);

  const wrap = document.createElement('div');
  wrap.className = 'group-item';
  wrap.innerHTML = `
    <div class="group-header open" style="cursor:default">
      <span class="group-icon">📁</span>
      <div class="group-info">
        <div class="group-name">${esc(group.name)}</div>
        <div class="group-meta">${stats.count} routes</div>
      </div>
    </div>
    <div class="group-body open">
      ${group.description ? `<div class="group-desc">${esc(group.description)}</div>` : ''}
      <div class="group-stats">
        <div class="group-stat"><div class="group-stat-val">${fmtKm(stats.km)}</div><div class="group-stat-lbl">km total</div></div>
        <div class="group-stat"><div class="group-stat-val">${fmtTime(stats.moving)}</div><div class="group-stat-lbl">moving time</div></div>
        <div class="group-stat"><div class="group-stat-val">${stats.gain >= 1000 ? (stats.gain/1000).toFixed(1)+'k' : stats.gain}</div><div class="group-stat-lbl">m ascent</div></div>
      </div>
      <div class="group-routes" id="openGroupRoutes"></div>
    </div>
  `;
  list.appendChild(wrap);
  const routesContainer = wrap.querySelector('#openGroupRoutes');
  members.forEach(r => routesContainer.appendChild(makeRouteItem(r)));
}

function makeRouteItem(route) {
  const item  = document.createElement('div');
  item.className = 'route-item';
  item.dataset.id = route.id;
  const color = ACTIVITY_COLORS[route.type] || ACTIVITY_COLORS.other;
  const km    = route.metrics?.distanceKm ?? '?';
  const gain  = route.metrics?.elevGain ?? null;
  const date  = route.metrics?.startTime
    ? new Date(route.metrics.startTime).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';
  item.innerHTML = `
    <div class="route-dot" style="background:${color}"></div>
    <div class="route-info">
      <div class="route-name">${esc(route.name)}</div>
      <div class="route-meta">${km} km${gain ? ' · ↑'+gain+'m' : ''}${date ? ' · '+date : ''}</div>
    </div>
    <span class="route-arrow">›</span>
  `;
  item.addEventListener('mouseenter', () => {
    const pl = polylines[route.id];
    if (pl) { pl.setStyle({ weight:5, opacity:1 }); pl.bringToFront(); }
  });
  item.addEventListener('mouseleave', () => {
    const pl = polylines[route.id];
    if (pl) pl.setStyle({ weight:3, opacity:0.8 });
  });
  item.addEventListener('click', () => { window.location.href = `route.html?id=${route.id}`; });
  return item;
}

function makeGroupItem(group, members) {
  const stats = groupStats(group);
  const el    = document.createElement('div');
  el.className = 'group-item';
  el.dataset.groupId = group.id;
  el.innerHTML = `
    <div class="group-header" data-group-id="${esc(group.id)}">
      <span class="group-icon">📁</span>
      <div class="group-info">
        <div class="group-name">${esc(group.name)}</div>
        <div class="group-meta">${members.length} routes · ${fmtKm(stats.km)} km</div>
      </div>
    </div>
  `;
  const header = el.querySelector('.group-header');
  header.addEventListener('mouseenter', () => highlightGroup(group, true));
  header.addEventListener('mouseleave', () => highlightGroup(group, false));
  header.addEventListener('click', () => { openGroupId = group.id; render(); fitGroupRoutes(group); });
  return el;
}

// ── Map ───────────────────────────────────────────────────────────────────────
function renderMap() {
  Object.values(polylines).forEach(p => map.removeLayer(p));
  polylines = {};
  const filtered = filteredRoutes();
  if (filtered.length === 0) return;

  const focusIds = openGroupId
    ? groupRouteIds(groups.find(g => g.id === openGroupId))
    : null;

  filtered.forEach(route => {
    const path = route.metrics?.simplifiedPath;
    if (!path || path.length < 2) return;
    const color  = ACTIVITY_COLORS[route.type] || ACTIVITY_COLORS.other;
    const dimmed = focusIds && !focusIds.has(route.id);
    const pl = L.polyline(path.map(p => [p.lat, p.lon]), {
      color:   dimmed ? '#444' : color,
      weight:  dimmed ? 2 : 3,
      opacity: dimmed ? 0.3 : 0.8,
    }).addTo(map);

    if (!dimmed) {
      pl.on('mouseover', e => {
        pl.setStyle({ weight:5, opacity:1 });
        L.popup({ closeButton:false }).setLatLng(e.latlng).setContent(`
          <div class="popup-name">${esc(route.name)}</div>
          <div class="popup-meta">📍 ${route.metrics?.distanceKm??'?'} km${route.metrics?.elevGain?'<br/>↑ '+route.metrics.elevGain+' m':''}<br/>${ACTIVITY_EMOJI[route.type]||'✦'} ${route.type}</div>
          <a class="popup-link" href="route.html?id=${route.id}">View details →</a>
        `).openOn(map);
      });
      pl.on('mouseout', () => pl.setStyle({ weight:3, opacity:0.8 }));
      pl.on('click', () => { window.location.href = `route.html?id=${route.id}`; });
    }
    polylines[route.id] = pl;
  });

  if (!openGroupId) fitAllRoutes();
}

function updateStats() {
  const f = filteredRoutes();
  const km   = f.reduce((s,r) => s+(r.metrics?.distanceKm||0), 0);
  const gain = f.reduce((s,r) => s+(r.metrics?.elevGain||0), 0);
  document.getElementById('statRoutes').textContent = f.length;
  document.getElementById('statKm').textContent = km >= 1000 ? (km/1000).toFixed(1)+'k' : Math.round(km);
  document.getElementById('statElev').textContent = gain >= 1000 ? (gain/1000).toFixed(1)+'k' : gain;
}

function fitAllRoutes() {
  const all = Object.values(polylines).flatMap(pl => pl.getLatLngs());
  if (all.length > 0) map.fitBounds(L.latLngBounds(all), { padding:[40,40] });
}
function fitGroupRoutes(group) {
  const ids = groupRouteIds(group);
  const lls = Object.entries(polylines).filter(([id]) => ids.has(id)).flatMap(([,pl]) => pl.getLatLngs());
  if (lls.length > 0) map.fitBounds(L.latLngBounds(lls), { padding:[40,40] });
}
function highlightGroup(group, on) {
  const ids = groupRouteIds(group);
  Object.entries(polylines).forEach(([id, pl]) => {
    if (ids.has(id)) { pl.setStyle(on ? {weight:5,opacity:1} : {weight:3,opacity:0.8}); if(on) pl.bringToFront(); }
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.dataset.type;
    render();
  });
});

// ── Import modal ──────────────────────────────────────────────────────────────
const importModal    = document.getElementById('modalBackdrop');
const fileInput      = document.getElementById('fileInput');
const modalDropZone  = document.getElementById('modalDropZone');
const routeNameInput = document.getElementById('routeName');
const activitySelect = document.getElementById('activityType');
let pendingParsed = null, pendingGpxText = null;

document.getElementById('importBtn').addEventListener('click', openImportModal);
document.getElementById('cancelBtn').addEventListener('click', closeImportModal);
document.getElementById('confirmBtn').addEventListener('click', confirmImport);
importModal.addEventListener('click', e => { if (e.target === importModal) closeImportModal(); });

function openImportModal() {
  pendingParsed = null; pendingGpxText = null;
  routeNameInput.value = '';
  document.getElementById('dropZoneLabel').innerHTML = '📂 Drop GPX here or <u>browse</u>';
  importModal.classList.add('open');
}
function closeImportModal() {
  importModal.classList.remove('open');
  pendingParsed = null; pendingGpxText = null; fileInput.value = '';
}

async function confirmImport() {
  if (!pendingParsed) { alert('Please select a GPX file first.'); return; }
  const name = routeNameInput.value.trim() || pendingParsed.name;
  const type = activitySelect.value;
  const btn  = document.getElementById('confirmBtn');
  btn.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const files = await Store.prepareCommitFiles({
      name, type, gpxText: pendingGpxText,
      metrics: pendingParsed.metrics,
      simplifiedPath: pendingParsed.metrics.simplifiedPath,
    });
    closeImportModal();
    openCommitModal(files);
  } catch(e) {
    alert('Error preparing files: ' + e.message);
  } finally {
    btn.textContent = 'Next →'; btn.disabled = false;
  }
}

// ── Commit modal ──────────────────────────────────────────────────────────────
const commitModal = document.getElementById('commitModalBackdrop');
document.getElementById('commitCloseBtn').addEventListener('click', closeCommitModal);
commitModal.addEventListener('click', e => { if (e.target === commitModal) closeCommitModal(); });

function openCommitModal(files) {
  document.getElementById('dlGpx').onclick   = () => download(files.gpxFilename.split('/').pop(), files.gpxText, 'application/octet-stream');
  document.getElementById('dlIndex').onclick = () => download('index.json', files.indexJson, 'application/octet-stream');
  document.getElementById('commitGpxPath').textContent   = files.gpxFilename;
  document.getElementById('commitIndexPath').textContent = files.indexFilename;
  document.getElementById('commitSnippet').textContent =
`git add ${files.gpxFilename} ${files.indexFilename}
git commit -m "Add route: ${files.entry.name}"
git push`;
  commitModal.classList.add('open');
}
function closeCommitModal() { commitModal.classList.remove('open'); }

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── File handling ─────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.gpx')) { alert('Please drop a .gpx file.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      pendingGpxText = e.target.result;
      const parsed = GPXParser.parse(pendingGpxText, file.name);
      pendingParsed = parsed;
      routeNameInput.value = parsed.name;
      document.getElementById('dropZoneLabel').textContent = '✓ ' + file.name + ' loaded';
    } catch(err) { alert('Could not parse GPX: ' + err.message); }
  };
  reader.readAsText(file);
}

modalDropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
modalDropZone.addEventListener('dragover', e => { e.preventDefault(); modalDropZone.classList.add('dragover'); });
modalDropZone.addEventListener('dragleave', () => modalDropZone.classList.remove('dragover'));
modalDropZone.addEventListener('drop', e => {
  e.preventDefault(); modalDropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

let dragCounter = 0;
document.addEventListener('dragenter', e => {
  if (e.dataTransfer.types.includes('Files')) { dragCounter++; document.getElementById('dropOverlay').classList.add('active'); }
});
document.addEventListener('dragleave', () => {
  if (--dragCounter <= 0) { dragCounter = 0; document.getElementById('dropOverlay').classList.remove('active'); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragCounter = 0;
  document.getElementById('dropOverlay').classList.remove('active');
  if (importModal.classList.contains('open') || commitModal.classList.contains('open')) return;
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
