# מפת הליכה תלת-ממדית – קמפוס אדמונד י' ספרא (גבעת רם)

A static, browser-only 3D walking map of the Hebrew University's Givat Ram campus, with seven
destinations, shortest-path routing on the bundled pedestrian network, and Hebrew walking directions.
No backend, no API keys, no build step. Published on GitHub Pages: <https://jonathan-samuelson.github.io/aicode-lab1/>.

## Open it

```bash
cd lab1
python3 -m http.server 8000
```

- App: <http://localhost:8000/>
- Location-review map: <http://localhost:8000/review/>

Use a local server rather than opening `index.html` directly: the 3D renderer is an ES module, and
browsers don't load modules from `file://`. Add `&fx=low` to the URL to start in reduced-effects mode.
You can link straight to a route: `http://localhost:8000/#from=harman&to=engineering`
(ids: `canada`, `engineering`, `sprinzak`, `harman`, `kaplan`, `rothberg`, `manchester`).
Add `&lawn=1` to turn on lawn shortcuts: `http://localhost:8000/#from=harman&to=engineering&lawn=1`.

## 90-second demo

1. The app opens with the route **בניין שפרינצק → אולם קנדה**: about 226 m, made of 217 m on the
   mapped network plus 9 m of dashed approximate connection.
2. Drag to pan, scroll to zoom (towards the cursor), and right-drag (or Ctrl+drag) to orbit and tilt.
   On touch screens: one finger pans, two fingers zoom and rotate. The toolbar at the top left has zoom,
   rotate, tilt and top-view buttons, plus **"איפוס תצוגה"** to return to the opening view.
3. Press **⇅** to swap the start and destination. The route and directions update.
4. Pick **ספריית הרמן → אודיטוריום הנדסה**. The route detours via שדרות מאגנס because OSM has
   no direct path mapped there (see limitations).
5. Pick **אולם קפלן → רוטברג**. The app refuses: both share one OSM point, so they can't be told apart.
6. Click destination labels on the map: the first click sets the start, the second the destination.
7. Keep **ספריית הרמן → אודיטוריום הנדסה** and tick **"אפשר קיצורי דרך דרך הדשא"**. The route drops from
   about 427 m to about 290 m. A green dashed stretch labelled "קיצור דרך משוער בדשא — יש לוודא שניתן
   לעבור" crosses the grass strip next to שדרות מאגנס, and the directions include a green step for it.
8. Pick **בניין שפרינצק → בניין מנצ'סטר — מתמטיקה** in both modes: about 456 m on paths, about 440 m with a
   66 m lawn stretch. Swap to check the reverse direction.

## 3D view

- **Renderer:** three.js 0.170 (`vendor/three/`, MIT), loaded through an import map. There's no build step.
  `app/scene3d.js` only draws. It reads the routing data and `app/data/scenery-data.js` and never changes
  either, and the routes it draws come from `app/route.js`.
- **What is mapped:**
  - Building footprints are the same outlines the router uses.
  - Grass, forest, parking, plazas, pitches, water and construction areas are OSM areas.
  - Roads, paths, steps, the light rail, the one mapped fence, and 2 OSM tree nodes are also from OSM.
  - Scenery data is built by `tools/build_scenery_data.py`.
- **What is illustrative:**
  - Building heights: 8 of the 180 buildings shown have a mapped height or floor count. The rest are
    9 m. Clicking a building shows where its height comes from.
  - Stone walls, window patterns (one bay about every 3.2 m, one row per floor), roof parapets,
    stepped tile roofs (on buildings OSM tags with tile or hipped roofs), road widths, and colours.
  - 1,021 decorative voxel trees, placed on a 7 m grid only inside OSM forest/wood areas and kept off
    buildings, roads and paths. The legend gives both tree counts. The tree toggle under "תצוגה וביצועים"
    hides the decorative ones.
  - The ground is flat: there is no elevation data.
- **Lighting:**
  - Warm afternoon sun from the west-south-west with soft shadows, a sky light, and darkened wall bases.
  - Light distance fog and a gradient sky. Tone mapping is ACES.
  - No bloom and no animation.
- **Reduced-effects mode** ("מצב חסכוני"): no shadows, pixel ratio 1, and fewer decorative trees.
  It turns on automatically when the browser reports 4 or fewer CPU cores or 4 GB or less of memory.
  The choice is saved in the browser, and `#fx=low` / `#fx=high` overrides it.
- **Routes:**
  - Drawn just above the ground on a white casing. Mapped paths are solid blue, lawn shortcuts are
    green dashes, and approximate building connections are orange dashes.
  - A faint copy shows through buildings that hide the route.
- **Labels:**
  - HTML labels, placed so they don't overlap.
  - Destination and uncertainty labels (confidence lines and the lawn-shortcut label) are never hidden,
    only moved. Building-name labels are hidden when they would overlap or when zoomed out.

## How routing works

- **Network:** OSM `highway` ways that pedestrians may use according to their tags
  (`tools/build_app_data.py`, `way_walk_rule`/`node_rule`).
  - Excluded: motorways and trunk roads, ways under construction, `foot`/`access` = no,
    private, customers or destination, and roads whose sidewalks are mapped separately.
  - Gates that are locked, `access=no` or `foot=destination` block passage.
  - A gate with conditional opening hours stays passable, and the directions show a warning.
- **Shortest path:** Dijkstra by distance (`app/route.js`). Its results equal an independent
  Python Dijkstra for all 40 routable pairs, in both modes (`tests/`).
- **Approximate connections:** no entrances are mapped, so each destination is joined to the network
  by the shortest straight link that is:
  - at most 40 m long;
  - starts where a line from the location point leaves the building outline;
  - doesn't cross any other mapped building or barrier.

  Its length is shown separately, and on the map it is drawn dashed. If no such link exists, the
  route stops at the mapped network endpoint and says the last stretch is unverified. It never
  draws a straight line through obstacles.
- **Lawn shortcuts (optional, off by default):**
  - OSM maps no `landuse=grass` here. The candidate lawns are the 8 areas tagged `leisure=park`
    (or meadow / village_green) inside the campus outline (`way/44139761`). Aerial imagery shows them as a
    mix of grass, trees and paved patches, so every shortcut is labelled as inferred.
  - A shortcut is a straight line between two mapped path points at the edge of or inside the same area. It
    must stay inside that area; only the first and last 2.5 m may cross its outline.
  - It must not cross buildings, barriers, roads, steps, railways, excluded or restricted ways, pitches,
    playgrounds, gardens, parking, water, construction or forest. Its ends can't be on steps, bridges,
    tunnels, indoor ways, roads or gates.
  - Only shortcuts that save at least 3 m over the mapped paths are offered (234 in total). Lawn mode is the
    shortest route on paths plus these shortcuts. It is never longer than path-only mode.
  - Rules and parameters: `build_lawns` in `tools/build_app_data.py`, and `lawn_rules` in the generated data.
- **No connected route:** if the endpoints sit in disconnected parts of the network, the app
  explains this and draws nothing.

## Destination data

| יעד | Location source | Confidence kept |
|---|---|---|
| אולם קנדה | Your correction, inside OSM `way/136591964` | field (אומת בשטח) |
| אודיטוריום הנדסה | Your correction, inside OSM `way/216960393` (Rothberg A) | estimate (הערכה) |
| בניין שפרינצק | OSM `way/121791888` (computed point inside the outline) | OSM |
| ספריית הרמן | OSM `way/121168935` (computed point inside the outline) | OSM |
| אולם קפלן | OSM `node/3705029048` "אולמות רוטברג וקפלן" | shared OSM point |
| רוטברג | Same OSM point, selected by you in the review map | estimate |
| בניין מנצ'סטר — מתמטיקה | OSM `way/121791882` "בניין מנצ'סטר" / "Manchester Building" (computed point inside the outline). The Einstein Institute's visitor page places its library and lecture halls in the Manchester building. | OSM |

Your building locations are **not** treated as entrances. Entrances you mark in the review map
are used as connection points instead of the building outline.

## Limitations

- No building entrances are mapped, so there is no door-to-door accuracy. Every route starts and ends
  with an approximate link.
- "Shortest" means shortest on the included network only (OSM snapshot of 2026-11-02). Unmapped
  shortcuts aren't known. Example: ספריית הרמן → אודיטוריום הנדסה takes a long detour because no
  direct path is mapped. A looser network that ignores all access tags gives the same distance, so
  the gap is in OSM, not in the exclusion rules.
- Fences are barely mapped (one way near the core). Gate opening hours aren't evaluated.
- Steps are only "up" or "down" where OSM has an `incline` tag. There's no step-free routing option.
- Lawn shortcuts are inferred from area tags only. The data does not show slopes, terraces, retaining walls,
  flowerbeds, dense planting or unmapped fences inside the green areas. Treat every green dashed stretch as
  "check on site".
- Manchester Building: the institute's site mentions a "main entrance" but not where it is, so the
  final 4 m to the building is an approximate link like the others.
- Building heights are schematic: 3.5 m per mapped floor, otherwise 9 m.
- Landmark names in the directions are OSM building names within 25 m of each turn. Note that
  "בניין קפלון" is a different building from "אולם קפלן".

## Updating corrections

1. In the review map, set points and choose "ייצוא JSON".
2. Replace `data/corrections/givat-ram-location-corrections.json` with the exported file.
3. Run `python3 tools/build_app_data.py` and reload the app.

## Tests

```bash
python3 -I tests/test_app_data.py   # data rules, corrections, Manchester, lawn checks, reference paths (both modes)
node tests/routing.test.js          # JS router vs reference in both modes, lawn rules, Manchester, no-route
python3 -I tests/test_scenery_data.py  # scenery is separate from routing and drawn from mapped data
node review/tests/data-and-geometry.test.js
node review/tests/obstacles-and-export.test.js
```

## Files

- `index.html`, `app/app.js`, `app/app.css`: the app page and panel.
- `app/scene3d.js`: the 3D renderer (three.js). It draws only.
- `app/data/scenery-data.js`: visual-only OSM scenery, generated by `tools/build_scenery_data.py`.
- `app/route.js`: routing and Hebrew directions (no map code).
- `app/data/campus-data.js`: generated by `tools/build_app_data.py`.
- `data/raw/osm_givat_ram_2026-11-02.json`: OSM API snapshot (bbox 35.1880,31.7690,35.2060,31.7800).
- `data/corrections/`: your exported corrections.
- `review/`: the location-review map (Leaflet).
- `vendor/three/`: three.js 0.170.0 core and MapControls (MIT). Leaflet 1.9.4 is in `review/vendor/`.

## Sources and attribution

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
  Background tiles: tile.openstreetmap.org (light use, with attribution).
- Einstein Institute of Mathematics, "Visitor Information": <https://mathematics.huji.ac.il/node/3066979>.
  Places the institute's library, main auditorium and lecture halls on the 2nd floor of the Manchester
  building. Wikipedia's "Einstein Institute of Mathematics" article says the institute is housed in the Manchester Building.
- "בשבילי הקמפוס – סיור בקמפוס אדמונד י' ספרא", Hebrew University:
  <https://www.cs.huji.ac.il/w~raananf/givat_ram_hebrew.pdf>. Confirms Canada Hall is next to
  the Plant Evolution Garden.
- Location corrections: supplied by the project owner through the review map
  (`data/corrections/`, exported 2026-11-02).
- [three.js](https://threejs.org) (MIT), [Leaflet](https://leafletjs.com) (BSD-2-Clause).
