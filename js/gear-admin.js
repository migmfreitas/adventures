/**
 * Gear admin — commits bike details and maintenance log entries straight to
 * data/gear.json using a GitHub personal access token, stored only in this
 * browser's localStorage (same key the routes admin uses, so a token
 * entered on either page works on both).
 */

const OWNER = 'migmfreitas';
const REPO = 'adventures';
const TOKEN_KEY = 'adventureLogAdminToken';
const GEAR_PATH = 'data/gear.json';

const BIKE_TYPE_EMOJI = { road: '🚴', gravel: '🌄', mountain: '⛰️', city: '🏙️', ebike: '⚡', other: '✦' };
const LOG_TYPE_EMOJI = { service: '🔧', repair: '🛠️', part: '🔩', tire: '🛞', clean: '🧼', other: '✦' };
const LOG_TYPE_LABEL = { service: 'Service', repair: 'Repair', part: 'Part replacement', tire: 'Tires', clean: 'Cleaning', other: 'Other' };

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  defaultBranch: null,
  gear: [],
  routes: [],            // data/index.json, loaded read-only just to show ride count/distance per bike
  editingBikeId: null,   // id of the bike currently being edited in the form, or null
  addingLogFor: null,    // id of the bike whose "add entry" mini-form is open, or null
};

// ── Small helpers ────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function $(id) { return document.getElementById(id); }
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function slugify(str) {
  return str.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function makeBikeId(name, existing) {
  const base = slugify(name) || 'bike';
  let id = base, i = 2;
  while (existing.some(b => b.id === id)) id = `${base}-${i++}`;
  return id;
}
function makeEntryId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ── GitHub API ────────────────────────────────────────────────────────────────
async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message; } catch {}
    throw new Error(`GitHub API ${method} ${path} → ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}
async function fetchRawJson(path, ref, fallback) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${ref}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return fallback;
    throw new Error(`Failed to fetch ${path} (${res.status})`);
  }
  return res.json();
}

async function commitGear(message, newGear) {
  logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
  const latestCommitSha = ref.object.sha;

  const baseCommit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${latestCommitSha}`);
  const content = JSON.stringify(newGear, null, 2);
  const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
  const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree: [{ path: GEAR_PATH, mode: '100644', type: 'blob', sha: blob.sha }] },
  });
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [latestCommitSha] },
  });
  logLine('✓ Commit created: ' + commit.sha.slice(0, 7));

  try {
    await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } catch (e) {
    throw new Error('Someone else pushed to the repo while this was running — the commit was created but not pushed. Reload and retry.');
  }
  logLine('✓ Pushed to ' + esc(state.defaultBranch));

  state.gear = newGear;
}

// ── Log panel ─────────────────────────────────────────────────────────────────
function clearLog() { $('logLines').innerHTML = ''; $('logCard').style.display = 'none'; }
function logLine(html, isErr = false, isOk = false) {
  $('logCard').style.display = '';
  const div = document.createElement('div');
  div.className = 'log-line' + (isErr ? ' err' : '') + (isOk ? ' ok' : '');
  div.innerHTML = html;
  $('logLines').appendChild(div);
  div.scrollIntoView({ block: 'nearest' });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function connect(token) {
  state.token = token.trim();
  const repoInfo = await gh(`/repos/${OWNER}/${REPO}`);
  state.defaultBranch = repoInfo.default_branch;
  localStorage.setItem(TOKEN_KEY, state.token);
  $('connectedRepo').textContent = `${repoInfo.full_name} (${state.defaultBranch})`;
  $('authForm').style.display = 'none';
  $('authConnected').style.display = '';
  $('bikeCard').style.display = '';
  $('bikesCard').style.display = '';
  await loadGear();
}
function disconnect() {
  state.token = '';
  state.defaultBranch = null;
  localStorage.removeItem(TOKEN_KEY);
  $('authForm').style.display = '';
  $('authConnected').style.display = 'none';
  $('bikeCard').style.display = 'none';
  $('bikesCard').style.display = 'none';
  $('tokenInput').value = '';
  state.gear = [];
}

$('connectBtn').addEventListener('click', async () => {
  const token = $('tokenInput').value;
  if (!token.trim()) return;
  $('connectBtn').disabled = true;
  $('connectBtn').textContent = 'Connecting…';
  try {
    await connect(token);
  } catch (e) {
    alert('Could not connect: ' + e.message);
  } finally {
    $('connectBtn').disabled = false;
    $('connectBtn').textContent = 'Connect';
  }
});
$('disconnectBtn').addEventListener('click', disconnect);

async function loadGear() {
  try {
    state.gear = await fetchRawJson(GEAR_PATH, state.defaultBranch, []);
  } catch (e) {
    state.gear = [];
  }
  try {
    state.routes = await fetchRawJson('data/index.json', state.defaultBranch, []);
  } catch (e) {
    state.routes = [];
  }
  renderBikesList();
}

// ── Bike form (add / edit) ───────────────────────────────────────────────────
function readBikeForm() {
  const name = $('nameInput').value.trim();
  if (!name) throw new Error('Enter a bike name.');
  return {
    name,
    type: $('typeSelect').value,
    brand: $('brandInput').value.trim(),
    model: $('modelInput').value.trim(),
    year: $('yearInput').value ? parseInt($('yearInput').value, 10) : null,
    size: $('sizeInput').value.trim(),
    purchaseDate: $('purchaseDateInput').value || null,
    frame: $('frameInput').value.trim(),
    groupset: $('groupsetInput').value.trim(),
    wheels: $('wheelsInput').value.trim(),
    tires: $('tiresInput').value.trim(),
    notes: $('notesInput').value.trim(),
  };
}

$('bikeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('submitBtn');
  const editing = !!state.editingBikeId;
  btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Committing…';
  clearLog();
  try {
    if (!state.token) throw new Error('Connect with a GitHub token first.');
    const fields = readBikeForm();

    let newGear, message;
    if (editing) {
      const idx = state.gear.findIndex(b => b.id === state.editingBikeId);
      if (idx === -1) throw new Error('This bike no longer exists — reload the page.');
      newGear = [...state.gear];
      newGear[idx] = { ...newGear[idx], ...fields };
      message = `Edit bike: ${fields.name}`;
    } else {
      const id = makeBikeId(fields.name, state.gear);
      const bike = { id, ...fields, addedAt: new Date().toISOString(), maintenanceLog: [] };
      newGear = [...state.gear, bike];
      message = `Add bike: ${fields.name}`;
    }

    await commitGear(message, newGear);
    logLine(`<b>${editing ? 'Saved' : 'Added'}.</b> Live in ~60s on <a href="gear.html" target="_blank">gear.html</a>`, false, true);
    exitEditMode();
    renderBikesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Add bike';
  }
});

function enterEditMode(bike) {
  state.editingBikeId = bike.id;
  $('bikeCardTitle').textContent = 'Edit bike';
  $('bikeCardSub').textContent = 'Change any field and save.';
  $('editBanner').style.display = '';
  $('editBannerName').textContent = bike.name;
  $('submitBtn').textContent = 'Save changes';
  $('deleteBtn').style.display = '';

  $('nameInput').value = bike.name || '';
  $('typeSelect').value = bike.type || 'road';
  $('brandInput').value = bike.brand || '';
  $('modelInput').value = bike.model || '';
  $('yearInput').value = bike.year || '';
  $('sizeInput').value = bike.size || '';
  $('purchaseDateInput').value = bike.purchaseDate || '';
  $('frameInput').value = bike.frame || '';
  $('groupsetInput').value = bike.groupset || '';
  $('wheelsInput').value = bike.wheels || '';
  $('tiresInput').value = bike.tires || '';
  $('notesInput').value = bike.notes || '';

  $('bikeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function exitEditMode() {
  state.editingBikeId = null;
  $('bikeCardTitle').textContent = 'Add a bike';
  $('bikeCardSub').textContent = "Add your bike's details. You can log maintenance on it afterward from the list below.";
  $('editBanner').style.display = 'none';
  $('submitBtn').textContent = 'Add bike';
  $('deleteBtn').style.display = 'none';
  $('bikeForm').reset();
  $('typeSelect').value = 'road';
}
$('cancelEditBtn').addEventListener('click', exitEditMode);

$('deleteBtn').addEventListener('click', async () => {
  const bike = state.gear.find(b => b.id === state.editingBikeId);
  if (!bike) return;
  if (!confirm(`Delete "${bike.name}"? This also removes its maintenance log. This cannot be undone from here.`)) return;

  clearLog();
  const btn = $('deleteBtn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    const newGear = state.gear.filter(b => b.id !== bike.id);
    await commitGear(`Delete bike: ${bike.name}`, newGear);
    logLine(`<b>Deleted "${esc(bike.name)}".</b>`, false, true);
    exitEditMode();
    renderBikesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Delete bike';
  }
});

// ── Bikes list + maintenance log ─────────────────────────────────────────────
function renderBikesList() {
  const list = $('bikesList');
  if (!state.gear.length) {
    list.innerHTML = '<div class="bikes-empty">No bikes yet — add one above.</div>';
    return;
  }
  list.innerHTML = '';
  state.gear.forEach(bike => list.appendChild(renderBikeRow(bike)));
}

function renderBikeRow(bike) {
  const wrap = document.createElement('div');
  wrap.className = 'bike-row';

  const top = document.createElement('div');
  top.className = 'bike-row-top';
  const logCount = (bike.maintenanceLog || []).length;
  const rides = state.routes.filter(r => r.gearId === bike.id);
  const totalKm = rides.reduce((sum, r) => sum + (Number(r.metrics?.distanceKm) || 0), 0);
  const meta = [
    `${logCount} log entr${logCount === 1 ? 'y' : 'ies'}`,
    `${rides.length} ride${rides.length === 1 ? '' : 's'}`,
    totalKm ? `${totalKm.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` : '',
    bike.brand,
  ].filter(Boolean).join(' · ');
  top.innerHTML = `
    <span class="bike-row-emoji">${BIKE_TYPE_EMOJI[bike.type] || '✦'}</span>
    <div class="bike-row-info">
      <div class="bike-row-name">${esc(bike.name)}</div>
      <div class="bike-row-meta">${meta}</div>
    </div>
    <div class="bike-row-actions">
      <button type="button" class="btn btn-small" data-act="edit">Edit</button>
      <button type="button" class="btn btn-small" data-act="log">＋ Log entry</button>
    </div>
  `;
  top.querySelector('[data-act="edit"]').addEventListener('click', () => enterEditMode(bike));
  top.querySelector('[data-act="log"]').addEventListener('click', () => {
    state.addingLogFor = state.addingLogFor === bike.id ? null : bike.id;
    renderBikesList();
  });
  wrap.appendChild(top);

  const entries = [...(bike.maintenanceLog || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (entries.length) {
    const entriesWrap = document.createElement('div');
    entriesWrap.className = 'log-entries';
    entries.forEach(entry => entriesWrap.appendChild(renderLogEntryRow(bike, entry)));
    wrap.appendChild(entriesWrap);
  }

  if (state.addingLogFor === bike.id) {
    wrap.appendChild(renderLogAddForm(bike));
  }

  return wrap;
}

function renderLogEntryRow(bike, entry) {
  const row = document.createElement('div');
  row.className = 'log-entry-row';
  const meta = [
    entry.mileageKm ? `${Number(entry.mileageKm).toLocaleString()} km` : '',
    entry.cost ? Number(entry.cost).toLocaleString(undefined, { style: 'currency', currency: 'EUR' }) : '',
  ].filter(Boolean).join(' · ');
  row.innerHTML = `
    <div class="log-entry-info">
      <div class="log-entry-title">${fmtDate(entry.date)} · ${LOG_TYPE_EMOJI[entry.type] || '✦'} ${esc(LOG_TYPE_LABEL[entry.type] || 'Other')}${entry.description ? ' — ' + esc(entry.description) : ''}</div>
      ${meta ? `<div class="log-entry-meta">${meta}</div>` : ''}
    </div>
    <div class="log-entry-actions">
      <button type="button" class="btn btn-small btn-danger" data-act="delete">✕</button>
    </div>
  `;
  row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteLogEntry(bike, entry));
  return row;
}

function renderLogAddForm(bike) {
  const wrap = document.createElement('div');
  wrap.className = 'log-add-form';
  wrap.innerHTML = `
    <div class="row">
      <div class="field">
        <label>Date</label>
        <input type="date" class="le-date" value="${new Date().toISOString().slice(0, 10)}" />
      </div>
      <div class="field">
        <label>Type</label>
        <select class="le-type">
          <option value="service">🔧 Service</option>
          <option value="repair">🛠️ Repair</option>
          <option value="part">🔩 Part replacement</option>
          <option value="tire">🛞 Tires</option>
          <option value="clean">🧼 Cleaning</option>
          <option value="other">✦ Other</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>Description <span style="text-transform:none">(optional)</span></label>
      <input type="text" class="le-desc" placeholder="e.g. New chain and cassette" />
    </div>
    <div class="row">
      <div class="field">
        <label>Mileage (km) <span style="text-transform:none">(optional)</span></label>
        <input type="number" class="le-km" min="0" />
      </div>
      <div class="field">
        <label>Cost (€) <span style="text-transform:none">(optional)</span></label>
        <input type="number" class="le-cost" min="0" step="0.01" />
      </div>
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-accent btn-block" data-act="save">Log entry</button>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
    </div>
  `;
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    state.addingLogFor = null;
    renderBikesList();
  });
  wrap.querySelector('[data-act="save"]').addEventListener('click', () => {
    const date = wrap.querySelector('.le-date').value;
    if (!date) { alert('Pick a date.'); return; }
    const entry = {
      id: makeEntryId(),
      date,
      type: wrap.querySelector('.le-type').value,
      description: wrap.querySelector('.le-desc').value.trim(),
      mileageKm: wrap.querySelector('.le-km').value ? parseInt(wrap.querySelector('.le-km').value, 10) : null,
      cost: wrap.querySelector('.le-cost').value ? parseFloat(wrap.querySelector('.le-cost').value) : null,
    };
    addLogEntry(bike, entry, wrap.querySelector('[data-act="save"]'));
  });
  return wrap;
}

async function addLogEntry(bike, entry, btn) {
  clearLog();
  if (!state.token) { logLine('✗ Connect with a GitHub token first.', true); return; }
  btn.disabled = true; btn.textContent = 'Logging…';
  try {
    const idx = state.gear.findIndex(b => b.id === bike.id);
    if (idx === -1) throw new Error('This bike no longer exists — reload the page.');
    const newGear = [...state.gear];
    newGear[idx] = { ...newGear[idx], maintenanceLog: [...(newGear[idx].maintenanceLog || []), entry] };
    await commitGear(`Log maintenance: ${bike.name} — ${LOG_TYPE_LABEL[entry.type] || entry.type}`, newGear);
    logLine('<b>Logged.</b>', false, true);
    state.addingLogFor = null;
    renderBikesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
    btn.disabled = false; btn.textContent = 'Log entry';
  }
}

async function deleteLogEntry(bike, entry) {
  if (!confirm('Delete this maintenance entry?')) return;
  clearLog();
  try {
    if (!state.token) throw new Error('Connect with a GitHub token first.');
    const idx = state.gear.findIndex(b => b.id === bike.id);
    if (idx === -1) throw new Error('This bike no longer exists — reload the page.');
    const newGear = [...state.gear];
    newGear[idx] = { ...newGear[idx], maintenanceLog: (newGear[idx].maintenanceLog || []).filter(e => e.id !== entry.id) };
    await commitGear(`Remove maintenance entry: ${bike.name}`, newGear);
    logLine('<b>Removed.</b>', false, true);
    renderBikesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  if (state.token) {
    try { await connect(state.token); }
    catch (e) { disconnect(); }
  }
})();
