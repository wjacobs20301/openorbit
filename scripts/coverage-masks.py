"""Builds src/data/coverage-masks.json: the outlines that national aerial photo layers are
clipped to, for the services that paint filler imagery outside their own country.

    pip install shapely && python3 scripts/coverage-masks.py

Boundaries come from geoBoundaries (https://www.geoboundaries.org), each under its
source's licence: Switzerland (swisstopo OGD), Spain (CC BY 4.0), Portugal and Morocco
(ODbL), Gibraltar (CC BY 4.0), Andorra (public domain). The output is published under the
same terms; see src/data/README.md.
"""
import json
import pathlib
import subprocess

from shapely.geometry import box, shape
from shapely.ops import unary_union

# id -> country to keep, coastal sea margin (degrees), and land neighbours to cut back out.
MASKS = {
    # swisstopo fills the rest of its map with coarse imagery. Landlocked: no margin.
    "ch": {"own": "CHE", "sea": 0, "neighbours": []},
    # Spain's PNOA paints coarse imagery or flat colour over Portugal, France and Morocco.
    # ~3 km of sea is kept. Along the Pyrenees (the box) the outline is Spain's own border
    # with no margin, since France's layer skips Spain and must meet it exactly.
    "es": {
        "own": "ESP",
        "sea": 0.03,
        "neighbours": ["PRT", "AND", "GIB", "MAR"],
        "exact_in": (-1.9, 42.3, 3.4, 43.5),
    },
}
# Simplification tolerance in degrees (about 15 m).
TOLERANCE = 0.00015


def get_json(url):
    # curl rather than urllib: python.org builds on macOS ship without CA certificates.
    return json.loads(subprocess.run(["curl", "-sfL", "--retry", "4", url], check=True, capture_output=True).stdout)


def country(iso):
    meta = get_json(f"https://www.geoboundaries.org/api/current/gbOpen/{iso}/ADM0/")
    data = get_json(meta["gjDownloadURL"])
    print(f"{iso}: {meta['boundaryLicense']}")
    geom = unary_union([shape(f["geometry"]) for f in data["features"]])
    return geom.simplify(TOLERANCE).buffer(0)


out = {}
for mask_id, spec in MASKS.items():
    geom = country(spec["own"])
    if spec["sea"]:
        geom = geom.buffer(spec["sea"], resolution=4).union(geom)
        area = box(*geom.bounds)
        for iso in spec["neighbours"]:
            geom = geom.difference(country(iso).intersection(area))
        if "exact_in" in spec:
            exact = box(*spec["exact_in"])
            geom = geom.difference(exact).union(country(spec["own"]).intersection(exact))
    geom = geom.simplify(TOLERANCE)
    polygons = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    rings = []
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            # Flat [lon, lat, lon, lat, ...] rounded to about 1 m.
            rings.append([round(v, 5) for xy in ring.coords for v in xy])
    out[mask_id] = rings
    print(f"{mask_id}: {len(rings)} rings, {sum(len(r) // 2 for r in rings)} points")

target = pathlib.Path(__file__).resolve().parent.parent / "src" / "data" / "coverage-masks.json"
target.write_text(json.dumps(out, separators=(",", ":")))
