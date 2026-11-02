// Routing tests. Run after tests/test_app_data.py:  node tests/routing.test.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");
function load(mutate) {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "app/data/campus-data.js"), "utf8"), ctx);
  if (mutate) mutate(ctx.window.CAMPUS);
  vm.runInContext(fs.readFileSync(path.join(root, "app/route.js"), "utf8"), ctx);
  return { R: ctx.window.CampusRoute.create(ctx.window.CAMPUS), C: ctx.window.CAMPUS };
}
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const { R, C } = load();
const ref = JSON.parse(fs.readFileSync(path.join(root, "tests/out/python_shortest.json"), "utf8"));
const ids = C.destinations.map(d => d.id);
let maxDiff = 0, n = 0;
for (const a of ids) for (const b of ids) {
  if (a === b) continue;
  const r = R.route(a, b);
  if (!ref[a + ">" + b]) { ok(!r.ok && r.sameLocation, `${a}->${b}: refused, shared point`); continue; }
  n++;
  const js = r.network.length_m + r.start.length_m + r.end.length_m;
  maxDiff = Math.max(maxDiff, Math.abs(js - ref[a + ">" + b]));
  // structure: starts/ends with an approximate step, distance parts add up
  if (!(r.steps[0].approx && r.steps[r.steps.length - 1].approx)) ok(false, `${a}->${b} start/end steps marked approximate`);
  if (Math.abs(r.total_m - (r.network_m + r.approx_m)) > 1) ok(false, `${a}->${b} distance parts add up`);
  const ba = R.route(b, a);
  if (Math.abs(ba.total_m - r.total_m) > 1) ok(false, `${a}<->${b} symmetric`);
}
ok(n === 40 && maxDiff < 0.5, `JS route length equals independent Python Dijkstra for ${n} pairs (max diff ${maxDiff.toFixed(2)} m)`);

// ---- lawn mode: same comparison against the Python reference that includes lawn edges
const refL = JSON.parse(fs.readFileSync(path.join(root, "tests/out/python_shortest_lawn.json"), "utf8"));
let maxDiffL = 0, nL = 0, usedLawn = 0, pathOnlyClean = true, labelled = true, partsAdd = true;
for (const a of ids) for (const b of ids) {
  if (a === b || !refL[a + ">" + b]) continue;
  nL++;
  const rl = R.route(a, b, { lawn: true }), rp = R.route(a, b);
  maxDiffL = Math.max(maxDiffL, Math.abs(rl.network.length_m + rl.start.length_m + rl.end.length_m - refL[a + ">" + b]));
  if (rp.lawn_m !== 0 || rp.segments.some(s => s.kind !== "path")) pathOnlyClean = false;
  if (Math.abs(rl.total_m - (rl.path_m + rl.lawn_m + rl.approx_m)) > 1) partsAdd = false;
  if (rl.lawn_m > 0) {
    usedLawn++;
    const lawnSteps = rl.steps.filter(s => s.lawn);
    if (!lawnSteps.length || !lawnSteps.every(s => s.text.includes("קיצור דרך משוער בדשא — יש לוודא שניתן לעבור"))) labelled = false;
    if (rl.segments.filter(s => s.kind === "lawn").length !== lawnSteps.length && lawnSteps.length === 0) labelled = false;
  }
}
ok(nL === 40 && maxDiffL < 0.5, `lawn mode: JS route length equals independent Python Dijkstra for ${nL} pairs (max diff ${maxDiffL.toFixed(2)} m)`);
ok(pathOnlyClean, "path-only mode never uses a lawn shortcut");
ok(usedLawn > 0 && labelled, `lawn mode uses shortcuts on ${usedLawn} routes, each with a labelled Hebrew direction step`);
ok(partsAdd, "lawn mode: path + lawn + approximate parts add up to the total");
const he = R.route("harman", "engineering", { lawn: true }), hp = R.route("harman", "engineering");
ok(he.total_m < hp.total_m - 100, `Harman->Engineering: lawn ${he.total_m} m vs paths ${hp.total_m} m`);
// lawn segments only use lawn edges from the data: every lawn hop's ends are graph nodes joined by a lawn edge
const key = c => c[0].toFixed(7) + "," + c[1].toFixed(7);
const lawnPairs = new Set((C.graph.lawn_edges || []).flatMap(([a, b]) => [key(C.graph.nodes[a]) + "|" + key(C.graph.nodes[b]), key(C.graph.nodes[b]) + "|" + key(C.graph.nodes[a])]));
ok(he.segments.filter(s => s.kind === "lawn").every(s => s.coords.slice(1).every((c, i) => lawnPairs.has(key(s.coords[i]) + "|" + key(c)))),
  "drawn lawn segments are exactly the precomputed lawn shortcuts (no ad-hoc straight lines)");
console.log("  sample (harman -> engineering, lawn):\n   " + he.steps.map(s => s.text).join("\n   "));
// no lawn data -> option unavailable, routes identical to path-only
const { R: R4 } = load(C4 => { C4.lawns = []; C4.graph.lawn_edges = []; });
ok(!R4.hasLawnData && R4.route("harman", "engineering", { lawn: true }).total_m === hp.total_m, "without lawn data the option is unavailable and routing falls back to paths");

// Manchester both ways, both modes
for (const [a, b] of [["manchester", "harman"], ["sprinzak", "manchester"], ["manchester", "canada"], ["kaplan", "manchester"]]) {
  for (const lawn of [false, true]) {
    const r = R.route(a, b, { lawn }), rr = R.route(b, a, { lawn });
    ok(r.ok && rr.ok && Math.abs(r.total_m - rr.total_m) <= 1 && r.steps[0].approx && r.steps[r.steps.length - 1].approx,
      `${a}<->${b} (${lawn ? "lawn" : "paths"}): ${r.total_m} m both ways, approximate ends`);
  }
}
ok(/בניין מנצ'סטר/.test(R.route("harman", "manchester").steps.slice(-1)[0].text), "Manchester named in the final direction");

// route geometry follows graph edges only: every consecutive pair of route coords lies on one graph edge
const G = C.graph, KX = 111320 * Math.cos(31.775 * Math.PI / 180), KY = 111320;
const nodeKey = new Set(G.nodes.map(key));
const r1 = R.route("sprinzak", "canada");
const inner = r1.network.coords.slice(1, -1);
ok(inner.every(c => nodeKey.has(key(c))), "route interior vertices are all graph nodes (no invented connections)");

// directions content
const txt = r1.steps.map(s => s.text).join("\n");
ok(/משוער/.test(r1.steps[0].text) && /משוער/.test(r1.steps[r1.steps.length - 1].text), "first/last direction says the connection is approximate");
ok(!/הקצר ביותר האפשרי/.test(txt), "directions do not claim a globally shortest route");
console.log("  sample (sprinzak -> canada):\n   " + txt.replace(/\n/g, "\n   "));

// same point
const kr = R.route("kaplan", "rothberg");
ok(!kr.ok && kr.sameLocation, "Kaplan->Rothberg refused (single shared point)");

// no connected route: attach destination to an edge in a small disconnected component
const { R: R2 } = load(C2 => {
  const main = C2.graph.main_component;
  const ei = C2.graph.edges.findIndex(e => C2.graph.component[e[0]] !== main);
  const d = C2.destinations.find(x => x.id === "canada");
  d.attaches = [Object.assign({}, d.attaches[0], { edge: ei, t: 0.5, network_point: C2.graph.nodes[C2.graph.edges[ei][0]] })];
});
const nr = R2.route("sprinzak", "canada");
ok(!nr.ok && nr.noRoute && /לא שורטט קו ישר/.test(nr.reason), "disconnected destination -> explicit no-route message, no line");

// invalid connector: route still drawn to network endpoint, connector not drawn
const { R: R3 } = load(C3 => { const d = C3.destinations.find(x => x.id === "harman"); d.attaches[0].valid = false; d.attaches[0].reason = "test"; });
const iv = R3.route("sprinzak", "harman");
ok(iv.ok && iv.any_invalid && iv.end.coords === null && /אינה מאומתת/.test(iv.steps[iv.steps.length - 1].text), "invalid connector: stops at network endpoint and says final approach is unverified");

console.log("FAILURES:", fails);
process.exit(fails ? 1 : 0);
