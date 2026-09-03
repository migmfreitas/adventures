/**
 * Admin portal — commits GPX routes (+ description, + photos) straight to
 * GitHub using a personal access token supplied by the operator, stored only
 * in this browser's localStorage. Supports adding, editing, deleting, and
 * reordering routes and collections (order lives in each index.json entry's
 * `order` field and in collections.json's array order — see resortIndex).
 *
 * Mirrors the folder/id/sort conventions in .github/scripts/build-index.js
 * so the entry this page writes is indistinguishable from one the Action
 * would have produced. Commit messages are prefixed "Add route:" / "Edit
 * route:" / "Delete route:" — the Action's update-index.yml only reacts to
 * pushes that touch data/gpx/**.gpx, and always skips rebuilding when the
 * commit message starts with "Add route:" since this page already wrote the
 * up-to-date index; edits/deletes still trigger the Action (their gpx paths
 * change), but the rebuild is a no-op because the index already matches.
 *
 * admin.html loads this file (and gpx-parser.js) with a `?v=N` cache-busting
 * query string — bump it whenever either file changes, or returning visitors
 * can keep running a stale cached copy indefinitely and silently miss new
 * features (this bit us once: admin.html had no versioning at all through
 * several rounds of add/edit/delete/reorder work).
 */

const OWNER = 'migmfreitas';
const REPO  = 'adventures';
const TOKEN_KEY = 'adventureLogAdminToken';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  defaultBranch: null,
  collections: [],
  gear: [],            // bikes loaded from data/gear.json, for the per-route "Bike" select
  gpxFile: null,
  gpxText: null,
  parsed: null,
  photos: [],          // new photos to add: { file, url }
  editingEntry: null,  // the index.json entry currently being edited, or null
  keptPhotos: [],       // existing photo paths kept while editing
  removedPhotos: [],    // existing photo paths marked for removal while editing
  routesIndex: null,   // cached data/index.json, loaded lazily for the browser
  treeCache: null,      // { commitSha, map: Map<path, blobSha> }
  reordering: false,    // true while a reorder commit is in flight (disables the arrows)
  editingCollectionFolder: null, // folder of the collection whose name/description form is open, or null
  bulkFiles: [],        // { file, text, parsed, name, type, error } — staged for the bulk-upload commit
  bulkCommitting: false, // true while a bulk commit is in flight (disables the commit button)
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
/**
 * Sorts entries into their final index.json order and renumbers each
 * group's `order` field densely (0..n-1). Ties (equal/missing `order`,
 * e.g. an entry newly dropped into a group) fall back to filename prefix
 * then name, so brand-new routes land somewhere sane before being
 * explicitly repositioned via the reorder arrows or the position field.
 */
// Normalizes before lowercasing so visually-identical folder/group names
// that differ in Unicode form (e.g. precomposed vs. combining-mark accents
// — easy to end up with when a name is typed in one tool and pasted from
// another) still match up as the same collection.
function collectionKey(str) { return str.normalize('NFC').toLowerCase(); }

function resortIndex(entries, collections) {
  const collectionMap = new Map();
  collections.forEach((c, i) => collectionMap.set(collectionKey(c.folder), { order: i }));

  const grouped   = entries.filter(e => e.group);
  const ungrouped = entries.filter(e => !e.group).sort((a, b) => {
    const ta = a.metrics?.startTime || a.addedAt;
    const tb = b.metrics?.startTime || b.addedAt;
    return new Date(tb) - new Date(ta);
  });

  const groupMap = new Map();
  for (const e of grouped) {
    const key = collectionKey(e.group);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(e);
  }
  for (const list of groupMap.values()) {
    list.sort((a, b) =>
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      filenameSortKey(a.gpxPath) - filenameSortKey(b.gpxPath) ||
      a.name.localeCompare(b.name));
    list.forEach((e, i) => { e.order = i; });
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
  $('bulkCard').style.display = '';
  $('routesCard').style.display = '';
  $('collectionsCard').style.display = '';
  await loadCollections();
  await loadGear();
  $('loadRoutesBtn').click();
}
function disconnect() {
  state.token = '';
  state.defaultBranch = null;
  localStorage.removeItem(TOKEN_KEY);
  $('authForm').style.display = '';
  $('authConnected').style.display = 'none';
  $('uploadCard').style.display = 'none';
  $('bulkCard').style.display = 'none';
  $('routesCard').style.display = 'none';
  $('collectionsCard').style.display = 'none';
  $('tokenInput').value = '';
  state.routesIndex = null;
  state.treeCache = null;
  state.editingCollectionFolder = null;
  state.bulkFiles = [];
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

/**
 * Folders under data/gpx/ can pick up routes without ever going through the
 * admin portal's "add route" form (a direct commit, or a bulk-add without a
 * new-collection entry) — the only place that writes collections.json. When
 * that happens, build-index.js still groups those routes fine (it derives
 * groupName from the folder name), but collections.json never learns about
 * the folder — so without this, the collection is invisible here even
 * though its routes appear correctly under "Existing routes" and on the
 * live map. Synthesize a placeholder entry for any such orphan group so it
 * always shows up and can be adopted into collections.json via Edit → Save.
 */
function mergeOrphanCollections(collections, indexEntries) {
  const known = new Set(collections.map(c => collectionKey(c.folder)));
  const orphans = new Map();
  for (const e of indexEntries) {
    if (!e.group) continue;
    const key = collectionKey(e.group);
    if (known.has(key) || orphans.has(key)) continue;
    orphans.set(key, { folder: e.group, name: e.groupName || e.group, description: '', orphan: true });
  }
  return [...collections, ...orphans.values()];
}

async function loadCollections() {
  try {
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const [collections, indexEntries] = await Promise.all([
      fetchRawJson('data/collections.json', ref.object.sha, []),
      fetchRawJson('data/index.json', ref.object.sha, []),
    ]);
    state.collections = mergeOrphanCollections(collections, indexEntries);
  } catch (e) {
    state.collections = [];
  }
  populateGroupSelect('groupSelect');
  populateGroupSelect('bulkGroupSelect');
  renderCollectionsList();
}
function populateGroupSelect(selectId, selected) {
  const sel = $(selectId);
  const known = new Set(state.collections.map(c => c.folder));
  let extra = '';
  if (selected && !known.has(selected)) extra = `<option value="${esc(selected)}">${esc(selected)} (not in collections.json)</option>`;
  sel.innerHTML = '<option value="">— No collection (standalone) —</option>' +
    state.collections.map(c => `<option value="${esc(c.folder)}">${esc(c.name)}</option>`).join('') +
    extra +
    '<option value="__new__">+ New collection…</option>';
  if (selected) sel.value = selected;
}
async function loadGear() {
  try {
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    state.gear = await fetchRawJson('data/gear.json', ref.object.sha, []);
  } catch (e) {
    state.gear = [];
  }
  populateGearSelect('gearSelect');
  populateGearSelect('bulkGearSelect');
}
function populateGearSelect(selectId, selected) {
  const sel = $(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— No bike —</option>' +
    state.gear.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  if (selected) sel.value = selected;
}

$('groupSelect').addEventListener('change', () => {
  $('newGroupFields').style.display = $('groupSelect').value === '__new__' ? '' : 'none';
});
$('bulkGroupSelect').addEventListener('change', () => {
  $('bulkNewGroupFields').style.display = $('bulkGroupSelect').value === '__new__' ? '' : 'none';
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
  const gearId = $('gearSelect').value || null;

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

  // 1-based position typed in the form's position field → a sort key that lands the
  // entry just before whatever currently holds that (0-based) slot; blank
  // means "append at the end". resortIndex renumbers everything densely
  // afterward, so this only has to land in roughly the right place.
  const orderSortKey = orderRaw ? Math.max(0, parseInt(orderRaw, 10) - 1) - 0.5 : Infinity;

  const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim();
  const folderSeg = groupFolder || 'ungrouped';

  return { type, name, description, groupFolder, groupName, newCollectionEntry, orderSortKey, safeName, folderSeg, gearId };
}

async function createRoute() {
  clearLog();
  if (!state.token) throw new Error('Connect with a GitHub token first.');
  if (!state.gpxFile || !state.parsed) throw new Error('Choose a GPX file first.');

  const { type, name, description, groupFolder, groupName, newCollectionEntry, orderSortKey, safeName, folderSeg, gearId } = readFormFields();
  const filename = safeName + '.gpx';
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
    throw new Error(`A route with id "${id}" already exists — change the name.`);
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
    gearId,
    ...(groupFolder ? { order: orderSortKey } : {}),
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
  if (newCollectionEntry) {
    state.collections = updatedCollections;
    populateGroupSelect('bulkGroupSelect');
    renderCollectionsList();
  }
  resetForm();
}

async function updateRoute() {
  clearLog();
  const orig = state.editingEntry;
  if (!orig) throw new Error('No route selected to edit.');
  if (!state.token) throw new Error('Connect with a GitHub token first.');

  const { type, name, description, groupFolder, groupName, newCollectionEntry, orderSortKey, safeName, folderSeg, gearId } = readFormFields();

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

  // Order lives in index.json now, decoupled from the filename — so a pure
  // reorder (or any other metadata-only edit) must not rename the GPX file
  // or change the route's id. Only regenerate the filename when something
  // that actually determines the path changed.
  const identityChanged = type !== current.type || (groupFolder || null) !== (current.group || null) || name !== current.name;
  const filename = identityChanged ? safeName + '.gpx' : current.gpxPath.split('/').pop();
  const newGpxPath = `data/gpx/${type}/${folderSeg}/${filename}`;
  const newId = makeId(type, groupFolder, filename);

  if (newId !== orig.id && indexEntries.some(en => en.id === newId)) {
    throw new Error(`A route with id "${newId}" already exists — change the name.`);
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
    gearId,
    ...(groupFolder ? { order: orderSortKey } : {}),
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
  if (newCollectionEntry) {
    state.collections = updatedCollections;
    populateGroupSelect('bulkGroupSelect');
    renderCollectionsList();
  }
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
  $('orderInput').value = typeof entry.order === 'number' ? entry.order + 1 : '';
  $('descInput').value = entry.description || '';
  populateGroupSelect('groupSelect', entry.group || '');
  $('newGroupFields').style.display = 'none';
  populateGearSelect('gearSelect', entry.gearId || '');

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
  populateGroupSelect('groupSelect');
  populateGearSelect('gearSelect');
}

// ── Collections browser (reorder) ───────────────────────────────────────────
function renderCollectionsList() {
  const list = $('collectionsList');
  if (!state.collections.length) {
    list.innerHTML = '<div class="routes-empty">No collections yet — add one from the form above.</div>';
    return;
  }
  list.style.opacity = state.reordering ? '.5' : '';
  list.style.pointerEvents = state.reordering ? 'none' : '';
  list.innerHTML = '';
  state.collections.forEach((c, i) => {
    if (state.editingCollectionFolder === c.folder) {
      list.appendChild(makeCollectionEditForm(c));
      return;
    }
    const count = state.routesIndex ? state.routesIndex.filter(r => r.group === c.folder).length : null;
    const canUp = !c.orphan && i > 0, canDown = !c.orphan && i < state.collections.length - 1;
    const meta = c.orphan
      ? '⚠ not in collections.json yet — click Edit to add it'
      : (count !== null ? count + ' route' + (count === 1 ? '' : 's') : esc(c.folder));
    const row = document.createElement('div');
    row.className = 'collection-row';
    row.innerHTML = `
      <div class="reorder-col">
        <button type="button" class="btn reorder-btn" data-act="up" ${canUp ? '' : 'disabled'} title="Move up">↑</button>
        <button type="button" class="btn reorder-btn" data-act="down" ${canDown ? '' : 'disabled'} title="Move down">↓</button>
      </div>
      <div class="collection-row-info">
        <div class="collection-row-name">${esc(c.name)}</div>
        <div class="collection-row-meta">${meta}</div>
      </div>
      <div class="collection-row-actions">
        <button type="button" class="btn btn-small" data-act="edit">Edit</button>
      </div>
    `;
    if (canUp) row.querySelector('[data-act="up"]').addEventListener('click', () => moveCollectionOrder(c.folder, -1));
    if (canDown) row.querySelector('[data-act="down"]').addEventListener('click', () => moveCollectionOrder(c.folder, 1));
    row.querySelector('[data-act="edit"]').addEventListener('click', () => {
      state.editingCollectionFolder = c.folder;
      renderCollectionsList();
    });
    list.appendChild(row);
  });
}

function makeCollectionEditForm(c) {
  const wrap = document.createElement('div');
  wrap.className = 'collection-edit-form';
  wrap.innerHTML = `
    <div class="field">
      <label>Name</label>
      <input type="text" class="ce-name" value="${esc(c.name)}" />
    </div>
    <div class="field">
      <label>Description</label>
      <textarea class="ce-desc">${esc(c.description || '')}</textarea>
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-accent btn-block" data-act="save">Save</button>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
    </div>
  `;
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    state.editingCollectionFolder = null;
    renderCollectionsList();
  });
  wrap.querySelector('[data-act="save"]').addEventListener('click', () => {
    const name = wrap.querySelector('.ce-name').value.trim();
    const description = wrap.querySelector('.ce-desc').value.trim();
    if (!name) { alert('Enter a collection name.'); return; }
    saveCollectionEdit(c.folder, name, description);
  });
  return wrap;
}

async function saveCollectionEdit(folder, name, description) {
  if (state.reordering) return;
  state.reordering = true;
  renderCollectionsList();
  clearLog();
  try {
    logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const latestCommitSha = ref.object.sha;

    const [indexEntries, collections] = await Promise.all([
      fetchRawJson('data/index.json', latestCommitSha, []),
      fetchRawJson('data/collections.json', latestCommitSha, []),
    ]);
    const idx = collections.findIndex(c => c.folder === folder);
    const updatedCollections = [...collections];
    if (idx === -1) {
      // Orphan collection (routes exist under this folder in index.json but
      // it was never written to collections.json) — adopt it now.
      updatedCollections.push({ folder, name, description });
    } else {
      updatedCollections[idx] = { ...updatedCollections[idx], name, description };
    }

    // groupName is denormalized onto every entry in index.json (so route.html
    // and the map don't need to cross-reference collections.json), so a
    // rename has to be propagated to every entry in this collection too.
    const key = collectionKey(folder);
    const updatedEntries = indexEntries.map(e =>
      e.group && collectionKey(e.group) === key ? { ...e, groupName: name } : e);

    const sortedEntries = resortIndex(updatedEntries, updatedCollections);
    logLine('Uploading updated collection…');
    await writeCommit({
      message: `Update collection: ${name}`,
      latestCommitSha,
      adds: [
        { path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' },
        { path: 'data/collections.json', content: JSON.stringify(updatedCollections, null, 2), encoding: 'utf-8' },
      ],
      deletes: [],
    });

    state.collections = updatedCollections;
    state.routesIndex = sortedEntries;
    state.editingCollectionFolder = null;
    populateGroupSelect('groupSelect', $('groupSelect').value);
    populateGroupSelect('bulkGroupSelect', $('bulkGroupSelect').value);
    logLine('<b>Saved.</b>', false, true);
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    state.reordering = false;
    renderCollectionsList();
    renderRoutesList();
  }
}

async function moveCollectionOrder(folder, direction) {
  if (state.reordering) return;
  state.reordering = true;
  renderCollectionsList();
  renderRoutesList();
  clearLog();
  try {
    logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const latestCommitSha = ref.object.sha;

    const [indexEntries, collections] = await Promise.all([
      fetchRawJson('data/index.json', latestCommitSha, []),
      fetchRawJson('data/collections.json', latestCommitSha, []),
    ]);
    const idx = collections.findIndex(c => c.folder === folder);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= collections.length) {
      logLine('Nothing to do — reload and try again.');
      return;
    }
    const reordered = [...collections];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];

    const sortedEntries = resortIndex(indexEntries, reordered);
    logLine(`Uploading reordered collections…`);
    await writeCommit({
      message: `Reorder collection: ${reordered[idx].name || folder}`,
      latestCommitSha,
      adds: [
        { path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' },
        { path: 'data/collections.json', content: JSON.stringify(reordered, null, 2), encoding: 'utf-8' },
      ],
      deletes: [],
    });

    state.collections = reordered;
    state.routesIndex = sortedEntries;
    logLine('<b>Reordered.</b>', false, true);
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    state.reordering = false;
    renderCollectionsList();
    renderRoutesList();
  }
}

// ── Bulk upload ───────────────────────────────────────────────────────────────
// Stages several GPX files client-side (parsed, named, typed), then writes
// them all — plus one shared updated index.json/collections.json — as a
// single commit. Fine-grained organizing (per-route description, moving to a
// different collection, reordering) happens afterward via "Existing routes",
// same as for a route added one at a time.
function guessTypeFromFilename(filename) {
  const m = filename.toLowerCase().match(/^(bike|hike|kayak|run)[-_]/);
  return m ? m[1] : $('bulkTypeSelect').value;
}

async function handleBulkFiles(fileList) {
  const files = [...fileList].filter(f => f.name.toLowerCase().endsWith('.gpx'));
  if (!files.length) { alert('Please choose .gpx files.'); return; }
  for (const file of files) {
    const entry = { file, text: null, parsed: null, name: '', type: guessTypeFromFilename(file.name), error: null };
    try {
      const text = await file.text();
      const parsed = GPXParser.parse(text, file.name);
      entry.text = text;
      entry.parsed = parsed;
      entry.name = guessNameFromFilename(parsed.name || file.name);
    } catch (err) {
      entry.error = err.message;
    }
    state.bulkFiles.push(entry);
  }
  renderBulkList();
}

const bulkDropZone = $('bulkDropZone');
bulkDropZone.addEventListener('click', () => $('bulkFileInput').click());
$('bulkFileInput').addEventListener('change', () => {
  if ($('bulkFileInput').files.length) handleBulkFiles($('bulkFileInput').files);
  $('bulkFileInput').value = '';
});
bulkDropZone.addEventListener('dragover', e => { e.preventDefault(); bulkDropZone.classList.add('dragover'); });
bulkDropZone.addEventListener('dragleave', () => bulkDropZone.classList.remove('dragover'));
bulkDropZone.addEventListener('drop', e => {
  e.preventDefault(); bulkDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleBulkFiles(e.dataTransfer.files);
});
$('bulkClearBtn').addEventListener('click', () => {
  state.bulkFiles = [];
  renderBulkList();
});

function renderBulkList() {
  const list = $('bulkList');
  const validCount = state.bulkFiles.filter(f => !f.error).length;
  $('bulkCommitBtn').disabled = validCount === 0 || state.bulkCommitting;
  $('bulkCommitBtn').textContent = state.bulkCommitting ? 'Committing…' :
    (validCount ? `Commit ${validCount} route${validCount === 1 ? '' : 's'}` : 'Commit routes');
  $('bulkClearBtn').style.display = state.bulkFiles.length ? '' : 'none';

  list.innerHTML = '';
  if (!state.bulkFiles.length) {
    list.innerHTML = '<div class="routes-empty">No files added yet.</div>';
    return;
  }

  state.bulkFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'bulk-row';
    if (f.error) {
      row.innerHTML = `
        <div class="bulk-row-info">
          <div class="bulk-row-filename">${esc(f.file.name)}</div>
          <div class="bulk-row-error">✗ Could not parse: ${esc(f.error)}</div>
        </div>
        <button type="button" class="btn btn-small btn-danger bulk-row-remove" data-act="remove">✕</button>
      `;
    } else {
      const m = f.parsed.metrics;
      row.innerHTML = `
        <div class="bulk-row-info">
          <div class="bulk-row-filename">${esc(f.file.name)}</div>
          <div class="bulk-row-fields">
            <input type="text" class="br-name" value="${esc(f.name)}" placeholder="Route name" />
            <select class="br-type">
              <option value="bike">🚴 Bike</option>
              <option value="hike">🥾 Hike</option>
              <option value="kayak">🛶 Kayak</option>
              <option value="run">🏃 Run</option>
              <option value="other">✦ Other</option>
            </select>
          </div>
          <div class="bulk-row-meta">${m.distanceKm} km · ↑${m.elevGain}m ↓${m.elevLoss}m · ${m.pointCount.toLocaleString()} points</div>
        </div>
        <button type="button" class="btn btn-small btn-danger bulk-row-remove" data-act="remove">✕</button>
      `;
      row.querySelector('.br-type').value = f.type;
      row.querySelector('.br-name').addEventListener('input', e => { f.name = e.target.value; });
      row.querySelector('.br-type').addEventListener('change', e => { f.type = e.target.value; });
    }
    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
      state.bulkFiles.splice(i, 1);
      renderBulkList();
    });
    list.appendChild(row);
  });
}

$('bulkCommitBtn').addEventListener('click', () => commitBulk());

async function commitBulk() {
  clearLog();
  if (!state.token) { logLine('✗ Connect with a GitHub token first.', true); return; }
  const validRows = state.bulkFiles.filter(f => !f.error);
  if (!validRows.length) { logLine('✗ No valid GPX files to commit.', true); return; }
  for (const row of validRows) {
    if (!row.name.trim()) { logLine(`✗ "${esc(row.file.name)}" needs a route name.`, true); return; }
  }

  const groupSel = $('bulkGroupSelect').value;
  const gearId = $('bulkGearSelect').value || null;
  let groupFolder = null, groupName = null, newCollectionEntry = null;
  if (groupSel === '__new__') {
    groupFolder = $('bulkNewGroupName').value.trim();
    if (!groupFolder) { logLine('✗ Enter a name for the new collection.', true); return; }
    groupName = groupFolder;
    newCollectionEntry = { folder: groupFolder, name: groupName, description: $('bulkNewGroupDesc').value.trim() };
  } else if (groupSel) {
    groupFolder = groupSel;
    const existing = state.collections.find(c => c.folder === groupSel);
    groupName = existing ? existing.name : groupSel;
  }

  const btn = $('bulkCommitBtn');
  state.bulkCommitting = true;
  btn.disabled = true; btn.textContent = 'Committing…';
  try {
    logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const latestCommitSha = ref.object.sha;

    logLine('Fetching current index.json and collections.json…');
    const [indexEntries, collections] = await Promise.all([
      fetchRawJson('data/index.json', latestCommitSha, []),
      fetchRawJson('data/collections.json', latestCommitSha, []),
    ]);

    const existingIds = new Set(indexEntries.map(en => en.id));
    const folderSeg = groupFolder || 'ungrouped';
    const newEntries = [];
    const adds = [];
    const seenIds = new Set();

    for (const row of validRows) {
      const name = row.name.trim();
      const type = row.type;
      const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim();
      const filename = safeName + '.gpx';
      const gpxPath = `data/gpx/${type}/${folderSeg}/${filename}`;
      const id = makeId(type, groupFolder, filename);
      if (existingIds.has(id) || seenIds.has(id)) {
        throw new Error(`A route with id "${id}" already exists (from "${name}") — rename it and try again.`);
      }
      seenIds.add(id);

      adds.push({ path: gpxPath, content: row.text, encoding: 'utf-8' });
      newEntries.push({
        id, name, type,
        group: groupFolder || null,
        groupName: groupName || null,
        description: null,
        gpxPath,
        photos: [],
        addedAt: new Date().toISOString(),
        metrics: row.parsed.metrics,
        gearId,
        ...(groupFolder ? { order: Infinity } : {}),
      });
    }

    let updatedCollections = collections;
    if (newCollectionEntry) updatedCollections = [...collections, newCollectionEntry];

    const sortedEntries = resortIndex([...indexEntries, ...newEntries], updatedCollections);
    adds.push({ path: 'data/index.json', content: JSON.stringify(sortedEntries, null, 2), encoding: 'utf-8' });
    if (newCollectionEntry) {
      adds.push({ path: 'data/collections.json', content: JSON.stringify(updatedCollections, null, 2), encoding: 'utf-8' });
    }

    logLine(`Uploading ${adds.length} file(s) for ${newEntries.length} route(s)…`);
    await writeCommit({
      message: `Bulk add ${newEntries.length} route${newEntries.length === 1 ? '' : 's'}${groupName ? ' to ' + groupName : ''}`,
      latestCommitSha, adds, deletes: [],
    });

    state.collections = updatedCollections;
    state.routesIndex = sortedEntries;
    logLine(`<b>Done.</b> Added ${newEntries.length} route(s). Reorder or edit them from "Existing routes" below.`, false, true);

    state.bulkFiles = [];
    populateGroupSelect('groupSelect');
    populateGroupSelect('bulkGroupSelect');
    $('bulkNewGroupFields').style.display = 'none';
    renderCollectionsList();
    renderRoutesList();
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    state.bulkCommitting = false;
    renderBulkList();
  }
}

// ── Existing routes browser ───────────────────────────────────────────────────
const ACTIVITY_EMOJI = { bike:'🚴', hike:'🥾', kayak:'🛶', run:'🏃', other:'✦' };

$('loadRoutesBtn').addEventListener('click', async () => {
  const btn = $('loadRoutesBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    state.routesIndex = await fetchRawJson('data/index.json', state.defaultBranch, []);
    renderRoutesList();
    renderCollectionsList();
  } catch (e) {
    $('routesList').innerHTML = `<div class="routes-empty">Could not load routes: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Load';
  }
});
$('routesSearch').addEventListener('input', renderRoutesList);

function makeRouteRow(r, reorder) {
  const row = document.createElement('div');
  row.className = 'route-row';
  const km = r.metrics?.distanceKm ?? '?';
  const bike = r.gearId ? state.gear.find(b => b.id === r.gearId) : null;
  row.innerHTML = `
    ${reorder ? `<div class="reorder-col">
      <button type="button" class="btn reorder-btn" data-act="up" ${reorder.canUp ? '' : 'disabled'} title="Move up">↑</button>
      <button type="button" class="btn reorder-btn" data-act="down" ${reorder.canDown ? '' : 'disabled'} title="Move down">↓</button>
    </div>` : ''}
    <span class="route-row-emoji">${ACTIVITY_EMOJI[r.type] || '✦'}</span>
    <div class="route-row-info">
      <div class="route-row-name">${esc(r.name)}</div>
      <div class="route-row-meta">${km} km${r.groupName ? ' · ' + esc(r.groupName) : ''}${bike ? ' · 🚲 ' + esc(bike.name) : ''}</div>
    </div>
    <div class="route-row-actions">
      <button type="button" class="btn btn-small" data-act="edit">Edit</button>
      <button type="button" class="btn btn-small btn-danger" data-act="delete">Delete</button>
    </div>
  `;
  row.querySelector('[data-act="edit"]').addEventListener('click', () => enterEditMode(r));
  row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteRouteFlow(r));
  if (reorder) {
    if (reorder.canUp) row.querySelector('[data-act="up"]').addEventListener('click', () => moveRouteOrder(r, -1));
    if (reorder.canDown) row.querySelector('[data-act="down"]').addEventListener('click', () => moveRouteOrder(r, 1));
  }
  return row;
}

function makeGroupHeader(text) {
  const header = document.createElement('div');
  header.className = 'routes-group-header';
  header.textContent = text;
  return header;
}

function renderRoutesList() {
  const list = $('routesList');
  if (!state.routesIndex) {
    list.innerHTML = '<div class="routes-empty">Click Load to fetch the current route list.</div>';
    return;
  }
  list.style.opacity = state.reordering ? '.5' : '';
  list.style.pointerEvents = state.reordering ? 'none' : '';

  const q = $('routesSearch').value.trim().toLowerCase();
  const filtered = state.routesIndex
    .filter(r => !q || r.name.toLowerCase().includes(q) || (r.groupName || '').toLowerCase().includes(q));

  if (filtered.length === 0) {
    list.innerHTML = '<div class="routes-empty">No routes match.</div>';
    return;
  }

  list.innerHTML = '';

  if (q) {
    // Searching shows a flat, newest-first list — reordering a filtered
    // subset wouldn't reflect each route's real neighbors, so arrows are
    // hidden until the search is cleared.
    filtered
      .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
      .forEach(r => list.appendChild(makeRouteRow(r, null)));
    return;
  }

  const byGroup = new Map();
  for (const r of filtered) {
    if (!r.group) continue;
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  for (const groupRows of byGroup.values()) {
    groupRows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  }

  for (const groupRows of byGroup.values()) {
    const section = document.createElement('div');
    section.className = 'routes-group';
    section.appendChild(makeGroupHeader(groupRows[0].groupName || groupRows[0].group));
    groupRows.forEach((r, i) => section.appendChild(makeRouteRow(r, { canUp: i > 0, canDown: i < groupRows.length - 1 })));
    list.appendChild(section);
  }

  const ungrouped = filtered.filter(r => !r.group).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  if (ungrouped.length) {
    const section = document.createElement('div');
    section.className = 'routes-group';
    section.appendChild(makeGroupHeader('Ungrouped'));
    ungrouped.forEach(r => section.appendChild(makeRouteRow(r, null)));
    list.appendChild(section);
  }
}

async function moveRouteOrder(entry, direction) {
  if (state.reordering) return;
  state.reordering = true;
  renderRoutesList();
  clearLog();
  try {
    logLine('Resolving latest commit on <b>' + esc(state.defaultBranch) + '</b>…');
    const ref = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${state.defaultBranch}`);
    const latestCommitSha = ref.object.sha;

    const [indexEntries, collections] = await Promise.all([
      fetchRawJson('data/index.json', latestCommitSha, []),
      fetchRawJson('data/collections.json', latestCommitSha, []),
    ]);
    const current = indexEntries.find(en => en.id === entry.id);
    if (!current || !current.group) throw new Error('This route no longer exists or is no longer grouped — reload the list.');

    const siblings = indexEntries
      .filter(en => en.group === current.group)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    const idx = siblings.findIndex(en => en.id === current.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= siblings.length) {
      logLine('Nothing to do — reload and try again.');
      return;
    }
    const other = siblings[swapIdx];
    const tmp = current.order; current.order = other.order; other.order = tmp;

    const sorted = resortIndex(indexEntries, collections);
    logLine('Uploading reordered index…');
    await writeCommit({
      message: `Reorder: ${current.name}`,
      latestCommitSha,
      adds: [{ path: 'data/index.json', content: JSON.stringify(sorted, null, 2), encoding: 'utf-8' }],
      deletes: [],
    });

    state.routesIndex = sorted;
    logLine(`<b>Reordered "${esc(current.name)}".</b>`, false, true);
  } catch (err) {
    logLine('✗ ' + esc(err.message), true);
  } finally {
    state.reordering = false;
    renderRoutesList();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  if (state.token) {
    try { await connect(state.token); }
    catch (e) { disconnect(); }
  }
})();
