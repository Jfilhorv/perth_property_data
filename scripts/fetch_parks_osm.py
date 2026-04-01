import json
import urllib.parse
import urllib.request


def main() -> None:
    south, west, north, east = -32.16, 115.70, -31.74, 116.10
    query = f"""
[out:json][timeout:180];
(
  way["leisure"="park"]({south},{west},{north},{east});
  relation["leisure"="park"]({south},{west},{north},{east});
  way["boundary"="protected_area"]({south},{west},{north},{east});
  way["landuse"="recreation_ground"]({south},{west},{north},{east});
);
out body;
>;
out skel qt;
""".strip()
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=payload,
        headers={"User-Agent": "perth-property-data/1.0"},
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        data = json.loads(response.read().decode("utf-8"))
    with open("dashboard/data/parks_osm_raw.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print("elements", len(data.get("elements", [])))


if __name__ == "__main__":
    main()
