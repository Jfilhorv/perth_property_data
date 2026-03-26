![1774512290238](image/data_schema/1774512290238.png)![1774512296331](image/data_schema/1774512296331.png)![1774512298405](image/data_schema/1774512298405.png)![1774512311153](image/data_schema/1774512311153.png)![1774512392195](image/data_schema/1774512392195.png)# Perth Property Data - Schema

Source: `perth_property_data.csv`  
Total rows: `42958`

## Columns, Types, and Nulls

| column | dtype | null_count | null_pct | non_null_count | unique_count |
|---|---:|---:|---:|---:|---:|
| Listing_ID | int64 | 0 | 0.0000 | 42958 | 42958 |
| Price | int64 | 0 | 0.0000 | 42958 | 3041 |
| Agency_Name | str | 0 | 0.0000 | 42958 | 862 |
| Postcode | int64 | 0 | 0.0000 | 42958 | 72 |
| Address | str | 0 | 0.0000 | 42958 | 41531 |
| Suburb | str | 0 | 0.0000 | 42958 | 203 |
| Longitude | float64 | 0 | 0.0000 | 42958 | 32395 |
| Latitude | float64 | 0 | 0.0000 | 42958 | 33276 |
| Property_Type | str | 0 | 0.0000 | 42958 | 10 |
| Bedrooms | int64 | 0 | 0.0000 | 42958 | 9 |
| Bathrooms | int64 | 0 | 0.0000 | 42958 | 7 |
| Parking_Spaces | int64 | 0 | 0.0000 | 42958 | 13 |
| Date_Sold | str | 0 | 0.0000 | 42958 | 3664 |
| Land_Size | int64 | 0 | 0.0000 | 42958 | 1328 |
| Primary_School_Name | str | 0 | 0.0000 | 42958 | 344 |
| Primary_School_Distance | int64 | 0 | 0.0000 | 42958 | 2193 |
| Primary_School_ICSEA | int64 | 0 | 0.0000 | 42958 | 192 |
| Secondary_School_Name | str | 0 | 0.0000 | 42958 | 123 |
| Secondary_School_Distance | int64 | 0 | 0.0000 | 42958 | 3748 |
| Secondary_School_ICSEA | int64 | 0 | 0.0000 | 42958 | 96 |
| Distance_to_CBD | int64 | 0 | 0.0000 | 42958 | 15606 |

## Notes

- There are no null values in any column.
- `Date_Sold` is stored as text in the CSV (`str`); for time-series analysis, convert it to datetime with `dayfirst=True`.
