import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
INPUT_CSV = ROOT / "perth_property_data.csv"
OUTPUT_DIR = ROOT / "dashboard" / "data"


def to_serializable_records(df: pd.DataFrame) -> list[dict]:
    records = df.where(pd.notnull(df), None).to_dict(orient="records")
    return records


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(INPUT_CSV)
    df["Date_Sold"] = pd.to_datetime(df["Date_Sold"], dayfirst=True, errors="coerce")
    df["Year"] = df["Date_Sold"].dt.year

    summary = {
        "rows": int(len(df)),
        "columns": int(len(df.columns)),
        "date_min": df["Date_Sold"].min().strftime("%Y-%m-%d") if df["Date_Sold"].notna().any() else None,
        "date_max": df["Date_Sold"].max().strftime("%Y-%m-%d") if df["Date_Sold"].notna().any() else None,
        "price_median": float(df["Price"].median()),
        "price_mean": float(df["Price"].mean()),
        "price_p75": float(df["Price"].quantile(0.75)),
        "price_p95": float(df["Price"].quantile(0.95)),
    }

    yearly = (
        df.dropna(subset=["Year"])
        .groupby("Year", as_index=False)
        .agg(median_price=("Price", "median"), sales=("Listing_ID", "count"))
        .sort_values("Year")
    )
    yearly["Year"] = yearly["Year"].astype(int)

    yearly_by_suburb = (
        df.dropna(subset=["Year"])
        .groupby(["Suburb", "Year"], as_index=False)
        .agg(median_price=("Price", "median"), sales=("Listing_ID", "count"))
        .sort_values(["Suburb", "Year"])
    )
    yearly_by_suburb["Year"] = yearly_by_suburb["Year"].astype(int)

    property_type = (
        df.groupby("Property_Type", as_index=False)
        .agg(count=("Listing_ID", "count"), median_price=("Price", "median"))
        .sort_values("count", ascending=False)
    )

    suburb = (
        df.groupby("Suburb", as_index=False)
        .agg(
            count=("Listing_ID", "count"),
            median_price=("Price", "median"),
            avg_price=("Price", "mean"),
            avg_distance_to_cbd=("Distance_to_CBD", "mean"),
        )
        .sort_values(["count", "median_price"], ascending=[False, False])
    )

    suburb_map = (
        df.dropna(subset=["Latitude", "Longitude"])
        .groupby("Suburb", as_index=False)
        .agg(
            count=("Listing_ID", "count"),
            avg_price=("Price", "mean"),
            median_price=("Price", "median"),
            latitude=("Latitude", "mean"),
            longitude=("Longitude", "mean"),
        )
        .sort_values("count", ascending=False)
    )

    listings_cols = [
        "Listing_ID",
        "Price",
        "Suburb",
        "Address",
        "Property_Type",
        "Bedrooms",
        "Bathrooms",
        "Parking_Spaces",
        "Land_Size",
        "Longitude",
        "Latitude",
        "Distance_to_CBD",
        "Year",
        "Primary_School_Name",
        "Primary_School_Distance",
        "Secondary_School_Name",
        "Secondary_School_Distance",
    ]
    listings_sample = (
        df[listings_cols]
        .dropna(subset=["Longitude", "Latitude"])
        .sample(n=min(8000, len(df)), random_state=42)
    )

    listings_core = df[listings_cols].dropna(subset=["Longitude", "Latitude"])

    school_points = (
        listings_core.groupby("Primary_School_Name", as_index=False)
        .agg(
            count=("Listing_ID", "count"),
            latitude=("Latitude", "mean"),
            longitude=("Longitude", "mean"),
            avg_price=("Price", "mean"),
        )
        .rename(columns={"Primary_School_Name": "school_name"})
        .sort_values("count", ascending=False)
    )

    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "yearly.json").write_text(
        json.dumps(to_serializable_records(yearly), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "yearly_by_suburb.json").write_text(
        json.dumps(to_serializable_records(yearly_by_suburb), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "property_type_stats.json").write_text(
        json.dumps(to_serializable_records(property_type), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "suburb_stats.json").write_text(
        json.dumps(to_serializable_records(suburb), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "suburb_map_stats.json").write_text(
        json.dumps(to_serializable_records(suburb_map), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "listings_sample.json").write_text(
        json.dumps(to_serializable_records(listings_sample), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "listings_core.json").write_text(
        json.dumps(to_serializable_records(listings_core), indent=2), encoding="utf-8"
    )
    (OUTPUT_DIR / "school_points_estimated.json").write_text(
        json.dumps(to_serializable_records(school_points), indent=2), encoding="utf-8"
    )

    print("Dashboard data generated in:", OUTPUT_DIR)


if __name__ == "__main__":
    main()
