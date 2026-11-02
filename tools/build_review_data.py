"""Build review/data/review-data.js from the stored OSM snapshot.

Usage: python3 tools/build_review_data.py

Input : data/raw/osm_givat_ram_2026-11-02.json
        (OSM API /api/0.6/map bbox=35.1880,31.7690,35.2060,31.7800, fetched 2026-11-02)
Output: review/data/review-data.js  (window.REVIEW_DATA = {...})

Nothing here invents coordinates: every geometry comes from an OSM object,
and destination candidates reference the OSM object or document they came from.
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "raw", "osm_givat_ram_2026-11-02.json")
OUT = os.path.join(ROOT, "review", "data", "review-data.js")

# Area shown in the review map (campus core plus margin).
BBOX = (31.7700, 35.1925, 31.7800, 35.2012)  # S, W, N, E

BOOKLET = "https://www.cs.huji.ac.il/w~raananf/givat_ram_hebrew.pdf"
A300_PAGE = "https://en.aph.huji.ac.il/node/96765"
MATH_VISITOR = "https://mathematics.huji.ac.il/node/3066979"

VEHICLE_ONLY = {"motorway", "motorway_link", "trunk", "trunk_link"}
NOT_OPEN = {"construction", "proposed", "abandoned", "raceway"}


def osm_url(kind, oid):
    return f"https://www.openstreetmap.org/{kind}/{oid}"


def walk_class(t):
    """Return (class, reason) for a highway way.

    walk      : usable by pedestrians per its tags
    restricted: pedestrian access limited (private / customers / no)
    excluded  : vehicle-only or not open
    """
    h = t.get("highway")
    if h in VEHICLE_ONLY:
        return "excluded", f"highway={h} (vehicle-only)"
    if h in NOT_OPEN:
        return "excluded", f"highway={h}"
    foot = t.get("foot")
    access = t.get("access")
    if foot in ("no",):
        return "excluded", "foot=no"
    if foot in ("private", "customers", "destination") or (
        access in ("private", "no", "customers") and foot not in ("yes", "designated", "permissive")
    ):
        return "restricted", f"foot={foot or '-'} access={access or '-'}"
    if t.get("sidewalk") == "separate" or t.get("sidewalk:both") == "separate":
        # Road itself; sidewalks are mapped separately. Keep as walkable but flag it.
        return "walk", "road with separately-mapped sidewalk"
    return "walk", ""


def main():
    d = json.load(open(SRC, encoding="utf-8"))
    els = d["elements"]
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    ways = {e["id"]: e for e in els if e["type"] == "way"}

    def coords(w):
        return [[round(nodes[n]["lon"], 7), round(nodes[n]["lat"], 7)] for n in w["nodes"] if n in nodes]

    def in_bbox(cs):
        s, w_, n, e = BBOX
        return any(s <= c[1] <= n and w_ <= c[0] <= e for c in cs)

    def centroid(cs):
        # area-weighted polygon centroid (planar approximation, fine at this scale)
        a = cx = cy = 0.0
        for (x1, y1), (x2, y2) in zip(cs, cs[1:]):
            f = x1 * y2 - x2 * y1
            a += f
            cx += (x1 + x2) * f
            cy += (y1 + y2) * f
        if abs(a) < 1e-14:
            return [sum(c[0] for c in cs) / len(cs), sum(c[1] for c in cs) / len(cs)]
        return [round(cx / (3 * a), 7), round(cy / (3 * a), 7)]

    def inside(pt, ring):
        x, y = pt
        c = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def interior_point(cs):
        """Centroid if it lies inside the outline; otherwise the midpoint of the widest
        horizontal interior span (handles L/U-shaped buildings)."""
        c = centroid(cs)
        if inside(c, cs):
            return c
        ys = sorted(p[1] for p in cs)
        best = None
        for i in range(1, 40):
            y = ys[0] + (ys[-1] - ys[0]) * i / 40
            xs = sorted(x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                        for (x1, y1), (x2, y2) in zip(cs, cs[1:]) if (y1 > y) != (y2 > y))
            for a_, b_ in zip(xs[0::2], xs[1::2]):
                if best is None or b_ - a_ > best[0]:
                    best = (b_ - a_, [round((a_ + b_) / 2, 7), round(y, 7)])
        return best[1] if best else c

    buildings, paths, barriers, gates = [], [], [], []
    for n in nodes.values():
        t = n.get("tags", {})
        if "barrier" in t and in_bbox([[n["lon"], n["lat"]]]):
            gates.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(n["lon"], 7), round(n["lat"], 7)]},
                "properties": {"osm": f"node/{n['id']}", "url": osm_url("node", n["id"]),
                               "barrier": t["barrier"], "access": t.get("access"), "foot": t.get("foot"),
                               "name": t.get("name")},
            })
    for w in ways.values():
        t = w.get("tags", {})
        cs = coords(w)
        if len(cs) < 2 or not in_bbox(cs):
            continue
        if "building" in t and cs[0] == cs[-1]:
            buildings.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [cs]},
                "properties": {
                    "osm": f"way/{w['id']}",
                    "url": osm_url("way", w["id"]),
                    "name": t.get("name:he") or t.get("name"),
                    "name_en": t.get("name:en"),
                    "levels": t.get("building:levels"),
                    "height": t.get("height"),
                    "centroid": interior_point(cs),
                },
            })
        elif "barrier" in t and t["barrier"] != "gate":
            barriers.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": cs},
                "properties": {"osm": f"way/{w['id']}", "url": osm_url("way", w["id"]),
                               "barrier": t["barrier"]},
            })
        elif "highway" in t and t["highway"] not in ("bus_stop",):
            cls, why = walk_class(t)
            paths.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": cs},
                "properties": {
                    "osm": f"way/{w['id']}",
                    "url": osm_url("way", w["id"]),
                    "highway": t["highway"],
                    "name": t.get("name:he") or t.get("name"),
                    "class": cls,
                    "reason": why,
                    "foot": t.get("foot"),
                    "access": t.get("access"),
                },
            })

    bmap = {b["properties"]["osm"]: b for b in buildings}

    def bcand(osm_id, label, note, kind="building"):
        b = bmap[osm_id]
        return {
            "kind": kind,
            "label": label,
            "lonlat": b["properties"]["centroid"],
            "point_note": "נקודה פנימית מחושבת מקווי המתאר ב-OSM (לא כניסה)",
            "osm": osm_id,
            "source": b["properties"]["url"],
            "note": note,
        }

    hall_node = nodes[3705029048]
    shared_point = {
        "kind": "point",
        "label": "נקודת OSM: \"אולמות רוטברג וקפלן\"",
        "lonlat": [round(hall_node["lon"], 7), round(hall_node["lat"], 7)],
        "point_note": "נקודה אחת משותפת לשני האולמות ב-OSM; ללא קווי מתאר",
        "osm": "node/3705029048",
        "source": osm_url("node", 3705029048),
        "note": "OSM מספק נקודה משותפת אחת בלבד. אין להפריד קואורדינטות ללא מקור.",
        "shared_with": ["kaplan", "rothberg"],
    }

    # Unnamed OSM buildings within 90 m of the Plant Evolution Garden (way/580827811).
    garden = ways[580827811]
    gc = centroid(coords(garden))
    kx = 111320 * math.cos(math.radians(31.776))

    def dist_m(a, b):
        return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111320)

    canada_cands = []
    for b in buildings:
        p = b["properties"]
        dm = dist_m(p["centroid"], gc)
        if not p["name"] and dm < 90:
            canada_cands.append((dm, p["osm"]))
    canada_cands.sort()

    destinations = [
        {
            "id": "canada", "name": "אולם קנדה", "status": "unknown",
            "status_text": "מיקום לא ידוע – לא מופיע ב-OSM",
            "summary": "חוברת הסיור הרשמית של האוניברסיטה מאשרת את קיום האולם ומציינת שהמדרגות "
                       "\"מימין לאולם קנדה\" יורדות לגינת האבולוציה. גינת האבולוציה ממופה ב-OSM. "
                       "הבניינים הלא-מזוהים הסמוכים לגינה מוצגים כמועמדים בלבד.",
            "evidence": [
                {"label": "חוברת \"בשבילי הקמפוס\" (האוניברסיטה העברית)", "url": BOOKLET,
                 "quote": "המשיכו במורד המדרגות מימין לאולם קנדה, עברו את הבריכה, פנו ימינה והיכנסו לגינת האבולוציה."},
                {"label": "גינת האבולוציה של הצמח (OSM way/580827811)", "url": osm_url("way", 580827811)},
            ],
            "candidates": [
                bcand(o, f"בניין ללא שם ב-OSM, {round(dm)} מ' ממרכז גינת האבולוציה",
                      "מועמד בלבד – אין מקור שמזהה בניין זה כאולם קנדה.", kind="candidate")
                for dm, o in canada_cands
            ],
        },
        {
            "id": "engineering", "name": "אודיטוריום הנדסה", "status": "unknown",
            "status_text": "מיקום לא ידוע – לא נמצא מקור בשם זה",
            "summary": "לא נמצא מקור שמשתמש בשם \"אודיטוריום הנדסה\". נמצא עמוד אירוע המזכיר את "
                       "אודיטוריום מדעי המחשב A300 בבניין רוטברג A – לפי הנחייתך הוא אינו מונח כמיקום.",
            "evidence": [
                {"label": "עמוד אירוע: A300, רוטברג A (לא הונח כמיקום)", "url": A300_PAGE},
            ],
            "candidates": [],
        },
        {
            "id": "sprinzak", "name": "בניין שפרינצק", "status": "verified",
            "status_text": "בניין מאומת ב-OSM – כניסה לא ממופה",
            "summary": "קווי מתאר ב-OSM בשם \"בניין שפרינצק\" (2 קומות). אין כניסות ממופות.",
            "evidence": [{"label": "OSM way/121791888", "url": osm_url("way", 121791888)}],
            "candidates": [bcand("way/121791888", "בניין שפרינצק (OSM)", "שם תואם ב-OSM.")],
        },
        {
            "id": "harman", "name": "ספריית הרמן", "status": "verified",
            "status_text": "בניין מאומת ב-OSM – כניסה לא ממופה",
            "summary": "קווי מתאר ב-OSM בשם \"ספריית הרמן למדעי הטבע\". אין כניסות ממופות.",
            "evidence": [{"label": "OSM way/121168935", "url": osm_url("way", 121168935)}],
            "candidates": [bcand("way/121168935", "ספריית הרמן למדעי הטבע (OSM)", "שם תואם ב-OSM.")],
        },
        {
            "id": "kaplan", "name": "אולם קפלן", "status": "shared",
            "status_text": "נקודה משותפת עם רוטברג – לא מאומת בנפרד",
            "summary": "ב-OSM קיימת נקודה אחת בשם \"אולמות רוטברג וקפלן\", ללא קווי מתאר וללא כניסות. "
                       "קפלן ורוטברג הם יעדים נפרדים, אך אין מקור לקואורדינטות נפרדות.",
            "evidence": [{"label": "OSM node/3705029048", "url": osm_url("node", 3705029048)}],
            "candidates": [shared_point],
        },
        {
            "id": "rothberg", "name": "רוטברג", "status": "shared",
            "status_text": "נקודה משותפת עם קפלן – לא מאומת בנפרד",
            "summary": "האולם הסמוך לאולם קפלן (לא מתחם בנייני רוטברג A/B/C). ב-OSM יש רק הנקודה "
                       "המשותפת \"אולמות רוטברג וקפלן\".",
            "evidence": [{"label": "OSM node/3705029048", "url": osm_url("node", 3705029048)}],
            "candidates": [shared_point],
        },
        {
            "id": "manchester", "name": "בניין מנצ'סטר — מתמטיקה", "status": "verified",
            "status_text": "בניין מאומת ב-OSM – כניסה לא ממופה",
            "summary": "קווי מתאר ב-OSM בשם \"בניין מנצ'סטר\" / Manchester Building. אתר מכון איינשטיין "
                       "למתמטיקה ממקם בבניין מנצ'סטר את הספרייה ואת האולמות של המכון. אין כניסות ממופות; "
                       "האתר מזכיר \"main entrance\" בלי לציין את מיקומה.",
            "evidence": [{"label": "OSM way/121791882", "url": osm_url("way", 121791882)},
                         {"label": "מכון איינשטיין – Visitor Information", "url": MATH_VISITOR}],
            "candidates": [bcand("way/121791882", "בניין מנצ'סטר (OSM)", "שם תואם ב-OSM.")],
        },
    ]

    landmarks = []
    for oid, label in [
        ("way/580827811", "גינת האבולוציה של הצמח"),
    ]:
        w = ways[int(oid.split("/")[1])]
        landmarks.append({"label": label, "lonlat": centroid(coords(w)), "osm": oid,
                          "source": osm_url("way", w["id"])})

    data = {
        "generated": "2026-11-02",
        "bbox": BBOX,
        "sources": [
            {"label": "OpenStreetMap – © OpenStreetMap contributors, ODbL",
             "url": "https://www.openstreetmap.org/copyright",
             "detail": "OSM API /api/0.6/map bbox=35.1880,31.7690,35.2060,31.7800, נשלף 2026-11-02"},
            {"label": "חוברת \"בשבילי הקמפוס – סיור בקמפוס אדמונד י' ספרא\"", "url": BOOKLET,
             "detail": "האוניברסיטה העברית; טקסט בלבד חולץ, המפה שבה לא נקראה"},
        ],
        "destinations": destinations,
        "landmarks": landmarks,
        "buildings": {"type": "FeatureCollection", "features": buildings},
        "paths": {"type": "FeatureCollection", "features": paths},
        "barriers": {"type": "FeatureCollection", "features": barriers},
        "gates": {"type": "FeatureCollection", "features": gates},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_review_data.py – do not edit by hand.\n")
        f.write("window.REVIEW_DATA = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"buildings={len(buildings)} paths={len(paths)} barriers={len(barriers)} gates={len(gates)} canada_candidates={len(canada_cands)} -> {OUT}")


if __name__ == "__main__":
    main()
