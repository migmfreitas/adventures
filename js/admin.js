/**
 * Admin portal — commits GPX routes (+ description, + photos) straight to
 * GitHub using a personal access token supplied by the operator, stored only
 * in this browser's localStorage. Supports adding, editing, and deleting
 * routes.
 *
 * Mirrors the folder/id/sort conventions in .github/scripts/build-index.js
 * so the entry this page writes is indistinguishable from one the Action
 * would have produced. Commit messages are prefixed "Add route:" / "Edit
 * route:" / "Delete route:" — the Action's update-index.yml only reacts to
 * pushes that touch data/gpx/**.gpx, and always skips rebuilding when the
 * commit message starts with "Add route:" since this page already wrote the
 * up-to-date index; edits/deletes still trigger the Action (their gpx paths
 * change), but the rebuild is a no-op because the index already matches.
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
  photos: [],          // new photos to add: { file, url }
  editingEntry: null,  // the index.json entry currently being edited, or null
  keptPhotos: [],       // existing photo paths kept while editing
  removedPhotos: [],    // existing photo paths marked for removal while editing
  routesIndex: null,   // cached data/index.json, loaded lazily for the browser
  treeCache: null,      // { commitSha, map: Map<path, blobSha> }
};

// ── Small helpers ────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function $(id) { return document.getElementById(id); }

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
function orderFromGpxPath(gpxPath) {
  const base = gpxPath.split('/').pop().replace(/\.gpx$/i, '');
  const m = base.match(/^(\d+)-/);
  return m ? String(parseInt(m[1], 10)) : '';
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
async function fetchRawJson(path, ref, fallback) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${ref}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return fallback;
    throw new Error(`Failed to fetch ${path} (${res.status})`);
  }
  return res.json();
}
/** path → blob sha, for the full tree at a commit. Used to move/copy files
 *  without re-downloading and re-uploading their bytes. */
async function getTreeMap(commitSha) {
  if (state.treeCache && state.treeCache.commitSha === commitSha) return state.treeCache.map;
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${commitSha}`);
  const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) logLine('⚠ Repo tree listing was truncated by the GitHub API — a moved file may be missed.', true);
  const map = new Map(tree.tree.filter(t => t.type === 'blob').map(t => [t.path, t.sha]));
  state.treeCache = { commitSha, map };
  return map;
}

/**
 * Builds one commit from a set of additions/moves and deletions, and pushes
 * it to the branch. `adds` entries are either { path, content, encoding }
 * (new blob) or { path, sha } (reuse an existing blob at a new path — used
 * for moving/renaming without re-uploading bytes). `deletes` is a plain
 * array of paths to remove.
 */
async function writeCommit({ message, latestCommitSha, adds, deletes }) {
  const baseCommit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${latestCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const treeEntries = deletes.map(path => ({ path, mode: '100644', type: 'blob', sha: null }));
  for (const f of adds) {
    let sha = f.sha;
    if (!sha) {
      const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: { content: f.content, encoding: f.encoding } });
      sha = blob.sha;
    }
    treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  logLine(`✓ ${treeEntries.length} file change(s) prepared`);

  const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, { method: 'POST', body: { base_tree: baseTreeSha, tree: treeEntries } });
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
  return commit.sha;
}

async function encodeNewPhotos(photos, id) {
  const adds = [];
  const paths = [];
  if (!photos.length) return { adds, paths };
  logLine(`Encoding ${photos.length} photo(s)…`);
  const ts = Date.now();
  for (let i = 0; i < photos.length; i++) {
    const b64 = await fileToBase64(photos[i].file);
    const safeName = photos[i].file.name.replace(/[\\/:*?"<>|]/g, '').trim();
    const path = `data/images/${id}/${ts}-${i + 1}-${safeName}`;
    adds.push({ path, content: b64, encoding: 'base64' });
    paths.push(path);
  }
  logLine('✓ Photos encoded');
  return { adds, paths };
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
  $('routesCard').style.display = '';
  await loadCollections();
}
function disconnect() {
  state.token = '';
  state.defaultBranch = null;
  localStorage.removeItem(TOKEN_KEY);
  $('authForm').style.display = '';
  $('authConnected').style.display = 'none';
  $('uploadCard').style.display = 'none';
  $('routesCard').style.display = 'none';
  $('tokenInput').value = '';
  state.routesIndex = null;
  state.treeCache = null;
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
  populateGroupSelect();
}
function populateGroupSelect(selected) {
  const sel = $('groupSelect');
  const known = new Set(state.collections.map(c => c.folder));
  let extra = '';
  if (selected && !known.has(selected)) extra = `<option value="${esc(selected)}">${esc(selected)} (not in collections.json)</option>`;
  sel.innerHTML = '<option value="">— No collection (standalone) —</option>' +
    state.collections.map(c => `<option value="${esc(c.folder)}">${esc(c.name)}</option>`).join('') +
    extra +
    '<option value="__new__">+ New collection…</option>';
  if (selected) sel.value = selected;
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

      if (!state.editingEntry) {
        const prefixMatch = file.name.toLowerCase().match(/^(bike|hike|kayak|run)[-_]/);
        if (prefixMatch) $('typeSelect').value = prefixMatch[1];
        if (!$('nameInput').value) $('nameInput').value = guessNameFromFilename(state.parsed.name || file.name);
      }

      $('gpxDropLabel').textContent = '✓ ' + file.name + (state.editingEntry ? ' (replaces current track)' : '');
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

// ── Photos (new) ──────────────────────────────────────────────────────────────
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
  $('newPhotoLabel').style.display = state.photos.length ? '' : 'none';
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
// ── Photos (existing, edit mode) ─────────────────────────────────────────────
function renderExistingPhotoGrid() {
  const grid = $('existingPhotoGrid');
  grid.innerHTML = '';
  $('existingPhotoLabel').style.display = state.keptPhotos.length ? '' : 'none';
  state.keptPhotos.forEach(path => {
    const div = document.createElement('div');
    div.className = 'photo-thumb';
    div.innerHTML = `<img src="${esc(path)}" alt=""><button type="button" title="Remove">✕</button>`;
    div.querySelector('button').addEventListener('click', () => {
      state.keptPhotos = state.keptPhotos.filter(p => p !== path);
      state.removedPhotos.push(path);
      renderExistingPhotoGrid();
    });
    grid.appendChild(div);
  });
}

// ── Submit (add or edit) ──────────────────────────────────────────────────────
$('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('submitBtn');
  const editing = !!state.editingEntry;
  btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Committing…';
  try {
    if (editing) await updateRoute();
    else await createRoute();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Commit route';
  }
});

function readFormFields() {
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

  const order = orderRaw ? String(parseInt(orderRaw, 10)).padStart(3, '0') : null;
  const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim();
  const filename = (order ? `${order}-${safeName}` : safeName) + '.gpx';
  const folderSeg = groupFolder || 'ungrouped';

  return { type, name, description, groupFolder, groupName, newCollectionEntry, filename, folderSeg };
}

async function createRoute() {
  clearLog();
  if (!state.token) throw new Error('Connect with a GitHub token first.');
  if (!state.gpxFile || !state.parsed) throw new Error('Choose a GPX file first.');

  const { type, name, description, groupFolder, groupName, newCollectionEntry, filename, folderSeg } = readFormFields();
  const gpxPath = `data/gpx/${type}/${folderSeg}/${filename}`;
  const id = makeId(type, groupFolder, filename);

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

  if (indexEntries.some(en => en.id === id)) {
    throw new Error(`A route with id "${id}" already exists — change the name or stage number.`);
  }

  const metrics = state.parsed.metrics;
  const adds = [{ path: gpxPath, content: state.gpxText, encoding: 'utf-8' }];

  const { adds: photoAdds, paths: photoPaths } = await encodeNewPhotos(state.photos, id);
  adds.push(...photoAdds);

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
  const sortedEntries = resortIndex([...indexEntries, newEntry], updatedCollections);

  adds.push({ path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' });
  if (newCollectionEntry) {
    adds.push({ path: 'data/collections.json', content: JSON.stringify(updatedCollections, null, 2), encoding: 'utf-8' });
  }

  logLine(`Uploading ${adds.length} file(s)…`);
  await writeCommit({ message: `Add route: ${name}`, latestCommitSha, adds, deletes: [] });

  logLine(`<b>Done.</b> Live in ~60s at <a href="route.html?id=${encodeURIComponent(id)}" target="_blank">route.html?id=${esc(id)}</a>`, false, true);
  state.routesIndex = null;
  resetForm();
}

async function updateRoute() {
  clearLog();
  const orig = state.editingEntry;
  if (!orig) throw new Error('No route selected to edit.');
  if (!state.token) throw new Error('Connect with a GitHub token first.');

  const { type, name, description, groupFolder, groupName, newCollectionEntry, filename, folderSeg } = readFormFields();
  const newGpxPath = `data/gpx/${type}/${folderSeg}/${filename}`;
  const newId = makeId(type, groupFolder, filename);

  logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
  const latestCommitSha = ref.object.sha;
  logLine('✓ HEAD is ' + latestCommitSha.slice(0, 7));

  const [indexEntries, collections] = await Promise.all([
    fetchRawJson('data/index.json', latestCommitSha, []),
    fetchRawJson('data/collections.json', latestCommitSha, []),
  ]);
  const current = indexEntries.find(en => en.id === orig.id);
  if (!current) throw new Error('This route no longer exists in the index — someone may have deleted it. Reload the route list.');

  if (newId !== orig.id && indexEntries.some(en => en.id === newId)) {
    throw new Error(`A route with id "${newId}" already exists — change the name or stage number.`);
  }

  const adds = [];
  const deletes = [];
  const usingNewGpx = !!(state.gpxFile && state.gpxText && state.parsed);
  const pathChanged = newGpxPath !== current.gpxPath;

  let metrics = current.metrics;
  if (usingNewGpx) {
    metrics = state.parsed.metrics;
    adds.push({ path: newGpxPath, content: state.gpxText, encoding: 'utf-8' });
    if (pathChanged) deletes.push(current.gpxPath);
    logLine('✓ Track replaced');
  } else if (pathChanged) {
    logLine('Moving GPX file (type/collection/name changed)…');
    const treeMap = await getTreeMap(latestCommitSha);
    const oldSha = treeMap.get(current.gpxPath);
    if (!oldSha) throw new Error(`Could not find the current GPX file at ${current.gpxPath} in the repo.`);
    adds.push({ path: newGpxPath, sha: oldSha });
    deletes.push(current.gpxPath);
  }

  // Photos: move kept ones only if the route id changed (their path is keyed by id)
  let finalPhotoPaths = [...state.keptPhotos];
  if (newId !== orig.id && state.keptPhotos.length) {
    logLine('Moving photos to new path…');
    const treeMap = await getTreeMap(latestCommitSha);
    finalPhotoPaths = [];
    for (const p of state.keptPhotos) {
      const sha = treeMap.get(p);
      if (!sha) { logLine('⚠ Could not find ' + esc(p) + ' — skipping', true); continue; }
      const newPath = p.replace(`data/images/${orig.id}/`, `data/images/${newId}/`);
      adds.push({ path: newPath, sha });
      deletes.push(p);
      finalPhotoPaths.push(newPath);
    }
  }
  for (const p of state.removedPhotos) deletes.push(p);

  const { adds: photoAdds, paths: newPhotoPaths } = await encodeNewPhotos(state.photos, newId);
  adds.push(...photoAdds);
  finalPhotoPaths.push(...newPhotoPaths);

  let updatedCollections = collections;
  if (newCollectionEntry) updatedCollections = [...collections, newCollectionEntry];

  const updatedEntry = {
    id: newId, name, type,
    group: groupFolder || null,
    groupName: groupName || null,
    description: description || null,
    gpxPath: newGpxPath,
    photos: finalPhotoPaths,
    addedAt: current.addedAt,
    metrics,
  };
  const mergedEntries = [...indexEntries.filter(en => en.id !== orig.id), updatedEntry];
  const sortedEntries = resortIndex(mergedEntries, updatedCollections);

  adds.push({ path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' });
  if (newCollectionEntry) {
    adds.push({ path: 'data/collections.json', content: JSON.stringify(updatedCollections, null, 2), encoding: 'utf-8' });
  }

  logLine(`Uploading ${adds.length} change(s)…`);
  await writeCommit({ message: `Edit route: ${name}`, latestCommitSha, adds, deletes });

  logLine(`<b>Saved.</b> Live in ~60s at <a href="route.html?id=${encodeURIComponent(newId)}" target="_blank">route.html?id=${esc(newId)}</a>`, false, true);
  state.routesIndex = null;
  exitEditMode();
}

async function deleteRouteFlow(entry) {
  const photoNote = entry.photos?.length ? ` and ${entry.photos.length} photo(s)` : '';
  if (!confirm(`Delete "${entry.name}"?\n\nThis removes its GPX file${photoNote} and its entry from the map. This cannot be undone from here.`)) return;

  clearLog();
  const btn = $('deleteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const latestCommitSha = ref.object.sha;

    const [indexEntries, collections] = await Promise.all([
      fetchRawJson('data/index.json', latestCommitSha, []),
      fetchRawJson('data/collections.json', latestCommitSha, []),
    ]);
    const current = indexEntries.find(en => en.id === entry.id);
    if (!current) throw new Error('Route not found — it may already be deleted. Reload the list.');

    const deletes = [current.gpxPath, ...(current.photos || [])];
    const remaining = indexEntries.filter(en => en.id !== entry.id);
    const sorted = resortIndex(remaining, collections);
    const adds = [{ path: 'data/index.json', content: JSON.stringify(sorted, null, 2), encoding: 'utf-8' }];

    await writeCommit({ message: `Delete route: ${entry.name}`, latestCommitSha, adds, deletes });
    logLine(`<b>Deleted "${esc(entry.name)}".</b>`, false, true);

    state.routesIndex = null;
    if (state.editingEntry && state.editingEntry.id === entry.id) exitEditMode();
    renderRoutesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Delete route'; }
  }
}
$('deleteBtn').addEventListener('click', () => {
  if (state.editingEntry) deleteRouteFlow(state.editingEntry);
});

// ── Edit mode ─────────────────────────────────────────────────────────────────
function enterEditMode(entry) {
  state.editingEntry = entry;
  state.keptPhotos = [...(entry.photos || [])];
  state.removedPhotos = [];
  state.gpxFile = null; state.gpxText = null; state.parsed = null;
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = [];

  $('uploadCardTitle').textContent = 'Edit route';
  $('uploadCardSub').textContent = 'Change any field and save — only what changed is committed. Drop a new GPX only if you want to replace the track.';
  $('editBanner').style.display = '';
  $('editBannerName').textContent = entry.name;
  $('submitBtn').textContent = 'Save changes';
  $('deleteBtn').style.display = '';

  $('gpxDropLabel').innerHTML = `📂 Current: <code>${esc(entry.gpxPath.split('/').pop())}</code> — drop a file to replace it`;
  $('gpxPreview').classList.remove('show');

  $('typeSelect').value = entry.type;
  $('nameInput').value = entry.name;
  $('orderInput').value = orderFromGpxPath(entry.gpxPath);
  $('descInput').value = entry.description || '';
  populateGroupSelect(entry.group || '');
  $('newGroupFields').style.display = 'none';

  renderExistingPhotoGrid();
  renderPhotoGrid();

  $('uploadCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function exitEditMode() {
  state.editingEntry = null;
  state.keptPhotos = [];
  state.removedPhotos = [];

  $('uploadCardTitle').textContent = 'Add a route';
  $('uploadCardSub').textContent = "Drop a GPX file, fill in the details, and it's committed straight to the repo. The live map picks it up in about a minute.";
  $('editBanner').style.display = 'none';
  $('submitBtn').textContent = 'Commit route';
  $('deleteBtn').style.display = 'none';

  resetForm();
}
$('cancelEditBtn').addEventListener('click', exitEditMode);

function resetForm() {
  $('uploadForm').reset();
  $('gpxDropLabel').innerHTML = '📂 Drop a .gpx file here or <u>browse</u>';
  $('gpxPreview').classList.remove('show');
  $('newGroupFields').style.display = 'none';
  state.gpxFile = null; state.gpxText = null; state.parsed = null;
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = [];
  state.keptPhotos = []; state.removedPhotos = [];
  renderPhotoGrid();
  renderExistingPhotoGrid();
  populateGroupSelect();
}

// ── Existing routes browser ───────────────────────────────────────────────────
const ACTIVITY_EMOJI = { bike:'🚴', hike:'🥾', kayak:'🛶', run:'🏃', other:'✦' };

$('loadRoutesBtn').addEventListener('click', async () => {
  const btn = $('loadRoutesBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    state.routesIndex = await fetchRawJson('data/index.json', state.defaultBranch, []);
    renderRoutesList();
  } catch (e) {
    $('routesList').innerHTML = `<div class="routes-empty">Could not load routes: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Load';
  }
});
$('routesSearch').addEventListener('input', renderRoutesList);

function renderRoutesList() {
  const list = $('routesList');
  if (!state.routesIndex) {
    list.innerHTML = '<div class="routes-empty">Click Load to fetch the current route list.</div>';
    return;
  }
  const q = $('routesSearch').value.trim().toLowerCase();
  const rows = state.routesIndex
    .filter(r => !q || r.name.toLowerCase().includes(q) || (r.groupName || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

  if (rows.length === 0) {
    list.innerHTML = '<div class="routes-empty">No routes match.</div>';
    return;
  }

  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'route-row';
    const km = r.metrics?.distanceKm ?? '?';
    row.innerHTML = `
      <span class="route-row-emoji">${ACTIVITY_EMOJI[r.type] || '✦'}</span>
      <div class="route-row-info">
        <div class="route-row-name">${esc(r.name)}</div>
        <div class="route-row-meta">${km} km${r.groupName ? ' · ' + esc(r.groupName) : ''}</div>
      </div>
      <div class="route-row-actions">
        <button type="button" class="btn btn-small" data-act="edit">Edit</button>
        <button type="button" class="btn btn-small btn-danger" data-act="delete">Delete</button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').addEventListener('click', () => enterEditMode(r));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteRouteFlow(r));
    list.appendChild(row);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  if (state.token) {
    try { await connect(state.token); }
    catch (e) { disconnect(); }
  }
})();
