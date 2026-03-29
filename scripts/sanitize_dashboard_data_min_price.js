/**
 * Drop listings in dashboard/data/listings_core.json with Price < MIN_PRICE_AUD
 * (same threshold as build_dashboard_data.py). Recomputes summary.json row count
 * and price stats from the kept rows. Use when CSV rebuild is not available.
 */
const fs = require("fs");
const path = require("path");

const MIN_PRICE_AUD = 100_000;
const ROOT = path.join(__dirname, "..");
const LISTINGS_PATH = path.join(ROOT, "dashboard", "data", "listings_core.json");
const SUMMARY_PATH = path.join(ROOT, "dashboard", "data", "summary.json");

function percentileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function medianSorted(sorted) {
  return percentileSorted(sorted, 0.5);
}

function main() {
  const raw = JSON.parse(fs.readFileSync(LISTINGS_PATH, "utf8"));
  const filtered = raw.filter((r) => {
    const p = Number(r.Price);
    return Number.isFinite(p) && p >= MIN_PRICE_AUD;
  });
  const removed = raw.length - filtered.length;
  if (removed > 0) {
    console.log(`Removed ${removed} row(s) with Price < ${MIN_PRICE_AUD.toLocaleString("en-AU")} AUD or invalid Price.`);
    fs.writeFileSync(LISTINGS_PATH, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
  } else {
    console.log("listings_core.json: no sub-threshold rows to remove.");
  }

  const prices = filtered.map((r) => Number(r.Price)).filter(Number.isFinite).sort((a, b) => a - b);
  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));
  summary.rows = filtered.length;
  summary.price_median = medianSorted(prices);
  summary.price_mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : NaN;
  summary.price_p75 = percentileSorted(prices, 0.75);
  summary.price_p95 = percentileSorted(prices, 0.95);

  const dates = filtered.map((r) => String(r.Date_Sold || "")).filter(Boolean).sort();
  if (dates.length) {
    summary.date_min = dates[0];
    summary.date_max = dates[dates.length - 1];
  }

  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log("Updated summary.json (rows, prices, dates).");
}

main();
