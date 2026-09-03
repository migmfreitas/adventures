/**
 * Gear page — reads data/gear.json and data/index.json and renders each
 * bike's details, the rides logged against it (via each route's gearId),
 * and its maintenance log. Read-only; editing happens in gear-admin.html
 * (bikes/maintenance) and admin.html (which bike a route was ridden on).
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
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
/** A ride's date for sorting/comparison — the GPX's recorded start, falling
 *  back to when the route was added if the GPX carried no timestamps. */
function rideDate(route) {
  return route.metrics?.startTime || route.addedAt;
}

function detailRow(label, value) {
  if (!value) return '';
  return `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
}
function statCard(val, lbl) {
  return `<div class="bike-stat"><div class="bike-stat-val">${val}</div><div class="bike-stat-lbl">${esc(lbl)}</div></div>`;
}

function renderBike(bike, allRoutes) {
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

  const rides = allRoutes.filter(r => r.gearId === bike.id).sort((a, b) => new Date(rideDate(b)) - new Date(rideDate(a)));
  const totalDistanceKm = rides.reduce((sum, r) => sum + (Number(r.metrics?.distanceKm) || 0), 0);
  const sinceDate = lastEntry ? new Date(lastEntry.date + 'T00:00:00') : null;
  const kmSinceService = sinceDate
    ? rides.filter(r => new Date(rideDate(r)) > sinceDate).reduce((sum, r) => sum + (Number(r.metrics?.distanceKm) || 0), 0)
    : totalDistanceKm;

  const statsRow = `
    <div class="bike-stats">
      ${statCard(rides.length, 'Rides')}
      ${statCard(totalDistanceKm ? totalDistanceKm.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' km' : '—', 'Distance')}
      ${statCard(lastEntry ? kmSinceService.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' km' : '—', 'Since last service')}
      ${statCard(log.length, 'Log entries')}
      ${statCard(lastEntry ? fmtDate(lastEntry.date) : '—', 'Last entry')}
      ${statCard(totalCost ? totalCost.toLocaleString(undefined, { style: 'currency', currency: 'EUR' }) : '—', 'Total spent')}
    </div>`;

  const ridesHtml = rides.length ? rides.map(r => `
    <a class="ride-row" href="route.html?id=${encodeURIComponent(r.id)}">
      <div class="ride-row-info">
        <div class="ride-row-name">${esc(r.name)}</div>
        <div class="ride-row-meta">${fmtDateTime(rideDate(r))}</div>
      </div>
      <div class="ride-row-dist">${r.metrics?.distanceKm != null ? r.metrics.distanceKm + ' km' : '—'}</div>
    </a>`).join('') : '<div class="log-empty">No rides logged on this bike yet — assign it to a route from the routes admin.</div>';

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
      <div class="section-label">Rides on this bike</div>
      <div class="ride-list">${ridesHtml}</div>
      <div class="section-label">Maintenance log</div>
      <div class="log-list">${logHtml}</div>
    </section>`;
}

async function init() {
  const root = document.getElementById('gearRoot');
  try {
    const [gearRes, indexRes] = await Promise.all([
      fetch('data/gear.json?_=' + Date.now()),
      fetch('data/index.json?_=' + Date.now()),
    ]);
    if (!gearRes.ok) throw new Error('gear.json not found');
    const bikes = await gearRes.json();
    const routes = indexRes.ok ? await indexRes.json() : [];
    if (!bikes.length) {
      root.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🚲</div>
          <p>No bikes added yet.<br/><br/>Click <strong>Manage gear</strong> to add one.</p>
        </div>`;
      return;
    }
    root.innerHTML = bikes.map(b => renderBike(b, routes)).join('');
  } catch (e) {
    root.innerHTML = `<div class="state-msg">Could not load gear: ${esc(e.message)}</div>`;
  }
}

init();
