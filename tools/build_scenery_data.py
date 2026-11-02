"""Build app/data/scenery-data.js: visual-only scenery for the 3D renderer.

Usage: python3 tools/build_scenery_data.py

Input : data/raw/osm_givat_ram_2026-11-02.json, app/data/campus-data.js (for the building list)
Output: app/data/scenery-data.js  (window.SCENERY = {...})

This file is used ONLY for drawing. Routing uses app/data/campus-data.js, which this script
reads but never writes. Everything drawn comes from mapped OSM features, except the
"decorative" trees: these are placed on a jittered grid inside OSM areas mapped as
forest / wood, to suggest that mapped vegetation. They are flagged decorative=1.

Coordinates are local metres [east, north] from ORIGIN, with the same projection as
app/route.js (equirectangular at LAT0 = 31.775).
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "raw", "osm_givat_ram_2026-11-02.json")
CAMPUS = os.path.join(ROOT, "app", "data", "campus-data.js")
OUT = os.path.join(ROOT, "app", "data", "scenery-data.js")

LAT0 = 31.775
KX = 111320 * math.cos(math.radians(LAT0))
KY = 111320.0
ORIGIN = (35.1965, 31.7765)  # = campus-data "center"
BBOX = (31.7700, 35.1925, 31.7800, 35.2012)  # S, W, N, E (same as the building list)
LEVEL_H = 3.5

# drawn width (m) of mapped ways – illustrative, OSM rarely has width tags here
WIDTH = {
    "footway": 2.2, "path": 1.6, "pedestrian": 4.5, "steps": 2.6, "cycleway": 2.0, "track": 3.0,
    "corridor": 2.0, "living_street": 5.0, "service": 4.5, "residential": 6.5, "unclassified": 6.0,
    "tertiary": 8.0, "tertiary_link": 6.0, "secondary": 9.0, "secondary_link": 6.0, "primary": 10.0,
    "primary_link": 6.0, "trunk": 12.0, "trunk_link": 7.0, "motorway": 14.0, "motorway_link": 7.0,
}
WALK = {"footway", "path", "pedestrian", "cycleway", "track", "corridor"}

# area kinds, in drawing order (later = on top)
def area_kind(t):
    if "building" in t:
        return None
    if t.get("natural") == "water" or t.get("leisure") == "swimming_pool":
        return "water"
    if t.get("landuse") == "forest" or t.get("natural") == "wood":
        return "forest"
    if t.get("leisure") in ("park", "garden", "dog_park", "playground") or t.get("landuse") in (
            "grass", "meadow", "village_green", "flowerbed", "recreation_ground") or t.get("natural") in ("grassland", "scrub"):
        return "grass"
    if t.get("leisure") == "pitch":
        return "track" if t.get("sport") == "athletics" else "pitch"
    if t.get("leisure") in ("track",):
        return "track"
    if t.get("leisure") in ("stadium", "sports_centre"):
        return "sport"
    if t.get("amenity") == "parking":
        return "parking"
    if t.get("landuse") == "construction":
        return "construction"
    if t.get("highway") in ("pedestrian", "footway") and t.get("area") == "yes":
        return "plaza"
    if t.get("area:highway"):
        return "plaza"
    return None


ORDER = ["sport", "grass", "forest", "construction", "parking", "plaza", "pitch", "track", "water"]


def m(lon, lat):
    return (round((lon - ORIGIN[0]) * KX, 2), round((lat - ORIGIN[1]) * KY, 2))


def inside(p, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1:
            c = not c
    return c


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def rnd(i, j, k):
    """Deterministic pseudo-random in [0,1) from integers (no global RNG state)."""
    h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791)
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    return (h & 0xFFFFFF) / float(0x1000000)


def stitch(member_ways, nodes):
    """Join open member ways into closed rings (simple greedy)."""
    segs = [list(w["nodes"]) for w in member_ways]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def main():
    raw = json.load(open(SRC, encoding="utf-8"))
    s = open(CAMPUS, encoding="utf-8").read()
    C = json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))
    els = raw["elements"]
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    ways = {e["id"]: e for e in els if e["type"] == "way"}

    def in_box(n):
        return BBOX[0] - 0.001 <= n["lat"] <= BBOX[2] + 0.001 and BBOX[1] - 0.001 <= n["lon"] <= BBOX[3] + 0.001

    def ring_m(ids):
        return [m(nodes[n]["lon"], nodes[n]["lat"]) for n in ids if n in nodes]

    # ---------------- areas
    areas = []
    for w in ways.values():
        t = w.get("tags", {})
        k = area_kind(t)
        if not k or w["nodes"][0] != w["nodes"][-1] or len(w["nodes"]) < 4:
            continue
        if not any(in_box(nodes[n]) for n in w["nodes"] if n in nodes):
            continue
        areas.append({"kind": k, "osm": f"way/{w['id']}", "ring": ring_m(w["nodes"])})
    for r in els:
        if r["type"] != "relation" or r.get("tags", {}).get("type") != "multipolygon":
            continue
        k = area_kind(r["tags"])
        if not k:
            continue
        outer = [ways[mb["ref"]] for mb in r["members"] if mb["type"] == "way" and mb["ref"] in ways and mb.get("role") in ("outer", "")]
        for ring in stitch(outer, nodes):
            if any(in_box(nodes[n]) for n in ring if n in nodes):
                areas.append({"kind": k, "osm": f"relation/{r['id']}", "ring": ring_m(ring)})
    areas.sort(key=lambda a: ORDER.index(a["kind"]))

    # ---------------- lines (roads, paths, rail, barriers)
    lines, barriers = [], []
    for w in ways.values():
        t = w.get("tags", {})
        ns = [n for n in w["nodes"] if n in nodes]
        if len(ns) < 2 or not any(in_box(nodes[n]) for n in ns):
            continue
        if t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("location") == "underground":
            continue
        h = t.get("highway")
        if h in WIDTH and not (t.get("area") == "yes"):
            kind = "steps" if h == "steps" else "walk" if h in WALK else "road"
            if h in ("motorway", "motorway_link", "trunk", "trunk_link"):
                kind = "highway"
            lines.append({"kind": kind, "w": WIDTH[h], "osm": f"way/{w['id']}", "pts": ring_m(ns),
                          "bridge": 1 if t.get("bridge") == "yes" else 0})
        elif t.get("railway") in ("light_rail", "tram", "rail"):
            lines.append({"kind": "rail", "w": 3.0, "osm": f"way/{w['id']}", "pts": ring_m(ns), "bridge": 0})
        elif t.get("barrier") in ("fence", "wall", "retaining_wall", "hedge", "city_wall") and "building" not in t:
            barriers.append({"kind": t["barrier"], "osm": f"way/{w['id']}", "pts": ring_m(ns)})

    # ---------------- buildings: tags for styling (footprints come from campus-data.js)
    building_style = {}
    for b in C["buildings"]:
        w = ways[int(b["osm"].split("/")[1])]
        t = w.get("tags", {})
        src = "height" if "height" in t else "levels" if "building:levels" in t else "default"
        building_style[b["osm"]] = {
            "type": t.get("building"), "roof_shape": t.get("roof:shape"), "roof_material": t.get("roof:material"),
            "levels": t.get("building:levels"), "height_source": src,
        }

    # ---------------- trees
    trees = []
    for n in nodes.values():
        if n.get("tags", {}).get("natural") == "tree" and in_box(n):
            x, y = m(n["lon"], n["lat"])
            trees.append([x, y, 1])  # mapped
    bld_rings = [[m(*p) for p in b["ll"]] for b in C["buildings"]]
    bld_boxes = [(min(p[0] for p in r), min(p[1] for p in r), max(p[0] for p in r), max(p[1] for p in r)) for r in bld_rings]
    blockers = [a for a in areas if a["kind"] in ("parking", "plaza", "pitch", "track", "water", "construction")]
    line_segs = [(a, b, l["w"] / 2 + 1.5) for l in lines for a, b in zip(l["pts"], l["pts"][1:])]
    GRID = 7.0
    for ai, a in enumerate(areas):
        if a["kind"] != "forest":
            continue
        r = a["ring"]
        x0, y0 = min(p[0] for p in r), min(p[1] for p in r)
        x1, y1 = max(p[0] for p in r), max(p[1] for p in r)
        segs = [s_ for s_ in line_segs if not (max(s_[0][0], s_[1][0]) < x0 - 10 or min(s_[0][0], s_[1][0]) > x1 + 10
                                               or max(s_[0][1], s_[1][1]) < y0 - 10 or min(s_[0][1], s_[1][1]) > y1 + 10)]
        i = 0
        gx = x0
        while gx <= x1:
            gy = y0
            j = 0
            while gy <= y1:
                px = gx + (rnd(ai, i, j) - 0.5) * GRID * 0.8
                py = gy + (rnd(ai, j, i + 7) - 0.5) * GRID * 0.8
                p = (px, py)
                ok = inside(p, r)
                if ok:
                    for bi, bb in enumerate(bld_boxes):
                        if bb[0] - 2 <= px <= bb[2] + 2 and bb[1] - 2 <= py <= bb[3] + 2:
                            rr = bld_rings[bi]
                            if inside(p, rr) or min(seg_dist(p, u, v) for u, v in zip(rr, rr[1:])) < 2.5:
                                ok = False
                                break
                if ok and any(inside(p, b["ring"]) for b in blockers):
                    ok = False
                if ok and any(seg_dist(p, u, v) < d for u, v, d in segs):
                    ok = False
                if ok:
                    trees.append([round(px, 2), round(py, 2), 0])  # decorative
                gy += GRID
                j += 1
            gx += GRID
            i += 1

    x0, y0 = m(BBOX[1], BBOX[0])
    x1, y1 = m(BBOX[3], BBOX[2])
    data = {
        "generated": "2026-11-02",
        "origin": ORIGIN, "lat0": LAT0, "level_h": LEVEL_H,
        "extent": [x0, y0, x1, y1],
        "areas": areas, "lines": lines, "barriers": barriers,
        "building_style": building_style,
        "trees": trees,
        "notes": {
            "decorative_trees": "Trees with flag 0 are decorative: placed on a jittered 7 m grid inside OSM forest/wood areas, "
                                "away from buildings, roads and paths. Trees with flag 1 are OSM natural=tree nodes.",
            "widths": "Road and path widths are illustrative (by highway type).",
            "terrain": "No elevation data is included; the ground is drawn flat.",
        },
    }
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_scenery_data.py – visual only, not used for routing.\nwindow.SCENERY = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    kinds = {}
    for a in areas:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    print(f"areas={len(areas)} {kinds} lines={len(lines)} barriers={len(barriers)} "
          f"trees mapped={sum(1 for t in trees if t[2])} decorative={sum(1 for t in trees if not t[2])} -> {OUT} "
          f"({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
