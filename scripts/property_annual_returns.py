"""
Build per-property sale intervals and annualized returns between consecutive sales.

Rules (same property / house_key):
  - Same calendar date + same price  -> duplicates collapsed to one row
  - Same calendar date + diff prices -> keep the row with MAX price only
  - years between sales              -> elapsed time in fractional years (days / 365.25)

  annual_return = (price_t / price_t_minus_1) ** (1 / years) - 1

Also writes a per-property summary with avg_annual_return for projections:
  future_price = current_price * (1 + avg_annual_return)
  future_price_n = current_price * (1 + avg_annual_return) ** n
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


def _normalize_suburb_name(value) -> str:
    """Match dashboard `normalizeSuburbName` (title-case words)."""
    raw = " ".join(str(value or "").strip().split())
    if not raw:
        return ""
    return " ".join((w[0].upper() + w[1:].lower()) if w else "" for w in raw.split(" "))


def _house_key_row(row: pd.Series) -> str:
    lat, lon = row.get("Latitude"), row.get("Longitude")
    if pd.notna(lat) and pd.notna(lon):
        return f"geo:{float(lat):.7f}|{float(lon):.7f}"
    lid = row.get("Listing_ID")
    if pd.notna(lid) and str(lid).strip() != "":
        try:
            return f"listing:{int(float(lid))}"
        except (ValueError, TypeError):
            return f"listing:{lid}"
    addr = str(row.get("Address") or "").strip().lower()
    sub = str(row.get("Suburb") or "").strip().lower()
    return f"listing-fallback:{addr}|{sub}"


def _collapse_sales_same_property(part: pd.DataFrame) -> pd.DataFrame:
    """One representative sale per calendar day: max price; duplicate same-day same-price removed."""
    if part.empty:
        return part
    work = part.copy()
    work["_day"] = pd.to_datetime(work["Date_Sold"], errors="coerce").dt.normalize()
    work = work.dropna(subset=["_day", "Price"])
    if work.empty:
        return work.iloc[0:0]
    kept: list[pd.Series] = []
    for _, day_grp in work.groupby("_day", sort=True):
        pmax = day_grp["Price"].max()
        # Among rows at max price that day, keep one stable row (e.g. smallest Listing_ID)
        at_max = day_grp[day_grp["Price"] == pmax]
        if "Listing_ID" in at_max.columns:
            at_max = at_max.sort_values("Listing_ID", na_position="last")
        kept.append(at_max.iloc[0])
    out = pd.DataFrame(kept)
    out = out.drop(columns=["_day"], errors="ignore")
    out = out.sort_values("Date_Sold").reset_index(drop=True)
    return out


def _intervals_for_property(house_key: str, collapsed: pd.DataFrame) -> list[dict]:
    if len(collapsed) < 2:
        return []
    rows: list[dict] = []
    collapsed = collapsed.sort_values("Date_Sold").reset_index(drop=True)
    for i in range(1, len(collapsed)):
        prev = collapsed.iloc[i - 1]
        cur = collapsed.iloc[i]
        d0 = pd.Timestamp(prev["Date_Sold"])
        d1 = pd.Timestamp(cur["Date_Sold"])
        days = (d1 - d0).days
        years = days / 365.25
        prev_price = float(prev["Price"])
        price = float(cur["Price"])
        if years <= 0 or prev_price <= 0 or price <= 0 or not np.isfinite(years):
            continue
        annual_return = (price / prev_price) ** (1.0 / years) - 1.0
        if not np.isfinite(annual_return):
            continue
        rec = {
            "house_key": house_key,
            "Suburb": _normalize_suburb_name(cur.get("Suburb")),
            "Address": cur.get("Address"),
            "prev_date_sold": d0.strftime("%Y-%m-%d"),
            "date_sold": d1.strftime("%Y-%m-%d"),
            "prev_price": prev_price,
            "price": price,
            "years": round(float(years), 6),
            "annual_return": float(annual_return),
        }
        if "Listing_ID" in cur.index and pd.notna(cur["Listing_ID"]):
            try:
                rec["listing_id"] = int(float(cur["Listing_ID"]))
            except (ValueError, TypeError):
                rec["listing_id"] = cur["Listing_ID"]
        rows.append(rec)
    return rows


def build_interval_and_summary_records(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    """Return (interval_records, summary_per_house_key)."""
    work = df.copy()
    work["Date_Sold"] = pd.to_datetime(work["Date_Sold"], dayfirst=True, errors="coerce")
    work = work.dropna(subset=["Date_Sold", "Price"])
    work["house_key"] = work.apply(_house_key_row, axis=1)

    all_intervals: list[dict] = []
    summaries: list[dict] = []

    for house_key, grp in work.groupby("house_key", sort=False):
        collapsed = _collapse_sales_same_property(grp)
        if collapsed.empty:
            continue
        intervals = _intervals_for_property(house_key, collapsed)
        all_intervals.extend(intervals)

        last = collapsed.sort_values("Date_Sold").iloc[-1]
        returns = [x["annual_return"] for x in intervals if np.isfinite(x["annual_return"])]
        avg_ret = float(np.mean(returns)) if returns else None
        summ = {
            "house_key": house_key,
            "Suburb": _normalize_suburb_name(last.get("Suburb")),
            "Address": last.get("Address"),
            "current_price": float(last["Price"]),
            "last_sale_date": pd.Timestamp(last["Date_Sold"]).strftime("%Y-%m-%d"),
            "sale_count_after_dedupe": int(len(collapsed)),
            "interval_count": int(len(intervals)),
            "avg_annual_return": avg_ret,
        }
        if avg_ret is not None and np.isfinite(avg_ret):
            summ["future_price_1y"] = float(last["Price"]) * (1.0 + avg_ret)
        else:
            summ["future_price_1y"] = None
        summaries.append(summ)

    return all_intervals, summaries


def write_annual_return_jsons(df: pd.DataFrame, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    intervals, summaries = build_interval_and_summary_records(df)

    (output_dir / "property_annual_return_intervals.json").write_text(
        json.dumps(intervals, indent=2),
        encoding="utf-8",
    )
    (output_dir / "property_annual_return_summary.json").write_text(
        json.dumps(summaries, indent=2),
        encoding="utf-8",
    )
    print(
        "Annual return tables:",
        len(intervals),
        "intervals,",
        len(summaries),
        "properties ->",
        output_dir,
    )


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    csv_path = root / "perth_property_data.csv"
    out = root / "dashboard" / "data"
    d = pd.read_csv(csv_path)
    write_annual_return_jsons(d, out)
