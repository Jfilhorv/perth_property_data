# Perth Property Data Dashboard

Project for Perth property data analysis with a simple Python pipeline and a static dashboard.

## Structure

- `perth_property_data.csv`: main sold-property dataset
- `scripts/build_dashboard_data.py`: transforms CSV into dashboard JSON files
- `scripts/run_update.py`: entrypoint to refresh dashboard data
- `dashboard/`: static front-end (HTML/CSS/JS)
- `dashboard/data/`: generated JSON files used by the dashboard
- `data_schema.md`: column, type, and null-count documentation

## How To Update Data

```bash
python scripts/run_update.py
```

## How To Run Locally

```bash
python -m http.server 8000
```

Then open:

`http://localhost:8000/dashboard/`

## Current Features

- Main KPIs (records, median/average/P75/P95)
- Yearly median price trend
- Suburb table with quick filtering

## Suggested Next Steps

- Filters by year, property type, and price range
- Map with latitude/longitude points
- CSV/PNG export in the dashboard
