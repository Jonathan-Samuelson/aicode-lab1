/* Routing and Hebrew walking directions over the bundled pedestrian graph.
 * Pure logic (no map code) so it can be tested in Node: `CampusRoute.create(window.CAMPUS)`.
 */
(function (root) {
  "use strict";

  function create(C) {
    const G = C.graph;
    const N = G.nodes.length;
    const LAT0 = 31.775, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
    const xy = ll => [ll[0] * KX, ll[1] * KY];
    const nodeXY = G.nodes.map(xy);
    // Edges 0..E0-1 are mapped OSM ways. Edges E0.. are inferred lawn shortcuts (optional mode),
    // whose "way" index is W0 + lawn index.
    const E0 = G.edges.length, W0 = G.ways.length;
    const LAWN_LABEL = "קיצור דרך משוער בדשא — יש לוודא שניתן לעבור";
    const lawnEdges = (G.lawn_edges || []).map(([a, b, L, li]) => [a, b, L, W0 + li]);
    const lawnWays = (C.lawns || []).map(l => ({ osm: l.osm, kind: "lawn", type_he: "דשא", name: null, lawn: true }));
    const edgeOf = e => (e < E0 ? G.edges[e] : lawnEdges[e - E0]);
    const wayOf = wi => (wi < W0 ? G.ways[wi] : lawnWays[wi - W0]);
    const adjPath = Array.from({ length: N }, () => []);
    G.edges.forEach(([a, b, L], i) => { adjPath[a].push([b, L, i]); adjPath[b].push([a, L, i]); });
    const adjLawn = adjPath.map(l => l.slice());
    lawnEdges.forEach(([a, b, L], k) => { adjLawn[a].push([b, L, E0 + k]); adjLawn[b].push([a, L, E0 + k]); });
    const dname = d => d.short || d.name;
    const destById = Object.fromEntries(C.destinations.map(d => [d.id, d]));
    const bldgXY = C.buildings.filter(b => b.name).map(b => ({ name: b.name, osm: b.osm, ring: b.ll.map(xy) }));

    // ---------- small helpers ----------
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    function segDist(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    }
    const bearing = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI; // 0 = north, clockwise
    const norm = d => { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; };
    const round = m => Math.max(1, Math.round(m));

    class Heap {
      constructor() { this.a = []; }
      push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
      pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
        return top;
      }
      get size() { return this.a.length; }
    }

    /** Shortest path by distance. Virtual nodes split the attach edges. */
    function shortest(fromD, toD, lawn) {
      const adj = lawn ? adjLawn : adjPath;
      const extra = new Map(); // node -> [[to, len, edgeIdx]]
      const vxy = {};
      const addE = (a, b, L, e) => { for (const [x, y] of [[a, b], [b, a]]) { if (!extra.has(x)) extra.set(x, []); extra.get(x).push([y, L, e]); } };
      const S = N, E = N + 1;
      let next = N + 2;
      const attachNodes = [];
      function attach(d, side) {
        d.attaches.forEach((a, k) => {
          if (a.edge == null) return;
          const [u, w, L] = G.edges[a.edge];
          const v = next++;
          vxy[v] = xy(a.network_point);
          addE(u, v, L * a.t, a.edge);
          addE(v, w, L * (1 - a.t), a.edge);
          // cost of the approximate connector (only counts when it is a valid connection)
          addE(side === "start" ? S : E, v, a.valid ? a.connector_m : 0, -1);
          attachNodes.push({ v, side, a, k });
        });
      }
      attach(fromD, "start");
      attach(toD, "end");
      // two attaches on the same edge: allow direct travel between them along that edge
      for (const s of attachNodes) for (const e of attachNodes) {
        if (s.side === "start" && e.side === "end" && s.a.edge === e.a.edge) {
          addE(s.v, e.v, G.edges[s.a.edge][2] * Math.abs(s.a.t - e.a.t), s.a.edge);
        }
      }
      const distTo = new Map([[S, 0]]), prev = new Map();
      const h = new Heap(); h.push([0, S]);
      const done = new Set();
      while (h.size) {
        const [d, x] = h.pop();
        if (done.has(x)) continue;
        done.add(x);
        if (x === E) break;
        // S is only a source; E is only reached from an end attach node
        const nb = (x < N ? adj[x] : []).concat(extra.get(x) || []);
        for (const [y, L, e] of nb) {
          if (y === S) continue;
          const nd = d + L;
          if (nd < (distTo.has(y) ? distTo.get(y) : Infinity)) { distTo.set(y, nd); prev.set(y, [x, e]); h.push([nd, y]); }
        }
      }
      if (!distTo.has(E)) return null;
      const seq = []; // [{node, edgeIdx used to arrive}]
      let cur = E;
      while (cur !== undefined) { const p = prev.get(cur); seq.push({ node: cur, via: p ? p[1] : null }); cur = p ? p[0] : undefined; }
      seq.reverse();
      const pos = n => (n < N ? nodeXY[n] : vxy[n]);
      const inner = seq.slice(1, -1); // drop S and E
      const startA = attachNodes.find(t => t.v === inner[0].node).a;
      const endA = attachNodes.find(t => t.v === inner[inner.length - 1].node).a;
      const hops = [];
      for (let i = 1; i < inner.length; i++) {
        const a = inner[i - 1].node, b = inner[i].node, e = inner[i].via;
        hops.push({ a, b, e, from: pos(a), to: pos(b), len: dist(pos(a), pos(b)) });
      }
      return { hops, startA, endA, nodes: inner.map(s => s.node) };
    }

    // ---------- directions ----------
    function describeWay(w) {
      if (w.kind === "crossing") return "מעבר החציה";
      if (w.name) return `${w.type_he} "${w.name}"`;
      return w.type_he;
    }
    function turnText(delta) {
      const a = Math.abs(delta), side = delta > 0 ? "ימינה" : "שמאלה";
      if (a < 25) return "המשיכו ישר";
      if (a < 60) return `פנו קלות ${side}`;
      if (a < 135) return `פנו ${side}`;
      return `פנו בחדות ${side}`;
    }
    function nearbyLandmark(p, exclude, used) {
      let best = null;
      for (const b of bldgXY) {
        if (exclude.has(b.osm) || used.has(b.osm)) continue;
        let m = Infinity;
        for (let i = 0; i < b.ring.length - 1; i++) m = Math.min(m, segDist(p, b.ring[i], b.ring[i + 1]));
        if (m <= 25 && (!best || m < best.m)) best = { m, b };
      }
      if (best) used.add(best.b.osm);
      return best && best.b.name;
    }
    function pointAlong(coords, fromEnd, meters) {
      // point ~meters from the start (or end) of a polyline, for stable bearings
      const pts = fromEnd ? coords.slice().reverse() : coords;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const L = dist(pts[i - 1], pts[i]);
        if (acc + L >= meters) { const t = (meters - acc) / L; return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; }
        acc += L;
      }
      return pts[pts.length - 1];
    }

    function buildLegs(hops) {
      const legs = [];
      for (const h of hops) {
        const wi = edgeOf(h.e)[3], w = wayOf(wi);
        const last = legs[legs.length - 1];
        if (last && last.wi === wi) { last.coords.push(h.to); last.len += h.len; last.nodes.push(h.b); }
        else legs.push({ wi, w, coords: [h.from, h.to], len: h.len, nodes: [h.a, h.b], forward: edgeForward(h) });
      }
      // merge consecutive legs that a walker would not notice as a change
      const merged = [];
      for (const l of legs) {
        const p = merged[merged.length - 1];
        if (p) {
          const delta = norm(bearing(pointAlong(l.coords, false, 0), pointAlong(l.coords, false, 8)) - bearing(pointAlong(p.coords, true, 8), pointAlong(p.coords, true, 0)));
          const sameKind = p.w.type_he === l.w.type_he && (p.w.name || "") === (l.w.name || "") && l.w.kind !== "steps" && l.w.kind !== "crossing";
          // lawn legs are never merged into path legs (or vice versa): they must stay visible
          const tiny = l.len < 6 && l.w.kind !== "steps" && l.w.kind !== "crossing" && !l.w.lawn && !p.w.lawn;
          if (p.w.lawn && l.w.lawn) { p.coords.push(...l.coords.slice(1)); p.len += l.len; p.nodes.push(...l.nodes.slice(1)); continue; }
          if ((sameKind && Math.abs(delta) < 30) || tiny) {
            p.coords.push(...l.coords.slice(1)); p.len += l.len; p.nodes.push(...l.nodes.slice(1)); continue;
          }
        }
        merged.push(Object.assign({}, l, { coords: l.coords.slice(), nodes: l.nodes.slice() }));
      }
      return merged;
    }
    function edgeForward(h) {
      const [u, w] = edgeOf(h.e);
      if (h.a === u || h.b === w) return true;
      if (h.a === w || h.b === u) return false;
      // virtual endpoints: compare positions along the edge
      return dist(h.from, nodeXY[u]) < dist(h.to, nodeXY[u]);
    }

    function directions(r, fromD, toD) {
      const steps = [], warnings = [];
      const exclude = new Set([fromD.footprint, toD.footprint].filter(Boolean));
      const used = new Set();
      const legs = buildLegs(r.hops);
      const sa = r.startA, ea = r.endA;
      // start
      if (sa.from === "entrance") {
        steps.push({ kind: "start", text: `צאו מהכניסה של ${dname(fromD)}${sa.valid ? ` אל ${describeWay(legs[0].w)} (חיבור משוער, כ-${round(sa.connector_m)} מ')` : ""}.`, approx: true });
      } else if (fromD.footprint) {
        steps.push({ kind: "start", approx: true, text: sa.valid
          ? `צאו מ${dname(fromD)} אל ${describeWay(legs[0].w)}. מיקום הכניסה אינו ממופה – קטע של כ-${round(sa.connector_m)} מ' מקיר הבניין לשביל הוא משוער.`
          : `החיבור מ${dname(fromD)} לרשת ההליכה אינו ממופה. התחילו מנקודת הקצה המסומנת על ${describeWay(legs[0].w)}.` });
      } else {
        steps.push({ kind: "start", approx: true, text: `התחילו בנקודה המסומנת של ${dname(fromD)}${fromD.shared_with.length ? " (נקודה משותפת לקפלן ורוטברג במקור הנתונים)" : ""}, על ${describeWay(legs[0].w)}. הכניסה לאולם אינה ממופה.` });
      }
      const seenWarn = new Set();
      legs.forEach((l, i) => {
        let lead;
        if (i === 0) lead = "המשיכו";
        else {
          const p = legs[i - 1];
          const delta = norm(bearing(pointAlong(l.coords, false, 0), pointAlong(l.coords, false, 8)) - bearing(pointAlong(p.coords, true, 8), pointAlong(p.coords, true, 0)));
          lead = turnText(delta);
        }
        const lm = nearbyLandmark(l.coords[0], exclude, used);
        const at = i > 0 && lm ? ` ליד ${lm}` : "";
        let text;
        const m = round(l.len);
        if (l.w.lawn) {
          text = `${lead}${at} וחצו את הדשא בקו ישר – ${m} מ'. ${LAWN_LABEL}.`;
        } else if (l.w.kind === "steps") {
          const inc = l.w.incline;
          const verb = inc === "up" || inc === "down" ? ((inc === "up") === l.forward ? "עלו" : "רדו") : "עברו";
          text = `${i ? lead + at + " ו" : ""}${verb} במדרגות (${m} מ').`;
        } else if (l.w.kind === "crossing") {
          text = `${i ? lead + at + " ו" : ""}חצו במעבר החציה (${m} מ').`;
        } else {
          text = `${lead}${at} ${i ? "אל" : "לאורך"} ${describeWay(l.w)} – ${m} מ'.`;
          if (l.w.road) text += " (לאורך כביש)";
        }
        steps.push({ kind: "leg", text, meters: m, lawn: !!l.w.lawn });
        for (const n of l.nodes) {
          const wtxt = n < N && G.warn_nodes[String(n)];
          if (wtxt && !seenWarn.has(n)) { seenWarn.add(n); steps.push({ kind: "warn", text: "שימו לב: " + wtxt + "." }); warnings.push(wtxt); }
        }
      });
      // end
      if (ea.from === "entrance") {
        steps.push({ kind: "end", approx: true, text: `הגעתם לכניסה של ${dname(toD)}${ea.valid ? ` (חיבור משוער, כ-${round(ea.connector_m)} מ')` : ""}.` });
      } else if (toD.footprint) {
        steps.push({ kind: "end", approx: true, text: ea.valid
          ? `הגעתם לקצה הרשת הממופה ליד ${dname(toD)}. כ-${round(ea.connector_m)} מ' נוספים עד קיר הבניין הם חיבור משוער; מיקום הכניסה אינו ממופה.`
          : `המסלול הממופה מסתיים כאן. הגישה האחרונה ל${dname(toD)} אינה מאומתת ואינה משורטטת.` });
      } else {
        steps.push({ kind: "end", approx: true, text: `הגעתם לנקודה המסומנת של ${dname(toD)}${toD.shared_with.length ? " (נקודה משותפת לקפלן ורוטברג במקור הנתונים)" : ""}. הכניסה לאולם אינה ממופה.` });
      }
      return { steps, warnings };
    }

    function route(fromId, toId, opts) {
      const lawn = !!(opts && opts.lawn);
      const fromD = destById[fromId], toD = destById[toId];
      if (!fromD || !toD) return { ok: false, reason: "יש לבחור נקודת מוצא ויעד." };
      if (fromId === toId) return { ok: false, reason: "נקודת המוצא והיעד זהות." };
      if (!fromD.location || !toD.location) return { ok: false, reason: "אין מיקום ידוע לאחד היעדים." };
      if (fromD.location[0] === toD.location[0] && fromD.location[1] === toD.location[1]) {
        return { ok: false, sameLocation: true, reason: `${dname(fromD)} ו${dname(toD)} חולקים נקודה אחת במקור הנתונים (OSM). אין נתונים שמבחינים ביניהם, ולכן לא ניתן לחשב מסלול ביניהם.` };
      }
      const r = shortest(fromD, toD, lawn);
      if (!r || !r.hops.length) {
        return { ok: false, noRoute: true, reason: `לא נמצא מסלול מחובר ברשת ההליכה הממופה בין ${dname(fromD)} לבין ${dname(toD)}. לא שורטט קו ישר ולא נוספו חיבורים שאינם במפה.` };
      }
      const networkM = r.hops.reduce((s, h) => s + h.len, 0);
      const isLawn = h => h.e >= E0;
      const lawnM = r.hops.filter(isLawn).reduce((s, h) => s + h.len, 0);
      const ll = p => [p[0] / KX, p[1] / KY];
      const connector = (a, atStart) => ({
        valid: a.valid, length_m: a.valid ? a.connector_m : 0, inside_m: a.inside_m, reason: a.reason || null,
        coords: a.valid ? (atStart ? [a.wall_point, a.network_point] : [a.network_point, a.wall_point]) : null,
        network_point: a.network_point,
      });
      const start = connector(r.startA, true), end = connector(r.endA, false);
      const dir = directions(r, fromD, toD);
      // consecutive runs of path / lawn hops, for drawing
      const segments = [];
      for (const h of r.hops) {
        const kind = isLawn(h) ? "lawn" : "path", last = segments[segments.length - 1];
        if (last && last.kind === kind) last.coords.push(ll(h.to));
        else segments.push({ kind, coords: [ll(h.from), ll(h.to)] });
      }
      return {
        ok: true,
        lawn_mode: lawn,
        network: { coords: [r.hops[0].from].concat(r.hops.map(h => h.to)).map(ll), length_m: networkM },
        segments,
        lawn_m: Math.round(lawnM),
        lawn_label: LAWN_LABEL,
        path_m: Math.round(networkM) - Math.round(lawnM),
        start, end,
        network_m: Math.round(networkM),
        approx_m: Math.round(start.length_m + end.length_m),
        total_m: Math.round(networkM + start.length_m + end.length_m),
        any_invalid: !start.valid || !end.valid,
        steps: dir.steps, warnings: dir.warnings,
      };
    }

    return { route, destinations: C.destinations, lawnLabel: LAWN_LABEL, hasLawnData: lawnEdges.length > 0 };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CampusRoute = api;
})(typeof window !== "undefined" ? window : globalThis);
