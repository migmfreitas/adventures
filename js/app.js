/**
 * Adventure Log — Main App
 * Supports view mode (public) and edit mode (passphrase-protected)
 */

const ACTIVITY_COLORS = { bike:'#e07840', hike:'#52c97a', kayak:'#4a9eff', run:'#f5c842', other:'#b48aff' };
const ACTIVITY_EMOJI  = { bike:'🚴', hike:'🥾', kayak:'🛶', run:'🏃', other:'✦' };
const STORAGE_KEY     = 'adventure_log_auth';

// ── Map ───────────────────────────────────────────────────────────────────────
const map = L.map('map', { center:[39.5,-8.0], zoom:6, zoomControl:false });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom:19,
}).addTo(map);
L.control.zoom({ position:'bottomright' }).addTo(map);

// ── State ─────────────────────────────────────────────────────────────────────
let routes       = [];
let groups       = [];
let activeFilter = 'all';
let openGroupId  = null;
let polylines    = {};
let editMode     = false;
let dirty        = false;   // unsaved changes exist
let dragSrcEl    = null;    // drag-and-drop source element

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  [routes, groups] = await Promise.all([Store.loadIndex(), Store.loadGroups()]);
  render();
  setTimeout(() => map.invalidateSize(), 200);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(s) { if(!s)return'—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; }
function fmtKm(km) { return km>=1000?(km/1000).toFixed(1)+'k':Math.round(km)+''; }
function groupRouteIds(g) { return new Set(g.routes||[]); }
function allGroupedIds() { const s=new Set(); groups.forEach(g=>g.routes?.forEach(id=>s.add(id))); return s; }
function groupStats(g) {
  const ids=groupRouteIds(g), members=routes.filter(r=>ids.has(r.id));
  return {
    km:    Math.round(members.reduce((s,r)=>s+(r.metrics?.distanceKm||0),0)*10)/10,
    gain:  members.reduce((s,r)=>s+(r.metrics?.elevGain||0),0),
    moving:members.reduce((s,r)=>s+(r.metrics?.movingTime||0),0),
    count: members.length,
  };
}
function filteredRoutes() { return activeFilter==='all'?routes:routes.filter(r=>r.type===activeFilter); }
function getAuth() { try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); }catch{return {};} }
function saveAuth(obj) { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
function markDirty() { dirty=true; document.getElementById('saveBtn').style.display='flex'; }

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('editBadge').style.display = editMode ? 'flex' : 'none';
  document.getElementById('importBtn').style.display = editMode ? 'flex' : 'none';
  document.getElementById('saveBtn').style.display   = (editMode && dirty) ? 'flex' : 'none';
  document.getElementById('lockBtn').textContent     = editMode ? '🔓 Lock' : '🔒 Edit';
  renderSidebar();
  renderMap();
  updateStats();
}

function renderSidebar() {
  const list  = document.getElementById('routeList');
  const empty = document.getElementById('emptyState');
  [...list.querySelectorAll('.route-item,.group-item,.back-to-all,.ungrouped-label')].forEach(el=>el.remove());

  const filtered = filteredRoutes();
  if (filtered.length===0) { empty.style.display='flex'; return; }
  empty.style.display='none';

  if (openGroupId) {
    renderGroupOpen(list, filtered);
  } else {
    renderAllView(list, filtered);
  }
}

function renderAllView(list, filtered) {
  const groupedIds = allGroupedIds();

  // Groups
  groups.forEach((group, gi) => {
    const members = filtered.filter(r => groupRouteIds(group).has(r.id));
    if (members.length===0 && !editMode) return;
    list.appendChild(makeGroupItem(group, members, gi));
  });

  // Ungrouped
  const ungrouped = filtered.filter(r => !groupedIds.has(r.id));
  if (ungrouped.length > 0) {
    if (groups.length > 0 && editMode) {
      const lbl = document.createElement('div');
      lbl.className = 'ungrouped-label';
      lbl.textContent = 'Ungrouped';
      list.appendChild(lbl);
    }
    ungrouped.forEach((r, ri) => list.appendChild(makeRouteItem(r, ri, null)));
  }
}

function renderGroupOpen(list, filtered) {
  const group   = groups.find(g=>g.id===openGroupId);
  if (!group) { openGroupId=null; renderAllView(list, filtered); return; }
  const ids     = groupRouteIds(group);
  const stats   = groupStats(group);
  const members = filtered.filter(r=>ids.has(r.id));

  const back = document.createElement('div');
  back.className = 'back-to-all visible';
  back.innerHTML = '← All adventures';
  back.addEventListener('click', ()=>{ openGroupId=null; render(); fitAllRoutes(); });
  list.appendChild(back);

  const wrap = document.createElement('div');
  wrap.className = 'group-item';
  wrap.innerHTML = `
    <div class="group-header open" style="cursor:default">
      <span class="group-icon">📁</span>
      <div class="group-info" style="flex:1;min-width:0">
        ${editMode
          ? `<input class="edit-inline" data-field="group-name" data-id="${esc(group.id)}" value="${esc(group.name)}" />`
          : `<div class="group-name">${esc(group.name)}</div>`
        }
        <div class="group-meta">${stats.count} routes</div>
      </div>
    </div>
    <div class="group-body open">
      <div class="group-desc-wrap">
        ${editMode
          ? `<textarea class="edit-inline edit-textarea" data-field="group-desc" data-id="${esc(group.id)}" placeholder="Add a description…">${esc(group.description||'')}</textarea>`
          : (group.description ? `<div class="group-desc">${esc(group.description)}</div>` : '')
        }
      </div>
      <div class="group-stats">
        <div class="group-stat"><div class="group-stat-val">${fmtKm(stats.km)}</div><div class="group-stat-lbl">km total</div></div>
        <div class="group-stat"><div class="group-stat-val">${fmtTime(stats.moving)}</div><div class="group-stat-lbl">moving time</div></div>
        <div class="group-stat"><div class="group-stat-val">${stats.gain>=1000?(stats.gain/1000).toFixed(1)+'k':stats.gain}</div><div class="group-stat-lbl">m ascent</div></div>
      </div>
      <div class="group-routes" id="openGroupRoutes"></div>
      ${editMode ? `<div class="group-add-routes" id="groupAddRoutes"></div>` : ''}
    </div>
  `;
  list.appendChild(wrap);

  // Wire up inline edits
  if (editMode) {
    wrap.querySelector('[data-field="group-name"]').addEventListener('input', e => {
      group.name = e.target.value; markDirty();
    });
    wrap.querySelector('[data-field="group-desc"]').addEventListener('input', e => {
      group.description = e.target.value; markDirty();
    });
  }

  const routesContainer = wrap.querySelector('#openGroupRoutes');
  members.forEach((r, ri) => routesContainer.appendChild(makeRouteItem(r, ri, group)));

  // In edit mode show ungrouped routes that can be added
  if (editMode) {
    const addContainer = wrap.querySelector('#groupAddRoutes');
    const ungrouped = routes.filter(r => !groupRouteIds(group).has(r.id));
    if (ungrouped.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'ungrouped-label';
      lbl.textContent = '+ Add to group';
      addContainer.appendChild(lbl);
      ungrouped.forEach(r => {
        const el = document.createElement('div');
        el.className = 'route-item add-to-group';
        el.innerHTML = `
          <div class="route-dot" style="background:${ACTIVITY_COLORS[r.type]||ACTIVITY_COLORS.other}"></div>
          <div class="route-info"><div class="route-name">${esc(r.name)}</div></div>
          <button class="btn-add-route" title="Add to group">＋</button>
        `;
        el.querySelector('.btn-add-route').addEventListener('click', () => {
          if (!group.routes) group.routes = [];
          group.routes.push(r.id);
          markDirty(); render();
        });
        addContainer.appendChild(el);
      });
    }
  }

  // Enable drag-to-reorder within open group
  if (editMode) enableDragSort(routesContainer, 'route', group);
}

// ── Route item ────────────────────────────────────────────────────────────────
function makeRouteItem(route, idx, group) {
  const item  = document.createElement('div');
  item.className = 'route-item';
  item.dataset.id = route.id;
  const color = ACTIVITY_COLORS[route.type]||ACTIVITY_COLORS.other;
  const km    = route.metrics?.distanceKm ?? '?';
  const gain  = route.metrics?.elevGain ?? null;
  const date  = route.metrics?.startTime
    ? new Date(route.metrics.startTime).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';

  item.innerHTML = `
    ${editMode ? '<span class="drag-handle">⠿</span>' : ''}
    <div class="route-dot" style="background:${color}"></div>
    <div class="route-info">
      ${editMode
        ? `<input class="edit-inline" data-field="route-name" data-id="${esc(route.id)}" value="${esc(route.name)}" />`
        : `<div class="route-name">${esc(route.name)}</div>`
      }
      <div class="route-meta">${km} km${gain?' · ↑'+gain+'m':''}${date?' · '+date:''}</div>
    </div>
    ${editMode && group
      ? `<button class="btn-remove-route" title="Remove from group" data-id="${esc(route.id)}">✕</button>`
      : `<span class="route-arrow">›</span>`
    }
  `;

  if (editMode) {
    item.setAttribute('draggable','true');
    item.querySelector('[data-field="route-name"]').addEventListener('input', e => {
      route.name = e.target.value; markDirty();
    });
    // Stop click propagation from inputs
    item.querySelector('input').addEventListener('click', e => e.stopPropagation());
    if (group) {
      item.querySelector('.btn-remove-route')?.addEventListener('click', e => {
        e.stopPropagation();
        group.routes = group.routes.filter(id=>id!==route.id);
        markDirty(); render();
      });
    }
  } else {
    item.addEventListener('mouseenter', () => {
      const pl=polylines[route.id]; if(pl){pl.setStyle({weight:5,opacity:1});pl.bringToFront();}
    });
    item.addEventListener('mouseleave', () => {
      const pl=polylines[route.id]; if(pl) pl.setStyle({weight:3,opacity:0.8});
    });
    item.addEventListener('click', () => { window.location.href=`route.html?id=${route.id}`; });
  }

  return item;
}

// ── Group item ────────────────────────────────────────────────────────────────
function makeGroupItem(group, members, gi) {
  const stats = groupStats(group);
  const el    = document.createElement('div');
  el.className = 'group-item';
  el.dataset.groupId = group.id;
  if (editMode) { el.setAttribute('draggable','true'); }

  el.innerHTML = `
    <div class="group-header" data-group-id="${esc(group.id)}">
      ${editMode ? '<span class="drag-handle">⠿</span>' : ''}
      <span class="group-icon">📁</span>
      <div class="group-info">
        ${editMode
          ? `<input class="edit-inline" data-field="group-name" data-id="${esc(group.id)}" value="${esc(group.name)}" />`
          : `<div class="group-name">${esc(group.name)}</div>`
        }
        <div class="group-meta">${members.length} routes · ${fmtKm(stats.km)} km</div>
      </div>
      ${editMode ? `<button class="btn-delete-group" data-id="${esc(group.id)}" title="Delete group">🗑</button>` : ''}
    </div>
  `;

  const header = el.querySelector('.group-header');

  if (editMode) {
    header.querySelector('[data-field="group-name"]')?.addEventListener('input', e => {
      group.name = e.target.value; markDirty();
      header.querySelector('[data-field="group-name"]').value = group.name;
    });
    header.querySelector('[data-field="group-name"]')?.addEventListener('click', e => e.stopPropagation());
    el.querySelector('.btn-delete-group')?.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete group "${group.name}"? Routes will stay, just ungrouped.`)) {
        groups = groups.filter(g=>g.id!==group.id);
        markDirty(); render();
      }
    });
  } else {
    header.addEventListener('mouseenter', () => highlightGroup(group, true));
    header.addEventListener('mouseleave', () => highlightGroup(group, false));
  }

  header.addEventListener('click', e => {
    if (editMode && e.target.tagName==='INPUT') return;
    openGroupId = group.id; render(); fitGroupRoutes(group);
  });

  return el;
}

// ── Drag-to-reorder ───────────────────────────────────────────────────────────
function enableDragSort(container, type, group) {
  container.addEventListener('dragstart', e => {
    const item = e.target.closest('.route-item, .group-item');
    if (!item) return;
    dragSrcEl = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.id || item.dataset.groupId || '');
    setTimeout(() => item.style.opacity = '0.4', 0);
  });
  container.addEventListener('dragend', e => {
    const item = e.target.closest('.route-item, .group-item');
    if (item) item.style.opacity = '';
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragSrcEl = null;
  });
  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.route-item, .group-item');
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (target && target !== dragSrcEl) target.classList.add('drag-over');
  });
  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget))
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  container.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    const target = e.target.closest('.route-item, .group-item');
    if (!target || !dragSrcEl || target === dragSrcEl) return;

    if (type === 'route' && group) {
      const srcId = dragSrcEl.dataset.id;
      const tgtId = target.dataset.id;
      if (!srcId || !tgtId) return;
      const arr = group.routes;
      const si = arr.indexOf(srcId), ti = arr.indexOf(tgtId);
      if (si >= 0 && ti >= 0) { arr.splice(si, 1); arr.splice(ti, 0, srcId); markDirty(); render(); }
    } else if (type === 'group') {
      const srcId = dragSrcEl.dataset.groupId;
      const tgtId = target.dataset.groupId;
      if (!srcId || !tgtId) return;
      const si = groups.findIndex(g => g.id === srcId);
      const ti = groups.findIndex(g => g.id === tgtId);
      if (si >= 0 && ti >= 0) { const [g] = groups.splice(si, 1); groups.splice(ti, 0, g); markDirty(); render(); }
    }
  });
}

// Enable reorder of top-level items (groups + ungrouped routes)
function enableTopLevelDrag(list) {
  if (!editMode) return;
  list.addEventListener('dragstart', e => {
    dragSrcEl = e.target.closest('.group-item,[data-id]');
    if (!dragSrcEl) return;
    e.dataTransfer.effectAllowed='move';
    setTimeout(()=>dragSrcEl.style.opacity='0.4',0);
  });
  list.addEventListener('dragend',()=>{
    if(dragSrcEl) dragSrcEl.style.opacity='';
    dragSrcEl=null;
    list.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  });
  list.addEventListener('dragover', e=>{
    e.preventDefault();
    const target=e.target.closest('.group-item,.route-item');
    list.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    if(target&&target!==dragSrcEl) target.classList.add('drag-over');
  });
  list.addEventListener('drop', e=>{
    e.preventDefault();
    const target=e.target.closest('.group-item,.route-item');
    if(!target||!dragSrcEl||target===dragSrcEl) return;
    target.classList.remove('drag-over');

    // Determine what moved
    const srcGroupId  = dragSrcEl.dataset.groupId;
    const srcRouteId  = dragSrcEl.dataset.id;
    const tgtGroupId  = target.dataset.groupId;
    const tgtRouteId  = target.dataset.id;
    const groupedIds  = allGroupedIds();

    if (srcGroupId && tgtGroupId) {
      // Reorder groups
      const si=groups.findIndex(g=>g.id===srcGroupId), ti=groups.findIndex(g=>g.id===tgtGroupId);
      if(si>=0&&ti>=0){ const[g]=groups.splice(si,1); groups.splice(ti,0,g); }
    } else if (srcRouteId && !groupedIds.has(srcRouteId) && tgtRouteId && !groupedIds.has(tgtRouteId)) {
      // Reorder ungrouped routes
      const si=routes.findIndex(r=>r.id===srcRouteId), ti=routes.findIndex(r=>r.id===tgtRouteId);
      if(si>=0&&ti>=0){ const[r]=routes.splice(si,1); routes.splice(ti,0,r); }
    }
    markDirty(); render();
  });
}

// ── Map ───────────────────────────────────────────────────────────────────────
function renderMap() {
  Object.values(polylines).forEach(p=>map.removeLayer(p));
  polylines={};
  const filtered=filteredRoutes();
  if(filtered.length===0) return;

  const focusIds=openGroupId?groupRouteIds(groups.find(g=>g.id===openGroupId)):null;

  filtered.forEach(route=>{
    const path=route.metrics?.simplifiedPath;
    if(!path||path.length<2) return;
    const color=ACTIVITY_COLORS[route.type]||ACTIVITY_COLORS.other;
    const dimmed=focusIds&&!focusIds.has(route.id);
    const pl=L.polyline(path.map(p=>[p.lat,p.lon]),{
      color:dimmed?'#444':color, weight:dimmed?2:3, opacity:dimmed?0.3:0.8,
    }).addTo(map);
    if(!dimmed&&!editMode){
      pl.on('mouseover',e=>{
        pl.setStyle({weight:5,opacity:1});
        L.popup({closeButton:false}).setLatLng(e.latlng).setContent(`
          <div class="popup-name">${esc(route.name)}</div>
          <div class="popup-meta">📍 ${route.metrics?.distanceKm??'?'} km${route.metrics?.elevGain?'<br/>↑ '+route.metrics.elevGain+' m':''}<br/>${ACTIVITY_EMOJI[route.type]||'✦'} ${route.type}</div>
          <a class="popup-link" href="route.html?id=${route.id}">View details →</a>
        `).openOn(map);
      });
      pl.on('mouseout',()=>pl.setStyle({weight:3,opacity:0.8}));
      pl.on('click',()=>{ window.location.href=`route.html?id=${route.id}`; });
    }
    polylines[route.id]=pl;
  });
  if(!openGroupId) fitAllRoutes();
}

function updateStats() {
  const f=filteredRoutes();
  const km=f.reduce((s,r)=>s+(r.metrics?.distanceKm||0),0);
  const gain=f.reduce((s,r)=>s+(r.metrics?.elevGain||0),0);
  document.getElementById('statRoutes').textContent=f.length;
  document.getElementById('statKm').textContent=km>=1000?(km/1000).toFixed(1)+'k':Math.round(km);
  document.getElementById('statElev').textContent=gain>=1000?(gain/1000).toFixed(1)+'k':gain;
}

function fitAllRoutes() {
  const all=Object.values(polylines).flatMap(pl=>pl.getLatLngs());
  if(all.length>0) map.fitBounds(L.latLngBounds(all),{padding:[40,40]});
}
function fitGroupRoutes(group) {
  const ids=groupRouteIds(group);
  const lls=Object.entries(polylines).filter(([id])=>ids.has(id)).flatMap(([,pl])=>pl.getLatLngs());
  if(lls.length>0) map.fitBounds(L.latLngBounds(lls),{padding:[40,40]});
}
function highlightGroup(group, on) {
  const ids=groupRouteIds(group);
  Object.entries(polylines).forEach(([id,pl])=>{
    if(ids.has(id)){ pl.setStyle(on?{weight:5,opacity:1}:{weight:3,opacity:0.8}); if(on)pl.bringToFront(); }
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.pill').forEach(pill=>{
  pill.addEventListener('click',()=>{
    document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter=pill.dataset.type;
    render();
  });
});

// ── Lock / edit mode ──────────────────────────────────────────────────────────
document.getElementById('lockBtn').addEventListener('click', () => {
  if (editMode) {
    editMode=false; render();
  } else {
    document.getElementById('authModalBackdrop').classList.add('open');
  }
});

document.getElementById('authForm').addEventListener('submit', e => {
  e.preventDefault();
  const pass  = document.getElementById('authPass').value;
  const token = document.getElementById('authToken').value;
  const repo  = document.getElementById('authRepo').value;
  const auth  = getAuth();

  // First time setup — save passphrase hash + token + repo
  if (!auth.passHash) {
    if (!pass || !token || !repo) { alert('Fill in all fields to set up edit mode.'); return; }
    saveAuth({ passHash: btoa(pass), token, repo });
    enterEditMode();
  } else {
    // Verify passphrase
    if (btoa(pass) !== auth.passHash) { alert('Wrong passphrase.'); return; }
    // Update token/repo if provided
    if (token) saveAuth({ ...auth, token });
    if (repo)  saveAuth({ ...getAuth(), repo });
    enterEditMode();
  }
});

function enterEditMode() {
  document.getElementById('authModalBackdrop').classList.remove('open');
  document.getElementById('authPass').value='';
  document.getElementById('authToken').value='';
  editMode=true; dirty=false; render();
}

document.getElementById('authModalBackdrop').addEventListener('click', e => {
  if (e.target===document.getElementById('authModalBackdrop'))
    document.getElementById('authModalBackdrop').classList.remove('open');
});
document.getElementById('authCancelBtn').addEventListener('click', () => {
  document.getElementById('authModalBackdrop').classList.remove('open');
});

// Show/hide setup fields based on whether auth exists
document.getElementById('authModalBackdrop').addEventListener('transitionend', () => {});
document.getElementById('lockBtn').addEventListener('click', () => {
  const auth = getAuth();
  const isSetup = !auth.passHash;
  document.getElementById('authSetupNote').style.display = isSetup ? 'block' : 'none';
  document.getElementById('authTokenField').style.display = isSetup ? 'block' : 'none';
  document.getElementById('authRepoField').style.display  = isSetup ? 'block' : 'none';
  document.getElementById('authModalTitle').textContent   = isSetup ? 'Set up edit mode' : 'Enter passphrase';
}, { capture: true });

// ── New group button ──────────────────────────────────────────────────────────
document.getElementById('newGroupBtn').addEventListener('click', () => {
  const name = prompt('Group name:');
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+Date.now().toString(36);
  groups.unshift({ id, name, description:'', routes:[] });
  markDirty(); render();
});

// ── Save to GitHub ────────────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', saveToGitHub);

async function saveToGitHub() {
  const auth = getAuth();
  if (!auth.token || !auth.repo) {
    alert('No GitHub token or repo set. Lock and re-enter edit mode to configure.');
    return;
  }

  const btn = document.getElementById('saveBtn');
  btn.textContent = '⏳ Saving…'; btn.disabled = true;

  try {
    const [owner, repo] = auth.repo.split('/');
    const headers = {
      'Authorization': `token ${auth.token}`,
      'Content-Type':  'application/json',
    };

    await Promise.all([
      pushFile({ owner, repo, headers, path:'data/index.json', content:JSON.stringify(routes, null, 2),   message:'Update route index' }),
      pushFile({ owner, repo, headers, path:'data/groups.json', content:JSON.stringify(groups, null, 2), message:'Update groups' }),
    ]);

    dirty = false;
    btn.textContent = '✓ Saved';
    btn.style.background = '#2a6e3f';
    setTimeout(() => { btn.textContent='💾 Save'; btn.style.background=''; btn.style.display='none'; btn.disabled=false; }, 2500);
  } catch(e) {
    alert('Save failed: '+e.message);
    btn.textContent='💾 Save'; btn.disabled=false;
  }
}

async function pushFile({ owner, repo, headers, path, content, message }) {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  // Get current SHA
  let sha;
  try {
    const res = await fetch(base, { headers });
    if (res.ok) { const d=await res.json(); sha=d.sha; }
  } catch {}

  const body = { message, content: btoa(unescape(encodeURIComponent(content))) };
  if (sha) body.sha = sha;

  const res = await fetch(base, { method:'PUT', headers, body:JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(()=>({}));
    throw new Error(err.message||`HTTP ${res.status} for ${path}`);
  }
}

// ── Import flow ───────────────────────────────────────────────────────────────
const importModal    = document.getElementById('modalBackdrop');
const fileInput      = document.getElementById('fileInput');
const modalDropZone  = document.getElementById('modalDropZone');
const routeNameInput = document.getElementById('routeName');
const activitySelect = document.getElementById('activityType');
let pendingParsed=null, pendingGpxText=null;

document.getElementById('importBtn').addEventListener('click', openImportModal);
document.getElementById('cancelBtn').addEventListener('click', closeImportModal);
document.getElementById('confirmBtn').addEventListener('click', confirmImport);
importModal.addEventListener('click', e=>{ if(e.target===importModal) closeImportModal(); });

function openImportModal() {
  pendingParsed=null; pendingGpxText=null;
  routeNameInput.value='';
  document.getElementById('dropZoneLabel').innerHTML='📂 Drop GPX here or <u>browse</u>';
  // Populate group selector
  const sel = document.getElementById('groupSelect');
  sel.innerHTML='<option value="">No group</option>';
  groups.forEach(g=>{ const o=document.createElement('option'); o.value=g.id; o.textContent=g.name; sel.appendChild(o); });
  if (openGroupId) sel.value = openGroupId;
  importModal.classList.add('open');
}
function closeImportModal() {
  importModal.classList.remove('open');
  pendingParsed=null; pendingGpxText=null; fileInput.value='';
}

async function confirmImport() {
  if (!pendingParsed) { alert('Please select a GPX file first.'); return; }
  const name    = routeNameInput.value.trim() || pendingParsed.name;
  const type    = activitySelect.value;
  const groupId = document.getElementById('groupSelect').value;
  const btn     = document.getElementById('confirmBtn');
  btn.textContent='Saving…'; btn.disabled=true;

  try {
    const auth = getAuth();
    if (!auth.token||!auth.repo) throw new Error('No GitHub token set. Re-enter edit mode to configure.');
    const [owner, repo] = auth.repo.split('/');
    const headers = { 'Authorization':`token ${auth.token}`, 'Content-Type':'application/json' };

    // Build entry
    const id = type+'-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)+'-'+Date.now().toString(36);
    const parsed = pendingParsed;
    const entry  = {
      id, name, type,
      addedAt: new Date().toISOString(),
      metrics: {
        distanceKm:    parsed.metrics.distanceKm,
        elevGain:      parsed.metrics.elevGain,
        elevLoss:      parsed.metrics.elevLoss,
        minEle:        parsed.metrics.minEle,
        maxEle:        parsed.metrics.maxEle,
        movingTime:    parsed.metrics.movingTime,
        totalTime:     parsed.metrics.totalTime,
        avgHr:         parsed.metrics.avgHr,
        pointCount:    parsed.metrics.pointCount,
        startTime:     parsed.metrics.startTime,
        bounds:        parsed.metrics.bounds,
        elevProfile:   parsed.metrics.elevProfile,
        simplifiedPath:parsed.metrics.simplifiedPath,
      },
    };

    const newRoutes = [entry, ...routes];
    const newGroups = groups.map(g => {
      if (g.id===groupId) return { ...g, routes:[...(g.routes||[]), id] };
      return g;
    });

    await Promise.all([
      pushFile({ owner, repo, headers, path:`data/gpx/${id}.gpx`, content:pendingGpxText, message:`Add GPX: ${name}` }),
      pushFile({ owner, repo, headers, path:'data/index.json',     content:JSON.stringify(newRoutes,null,2), message:`Add route: ${name}` }),
      pushFile({ owner, repo, headers, path:'data/groups.json',    content:JSON.stringify(newGroups,null,2), message:`Update groups` }),
    ]);

    routes = newRoutes;
    groups = newGroups;
    dirty  = false;
    closeImportModal();
    render();
    alert(`✓ "${name}" uploaded and saved to GitHub!`);
  } catch(e) {
    alert('Upload failed: '+e.message);
  } finally {
    btn.textContent='Add Route'; btn.disabled=false;
  }
}

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.gpx')) { alert('Please drop a .gpx file.'); return; }
  const reader=new FileReader();
  reader.onload=e=>{
    try {
      pendingGpxText=e.target.result;
      const parsed=GPXParser.parse(pendingGpxText,file.name);
      pendingParsed=parsed;
      routeNameInput.value=parsed.name;
      document.getElementById('dropZoneLabel').textContent='✓ '+file.name+' loaded';
    } catch(err){ alert('Could not parse GPX: '+err.message); }
  };
  reader.readAsText(file);
}

modalDropZone.addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',()=>{ if(fileInput.files[0]) handleFile(fileInput.files[0]); });
modalDropZone.addEventListener('dragover',e=>{e.preventDefault();modalDropZone.classList.add('dragover');});
modalDropZone.addEventListener('dragleave',()=>modalDropZone.classList.remove('dragover'));
modalDropZone.addEventListener('drop',e=>{
  e.preventDefault();modalDropZone.classList.remove('dragover');
  if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

let dragCounter=0;
document.addEventListener('dragenter',e=>{
  if(e.dataTransfer.types.includes('Files')){ dragCounter++; document.getElementById('dropOverlay').classList.add('active'); }
});
document.addEventListener('dragleave',()=>{
  if(--dragCounter<=0){ dragCounter=0; document.getElementById('dropOverlay').classList.remove('active'); }
});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{
  e.preventDefault(); dragCounter=0;
  document.getElementById('dropOverlay').classList.remove('active');
  if(importModal.classList.contains('open')) return;
  if(editMode && e.dataTransfer.files[0]) { openImportModal(); handleFile(e.dataTransfer.files[0]); }
});
