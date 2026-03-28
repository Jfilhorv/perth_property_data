from pathlib import Path

from build_dashboard_data import main as build_dashboard


def main() -> None:
    build_dashboard()
    root = Path(__file__).resolve().parents[1]
    stops = root / "Stops_PTA_001_WA_GDA2020_Public_GeoJSON" / "Stops_PTA_001_WA_GDA2020_Public.geojson"
    routes = root / "Service_Routes_PTA_002_WA_GDA2020_Public_GeoJSON" / "Service_Routes_PTA_002_WA_GDA2020_Public.geojson"
    if stops.is_file() and routes.is_file():
        from build_public_transport_data import main as build_public_transport

        build_public_transport()


if __name__ == "__main__":
    main()
