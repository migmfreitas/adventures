/**
 * Admin portal — commits GPX routes (+ description, + photos) straight to
 * GitHub using a personal access token supplied by the operator, stored only
 * in this browser's localStorage.
 *
 * Mirrors the folder/id/sort conventions in .github/scripts/build-index.js
 * so the entry this page writes is indistinguishable from one the Action
 * would have produced. The commit message is prefixed "Add route: " on
 * purpose — the Action skips rebuilding data/index.json when it sees that
 * prefix, since this page already wrote the up-to-date version.
 */

const OWNER = 'migmfreitas';
const REPO  = 'adventures';
const TOKEN_KEY = 'adventureLogAdminToken';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  defaultBranch: null,
  collections: [],
  gpxFile: null,
  gpxText: null,
  parsed: null,
  photos: [], // { file, url }
};

// ── Small helpers ────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function $(id) { return document.getElementById(id); }

function b64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const LOWERCASE_WORDS = new Set([
  'a','à','ao','de','do','da','dos','das','em','no','na','nos','nas',
  'e','o','os','as','um','uma','por','para','com','the','to','of','in',
  'at','by','and','or','from',
]);
function toTitleCase(str) {
  return str.split(/([\s\-–]+)/).map((part, i, arr) => {
    if (/^[\s\-–]+$/.test(part)) return part;
    const lower = part.toLowerCase();
    const isFirst = arr.slice(0, i).every(p => /^[\s\-–]*$/.test(p));
    if (isFirst || !LOWERCASE_WORDS.has(lower)) {
      const chars = [...lower];
      chars[0] = chars[0].toUpperCase();
      return chars.join('');
    }
    return lower;
  }).join('');
}
function guessNameFromFilename(filename) {
  const base = filename.replace(/\.gpx$/i, '');
  const stripped = base.replace(/^\d+\s*[-–.\s]\s*/, '');
  const spaced = stripped.includes(' ') ? stripped : stripped.replace(/-/g, ' ');
  return toTitleCase(spaced.trim());
}

function makeId(type, group, filename) {
  const base = filename.replace(/\.gpx$/i, '');
  const parts = [type, group, base].filter(Boolean);
  return parts.join('/').replace(/[^a-z0-9/._-]/gi, '-').toLowerCase();
}
function filenameSortKey(gpxPath) {
  const base = gpxPath.split('/').pop().replace(/\.gpx$/i, '');
  const m = base.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : Infinity;
}
function resortIndex(entries, collections) {
  const collectionMap = new Map();
  collections.forEach((c, i) => collectionMap.set(c.folder.toLowerCase(), { order: i }));

  const grouped   = entries.filter(e => e.group);
  const ungrouped = entries.filter(e => !e.group).sort((a, b) => {
    const ta = a.metrics?.startTime || a.addedAt;
    const tb = b.metrics?.startTime || b.addedAt;
    return new Date(tb) - new Date(ta);
  });

  const groupMap = new Map();
  for (const e of grouped) {
    const key = e.group.toLowerCase();
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(e);
  }
  for (const list of groupMap.values()) {
    list.sort((a, b) => filenameSortKey(a.gpxPath) - filenameSortKey(b.gpxPath) || a.name.localeCompare(b.name));
  }

  const sortedGroupKeys = [...groupMap.keys()].sort((a, b) =>
    (collectionMap.get(a)?.order ?? Infinity) - (collectionMap.get(b)?.order ?? Infinity));
  const groupedSorted = sortedGroupKeys.flatMap(k => groupMap.get(k));

  return [...groupedSorted, ...ungrouped];
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
async function fetchRawJson(path, commitSha, fallback) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${commitSha}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return fallback;
    throw new Error(`Failed to fetch ${path} (${res.status})`);
  }
  return res.json();
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
  $('uploadCard').style.display = '';
  await loadCollections();
}
function disconnect() {
  state.token = '';
  state.defaultBranch = null;
  localStorage.removeItem(TOKEN_KEY);
  $('authForm').style.display = '';
  $('authConnected').style.display = 'none';
  $('uploadCard').style.display = 'none';
  $('tokenInput').value = '';
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

async function loadCollections() {
  try {
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    state.collections = await fetchRawJson('data/collections.json', ref.object.sha, []);
  } catch (e) {
    state.collections = [];
  }
  const sel = $('groupSelect');
  sel.innerHTML = '<option value="">— No collection (standalone) —</option>' +
    state.collections.map(c => `<option value="${esc(c.folder)}">${esc(c.name)}</option>`).join('') +
    '<option value="__new__">+ New collection…</option>';
}
$('groupSelect').addEventListener('change', () => {
  $('newGroupFields').style.display = $('groupSelect').value === '__new__' ? '' : 'none';
});

// ── GPX drop / parse ──────────────────────────────────────────────────────────
const gpxDropZone = $('gpxDropZone');
gpxDropZone.addEventListener('click', () => $('gpxFileInput').click());
$('gpxFileInput').addEventListener('change', () => {
  if ($('gpxFileInput').files[0]) handleGpxFile($('gpxFileInput').files[0]);
});
gpxDropZone.addEventListener('dragover', e => { e.preventDefault(); gpxDropZone.classList.add('dragover'); });
gpxDropZone.addEventListener('dragleave', () => gpxDropZone.classList.remove('dragover'));
gpxDropZone.addEventListener('drop', e => {
  e.preventDefault(); gpxDropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleGpxFile(e.dataTransfer.files[0]);
});

function handleGpxFile(file) {
  if (!file.name.toLowerCase().endsWith('.gpx')) { alert('Please choose a .gpx file.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      state.gpxText = e.target.result;
      state.parsed = GPXParser.parse(state.gpxText, file.name);
      state.gpxFile = file;

      const prefixMatch = file.name.toLowerCase().match(/^(bike|hike|kayak|run)[-_]/);
      if (prefixMatch) $('typeSelect').value = prefixMatch[1];
      if (!$('nameInput').value) {
        $('nameInput').value = guessNameFromFilename(state.parsed.name || file.name);
      }

      $('gpxDropLabel').textContent = '✓ ' + file.name;
      const m = state.parsed.metrics;
      $('gpxPreview').innerHTML =
        `<b>${m.distanceKm} km</b> · ↑${m.elevGain}m ↓${m.elevLoss}m · ${m.pointCount.toLocaleString()} points` +
        (m.startTime ? ` · ${new Date(m.startTime).toLocaleDateString()}` : '');
      $('gpxPreview').classList.add('show');
    } catch (err) {
      alert('Could not parse GPX: ' + err.message);
      state.gpxFile = null; state.gpxText = null; state.parsed = null;
    }
  };
  reader.readAsText(file);
}

// ── Photos ────────────────────────────────────────────────────────────────────
$('addPhotosBtn').addEventListener('click', () => $('photoFileInput').click());
$('photoFileInput').addEventListener('change', () => {
  for (const file of $('photoFileInput').files) {
    state.photos.push({ file, url: URL.createObjectURL(file) });
  }
  $('photoFileInput').value = '';
  renderPhotoGrid();
});
function renderPhotoGrid() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  state.photos.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'photo-thumb';
    div.innerHTML = `<img src="${p.url}" alt=""><button type="button" title="Remove">✕</button>`;
    div.querySelector('button').addEventListener('click', () => {
      URL.revokeObjectURL(p.url);
      state.photos.splice(i, 1);
      renderPhotoGrid();
    });
    grid.appendChild(div);
  });
}

// ── Submit ────────────────────────────────────────────────────────────────────
$('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('submitBtn');
  btn.disabled = true; btn.textContent = 'Committing…';
  try {
    await submitRoute();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Commit route';
  }
});

async function submitRoute() {
  clearLog();
  if (!state.token) throw new Error('Connect with a GitHub token first.');
  if (!state.gpxFile || !state.parsed) throw new Error('Choose a GPX file first.');

  const type = $('typeSelect').value;
  const name = $('nameInput').value.trim();
  if (!name) throw new Error('Enter a route name.');

  const groupSel = $('groupSelect').value;
  const description = $('descInput').value.trim();
  const orderRaw = $('orderInput').value.trim();

  let groupFolder = null, groupName = null, newCollectionEntry = null;
  if (groupSel === '__new__') {
    groupFolder = $('newGroupName').value.trim();
    if (!groupFolder) throw new Error('Enter a name for the new collection.');
    groupName = groupFolder;
    newCollectionEntry = { folder: groupFolder, name: groupName, description: $('newGroupDesc').value.trim() };
  } else if (groupSel) {
    groupFolder = groupSel;
    const existing = state.collections.find(c => c.folder === groupSel);
    groupName = existing ? existing.name : groupSel;
  }

  logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
  const latestCommitSha = ref.object.sha;
  logLine('✓ HEAD is ' + latestCommitSha.slice(0, 7));

  logLine('Fetching current index.json and collections.json…');
  const [indexEntries, collections] = await Promise.all([
    fetchRawJson('data/index.json', latestCommitSha, []),
    fetchRawJson('data/collections.json', latestCommitSha, []),
  ]);
  logLine(`✓ ${indexEntries.length} existing route(s) loaded`);

  const order = orderRaw ? String(parseInt(orderRaw, 10)).padStart(3, '0') : null;
  const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim();
  const filename = (order ? `${order}-${safeName}` : safeName) + '.gpx';
  const folderSeg = groupFolder || 'ungrouped';
  const gpxPath = `data/gpx/${type}/${folderSeg}/${filename}`;
  const id = makeId(type, groupFolder, filename);

  if (indexEntries.some(en => en.id === id)) {
    throw new Error(`A route with id "${id}" already exists — change the name or stage number.`);
  }

  const metrics = state.parsed.metrics;

  const filesToCommit = [{ path: gpxPath, content: state.gpxText, encoding: 'utf-8' }];

  const photoPaths = [];
  if (state.photos.length) {
    logLine(`Encoding ${state.photos.length} photo(s)…`);
    for (let i = 0; i < state.photos.length; i++) {
      const p = state.photos[i];
      const b64 = await fileToBase64(p.file);
      const safePhotoName = p.file.name.replace(/[\\/:*?"<>|]/g, '').trim();
      const photoPath = `data/images/${id}/${String(i + 1).padStart(2, '0')}-${safePhotoName}`;
      filesToCommit.push({ path: photoPath, content: b64, encoding: 'base64' });
      photoPaths.push(photoPath);
    }
    logLine('✓ Photos encoded');
  }

  let updatedCollections = collections;
  if (newCollectionEntry) updatedCollections = [...collections, newCollectionEntry];

  const newEntry = {
    id, name, type,
    group: groupFolder || null,
    groupName: groupName || null,
    description: description || null,
    gpxPath,
    photos: photoPaths,
    addedAt: new Date().toISOString(),
    metrics,
  };
  const mergedEntries = [...indexEntries.filter(en => en.id !== id), newEntry];
  const sortedEntries = resortIndex(mergedEntries, updatedCollections);

  filesToCommit.push({ path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' });
  if (newCollectionEntry) {
    filesToCommit.push({ path: 'data/collections.json', content: JSON.stringify(updatedCollections, null, 2), encoding: 'utf-8' });
  }

  logLine(`Uploading ${filesToCommit.length} file(s)…`);
  const baseCommit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${latestCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const treeEntries = [];
  for (const f of filesToCommit) {
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: { content: f.content, encoding: f.encoding } });
    treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  logLine('✓ Blobs created');

  const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, { method: 'POST', body: { base_tree: baseTreeSha, tree: treeEntries } });
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: { message: `Add route: ${name}`, tree: tree.sha, parents: [latestCommitSha] },
  });
  logLine('✓ Commit created: ' + commit.sha.slice(0, 7));

  try {
    await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } catch (e) {
    throw new Error('Someone else pushed to the repo while this was running — the commit was created but not pushed. Retry.');
  }
  logLine('✓ Pushed to ' + esc(state.defaultBranch));
  logLine(`<b>Done.</b> Live in ~60s at <a href="route.html?id=${encodeURIComponent(id)}" target="_blank">route.html?id=${esc(id)}</a>`, false, true);

  resetForm();
}

function resetForm() {
  $('uploadForm').reset();
  $('gpxDropLabel').innerHTML = '📂 Drop a .gpx file here or <u>browse</u>';
  $('gpxPreview').classList.remove('show');
  $('newGroupFields').style.display = 'none';
  state.gpxFile = null; state.gpxText = null; state.parsed = null;
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = [];
  renderPhotoGrid();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  if (state.token) {
    try { await connect(state.token); }
    catch (e) { disconnect(); }
  }
})();
