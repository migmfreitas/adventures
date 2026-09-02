/**
 * Gear page — reads data/gear.json and renders each bike's details plus its
 * maintenance log. Read-only; editing happens in gear-admin.html.
 */

const BIKE_TYPE_EMOJI = { road: '🚴', gravel: '🌄', mountain: '⛰️', city: '🏙️', ebike: '⚡', other: '✦' };
const BIKE_TYPE_LABEL = { road: 'Road', gravel: 'Gravel', mountain: 'Mountain', city: 'City', ebike: 'E-bike', other: 'Other' };
const LOG_TYPE_EMOJI = { service: '🔧', repair: '🛠️', part: '🔩', tire: '🛞', clean: '🧼', other: '✦' };
const LOG_TYPE_LABEL = { service: 'Service', repair: 'Repair', part: 'Part replacement', tire: 'Tires', clean: 'Cleaning', other: 'Other' };

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function detailRow(label, value) {
  if (!value) return '';
  return `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
}

function renderBike(bike) {
  const emoji = BIKE_TYPE_EMOJI[bike.type] || '✦';
  const typeLabel = BIKE_TYPE_LABEL[bike.type] || 'Other';
  const sub = [bike.brand, bike.year].filter(Boolean).join(' · ');

  const details = [
    detailRow('Brand', bike.brand),
    detailRow('Model', bike.model),
    detailRow('Year', bike.year),
    detailRow('Type', typeLabel),
    detailRow('Size', bike.size),
    detailRow('Frame', bike.frame),
    detailRow('Groupset', bike.groupset),
    detailRow('Wheels', bike.wheels),
    detailRow('Tires', bike.tires),
    detailRow('Purchased', bike.purchaseDate ? fmtDate(bike.purchaseDate) : ''),
  ].join('');

  const log = [...(bike.maintenanceLog || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalCost = log.reduce((sum, e) => sum + (Number(e.cost) || 0), 0);
  const lastEntry = log[0];

  const statsRow = `
    <div class="bike-stats">
      <div class="bike-stat"><div class="bike-stat-val">${log.length}</div><div class="bike-stat-lbl">Log entries</div></div>
      <div class="bike-stat"><div class="bike-stat-val">${lastEntry ? fmtDate(lastEntry.date) : '—'}</div><div class="bike-stat-lbl">Last entry</div></div>
      <div class="bike-stat"><div class="bike-stat-val">${totalCost ? totalCost.toLocaleString(undefined, { style: 'currency', currency: 'EUR' }) : '—'}</div><div class="bike-stat-lbl">Total spent</div></div>
    </div>`;

  const logHtml = log.length ? log.map(e => `
    <div class="log-entry">
      <div class="log-entry-date">${fmtDate(e.date)}</div>
      <div class="log-entry-body">
        <div class="log-entry-title"><span class="log-entry-emoji">${LOG_TYPE_EMOJI[e.type] || '✦'}</span>${esc(LOG_TYPE_LABEL[e.type] || 'Other')}</div>
        ${e.description ? `<div class="log-entry-desc">${esc(e.description)}</div>` : ''}
        <div class="log-entry-meta">${[
          e.mileageKm ? `${Number(e.mileageKm).toLocaleString()} km` : '',
          e.cost ? Number(e.cost).toLocaleString(undefined, { style: 'currency', currency: 'EUR' }) : '',
        ].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`).join('') : '<div class="log-empty">No maintenance logged yet.</div>';

  return `
    <section class="bike-card">
      <div class="bike-header">
        <div class="bike-emoji">${emoji}</div>
        <div class="bike-heading">
          <div class="bike-name">${esc(bike.name)}</div>
          <div class="bike-sub">${esc(sub || typeLabel)}</div>
        </div>
      </div>
      ${statsRow}
      ${details ? `<div class="details-card"><table>${details}</table></div>` : ''}
      ${bike.notes ? `<p class="bike-notes">${esc(bike.notes)}</p>` : ''}
      <div class="section-label">Maintenance log</div>
      <div class="log-list">${logHtml}</div>
    </section>`;
}

async function init() {
  const root = document.getElementById('gearRoot');
  try {
    const res = await fetch('data/gear.json?_=' + Date.now());
    if (!res.ok) throw new Error('gear.json not found');
    const bikes = await res.json();
    if (!bikes.length) {
      root.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🚲</div>
          <p>No bikes added yet.<br/><br/>Click <strong>Manage gear</strong> to add one.</p>
        </div>`;
      return;
    }
    root.innerHTML = bikes.map(renderBike).join('');
  } catch (e) {
    root.innerHTML = `<div class="state-msg">Could not load gear: ${esc(e.message)}</div>`;
  }
}

init();
