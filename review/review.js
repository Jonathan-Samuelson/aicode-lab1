/* Location-review map for the Givat Ram campus.
 * Data: window.REVIEW_DATA (generated from the stored OSM snapshot).
 * User corrections live in localStorage and can be exported/imported as JSON.
 */
(function () {
  "use strict";

  const DATA = window.REVIEW_DATA;
  const STORE_KEY = "givatram-location-review-v1";
  const SCHEMA = "givat-ram-location-review/1";
  const MAX_CONNECTOR_M = 40; // beyond this an approximate link is not considered reasonable
  const DOOR_TOL_M = 1.5; // an entrance this close to a building outline is treated as being on that wall
  const CONF_LABELS = { field: "אומת בשטח", official_map: "לפי מפה רשמית", estimate: "הערכה" };

  // ---------- state ----------
  function blankState() {
    const destinations = {};
    for (const d of DATA.destinations) destinations[d.id] = { building: null, entrances: [], note: "" };
    return { schema: SCHEMA, base_data: "OSM snapshot " + DATA.generated, destinations };
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.schema === SCHEMA) return mergeState(s);
    } catch (e) { /* fall through */ }
    return blankState();
  }
  function mergeState(s) {
    const base = blankState();
    for (const id of Object.keys(base.destinations)) {
      const src = s.destinations && s.destinations[id];
      if (src) base.destinations[id] = { building: src.building || null, entrances: src.entrances || [], note: src.note || "" };
    }
    return base;
  }
  let state = loadState();
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    document.getElementById("save-state").textContent = "נשמר בדפדפן: " + new Date().toLocaleTimeString("he-IL");
  }

  // ---------- geometry (local metric plane) ----------
  const LAT0 = (DATA.bbox[0] + DATA.bbox[2]) / 2;
  const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
  const toXY = (lon, lat) => [lon * KX, lat * KY];
  const toLonLat = (x, y) => [x / KX, y / KY];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function nearestOnSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  }
  function segIntersect(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }
  function pointInRing(p, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  const walkSegs = [];
  for (const f of DATA.paths.features) {
    if (f.properties.class !== "walk") continue;
    const cs = f.geometry.coordinates.map(c => toXY(c[0], c[1]));
    for (let i = 0; i < cs.length - 1; i++) walkSegs.push({ a: cs[i], b: cs[i + 1], props: f.properties });
  }
  const obstacles = []; // {ring:[xy], label, url, kind}
  for (const f of DATA.buildings.features) {
    obstacles.push({ ring: f.geometry.coordinates[0].map(c => toXY(c[0], c[1])), kind: "building",
      label: f.properties.name || "בניין ללא שם", url: f.properties.url, closed: true });
  }
  for (const f of DATA.barriers.features) {
    obstacles.push({ ring: f.geometry.coordinates.map(c => toXY(c[0], c[1])), kind: "barrier",
      label: f.properties.barrier, url: f.properties.url, closed: false });
  }

  /** Approximate link from an entrance to the walk network, checked against mapped obstacles. */
  function analyseEntrance(lon, lat) {
    const p = toXY(lon, lat);
    let best = null;
    for (const s of walkSegs) {
      const q = nearestOnSeg(p, s.a, s.b), d = dist(p, q);
      if (!best || d < best.d) best = { d, q, props: s.props };
    }
    const res = { distance_m: best ? Math.round(best.d * 10) / 10 : null, path: best && best.props,
      end: best && toLonLat(best.q[0], best.q[1]), crosses: [], insideBuilding: null, reasonable: false };
    if (!best) return res;
    for (const o of obstacles) {
      if (o.closed && pointInRing(p, o.ring)) { res.insideBuilding = o; continue; }
      // The building whose wall the door sits on (outline within DOOR_TOL_M) may be touched at the door end.
      let ownWall = false;
      if (o.closed) for (let i = 0; i < o.ring.length - 1 && !ownWall; i++) ownWall = dist(p, nearestOnSeg(p, o.ring[i], o.ring[i + 1])) <= DOOR_TOL_M;
      for (let i = 0; i < o.ring.length - 1; i++) {
        const x = segIntersect(p, best.q, o.ring[i], o.ring[i + 1]);
        if (x && (!ownWall || dist(x, p) > DOOR_TOL_M) && dist(x, best.q) > 0.5) { res.crosses.push(o); break; }
      }
    }
    res.reasonable = best.d <= MAX_CONNECTOR_M && res.crosses.length === 0 && !res.insideBuilding;
    return res;
  }

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true });
  map.fitBounds([[DATA.bbox[0], DATA.bbox[1]], [DATA.bbox[2], DATA.bbox[3]]]);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  document.getElementById("tog-tiles").addEventListener("change", e => e.target.checked ? tiles.addTo(map) : map.removeLayer(tiles));

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>`;

  // which OSM buildings are destination/candidate buildings
  const role = {}; // osm id -> {kind, destName}
  for (const d of DATA.destinations) for (const c of d.candidates) {
    if (!c.osm || !c.osm.startsWith("way/")) continue;
    role[c.osm] = { kind: d.status === "verified" ? "verified" : "candidate", dest: d.name };
  }

  L.geoJSON(DATA.paths, {
    style: f => {
      const c = f.properties.class;
      if (c === "walk") return { color: "#1565c0", weight: f.properties.highway === "steps" ? 4 : 2.5, opacity: .75, dashArray: f.properties.highway === "steps" ? "2 3" : null };
      if (c === "restricted") return { color: "#c62828", weight: 3, dashArray: "6 4" };
      return { color: "#000", weight: 2, dashArray: "1 4" };
    },
    onEachFeature: (f, l) => {
      const p = f.properties;
      l.bindPopup(`<b>${esc(p.name || "דרך ללא שם")}</b><br>highway=${esc(p.highway)}` +
        (p.foot ? `<br>foot=${esc(p.foot)}` : "") + (p.access ? `<br>access=${esc(p.access)}` : "") +
        `<br>סיווג: ${esc({ walk: "מותר להולכי רגל", restricted: "גישה מוגבלת", excluded: "מוחרג" }[p.class])}` +
        (p.reason ? ` (${esc(p.reason)})` : "") + `<br>${link(p.url, p.osm)}`);
    },
  }).addTo(map);

  L.geoJSON(DATA.buildings, {
    style: f => {
      const r = role[f.properties.osm];
      if (r && r.kind === "verified") return { color: "#2e7d32", weight: 2.5, fillColor: "#2e7d32", fillOpacity: .35 };
      if (r) return { color: "#f57f17", weight: 2, dashArray: "5 4", fillColor: "#f9a825", fillOpacity: .3 };
      return { color: "#9e9e9e", weight: 1, fillColor: "#9e9e9e", fillOpacity: .2 };
    },
    onEachFeature: (f, l) => {
      const p = f.properties, r = role[p.osm];
      let h = `<b>${esc(p.name || "בניין ללא שם ב-OSM")}</b>`;
      if (p.name_en) h += `<br>${esc(p.name_en)}`;
      if (r && r.kind === "verified") h += `<br><span style="color:#1b5e20">יעד מאומת: ${esc(r.dest)}</span>`;
      if (r && r.kind === "candidate") h += `<br><span style="color:#8a1c14">מועמד לא מאומת עבור: ${esc(r.dest)}</span>`;
      if (p.levels) h += `<br>קומות: ${esc(p.levels)}`;
      h += `<br>${link(p.url, p.osm)}`;
      l.bindPopup(h);
      if (r && r.kind === "verified") l.bindTooltip(r.dest, { permanent: true, direction: "center", className: "lbl" });
    },
  }).addTo(map);

  L.geoJSON(DATA.barriers, {
    style: { color: "#6d4c41", weight: 3 },
    onEachFeature: (f, l) => l.bindPopup(`barrier=${esc(f.properties.barrier)}<br>${link(f.properties.url, f.properties.osm)}`),
  }).addTo(map);
  L.geoJSON(DATA.gates, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4, color: "#6d4c41", fillColor: "#fff", fillOpacity: 1, weight: 2 }),
    onEachFeature: (f, l) => {
      const p = f.properties;
      l.bindPopup(`barrier=${esc(p.barrier)}` + (p.access ? `<br>access=${esc(p.access)}` : "") +
        (p.foot ? `<br>foot=${esc(p.foot)}` : "") + (p.name ? `<br>${esc(p.name)}` : "") + `<br>${link(p.url, p.osm)}`);
    },
  }).addTo(map);

  // shared Kaplan/Rothberg point and other point candidates (drawn once)
  const drawnPoints = new Set();
  for (const d of DATA.destinations) for (const c of d.candidates) {
    if (c.kind !== "point" || drawnPoints.has(c.osm)) continue;
    drawnPoints.add(c.osm);
    const names = DATA.destinations.filter(x => x.candidates.some(y => y.osm === c.osm)).map(x => x.name);
    L.circleMarker([c.lonlat[1], c.lonlat[0]], { radius: 8, color: "#fff", weight: 2, fillColor: "#f9a825", fillOpacity: 1 })
      .bindTooltip(names.join(" / ") + " – נקודה משותפת", { permanent: true, direction: "top", offset: [0, -8], className: "lbl uncertain" })
      .bindPopup(`<b>${esc(c.label)}</b><br>${esc(c.point_note)}<br>${esc(c.note)}<br>${link(c.source, c.osm)}`)
      .addTo(map);
  }
  // Canada Hall candidate labels
  for (const d of DATA.destinations) {
    d.candidates.filter(c => c.kind === "candidate").forEach((c, i) => {
      L.marker([c.lonlat[1], c.lonlat[0]], { opacity: 0, interactive: false })
        .bindTooltip(`${d.name}? מועמד ${i + 1}`, { permanent: true, direction: "center", className: "lbl uncertain" }).addTo(map);
    });
  }
  for (const lm of DATA.landmarks) {
    L.circleMarker([lm.lonlat[1], lm.lonlat[0]], { radius: 4, color: "#2e7d32", fillOpacity: 1 })
      .bindTooltip(lm.label, { permanent: true, direction: "bottom", className: "lbl" })
      .bindPopup(`<b>${esc(lm.label)}</b><br>ציון דרך ממופה<br>${link(lm.source, lm.osm)}`).addTo(map);
  }

  // ---------- user correction layer ----------
  const userLayer = L.layerGroup().addTo(map);
  const pinIcon = cls => L.divIcon({ className: "", html: `<div class="pin ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
  const destById = Object.fromEntries(DATA.destinations.map(d => [d.id, d]));

  function drawUser() {
    userLayer.clearLayers();
    for (const d of DATA.destinations) {
      const s = state.destinations[d.id];
      if (s.building) {
        const m = L.marker([s.building.lat, s.building.lon], { draggable: true, icon: pinIcon("bldg") })
          .bindTooltip(`${d.name} – מיקום בניין (${CONF_LABELS[s.building.confidence] || ""})`, { direction: "top", offset: [0, -8], className: "lbl" });
        m.on("dragend", e => { const ll = e.target.getLatLng(); setPoint(d.id, "building", null, ll, "drag"); });
        m.on("click", () => selectDest(d.id));
        userLayer.addLayer(m);
      }
      s.entrances.forEach((en, idx) => {
        const m = L.marker([en.lat, en.lon], { draggable: true, icon: pinIcon("ent") })
          .bindTooltip(`${d.name} – כניסה ${idx + 1}`, { direction: "top", offset: [0, -8], className: "lbl" });
        m.on("dragend", e => { const ll = e.target.getLatLng(); setPoint(d.id, "entrance", idx, ll, "drag"); });
        m.on("click", () => selectDest(d.id));
        userLayer.addLayer(m);
        const a = analyseEntrance(en.lon, en.lat);
        if (a.end) {
          userLayer.addLayer(L.polyline([[en.lat, en.lon], [a.end[1], a.end[0]]], {
            color: a.reasonable ? "#d9480f" : "#8a1c14", weight: 3, dashArray: "6 5",
          }).bindPopup(connectorHtml(a)));
          userLayer.addLayer(L.circleMarker([a.end[1], a.end[0]], { radius: 4, color: "#d9480f", fillColor: "#fff", fillOpacity: 1 })
            .bindPopup("נקודת קצה ברשת ההליכה הממופה<br>" + connectorHtml(a)));
        }
      });
    }
  }
  function connectorHtml(a) {
    let h = `<b>חיבור משוער – לא מאומת</b><br>מרחק לדרך הולכי רגל: ${a.distance_m} מ'`;
    if (a.path) h += `<br>דרך: ${esc(a.path.name || a.path.highway)} (${link(a.path.url, a.path.osm)})`;
    if (a.insideBuilding) h += `<br><span class="warn">הנקודה בתוך קווי מתאר של בניין (${esc(a.insideBuilding.label)}) – כניסה צריכה להיות על הקיר החיצוני.</span>`;
    for (const o of a.crosses) h += `<br><span class="warn">הקו חוצה ${o.kind === "building" ? "בניין" : "מחסום"}: ${link(o.url, o.label)}</span>`;
    if (a.distance_m > MAX_CONNECTOR_M) h += `<br><span class="warn">רחוק מ-${MAX_CONNECTOR_M} מ'.</span>`;
    if (!a.reasonable) h += `<br><span class="warn">לא ניתן לקבוע חיבור סביר. האפליקציה תציג את נקודת הקצה ברשת ותציין שהגישה האחרונה לא מאומתת.</span>`;
    return h;
  }

  function setPoint(destId, kind, idx, ll, method, extra) {
    const s = state.destinations[destId];
    const now = new Date().toISOString();
    const base = { lat: +ll.lat.toFixed(7), lon: +ll.lng.toFixed(7), method, updated_at: now };
    if (kind === "building") {
      // A drag keeps the original source reference but records that the point was moved by hand.
      s.building = Object.assign({ confidence: "estimate", note: "", source: null, source_ref: null, shared_with: null },
        s.building || {}, base, extra || {}, { moved_from_source: method === "drag" && !!(s.building && s.building.source_ref) });
      if (method === "drag") s.building.method = s.building.source_ref ? "candidate+drag" : "map-click+drag";
    } else if (idx == null) {
      s.entrances.push(Object.assign({ confidence: "estimate", note: "", step_free: "unknown" }, base));
    } else {
      Object.assign(s.entrances[idx], base);
    }
    save(); drawUser(); if (current === destId) renderDetail();
  }

  // ---------- panel ----------
  let current = null;
  function userBadge(id) {
    const s = state.destinations[id];
    const n = (s.building ? 1 : 0) + s.entrances.length;
    return n ? `<span class="badge user">${s.building ? "בניין ✓ " : ""}${s.entrances.length} כניסות</span>` : "";
  }
  function renderList() {
    const ul = document.getElementById("dest-list");
    ul.innerHTML = "";
    for (const d of DATA.destinations) {
      const li = document.createElement("li");
      li.className = d.id === current ? "active" : "";
      li.innerHTML = `<span>${esc(d.name)}</span><span>${userBadge(d.id)} <span class="badge ${d.status}">${esc({ verified: "מאומת", shared: "נקודה משותפת", unknown: "לא ידוע" }[d.status])}</span></span>`;
      li.addEventListener("click", () => selectDest(d.id));
      ul.appendChild(li);
    }
  }
  function selectDest(id) {
    current = id; renderList(); renderDetail();
    const d = destById[id], s = state.destinations[id];
    const pts = d.candidates.map(c => [c.lonlat[1], c.lonlat[0]]);
    if (s.building) pts.push([s.building.lat, s.building.lon]);
    s.entrances.forEach(e => pts.push([e.lat, e.lon]));
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.6), { maxZoom: 19 });
  }
  function renderDetail() {
    const d = destById[current], s = state.destinations[current];
    document.getElementById("dest-detail").hidden = false;
    document.getElementById("dd-name").textContent = d.name;
    const st = document.getElementById("dd-status");
    st.textContent = d.status_text; st.className = "status " + d.status;
    document.getElementById("dd-summary").textContent = d.summary;
    document.getElementById("dd-evidence").innerHTML = d.evidence.map(e =>
      `<li>${link(e.url, e.label)}${e.quote ? `<blockquote>"${esc(e.quote)}"</blockquote>` : ""}</li>`).join("") || "<li>אין</li>";

    const cl = document.getElementById("dd-candidates");
    cl.innerHTML = d.candidates.length ? "" : "<li>לא נמצאו מועמדים. ניתן לקבוע מיקום בלחיצה על המפה.</li>";
    d.candidates.forEach((c, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<b>${c.kind === "candidate" ? `מועמד ${i + 1}: ` : ""}${esc(c.label)}</b><br>${esc(c.note)}<br><span class="small">${esc(c.point_note)}</span><br>${link(c.source, c.osm)} `;
      const zoom = document.createElement("button"); zoom.textContent = "הצג";
      zoom.onclick = () => map.setView([c.lonlat[1], c.lonlat[0]], 19);
      const use = document.createElement("button"); use.textContent = "השתמש כמיקום הבניין";
      use.onclick = () => setPoint(current, "building", null, { lat: c.lonlat[1], lng: c.lonlat[0] }, "candidate",
        { source: c.source, source_ref: c.osm, shared_with: c.shared_with || null, confidence: d.status === "verified" ? "official_map" : "estimate" });
      li.append(zoom, " ", use);
      cl.appendChild(li);
    });

    const bd = document.getElementById("dd-building");
    bd.innerHTML = "";
    const card = document.createElement("div"); card.className = "card bldg";
    if (s.building) {
      const b = s.building;
      card.innerHTML = `<b>מיקום הבניין</b> ${b.lat}, ${b.lon}<br><span class="small">שיטה: ${esc(b.method)}${b.source_ref ? " · מקור: " + esc(b.source_ref) : ""}</span>` +
        (b.shared_with ? `<br><span class="warn small">נקודה משותפת עם יעד אחר – אינה קואורדינטה נפרדת.</span>` : "");
      card.appendChild(confSelect(b.confidence, v => { b.confidence = v; save(); drawUser(); }));
      card.appendChild(noteInput(b.note, v => { b.note = v; save(); }));
      const row = document.createElement("div"); row.className = "row";
      const del = document.createElement("button"); del.textContent = "מחק מיקום"; del.className = "danger";
      del.onclick = () => { s.building = null; save(); drawUser(); renderDetail(); renderList(); };
      row.appendChild(del); card.appendChild(row);
    } else {
      card.innerHTML = "<b>מיקום הבניין:</b> לא נקבע. בחר מועמד או סמן \"מיקום הבניין\" ולחץ על המפה.";
    }
    bd.appendChild(card);

    const ed = document.getElementById("dd-entrances");
    ed.innerHTML = "";
    if (!s.entrances.length) ed.innerHTML = `<div class="card ent"><b>כניסות להולכי רגל:</b> אין. סמן "כניסה" ולחץ על המפה במקום הדלת.</div>`;
    s.entrances.forEach((en, idx) => {
      const a = analyseEntrance(en.lon, en.lat);
      const c = document.createElement("div"); c.className = "card ent";
      c.innerHTML = `<b>כניסה ${idx + 1}</b> ${en.lat}, ${en.lon}<br>` +
        `<span class="${a.reasonable ? "ok" : "warn"}">${a.reasonable ? `חיבור משוער סביר: ${a.distance_m} מ' לדרך ממופה` : `אין חיבור סביר (${a.distance_m} מ'${a.crosses.length ? ", חוצה מכשול ממופה" : ""}${a.insideBuilding ? ", בתוך בניין" : ""})`}</span>`;
      c.appendChild(confSelect(en.confidence, v => { en.confidence = v; save(); }));
      const sf = document.createElement("select");
      for (const [v, t] of [["unknown", "נגישות: לא ידוע"], ["yes", "ללא מדרגות"], ["no", "עם מדרגות"]]) sf.add(new Option(t, v, false, en.step_free === v));
      sf.onchange = () => { en.step_free = sf.value; save(); };
      c.appendChild(sf);
      c.appendChild(noteInput(en.note, v => { en.note = v; save(); }));
      const row = document.createElement("div"); row.className = "row";
      const z = document.createElement("button"); z.textContent = "הצג"; z.onclick = () => map.setView([en.lat, en.lon], 19);
      const del = document.createElement("button"); del.textContent = "מחק כניסה"; del.className = "danger";
      del.onclick = () => { s.entrances.splice(idx, 1); save(); drawUser(); renderDetail(); renderList(); };
      row.append(z, del); c.appendChild(row);
      ed.appendChild(c);
    });
    const note = document.getElementById("dd-note");
    note.value = s.note || "";
    note.oninput = () => { s.note = note.value; save(); };
  }
  function confSelect(val, onChange) {
    const sel = document.createElement("select");
    for (const [v, t] of Object.entries(CONF_LABELS)) sel.add(new Option("ודאות: " + t, v, false, v === val));
    sel.onchange = () => onChange(sel.value);
    return sel;
  }
  function noteInput(val, onChange) {
    const i = document.createElement("input"); i.type = "text"; i.placeholder = "הערה / מקור (למשל: תמונה, מפה רשמית)";
    i.value = val || ""; i.oninput = () => onChange(i.value);
    return i;
  }

  // ---------- click-to-set ----------
  let hint = null;
  function mode() { return document.querySelector('input[name=mode]:checked').value; }
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener("change", updateHint));
  function updateHint() {
    if (hint) { hint.remove(); hint = null; }
    const m = mode();
    if (m === "none" || !current) return;
    hint = document.createElement("div"); hint.className = "map-hint";
    hint.textContent = `לחיצה על המפה: ${m === "building" ? "מיקום הבניין" : "כניסה חדשה"} – ${destById[current].name}`;
    document.getElementById("map").appendChild(hint);
  }
  map.on("click", e => {
    const m = mode();
    if (!current || m === "none") return;
    if (m === "building") setPoint(current, "building", null, e.latlng, "map-click", { source: null, source_ref: null, shared_with: null });
    else setPoint(current, "entrance", null, e.latlng, "map-click");
    renderList();
  });

  // ---------- export / import ----------
  document.getElementById("btn-export").onclick = () => {
    const out = Object.assign({}, state, {
      exported_at: new Date().toISOString(),
      destination_names: Object.fromEntries(DATA.destinations.map(d => [d.id, d.name])),
      entrance_connectors: Object.fromEntries(DATA.destinations.map(d => [d.id,
        state.destinations[d.id].entrances.map(en => { const a = analyseEntrance(en.lon, en.lat);
          return { approximate: true, reasonable: a.reasonable, distance_m: a.distance_m,
            network_endpoint: a.end && { lon: +a.end[0].toFixed(7), lat: +a.end[1].toFixed(7) },
            path: a.path && a.path.osm, crosses: a.crosses.map(o => o.url), inside_building: a.insideBuilding && a.insideBuilding.url }; })])),
    });
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "givat-ram-location-corrections.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById("file-import").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => {
      const s = JSON.parse(t);
      if (s.schema !== SCHEMA) throw new Error("schema");
      state = mergeState(s); save(); drawUser(); renderList(); if (current) renderDetail();
    }).catch(() => alert("הקובץ אינו קובץ תיקונים תקין.")).finally(() => { e.target.value = ""; });
  };
  document.getElementById("btn-reset").onclick = () => {
    if (!confirm("למחוק את כל התיקונים השמורים בדפדפן זה?")) return;
    state = blankState(); save(); drawUser(); renderList(); if (current) renderDetail();
  };

  document.getElementById("sources").innerHTML = DATA.sources.map(s => `<li>${link(s.url, s.label)}<br>${esc(s.detail)}</li>`).join("") +
    `<li>${link("https://leafletjs.com", "Leaflet")} (BSD-2)</li>`;

  renderList(); drawUser();
  window.__review = { analyseEntrance, select: selectDest, get state() { return state; } }; // for manual testing in the console
})();
