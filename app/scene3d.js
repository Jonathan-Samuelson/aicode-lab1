/* Voxel-style 3D campus renderer (three.js, no build step).
 *
 * Draws ONLY. It reads window.CAMPUS (routing data: building footprints, destinations, lawn
 * areas, graph for the optional network overlay) and window.SCENERY (visual-only OSM areas,
 * ways and trees) and never modifies either. Routes are computed by route.js and passed in.
 *
 * World axes: x = east (m), y = up (m), z = south (m), origin at SCENERY.origin, same
 * equirectangular projection as route.js.
 */
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";

const DEG = Math.PI / 180;
const CONF_SHORT = { field: "אומת בשטח (סימון משתמש)", official_map: "לפי מפה רשמית (סימון משתמש)", estimate: "הערכה (סימון משתמש)" };

// ------------------------------------------------------------------ small utils
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function signedArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function pointInRing(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
/** ring without the closing duplicate, as [[x, z], ...] in world metres */
function openRing(r) { const o = r.slice(); const a = o[0], b = o[o.length - 1]; if (a[0] === b[0] && a[1] === b[1]) o.pop(); return o; }

/** Inset (shrink) a ring by d metres with mitred corners. Returns null if the result is degenerate. */
function insetRing(r, d) {
  const n = r.length;
  if (n < 3) return null;
  const ccwSign = signedArea(r) > 0 ? 1 : -1; // in (x, z) coordinates
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = r[(i - 1 + n) % n], p1 = r[i], p2 = r[(i + 1) % n];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    // inward normals (left of edge for CCW in x,z)
    const n1 = [-e1[1] / l1 * ccwSign, e1[0] / l1 * ccwSign], n2 = [-e2[1] / l2 * ccwSign, e2[0] / l2 * ccwSign];
    const s = [n1[0] + n2[0], n1[1] + n2[1]];
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const k = d / Math.max(0.33, 1 + dot); // miter, limited
    out.push([p1[0] + s[0] * k, p1[1] + s[1] * k]);
  }
  // validate: edges keep their direction and the ring keeps orientation and some area
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], A = out[i], B = out[(i + 1) % n];
    if ((b[0] - a[0]) * (B[0] - A[0]) + (b[1] - a[1]) * (B[1] - A[1]) <= 0) return null;
  }
  const a0 = signedArea(r), a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 4) return null;
  return out;
}

// ------------------------------------------------------------------ geometry builder
class GB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.tri = 0; this.owner = []; }
  v(x, y, z, nx, ny, nz, u, w, r, g, b) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, w); this.c.push(r, g, b); }
  /** quad a,b,c,d (counter-clockwise when seen from the side the normal points to) */
  quad(P, N, UV, col, owner = 0) {
    const [a, b, c, d] = P;
    // ensure winding matches the normal
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * N[0] + cy * N[1] + cz * N[2] < 0;
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const i of order) { const q = P[i]; const cc = col[i] || col[0]; this.v(q[0], q[1], q[2], N[0], N[1], N[2], UV[i][0], UV[i][1], cc[0], cc[1], cc[2]); }
    this.tri += 2; this.owner.push(owner, owner);
  }
  triangle(A, B, Cc, N, uvs, col, owner = 0) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
    const cy = uz * vx - ux * vz, cx = uy * vz - uz * vy, cz = ux * vy - uy * vx;
    const pts = cx * N[0] + cy * N[1] + cz * N[2] < 0 ? [[A, uvs[0]], [Cc, uvs[2]], [B, uvs[1]]] : [[A, uvs[0]], [B, uvs[1]], [Cc, uvs[2]]];
    for (const [q, t] of pts) this.v(q[0], q[1], q[2], N[0], N[1], N[2], t[0], t[1], col[0], col[1], col[2]);
    this.tri += 1; this.owner.push(owner);
  }
  box(cx, cy, cz, sx, sy, sz, col, uvScale = 1) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy, y1 = cy + sy, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const sh = (k) => [col[0] * k, col[1] * k, col[2] * k];
    const f = (P, N, k) => this.quad(P, N, [[0, 0], [uvScale, 0], [uvScale, uvScale], [0, uvScale]], [sh(k)]);
    f([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], 1.0);
    f([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], 0.86);
    f([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], 0.86);
    f([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], 0.92);
    f([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], 0.8);
  }
  /** flat polygon (x,z ring) at height y, facing up; uv = world / uvSize */
  cap(ring, y, uvSize, col, owner = 0) {
    const contour = ring.map(p => new THREE.Vector2(p[0], p[1]));
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { return; }
    for (const [a, b, c] of faces) {
      const A = ring[a], B = ring[b], Cc = ring[c];
      this.triangle([A[0], y, A[1]], [B[0], y, B[1]], [Cc[0], y, Cc[1]], [0, 1, 0],
        [[A[0] / uvSize, -A[1] / uvSize], [B[0] / uvSize, -B[1] / uvSize], [Cc[0] / uvSize, -Cc[1] / uvSize]], col, owner);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ pixel textures
function canvasTex(size, draw, renderer, srgb = true) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  draw(ctx, size);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function noiseFill(ctx, size, palette, seed, px = 1) {
  const r = mulberry(seed);
  for (let y = 0; y < size; y += px) for (let x = 0; x < size; x += px) {
    ctx.fillStyle = palette[Math.floor(r() * palette.length)]; ctx.fillRect(x, y, px, px);
  }
}
const STONE = ["#eadcc2", "#e4d5b9", "#efe3cb", "#ddcdb0", "#e8d9be"];
function stoneBlocks(ctx, s, seed) {
  noiseFill(ctx, s, STONE, seed);
  ctx.fillStyle = "#cbb894";
  for (let y = 3; y < s; y += 4) ctx.fillRect(0, y, s, 1);                     // bed joints
  for (let row = 0; row < s / 4; row++) {                                       // head joints, staggered
    const off = row % 2 ? 2 : 6;
    for (let x = off; x < s; x += 8) ctx.fillRect(x, row * 4, 1, 3);
  }
}
/** one wall bay = one 16x16 tile: 1 window bay wide, 1 floor high */
function wallTile(kind) {
  return (ctx, s) => {
    stoneBlocks(ctx, s, 11);
    if (kind === "plain") return;
    const win = kind === "ribbon" ? [1, 5, 14, 6] : kind === "small" ? [5, 4, 6, 7] : [4, 4, 8, 7]; // x, y, w, h (canvas y down)
    const [x, y, w, h] = win;
    ctx.fillStyle = "#b19f7f"; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);         // stone frame / sill
    ctx.fillStyle = "#33495c"; ctx.fillRect(x, y, w, h);                         // glass
    ctx.fillStyle = "#4a6880"; ctx.fillRect(x, y + h - 2, w, 2);
    ctx.fillStyle = "#9cc0d8"; ctx.fillRect(x, y, Math.max(1, Math.floor(w / 3)), 1); ctx.fillRect(x, y, 1, 2); // glint
    ctx.fillStyle = "#c9b897";
    if (kind === "ribbon") for (let mx = x + 4; mx < x + w; mx += 4) ctx.fillRect(mx, y, 1, h);
    else ctx.fillRect(x + Math.floor(w / 2), y, 1, h);
    ctx.fillStyle = "#a89573"; ctx.fillRect(x - 1, y + h + 1, w + 2, 1);         // sill shadow
  };
}
function wallRough(kind) {
  return (ctx, s) => {
    ctx.fillStyle = "#e6e6e6"; ctx.fillRect(0, 0, s, s);
    if (kind === "plain") return;
    const [x, y, w, h] = kind === "ribbon" ? [1, 5, 14, 6] : kind === "small" ? [5, 4, 6, 7] : [4, 4, 8, 7];
    ctx.fillStyle = "#3a3a3a"; ctx.fillRect(x, y, w, h);
  };
}
const TEX_DEF = {
  grass: (c, s) => noiseFill(c, s, ["#6f9e45", "#679741", "#77a64c", "#62903c", "#729f48", "#7cab52"], 3),
  forest: (c, s) => noiseFill(c, s, ["#557f36", "#4e7731", "#5b873b", "#48702d", "#618d40"], 4),
  ground: (c, s) => noiseFill(c, s, ["#cfc5b1", "#c9bfaa", "#d4cab7", "#c4b9a3", "#cdc3ae"], 5),
  paving: (c, s) => { noiseFill(c, s, ["#e2d8c6", "#dbd0bc", "#e6dccb"], 6); c.fillStyle = "#c4b8a2"; for (let i = 0; i < s; i += 4) { c.fillRect(0, i, s, 1); c.fillRect((i / 4) % 2 ? 2 : 0, 0, 0, 0); } for (let y = 0; y < s; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < s; x += 4) c.fillRect(x, y, 1, 4); },
  plaza: (c, s) => { noiseFill(c, s, ["#ebe1cd", "#e4d9c3", "#efe6d4"], 7); c.fillStyle = "#cfc2a8"; for (let i = 0; i < s; i += 8) { c.fillRect(0, i, s, 1); c.fillRect(i, 0, 1, s); } },
  asphalt: (c, s) => noiseFill(c, s, ["#5b5e63", "#565a5f", "#606368", "#52555a"], 8),
  parking: (c, s) => { noiseFill(c, s, ["#6a6d72", "#66696e", "#6f7277"], 9); c.fillStyle = "#cfd2d6"; c.fillRect(0, 0, 1, 6); },
  steps: (c, s) => { noiseFill(c, s, ["#e0d6c2", "#d8cdb7"], 10); c.fillStyle = "#a89c86"; for (let y = 0; y < s; y += 4) c.fillRect(0, y, s, 1); },
  roof: (c, s) => noiseFill(c, s, ["#cdc7bb", "#c6c0b3", "#d3cdc2", "#bfb8ab"], 12),
  tiles: (c, s) => { for (let y = 0; y < s; y++) { c.fillStyle = ["#b4513a", "#a9472f", "#bd5c43", "#9c3f2a"][y % 4]; c.fillRect(0, y, s, 1); } c.fillStyle = "#8a3524"; for (let y = 3; y < s; y += 4) for (let x = (y % 8 === 3) ? 0 : 2; x < s; x += 4) c.fillRect(x, y - 3, 1, 3); },
  pitch: (c, s) => { for (let x = 0; x < s; x++) { c.fillStyle = (Math.floor(x / 4) % 2) ? "#5fae4a" : "#6bb854"; c.fillRect(x, 0, 1, s); } },
  water: (c, s) => noiseFill(c, s, ["#4d8db5", "#4887b0", "#5394bb"], 13),
  construction: (c, s) => noiseFill(c, s, ["#c8a679", "#c09d6f", "#cfad82", "#b8956a"], 14),
  sport: (c, s) => noiseFill(c, s, ["#d0c29f", "#c9ba96", "#d6c8a6"], 15),
  rail: (c, s) => { noiseFill(c, s, ["#8b8378", "#827a70", "#938b80"], 16); c.fillStyle = "#4b4640"; c.fillRect(0, 4, s, 1); c.fillRect(0, 11, s, 1); },
};
const AREA_TEX = { grass: "grass", forest: "forest", parking: "parking", plaza: "plaza", pitch: "pitch", track: "construction", water: "water", construction: "construction", sport: "sport" };
const AREA_Y = { sport: 0.04, grass: 0.08, forest: 0.1, construction: 0.12, parking: 0.14, plaza: 0.16, pitch: 0.18, track: 0.2, water: 0.22 };
const LINE_Y = { highway: 0.26, road: 0.3, rail: 0.33, walk: 0.38, steps: 0.42 };

// ------------------------------------------------------------------ main
export function createCampusScene(container, overlay, C, S, opts = {}) {
  const KX = 111320 * Math.cos(S.lat0 * DEG), KY = 111320;
  const O = S.origin;
  const toW = ll => [(ll[0] - O[0]) * KX, -(ll[1] - O[1]) * KY];   // lon/lat -> world [x, z]
  const mW = p => [p[0], -p[1]];                                   // scenery metres [e, n] -> world [x, z]

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const HAZE = new THREE.Color("#e9dcc6");
  scene.fog = new THREE.Fog(HAZE, 600, 2600);
  const camera = new THREE.PerspectiveCamera(38, 1, 2, 9000);

  // ---------- sky dome (gradient + soft sun glow), unaffected by fog
  const SUN_AZ = 240 * DEG, SUN_EL = 37 * DEG; // from west-south-west, warm afternoon light
  const sunDir = new THREE.Vector3(Math.sin(SUN_AZ) * Math.cos(SUN_EL), Math.sin(SUN_EL), -Math.cos(SUN_AZ) * Math.cos(SUN_EL)).normalize();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color("#6fa3d9") }, horizon: { value: new THREE.Color("#f3dcbc") }, ground: { value: new THREE.Color("#e2d2b6") }, sun: { value: sunDir } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sun; varying vec3 vDir;" +
      "void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(min(1.0, h * 1.6), 0.7)) : mix(horizon, ground, min(1.0, -h * 6.0));" +
      "float g = max(0.0, dot(normalize(vDir), normalize(sun))); c += vec3(1.0, 0.86, 0.62) * (pow(g, 18.0) * 0.35 + pow(g, 400.0) * 0.6);" +
      "gl_FragColor = vec4(c, 1.0); }",
  }));
  sky.renderOrder = -10;
  scene.add(sky);

  // ---------- lights
  const hemi = new THREE.HemisphereLight("#d3e2fb", "#a89474", 0.78);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#ffd7a3", 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // ---------- textures & materials
  const tex = {};
  for (const [k, f] of Object.entries(TEX_DEF)) tex[k] = canvasTex(16, f, renderer);
  const wallKinds = ["standard", "ribbon", "small", "plain"];
  const wallTex = {}, wallRoughTex = {};
  for (const k of wallKinds) { wallTex[k] = canvasTex(16, wallTile(k), renderer); wallRoughTex[k] = canvasTex(16, wallRough(k), renderer, false); }
  const mats = [];
  const std = (o) => { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.92, metalness: 0 }, o)); mats.push(m); return m; };
  const M = {};
  for (const k of wallKinds) M["wall_" + k] = std({ map: wallTex[k], roughnessMap: wallRoughTex[k], roughness: 1, vertexColors: true });
  M.roof = std({ map: tex.roof, vertexColors: true });
  M.tiles = std({ map: tex.tiles, vertexColors: true, roughness: 0.8 });
  for (const k of Object.keys(TEX_DEF)) if (!M[k]) M[k] = std({ map: tex[k], roughness: k === "water" ? 0.25 : 0.95, vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  M.tree = std({ vertexColors: true, roughness: 0.9 });
  M.fence = std({ color: "#9a8f80", roughness: 0.9 });

  const world = new THREE.Group(); scene.add(world);

  // ---------- ground
  const [ex0, ey0, ex1, ey1] = S.extent;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), std({ map: tex.ground, color: "#ffffff" }));
  tex.ground.repeat.set(9000 / 4, 9000 / 4);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  world.add(ground);

  // ---------- mapped areas
  const areaGB = {};
  for (const a of S.areas) {
    const ring = openRing(a.ring.map(mW));
    if (ring.length < 3) continue;
    const k = AREA_TEX[a.kind]; if (!k) continue;
    (areaGB[k] = areaGB[k] || new GB()).cap(ring, AREA_Y[a.kind] || 0.1, 4, [1, 1, 1]);
  }
  for (const [k, gb] of Object.entries(areaGB)) {
    const mesh = new THREE.Mesh(gb.geometry(), M[k]); mesh.receiveShadow = true; world.add(mesh);
  }

  // ---------- mapped roads / paths / rail (ribbons)
  function ribbon(gb, pts, w, y, col, uvMode, extend = true) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 0.01) continue;
      const ux = dx / L, uz = dz / L, nx = -uz * w / 2, nz = ux * w / 2;
      const e = extend ? w / 2 : 0;
      const A = [a[0] - ux * e, a[1] - uz * e], B = [b[0] + ux * e, b[1] + uz * e];
      const P = [[A[0] + nx, y, A[1] + nz], [B[0] + nx, y, B[1] + nz], [B[0] - nx, y, B[1] - nz], [A[0] - nx, y, A[1] - nz]];
      const uv = uvMode === "along" ? [[0, 0], [(L + 2 * e) / 1.0, 0], [(L + 2 * e) / 1.0, 1], [0, 1]]
        : P.map(p => [p[0] / 4, -p[2] / 4]);
      gb.quad(P, [0, 1, 0], uv, [col]);
    }
  }
  const lineGB = {};
  for (const l of S.lines) {
    const pts = l.pts.map(mW);
    const k = l.kind === "walk" ? "paving" : l.kind === "steps" ? "steps" : l.kind === "rail" ? "rail" : "asphalt";
    const gb = lineGB[k] = lineGB[k] || new GB();
    ribbon(gb, pts, l.w, LINE_Y[l.kind] || 0.3, [1, 1, 1], l.kind === "steps" ? "along" : "world");
  }
  for (const [k, gb] of Object.entries(lineGB)) { const m = new THREE.Mesh(gb.geometry(), M[k]); m.receiveShadow = true; world.add(m); }

  // ---------- mapped barriers (thin walls)
  {
    const gb = new GB();
    for (const b of S.barriers) {
      const pts = b.pts.map(mW);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], c = pts[i + 1], dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 0.05) continue;
        const h = 1.6;
        const nx = -dz / L * 0.12, nz = dx / L * 0.12;
        gb.quad([[a[0] + nx, 0, a[1] + nz], [c[0] + nx, 0, c[1] + nz], [c[0] + nx, h, c[1] + nz], [a[0] + nx, h, a[1] + nz]], [nx, 0, nz], [[0, 0], [1, 0], [1, 1], [0, 1]], [[0.9, 0.9, 0.9]]);
        gb.quad([[c[0] - nx, 0, c[1] - nz], [a[0] - nx, 0, a[1] - nz], [a[0] - nx, h, a[1] - nz], [c[0] - nx, h, c[1] - nz]], [-nx, 0, -nz], [[0, 0], [1, 0], [1, 1], [0, 1]], [[0.8, 0.8, 0.8]]);
      }
    }
    if (gb.tri) { const m = new THREE.Mesh(gb.geometry(), M.fence); m.castShadow = true; m.receiveShadow = true; world.add(m); }
  }

  // ---------- buildings (footprints from the routing data file, unchanged)
  const roleOf = {};
  for (const d of C.destinations) if (d.footprint) roleOf[d.footprint] = d.footprint_rel;
  const buildings = C.buildings.map((b, i) => {
    const ring = openRing(b.ll.map(toW));
    const st = (S.building_style && S.building_style[b.osm]) || {};
    let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
    return { i, osm: b.osm, name: b.name, ring, height: b.height, heightKnown: b.height_known, style: st, role: roleOf[b.osm] || null, center: [cx, cz] };
  });
  const wallKindFor = st => {
    const t = st.type || "";
    if (/^(university|college|school|public|office|commercial|civic|hospital)$/.test(t)) return "ribbon";
    if (/^(apartments|dormitory|residential|house|detached|semidetached_house|terrace)$/.test(t)) return "small";
    return "standard";
  };
  const wallGB = { standard: new GB(), ribbon: new GB(), small: new GB(), plain: new GB() };
  const roofGB = new GB(), tileGB = new GB();
  const BAY = 3.2;

  function addWalls(gbs, ring, y0, y1, kind, tint, owner, inward = false, floorsH = null) {
    const n = ring.length;
    const outwardSign = signedArea(ring) > 0 ? 1 : -1;
    const h = y1 - y0;
    const floors = floorsH ? Math.max(1, Math.round(floorsH / 3.5)) : Math.max(1, Math.round(h / 3.5));
    const vTop = floorsH ? floors * (h / floorsH) : floors;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      // outward normal: right of edge for CCW rings in (x,z) – sign from ring orientation
      let nx = dz / L * outwardSign, nz = -dx / L * outwardSign;
      if (inward) { nx = -nx; nz = -nz; }
      const shortEdge = L < BAY * 0.55 || kind === "plain";
      const k = shortEdge ? "plain" : kind;
      const bays = Math.max(1, Math.round(L / BAY));
      const u1 = shortEdge ? L / BAY : bays;
      const ao = Math.min(h, 2.6);
      const dark = [tint[0] * 0.62, tint[1] * 0.62, tint[2] * 0.64];
      // lower band (ambient-occlusion darkening near the ground) and upper part
      const vAo = vTop * (ao / h);
      gbs[k].quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y0 + ao, b[1]], [a[0], y0 + ao, a[1]]], [nx, 0, nz],
        [[0, 0], [u1, 0], [u1, vAo], [0, vAo]], [dark, dark, tint, tint], owner);
      if (h > ao + 0.01) gbs[k].quad([[a[0], y0 + ao, a[1]], [b[0], y0 + ao, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [nx, 0, nz],
        [[0, vAo], [u1, vAo], [u1, vTop], [0, vTop]], [tint], owner);
    }
  }

  for (const b of buildings) {
    const r = mulberry(hashStr(b.osm));
    const tone = 0.9 + r() * 0.14;
    const tint = [tone * (1 + (r() - 0.5) * 0.04), tone, tone * (0.96 + r() * 0.06)];
    const kind = wallKindFor(b.style);
    const H = b.height;
    const tiled = b.style.roof_shape === "hipped" || b.style.roof_shape === "gabled" || b.style.roof_material === "roof_tiles";
    if (tiled) {
      // stepped (voxel) hipped roof: successive insets, as in block-built roofs
      const wallH = Math.max(3, H - 1.6);
      addWalls(wallGB, b.ring, 0, wallH, kind, tint, b.i);
      let ring = b.ring, y = wallH;
      const ledge = (rg, yy) => tileGB.cap(rg, yy, 2, [1, 1, 1], b.i);
      ledge(ring, y);
      for (let s = 0; s < 4; s++) {
        const nr = insetRing(ring, 0.75);
        if (!nr) break;
        const gbs = { standard: tileGB, ribbon: tileGB, small: tileGB, plain: tileGB };
        addWalls(gbs, nr, y, y + 0.45, "plain", [0.85, 0.85, 0.85], b.i);
        y += 0.45; ring = nr; ledge(ring, y);
      }
      b.top = y;
    } else {
      addWalls(wallGB, b.ring, 0, H, kind, tint, b.i, false, H);
      const area = Math.abs(signedArea(b.ring));
      const inner = area > 120 ? insetRing(b.ring, 0.45) : null;
      if (inner) {
        // parapet: outer wall continues 0.7 m above the roof, inner face, and a capping strip
        addWalls(wallGB, b.ring, H, H + 0.7, "plain", tint, b.i);
        addWalls(wallGB, inner, H, H + 0.7, "plain", [tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85], b.i, true);
        const n = b.ring.length, y = H + 0.7;
        for (let i = 0; i < n; i++) {
          const a = b.ring[i], c = b.ring[(i + 1) % n], A = inner[i], Cc = inner[(i + 1) % n];
          wallGB.plain.quad([[a[0], y, a[1]], [c[0], y, c[1]], [Cc[0], y, Cc[1]], [A[0], y, A[1]]], [0, 1, 0],
            [[a[0] / 3, a[1] / 3], [c[0] / 3, c[1] / 3], [Cc[0] / 3, Cc[1] / 3], [A[0] / 3, A[1] / 3]], [[tint[0] * 1.05, tint[1] * 1.05, tint[2] * 1.05]], b.i);
        }
        roofGB.cap(inner, H, 4, [0.98, 0.98, 0.98], b.i);
        b.top = H + 0.7;
      } else {
        roofGB.cap(b.ring, H, 4, [0.98, 0.98, 0.98], b.i);
        b.top = H;
      }
    }
  }
  const pickMeshes = [];
  const addBuildingMesh = (gb, mat) => {
    if (!gb.tri) return;
    const m = new THREE.Mesh(gb.geometry(), mat);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.owner = Uint16Array.from(gb.owner);
    world.add(m); pickMeshes.push(m);
  };
  for (const k of wallKinds) addBuildingMesh(wallGB[k], M["wall_" + k]);
  addBuildingMesh(roofGB, M.roof);
  addBuildingMesh(tileGB, M.tiles);
  const bByOsm = Object.fromEntries(buildings.map(b => [b.osm, b]));

  // ---------- trees (voxel), mapped first, then decorative in shuffled order
  const treeGeo = (() => {
    const gb = new GB();
    gb.box(0, 0, 0, 0.7, 3.0, 0.7, [0.45, 0.32, 0.2]);
    gb.box(0, 2.4, 0, 3.6, 2.2, 3.6, [0.3, 0.5, 0.2]);
    gb.box(0, 2.9, 0, 4.6, 1.2, 2.2, [0.27, 0.46, 0.18]);
    gb.box(0, 2.9, 0, 2.2, 1.2, 4.6, [0.28, 0.48, 0.19]);
    gb.box(0, 4.6, 0, 2.2, 1.1, 2.2, [0.34, 0.56, 0.23]);
    return gb.geometry();
  })();
  const mappedTrees = S.trees.filter(t => t[2] === 1), decoTrees = S.trees.filter(t => t[2] === 0);
  {
    const r = mulberry(99);
    for (let i = decoTrees.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [decoTrees[i], decoTrees[j]] = [decoTrees[j], decoTrees[i]]; }
  }
  function treeMesh(list, seed, tintBase) {
    const im = new THREE.InstancedMesh(treeGeo, M.tree, Math.max(1, list.length));
    const r = mulberry(seed), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    list.forEach((t, i) => {
      const [x, z] = mW(t);
      const k = 0.8 + r() * 0.55;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.floor(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.3);
      m4.compose(p.set(x, 0, z), q, s.set(k, k * (0.9 + r() * 0.25), k));
      im.setMatrixAt(i, m4);
      col.setRGB(tintBase[0] * (0.85 + r() * 0.3), tintBase[1] * (0.88 + r() * 0.24), tintBase[2] * (0.85 + r() * 0.3));
      im.setColorAt(i, col);
    });
    im.count = list.length;
    im.castShadow = true; im.receiveShadow = true;
    world.add(im);
    return im;
  }
  const mappedTreeMesh = treeMesh(mappedTrees, 7, [1, 1, 1]);
  const decoTreeMesh = treeMesh(decoTrees, 8, [0.97, 1, 0.95]);

  // ---------- overlays: lawn candidate areas, walking network (optional)
  const overlayGroup = new THREE.Group(); world.add(overlayGroup);
  const lawnGroup = new THREE.Group(); lawnGroup.visible = false; overlayGroup.add(lawnGroup);
  {
    const fill = new GB(), edge = new GB();
    for (const l of C.lawns || []) {
      const ring = openRing(l.ll.map(toW));
      fill.cap(ring, 0.5, 4, [1, 1, 1]);
      ribbon(edge, ring.concat([ring[0]]), 0.9, 0.52, [1, 1, 1], "world", false);
    }
    lawnGroup.add(new THREE.Mesh(fill.geometry(), new THREE.MeshBasicMaterial({ color: "#8ce99a", transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false })));
    lawnGroup.add(new THREE.Mesh(edge.geometry(), new THREE.MeshBasicMaterial({ color: "#2b8a3e", transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false })));
  }
  const netGroup = new THREE.Group(); netGroup.visible = false; overlayGroup.add(netGroup);
  {
    const gb = new GB(), G = C.graph;
    for (const [a, b] of G.edges) ribbon(gb, [toW(G.nodes[a]), toW(G.nodes[b])], 0.7, 0.56, [1, 1, 1], "world", false);
    netGroup.add(new THREE.Mesh(gb.geometry(), new THREE.MeshBasicMaterial({ color: "#3d5a80", transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })));
  }

  // ---------- destination accents (persistent) and selection highlights
  const accentGroup = new THREE.Group(); world.add(accentGroup);
  const ROLE_COL = { destination: "#e64980", contains_point: "#f59f00" };
  for (const b of buildings) if (b.role) {
    const gb = new GB(); gb.cap(b.ring, b.top + 0.08, 4, [1, 1, 1]);
    const m = new THREE.Mesh(gb.geometry(), new THREE.MeshBasicMaterial({ color: ROLE_COL[b.role], transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false }));
    accentGroup.add(m);
  }
  const selGroup = new THREE.Group(); world.add(selGroup);
  const SEL_COL = { from: "#2f9e44", to: "#e03131" };
  function buildingShell(b) {
    const gb = new GB(); const gbs = { standard: gb, ribbon: gb, small: gb, plain: gb };
    addWalls(gbs, b.ring, 0, b.top, "plain", [1, 1, 1], 0); gb.cap(b.ring, b.top + 0.05, 4, [1, 1, 1]);
    return gb.geometry();
  }
  function selectionFor(d, role) {
    const g = new THREE.Group(), color = SEL_COL[role];
    const b = d.footprint && bByOsm[d.footprint];
    if (b) {
      g.add(new THREE.Mesh(buildingShell(b), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false })));
      const halo = new GB(); ribbon(halo, b.ring.concat([b.ring[0]]), 1.6, 0.6, [1, 1, 1], "world", true);
      const top = new GB(); ribbon(top, b.ring.concat([b.ring[0]]), 0.5, b.top + 0.15, [1, 1, 1], "world", true);
      for (const gb of [halo, top]) g.add(new THREE.Mesh(gb.geometry(), new THREE.MeshBasicMaterial({ color, toneMapped: false })));
    } else if (d.location) {
      const [x, z] = toW(d.location);
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.4, 32), new THREE.MeshBasicMaterial({ color, toneMapped: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.62, z); g.add(ring);
    }
    return g;
  }

  // ---------- route
  const routeGroup = new THREE.Group(); world.add(routeGroup);
  const ROUTE = { path: "#2a6fdb", lawn: "#2b9a48", approx: "#f0700f", casing: "#ffffff" };
  function dashed(coords, dash, gap) {
    const out = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s < L; s += dash + gap) {
        const e = Math.min(L, s + dash), t0 = s / L, t1 = e / L;
        out.push([[a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]]);
      }
    }
    return out;
  }
  function routeMeshes(gb, color, y, ghost) {
    const solid = new THREE.Mesh(gb.geometry(), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    solid.renderOrder = 5;
    routeGroup.add(solid);
    if (ghost) { // faint copy drawn on top of everything: keeps routes readable behind buildings
      const g = new THREE.Mesh(solid.geometry, new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false }));
      g.renderOrder = 20; routeGroup.add(g);
    }
  }
  let lastRoute = null, routeScale = 1;
  function scaleForDistance() { const d = camera.position.distanceTo(controls.target); return THREE.MathUtils.clamp(d / 250, 1, 4.2); }
  function setRoute(r) {
    lastRoute = r; routeScale = scaleForDistance();
    const W = routeScale;
    for (const c of routeGroup.children.slice()) { routeGroup.remove(c); c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); }
    if (!r || !r.ok) { requestRender(); return; }
    const casing = new GB(), path = new GB(), lawn = new GB(), approx = new GB(), ends = new GB();
    for (const s of r.segments) {
      const pts = s.coords.map(toW);
      ribbon(casing, pts, (s.kind === "lawn" ? 3.4 : 4.2) * W, 0.74, [1, 1, 1], "world", true);
      if (s.kind === "path") ribbon(path, pts, 2.8 * W, 0.8, [1, 1, 1], "world", true);
      else for (const seg of dashed(pts, 3.2 * W, 2.2 * W)) ribbon(lawn, seg, 2.4 * W, 0.8, [1, 1, 1], "world", false);
    }
    for (const c of [r.start, r.end]) if (c && c.coords) {
      const pts = c.coords.map(toW);
      ribbon(casing, pts, 3.0 * Math.min(W, 1.8), 0.76, [1, 1, 1], "world", true);
      for (const seg of dashed(pts, 1.6, 1.2)) ribbon(approx, seg, 2.0 * Math.min(W, 1.8), 0.82, [1, 1, 1], "world", false);
    }
    routeMeshes(casing, ROUTE.casing, 0, false);
    routeMeshes(path, ROUTE.path, 0, true);
    if (lawn.tri) routeMeshes(lawn, ROUTE.lawn, 0, true);
    if (approx.tri) routeMeshes(approx, ROUTE.approx, 0, true);
    for (const c of [r.start, r.end]) if (c && c.network_point) {
      const [x, z] = toW(c.network_point);
      const o = new THREE.Mesh(new THREE.CylinderGeometry(2.2 * Math.min(W, 2), 2.2 * Math.min(W, 2), 0.5, 24), new THREE.MeshBasicMaterial({ color: ROUTE.approx, toneMapped: false }));
      const i = new THREE.Mesh(new THREE.CylinderGeometry(1.3 * Math.min(W, 2), 1.3 * Math.min(W, 2), 0.6, 24), new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
      o.position.set(x, 0.9, z); i.position.set(x, 0.95, z); o.renderOrder = i.renderOrder = 6;
      routeGroup.add(o, i);
    }
    requestRender();
  }

  // ---------- labels (HTML, greedy de-overlap)
  const labels = []; // {el, world: Vector3, prio, kind, id?}
  function addLabel(el, pos, prio, kind) { overlay.appendChild(el); const L = { el, pos, prio, kind, w: 0, h: 0 }; labels.push(L); return L; }
  const destLabels = {};
  {
    const byPoint = {};
    for (const d of C.destinations) if (d.location) (byPoint[d.location.join(",")] = byPoint[d.location.join(",")] || []).push(d);
    for (const ds of Object.values(byPoint)) {
      const el = document.createElement("div");
      el.className = "lbl dest";
      el.innerHTML = ds.map(d => `<span class="lbl-name" data-id="${d.id}">${esc(d.name)}</span>`).join('<span class="lbl-sep">·</span>') +
        (ds.length > 1 ? `<span class="conf">נקודה משותפת במקור הנתונים</span>` : "") +
        ds.filter(d => d.provenance && d.provenance.source === "user").map(d => `<span class="conf">${ds.length > 1 ? esc(d.name) + ": " : ""}${esc(CONF_SHORT[d.provenance.confidence] || d.provenance.confidence_he)}</span>`).join("");
      const d0 = ds[0], b = d0.footprint && bByOsm[d0.footprint];
      const [x, z] = toW(d0.location);
      const L = addLabel(el, new THREE.Vector3(x, (b ? b.top : 0) + 3, z), 10, "dest");
      L.ids = ds.map(d => d.id);
      ds.forEach(d => { destLabels[d.id] = L; });
      el.addEventListener("click", ev => {
        ev.stopPropagation();
        const t = ev.target.closest("[data-id]") || el.querySelector("[data-id]");
        if (opts.onLabelClick) opts.onLabelClick(t.dataset.id);
      });
    }
    const destFp = new Set(C.destinations.map(d => d.footprint).filter(Boolean));
    for (const lm of C.landmarks) {
      if (destFp.has(lm.osm)) continue;
      const b = bByOsm[lm.osm];
      const el = document.createElement("div"); el.className = "lm"; el.textContent = lm.name;
      const [x, z] = toW(lm.point);
      addLabel(el, new THREE.Vector3(x, (b ? b.top : 8) + 1.5, z), 1, "lm");
    }
  }
  let lawnLabel = null;
  function setLawnLabel(text, lonlat) {
    if (lawnLabel) { lawnLabel.el.remove(); labels.splice(labels.indexOf(lawnLabel), 1); lawnLabel = null; }
    if (!text) return;
    const el = document.createElement("div"); el.className = "lbl lawn-lbl"; el.textContent = text;
    const [x, z] = toW(lonlat);
    lawnLabel = addLabel(el, new THREE.Vector3(x, 1.5, z), 9, "lawn");
    requestRender();
  }
  const v3 = new THREE.Vector3();
  function layoutLabels() {
    const W = overlay.clientWidth, H = overlay.clientHeight;
    const dist = camera.position.distanceTo(controls.target);
    const placed = [];
    const order = labels.slice().sort((a, b) => b.prio - a.prio);
    for (const L of order) {
      v3.copy(L.pos).project(camera);
      const visible = v3.z < 1 && v3.x > -1.2 && v3.x < 1.2 && v3.y > -1.2 && v3.y < 1.2;
      if (!visible || (L.kind === "lm" && dist > 700)) { L.el.style.display = "none"; continue; }
      L.el.style.display = "";
      if (!L.w || L.dirty) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; L.dirty = false; }
      const sx = (v3.x + 1) / 2 * W, sy = (1 - v3.y) / 2 * H;
      let x = sx - L.w / 2, y = L.kind === "lawn" ? sy + 8 : sy - L.h - 6;
      x = Math.max(4, Math.min(W - L.w - 4, x)); y = Math.max(4, Math.min(H - L.h - 4, y));
      const overlaps = (bx, by) => placed.some(p => bx < p.x + p.w + 3 && bx + L.w + 3 > p.x && by < p.y + p.h + 2 && by + L.h + 2 > p.y);
      if (L.kind === "lm") {
        if (overlaps(x, y)) { L.el.style.display = "none"; continue; }
      } else {
        // destinations and uncertainty labels are never hidden: nudge them until free
        const tries = [0, -1, 1, -2, 2, -3, 3];
        let ok = false;
        for (const t of tries) {
          const yy = y + t * (L.h + 3);
          if (yy < 4 || yy > H - L.h - 4) continue; // stay inside the map
          if (!overlaps(x, yy)) { y = yy; ok = true; break; }
        }
        if (!ok) for (const dx of [L.w * 0.6, -L.w * 0.6]) { const xx = x + dx; if (xx >= 4 && xx <= W - L.w - 4 && !overlaps(xx, y)) { x = xx; break; } }
      }
      placed.push({ x, y, w: L.w, h: L.h });
      L.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    if (popup) placePopup();
  }

  // ---------- building popup
  let popup = null;
  function placePopup() {
    v3.copy(popup.pos).project(camera);
    if (v3.z > 1) { popup.el.style.display = "none"; return; }
    popup.el.style.display = "";
    const W = overlay.clientWidth, H = overlay.clientHeight;
    popup.el.style.transform = `translate(${Math.round((v3.x + 1) / 2 * W - popup.el.offsetWidth / 2)}px, ${Math.round((1 - v3.y) / 2 * H - popup.el.offsetHeight - 10)}px)`;
  }
  function closePopup() { if (popup) { popup.el.remove(); popup = null; } }
  function openPopup(b, point) {
    closePopup();
    const el = document.createElement("div"); el.className = "popup";
    const st = b.style || {};
    const hText = st.height_source === "levels" ? `גובה לפי מספר הקומות ב-OSM (${esc(st.levels)})`
      : st.height_source === "height" ? "גובה לפי תג height ב-OSM" : "גובה איורי – אין נתון גובה ב-OSM";
    el.innerHTML = `<button class="popup-x" aria-label="סגירה">×</button><b>${esc(b.name || "בניין ללא שם ב-OSM")}</b>` +
      `<div class="popup-meta">${hText}</div>` +
      `<a href="https://www.openstreetmap.org/${esc(b.osm)}" target="_blank" rel="noopener">${esc(b.osm)}</a>`;
    el.querySelector(".popup-x").onclick = closePopup;
    overlay.appendChild(el);
    popup = { el, pos: point.clone() };
    placePopup();
  }

  // ---------- camera & controls
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.minDistance = 35; controls.maxDistance = 1900;
  controls.maxPolarAngle = 78 * DEG;
  controls.rotateSpeed = 0.6; controls.zoomSpeed = 1.1;
  controls.addEventListener("change", () => requestRender());

  const destPts = C.destinations.filter(d => d.location).map(d => toW(d.location));
  const home = (() => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of destPts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 + 20, size: Math.max(x1 - x0, z1 - z0) + 260 };
  })();
  const HOME_PHI = 60 * DEG, HOME_THETA = 22 * DEG; // looking north-north-west, sun from the left
  function radiusFor(size) {
    const fov = camera.fov * DEG, aspect = camera.aspect || 1;
    return size / 2 / Math.tan(fov / 2) / Math.min(1, aspect) * 1.05;
  }
  const sph = new THREE.Spherical();
  let tween = null;
  function currentView() {
    const off = camera.position.clone().sub(controls.target); sph.setFromVector3(off);
    return { target: controls.target.clone(), r: sph.radius, phi: sph.phi, theta: sph.theta };
  }
  function applyView(v) {
    const off = new THREE.Vector3().setFromSphericalCoords(v.r, v.phi, v.theta);
    controls.target.copy(v.target); camera.position.copy(v.target).add(off); camera.lookAt(v.target);
  }
  function flyTo(to, ms = 800) {
    const from = currentView();
    if (to.theta !== undefined) { // shortest rotation
      let d = to.theta - from.theta; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; to.theta = from.theta + d;
    }
    tween = { from, to: Object.assign({}, from, to), t0: performance.now(), ms };
    requestRender();
  }
  function resetView(ms = 900) {
    flyTo({ target: new THREE.Vector3(home.cx, 0, home.cz), r: radiusFor(home.size), phi: HOME_PHI, theta: HOME_THETA }, ms);
  }
  function fitPoints(pts) {
    if (!pts.length) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const v = currentView();
    flyTo({ target: new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), r: Math.min(1400, Math.max(140, radiusFor(Math.max(x1 - x0, z1 - z0) * 1.35 + 60))), phi: Math.min(v.phi, 58 * DEG) });
  }
  function nudge(kind) {
    const v = currentView();
    if (kind === "in") flyTo({ r: Math.max(controls.minDistance, v.r * 0.7) }, 350);
    else if (kind === "out") flyTo({ r: Math.min(controls.maxDistance, v.r * 1.4) }, 350);
    else if (kind === "left") flyTo({ theta: v.theta + 30 * DEG }, 450);
    else if (kind === "right") flyTo({ theta: v.theta - 30 * DEG }, 450);
    else if (kind === "tilt-up") flyTo({ phi: Math.max(0.01, v.phi - 12 * DEG) }, 400);
    else if (kind === "tilt-down") flyTo({ phi: Math.min(controls.maxPolarAngle, v.phi + 12 * DEG) }, 400);
    else if (kind === "top") flyTo({ phi: 0.01 }, 600);
  }

  // ---------- picking (click vs drag)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const rc = renderer.domElement.getBoundingClientRect();
    ndc.set((e.clientX - rc.left) / rc.width * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickMeshes, false)[0];
    if (hit) { const b = buildings[hit.object.userData.owner[hit.faceIndex]]; if (b) openPopup(b, hit.point); }
    else closePopup();
    requestRender();
  });

  // ---------- quality
  let quality = "high";
  function setQuality(q) {
    quality = q === "low" ? "low" : "high";
    const hi = quality === "high";
    renderer.setPixelRatio(hi ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    renderer.shadowMap.enabled = hi;
    sun.castShadow = hi;
    for (const m of mats) m.needsUpdate = true;
    decoTreeMesh.count = hi ? decoTrees.length : Math.floor(decoTrees.length * 0.45);
    scene.fog.near = hi ? 600 : 500;
    resize();
    requestRender();
  }

  // ---------- render loop (on demand)
  let needs = true, frames = 0, frameTimeSum = 0, last = 0;
  function requestRender() { needs = true; }
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
    camera.aspect = w / h; camera.updateProjectionMatrix();
    for (const L of labels) L.dirty = true;
    requestRender();
  }
  new ResizeObserver(resize).observe(container);

  function updateSunAndFog() {
    const t = controls.target, dist = camera.position.distanceTo(t);
    const span = THREE.MathUtils.clamp(dist * 0.85, 120, 1100);
    sun.position.copy(t).addScaledVector(sunDir, 1600);
    sun.target.position.copy(t);
    const sc = sun.shadow.camera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 200; sc.far = 3400;
    sc.updateProjectionMatrix();
    scene.fog.near = dist * (quality === "high" ? 1.15 : 1.0);
    scene.fog.far = dist * 4.2 + 600;
    sky.position.copy(camera.position);
  }
  function loop(now) {
    requestAnimationFrame(loop);
    if (tween) {
      const k = Math.min(1, (now - tween.t0) / tween.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const a = tween.from, b = tween.to;
      applyView({ target: a.target.clone().lerp(b.target, e), r: a.r + (b.r - a.r) * e, phi: a.phi + (b.phi - a.phi) * e, theta: a.theta + (b.theta - a.theta) * e });
      if (k >= 1) tween = null;
      needs = true;
    }
    const moved = controls.update();
    if (!needs && !moved) return;
    needs = false;
    // keep the target on the campus
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, ex0 - 200, ex1 + 200);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -ey1 - 200, -ey0 + 200);
    controls.target.y = 0;
    updateSunAndFog();
    if (lastRoute && Math.abs(Math.log(scaleForDistance() / routeScale)) > 0.18) setRoute(lastRoute);
    const t0 = performance.now();
    renderer.render(scene, camera);
    layoutLabels();
    const dt = performance.now() - t0;
    if (frames < 90) { frames++; frameTimeSum += dt + (last ? Math.max(0, now - last - 16.7) * 0 : 0); }
    last = now;
  }

  // ---------- public API
  let selection = { from: null, to: null };
  function setSelection(fromId, toId) {
    for (const c of selGroup.children.slice()) selGroup.remove(c);
    for (const L of Object.values(destLabels)) L.el.classList.remove("sel-from", "sel-to");
    const byId = Object.fromEntries(C.destinations.map(d => [d.id, d]));
    if (fromId && byId[fromId]) { selGroup.add(selectionFor(byId[fromId], "from")); destLabels[fromId].el.classList.add("sel-from"); }
    if (toId && byId[toId]) { selGroup.add(selectionFor(byId[toId], "to")); destLabels[toId].el.classList.add("sel-to"); }
    for (const L of Object.values(destLabels)) { L.dirty = true; L.prio = L.el.classList.contains("sel-from") || L.el.classList.contains("sel-to") ? 12 : 10; }
    selection = { from: fromId, to: toId };
    requestRender();
  }
  function fitRoute(r) {
    if (!r || !r.ok) return;
    const pts = r.network.coords.map(toW).concat(...[r.start, r.end].filter(c => c.coords).map(c => c.coords.map(toW)));
    fitPoints(pts);
  }

  resize();
  applyView({ target: new THREE.Vector3(home.cx, 0, home.cz), r: radiusFor(home.size), phi: HOME_PHI, theta: HOME_THETA });
  controls.update();
  setQuality(opts.quality || "high");
  requestAnimationFrame(loop);

  return {
    setRoute, setSelection, fitRoute, resetView, nudge, setQuality, setLawnLabel,
    setLawnAreas: v => { lawnGroup.visible = !!v; requestRender(); },
    setNetwork: v => { netGroup.visible = !!v; requestRender(); },
    setDecorative: v => { decoTreeMesh.visible = !!v; requestRender(); },
    get quality() { return quality; },
    stats: () => ({ frames, avgRenderMs: frames ? frameTimeSum / frames : null, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      buildings: buildings.length, trees: { mapped: mappedTrees.length, decorative: decoTrees.length }, quality }),
    labelsInfo: () => labels.map(L => ({ kind: L.kind, text: L.el.textContent, shown: L.el.style.display !== "none", rect: L.el.style.display !== "none" ? L.el.getBoundingClientRect().toJSON() : null })),
    renderer, camera, controls, scene,
  };
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
