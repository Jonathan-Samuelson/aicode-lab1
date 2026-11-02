"""Checks on app/data/campus-data.js against the raw OSM snapshot and the corrections file.

Run: python3 -I tests/test_app_data.py
Writes tests/out/python_shortest.json, which tests/routing.test.js compares to the JS router.
"""
import heapq
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import build_app_data as B  # noqa: E402  (rules are tested from the same module the build uses)

fails = 0


def check(cond, msg):
    global fails
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


s = open(os.path.join(ROOT, "app", "data", "campus-data.js"), encoding="utf-8").read()
C = json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))
raw = json.load(open(B.SRC, encoding="utf-8"))
corr = json.load(open(os.path.join(ROOT, "data", "corrections", "givat-ram-location-corrections.json"), encoding="utf-8"))
osm_ways = {f"way/{e['id']}": e for e in raw["elements"] if e["type"] == "way"}
osm_nodes = {e["id"]: e for e in raw["elements"] if e["type"] == "node"}
G = C["graph"]
D = {d["id"]: d for d in C["destinations"]}

# --- network contents
bad = [w["osm"] for w in G["ways"] if not B.way_walk_rule(osm_ways[w["osm"]]["tags"])[0]]
check(not bad, f"graph contains only pedestrian-usable ways ({len(G['ways'])} ways)")
hw = {w["highway"] for w in G["ways"]}
check(not (hw & B.VEHICLE_ONLY), "no vehicle-only highway types in graph: " + ",".join(sorted(hw)))
used_nodes = {G["osm_nodes"][i] for e in G["edges"] for i in e[:2]}
blocked = [n for n in used_nodes if B.node_rule(osm_nodes[n].get("tags", {}))[0]]
check(not blocked, "no blocked gate is part of any graph edge")
check(560814404 not in used_nodes, "locked gate node/560814404 not traversable")
check(all(osm_ways[w["osm"]]["tags"].get("foot") != "customers" for w in G["ways"]), "foot=customers ways excluded")

# --- corrections preserved
for did in ("canada", "engineering", "rothberg"):
    cb = corr["destinations"][did]["building"]
    d = D[did]
    check(d["provenance"]["confidence"] == cb["confidence"] and d["location"] == [cb["lon"], cb["lat"]],
          f"{did}: location and confidence '{cb['confidence']}' preserved from corrections")
check(D["kaplan"]["location"] == D["rothberg"]["location"], "Kaplan and Rothberg share the single OSM point")
check(D["kaplan"]["provenance"]["confidence"] == "osm_shared", "Kaplan (no correction) uses OSM shared point")
check(all(d["entrances_mapped"] == 0 for d in C["destinations"]), "no destination has a mapped entrance (corrections had none)")
check(all(a["from"] == "building" for d in C["destinations"] for a in d["attaches"]),
      "building locations are not used as entrances")
check(all(a["valid"] and a["connector_m"] <= C["max_connector_m"] for d in C["destinations"] for a in d["attaches"]),
      "all approximate connectors are within limits and valid")

# --- Manchester (7th destination)
m = D.get("manchester")
check(m is not None and m["name"] == "בניין מנצ'סטר — מתמטיקה", "Manchester is a destination with the requested Hebrew label")
check(m["footprint"] == "way/121791882" and osm_ways["way/121791882"]["tags"].get("name:en") == "Manchester Building",
      "Manchester uses OSM way/121791882 (name:en=Manchester Building)")
check(m["entrances_mapped"] == 0 and m["attaches"][0]["from"] == "building" and m["attaches"][0]["valid"],
      f"Manchester: no mapped entrance, approximate connector {m['attaches'][0]['connector_m']} m from the outline")

# --- lawn shortcuts, checked independently against the raw OSM data
import math  # noqa: E402
KX, KY = 111320 * math.cos(math.radians(31.775)), 111320.0
P = lambda ll: (ll[0] * KX, ll[1] * KY)  # noqa: E731
nxy = {e["id"]: P((e["lon"], e["lat"])) for e in raw["elements"] if e["type"] == "node"}


def proper_cross(a, b, c, d, tol=0.5):
    t = B.seg_x(a, b, c, d)
    L = math.dist(a, b)
    return t is not None and tol < t * L < L - tol


lawns = C["lawns"]
check(len(lawns) > 0 and all(osm_ways[l["osm"]]["tags"].get("leisure") == "park" or
                             osm_ways[l["osm"]]["tags"].get("landuse") in ("grass", "meadow", "village_green") for l in lawns),
      f"{len(lawns)} candidate lawn areas, all tagged park/grass/meadow/village_green in OSM")
obstacles = []
for w in osm_ways.values():
    t = w.get("tags", {})
    ring = [nxy[n] for n in w["nodes"] if n in nxy]
    hw = t.get("highway")
    if ("building" in t or "barrier" in t or "railway" in t or hw in B.ROADS or hw == "steps"
            or (hw and not B.way_walk_rule(t)[0]) or t.get("leisure") in ("pitch", "playground", "garden")
            or t.get("amenity") == "parking" or t.get("natural") == "water"):
        obstacles.append((ring, t))
bad_cross, bad_inside, bad_save = [], [], []
pathadj = [[] for _ in G["nodes"]]
for a, b, L, wi in G["edges"]:
    pathadj[a].append((b, L))
    pathadj[b].append((a, L))
for a, b, L, li in G["lawn_edges"]:
    A, Bp = P(G["nodes"][a]), P(G["nodes"][b])
    ring = [P(x) for x in lawns[li]["ll"]]
    for orr, t in obstacles:
        if any(proper_cross(A, Bp, c, d) for c, d in zip(orr, orr[1:])):
            bad_cross.append((a, b, t))
            break
    n = max(2, int(L))
    for k in range(n + 1):
        s_ = k / n * L
        if 2.5 <= s_ <= L - 2.5 and not B.inside((A[0] + (Bp[0] - A[0]) * s_ / L, A[1] + (Bp[1] - A[1]) * s_ / L), ring):
            bad_inside.append((a, b))
            break
check(not bad_cross, f"no lawn shortcut crosses a building, barrier, road, steps, railway, pitch, garden, parking or excluded way ({len(G['lawn_edges'])} checked) {bad_cross[:2]}")
check(not bad_inside, f"every lawn shortcut stays inside its lawn polygon {bad_inside[:3]}")


def dijkstra_adj(adjl, sources):
    dist = {}
    pq = [(c, n) for n, c in sources]
    heapq.heapify(pq)
    while pq:
        c, n = heapq.heappop(pq)
        if n in dist:
            continue
        dist[n] = c
        for m_, L in adjl[n]:
            if m_ not in dist:
                heapq.heappush(pq, (c + L, m_))
    return dist


for a, b, L, li in G["lawn_edges"][:400]:
    if dijkstra_adj(pathadj, [(a, 0)]).get(b, 1e18) < L + C["lawn_rules"]["min_saving_m"] - 0.01:
        bad_save.append((a, b))
check(not bad_save, "each lawn shortcut saves >= min_saving_m over the mapped paths between its ends")
check(all(isinstance(x, int) for e in G["lawn_edges"] for x in e[:2]) and
      all(e[3] < len(lawns) for e in G["lawn_edges"]), "lawn edges reference graph nodes and lawn areas")

# --- independent shortest-path reference
N = len(G["nodes"])
adj = [[] for _ in range(N)]
for a, b, L, wi in G["edges"]:
    adj[a].append((b, L))
    adj[b].append((a, L))


def dijkstra(sources):
    dist = {}
    pq = [(c, n) for n, c in sources]
    heapq.heapify(pq)
    while pq:
        c, n = heapq.heappop(pq)
        if n in dist:
            continue
        dist[n] = c
        for m, L in adj[n]:
            if m not in dist:
                heapq.heappush(pq, (c + L, m))
    return dist


def reference():
    out = {}
    for f in D:
        for t in D:
            if f == t or D[f]["location"] == D[t]["location"]:
                continue
            sa, ea = D[f]["attaches"][0], D[t]["attaches"][0]
            u, w, L, _ = G["edges"][sa["edge"]]
            dist = dijkstra([(u, sa["t"] * L), (w, (1 - sa["t"]) * L)])
            u2, w2, L2, _ = G["edges"][ea["edge"]]
            best = min(dist.get(u2, 1e18) + ea["t"] * L2, dist.get(w2, 1e18) + (1 - ea["t"]) * L2)
            if sa["edge"] == ea["edge"]:
                best = min(best, abs(sa["t"] - ea["t"]) * L)
            out[f + ">" + t] = round(best + sa["connector_m"] + ea["connector_m"], 1)
    return out


out = reference()
for a, b, L, li in G["lawn_edges"]:
    adj[a].append((b, L))
    adj[b].append((a, L))
out_lawn = reference()
check(all(out_lawn[k] <= out[k] + 0.01 for k in out), "lawn mode is never longer than path-only mode")
check(any(out_lawn[k] < out[k] - 50 for k in out), "lawn mode shortens at least one route by >50 m")
os.makedirs(os.path.join(ROOT, "tests", "out"), exist_ok=True)
json.dump(out, open(os.path.join(ROOT, "tests", "out", "python_shortest.json"), "w"), indent=1)
json.dump(out_lawn, open(os.path.join(ROOT, "tests", "out", "python_shortest_lawn.json"), "w"), indent=1)
check(len(out) == 40, f"reference shortest distances computed for {len(out)} pairs")
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
