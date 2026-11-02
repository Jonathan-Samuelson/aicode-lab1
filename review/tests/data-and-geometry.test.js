const fs = require("fs"), vm = require("vm");
const root = process.argv[2] || require("path").join(__dirname, "..");
// --- minimal stubs ---
const chain = new Proxy(function () {}, { get: (t, k) => k === "getLatLng" ? () => ({ lat: 0, lng: 0 }) : chain, apply: () => chain });
const handlers = {};
const mapObj = new Proxy({}, { get: (t, k) => k === "on" ? (ev, fn) => { handlers[ev] = fn; return mapObj; } : (() => mapObj) });
const L = new Proxy({}, { get: (t, k) => k === "map" ? () => mapObj : k === "latLngBounds" ? () => ({ pad: () => 0 }) : chain });
function el() { const e = { children: [], style: {}, appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); },
  addEventListener() {}, remove() {}, add() {}, click() {}, hidden: true, innerHTML: "", textContent: "", value: "" }; return e; }
const els = {}; let modeVal = "none";
const document = { getElementById: id => (els[id] = els[id] || el()), createElement: () => el(),
  querySelector: () => ({ get value() { return modeVal; } }), querySelectorAll: () => [] };
const store = {};
const window = {};
const ctx = { window, document, L, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  Option: function (t, v) { this.text = t; this.value = v; }, Blob: function () {}, URL: {}, alert: console.log, confirm: () => true, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root + "/data/review-data.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync(root + "/review.js", "utf8"), ctx);
const R = window.__review, D = window.REVIEW_DATA;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// 1. data sanity
ok(D.destinations.length === 7 && D.destinations.some(d => d.id === "manchester" && d.candidates[0].osm === "way/121791882"), "seven destinations, incl. Manchester (OSM way/121791882)");
const kap = D.destinations.find(d => d.id === "kaplan"), rot = D.destinations.find(d => d.id === "rothberg");
ok(JSON.stringify(kap.candidates[0].lonlat) === JSON.stringify(rot.candidates[0].lonlat), "Kaplan/Rothberg share the single OSM point, no invented split");
ok(D.destinations.find(d => d.id === "engineering").candidates.length === 0, "no candidate assumed for Engineering Auditorium");
ok(D.destinations.find(d => d.id === "canada").candidates.every(c => c.kind === "candidate"), "Canada Hall candidates all marked as unconfirmed");

// 2. connector analysis: point just outside Sprinzak's outline vs point deep inside it
const spr = D.buildings.features.find(f => f.properties.osm === "way/121791888");
const ring = spr.geometry.coordinates[0], c = spr.properties.centroid;
const inside = R.analyseEntrance(c[0], c[1]);
ok(inside.insideBuilding && !inside.reasonable, "entrance at building centroid flagged as inside building, not reasonable");
// vertex pushed 3 m outward from centroid
const v = ring[0], dx = v[0] - c[0], dy = v[1] - c[1], n = Math.hypot(dx * 94600, dy * 111320);
const out = [v[0] + dx / n * 3, v[1] + dy / n * 3];
const a = R.analyseEntrance(out[0], out[1]);
console.log("  outside-vertex entrance:", JSON.stringify({ d: a.distance_m, reasonable: a.reasonable, crosses: a.crosses.map(o => o.label), path: a.path && a.path.osm }));
ok(a.end && a.distance_m != null && !a.insideBuilding, "outside entrance gets a network endpoint");
// far away point (south of bbox) -> not reasonable
const far = R.analyseEntrance(35.1965, 31.7600);
ok(far.distance_m > 40 && !far.reasonable, "far entrance (" + far.distance_m + " m) not reasonable");
// connector across a building: from the west side of Harman, but force crossing by picking a point inside another building
const crossCount = D.buildings.features.slice(0, 180).filter(f => { const p = f.properties.centroid; const r = R.analyseEntrance(p[0], p[1]); return r.insideBuilding; }).length;
ok(crossCount === 180, "interior points of all buildings detected as inside a building (" + crossCount + "/180)");

// 3. click-to-set + persistence
modeVal = "entrance"; handlers.click({ latlng: { lat: out[1], lng: out[0] } });
ok(R.state.destinations.sprinzak.entrances.length === 0, "map click without a selected destination does nothing");
