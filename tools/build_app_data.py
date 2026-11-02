"""Build app/data/campus-data.js for the 3D walking map.

Usage: python3 tools/build_app_data.py [corrections.json]

Inputs : data/raw/osm_givat_ram_2026-11-02.json        (OSM snapshot)
         data/corrections/givat-ram-location-corrections.json  (exported from review/)
Output : app/data/campus-data.js  (window.CAMPUS = {...})

Rules (see README):
- Pedestrian graph = OSM highway ways that pedestrians may use according to their tags.
  Vehicle-only, private / customers-only, and roads whose sidewalks are mapped
  separately are excluded. Gates that are locked / access=no / foot=destination block passage.
- Destination locations come from the user's corrections (with their recorded
  confidence) or from OSM. Nothing is invented: when only one shared point exists,
  both destinations use it.
- No entrances are mapped, so each destination gets an APPROXIMATE connection from
  its building outline (or point) to the network. A connection is accepted only if it
  is <= MAX_CONNECTOR_M and does not cross any mapped building or barrier.
  Otherwise it is marked invalid and the app stops at the network endpoint.
"""
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "raw", "osm_givat_ram_2026-11-02.json")
CORR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "corrections", "givat-ram-location-corrections.json")
OUT = os.path.join(ROOT, "app", "data", "campus-data.js")

BBOX = (31.7700, 35.1925, 31.7800, 35.2012)  # S, W, N, E – buildings shown
GRAPH_BBOX = (31.7690, 35.1880, 31.7800, 35.2060)  # whole snapshot
MAX_CONNECTOR_M = 40.0
SEARCH_M = 80.0
LEVEL_H = 3.5
DEFAULT_H = 9.0

BOOKLET = "https://www.cs.huji.ac.il/w~raananf/givat_ram_hebrew.pdf"
MATH_VISITOR = "https://mathematics.huji.ac.il/node/3066979"
CAMPUS_OUTLINE = 44139761  # OSM way "האוניברסיטה העברית - קמפוס גבעת רם"

# ---- lawn shortcuts (optional routing mode)
# OSM has no landuse=grass in this area. The only mapped open green areas inside the campus
# outline are tagged leisure=park (plus meadow / village_green if present). They are used as
# *candidate* lawns; whether a given stretch is actually walkable is not in the data.
LAWN_TAGS = {("leisure", "park"), ("landuse", "grass"), ("landuse", "meadow"), ("landuse", "village_green")}
LAWN_SNAP_M = 2.5       # a path node within this distance of a lawn edge may start a shortcut
LAWN_MAX_M = 250.0      # longest single shortcut considered
LAWN_MIN_SAVING_M = 3.0  # shortcuts that save less than this over the mapped paths are not offered
OBSTACLE_AREAS = {
    "leisure": {"pitch", "playground", "garden", "sports_centre", "stadium", "track", "swimming_pool",
                "dog_park", "fitness_station", "outdoor_seating"},
    "landuse": {"construction", "flowerbed", "forest", "brownfield", "railway"},
    "natural": {"water", "wetland", "wood", "scrub", "bare_rock", "cliff"},
    "amenity": {"parking", "bicycle_parking", "parking_space"},
}
LAT0 = 31.775
KX = 111320 * math.cos(math.radians(LAT0))
KY = 111320.0


def osm_url(kind, oid):
    return f"https://www.openstreetmap.org/{kind}/{oid}"


def xy(lon, lat):
    return (lon * KX, lat * KY)


def lonlat(p):
    return [round(p[0] / KX, 7), round(p[1] / KY, 7)]


def d2(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def seg_x(p1, p2, p3, p4):
    """Intersection parameter (t along p1->p2) of two segments, or None."""
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-12:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return t
    return None


def inside(p, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1:
            c = not c
    return c


def proj(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    return t


def interior_point(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    c = (cx / (3 * a), cy / (3 * a)) if abs(a) > 1e-9 else ring[0]
    if inside(c, ring):
        return c
    ys = sorted(p[1] for p in ring)
    best = None
    for i in range(1, 40):
        y = ys[0] + (ys[-1] - ys[0]) * i / 40
        xs = sorted(x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                    for (x1, y1), (x2, y2) in zip(ring, ring[1:]) if (y1 > y) != (y2 > y))
        for a_, b_ in zip(xs[0::2], xs[1::2]):
            if best is None or b_ - a_ > best[0]:
                best = (b_ - a_, ((a_ + b_) / 2, y))
    return best[1] if best else c


# ---------------------------------------------------------------- tagging rules
VEHICLE_ONLY = {"motorway", "motorway_link", "trunk", "trunk_link"}
NOT_OPEN = {"construction", "proposed", "abandoned", "raceway", "bus_guideway", "busway"}
ROADS = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
         "residential", "unclassified", "living_street", "service", "road"}


def way_walk_rule(t):
    """(usable, reason) for pedestrians, from the way's own tags."""
    h = t.get("highway")
    if not h or h in VEHICLE_ONLY or h in NOT_OPEN or h in ("bus_stop", "platform", "elevator"):
        return False, f"highway={h}"
    foot, access = t.get("foot"), t.get("access")
    if foot in ("no", "private", "customers", "destination", "use_sidepath"):
        return False, f"foot={foot}"
    if access in ("no", "private", "customers", "destination") and foot not in ("yes", "designated", "permissive"):
        return False, f"access={access}"
    if h in ROADS:
        sides = [t.get(k) for k in ("sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right") if t.get(k)]
        if sides and "separate" in sides and not any(s in ("yes", "both", "left", "right") for s in sides):
            return False, "sidewalk mapped separately"
    return True, ""


def node_rule(t):
    """(blocked, warning_he) for a barrier node."""
    b = t.get("barrier")
    if not b:
        return False, None
    foot, access = t.get("foot"), t.get("access")
    if t.get("foot:conditional"):
        return False, f"שער עם הגבלת שעות להולכי רגל ({t.get('foot:conditional')})"
    if foot in ("no", "private", "destination"):
        return True, None
    if access in ("no", "private") and foot not in ("yes", "designated", "permissive"):
        return True, None
    if t.get("locked") == "yes" and foot not in ("yes", "designated", "permissive"):
        return True, None
    if b in ("turnstile", "full-height_turnstile") and t.get("oneway") == "yes":
        return False, "קרוסלה חד-כיוונית – ייתכן שאינה עבירה בכיוון זה"
    if b == "gate":
        return False, "שער – מצב פתיחה לא ידוע"
    return False, None


TYPE_HE = {
    "footway": "שביל", "path": "שביל", "pedestrian": "רחבה / מדרחוב", "steps": "מדרגות",
    "service": "דרך שירות", "residential": "רחוב", "tertiary": "כביש", "tertiary_link": "כביש",
    "unclassified": "דרך", "living_street": "רחוב משולב", "cycleway": "שביל אופניים", "track": "דרך עפר",
    "secondary": "כביש", "primary": "כביש", "corridor": "מסדרון",
}


def build_lawns(nodes, ways, buildings, barriers, node_xy, node_ways, way_flat, edges, warn_nodes, node_index):
    """Candidate lawn polygons and straight shortcut edges across them.

    A shortcut a-b is kept only if
      * a and b are graph nodes on ground-level, non-road, non-steps walkable ways, within
        LAWN_SNAP_M of (or inside) the same lawn polygon, not inside any building / obstacle area,
        and not a barrier node;
      * every sample point of a-b (except LAWN_SNAP_M at each end) lies inside that lawn polygon;
      * a-b does not cross any building outline, barrier, road, steps, railway, excluded way,
        or obstacle area (pitch, playground, garden, parking, water, construction, forest ...);
      * it is at most LAWN_MAX_M long and saves at least LAWN_MIN_SAVING_M over the mapped paths.
    """
    import heapq

    def ring_of(w):
        return [xy(nodes[n]["lon"], nodes[n]["lat"]) for n in w["nodes"] if n in nodes]

    wmap = {w["id"]: w for w in ways}
    campus = ring_of(wmap[CAMPUS_OUTLINE])
    lawn_polys, obst_rings, obst_lines = [], [], []
    for w in ways:
        t = w.get("tags", {})
        closed = w["nodes"][0] == w["nodes"][-1] and len(w["nodes"]) >= 4
        tag = next((f"{k}={v}" for k, v in LAWN_TAGS if t.get(k) == v), None)
        if tag and closed and "building" not in t:
            r = ring_of(w)
            ip = interior_point(r)
            if inside(ip, campus) and t.get("access") not in ("no", "private") and t.get("foot") not in ("no", "private"):
                lawn_polys.append({"osm": f"way/{w['id']}", "tag": tag, "name": t.get("name"), "ring": r})
            continue
        if closed and any(t.get(k) in v for k, v in OBSTACLE_AREAS.items()):
            obst_rings.append((ring_of(w), "area " + ",".join(f"{k}={t[k]}" for k in OBSTACLE_AREAS if k in t)))
            continue
        h = t.get("highway")
        if h:
            ok, _ = way_walk_rule(t)
            if not ok or h in ROADS or h in ("steps", "elevator"):
                obst_lines.append((ring_of(w), f"highway={h}"))
        elif "railway" in t:
            obst_lines.append((ring_of(w), f"railway={t['railway']}"))
    for b in buildings:
        obst_rings.append((b["ring"], "building " + (b["name"] or b["osm"])))
    for br in barriers:
        obst_lines.append((br["ring"], "barrier " + br["barrier"]))
    obst = []  # (bbox, segments, label, is_area, ring)
    for r, lab in obst_rings:
        if len(r) >= 3:
            obst.append((bbox(r), list(zip(r, r[1:])), lab, True, r))
    for r, lab in obst_lines:
        if len(r) >= 2:
            obst.append((bbox(r), list(zip(r, r[1:])), lab, False, r))

    # path-only adjacency for the "saves enough" test
    adj = [[] for _ in node_xy]
    for a, b, L, wi in edges:
        adj[a].append((b, L))
        adj[b].append((a, L))

    def net_within(src, limit):
        dist, pq = {src: 0.0}, [(0.0, src)]
        while pq:
            c, n = heapq.heappop(pq)
            if c > dist.get(n, 1e18) or c > limit:
                continue
            for m, L in adj[n]:
                nc = c + L
                if nc <= limit and nc < dist.get(m, 1e18):
                    dist[m] = nc
                    heapq.heappush(pq, (nc, m))
        return dist

    warn_idx = {node_index[k] for k in warn_nodes if k in node_index}

    def ring_dist(p, r):
        best = 1e18
        for a, b in zip(r, r[1:]):
            t = proj(p, a, b)
            best = min(best, d2(p, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))))
        return best

    lawns, lawn_edges, rejects = [], [], 0
    for li, lp in enumerate(lawn_polys):
        r = lp["ring"]
        bx = bbox(r)
        near = [o for o in obst if overlaps(o[0], bx, LAWN_SNAP_M + 1)]
        portals = []
        for n, p in enumerate(node_xy):
            if not (bx[0] - LAWN_SNAP_M <= p[0] <= bx[2] + LAWN_SNAP_M and bx[1] - LAWN_SNAP_M <= p[1] <= bx[3] + LAWN_SNAP_M):
                continue
            if n in warn_idx or not any(way_flat[wi] for wi in node_ways.get(n, ())):
                continue
            if not (inside(p, r) or ring_dist(p, r) <= LAWN_SNAP_M):
                continue
            if any(o[3] and inside(p, o[4]) for o in near):
                continue
            portals.append(n)
        count = 0
        for i, a in enumerate(portals):
            A = node_xy[a]
            cand = []
            for b in portals[i + 1:]:
                B = node_xy[b]
                L = d2(A, B)
                if L < 5 or L > LAWN_MAX_M:
                    continue
                if not segment_in_lawn(A, B, L, r):
                    rejects += 1
                    continue
                if crosses_obstacle(A, B, L, near):
                    rejects += 1
                    continue
                cand.append((b, L))
            if not cand:
                continue
            reach = net_within(a, max(L for _, L in cand) + LAWN_MIN_SAVING_M)
            for b, L in cand:
                if reach.get(b, 1e18) < L + LAWN_MIN_SAVING_M:
                    continue  # the mapped paths are (almost) as short
                lawn_edges.append([a, b, round(L, 2), li])
                count += 1
        area = abs(sum(r[k][0] * r[k - 1][1] - r[k - 1][0] * r[k][1] for k in range(len(r)))) / 2
        lawns.append({"osm": lp["osm"], "tag": lp["tag"], "name": lp["name"], "area_m2": round(area),
                      "portals": len(portals), "shortcuts": count, "ll": [lonlat(p) for p in r]})
    return lawns, lawn_edges, rejects


def bbox(r):
    xs, ys = [p[0] for p in r], [p[1] for p in r]
    return (min(xs), min(ys), max(xs), max(ys))


def overlaps(a, b, pad=0.0):
    return not (a[2] < b[0] - pad or b[2] < a[0] - pad or a[3] < b[1] - pad or b[3] < a[1] - pad)


def segment_in_lawn(A, B, L, ring):
    """Exact test: A-B may cross the lawn outline only within LAWN_SNAP_M of either end,
    and its middle part lies inside the lawn polygon."""
    for p, q in zip(ring, ring[1:]):
        t = seg_x(A, B, p, q)
        if t is not None and LAWN_SNAP_M < t * L < L - LAWN_SNAP_M:
            return False
    # with no crossing in the middle part, one interior sample decides inside/outside
    s = min(max(LAWN_SNAP_M + 0.25, L / 2), L - LAWN_SNAP_M - 0.25) if L > 2 * LAWN_SNAP_M + 0.5 else L / 2
    t = s / L
    return inside((A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])), ring)


def crosses_obstacle(A, B, L, near):
    """True if A-B crosses an obstacle (ignoring touches within 0.5 m of A or B)."""
    sb = (min(A[0], B[0]), min(A[1], B[1]), max(A[0], B[0]), max(A[1], B[1]))
    for ob, segs, lab, is_area, ring in near:
        if not overlaps(ob, sb, 0.5):
            continue
        for p, q in segs:
            t = seg_x(A, B, p, q)
            if t is not None and 0.5 < t * L < L - 0.5:
                return True
        if is_area:
            mid = ((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)
            if inside(mid, ring):
                return True
    return False


def main():
    raw = json.load(open(SRC, encoding="utf-8"))
    corr = json.load(open(CORR, encoding="utf-8"))
    assert corr.get("schema") == "givat-ram-location-review/1", "unexpected corrections schema"
    els = raw["elements"]
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    ways = [e for e in els if e["type"] == "way"]

    def in_box(lat, lon, box):
        return box[0] <= lat <= box[2] and box[1] <= lon <= box[3]

    # ---------------- buildings
    buildings = []
    for w in ways:
        t = w.get("tags", {})
        if "building" not in t or w["nodes"][0] != w["nodes"][-1]:
            continue
        ll = [(nodes[n]["lon"], nodes[n]["lat"]) for n in w["nodes"] if n in nodes]
        if len(ll) < 4 or not any(in_box(la, lo, BBOX) for lo, la in ll):
            continue
        ring = [xy(*p) for p in ll]
        lv = t.get("building:levels")
        h = None
        try:
            h = float(t["height"]) if "height" in t else (float(lv) * LEVEL_H if lv else None)
        except ValueError:
            h = None
        buildings.append({
            "osm": f"way/{w['id']}", "name": t.get("name:he") or t.get("name"), "name_en": t.get("name:en"),
            "ring": ring, "ll": [[round(a, 7), round(b, 7)] for a, b in ll],
            "height": h if h else DEFAULT_H, "height_known": bool(h), "levels": lv,
            "interior": interior_point(ring),
        })
    bidx = {b["osm"]: b for b in buildings}
    barriers = []
    for w in ways:
        t = w.get("tags", {})
        if "barrier" in t and t["barrier"] not in ("gate",) and "building" not in t:
            r = [xy(nodes[n]["lon"], nodes[n]["lat"]) for n in w["nodes"] if n in nodes]
            if len(r) >= 2:
                barriers.append({"osm": f"way/{w['id']}", "ring": r, "barrier": t["barrier"]})

    # ---------------- pedestrian graph
    node_ids, node_xy, node_index = [], [], {}
    blocked, warn_nodes = set(), {}
    for n in nodes.values():
        t = n.get("tags", {})
        if "barrier" in t:
            bl, wtxt = node_rule(t)
            if bl:
                blocked.add(n["id"])
            elif wtxt:
                warn_nodes[n["id"]] = wtxt

    def nid(osm_node):
        if osm_node not in node_index:
            node_index[osm_node] = len(node_ids)
            node_ids.append(osm_node)
            node_xy.append(xy(nodes[osm_node]["lon"], nodes[osm_node]["lat"]))
        return node_index[osm_node]

    way_meta, edges, excluded = [], [], []
    node_ways = {}      # graph node index -> set of way_meta indexes
    way_flat = []       # way_meta index -> True if the way is at ground level and not steps/road
    for w in ways:
        t = w.get("tags", {})
        if "highway" not in t:
            continue
        ok, why = way_walk_rule(t)
        if not ok:
            excluded.append({"osm": f"way/{w['id']}", "highway": t["highway"], "reason": why})
            continue
        ns = [n for n in w["nodes"] if n in nodes]
        if not any(in_box(nodes[n]["lat"], nodes[n]["lon"], GRAPH_BBOX) for n in ns):
            continue
        wi = len(way_meta)
        h = t["highway"]
        kind = "crossing" if t.get("footway") == "crossing" or t.get("path") == "crossing" else h
        way_meta.append({
            "osm": f"way/{w['id']}", "highway": h, "kind": kind,
            "name": t.get("name:he") or t.get("name"),
            "type_he": "מעבר חציה" if kind == "crossing" else TYPE_HE.get(h, "דרך"),
            "incline": t.get("incline"), "road": h in ROADS and h != "service",
        })
        way_flat.append(h not in ROADS and h not in ("steps", "corridor", "elevator")
                        and t.get("bridge", "no") == "no" and t.get("tunnel", "no") == "no"
                        and t.get("layer", "0") == "0" and t.get("indoor", "no") == "no"
                        and t.get("covered", "no") == "no")
        for a, b in zip(ns, ns[1:]):
            if a in blocked or b in blocked:
                continue
            ia, ib = nid(a), nid(b)
            edges.append([ia, ib, round(d2(node_xy[ia], node_xy[ib]), 2), wi])
            node_ways.setdefault(ia, set()).add(wi)
            node_ways.setdefault(ib, set()).add(wi)

    # components
    adj = [[] for _ in node_ids]
    for i, (a, b, L, wi) in enumerate(edges):
        adj[a].append(b)
        adj[b].append(a)
    comp = [-1] * len(node_ids)
    sizes = []
    for s in range(len(node_ids)):
        if comp[s] != -1:
            continue
        cid, stack, size = len(sizes), [s], 0
        comp[s] = cid
        while stack:
            x = stack.pop()
            size += 1
            for y in adj[x]:
                if comp[y] == -1:
                    comp[y] = cid
                    stack.append(y)
        sizes.append(size)
    main_comp = max(range(len(sizes)), key=lambda c: sizes[c])

    # ---------------- obstacles for connector checks
    def blocked_line(a, b, own, skip_own=False):
        """Reason string if a->b crosses a mapped building/barrier, else None.
        The own outline may only be touched at a (or is ignored entirely with skip_own)."""
        for bl in buildings:
            if skip_own and bl is own:
                continue
            r = bl["ring"]
            for p, q in zip(r, r[1:]):
                t = seg_x(a, b, p, q)
                if t is None:
                    continue
                if bl is own and t * d2(a, b) < 0.3:
                    continue
                if t * d2(a, b) > d2(a, b) - 0.3:  # touching the path end
                    continue
                return f"חוצה בניין ({bl['name'] or bl['osm']})"
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if inside(mid, r):
                return f"עובר בתוך בניין ({bl['name'] or bl['osm']})"
        for br in barriers:
            r = br["ring"]
            for p, q in zip(r, r[1:]):
                if seg_x(a, b, p, q) is not None:
                    return f"חוצה {br['barrier']} ({br['osm']})"
        return None

    def exit_point(P, b, ring):
        """Last crossing of P->b with ring (where one leaves the building)."""
        best = None
        for p, q in zip(ring, ring[1:]):
            t = seg_x(P, b, p, q)
            if t is not None and (best is None or t > best):
                best = t
        if best is None:
            return None
        return (P[0] + (b[0] - P[0]) * best, P[1] + (b[1] - P[1]) * best)

    def connect(P, own):
        """Find the approximate connection from point P (inside `own` outline, or free)."""
        cands = []
        for ei, (a, b, L, wi) in enumerate(edges):
            A, B = node_xy[a], node_xy[b]
            t0 = proj(P, A, B)
            if d2(P, (A[0] + t0 * (B[0] - A[0]), A[1] + t0 * (B[1] - A[1]))) > SEARCH_M:
                continue
            steps = max(1, int(L / 2.0))
            ts = {round(t0, 4)} | {i / steps for i in range(steps + 1)}
            for t in ts:
                q = (A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]))
                if d2(P, q) > SEARCH_M:
                    continue
                cands.append((d2(P, q), ei, t, q))
        cands.sort()
        best_by_comp, fallback = {}, None
        for dist, ei, t, q in cands:
            if own is not None:
                if inside(q, own["ring"]):
                    continue  # network point inside the destination outline – not used as approach
                a = exit_point(P, q, own["ring"])
                if a is None:
                    continue
            else:
                a = P
            if fallback is None:
                fallback = (dist, ei, t, q, a)
            c = comp[edges[ei][0]]
            if c in best_by_comp:
                continue
            L = d2(a, q)
            if L > MAX_CONNECTOR_M:
                continue
            why = blocked_line(a, q, own)
            if why:
                continue
            # the inside part must not leave and re-enter other buildings either
            if own is None or not blocked_line(P, a, own, skip_own=True):
                best_by_comp[c] = (dist, ei, t, q, a)
        choice, valid = None, False
        if best_by_comp:
            best = min(best_by_comp.values())
            choice = best_by_comp.get(main_comp)
            if choice is None or choice[0] > best[0] + 20:
                choice = best
            valid = True
        elif fallback:
            choice = fallback
        if not choice:
            return {"valid": False, "reason": "לא נמצאה דרך הולכי רגל ממופה בטווח"}
        dist, ei, t, q, a = choice
        out = {
            "valid": valid,
            "edge": ei, "t": round(t, 5),
            "network_point": lonlat(q),
            "wall_point": lonlat(a),
            "connector_m": round(d2(a, q), 1),
            "inside_m": round(d2(P, a), 1),
            "component_main": comp[edges[ei][0]] == main_comp,
            "way": way_meta[edges[ei][3]]["osm"],
        }
        if not valid:
            out["reason"] = "לא נמצא חיבור סביר (עד %d מ' וללא חציית בניין/גדר ממופים). " \
                            "המסלול מסתיים בנקודת הקצה של הרשת הממופה." % MAX_CONNECTOR_M
        return out

    # ---------------- destinations
    def find_container(P):
        for b in buildings:
            if inside(P, b["ring"]):
                return b
        return None

    hall = nodes[3705029048]
    shared_pt = (hall["lon"], hall["lat"])
    cd = corr["destinations"]
    CONF_HE = {"field": "אומת בשטח (סימון משתמש)", "official_map": "לפי מפה רשמית (סימון משתמש)",
               "estimate": "הערכה (סימון משתמש)"}
    defs = [
        ("canada", "אולם קנדה", None, None),
        ("engineering", "אודיטוריום הנדסה", None, None),
        ("sprinzak", "בניין שפרינצק", "way/121791888", None),
        ("harman", "ספריית הרמן", "way/121168935", None),
        ("kaplan", "אולם קפלן", None, "node/3705029048"),
        ("rothberg", "רוטברג", None, "node/3705029048"),
        ("manchester", "בניין מנצ'סטר — מתמטיקה", "way/121791882", None),
    ]
    short_names = {"manchester": "בניין מנצ'סטר"}
    extra_sources = {"manchester": [MATH_VISITOR]}
    dests = []
    for did, name, osm_bldg, osm_pt in defs:
        c = cd.get(did) or {}
        cb = c.get("building")
        prov = {}
        if cb:
            P = xy(cb["lon"], cb["lat"])
            prov = {"source": "user", "confidence": cb.get("confidence", "estimate"),
                    "confidence_he": CONF_HE.get(cb.get("confidence"), "סימון משתמש"),
                    "method": cb.get("method"), "source_ref": cb.get("source_ref"),
                    "note": c.get("note") or cb.get("note") or "", "updated_at": cb.get("updated_at")}
            if cb.get("source_ref") == "node/3705029048":
                prov["confidence_he"] = "נקודת OSM משותפת לקפלן ורוטברג (" + CONF_HE.get(cb.get("confidence"), "") + ")"
        elif osm_bldg:
            P = bidx[osm_bldg]["interior"]
            prov = {"source": "osm", "confidence": "osm", "confidence_he": "קווי מתאר ב-OSM עם שם תואם",
                    "source_ref": osm_bldg}
        elif osm_pt:
            P = xy(*shared_pt)
            prov = {"source": "osm", "confidence": "osm_shared",
                    "confidence_he": "נקודת OSM משותפת לקפלן ורוטברג", "source_ref": osm_pt}
        else:
            dests.append({"id": did, "name": name, "location": None,
                          "connector": {"valid": False, "reason": "אין מיקום ליעד"}})
            continue
        own = bidx.get(osm_bldg) if osm_bldg else find_container(P)
        if own is not None and not inside(P, own["ring"]):
            own = None
        footprint_rel = None
        if own is not None:
            footprint_rel = "destination" if osm_bldg else "contains_point"
        entrances = [e for e in c.get("entrances", [])]
        attaches = []
        for i, e in enumerate(entrances):
            E = xy(e["lon"], e["lat"])
            con = connect(E, None)
            con.update({"from": "entrance", "entrance_index": i, "confidence": e.get("confidence", "estimate")})
            attaches.append(con)
        if not attaches:
            con = connect(P, own)
            con["from"] = "building"
            attaches.append(con)
        dests.append({
            "id": did, "name": name, "short": short_names.get(did, name), "location": lonlat(P), "provenance": prov,
            "footprint": own["osm"] if own else None, "footprint_rel": footprint_rel,
            "footprint_name": own["name"] if own else None,
            "entrances_mapped": len(entrances),
            "shared_with": [x for x in ("kaplan", "rothberg") if x != did] if did in ("kaplan", "rothberg") else [],
            "attaches": attaches,
            "sources": ([osm_url(*prov["source_ref"].split("/"))] if prov.get("source_ref") else [])
                       + extra_sources.get(did, []),
        })
    # sanity: Kaplan and Rothberg must not have been given different coordinates by this script
    kp = next(d for d in dests if d["id"] == "kaplan")
    rb = next(d for d in dests if d["id"] == "rothberg")
    same_point = kp["location"] == rb["location"]

    lawns, lawn_edges, lawn_rejects = build_lawns(nodes, ways, buildings, barriers, node_xy, node_ways,
                                                  way_flat, edges, warn_nodes, node_index)

    landmarks = [{"name": b["name"], "osm": b["osm"], "point": lonlat(b["interior"])}
                 for b in buildings if b["name"]]

    data = {
        "generated": "2026-11-02",
        "center": [35.1965, 31.7765],
        "corrections_exported_at": corr.get("exported_at"),
        "kaplan_rothberg_same_point": same_point,
        "max_connector_m": MAX_CONNECTOR_M,
        "graph": {
            "nodes": [lonlat(p) for p in node_xy],
            "osm_nodes": node_ids,
            "edges": edges,
            "ways": way_meta,
            "component": comp,
            "main_component": main_comp,
            "warn_nodes": {str(node_index[k]): v for k, v in warn_nodes.items() if k in node_index},
            "lawn_edges": lawn_edges,
        },
        "lawns": lawns,
        "lawn_rules": {"snap_m": LAWN_SNAP_M, "max_m": LAWN_MAX_M, "min_saving_m": LAWN_MIN_SAVING_M,
                       "tags": sorted("=".join(t) for t in LAWN_TAGS)},
        "buildings": [{"osm": b["osm"], "name": b["name"], "name_en": b["name_en"], "ll": b["ll"],
                       "height": b["height"], "height_known": b["height_known"]} for b in buildings],
        "destinations": dests,
        "landmarks": landmarks,
        "excluded_ways": len(excluded),
        "blocked_nodes": len(blocked),
        "sources": [
            {"label": "© OpenStreetMap contributors (ODbL)", "url": "https://www.openstreetmap.org/copyright",
             "detail": "OSM API map bbox 35.1880,31.7690,35.2060,31.7800, נשלף 2026-11-02"},
            {"label": "חוברת \"בשבילי הקמפוס\" – האוניברסיטה העברית", "url": BOOKLET,
             "detail": "אימות קיומו של אולם קנדה ליד גינת האבולוציה"},
            {"label": "מכון איינשטיין למתמטיקה – Visitor Information", "url": MATH_VISITOR,
             "detail": "הספרייה והאולמות של המכון נמצאים בבניין מנצ'סטר; מיקום הכניסה אינו מפורט"},
            {"label": "תיקוני מיקום של המשתמש (מפת הבדיקה)", "url": "data/corrections/givat-ram-location-corrections.json",
             "detail": "יוצא " + str(corr.get("exported_at"))},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_app_data.py – do not edit by hand.\nwindow.CAMPUS = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"nodes={len(node_ids)} edges={len(edges)} ways={len(way_meta)} components={len(sizes)} "
          f"main={sizes[main_comp]} blocked_nodes={len(blocked)} excluded_ways={len(excluded)} buildings={len(buildings)}")
    for d in dests:
        a = d["attaches"][0]
        print(f"  {d['id']:12s} loc={d['location']} footprint={d.get('footprint')} ({d.get('footprint_rel')}) "
              f"conf={d.get('provenance', {}).get('confidence')} valid={a['valid']} connector={a.get('connector_m')}m "
              f"inside={a.get('inside_m')}m main={a.get('component_main')} way={a.get('way')} {a.get('reason', '')}")
    print("  kaplan/rothberg same point:", same_point)
    print(f"  lawns={len(lawns)} lawn_edges={len(lawn_edges)} rejected_pairs={lawn_rejects}")
    for l in lawns:
        print(f"    {l['osm']:16s} {l['tag']:16s} {l['area_m2']:7.0f} m2 portals={l['portals']} shortcuts={l['shortcuts']}")


if __name__ == "__main__":
    main()
