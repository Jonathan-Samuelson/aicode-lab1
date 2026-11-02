/* 3D campus walking map UI (MapLibre GL). Routing lives in route.js. */
(function () {
  "use strict";
  const C = window.CAMPUS;
  const R = window.CampusRoute.create(C);
  const destById = Object.fromEntries(C.destinations.map(d => [d.id, d]));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>`;

  // ---------- GeoJSON from bundled data ----------
  const footprintRole = {};
  for (const d of C.destinations) if (d.footprint) footprintRole[d.footprint] = d.footprint_rel;
  const buildingsGJ = {
    type: "FeatureCollection",
    features: C.buildings.map(b => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [b.ll] },
      properties: { osm: b.osm, name: b.name || "", height: b.height, role: footprintRole[b.osm] || "other" },
    })),
  };
  const pathsGJ = {
    type: "FeatureCollection",
    features: C.graph.edges.map(([a, b, , wi]) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [C.graph.nodes[a], C.graph.nodes[b]] },
      properties: { kind: C.graph.ways[wi].kind },
    })),
  };
  const lawnsGJ = {
    type: "FeatureCollection",
    features: (C.lawns || []).map(l => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [l.ll] },
      properties: { osm: l.osm, tag: l.tag, shortcuts: l.shortcuts } })),
  };
  const empty = { type: "FeatureCollection", features: [] };

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: "map",
    center: C.center, zoom: 16.6, pitch: 55, bearing: -20, maxPitch: 75,
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' },
        buildings: { type: "geojson", data: buildingsGJ, attribution: "נתוני בניינים ושבילים: © OpenStreetMap contributors (ODbL)" },
        paths: { type: "geojson", data: pathsGJ },
        lawns: { type: "geojson", data: lawnsGJ },
        lawnroute: { type: "geojson", data: empty },
        route: { type: "geojson", data: empty },
        approx: { type: "geojson", data: empty },
        ends: { type: "geojson", data: empty },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#eef0ea" } },
        { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.55, "raster-saturation": -0.6 } },
        { id: "lawns", type: "fill", source: "lawns", layout: { visibility: "none" },
          paint: { "fill-color": "#69db7c", "fill-opacity": 0.35, "fill-outline-color": "#2b8a3e" } },
        { id: "paths", type: "line", source: "paths", filter: ["!=", ["get", "kind"], "steps"], paint: {
          "line-color": "#8fa3b8", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 19, 3],
        } },
        { id: "paths-steps", type: "line", source: "paths", filter: ["==", ["get", "kind"], "steps"], paint: {
          "line-color": "#5c6b7a", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 2, 19, 5], "line-dasharray": [0.6, 0.6],
        } },
        { id: "buildings-3d", type: "fill-extrusion", source: "buildings", paint: {
          "fill-extrusion-color": ["match", ["get", "role"], "destination", "#d6336c", "contains_point", "#f59f00", "#c9c4bb"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": 0.78,
        } },
        // route layers come after the extrusions so they are not hidden behind buildings
        { id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#1f6feb", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 4, 19, 9] } },
        { id: "lawnroute", type: "line", source: "lawnroute", layout: { "line-cap": "butt" },
          paint: { "line-color": "#2b8a3e", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 4, 19, 9], "line-dasharray": [1.2, 0.8] } },
        { id: "approx", type: "line", source: "approx", layout: { "line-cap": "butt" },
          paint: { "line-color": "#e8590c", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 3, 19, 7], "line-dasharray": [1.5, 1] } },
        { id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#e8590c", "circle-stroke-width": 3 } },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");

  document.getElementById("tog-tiles").onchange = e => map.setLayoutProperty("osm", "visibility", e.target.checked ? "visible" : "none");
  document.getElementById("tog-paths").onchange = e => ["paths", "paths-steps"].forEach(l => map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none"));
  const btn3d = document.getElementById("btn-3d");
  btn3d.onclick = () => {
    const flat = map.getPitch() > 5;
    map.easeTo({ pitch: flat ? 0 : 55 });
    btn3d.textContent = flat ? "תצוגה תלת-ממדית" : "תצוגה דו-ממדית";
  };

  const chkLawn = document.getElementById("chk-lawn");
  chkLawn.onchange = () => { map.setLayoutProperty("lawns", "visibility", chkLawn.checked ? "visible" : "none"); update(); };
  let lawnMarker = null;

  map.on("click", "buildings-3d", e => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat)
      .setHTML(`<div dir="rtl"><b>${esc(p.name || "בניין ללא שם ב-OSM")}</b><br>${link("https://www.openstreetmap.org/" + p.osm, p.osm)}</div>`).addTo(map);
  });

  // ---------- labels (HTML markers: native Hebrew/RTL rendering) ----------
  const labelEls = {};
  const byPoint = {};
  for (const d of C.destinations) if (d.location) (byPoint[d.location.join(",")] = byPoint[d.location.join(",")] || []).push(d);
  for (const [key, ds] of Object.entries(byPoint)) {
    const el = document.createElement("div");
    el.className = "lbl";
    el.innerHTML = ds.map(d => `<span data-id="${d.id}">${esc(d.name)}</span>`).join(" · ") +
      (ds.length > 1 ? `<span class="conf">נקודה משותפת במקור הנתונים</span>` : "") +
      ds.filter(d => d.provenance && d.provenance.source === "user").map(d => `<span class="conf">${esc(d.provenance.confidence_he)}</span>`).join("");
    el.addEventListener("click", ev => {
      ev.stopPropagation();
      const id = (ev.target.closest("[data-id]") || el.querySelector("[data-id]")).dataset.id;
      // first click sets the start, second the destination; a third click starts over
      if (!selFrom.value) selFrom.value = id;
      else if (!selTo.value) selTo.value = id;
      else { selFrom.value = id; selTo.value = ""; }
      update();
    });
    ds.forEach(d => { labelEls[d.id] = el; });
    // the outline-less Kaplan/Rothberg point label sits below its point, the rest above, so it does
    // not cover the Harman library label ~20 m north of it in the default (north-up) view
    const below = !ds[0].footprint;
    new maplibregl.Marker({ element: el, anchor: below ? "top" : "bottom", offset: [0, below ? 4 : -4] }).setLngLat(ds[0].location).addTo(map);
  }
  const destFootprints = new Set(C.destinations.map(d => d.footprint).filter(Boolean));
  const landmarkMarkers = C.landmarks.filter(l => !destFootprints.has(l.osm)).map(l => {
    const el = document.createElement("div"); el.className = "lm"; el.textContent = l.name;
    return new maplibregl.Marker({ element: el }).setLngLat(l.point).addTo(map);
  });
  const toggleLandmarks = () => { const show = map.getZoom() >= 16.3; landmarkMarkers.forEach(m => { m.getElement().style.display = show ? "" : "none"; }); };
  map.on("zoom", toggleLandmarks); toggleLandmarks();

  // ---------- panel ----------
  const selFrom = document.getElementById("sel-from"), selTo = document.getElementById("sel-to");
  for (const d of C.destinations) { selFrom.add(new Option(d.name, d.id)); selTo.add(new Option(d.name, d.id)); }
  document.getElementById("btn-swap").onclick = () => { [selFrom.value, selTo.value] = [selTo.value, selFrom.value]; update(); };
  selFrom.onchange = selTo.onchange = update;

  document.getElementById("dest-info").innerHTML = C.destinations.map(d => {
    const p = d.provenance || {};
    const a = d.attaches[0];
    const fp = d.footprint ? (d.footprint_rel === "destination"
      ? `קווי מתאר: ${link("https://www.openstreetmap.org/" + d.footprint, d.footprint)}`
      : `הנקודה נמצאת בתוך ${link("https://www.openstreetmap.org/" + d.footprint, d.footprint_name || d.footprint)}`) : "ללא קווי מתאר";
    return `<li><b>${esc(d.name)}</b><span class="chip ${esc(p.confidence)}">${esc(p.confidence_he || "לא ידוע")}</span><br>` +
      `${fp}. כניסות ממופות: ${d.entrances_mapped}. ` +
      (a ? (a.valid ? `חיבור משוער לרשת: ${Math.round(a.connector_m)} מ'.` : `<span style="color:#8a1c14">${esc(a.reason)}</span>`) : "") +
      (p.note ? `<br><i>הערת המשתמש: ${esc(p.note)}</i>` : "") +
      (d.sources || []).map(u => " " + link(u, "מקור")).join("") + `</li>`;
  }).join("");
  document.getElementById("sources").innerHTML = C.sources.map(s => `<li>${link(s.url, s.label)} – ${esc(s.detail)}</li>`).join("") +
    `<li>${link("https://maplibre.org", "MapLibre GL JS")} (BSD-3-Clause)</li>`;

  function setData(id, gj) { const s = map.getSource(id); if (s) s.setData(gj); }
  const line = c => ({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: {} });
  const pt = c => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} });

  function update() {
    const from = selFrom.value, to = selTo.value;
    for (const [id, el] of Object.entries(labelEls)) el.classList.remove("sel-from", "sel-to");
    if (from) labelEls[from].classList.add("sel-from");
    if (to) labelEls[to].classList.add("sel-to");
    const lawn = chkLawn.checked;
    history.replaceState(null, "", from || to ? `#from=${from}&to=${to}${lawn ? "&lawn=1" : ""}` : "#");
    const out = document.getElementById("result");
    setData("route", empty); setData("approx", empty); setData("ends", empty); setData("lawnroute", empty);
    if (lawnMarker) { lawnMarker.remove(); lawnMarker = null; }
    if (!from || !to) { out.innerHTML = `<p class="small">בחרו מוצא ויעד, או לחצו על תוויות היעדים במפה.</p>`; return; }
    const r = R.route(from, to, { lawn });
    if (!r.ok) { out.innerHTML = `<div class="error">${esc(r.reason)}</div>`; return; }
    const segs = k => ({ type: "FeatureCollection", features: r.segments.filter(s => s.kind === k).map(s => line(s.coords)) });
    setData("route", segs("path"));
    setData("lawnroute", segs("lawn"));
    const lawnSegs = r.segments.filter(s => s.kind === "lawn");
    if (lawnSegs.length) {
      // label the longest lawn stretch on the map
      const segLen = c => c.slice(1).reduce((a, p, i) => a + Math.hypot((p[0] - c[i][0]) * 94600, (p[1] - c[i][1]) * 111320), 0);
      const longest = lawnSegs.reduce((a, b) => (segLen(b.coords) > segLen(a.coords) ? b : a));
      const c = longest.coords, mid = [(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2];
      const el = document.createElement("div"); el.className = "lbl lawn-lbl"; el.textContent = r.lawn_label;
      lawnMarker = new maplibregl.Marker({ element: el, anchor: "left", offset: [10, 0] }).setLngLat(mid).addTo(map);
    }
    setData("approx", { type: "FeatureCollection", features: [r.start, r.end].filter(c => c.coords).map(c => line(c.coords)) });
    setData("ends", { type: "FeatureCollection", features: [pt(r.start.network_point), pt(r.end.network_point)] });
    out.innerHTML =
      `<div class="dist">כ-${r.total_m} מ'</div>` +
      `<div class="dist-break">${r.path_m} מ' בשבילים ממופים` +
        (r.lawn_m ? ` + <b class="lawn-txt">${r.lawn_m} מ' בקיצורי דרך משוערים בדשא</b> (קו ירוק מקווקו)` : "") +
        ` + ${r.approx_m} מ' בחיבורים משוערים לבניינים (קו כתום מקווקו)</div>` +
      (lawn ? (r.lawn_m
        ? `<div class="notice lawn">${esc(r.lawn_label)}. המסלול חוצה ${lawnSegs.length === 1 ? "קטע דשא אחד" : lawnSegs.length + " קטעי דשא"} בקו ישר. השטחים מסומנים ב-OSM כ"פארק" בתוך הקמפוס; הנתונים אינם קובעים אם יש בהם מדרגות, קירות תמך, צמחייה צפופה או גדר שאינה ממופה.</div>`
        : `<div class="notice">לא נמצא קיצור דרך בדשא שמקצר מסלול זה (מתוך השטחים שנבדקו), ולכן המסלול זהה למסלול השבילים בלבד.</div>`) : "") +
      `<div class="notice">המסלול הקצר ביותר <b>${lawn ? "ברשת ההליכה שנכללה בפרויקט ובקיצורי הדשא שהוסקו ממנה" : "ברשת ההליכה שנכללה בפרויקט"}</b>. הכניסות לבניינים אינן ממופות, ולכן תחילת המסלול וסופו משוערים – אין דיוק מדלת לדלת.</div>` +
      (r.any_invalid ? `<div class="error">לאחד הקצוות אין חיבור סביר לרשת; המסלול מוצג רק עד נקודת הקצה הממופה.</div>` : "") +
      `<h2>הוראות הליכה</h2><ol class="steps">` +
      r.steps.map(s => `<li class="${s.kind === "warn" ? "warn" : s.approx ? "approx" : s.lawn ? "lawn" : ""}">${esc(s.text)}</li>`).join("") + `</ol>`;
    const all = r.network.coords.concat(...[r.start, r.end].filter(c => c.coords).map(c => c.coords));
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    map.fitBounds(b, { padding: 80, maxZoom: 18.2, pitch: map.getPitch(), bearing: map.getBearing() });
  }

  // initial selection: URL hash, else a demo route
  const h = new URLSearchParams(location.hash.slice(1));
  selFrom.value = destById[h.get("from")] ? h.get("from") : (location.hash ? "" : "sprinzak");
  selTo.value = destById[h.get("to")] ? h.get("to") : (location.hash ? "" : "canada");
  chkLawn.checked = h.get("lawn") === "1";
  map.on("load", () => map.setLayoutProperty("lawns", "visibility", chkLawn.checked ? "visible" : "none"));
  if (!R.hasLawnData) { chkLawn.disabled = true; document.getElementById("lawn-help").textContent = "אין בנתונים שטחי דשא שניתן להעריך, ולכן האפשרות אינה זמינה."; }
  map.on("load", update);
  window.__app = { map, route: R.route, update }; // for manual testing in the console
})();
