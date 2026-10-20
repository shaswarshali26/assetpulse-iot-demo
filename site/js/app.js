(function () {
  const { Sim, TYPES, HOUR, DAY, MIN } = window.AP;
  const sim = new Sim(7);
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const STATUS = {
    transit: { label: 'In transit', color: 'var(--transit)', hex: '#2563eb' },
    site: { label: 'At geozone', color: 'var(--site)', hex: '#16a34a' },
    idle: { label: 'Idle', color: 'var(--idle)', hex: '#d97706' },
    offsite: { label: 'Outside geozones', color: 'var(--offsite)', hex: '#7c3aed' },
    alert: { label: 'Alert', color: 'var(--alert)', hex: '#dc2626' },
    offline: { label: 'Offline', color: 'var(--offline)', hex: '#8a96a3' },
  };
  const ui = { running: true, speed: 5, view: 'dashboard', selected: null, groundTruth: false, statusFilter: new Set(), sort: { key: 'id', dir: 1 } };

  // ---------- formatting ----------
  const fmtTime = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtShort = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  function ago(t) {
    const m = (sim.t - t) / MIN;
    if (m < 1) return 'just now';
    if (m < 60) return `${Math.round(m)} min ago`;
    if (m < 60 * 48) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} d ago`;
  }
  const dur = (ms) => (ms < DAY ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} d`);
  const battColor = (b) => (b < 15 ? 'var(--alert)' : b < 35 ? 'var(--warn)' : 'var(--site)');
  const battHtml = (b) => `<span class="batt"><i style="--w:${Math.max(2, b)}%;--c:${battColor(b)}"></i>${Math.round(b)}%</span>`;
  const pos = (a) => (ui.groundTruth ? { lat: a.lat, lng: a.lng } : a.rep);
  function locationText(a) {
    const r = ui.groundTruth ? { siteId: a.state === 'site' ? a.siteId : null, lat: a.lat, lng: a.lng, moving: a.state !== 'site' } : a.rep;
    if (r.siteId && !r.moving) return sim.siteById[r.siteId].name;
    const n = sim.nearestSite(r.lat, r.lng);
    return `${r.moving ? 'On the road' : 'Stopped'}, ${n.km.toFixed(0)} km from ${n.site.short}`;
  }

  // ---------- routing ----------
  function show(view) {
    ui.view = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    if (view === 'dashboard') setTimeout(() => map.invalidateSize(), 0);
    renderView(true);
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'dashboard'));

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([35.55, 45.4], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

  const zoneLayers = {};
  for (const s of sim.sites) {
    const c = L.circle([s.lat, s.lng], { radius: s.r, color: '#0e7490', weight: 1.5, fillOpacity: 0.08, dashArray: '4 4' }).addTo(map);
    c.bindTooltip('', { permanent: true, direction: 'top', className: 'zone-label', offset: [0, -6] });
    c.on('click', () => { location.hash = 'geozones'; });
    zoneLayers[s.id] = c;
  }
  const markers = {};
  for (const a of sim.assets) {
    const m = L.circleMarker([a.rep.lat, a.rep.lng], { radius: 6, weight: 1.5, color: '#fff', fillOpacity: 0.95 }).addTo(map);
    m.bindTooltip(a.id, { direction: 'top', offset: [0, -4] });
    m.on('click', () => openDrawer(a.id));
    markers[a.id] = m;
  }
  let trailLine = null, routeLine = null;

  $('#legend').innerHTML = Object.values(STATUS).map((s) => `<span><i class="dot" style="background:${s.color}"></i>${s.label}</span>`).join('');
  $('#statusChips').innerHTML = Object.entries(STATUS).map(([k, s]) => `<button class="chip" data-st="${k}"><i class="dot" style="background:${s.color}"></i>${s.label}</button>`).join('');
  $('#statusChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const k = b.dataset.st;
    ui.statusFilter.has(k) ? ui.statusFilter.delete(k) : ui.statusFilter.add(k);
    b.classList.toggle('on');
    renderMap();
  });
  const typeOpts = Object.keys(TYPES).map((t) => `<option>${t}</option>`).join('');
  $('#mapType').insertAdjacentHTML('beforeend', typeOpts);
  $('#assetType').insertAdjacentHTML('beforeend', typeOpts);
  $('#assetStatus').insertAdjacentHTML('beforeend', Object.entries(STATUS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join(''));
  $('#mapType').addEventListener('change', renderMap);
  $('#mapSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toUpperCase();
    const a = sim.assets.find((x) => x.id === q) || sim.assets.find((x) => x.id.includes(q));
    if (a) openDrawer(a.id, true); else toast('info', `No asset matches “${esc(q)}”`);
  });

  function renderMap() {
    const type = $('#mapType').value;
    for (const a of sim.assets) {
      const m = markers[a.id], st = sim.statusOf(a);
      const visible = (!type || a.type === type) && (!ui.statusFilter.size || ui.statusFilter.has(st));
      if (!visible) { if (map.hasLayer(m)) m.remove(); continue; }
      if (!map.hasLayer(m)) m.addTo(map);
      const p = pos(a);
      m.setLatLng([p.lat, p.lng]);
      m.setStyle({ fillColor: STATUS[st].hex, radius: ui.selected === a.id ? 9 : 6, color: ui.selected === a.id ? '#0f1b2a' : '#fff' });
    }
    const stock = sim.stockBySite();
    for (const s of sim.sites) zoneLayers[s.id].setTooltipContent(`${s.short} · ${stock[s.id]}`);
    if (ui.selected) {
      const a = sim.assetById[ui.selected];
      const pts = a.trail.map((p) => [p.lat, p.lng]);
      if (trailLine) trailLine.setLatLngs(pts); else trailLine = L.polyline(pts, { color: '#0e7490', weight: 3, opacity: 0.75 }).addTo(map);
      const plan = a.state === 'transit' || a.state === 'rogue' ? [[a.rep.lat, a.rep.lng], [a.to.lat, a.to.lng]] : [];
      if (routeLine) routeLine.setLatLngs(plan); else routeLine = L.polyline(plan, { color: '#64748b', weight: 2, dashArray: '6 6' }).addTo(map);
    }
  }

  // ---------- dashboard ----------
  function renderKpis() {
    const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
    for (const a of sim.assets) counts[sim.statusOf(a)]++;
    const open = sim.alerts.filter((x) => x.status === 'open');
    const crit = open.filter((x) => x.severity === 'critical').length;
    const util = sim.assets.reduce((s, a) => s + a.useMin / a.totalMin, 0) / sim.assets.length;
    const avgBatt = sim.assets.reduce((s, a) => s + a.battery, 0) / sim.assets.length;
    const k = [
      ['Tracked assets', sim.assets.length, `${Object.keys(TYPES).length} asset types`],
      ['In transit', counts.transit, `${Math.round((counts.transit / sim.assets.length) * 100)}% of fleet`],
      ['At geozones', counts.site + counts.idle, `${counts.idle} idle`],
      ['Open alerts', open.length, `${crit} critical`, crit > 0],
      ['Utilization', `${Math.round(util * 100)}%`, 'moving or in use'],
      ['Avg. battery', `${Math.round(avgBatt)}%`, `${sim.assets.filter((a) => a.battery < 15).length} below 15%`],
    ];
    $('#kpis').innerHTML = k.map(([l, v, s, bad]) => `<div class="kpi${bad ? ' bad' : ''}"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
    const nc = $('#navAlertCount');
    nc.textContent = open.length;
    open.length ? nc.removeAttribute('data-zero') : nc.setAttribute('data-zero', '');
  }

  function renderSide() {
    const stock = sim.stockBySite();
    $('#stockBars').innerHTML = sim.sites.map((s) => {
      const v = stock[s.id], cls = v < s.min ? 'low' : v > s.max ? 'over' : '';
      return `<div class="stock-row ${cls}" data-site="${s.id}"><span>${s.name}</span><b>${v} <span class="muted" style="font-weight:400">/ ${s.min}–${s.max}</span></b><div class="bar"><i style="width:${Math.min(100, (v / s.max) * 100)}%"></i></div></div>`;
    }).join('');
    const latest = sim.alerts.filter((a) => a.status !== 'resolved').slice(0, 6);
    $('#dashAlerts').innerHTML = latest.length ? latest.map(alertLi).join('') : '<li class="muted">No open alerts</li>';
  }
  const alertLi = (al) => `<li data-target="${al.targetId}"><span class="sev ${al.severity}"></span><div><div>${esc(al.msg)}</div><div class="meta">${al.kind} · ${ago(al.t)}</div></div></li>`;
  $('#stockBars').addEventListener('click', (e) => {
    const r = e.target.closest('[data-site]'); if (!r) return;
    const s = sim.siteById[r.dataset.site];
    map.flyTo([s.lat, s.lng], 13);
  });
  $('#dashAlerts').addEventListener('click', (e) => { const li = e.target.closest('[data-target]'); if (li) focusTarget(li.dataset.target); });

  function focusTarget(id) {
    if (sim.assetById[id]) openDrawer(id, true);
    else if (sim.siteById[id]) { location.hash = 'dashboard'; const s = sim.siteById[id]; setTimeout(() => map.flyTo([s.lat, s.lng], 13), 50); }
  }

  // ---------- assets table ----------
  function assetRows() {
    const q = $('#assetSearch').value.trim().toLowerCase(), type = $('#assetType').value, st = $('#assetStatus').value;
    const rows = sim.assets.map((a) => ({
      a, id: a.id, type: a.type, tracker: a.tracker, status: sim.statusOf(a), loc: locationText(a),
      seen: a.rep.t, battery: a.battery, dwell: a.state === 'site' ? sim.t - a.visitStart : -1,
    })).filter((r) => (!type || r.type === type) && (!st || r.status === st) &&
      (!q || `${r.id} ${r.type} ${r.loc} ${r.tracker}`.toLowerCase().includes(q)));
    const { key, dir } = ui.sort;
    rows.sort((x, y) => (x[key] > y[key] ? dir : x[key] < y[key] ? -dir : 0));
    return rows;
  }
  function renderAssets() {
    $('#assetTable tbody').innerHTML = assetRows().map((r) => `<tr data-id="${r.id}">
      <td><b>${r.id}</b></td><td>${r.type}</td><td>${r.tracker}</td>
      <td><span class="pill"><i class="dot" style="background:${STATUS[r.status].color}"></i>${STATUS[r.status].label}</span></td>
      <td>${esc(r.loc)}</td><td class="num">${ago(r.seen)}</td><td>${battHtml(r.battery)}</td>
      <td class="num">${r.dwell >= 0 ? dur(r.dwell) : '—'}</td></tr>`).join('');
  }
  ['#assetSearch', '#assetType', '#assetStatus'].forEach((s) => $(s).addEventListener('input', renderAssets));
  $('#assetTable thead').addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]'); if (!th) return;
    ui.sort = { key: th.dataset.sort, dir: ui.sort.key === th.dataset.sort ? -ui.sort.dir : 1 };
    renderAssets();
  });
  $('#assetTable tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) openDrawer(tr.dataset.id); });

  // ---------- geozones ----------
  function siteStats(s) {
    const recent = sim.visits.filter((v) => v.siteId === s.id && v.exit && sim.t - v.exit < 7 * DAY);
    const avgDwell = recent.length ? recent.reduce((t, v) => t + (v.exit - v.enter), 0) / recent.length : 0;
    const arrivals = sim.visits.filter((v) => v.siteId === s.id && sim.t - v.enter < DAY).length;
    const departures = sim.visits.filter((v) => v.siteId === s.id && v.exit && sim.t - v.exit < DAY).length;
    return { avgDwell, arrivals, departures };
  }
  function renderZones() {
    const stock = sim.stockBySite();
    $('#zoneGrid').innerHTML = sim.sites.map((s) => {
      const st = siteStats(s), v = stock[s.id];
      const byType = {};
      for (const a of sim.assets) if (a.rep.siteId === s.id && !a.rep.moving) byType[a.type] = (byType[a.type] || 0) + 1;
      const flag = v < s.min ? '<span class="pill warning">Low stock</span>' : v > s.max ? '<span class="pill info">Overstock</span>' : '<span class="pill" style="color:var(--site)">OK</span>';
      return `<div class="card zone" data-site="${s.id}">
        <div class="type">${s.type}</div>
        <h3 style="margin:2px 0 6px"><span>${s.name}</span>${flag}</h3>
        <div><span class="big">${v}</span> <span class="range">assets · target ${s.min}–${s.max}</span></div>
        <div class="types">${Object.entries(byType).map(([t, n]) => `<span class="pill">${t} ${n}</span>`).join('') || '<span class="muted">Empty</span>'}</div>
        <div class="stats"><div><b>${st.arrivals}</b>arrivals 24h</div><div><b>${st.departures}</b>departures 24h</div><div><b>${st.avgDwell ? dur(st.avgDwell) : '—'}</b>avg dwell 7d</div></div>
      </div>`;
    }).join('');
    $('#visitTable tbody').innerHTML = sim.visits.slice(-40).reverse().map((v) => `<tr data-id="${v.assetId}">
      <td><b>${v.assetId}</b></td><td>${v.type}</td><td>${sim.siteById[v.siteId].name}</td><td>${fmtShort(v.enter)}</td>
      <td>${v.exit ? fmtShort(v.exit) : '<span class="pill" style="color:var(--site)">On site</span>'}</td><td class="num">${dur((v.exit || sim.t) - v.enter)}</td></tr>`).join('');
  }
  $('#zoneGrid').addEventListener('click', (e) => { const c = e.target.closest('[data-site]'); if (c) focusTarget(c.dataset.site); });
  $('#visitTable tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) openDrawer(tr.dataset.id); });

  // ---------- alerts ----------
  function renderAlerts() {
    const st = $('#alertStatus').value, sev = $('#alertSev').value;
    const rows = sim.alerts.filter((a) => (!st || a.status === st) && (!sev || a.severity === sev)).slice(0, 200);
    $('#alertTable tbody').innerHTML = rows.length ? rows.map((a) => `<tr data-target="${a.targetId}">
      <td><span class="pill ${a.severity}"><span class="sev ${a.severity}" style="margin:0"></span>${a.severity}</span></td>
      <td>${a.kind}</td><td>${esc(a.msg)}</td><td>${fmtShort(a.t)} <span class="muted">(${ago(a.t)})</span></td>
      <td>${a.status}${a.resolvedT ? ` <span class="muted">${ago(a.resolvedT)}</span>` : ''}</td>
      <td>${a.status === 'open' ? `<button class="btn sm" data-ack="${a.id}">Acknowledge</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6" class="muted">No alerts match these filters.</td></tr>';
  }
  ['#alertStatus', '#alertSev'].forEach((s) => $(s).addEventListener('change', renderAlerts));
  $('#alertTable tbody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ack]');
    if (b) { const al = sim.alerts.find((x) => x.id === +b.dataset.ack); al.status = 'acknowledged'; renderAlerts(); renderKpis(); return; }
    const tr = e.target.closest('[data-target]'); if (tr) focusTarget(tr.dataset.target);
  });
  $('#ackAll').addEventListener('click', () => { sim.alerts.forEach((a) => a.status === 'open' && (a.status = 'acknowledged')); renderAlerts(); renderKpis(); });

  // ---------- analytics ----------
  const charts = {};
  const PALETTE = ['#0e7490', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#64748b', '#0891b2'];
  function chartDefaults() {
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue('--muted').trim();
    Chart.defaults.borderColor = css.getPropertyValue('--border').trim();
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
  }
  function upsert(id, cfg) {
    if (charts[id]) { charts[id].data = cfg.data; charts[id].update('none'); return; }
    charts[id] = new Chart(document.getElementById(id), cfg);
  }
  function renderAnalytics() {
    const types = Object.keys(TYPES);
    const hist = sim.history.slice(-24 * 7);
    upsert('chStock', {
      type: 'line',
      data: {
        labels: hist.map((h) => fmtShort(h.t)),
        datasets: sim.sites.map((s, i) => ({ label: s.short, data: hist.map((h) => h.stock[s.id]), borderColor: PALETTE[i], backgroundColor: PALETTE[i], pointRadius: 0, borderWidth: 1.8, tension: 0.25 })),
      },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } } },
    });
    upsert('chUtil', {
      type: 'bar',
      data: { labels: types, datasets: [{ label: 'Utilization %', data: types.map((t) => { const g = sim.assets.filter((a) => a.type === t); return Math.round((g.reduce((s, a) => s + a.useMin / a.totalMin, 0) / g.length) * 100); }), backgroundColor: '#0e7490', borderRadius: 4 }] },
      options: { indexAxis: 'y', scales: { x: { max: 100, beginAtZero: true } }, plugins: { legend: { display: false } } },
    });
    upsert('chDwell', {
      type: 'bar',
      data: { labels: sim.sites.map((s) => s.short), datasets: [{ label: 'Avg dwell (h)', data: sim.sites.map((s) => +(siteStats(s).avgDwell / HOUR).toFixed(1)), backgroundColor: '#2563eb', borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
    upsert('chCycle', {
      type: 'bar',
      data: { labels: types, datasets: [{ label: 'Cycle time (days)', data: types.map((t) => { const c = sim.cycles.filter((x) => x.type === t); return c.length ? +(c.reduce((s, x) => s + x.days, 0) / c.length).toFixed(1) : 0; }), backgroundColor: '#16a34a', borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
    const bins = [0, 0, 0, 0, 0];
    sim.assets.forEach((a) => bins[Math.min(4, Math.floor(a.battery / 20))]++);
    upsert('chBattery', {
      type: 'bar',
      data: { labels: ['0–20%', '20–40%', '40–60%', '60–80%', '80–100%'], datasets: [{ label: 'Assets', data: bins, backgroundColor: ['#dc2626', '#d97706', '#eab308', '#16a34a', '#15803d'], borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  // ---------- simulator view ----------
  function renderEvents() {
    $('#eventLog').innerHTML = sim.events.slice(0, 120).map((e) => `<li class="k-${e.kind}"><time>${fmtShort(e.t)}</time><span>${esc(e.msg)}</span></li>`).join('');
  }
  $('.scenarios').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scn]'); if (!b) return;
    const fn = { theft: 'scenarioTheft', temp: 'scenarioTemp', lost: 'scenarioLost', battery: 'scenarioBattery', shortage: 'scenarioShortage' }[b.dataset.scn];
    const r = sim[fn]();
    if (r && r.id) { toast('info', `Scenario applied to <b>${r.id}</b>. <a href="#" data-open="${r.id}">Track it</a>`); }
    else if (typeof r === 'number') toast('info', `${r} assets dispatched from the Sulaymaniyah Industrial Zone`);
    else toast('warning', 'No eligible asset for this scenario right now');
    renderView(true);
  });
  $('#toasts').addEventListener('click', (e) => { const a = e.target.closest('[data-open]'); if (a) { e.preventDefault(); openDrawer(a.dataset.open, true); } });
  $('#idleDays').addEventListener('change', (e) => { sim.settings.idleDays = Math.max(1, +e.target.value || 4); sim.evaluate(); });
  $('#groundTruth').addEventListener('change', (e) => { ui.groundTruth = e.target.checked; renderMap(); });
  $('#resetBtn').addEventListener('click', () => {
    sim.reset(+$('#seed').value || 7);
    sim.settings.idleDays = Math.max(1, +$('#idleDays').value || 4);
    closeDrawer(); seenAlert = sim.alertSeq;
    toast('info', 'Simulation restarted');
    renderView(true);
  });

  // ---------- drawer ----------
  function openDrawer(id, fly) {
    ui.selected = id;
    const a = sim.assetById[id];
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    if (fly) {
      if (ui.view !== 'dashboard') location.hash = 'dashboard';
      setTimeout(() => { const p = pos(a); map.flyTo([p.lat, p.lng], 11); }, 60);
    }
    renderDrawer(); renderMap();
  }
  function closeDrawer() {
    ui.selected = null;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    if (trailLine) { trailLine.remove(); trailLine = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    renderMap();
  }
  $('#drawerClose').addEventListener('click', closeDrawer);

  function renderDrawer() {
    if (!ui.selected) return;
    const a = sim.assetById[ui.selected], st = sim.statusOf(a);
    const alerts = sim.alerts.filter((x) => x.targetId === a.id).slice(0, 6);
    const visits = sim.visits.filter((v) => v.assetId === a.id).slice(-6).reverse();
    const dest = a.state === 'transit' ? sim.siteById[a.to.siteId] : null;
    const rogue = a.state === 'rogue' || a.state === 'parked';
    $('#drawerBody').innerHTML = `
      <h2>${a.id}</h2>
      <div class="sub">${a.type} · ${a.tracker} (${a.conn})</div>
      <span class="pill"><i class="dot" style="background:${STATUS[st].color}"></i>${STATUS[st].label}</span>
      <dl class="kv">
        <dt>Last location</dt><dd>${esc(locationText(a))}</dd>
        <dt>Last seen</dt><dd>${fmtShort(a.rep.t)} (${ago(a.rep.t)})</dd>
        ${dest ? `<dt>Heading to</dt><dd>${dest.name}, ETA ${fmtShort(a.arriveT)}</dd>` : ''}
        ${a.state === 'site' ? `<dt>Dwell time</dt><dd>${dur(sim.t - a.visitStart)}</dd>` : ''}
        <dt>Battery</dt><dd>${battHtml(a.battery)}</dd>
        ${a.temp !== null ? `<dt>Temperature</dt><dd>${a.temp} °C</dd>` : ''}
        ${a.fill !== null ? `<dt>Fill level</dt><dd>${a.fill}%</dd>` : ''}
        <dt>Distance travelled</dt><dd>${a.km.toLocaleString()} km</dd>
        <dt>Completed cycles</dt><dd>${a.cycleCount} (${a.sinceMaint} since service)</dd>
        <dt>Circuit</dt><dd>${a.circuit.map((c) => c).join(' → ')}</dd>
      </dl>
      <div class="actions">
        <button class="btn sm" data-act="locate">Locate on map</button>
        ${rogue ? '<button class="btn sm primary" data-act="recover">Mark recovered</button>' : ''}
        ${a.dwellUntil === Infinity ? '<button class="btn sm primary" data-act="recover">Release asset</button>' : ''}
        ${a.state === 'site' && a.siteId !== 'SRM' ? '<button class="btn sm" data-act="maint">Send to maintenance</button>' : ''}
        ${a.battery < 30 ? '<button class="btn sm" data-act="battery">Replace battery</button>' : ''}
      </div>
      ${a.tempHist.length ? '<h4>Temperature (last 24 h of reports)</h4><div class="spark"><canvas id="chTemp"></canvas></div>' : ''}
      <h4>Recent geozone visits</h4>
      <ul class="mini-list">${visits.map((v) => `<li><span>${sim.siteById[v.siteId].name}</span><span class="muted">${fmtShort(v.enter)} · ${dur((v.exit || sim.t) - v.enter)}</span></li>`).join('') || '<li class="muted">None yet</li>'}</ul>
      <h4>Alerts</h4>
      <ul class="mini-list">${alerts.map((x) => `<li><span><span class="sev ${x.severity}" style="display:inline-block;margin:0 6px 0 0"></span>${x.kind}</span><span class="muted">${x.status} · ${ago(x.t)}</span></li>`).join('') || '<li class="muted">No alerts</li>'}</ul>`;
    if (a.tempHist.length) {
      if (charts.chTemp) { charts.chTemp.destroy(); delete charts.chTemp; }
      charts.chTemp = new Chart(document.getElementById('chTemp'), {
        type: 'line',
        data: { labels: a.tempHist.map((h) => fmtShort(h.t)), datasets: [{ data: a.tempHist.map((h) => h.v), borderColor: '#d97706', pointRadius: 0, borderWidth: 1.6, tension: 0.3 }] },
        options: { plugins: { legend: { display: false } }, scales: { x: { display: false } } },
      });
    }
  }
  $('#drawerBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = sim.assetById[ui.selected];
    if (b.dataset.act === 'locate') { if (ui.view !== 'dashboard') location.hash = 'dashboard'; setTimeout(() => { const p = pos(a); map.flyTo([p.lat, p.lng], 12); }, 60); }
    if (b.dataset.act === 'recover') { a.dwellUntil === Infinity ? (a.dwellUntil = sim.t) : sim.recover(a); toast('info', `${a.id} is heading back to its circuit`); }
    if (b.dataset.act === 'maint') { sim.sendToMaintenance(a); toast('info', `${a.id} dispatched to the Sulaymaniyah repair center`); }
    if (b.dataset.act === 'battery') { sim.replaceBattery(a); toast('info', `Battery replaced on ${a.id}`); }
    renderView(true); renderDrawer();
  });

  // ---------- toasts for new alerts ----------
  let seenAlert = sim.alertSeq;
  function toast(sev, html) {
    const el = document.createElement('div');
    el.className = `toast ${sev}`; el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }
  function notifyNewAlerts() {
    const fresh = sim.alerts.filter((a) => a.id > seenAlert && a.severity !== 'info');
    seenAlert = sim.alertSeq;
    fresh.slice(0, 3).forEach((a) => toast(a.severity, `<b>${a.kind}</b><br>${esc(a.msg)}${sim.assetById[a.targetId] ? ` · <a href="#" data-open="${a.targetId}">Open</a>` : ''}`));
  }

  // ---------- render orchestration ----------
  let lastSlow = 0, lastCharts = 0;
  function renderView(force) {
    $('#clock').textContent = fmtTime(sim.t);
    renderMap();
    const now = performance.now();
    if (!force && now - lastSlow < 1000) return;
    lastSlow = now;
    renderKpis();
    if (ui.view === 'dashboard') renderSide();
    if (ui.view === 'assets') renderAssets();
    if (ui.view === 'geozones') renderZones();
    if (ui.view === 'alerts') renderAlerts();
    if (ui.view === 'simulator') renderEvents();
    if (ui.view === 'analytics' && (force || now - lastCharts > 3000)) { lastCharts = now; renderAnalytics(); }
    if (ui.selected && document.activeElement?.closest('#drawer') == null) renderDrawer();
  }

  $('#playBtn').addEventListener('click', () => { ui.running = !ui.running; $('#playBtn').textContent = ui.running ? '❚❚' : '▶'; });
  $('#speedSel').addEventListener('change', (e) => { ui.speed = +e.target.value; });

  setInterval(() => {
    if (!ui.running) return;
    let left = ui.speed;
    while (left > 0) { const d = Math.min(5, left); sim.step(d); left -= d; }
    notifyNewAlerts();
    renderView(false);
  }, 250);

  chartDefaults();
  show(location.hash.slice(1) || 'dashboard');
})();
