"""
Filter PTA-001 (stops) and PTA-002 (service routes) GeoJSON to Greater Perth metro
for use in the static dashboard (smaller files, faster browser load).

Source paths are relative to the repo root. Re-run after replacing source downloads.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "dashboard" / "data"

# Perth metro core (tighter box keeps route file small enough for browser fetch)
PERTH_BBOX = (115.70, -32.22, 116.12, -31.58)

STOPS_SRC = ROOT / "Stops_PTA_001_WA_GDA2020_Public_GeoJSON" / "Stops_PTA_001_WA_GDA2020_Public.geojson"
ROUTES_SRC = ROOT / "Service_Routes_PTA_002_WA_GDA2020_Public_GeoJSON" / "Service_Routes_PTA_002_WA_GDA2020_Public.geojson"

STOPS_OUT = OUTPUT_DIR / "public_transport_stops.geojson"
ROUTES_OUT = OUTPUT_DIR / "public_transport_routes.geojson"


def walk_coords(node, visitor) -> None:
    if not node:
        return
    if isinstance(node[0], (int, float)):
        visitor(float(node[0]), float(node[1]))
        return
    for part in node:
        walk_coords(part, visitor)


def feature_bbox(geometry: dict) -> tuple[float, float, float, float] | None:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not gtype or coords is None:
        return None
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")

    def visitor(lon: float, lat: float) -> None:
        nonlocal min_lon, min_lat, max_lon, max_lat
        min_lon = min(min_lon, lon)
        max_lon = max(max_lon, lon)
        min_lat = min(min_lat, lat)
        max_lat = max(max_lat, lat)

    try:
        walk_coords(coords, visitor)
    except (TypeError, ValueError, IndexError):
        return None
    if min_lon == float("inf"):
        return None
    return (min_lon, min_lat, max_lon, max_lat)


def intersects_metro(fb: tuple[float, float, float, float], metro: tuple[float, float, float, float]) -> bool:
    min_lon, min_lat, max_lon, max_lat = fb
    ml, mb, mr, mt = metro
    return not (max_lon < ml or min_lon > mr or max_lat < mb or min_lat > mt)


def round_pt(pair: list, ndp: int = 5) -> list:
    return [round(float(pair[0]), ndp), round(float(pair[1]), ndp)]


def decimate_ring(ring: list, step: int) -> list:
    """Keep every `step` vertices plus endpoints so polylines stay lightweight in the browser."""
    if len(ring) <= 2 or step <= 1:
        return [round_pt(p) for p in ring]
    out = [round_pt(ring[0])]
    for i in range(step, len(ring) - 1, step):
        out.append(round_pt(ring[i]))
    last = round_pt(ring[-1])
    if out[-1] != last:
        out.append(last)
    return out


def simplify_multiline_coords(coords: list, step: int) -> list:
    out = []
    for line in coords:
        if not line:
            continue
        decimated = decimate_ring(line, step)
        if len(decimated) >= 2:
            out.append(decimated)
    return out


def filter_collection(path: Path, metro: tuple[float, float, float, float]) -> dict:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    features = data.get("features") or []
    kept = []
    for feat in features:
        geom = feat.get("geometry")
        if not geom:
            continue
        fb = feature_bbox(geom)
        if fb and intersects_metro(fb, metro):
            if geom.get("type") == "Point" and geom.get("coordinates"):
                kept.append(
                    {
                        "type": "Feature",
                        "properties": feat.get("properties") or {},
                        "geometry": {"type": "Point", "coordinates": round_pt(geom["coordinates"])},
                    }
                )
            else:
                kept.append(feat)
    return {
        "type": "FeatureCollection",
        "name": data.get("name", path.stem),
        "features": kept,
    }


def filter_and_simplify_routes(path: Path, metro: tuple[float, float, float, float], decimate_step: int) -> dict:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    features = data.get("features") or []
    kept = []
    for feat in features:
        geom = feat.get("geometry")
        if not geom or geom.get("type") != "MultiLineString":
            continue
        coords = geom.get("coordinates")
        if not coords:
            continue
        fb = feature_bbox(geom)
        if not fb or not intersects_metro(fb, metro):
            continue
        new_coords = simplify_multiline_coords(coords, decimate_step)
        if not new_coords:
            continue
        kept.append(
            {
                "type": "Feature",
                "properties": feat.get("properties") or {},
                "geometry": {"type": "MultiLineString", "coordinates": new_coords},
            }
        )
    return {
        "type": "FeatureCollection",
        "name": data.get("name", path.stem),
        "features": kept,
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if not STOPS_SRC.is_file():
        raise SystemExit(f"Missing stops source: {STOPS_SRC}")
    if not ROUTES_SRC.is_file():
        raise SystemExit(f"Missing routes source: {ROUTES_SRC}")

    stops_fc = filter_collection(STOPS_SRC, PERTH_BBOX)
    routes_fc = filter_and_simplify_routes(ROUTES_SRC, PERTH_BBOX, decimate_step=28)

    STOPS_OUT.write_text(json.dumps(stops_fc, separators=(",", ":")), encoding="utf-8")
    ROUTES_OUT.write_text(json.dumps(routes_fc, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote {STOPS_OUT.name}: {len(stops_fc['features'])} features ({STOPS_OUT.stat().st_size // 1024} KB)")
    print(f"Wrote {ROUTES_OUT.name}: {len(routes_fc['features'])} features ({ROUTES_OUT.stat().st_size // 1024 // 1024} MB)")


if __name__ == "__main__":
    main()
