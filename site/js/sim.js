// AssetPulse simulation engine: moves non-powered assets between geozones and
// emulates how low-power trackers report (sparse, delayed, gateway-only for BLE).
(function (global) {
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function haversine(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  const SITES = [
    { id: 'SIZ', short: 'Industrial Zone', name: 'Sulaymaniyah Industrial Zone', type: 'Plant', lat: 35.5235, lng: 45.3560, r: 1200, min: 18, max: 70, dwellH: 8 },
    { id: 'BSH', short: 'Bashmakh', name: 'Bashmakh Border Crossing', type: 'Border crossing', lat: 35.5830, lng: 46.0300, r: 1200, min: 8, max: 50, dwellH: 14 },
    { id: 'ARB', short: 'Arbat', name: 'Arbat Logistics Hub', type: 'Warehouse', lat: 35.4220, lng: 45.5750, r: 1000, min: 5, max: 40, dwellH: 10 },
    { id: 'TSL', short: 'Tasluja', name: 'Tasluja Cement Supplier', type: 'Supplier', lat: 35.6150, lng: 45.2550, r: 1000, min: 4, max: 30, dwellH: 10 },
    { id: 'CHM', short: 'Chamchamal', name: 'Chamchamal Construction Site', type: 'Customer', lat: 35.5290, lng: 44.8290, r: 1000, min: 4, max: 35, dwellH: 16 },
    { id: 'DKN', short: 'Dukan', name: 'Dukan Materials Supplier', type: 'Supplier', lat: 35.9540, lng: 44.9530, r: 900, min: 4, max: 30, dwellH: 12 },
    { id: 'SRM', short: 'Repair Center', name: 'Sulaymaniyah Repair & Maintenance', type: 'Repair', lat: 35.5720, lng: 45.4250, r: 700, min: 0, max: 15, dwellH: 30 },
    { id: 'DBK', short: 'Darbandikhan', name: 'Darbandikhan Cross-Dock', type: 'Warehouse', lat: 35.1130, lng: 45.7060, r: 1000, min: 5, max: 40, dwellH: 6 },
  ];

  const TYPES = {
    'Stillage':       { prefix: 'STL', count: 36, circuit: ['TSL', 'SIZ', 'CHM', 'SIZ'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 50 },
    'Roll cage':      { prefix: 'RLC', count: 24, circuit: ['ARB', 'DBK', 'BSH', 'DBK'], tracker: 'BLE tag', conn: 'BLE gateway', speed: 45 },
    'IBC container':  { prefix: 'IBC', count: 18, circuit: ['BSH', 'DKN', 'CHM', 'BSH'], tracker: 'Condition sensor', conn: 'NB-IoT', speed: 47, sensors: ['temp', 'fill'] },
    'Trailer':        { prefix: 'TRL', count: 14, circuit: ['BSH', 'SIZ', 'ARB', 'DBK'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 63 },
    'Tooling jig':    { prefix: 'JIG', count: 10, circuit: ['SIZ', 'SRM', 'SIZ', 'DKN'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 45 },
    'Pallet box':     { prefix: 'PLB', count: 20, circuit: ['DKN', 'SIZ', 'DBK', 'DKN'], tracker: 'BLE tag', conn: 'BLE gateway', speed: 49 },
  };

  const USE_SITE_TYPES = new Set(['Plant', 'Customer']);

  class Sim {
    constructor(seed = 7) { this.reset(seed); }

    reset(seed = this.seed) {
      this.seed = seed;
      this.rnd = mulberry32(seed);
      this.sites = SITES.map((s) => ({ ...s }));
      this.siteById = Object.fromEntries(this.sites.map((s) => [s.id, s]));
      this.t = Math.floor(Date.now() / HOUR) * HOUR - 10 * DAY;
      this.startT = this.t;
      this.assets = [];
      this.alerts = [];
      this.active = new Map();
      this.events = [];
      this.visits = [];
      this.history = [];
      this.cycles = [];
      this.alertSeq = 0;
      this.settings = { idleDays: 4, maintEvery: 12 };

      for (const [type, def] of Object.entries(TYPES)) {
        for (let i = 0; i < def.count; i++) {
          const ci = Math.floor(this.rnd() * def.circuit.length);
          const a = {
            id: `${def.prefix}-${1001 + i}`, type, tracker: def.tracker, conn: def.conn,
            sensors: def.sensors || [], circuit: def.circuit, ci, speed: def.speed,
            state: 'site', siteId: def.circuit[ci], battery: Math.round(30 + this.rnd() * 70),
            trail: [], tempHist: [], km: Math.round(this.rnd() * 4000), cycleCount: 0, cycleStart: null,
            sinceMaint: Math.floor(this.rnd() * 10), transitMin: 0, useMin: 0, totalMin: 0,
            tempBias: (this.rnd() - 0.5) * 3, fill: def.sensors ? Math.round(this.rnd() * 100) : null, temp: null,
          };
          this.placeAt(a, a.siteId);
          a.visitStart = this.t - this.rnd() * this.siteById[a.siteId].dwellH * HOUR;
          a.dwellUntil = this.t + this.dwellDuration(a.siteId) * this.rnd();
          this.report(a);
          this.assets.push(a);
        }
      }
      this.assetById = Object.fromEntries(this.assets.map((a) => [a.id, a]));

      // Warm up 10 days so history, visits and analytics have data on first load.
      const end = this.t + 10 * DAY;
      while (this.t < end) this.step(10);
    }

    // ---------- geometry helpers ----------
    jitter(site, frac = 0.75) {
      const ang = this.rnd() * Math.PI * 2, rad = Math.sqrt(this.rnd()) * site.r * frac;
      return {
        lat: site.lat + (Math.sin(ang) * rad) / 111320,
        lng: site.lng + (Math.cos(ang) * rad) / (111320 * Math.cos((site.lat * Math.PI) / 180)),
      };
    }
    placeAt(a, siteId) { Object.assign(a, this.jitter(this.siteById[siteId])); }
    siteAt(lat, lng) {
      for (const s of this.sites) if (haversine(s, { lat, lng }) * 1000 <= s.r) return s;
      return null;
    }
    nearestSite(lat, lng) {
      let best = null, bd = Infinity;
      for (const s of this.sites) { const d = haversine(s, { lat, lng }); if (d < bd) { bd = d; best = s; } }
      return { site: best, km: bd };
    }
    dwellDuration(siteId) {
      const s = this.siteById[siteId];
      let h = s.dwellH * (0.5 + this.rnd());
      if (this.rnd() < 0.05) h *= 3;
      return h * HOUR;
    }

    // ---------- movement ----------
    nextDest(a) {
      if (a.maintenanceDue && a.siteId !== 'SRM' && this.rnd() < 0.5) { a.detour = true; return 'SRM'; }
      if (a.detour) { a.detour = false; return a.circuit[a.ci]; }
      a.ci = (a.ci + 1) % a.circuit.length;
      return a.circuit[a.ci];
    }

    depart(a, to, rogue = false) {
      const from = { lat: a.lat, lng: a.lng };
      const target = typeof to === 'string' ? { ...this.jitter(this.siteById[to]), siteId: to } : { ...to, siteId: null };
      const dist = haversine(from, target) * 1.4;
      const speed = a.speed + this.rnd() * 10;
      const off = (this.rnd() - 0.5) * 0.3;
      if (a.state === 'site') this.closeVisit(a);
      Object.assign(a, {
        state: rogue ? 'rogue' : 'transit', from, to: target, departT: this.t,
        arriveT: this.t + Math.max(0.25, dist / speed) * HOUR, legKm: dist,
        ctrl: {
          lat: (from.lat + target.lat) / 2 - (target.lng - from.lng) * off,
          lng: (from.lng + target.lng) / 2 + (target.lat - from.lat) * off,
        },
      });
      a.prevSite = a.siteId; a.siteId = null;
      this.report(a, true);
    }

    arrive(a) {
      const siteId = a.to.siteId;
      a.km += Math.round(a.legKm);
      a.lat = a.to.lat; a.lng = a.to.lng;
      if (!siteId) { a.state = 'parked'; this.report(a); return; }
      const site = this.siteById[siteId];
      Object.assign(a, { state: 'site', siteId, visitStart: this.t, dwellUntil: this.t + this.dwellDuration(siteId) });
      this.visits.push({ assetId: a.id, type: a.type, siteId, enter: this.t, exit: null });
      if (this.visits.length > 4000) this.visits.splice(0, this.visits.length - 4000);
      this.log('enter', `${a.id} entered ${site.name}`, a.id);
      if (siteId === a.circuit[0] && !a.detour) {
        if (a.cycleStart) this.cycles.push({ type: a.type, t: this.t, days: (this.t - a.cycleStart) / DAY });
        if (this.cycles.length > 2000) this.cycles.shift();
        a.cycleStart = this.t; a.cycleCount++; a.sinceMaint++;
      }
      if (siteId === 'SRM') { a.sinceMaint = 0; a.maintenanceDue = false; }
      if (a.fill !== null) {
        if (site.type === 'Supplier' || site.type === 'Port') a.fill = Math.round(85 + this.rnd() * 15);
        if (site.type === 'Customer') a.fill = Math.round(this.rnd() * 10);
      }
      this.report(a);
    }

    closeVisit(a) {
      for (let i = this.visits.length - 1; i >= 0; i--) {
        const v = this.visits[i];
        if (v.assetId === a.id && v.exit === null) { v.exit = this.t; break; }
      }
      this.log('exit', `${a.id} left ${this.siteById[a.siteId].name}`, a.id);
    }

    position(a) {
      const u = Math.min(1, (this.t - a.departT) / (a.arriveT - a.departT));
      const p0 = a.from, c = a.ctrl, p1 = a.to, v = 1 - u;
      return { u, lat: v * v * p0.lat + 2 * v * u * c.lat + u * u * p1.lat, lng: v * v * p0.lng + 2 * v * u * c.lng + u * u * p1.lng };
    }

    // ---------- tracker reporting ----------
    report(a, moving) {
      if (a.battery <= 0) return;
      const isMoving = moving ?? (a.state === 'transit' || a.state === 'rogue');
      a.battery = Math.max(0, +(a.battery - (a.tracker === 'BLE tag' ? 0.002 : 0.006)).toFixed(3));
      if (a.sensors.includes('temp')) {
        const hr = new Date(this.t).getHours() + new Date(this.t).getMinutes() / 60;
        let temp = 11 + 6 * Math.sin(((hr - 9) / 24) * 2 * Math.PI) + a.tempBias + (this.rnd() - 0.5);
        if (a.tempSpikeUntil && this.t < a.tempSpikeUntil) temp += 19;
        a.temp = +temp.toFixed(1);
        a.tempHist.push({ t: this.t, v: a.temp });
        if (a.tempHist.length > 96) a.tempHist.shift();
      }
      const site = a.state === 'site' ? this.siteById[a.siteId] : null;
      a.rep = { lat: a.lat, lng: a.lng, t: this.t, siteId: site ? site.id : null, moving: isMoving };
      a.trail.push({ lat: a.lat, lng: a.lng, t: this.t });
      if (a.trail.length > 80) a.trail.shift();
    }

    maybeReport(a) {
      const since = this.t - a.rep.t;
      if (a.tracker === 'BLE tag') {
        // BLE tags are only heard by gateways installed inside geozones.
        if (a.state === 'site' && (since >= HOUR || a.rep.siteId !== a.siteId)) this.report(a);
        return;
      }
      const interval = a.state === 'transit' || a.state === 'rogue' ? 15 * MIN : 6 * HOUR;
      if (since >= interval) this.report(a);
    }

    // ---------- main loop ----------
    step(dtMin) {
      const prevHour = Math.floor(this.t / HOUR);
      this.t += dtMin * MIN;
      for (const a of this.assets) {
        a.totalMin += dtMin;
        if (a.state === 'site' && this.t >= a.dwellUntil) this.depart(a, this.nextDest(a));
        if (a.state === 'transit' || a.state === 'rogue') {
          a.transitMin += dtMin; a.useMin += dtMin;
          const p = this.position(a);
          a.lat = p.lat; a.lng = p.lng;
          if (p.u >= 1) this.arrive(a);
        } else if (a.state === 'site' && USE_SITE_TYPES.has(this.siteById[a.siteId].type)) {
          a.useMin += dtMin;
        }
        this.maybeReport(a);
      }
      if (Math.floor(this.t / HOUR) !== prevHour) this.snapshot();
      this.evaluate();
    }

    stockBySite() {
      const stock = Object.fromEntries(this.sites.map((s) => [s.id, 0]));
      for (const a of this.assets) if (a.rep.siteId && !a.rep.moving) stock[a.rep.siteId]++;
      return stock;
    }

    snapshot() {
      const stock = this.stockBySite();
      const transit = this.assets.filter((a) => a.rep.moving || (!a.rep.siteId)).length;
      this.history.push({ t: this.t, stock, transit });
      if (this.history.length > 24 * 14) this.history.shift();
    }

    // ---------- alerts ----------
    raise(key, severity, kind, targetId, msg) {
      const ex = this.active.get(key);
      if (ex) { ex.msg = msg; return; }
      const al = { id: ++this.alertSeq, key, t: this.t, severity, kind, targetId, msg, status: 'open' };
      this.active.set(key, al);
      this.alerts.unshift(al);
      if (this.alerts.length > 500) this.alerts.pop();
      this.log('alert', `${kind}: ${msg}`, targetId);
    }
    resolve(key) {
      const al = this.active.get(key);
      if (!al) return;
      al.status = 'resolved'; al.resolvedT = this.t;
      this.active.delete(key);
    }
    check(cond, key, ...args) { cond ? this.raise(key, ...args) : this.resolve(key); }

    evaluate() {
      const idleMs = this.settings.idleDays * DAY;
      for (const a of this.assets) {
        this.check(a.battery < 15, `bat:${a.id}`, 'warning', 'Low battery', a.id, `${a.id} battery at ${Math.round(a.battery)}%`);
        this.check(a.temp !== null && (a.temp > 25 || a.temp < 2), `temp:${a.id}`, 'critical', 'Temperature excursion', a.id,
          `${a.id} reports ${a.temp}°C (allowed 2–25°C)`);
        const idle = a.state === 'site' && this.t - a.visitStart > idleMs;
        this.check(idle, `idle:${a.id}`, 'warning', 'Idle asset', a.id,
          idle ? `${a.id} idle at ${this.siteById[a.siteId].name} for ${((this.t - a.visitStart) / DAY).toFixed(1)} days` : '');
        const rogue = (a.state === 'rogue' || a.state === 'parked') && !a.rep.siteId && a.rep.t > a.departT;
        this.check(rogue, `move:${a.id}`, 'critical', 'Unexpected movement', a.id, `${a.id} moved outside all geozones`);
        this.check(this.t - a.rep.t > 48 * HOUR, `off:${a.id}`, 'warning', 'Tracker offline', a.id, `${a.id} silent for over 48 h`);
        if (a.sinceMaint >= this.settings.maintEvery) a.maintenanceDue = true;
        this.check(!!a.maintenanceDue, `maint:${a.id}`, 'info', 'Maintenance due', a.id, `${a.id} completed ${a.sinceMaint} cycles since service`);
      }
      const stock = this.stockBySite();
      for (const s of this.sites) {
        this.check(stock[s.id] < s.min, `low:${s.id}`, 'warning', 'Low stock', s.id, `${s.name}: ${stock[s.id]} assets (min ${s.min})`);
        this.check(stock[s.id] > s.max, `over:${s.id}`, 'info', 'Overstock', s.id, `${s.name}: ${stock[s.id]} assets (max ${s.max})`);
      }
    }

    log(kind, msg, ref) {
      this.events.unshift({ t: this.t, kind, msg, ref });
      if (this.events.length > 300) this.events.pop();
    }

    // ---------- derived ----------
    statusOf(a) {
      if (this.active.has(`move:${a.id}`) || this.active.has(`temp:${a.id}`)) return 'alert';
      if (this.active.has(`off:${a.id}`) || a.battery <= 0) return 'offline';
      if (a.rep.moving) return 'transit';
      if (!a.rep.siteId) return 'offsite';
      if (this.active.has(`idle:${a.id}`)) return 'idle';
      return 'site';
    }

    // ---------- scenarios ----------
    pick(filter) {
      const pool = this.assets.filter(filter);
      return pool.length ? pool[Math.floor(this.rnd() * pool.length)] : null;
    }
    scenarioTheft() {
      const a = this.pick((x) => x.state === 'site' && x.tracker !== 'BLE tag');
      if (!a) return null;
      let target;
      for (let i = 0; i < 30; i++) {
        const ang = this.rnd() * Math.PI * 2, km = 15 + this.rnd() * 20;
        target = { lat: a.lat + (Math.sin(ang) * km) / 111, lng: a.lng + (Math.cos(ang) * km) / (111 * Math.cos((a.lat * Math.PI) / 180)) };
        if (this.nearestSite(target.lat, target.lng).km > 8 && target.lng < 45.9) break;
      }
      this.depart(a, target, true);
      this.log('scenario', `Scenario: ${a.id} taken off-route`, a.id);
      return a;
    }
    scenarioTemp() {
      const a = this.pick((x) => x.sensors.includes('temp'));
      if (!a) return null;
      a.tempSpikeUntil = this.t + 8 * HOUR;
      this.report(a); this.evaluate();
      this.log('scenario', `Scenario: heat exposure on ${a.id}`, a.id);
      return a;
    }
    scenarioBattery() {
      const a = this.pick((x) => x.battery > 15);
      if (!a) return null;
      a.battery = 9; this.report(a); this.evaluate();
      this.log('scenario', `Scenario: ${a.id} battery drained`, a.id);
      return a;
    }
    scenarioLost() {
      const a = this.pick((x) => x.state === 'site' && x.siteId !== 'SRM');
      if (!a) return null;
      a.dwellUntil = Infinity;
      a.visitStart = this.t - (this.settings.idleDays + 0.5) * DAY;
      this.evaluate();
      this.log('scenario', `Scenario: ${a.id} forgotten at ${this.siteById[a.siteId].name}`, a.id);
      return a;
    }
    scenarioShortage(siteId = 'SIZ') {
      const here = this.assets.filter((x) => x.state === 'site' && x.siteId === siteId);
      here.slice(3).forEach((a) => (a.dwellUntil = this.t));
      this.log('scenario', `Scenario: mass dispatch from ${this.siteById[siteId].name}`, siteId);
      return here.length - 3;
    }
    recover(a) {
      if (a.state === 'rogue' || a.state === 'parked') {
        a.state = 'parked';
        this.depart(a, a.circuit[a.ci]);
        this.log('scenario', `${a.id} recovered, returning to ${this.siteById[a.circuit[a.ci]].name}`, a.id);
      } else if (a.state === 'site') {
        a.dwellUntil = this.t;
      }
    }
    sendToMaintenance(a) {
      a.maintenanceDue = true;
      if (a.state === 'site' && a.siteId !== 'SRM') { a.detour = true; this.depart(a, 'SRM'); }
    }
    replaceBattery(a) { a.battery = 100; this.report(a); this.evaluate(); }
  }

  global.AP = { Sim, SITES, TYPES, haversine, MIN, HOUR, DAY };
})(window);
