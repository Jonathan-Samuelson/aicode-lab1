const fs = require("fs"), vm = require("vm");
const root = process.argv[2] || require("path").join(__dirname, "..");
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const handlers = {};
const mapObj = new Proxy({}, { get: (t, k) => k === "on" ? (ev, fn) => { handlers[ev] = fn; return mapObj; } : (() => mapObj) });
const L = new Proxy({}, { get: (t, k) => k === "map" ? () => mapObj : k === "latLngBounds" ? () => ({ pad: () => 0 }) : chain });
function el() { return { children: [], appendChild(c) { this.children.push(c); return c; }, append() {}, addEventListener() {}, remove() {}, add() {}, click() {}, hidden: true, innerHTML: "", textContent: "", value: "" }; }
const els = {}; let modeVal = "none";
const document = { getElementById: id => (els[id] = els[id] || el()), createElement: () => el(),
  querySelector: () => ({ get value() { return modeVal; } }), querySelectorAll: () => [] };
const store = {}; let blobOut = null;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
function boot(mutate) {
  const window = {};
  const ctx = { window, document, L, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    Option: function () {}, Blob: function (parts) { blobOut = parts.join(""); }, URL: { createObjectURL: () => "", revokeObjectURL() {} },
    alert: console.log, confirm: () => true, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(root + "/data/review-data.js", "utf8"), ctx);
  if (mutate) mutate(window.REVIEW_DATA);
  vm.runInContext(fs.readFileSync(root + "/review.js", "utf8"), ctx);
  return window;
}
// entrance point 3 m outside Sprinzak's first vertex (from harness 1)
let w = boot();
const D = w.REVIEW_DATA, spr = D.buildings.features.find(f => f.properties.osm === "way/121791888");
const v = spr.geometry.coordinates[0][0], c = spr.properties.centroid;
const dx = v[0] - c[0], dy = v[1] - c[1], n = Math.hypot(dx * 94600, dy * 111320);
const P = [v[0] + dx / n * 3, v[1] + dy / n * 3];
const a0 = w.__review.analyseEntrance(P[0], P[1]);

// A. synthetic fence across the connector must make it unreasonable
w = boot(D2 => {
  const mx = (P[0] + a0.end[0]) / 2, my = (P[1] + a0.end[1]) / 2, ox = -(a0.end[1] - P[1]), oy = a0.end[0] - P[0];
  D2.barriers.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[mx - ox * 3, my - oy * 3], [mx + ox * 3, my + oy * 3]] },
    properties: { osm: "way/TEST", url: "test", barrier: "fence" } });
});
const a1 = w.__review.analyseEntrance(P[0], P[1]);
ok(a0.reasonable && !a1.reasonable && a1.crosses.some(o => o.url === "test"), "connector crossing a fence is rejected");

// B. select -> click entrance -> click building -> persisted -> export
w = boot(); const R = w.__review;
R.select("sprinzak");
modeVal = "entrance"; handlers.click({ latlng: { lat: P[1], lng: P[0] } });
modeVal = "building"; handlers.click({ latlng: { lat: c[1], lng: c[0] } });
ok(R.state.destinations.sprinzak.entrances.length === 1, "entrance added by map click");
ok(R.state.destinations.sprinzak.building && R.state.destinations.sprinzak.building.method === "map-click", "building location set by map click");
const saved = JSON.parse(store["givatram-location-review-v1"]);
ok(saved.destinations.sprinzak.entrances[0].lat === +P[1].toFixed(7), "saved to localStorage");
// reload from storage
w = boot();
ok(w.__review.state.destinations.sprinzak.entrances.length === 1, "state survives reload");
els["btn-export"].onclick();
const ex = JSON.parse(blobOut);
ok(ex.schema === "givat-ram-location-review/1" && ex.entrance_connectors.sprinzak[0].approximate === true, "export contains schema and approximate-connector info");
console.log("  export sample:", JSON.stringify(ex.entrance_connectors.sprinzak[0]));
// D. synthetic building straddling the connector (thin box across it) must also be rejected
let Q = null;
for (let m = 6; m <= 30 && !Q; m += 2) {   // find an outside point whose connector is > 4 m
  const q = [v[0] + dx / n * m, v[1] + dy / n * m]; const r = w.__review.analyseEntrance(q[0], q[1]);
  if (r.distance_m > 4 && r.reasonable) Q = { q, r };
}
console.log("  test entrance for D:", Q && Q.r.distance_m, "m");
w = boot(D2 => {
  const P = Q.q, a0 = Q.r;
  const ux = a0.end[0] - P[0], uy = a0.end[1] - P[1];           // along connector
  const mx = P[0] + ux / 2, my = P[1] + uy / 2, ox = -uy * 3, oy = ux * 3, sx = ux * 0.1, sy = uy * 0.1; // across, thin
  const ring = [[mx - ox - sx, my - oy - sy], [mx + ox - sx, my + oy - sy], [mx + ox + sx, my + oy + sy], [mx - ox + sx, my - oy + sy]];
  ring.push(ring[0]);
  D2.buildings.features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] },
    properties: { osm: "way/TESTB", url: "testb", name: "test", centroid: [mx, my] } });
});
const a2 = w.__review.analyseEntrance(Q.q[0], Q.q[1]);
ok(!a2.reasonable && a2.crosses.some(o => o.url === "testb"), "connector crossing a building is rejected");
// E. door exactly on Sprinzak's wall (midpoint of first edge) is not flagged as crossing its own building
w = boot(); 
const r0 = spr.geometry.coordinates[0], mid = [(r0[0][0] + r0[1][0]) / 2, (r0[0][1] + r0[1][1]) / 2];
const a3 = w.__review.analyseEntrance(mid[0], mid[1]);
console.log("  door-on-wall:", JSON.stringify({ d: a3.distance_m, inside: a3.insideBuilding && a3.insideBuilding.label, crosses: a3.crosses.map(o => o.label) }));
ok(!a3.crosses.some(o => o.url.endsWith("121791888")), "door on own wall does not count as crossing its own building");
