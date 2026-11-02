/* Panel + glue. Routing lives in route.js (unchanged), drawing in scene3d.js. */
import { createCampusScene } from "./scene3d.js";

const C = window.CAMPUS, S = window.SCENERY;
const R = window.CampusRoute.create(C);
const destById = Object.fromEntries(C.destinations.map(d => [d.id, d]));
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>`;

// ---------- quality preference: URL ?fx= / #fx=, saved choice, else a device guess
const PREF_KEY = "givatram-fx";
const hash = new URLSearchParams(location.hash.slice(1));
function initialQuality() {
  const q = hash.get("fx") || new URLSearchParams(location.search).get("fx");
  if (q === "low" || q === "high") return q;
  try { const s = localStorage.getItem(PREF_KEY); if (s === "low" || s === "high") return s; } catch (e) { /* storage blocked */ }
  const weak = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  return weak ? "low" : "high";
}

// ---------- panel: selectors
const selFrom = $("sel-from"), selTo = $("sel-to"), chkLawn = $("chk-lawn");
for (const d of C.destinations) { selFrom.add(new Option(d.name, d.id)); selTo.add(new Option(d.name, d.id)); }
$("btn-swap").onclick = () => { [selFrom.value, selTo.value] = [selTo.value, selFrom.value]; update(true); };
selFrom.onchange = selTo.onchange = () => update(true);
chkLawn.onchange = () => { scene && scene.setLawnAreas(chkLawn.checked); update(true); };
if (!R.hasLawnData) { chkLawn.disabled = true; $("lawn-help").textContent = "אין בנתונים שטחי דשא שניתן להעריך, ולכן האפשרות אינה זמינה."; }

// destination info
$("dest-info").innerHTML = C.destinations.map(d => {
  const p = d.provenance || {};
  const a = d.attaches[0];
  const fp = d.footprint ? (d.footprint_rel === "destination"
    ? `קווי מתאר: ${link("https://www.openstreetmap.org/" + d.footprint, d.footprint)}`
    : `הנקודה נמצאת בתוך ${link("https://www.openstreetmap.org/" + d.footprint, d.footprint_name || d.footprint)}`) : "ללא קווי מתאר";
  return `<li><div class="di-head"><b>${esc(d.name)}</b><span class="chip ${esc(p.confidence)}">${esc(p.confidence_he || "לא ידוע")}</span></div>` +
    `<div>${fp}. כניסות ממופות: ${d.entrances_mapped}. ` +
    (a ? (a.valid ? `חיבור משוער לרשת: ${Math.round(a.connector_m)} מ'.` : `<span class="bad">${esc(a.reason)}</span>`) : "") +
    (p.note ? `<br><i>הערת המשתמש: ${esc(p.note)}</i>` : "") +
    (d.sources || []).map(u => " " + link(u, "מקור")).join("") + `</div></li>`;
}).join("");
$("sources").innerHTML = C.sources.map(s => `<li>${link(s.url, s.label)} – ${esc(s.detail)}</li>`).join("") +
  `<li>${link("https://threejs.org", "three.js")} (MIT) – תצוגה תלת-ממדית</li>`;

// ---------- 3D scene
let scene = null;
const mapEl = $("map");
try {
  scene = createCampusScene($("gl"), $("labels"), C, S, {
    quality: initialQuality(),
    onLabelClick: id => {
      // first click sets the start, second the destination; a third click starts over
      if (!selFrom.value) selFrom.value = id;
      else if (!selTo.value && id !== selFrom.value) selTo.value = id;
      else { selFrom.value = id; selTo.value = ""; }
      update(true);
    },
  });
} catch (e) {
  console.error(e);
  mapEl.classList.add("no-gl");
  $("gl").innerHTML = `<div class="gl-error">התצוגה התלת-ממדית אינה זמינה בדפדפן זה (WebGL). בחירת מסלול, המרחק וההוראות זמינים בחלונית.</div>`;
}

// view controls
document.querySelectorAll("[data-nudge]").forEach(b => { b.onclick = () => scene && scene.nudge(b.dataset.nudge); });
$("btn-reset").onclick = () => scene && scene.resetView();
const chkLow = $("chk-low"), chkDeco = $("chk-deco"), chkNet = $("chk-net");
if (scene) chkLow.checked = scene.quality === "low";
chkLow.onchange = () => {
  const q = chkLow.checked ? "low" : "high";
  try { localStorage.setItem(PREF_KEY, q); } catch (e) { /* ignore */ }
  scene && scene.setQuality(q);
};
chkDeco.onchange = () => scene && scene.setDecorative(chkDeco.checked);
chkNet.onchange = () => scene && scene.setNetwork(chkNet.checked);
$("cnt-deco").textContent = S.trees.filter(t => t[2] === 0).length;
$("cnt-mapped").textContent = S.trees.filter(t => t[2] === 1).length;

// mobile: collapse / expand the panel sheet
$("sheet-toggle").onclick = () => document.body.classList.toggle("sheet-min");

// ---------- route + result
function update(fit) {
  const from = selFrom.value, to = selTo.value, lawn = chkLawn.checked;
  history.replaceState(null, "", from || to ? `#from=${from}&to=${to}${lawn ? "&lawn=1" : ""}` : "#");
  const out = $("result");
  if (scene) { scene.setSelection(from, to); scene.setRoute(null); scene.setLawnLabel(null); }
  if (!from || !to) { out.innerHTML = `<p class="hint">בחרו מוצא ויעד, או לחצו על תוויות היעדים במפה.</p>`; return; }
  const r = R.route(from, to, { lawn });
  if (!r.ok) { out.innerHTML = `<div class="error">${esc(r.reason)}</div>`; return; }
  const lawnSegs = r.segments.filter(s => s.kind === "lawn");
  if (scene) {
    scene.setRoute(r);
    if (lawnSegs.length) {
      const segLen = c => c.slice(1).reduce((a, p, i) => a + Math.hypot((p[0] - c[i][0]) * 94600, (p[1] - c[i][1]) * 111320), 0);
      const longest = lawnSegs.reduce((a, b) => (segLen(b.coords) > segLen(a.coords) ? b : a));
      const c = longest.coords;
      scene.setLawnLabel(r.lawn_label, [(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2]);
    }
    if (fit) scene.fitRoute(r);
  }
  out.innerHTML =
    `<div class="dist-card"><div class="dist">כ-${r.total_m} <span>מ'</span></div>` +
    `<ul class="parts">` +
      `<li><i class="sw-line path"></i>${r.path_m} מ' בשבילים ממופים</li>` +
      (r.lawn_m ? `<li class="lawn-txt"><i class="sw-line lawn"></i>${r.lawn_m} מ' בקיצורי דרך משוערים בדשא</li>` : "") +
      `<li class="approx-txt"><i class="sw-line approx"></i>${r.approx_m} מ' בחיבורים משוערים לבניינים</li>` +
    `</ul></div>` +
    (lawn ? (r.lawn_m
      ? `<div class="notice lawn">${esc(r.lawn_label)}. המסלול חוצה ${lawnSegs.length === 1 ? "קטע דשא אחד" : lawnSegs.length + " קטעי דשא"} בקו ישר. השטחים מסומנים ב-OSM כ"פארק" בתוך הקמפוס; הנתונים אינם קובעים אם יש בהם מדרגות, קירות תמך, צמחייה צפופה או גדר שאינה ממופה.</div>`
      : `<div class="notice">לא נמצא קיצור דרך בדשא שמקצר מסלול זה (מתוך השטחים שנבדקו), ולכן המסלול זהה למסלול השבילים בלבד.</div>`) : "") +
    `<div class="notice">המסלול הקצר ביותר <b>${lawn ? "ברשת ההליכה שנכללה בפרויקט ובקיצורי הדשא שהוסקו ממנה" : "ברשת ההליכה שנכללה בפרויקט"}</b>. הכניסות לבניינים אינן ממופות, ולכן תחילת המסלול וסופו משוערים – אין דיוק מדלת לדלת.</div>` +
    (r.any_invalid ? `<div class="error">לאחד הקצוות אין חיבור סביר לרשת; המסלול מוצג רק עד נקודת הקצה הממופה.</div>` : "") +
    `<h2 class="dir-h">הוראות הליכה</h2><ol class="steps">` +
    r.steps.map(s => `<li class="${s.kind === "warn" ? "warn" : s.approx ? "approx" : s.lawn ? "lawn" : ""}">${esc(s.text)}</li>`).join("") + `</ol>`;
}

// initial selection: URL hash, else a demo route
selFrom.value = destById[hash.get("from")] ? hash.get("from") : (location.hash ? "" : "sprinzak");
selTo.value = destById[hash.get("to")] ? hash.get("to") : (location.hash ? "" : "canada");
chkLawn.checked = hash.get("lawn") === "1";
if (scene) scene.setLawnAreas(chkLawn.checked);
update(false);

window.__app = { route: R.route, update, scene, campus: C };
