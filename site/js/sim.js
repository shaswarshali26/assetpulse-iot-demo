// AssetPulse simulation engine: moves non-powered assets between geozones in
// cities across Iraq and emulates how low-power trackers report (sparse,
// delayed, gateway-only for BLE).
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

  const SITE_DEFAULTS = {
    'Plant':           { r: 1200, min: 6, max: 60, dwellH: 8 },
    'Port':            { r: 1500, min: 4, max: 60, dwellH: 14 },
    'Border crossing': { r: 1200, min: 3, max: 50, dwellH: 14 },
    'Warehouse':       { r: 1000, min: 3, max: 40, dwellH: 8 },
    'Supplier':        { r: 900,  min: 2, max: 30, dwellH: 10 },
    'Customer':        { r: 1000, min: 2, max: 35, dwellH: 16 },
    'Repair':          { r: 700,  min: 0, max: 15, dwellH: 30 },
  };

  // Site tuples: [id, short label, full name, type, lat, lng]
  const CITIES = [
    { id: 'SLY', name: 'Sulaymaniyah', lat: 35.5613, lng: 45.4373, weight: 1.3, sites: [
      ['SIZ', 'Industrial Zone', 'Sulaymaniyah Industrial Zone', 'Plant', 35.5235, 45.356],
      ['BSH', 'Bashmakh', 'Bashmakh Border Crossing', 'Border crossing', 35.583, 46.03],
      ['ARB', 'Arbat', 'Arbat Logistics Hub', 'Warehouse', 35.422, 45.575],
      ['TSL', 'Tasluja', 'Tasluja Cement Supplier', 'Supplier', 35.615, 45.255],
      ['CHM', 'Chamchamal', 'Chamchamal Construction Site', 'Customer', 35.529, 44.829],
      ['DKN', 'Dukan', 'Dukan Materials Supplier', 'Supplier', 35.954, 44.953],
      ['SRM', 'Repair Center', 'Sulaymaniyah Repair & Maintenance', 'Repair', 35.572, 45.425],
      ['DBK', 'Darbandikhan', 'Darbandikhan Cross-Dock', 'Warehouse', 35.113, 45.706],
    ] },
    { id: 'EBL', name: 'Erbil', lat: 36.191, lng: 44.009, weight: 1.3, sites: [
      ['EBL-IZ', 'Industrial Zone', 'Erbil Industrial Zone', 'Plant', 36.13, 44.07],
      ['EBL-LH', 'Logistics Hub', 'Erbil Logistics Hub', 'Warehouse', 36.24, 43.96],
      ['EBL-CS', 'Gulan Site', 'Erbil Gulan Construction Site', 'Customer', 36.2, 44.03],
      ['EBL-SU', 'Steel Supplier', 'Erbil Steel Supplier', 'Supplier', 36.3, 44.1],
      ['EBL-RP', 'Repair Center', 'Erbil Repair & Maintenance', 'Repair', 36.17, 43.98],
    ] },
    { id: 'DHK', name: 'Duhok', lat: 36.867, lng: 42.988, weight: 0.8, sites: [
      ['DHK-IZ', 'Industrial Zone', 'Duhok Industrial Zone', 'Plant', 36.84, 42.95],
      ['DHK-IK', 'Ibrahim Khalil', 'Ibrahim Khalil Border Crossing', 'Border crossing', 37.11, 42.36],
      ['DHK-WH', 'Distribution', 'Duhok Distribution Center', 'Warehouse', 36.87, 43.02],
      ['DHK-ZK', 'Zakho Site', 'Zakho Customer Site', 'Customer', 37.14, 42.68],
    ] },
    { id: 'MSL', name: 'Mosul', lat: 36.34, lng: 43.13, weight: 1.0, sites: [
      ['MSL-IZ', 'Industrial Area', 'Mosul Industrial Area', 'Plant', 36.3, 43.18],
      ['MSL-WH', 'Logistics Hub', 'Mosul Logistics Hub', 'Warehouse', 36.38, 43.1],
      ['MSL-CS', 'Reconstruction', 'Mosul Reconstruction Site', 'Customer', 36.35, 43.14],
      ['MSL-SU', 'Hammam al-Alil', 'Hammam al-Alil Cement Supplier', 'Supplier', 36.16, 43.25],
    ] },
    { id: 'KRK', name: 'Kirkuk', lat: 35.468, lng: 44.392, weight: 0.9, sites: [
      ['KRK-IZ', 'Industrial Zone', 'Kirkuk Industrial Zone', 'Plant', 35.43, 44.42],
      ['KRK-WH', 'Logistics Hub', 'Kirkuk Logistics Hub', 'Warehouse', 35.48, 44.36],
      ['KRK-OF', 'Oil Field', 'Kirkuk Oil Field Services', 'Customer', 35.52, 44.33],
    ] },
    { id: 'BGW', name: 'Baghdad', lat: 33.315, lng: 44.366, weight: 1.6, sites: [
      ['BGW-IZ', 'Zafaraniya', 'Baghdad Zafaraniya Industrial Zone', 'Plant', 33.25, 44.48],
      ['BGW-AC', 'Airport Cargo', 'Baghdad Airport Cargo Terminal', 'Warehouse', 33.27, 44.23],
      ['BGW-CS', 'City Site', 'Baghdad Construction Site', 'Customer', 33.33, 44.4],
      ['BGW-SU', 'Taji Supplier', 'Taji Materials Supplier', 'Supplier', 33.52, 44.27],
      ['BGW-RP', 'Repair Center', 'Baghdad Repair & Maintenance', 'Repair', 33.36, 44.33],
    ] },
    { id: 'RMD', name: 'Ramadi', lat: 33.42, lng: 43.3, weight: 0.6, sites: [
      ['RMD-WH', 'Logistics Hub', 'Ramadi Logistics Hub', 'Warehouse', 33.43, 43.27],
      ['RMD-CS', 'Infrastructure', 'Anbar Infrastructure Site', 'Customer', 33.4, 43.35],
    ] },
    { id: 'KRB', name: 'Karbala', lat: 32.616, lng: 44.025, weight: 0.7, sites: [
      ['KRB-WH', 'Logistics Hub', 'Karbala Logistics Hub', 'Warehouse', 32.6, 44.05],
      ['KRB-CS', 'City Site', 'Karbala Construction Site', 'Customer', 32.63, 44.0],
    ] },
    { id: 'NJF', name: 'Najaf', lat: 32.0, lng: 44.33, weight: 0.8, sites: [
      ['NJF-AP', 'Airport Cargo', 'Najaf Airport Cargo', 'Warehouse', 31.99, 44.4],
      ['NJF-SU', 'Kufa Cement', 'Kufa Cement Supplier', 'Supplier', 32.05, 44.42],
      ['NJF-CS', 'City Site', 'Najaf Customer Site', 'Customer', 32.02, 44.31],
    ] },
    { id: 'BSR', name: 'Basra', lat: 30.508, lng: 47.78, weight: 1.4, sites: [
      ['BSR-UQ', 'Umm Qasr Port', 'Umm Qasr Port', 'Port', 30.03, 47.95],
      ['BSR-IZ', 'Khor Al-Zubair', 'Khor Al-Zubair Industrial Zone', 'Plant', 30.18, 47.86],
      ['BSR-OF', 'Rumaila', 'Rumaila Oil Field Services', 'Customer', 30.43, 47.33],
      ['BSR-WH', 'Distribution', 'Basra Distribution Center', 'Warehouse', 30.5, 47.75],
      ['BSR-RP', 'Repair Center', 'Basra Repair & Maintenance', 'Repair', 30.53, 47.82],
    ] },
  ];

  const SITES = CITIES.flatMap((c) => c.sites.map(([id, short, name, type, lat, lng]) =>
    ({ id, short, name, type, lat, lng, city: c.id, ...SITE_DEFAULTS[type] })));

  // Local fleets build their circuit from site roles available in their city
  // ("A|B" = first role the city has). Long-haul trailers run fixed inter-city routes.
  const TYPES = {
    'Stillage':          { prefix: 'STL', base: 8, roles: ['Supplier', 'Plant', 'Customer', 'Plant'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 50 },
    'Roll cage':         { prefix: 'RLC', base: 6, roles: ['Warehouse', 'Customer', 'Warehouse', 'Plant'], tracker: 'BLE tag', conn: 'BLE gateway', speed: 45 },
    'IBC container':     { prefix: 'IBC', base: 5, roles: ['Port|Border crossing|Supplier', 'Supplier', 'Customer'], tracker: 'Condition sensor', conn: 'NB-IoT', speed: 47, sensors: ['temp', 'fill'] },
    'Trailer':           { prefix: 'TRL', base: 4, roles: ['Port|Border crossing|Warehouse', 'Plant', 'Warehouse', 'Customer'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 63 },
    'Tooling jig':       { prefix: 'JIG', base: 3, roles: ['Plant', 'Repair', 'Plant', 'Supplier'], tracker: 'Smart tracker', conn: 'LTE-M', speed: 45 },
    'Pallet box':        { prefix: 'PLB', base: 6, roles: ['Supplier', 'Plant', 'Warehouse'], tracker: 'BLE tag', conn: 'BLE gateway', speed: 49 },
    'Long-haul trailer': { prefix: 'LHT', perRoute: 5, tracker: 'Smart tracker', conn: 'LTE-M', speed: 80, routes: [
      ['BSR-UQ', 'BGW-IZ', 'BGW-AC', 'BSR-WH'],
      ['BSR-UQ', 'NJF-AP', 'KRB-WH', 'BGW-AC'],
      ['DHK-IK', 'MSL-WH', 'EBL-LH', 'KRK-WH'],
      ['BSH', 'SIZ', 'KRK-WH', 'EBL-LH'],
      ['BGW-AC', 'RMD-WH', 'BGW-IZ', 'KRK-WH'],
      ['EBL-LH', 'KRK-WH', 'BGW-AC', 'BGW-IZ'],
    ] },
  };

  const USE_SITE_TYPES = new Set(['Plant', 'Customer']);
  const NO_THEFT_TYPES = new Set(['Border crossing', 'Port']);

  class Sim {
    constructor(seed = 7) { this.reset(seed); }

    reset(seed = this.seed) {
      this.seed = seed;
      this.rnd = mulberry32(seed);
      this.cities = CITIES.map(({ sites, ...c }) => c);
      this.cityById = Object.fromEntries(this.cities.map((c) => [c.id, c]));
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
      this.assetById = {};

      const seq = {};
      const add = (type, def, home, circuit) => {
        seq[type] = (seq[type] || 1000) + 1;
        const ci = Math.floor(this.rnd() * circuit.length);
        const a = {
          id: `${def.prefix}-${seq[type]}`, type, home, tracker: def.tracker, conn: def.conn,
          sensors: def.sensors || [], circuit, ci, speed: def.speed,
          state: 'site', siteId: circuit[ci], battery: Math.round(30 + this.rnd() * 70),
          trail: [], tempHist: [], km: Math.round(this.rnd() * 4000), cycleCount: 0, cycleStart: null,
          sinceMaint: Math.floor(this.rnd() * 10), transitMin: 0, useMin: 0, totalMin: 0,
          tempBias: (this.rnd() - 0.5) * 3, fill: def.sensors ? Math.round(this.rnd() * 100) : null, temp: null,
        };
        this.placeAt(a, a.siteId);
        a.visitStart = this.t - this.rnd() * this.siteById[a.siteId].dwellH * HOUR;
        a.dwellUntil = this.t + this.dwellDuration(a.siteId) * this.rnd();
        this.report(a);
        this.assets.push(a);
        this.assetById[a.id] = a;
      };

      for (const city of this.cities) {
        const citySites = this.sites.filter((s) => s.city === city.id);
        for (const [type, def] of Object.entries(TYPES)) {
          if (!def.roles) continue;
          if (new Set(this.buildCircuit(def.roles, citySites)).size < 2) continue;
          const n = Math.round(def.base * city.weight);
          for (let i = 0; i < n; i++) {
            let c = this.buildCircuit(def.roles, citySites);
            if (new Set(c).size < 2) c = this.buildCircuit(def.roles, citySites);
            if (new Set(c).size >= 2) add(type, def, city.id, c);
          }
        }
      }
      const lh = TYPES['Long-haul trailer'];
      for (const route of lh.routes) {
        for (let i = 0; i < lh.perRoute; i++) add('Long-haul trailer', lh, this.siteById[route[0]].city, route);
      }

      // Warm up 10 days so history, visits and analytics have data on first load.
      const end = this.t + 10 * DAY;
      while (this.t < end) this.step(10);
    }

    buildCircuit(roles, citySites) {
      const out = [];
      for (const role of roles) {
        const alts = role.split('|');
        for (const r of alts) {
          const cands = citySites.filter((s) => s.type === r);
          if (cands.length) { out.push(cands[Math.floor(this.rnd() * cands.length)].id); break; }
        }
      }
      const c = out.filter((id, i) => id !== out[(i + 1) % out.length] || out.length === 1);
      return c;
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
    nearestSite(lat, lng, filter) {
      let best = null, bd = Infinity;
      for (const s of this.sites) {
        if (filter && !filter(s)) continue;
        const d = haversine(s, { lat, lng });
        if (d < bd) { bd = d; best = s; }
      }
      return { site: best, km: bd };
    }
    cityOf(a) {
      if (a.rep.siteId) return this.siteById[a.rep.siteId].city;
      return this.nearestSite(a.rep.lat, a.rep.lng).site.city;
    }
    cityOfTarget(id) {
      if (this.assetById[id]) return this.cityOf(this.assetById[id]);
      if (this.siteById[id]) return this.siteById[id].city;
      return null;
    }
    nearestRepair(a) {
      return this.nearestSite(a.lat, a.lng, (s) => s.type === 'Repair').site.id;
    }
    dwellDuration(siteId) {
      const s = this.siteById[siteId];
      let h = s.dwellH * (0.5 + this.rnd());
      if (this.rnd() < 0.05) h *= 3;
      return h * HOUR;
    }

    // ---------- movement ----------
    nextDest(a) {
      const atRepair = this.siteById[a.siteId].type === 'Repair';
      if (a.maintenanceDue && !atRepair && this.rnd() < 0.5) { a.detour = true; return this.nearestRepair(a); }
      if (a.detour) { a.detour = false; return a.circuit[a.ci]; }
      a.ci = (a.ci + 1) % a.circuit.length;
      return a.circuit[a.ci];
    }

    depart(a, to, rogue = false) {
      const from = { lat: a.lat, lng: a.lng };
      const target = typeof to === 'string' ? { ...this.jitter(this.siteById[to]), siteId: to } : { ...to, siteId: null };
      const dist = haversine(from, target) * 1.3;
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
      if (this.visits.length > 12000) this.visits.splice(0, this.visits.length - 12000);
      if (siteId === a.circuit[0] && !a.detour) {
        if (a.cycleStart) this.cycles.push({ type: a.type, city: site.city, t: this.t, days: (this.t - a.cycleStart) / DAY });
        if (this.cycles.length > 4000) this.cycles.shift();
        a.cycleStart = this.t; a.cycleCount++; a.sinceMaint++;
      }
      if (site.type === 'Repair') { a.sinceMaint = 0; a.maintenanceDue = false; }
      if (a.fill !== null) {
        if (site.type === 'Supplier' || site.type === 'Port' || site.type === 'Border crossing') a.fill = Math.round(85 + this.rnd() * 15);
        if (site.type === 'Customer') a.fill = Math.round(this.rnd() * 10);
      }
      this.report(a);
      this.log('enter', `${a.id} entered ${site.name}`, a.id);
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
      this.history.push({ t: this.t, stock: this.stockBySite() });
      if (this.history.length > 24 * 14) this.history.shift();
    }

    // ---------- alerts ----------
    raise(key, severity, kind, targetId, msg) {
      const ex = this.active.get(key);
      if (ex) { ex.msg = msg; return; }
      const al = { id: ++this.alertSeq, key, t: this.t, severity, kind, targetId, msg, status: 'open', city: this.cityOfTarget(targetId) };
      this.active.set(key, al);
      this.alerts.unshift(al);
      if (this.alerts.length > 1500) this.alerts.pop();
      this.log('alert', `${kind}: ${msg}`, targetId, al.city);
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

    log(kind, msg, ref, city) {
      this.events.unshift({ t: this.t, kind, msg, ref, city: city ?? this.cityOfTarget(ref) });
      if (this.events.length > 600) this.events.pop();
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

    // ---------- scenarios (optionally limited to one city) ----------
    pick(filter, city) {
      const pool = this.assets.filter((a) => filter(a) && (!city || this.cityOf(a) === city));
      return pool.length ? pool[Math.floor(this.rnd() * pool.length)] : null;
    }
    scenarioTheft(city) {
      const a = this.pick((x) => x.state === 'site' && x.tracker !== 'BLE tag' && !NO_THEFT_TYPES.has(this.siteById[x.siteId].type), city);
      if (!a) return null;
      let target;
      for (let i = 0; i < 40; i++) {
        const ang = this.rnd() * Math.PI * 2, km = 15 + this.rnd() * 20;
        target = { lat: a.lat + (Math.sin(ang) * km) / 111, lng: a.lng + (Math.cos(ang) * km) / (111 * Math.cos((a.lat * Math.PI) / 180)) };
        const n = this.nearestSite(target.lat, target.lng).km;
        if (n > 8 && n < 45) break;
      }
      this.depart(a, target, true);
      this.log('scenario', `Scenario: ${a.id} taken off-route`, a.id);
      return a;
    }
    scenarioTemp(city) {
      const a = this.pick((x) => x.sensors.includes('temp'), city);
      if (!a) return null;
      a.tempSpikeUntil = this.t + 8 * HOUR;
      this.report(a); this.evaluate();
      this.log('scenario', `Scenario: heat exposure on ${a.id}`, a.id);
      return a;
    }
    scenarioBattery(city) {
      const a = this.pick((x) => x.battery > 15, city);
      if (!a) return null;
      a.battery = 9; this.report(a); this.evaluate();
      this.log('scenario', `Scenario: ${a.id} battery drained`, a.id);
      return a;
    }
    scenarioLost(city) {
      const a = this.pick((x) => x.state === 'site' && this.siteById[x.siteId].type !== 'Repair', city);
      if (!a) return null;
      a.dwellUntil = Infinity;
      a.visitStart = this.t - (this.settings.idleDays + 0.5) * DAY;
      this.evaluate();
      this.log('scenario', `Scenario: ${a.id} forgotten at ${this.siteById[a.siteId].name}`, a.id);
      return a;
    }
    scenarioShortage(city) {
      const stock = this.stockBySite();
      const plants = this.sites.filter((s) => s.type === 'Plant' && (!city || s.city === city));
      const pool = plants.length ? plants : this.sites.filter((s) => !city || s.city === city);
      if (!pool.length) return null;
      const site = pool.reduce((b, s) => (stock[s.id] > stock[b.id] ? s : b));
      const here = this.assets.filter((x) => x.state === 'site' && x.siteId === site.id);
      here.slice(2).forEach((a) => (a.dwellUntil = this.t));
      this.log('scenario', `Scenario: mass dispatch from ${site.name}`, site.id);
      return { site, count: Math.max(0, here.length - 2) };
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
      if (a.state === 'site' && this.siteById[a.siteId].type !== 'Repair') {
        const to = this.nearestRepair(a);
        a.detour = true; this.depart(a, to);
        return this.siteById[to];
      }
      return null;
    }
    replaceBattery(a) { a.battery = 100; this.report(a); this.evaluate(); }
  }

  global.AP = { Sim, SITES, CITIES, TYPES, haversine, MIN, HOUR, DAY };
})(window);
