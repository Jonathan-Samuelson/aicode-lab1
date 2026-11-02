"""Checks that the visual scenery is separate from routing and drawn from mapped data.

Run: python3 -I tests/test_scenery_data.py
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import build_scenery_data as S  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


def load_js(path, var):
    s = open(path, encoding="utf-8").read()
    return json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))


campus_path = os.path.join(ROOT, "app", "data", "campus-data.js")
before = hashlib.sha256(open(campus_path, "rb").read()).hexdigest()
subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "build_scenery_data.py")], check=True, capture_output=True)
after = hashlib.sha256(open(campus_path, "rb").read()).hexdigest()
check(before == after, "building the scenery leaves the routing data (campus-data.js) byte-identical")

route_js = open(os.path.join(ROOT, "app", "route.js"), encoding="utf-8").read()
check("SCENERY" not in route_js and "scene3d" not in route_js, "route.js does not read the scenery or the renderer")
scene_js = open(os.path.join(ROOT, "app", "scene3d.js"), encoding="utf-8").read()
check(not any(f"C.{k} =" in scene_js or f"C.{k}.push" in scene_js for k in ("graph", "destinations", "buildings", "lawns")),
      "scene3d.js never assigns to the routing data")

C = load_js(campus_path, "CAMPUS")
SC = load_js(os.path.join(ROOT, "app", "data", "scenery-data.js"), "SCENERY")
raw = json.load(open(S.SRC, encoding="utf-8"))
ways = {f"way/{e['id']}": e for e in raw["elements"] if e["type"] == "way"}
rels = {f"relation/{e['id']}": e for e in raw["elements"] if e["type"] == "relation"}
nodes = {e["id"]: e for e in raw["elements"] if e["type"] == "node"}

check(SC["origin"] == C["center"], "scenery origin equals the routing data centre (same projection)")
check(set(SC["building_style"]) == {b["osm"] for b in C["buildings"]},
      f"styles exist for exactly the {len(C['buildings'])} routing-data buildings (footprints come from routing data)")
bad_src = [b for b, st in SC["building_style"].items()
           if (st["height_source"] != "default") != next(x for x in C["buildings"] if x["osm"] == b)["height_known"]]
check(not bad_src, "height source flag matches the routing data (sourced vs illustrative heights)")

bad_area = []
for a in SC["areas"]:
    el = ways.get(a["osm"]) or rels.get(a["osm"])
    if el is None or S.area_kind(el.get("tags", {})) != a["kind"]:
        bad_area.append(a["osm"])
check(not bad_area, f"all {len(SC['areas'])} areas are OSM features with matching tags {bad_area[:3]}")
bad_line = [l["osm"] for l in SC["lines"] if l["osm"] not in ways]
check(not bad_line, f"all {len(SC['lines'])} roads/paths/rail lines are OSM ways")

mapped = [t for t in SC["trees"] if t[2] == 1]
deco = [t for t in SC["trees"] if t[2] == 0]
osm_trees = [n for n in nodes.values() if n.get("tags", {}).get("natural") == "tree"
             and S.BBOX[0] - 0.001 <= n["lat"] <= S.BBOX[2] + 0.001 and S.BBOX[1] - 0.001 <= n["lon"] <= S.BBOX[3] + 0.001]
check(len(mapped) == len(osm_trees), f"{len(mapped)} mapped trees = OSM natural=tree nodes in the area")
forests = [a["ring"] for a in SC["areas"] if a["kind"] == "forest"]
blds = [[S.m(*p) for p in b["ll"]] for b in C["buildings"]]
outside = [t for t in deco if not any(S.inside((t[0], t[1]), r) for r in forests)]
in_bld = [t for t in deco if any(S.inside((t[0], t[1]), r) for r in blds)]
check(deco and not outside, f"all {len(deco)} decorative trees lie inside OSM forest/wood areas")
check(not in_bld, "no decorative tree is inside a building")
walk_lines = [l for l in SC["lines"]]
near = [t for t in deco[:400] if any(S.seg_dist((t[0], t[1]), a, b) < l["w"] / 2 for l in walk_lines for a, b in zip(l["pts"], l["pts"][1:]))]
check(not near, "decorative trees are not placed on drawn roads or paths (first 400 checked)")
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
