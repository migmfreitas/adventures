/**
 * Adventure Log — Main App (file-based, GitHub Pages)
 */

const ACTIVITY_COLORS = {
  bike:  '#e07840',
  hike:  '#52c97a',
  kayak: '#4a9eff',
  run:   '#f5c842',
  other: '#b48aff',
};
const ACTIVITY_EMOJI = { bike:'🚴', hike:'🥾', kayak:'🛶', run:'🏃', other:'✦' };

// ── Map init ──────────────────────────────────────────────────────────────────
const map = L.map('map', { center: [39.5, -8.0], zoom: 6, zoomControl: false });

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ── State ─────────────────────────────────────────────────────────────────────
let routes = [];
let activeFilter = 'all';
let polylines = {};
let pendingParsed = null;  // parsed GPX waiting for modal confirm
let pendingGpxText = null; // raw GPX text of the pending file

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  routes = await Store.loadIndex();
  render();
  // Force Leaflet to recalculate map size after layout and data settle
  setTimeout(() => map.invalidateSize(), 200);
})();

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  renderSidebar();
  renderMap();
  updateStats();
}

function renderSidebar() {
  const list = document.getElementById('routeList');
  const empty = document.getElementById('emptyState');
  const filtered = filteredRoutes();

  [...list.querySelectorAll('.route-item')].forEach(el => el.remove());

  if (filtered.length === 0) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  filtered.forEach(route => {
    const item = document.createElement('div');
    item.className = 'route-item';
    item.dataset.id = route.id;

    const color = ACTIVITY_COLORS[route.type] || ACTIVITY_COLORS.other;
    const km = route.metrics?.distanceKm ?? '?';
    const gain = route.metrics?.elevGain ?? null;
    const date = route.metrics?.startTime
      ? new Date(route.metrics.startTime).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
      : '';

    item.innerHTML = `
      <div class="route-dot" style="background:${color}"></div>
      <div class="route-info">
        <div class="route-name">${esc(route.name)}</div>
        <div class="route-meta">${km} km${gain ? ' · ↑' + gain + 'm' : ''}${date ? ' · ' + date : ''}</div>
      </div>
      <span class="route-arrow">›</span>
    `;
    item.addEventListener('click', () => openRoute(route.id));
    list.appendChild(item);
  });
}

function renderMap() {
  Object.values(polylines).forEach(p => map.removeLayer(p));
  polylines = {};

  const filtered = filteredRoutes();
  if (filtered.length === 0) return;

  filtered.forEach(route => {
    const path = route.metrics?.simplifiedPath;
    if (!path || path.length < 2) return;

    const color = ACTIVITY_COLORS[route.type] || ACTIVITY_COLORS.other;
    const latlngs = path.map(p => [p.lat, p.lon]);

    const pl = L.polyline(latlngs, { color, weight: 3, opacity: 0.75 }).addTo(map);

    pl.on('click', () => openRoute(route.id));
    pl.on('mouseover', e => {
      pl.setStyle({ weight: 5, opacity: 1 });
      const km = route.metrics?.distanceKm ?? '?';
      const gain = route.metrics?.elevGain;
      L.popup({ closeButton: false })
        .setLatLng(e.latlng)
        .setContent(`
          <div class="popup-name">${esc(route.name)}</div>
          <div class="popup-meta">
            📍 ${km} km${gain ? '<br/>↑ ' + gain + ' m gain' : ''}<br/>
            ${ACTIVITY_EMOJI[route.type] || '✦'} ${route.type}
          </div>
          <a class="popup-link" href="route.html?id=${route.id}">View details →</a>
        `)
        .openOn(map);
    });
    pl.on('mouseout', () => pl.setStyle({ weight: 3, opacity: 0.75 }));

    polylines[route.id] = pl;
  });

  const allLatLngs = Object.values(polylines).flatMap(pl => pl.getLatLngs());
  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] });
  }
}

function updateStats() {
  const filtered = filteredRoutes();
  const totalKm   = filtered.reduce((s, r) => s + (r.metrics?.distanceKm || 0), 0);
  const totalGain = filtered.reduce((s, r) => s + (r.metrics?.elevGain || 0), 0);

  document.getElementById('statRoutes').textContent = filtered.length;
  document.getElementById('statKm').textContent = totalKm >= 1000
    ? (totalKm / 1000).toFixed(1) + 'k' : Math.round(totalKm);
  document.getElementById('statElev').textContent = totalGain >= 1000
    ? (totalGain / 1000).toFixed(1) + 'k' : totalGain;
}

function filteredRoutes() {
  return activeFilter === 'all' ? routes : routes.filter(r => r.type === activeFilter);
}

function openRoute(id) {
  window.location.href = `route.html?id=${id}`;
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

// ── Import modal (step 1: pick file + metadata) ───────────────────────────────
const importModal    = document.getElementById('modalBackdrop');
const fileInput      = document.getElementById('fileInput');
const modalDropZone  = document.getElementById('modalDropZone');
const routeNameInput = document.getElementById('routeName');
const activitySelect = document.getElementById('activityType');

document.getElementById('importBtn').addEventListener('click', openImportModal);
document.getElementById('cancelBtn').addEventListener('click', closeImportModal);
document.getElementById('confirmBtn').addEventListener('click', confirmImport);
importModal.addEventListener('click', e => { if (e.target === importModal) closeImportModal(); });

function openImportModal(parsed = null) {
  pendingParsed = parsed;
  if (parsed) {
    routeNameInput.value = parsed.name;
    document.getElementById('dropZoneLabel').textContent = '✓ ' + parsed.name + '.gpx loaded';
  } else {
    routeNameInput.value = '';
    document.getElementById('dropZoneLabel').innerHTML = '📂 Drop GPX here or <u>browse</u>';
  }
  importModal.classList.add('open');
}

function closeImportModal() {
  importModal.classList.remove('open');
  pendingParsed = null;
  pendingGpxText = null;
  fileInput.value = '';
}

async function confirmImport() {
  if (!pendingParsed) { alert('Please select a GPX file first.'); return; }

  const name = routeNameInput.value.trim() || pendingParsed.name;
  const type = activitySelect.value;
  const btn = document.getElementById('confirmBtn');
  btn.textContent = 'Preparing…'; btn.disabled = true;

  try {
    const files = await Store.prepareCommitFiles({
      name,
      type,
      gpxText:        pendingGpxText,
      metrics:        pendingParsed.metrics,
      simplifiedPath: pendingParsed.metrics.simplifiedPath,
    });

    closeImportModal();
    openCommitModal(files);
  } catch (e) {
    alert('Error preparing files: ' + e.message);
  } finally {
    btn.textContent = 'Add Route'; btn.disabled = false;
  }
}

// ── Commit modal (step 2: download files + instructions) ──────────────────────
const commitModal = document.getElementById('commitModalBackdrop');
document.getElementById('commitCloseBtn').addEventListener('click', closeCommitModal);
commitModal.addEventListener('click', e => { if (e.target === commitModal) closeCommitModal(); });

function openCommitModal(files) {
  // Wire up download buttons
  document.getElementById('dlGpx').onclick = () => download(files.gpxFilename.split('/').pop(), files.gpxText, 'application/gpx+xml');
  document.getElementById('dlIndex').onclick = () => download('index.json', files.indexJson, 'application/json');

  // Show filenames in instructions
  document.getElementById('commitGpxPath').textContent   = files.gpxFilename;
  document.getElementById('commitIndexPath').textContent = files.indexFilename;

  // Show git snippet
  document.getElementById('commitSnippet').textContent =
`git add ${files.gpxFilename} ${files.indexFilename}
git commit -m "Add route: ${files.entry.name}"
git push`;

  commitModal.classList.add('open');
}

function closeCommitModal() {
  commitModal.classList.remove('open');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
      openImportModal(parsed);
    } catch (err) {
      alert('Could not parse GPX: ' + err.message);
    }
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
