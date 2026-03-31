/** Keep in sync with scripts/build_dashboard_data.py MIN_PRICE_AUD. */
const MIN_PRICE_AUD = 100_000;

function rowMeetsPriceFloor(row) {
  const p = Number(row.Price);
  return Number.isFinite(p) && p >= MIN_PRICE_AUD;
}

/** Drop bad or sub-threshold rows so charts/tables never use them (defense if JSON was edited). */
function filterListingsByPriceFloor(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const kept = arr.filter(rowMeetsPriceFloor);
  if (kept.length < arr.length) {
    console.warn(
      `[perth-property] Dropped ${arr.length - kept.length} listing(s): require numeric Price >= ${MIN_PRICE_AUD.toLocaleString("en-AU")} AUD (same rule as build_dashboard_data.py).`
    );
  }
  return kept;
}

const currency = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const numberFmt = new Intl.NumberFormat("en-AU");
const distanceKmFmt = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let summaryStats = null;
let listingsCore = [];
let listingsLatest = [];
let schoolPoints = [];
/** Map normalized suburb -> { avgPct: number, count: number } from property_annual_return_intervals.json */
let suburbAnnualGrowthBySuburb = new Map();
let yearlyChart;
let suburbDistributionChart;
let map;
let listingsLayer;
let suburbPriceLayer;
let schoolLayer;
let ptOverlayGroup = null;
let ptLoadPromise = null;
let suburbSelectControl = null;
let selectedFilters = {
  suburb: "",
  bedrooms: "",
  bathrooms: "",
  minPrice: null,
  maxPrice: null,
  year: "",
  /** houseKey from listingsCore; when set, yearly chart shows that property's sale history */
  chartHouseKey: "",
  /** when set (e.g. global search / map on a listing), KPIs/tables/map only include this property */
  filterHouseKey: "",
  /** cross-filter from table clicks; affects charts/map/KPIs, not table rows */
  interactionSuburb: "",
  /** cross-filter from table clicks; affects charts/map/KPIs, not table rows */
  interactionHouseKey: "",
};
let currentSuburbTableSort = { key: "count", dir: "desc" };
let currentPropertyTableSort = { key: "count", dir: "desc" };
let salesTableView = "suburbs";
/** Slider “full range” max; set in init after data load */
let dashboardDefaultMaxPrice = null;
const PROPERTY_TABLE_PAGE_SIZE = 100;
let propertyTablePage = 1;
let lastPropertyPagerContext = null;
let propertyFallbackGrowthPct = NaN;

function propertyPagerContextKey() {
  return JSON.stringify({
    suburb: selectedFilters.suburb,
    bedrooms: selectedFilters.bedrooms,
    bathrooms: selectedFilters.bathrooms,
    minPrice: selectedFilters.minPrice,
    maxPrice: selectedFilters.maxPrice,
    year: selectedFilters.year,
    filterHouseKey: selectedFilters.filterHouseKey,
    sortKey: currentPropertyTableSort.key,
    sortDir: currentPropertyTableSort.dir,
  });
}

function applyTableInteractionToRows(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  if (selectedFilters.interactionHouseKey) {
    return arr.filter((row) => houseKey(row) === selectedFilters.interactionHouseKey);
  }
  if (selectedFilters.interactionSuburb) {
    return arr.filter((row) => normalizeSuburbName(row.Suburb) === selectedFilters.interactionSuburb);
  }
  return arr;
}

function setTableInteractionSuburb(suburb) {
  const normalized = normalizeSuburbName(suburb || "");
  const same = !selectedFilters.interactionHouseKey && selectedFilters.interactionSuburb === normalized;
  selectedFilters.interactionHouseKey = "";
  selectedFilters.interactionSuburb = same ? "" : normalized;
  applyFilters();
}

function setTableInteractionProperty(propertyKey) {
  const key = String(propertyKey || "");
  if (!key) return;
  const same = selectedFilters.interactionHouseKey && selectedFilters.interactionHouseKey === key;
  selectedFilters.interactionSuburb = "";
  selectedFilters.interactionHouseKey = same ? "" : key;
  applyFilters();
}
let currentSuburbView = "table";
let distributionAxisTooltipEl = null;
const suburbBandPlugin = {
  id: "suburbBandPlugin",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const y = scales.y;
    if (!y || !chartArea) return;
    const totalRows = Math.max(0, Math.floor(y.max - y.min + 1));
    if (!totalRows) return;
    ctx.save();
    ctx.fillStyle = "#f3f4f6";
    for (let i = 0; i < totalRows; i += 1) {
      const top = y.getPixelForValue(i + 0.46);
      const bottom = y.getPixelForValue(i - 0.46);
      const yStart = Math.min(top, bottom);
      const height = Math.abs(bottom - top);
      ctx.fillRect(chartArea.left, yStart, chartArea.right - chartArea.left, height);
    }
    ctx.restore();
  },
};

function registerBoxPlotPlugin() {
  if (typeof Chart === "undefined" || typeof Chart.register !== "function") return;
  const lib = window.ChartBoxPlot || window.ChartBoxAndViolinPlot || window["chartjs-chart-box-and-violin-plot"] || null;
  if (!lib) return;
  const maybeDefault = lib.default || null;
  const parts = [
    lib.BoxPlotController,
    lib.BoxAndWiskers,
    lib.BoxAndWhiskers,
    lib.ViolinController,
    lib.Violin,
    lib.ArrayLinearScale,
    lib.ArrayLogarithmicScale,
    lib.PointAndWiskers,
    ...(Array.isArray(lib.registerables) ? lib.registerables : []),
    ...(Array.isArray(maybeDefault?.registerables) ? maybeDefault.registerables : []),
    maybeDefault?.BoxPlotController,
    maybeDefault?.BoxAndWhiskers,
    maybeDefault?.ViolinController,
    maybeDefault?.Violin,
    maybeDefault?.ArrayLinearScale,
    maybeDefault?.ArrayLogarithmicScale,
  ].filter(Boolean);
  if (parts.length) Chart.register(...parts);
}

function isBoxPlotRegistered() {
  try {
    if (!Chart?.registry?.controllers) return false;
    return Boolean(Chart.registry.controllers.get("boxplot"));
  } catch (_err) {
    return false;
  }
}

function ensureDistributionAxisTooltip() {
  if (distributionAxisTooltipEl) return distributionAxisTooltipEl;
  const wrap = document.getElementById("suburbDistributionWrap");
  if (!wrap) return null;
  const el = document.createElement("div");
  el.className = "distribution-axis-tooltip";
  wrap.appendChild(el);
  distributionAxisTooltipEl = el;
  return distributionAxisTooltipEl;
}

function normalizeSuburbName(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  return raw
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function canonicalSuburbKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function canonicalAddressKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function distinctBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  items.forEach((item, index) => {
    const key = keyFn(item, index);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

function houseKey(row) {
  const latKey = Number.isFinite(row.Latitude) ? row.Latitude.toFixed(7) : "";
  const lonKey = Number.isFinite(row.Longitude) ? row.Longitude.toFixed(7) : "";
  if (latKey && lonKey) return `geo:${latKey}|${lonKey}`;
  if (Number.isFinite(row.Listing_ID)) return `listing:${row.Listing_ID}`;
  return `listing-fallback:${String(row.Address || "").trim().toLowerCase()}|${String(row.Suburb || "")
    .trim()
    .toLowerCase()}`;
}

/** YYYY-MM-DD for grouping (aligns with Python dt.normalize() on sale dates). */
function calendarDateKeyFromSold(dateSold) {
  const s = String(dateSold ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function calendarDaysBetweenKeys(keyA, keyB) {
  const [y0, m0, d0] = keyA.split("-").map(Number);
  const [y1, m1, d1] = keyB.split("-").map(Number);
  const u0 = Date.UTC(y0, m0 - 1, d0);
  const u1 = Date.UTC(y1, m1 - 1, d1);
  return Math.round((u1 - u0) / 86400000);
}

/** Same calendar day + same price collapsed; same day + different prices → keep MAX price (one row). */
function collapseSalesSamePropertyDay(rows) {
  const valid = rows.filter((r) => Number.isFinite(r.Price) && r.Price > 0);
  const byDay = new Map();
  for (const r of valid) {
    const dk = calendarDateKeyFromSold(r.Date_Sold);
    if (!dk) continue;
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(r);
  }
  const kept = [];
  const sortedDays = [...byDay.keys()].sort();
  for (const dk of sortedDays) {
    const dayRows = byDay.get(dk);
    const maxP = Math.max(...dayRows.map((x) => x.Price));
    const atMax = dayRows.filter((x) => x.Price === maxP);
    atMax.sort((a, b) => (Number(a.Listing_ID) || 0) - (Number(b.Listing_ID) || 0));
    kept.push(atMax[0]);
  }
  return kept;
}

/** Skip very short holds: CAGR explodes when years is small. */
const MIN_HOLDING_YEARS_FOR_CAGR = 1;
/** As decimal CAGR; above this is excluded (data errors, non-comparable sales). Display caps at same. */
const MAX_ANNUAL_CAGR_RATIO = 1;
const GROWTH_DISPLAY_CAP_ABS_PCT = MAX_ANNUAL_CAGR_RATIO * 100;

/** Never show resale growth outside ±100%/yr (guards bad JSON, cached bundles, or double-scaled values). */
function clampResaleGrowthPercent(pct) {
  if (!Number.isFinite(pct)) return NaN;
  const c = GROWTH_DISPLAY_CAP_ABS_PCT;
  return Math.min(c, Math.max(-c, pct));
}

/**
 * Illustrative 2y forward median: compound (1+r)² — not “2× the %”.
 * Conservative: r = half of displayed annual growth %, then clamp r to ±PROJECTION_MAX_ANNUAL_RATE for the formula only.
 */
const PROJECTION_HORIZON_YEARS = 2;
const PROJECTION_CONSERVATIVE_GROWTH_FRACTION = 0.5;
const PROJECTION_MAX_ANNUAL_RATE = 0.06;
const PROJECTION_MIN_ANNUAL_RATE = -0.06;

function conservativeProjectedMedianPrice(medianPrice, growthPctAnnual) {
  if (!Number.isFinite(medianPrice) || medianPrice <= 0) return NaN;
  if (!Number.isFinite(growthPctAnnual)) return NaN;
  let r = (growthPctAnnual / 100) * PROJECTION_CONSERVATIVE_GROWTH_FRACTION;
  r = Math.min(PROJECTION_MAX_ANNUAL_RATE, Math.max(PROJECTION_MIN_ANNUAL_RATE, r));
  return medianPrice * (1 + r) ** PROJECTION_HORIZON_YEARS;
}

function sanitizeSuburbGrowthMap(map) {
  const out = new Map();
  const cap = GROWTH_DISPLAY_CAP_ABS_PCT;
  for (const [sub, v] of map) {
    if (!v || typeof v !== "object") continue;
    const raw = Number(v.avgPct);
    out.set(sub, {
      avgPct: Number.isFinite(raw) ? Math.min(cap, Math.max(-cap, raw)) : NaN,
      count: Number(v.count) || 0,
      yearCount: Number.isFinite(v.yearCount) ? v.yearCount : 0,
    });
  }
  return out;
}

/** Consecutive sale pairs after collapse; annual_return = (price/prev)^(1/years)-1, years = days/365.25 */
function resaleIntervalReturnsForHouse(rowsSameHouse) {
  const collapsed = collapseSalesSamePropertyDay(rowsSameHouse);
  const out = [];
  for (let i = 1; i < collapsed.length; i++) {
    const prev = collapsed[i - 1];
    const cur = collapsed[i];
    const k0 = calendarDateKeyFromSold(prev.Date_Sold);
    const k1 = calendarDateKeyFromSold(cur.Date_Sold);
    const days = calendarDaysBetweenKeys(k0, k1);
    const years = days / 365.25;
    const prevPrice = Number(prev.Price);
    const price = Number(cur.Price);
    if (
      years < MIN_HOLDING_YEARS_FOR_CAGR ||
      !Number.isFinite(prevPrice) ||
      !Number.isFinite(price) ||
      prevPrice < MIN_PRICE_AUD ||
      price < MIN_PRICE_AUD
    ) {
      continue;
    }
    const annualReturn = (price / prevPrice) ** (1 / years) - 1;
    if (!Number.isFinite(annualReturn) || annualReturn > MAX_ANNUAL_CAGR_RATIO) continue;
    const endYear = Number.parseInt(k1.slice(0, 4), 10);
    if (!Number.isFinite(endYear)) continue;
    out.push({
      annual_return: annualReturn,
      suburb: normalizeSuburbName(cur.Suburb),
      endYear,
    });
  }
  return out;
}

/**
 * Per suburb: for each calendar year (later sale year), arithmetic mean CAGR among eligible intervals;
 * headline value = mean of those yearly means (not a sum of simple % moves — each point is already CAGR).
 * Omits CAGR above MAX_ANNUAL_CAGR_RATIO (100%/yr).
 */
function aggregateSuburbGrowthFromIntervalRecords(records) {
  const bySuburbYear = new Map();
  for (const iv of records) {
    if (
      !iv?.suburb ||
      !Number.isFinite(iv.annual_return) ||
      iv.annual_return > MAX_ANNUAL_CAGR_RATIO ||
      !Number.isFinite(iv.endYear)
    ) {
      continue;
    }
    const key = `${iv.suburb}|${iv.endYear}`;
    if (!bySuburbYear.has(key)) bySuburbYear.set(key, []);
    bySuburbYear.get(key).push(iv.annual_return);
  }
  const suburbToYearMeans = new Map();
  const suburbToIntervalCount = new Map();
  for (const [key, returns] of bySuburbYear) {
    if (!returns.length) continue;
    const pipe = key.lastIndexOf("|");
    const sub = key.slice(0, pipe);
    const yMean = mean(returns);
    if (!Number.isFinite(yMean)) continue;
    if (!suburbToYearMeans.has(sub)) {
      suburbToYearMeans.set(sub, []);
      suburbToIntervalCount.set(sub, 0);
    }
    suburbToYearMeans.get(sub).push(yMean);
    suburbToIntervalCount.set(sub, suburbToIntervalCount.get(sub) + returns.length);
  }
  const capPct = MAX_ANNUAL_CAGR_RATIO * 100;
  const out = new Map();
  for (const [sub, yearMeans] of suburbToYearMeans) {
    if (!yearMeans.length) continue;
    const overallMean = mean(yearMeans);
    if (!Number.isFinite(overallMean)) continue;
    const pct = overallMean * 100;
    out.set(sub, {
      avgPct: Math.min(Math.max(pct, -capPct), capPct),
      count: suburbToIntervalCount.get(sub) || 0,
      yearCount: yearMeans.length,
    });
  }
  return out;
}

/** Suburb growth from full listings core (same rules as optional intervals JSON when regenerated). */
function buildSuburbAnnualGrowthMapFromCore(coreRows) {
  const byHouse = new Map();
  for (const row of coreRows) {
    const k = houseKey(row);
    if (!k) continue;
    if (!byHouse.has(k)) byHouse.set(k, []);
    byHouse.get(k).push(row);
  }
  const flat = [];
  for (const [, hRows] of byHouse) {
    flat.push(...resaleIntervalReturnsForHouse(hRows));
  }
  return aggregateSuburbGrowthFromIntervalRecords(flat);
}

const KPI_ASSET_BASE = "./assets";
const KPI_ASSET_VER = "4";

/** Left column: icon(s) scaled to card height, filenames in dashboard/assets. */
function kpiIconCellHtml(iconFiles) {
  const list = Array.isArray(iconFiles) ? iconFiles : iconFiles ? [iconFiles] : [];
  if (!list.length) return "";
  const imgs = list
    .map(
      (f) =>
        `<img class="kpi-card__icon" src="${KPI_ASSET_BASE}/${f}?v=${KPI_ASSET_VER}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
    )
    .join("");
  return `<div class="kpi-card__icon-cell" aria-hidden="true">${imgs}</div>`;
}

function kpiCardShell(bodyHtml, iconFiles) {
  const cell = kpiIconCellHtml(iconFiles);
  if (!cell) return bodyHtml;
  return `${cell}<div class="kpi-card__body">${bodyHtml}</div>`;
}

function makeKpiCard(label, value, iconFiles) {
  const div = document.createElement("div");
  div.className = "kpi-card";
  const body = `<h3>${escapeHtml(label)}</h3><p>${value}</p>`;
  div.innerHTML = kpiCardShell(body, iconFiles);
  return div;
}

/** Median prediction price as main figure; median resale growth % below in same style as Average Price (kpi-variation). */
function makeKpiGrowthPredictionCard(pctValue, predValue) {
  const growthTip =
    "Median of suburb Avg resale growth (%) for listings matching current filters — same rules as the sales tables.";
  const predTip =
    "Median of suburb prediction current price (same formula as tables) for listings matching current filters.";
  const meta = getVariationMeta(pctValue);
  const div = document.createElement("div");
  div.className = "kpi-card";
  div.innerHTML = kpiCardShell(
    `<h3>${escapeHtml("Current median prediction price")}</h3><p title="${escapeHtml(predTip)}">${asCurrencyOrNA(predValue)}</p>`,
    "growth.png"
  );
  const sub = document.createElement("div");
  sub.className = `kpi-variation ${meta.cls}`;
  sub.textContent = `${meta.arrow} ${meta.text} median growth`;
  sub.title = growthTip;
  (div.querySelector(".kpi-card__body") || div).appendChild(sub);
  return div;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * 0.5);
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return NaN;
  let s = 0;
  for (const x of values) {
    if (!Number.isFinite(x)) return NaN;
    s += x;
  }
  return s / values.length;
}

/**
 * Same stabilization as suburb Growth: mean of yearly mean CAGRs on this property’s resale intervals
 * (later sale year; hold ≥1y; omit CAGR >100%/yr). N/A if fewer than 2 sales or no eligible intervals.
 */
function propertyStabilizedAnnualGrowth(houseRows) {
  const intervals = resaleIntervalReturnsForHouse(houseRows);
  const byYear = new Map();
  for (const iv of intervals) {
    const y = iv.endYear;
    const r = iv.annual_return;
    if (!Number.isFinite(y) || !Number.isFinite(r) || r > MAX_ANNUAL_CAGR_RATIO) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const yearMeans = [];
  let intervalCount = 0;
  for (const [, returns] of byYear) {
    if (!returns.length) continue;
    const m = mean(returns);
    if (!Number.isFinite(m)) continue;
    yearMeans.push(m);
    intervalCount += returns.length;
  }
  if (!yearMeans.length) {
    return { avgPct: NaN, intervalN: 0, yearCount: 0 };
  }
  const overall = mean(yearMeans);
  const capPct = MAX_ANNUAL_CAGR_RATIO * 100;
  const rawPct = Number.isFinite(overall) ? overall * 100 : NaN;
  return {
    avgPct: Number.isFinite(rawPct) ? Math.min(Math.max(rawPct, -capPct), capPct) : NaN,
    intervalN: intervalCount,
    yearCount: yearMeans.length,
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function asPricePerSqm(value) {
  if (!Number.isFinite(value) || value <= 0) return "N/A";
  return currency.format(value);
}

function asCurrencyOrNA(value) {
  if (!Number.isFinite(value) || value <= 0) return "N/A";
  return currency.format(value);
}

function formatSignedPercent(value) {
  const rounded = Math.round(value * 10) / 10;
  const abs = Math.abs(rounded);
  const absText = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  if (rounded > 0) return `+${absText}%`;
  if (rounded < 0) return `-${absText}%`;
  return "0%";
}

function buildSuburbAnnualGrowthMap(intervals) {
  const flat = [];
  for (const row of intervals) {
    const years = row.years;
    if (
      !Number.isFinite(row.annual_return) ||
      row.annual_return > MAX_ANNUAL_CAGR_RATIO ||
      !Number.isFinite(years) ||
      years < MIN_HOLDING_YEARS_FOR_CAGR
    ) {
      continue;
    }
    const prevP = row.prev_price;
    const saleP = row.price;
    if (!Number.isFinite(prevP) || !Number.isFinite(saleP) || prevP < MIN_PRICE_AUD || saleP < MIN_PRICE_AUD) {
      continue;
    }
    const sub = normalizeSuburbName(row.Suburb);
    if (!sub) continue;
    const ds = String(row.date_sold || "");
    const endYear = Number.parseInt(ds.slice(0, 4), 10);
    if (!Number.isFinite(endYear)) continue;
    flat.push({ suburb: sub, annual_return: row.annual_return, endYear });
  }
  return aggregateSuburbGrowthFromIntervalRecords(flat);
}

function getVariationMeta(value) {
  if (!Number.isFinite(value)) {
    return { text: "N/A", arrow: "•", cls: "variation-na" };
  }
  if (value > 0) {
    return { text: formatSignedPercent(value), arrow: "▲", cls: "variation-positive" };
  }
  if (value < 0) {
    return { text: formatSignedPercent(value), arrow: "▼", cls: "variation-negative" };
  }
  return { text: "0%", arrow: "■", cls: "variation-neutral" };
}

function attachKpiVariation(cardEl, variationPct) {
  const meta = getVariationMeta(variationPct);
  const div = document.createElement("div");
  div.className = `kpi-variation ${meta.cls}`;
  div.textContent = `${meta.arrow} ${meta.text} vs prev year`;
  (cardEl.querySelector(".kpi-card__body") || cardEl).appendChild(div);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return "N/A";
  if (meters < 1000) return `${numberFmt.format(Math.round(meters))} m`;
  return `${distanceKmFmt.format(meters / 1000)} km`;
}

function formatCountOrDash(value) {
  return Number.isFinite(value) ? numberFmt.format(value) : "—";
}

function formatLandSizeOrDash(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${numberFmt.format(Math.round(value))} m²`;
}

function calcMonthsSince(dateText) {
  const t = Date.parse(String(dateText || ""));
  if (!Number.isFinite(t)) return NaN;
  const d = new Date(t);
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  return Math.max(0, months);
}

function predictCurrentPriceFromLastSale(lastPrice, annualGrowthPct, lastDateSold) {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return NaN;
  if (!Number.isFinite(annualGrowthPct)) return NaN;
  const months = calcMonthsSince(lastDateSold);
  if (!Number.isFinite(months)) return NaN;
  const annualRate = annualGrowthPct / 100;
  const projected = lastPrice * (1 + annualRate * (months / 12));
  return Number.isFinite(projected) && projected > 0 ? projected : NaN;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderKpis(summary, filteredRows) {
  const kpis = document.getElementById("kpis");
  const footnote = document.getElementById("kpiFootnote");
  kpis.innerHTML = "";

  const prices = filteredRows.map((r) => r.Price).filter((v) => Number.isFinite(v));
  const pricePerSqm = filteredRows
    .filter((r) => Number.isFinite(r.Price) && Number.isFinite(r.Land_Size) && r.Land_Size > 0)
    .map((r) => r.Price / r.Land_Size);

  const medianPrice = median(prices);
  const mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : NaN;
  const p75 = percentile(prices, 0.75);
  const p95 = percentile(prices, 0.95);
  const medianPsm = median(pricePerSqm);

  const yearly = new Map();
  filteredRows.forEach((r) => {
    if (!Number.isFinite(r.Year)) return;
    const cur = yearly.get(r.Year) || { prices: [], psm: [] };
    if (Number.isFinite(r.Price)) cur.prices.push(r.Price);
    if (Number.isFinite(r.Price) && Number.isFinite(r.Land_Size) && r.Land_Size > 0) {
      cur.psm.push(r.Price / r.Land_Size);
    }
    yearly.set(r.Year, cur);
  });
  const years = [...yearly.keys()].sort((a, b) => a - b);
  let medianYoY = NaN;
  let avgYoY = NaN;
  let m2YoY = NaN;
  if (years.length >= 2) {
    const last = yearly.get(years[years.length - 1]);
    const prev = yearly.get(years[years.length - 2]);
    const lastMedian = median(last?.prices || []);
    const prevMedian = median(prev?.prices || []);
    const lastAvg = (last?.prices || []).length
      ? (last.prices || []).reduce((a, b) => a + b, 0) / last.prices.length
      : NaN;
    const prevAvg = (prev?.prices || []).length
      ? (prev.prices || []).reduce((a, b) => a + b, 0) / prev.prices.length
      : NaN;
    const lastM2 = median(last?.psm || []);
    const prevM2 = median(prev?.psm || []);
    if (Number.isFinite(prevMedian) && prevMedian > 0 && Number.isFinite(lastMedian)) {
      medianYoY = ((lastMedian - prevMedian) / prevMedian) * 100;
    }
    if (Number.isFinite(prevAvg) && prevAvg > 0 && Number.isFinite(lastAvg)) {
      avgYoY = ((lastAvg - prevAvg) / prevAvg) * 100;
    }
    if (Number.isFinite(prevM2) && prevM2 > 0 && Number.isFinite(lastM2)) {
      m2YoY = ((lastM2 - prevM2) / prevM2) * 100;
    }
  }

  kpis.appendChild(makeKpiCard("Properties", numberFmt.format(filteredRows.length), "property.png"));

  const medianCard = makeKpiCard("Median Price", asCurrencyOrNA(medianPrice), "property_price.png");
  attachKpiVariation(medianCard, medianYoY);
  kpis.appendChild(medianCard);

  const suburbAgg = aggregateSuburbStats(filteredRows);
  const growthForMed = suburbAgg.map((s) => s.avg_annual_growth_pct).filter((v) => Number.isFinite(v));
  const kpiMedGrowth = growthForMed.length ? median(growthForMed) : NaN;
  const predForMed = suburbAgg.map((s) => s.prediction_price_2y).filter((v) => Number.isFinite(v));
  const kpiMedPred = predForMed.length ? median(predForMed) : NaN;
  kpis.appendChild(makeKpiGrowthPredictionCard(kpiMedGrowth, kpiMedPred));

  const m2Card = makeKpiCard("Median Price M²", asPricePerSqm(medianPsm), "M2price.png");
  attachKpiVariation(m2Card, m2YoY);
  kpis.appendChild(m2Card);

  const avgCard = makeKpiCard("Average Price", asCurrencyOrNA(mean), "avg.png");
  attachKpiVariation(avgCard, avgYoY);
  kpis.appendChild(avgCard);

  kpis.appendChild(makeKpiCard("P75", asCurrencyOrNA(p75), "average.png"));
  kpis.appendChild(makeKpiCard("P95", asCurrencyOrNA(p95), "prediction.png"));
  footnote.textContent = `Date range: ${summary.date_min} to ${summary.date_max}`;
}

function renderSuburbOptions() {
  const select = document.getElementById("suburbSelect");
  select.innerHTML = '<option value="">All</option>';
  const grouped = aggregateSuburbStats(listingsLatest);
  for (const row of grouped) {
    const opt = document.createElement("option");
    opt.value = row.Suburb;
    opt.textContent = `${row.Suburb} (${row.count})`;
    select.appendChild(opt);
  }
}

function renderBedroomBathroomOptions() {
  const bedSelect = document.getElementById("bedroomSelect");
  const bathSelect = document.getElementById("bathroomSelect");
  const beds = [...new Set(listingsLatest.map((r) => r.Bedrooms))].filter(Number.isFinite).sort((a, b) => a - b);
  const baths = [...new Set(listingsLatest.map((r) => r.Bathrooms))].filter(Number.isFinite).sort((a, b) => a - b);
  bedSelect.innerHTML = '<option value="">Any</option>';
  bathSelect.innerHTML = '<option value="">Any</option>';
  beds.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v);
    bedSelect.appendChild(opt);
  });
  baths.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v);
    bathSelect.appendChild(opt);
  });
}

function aggregateSuburbStats(rows) {
  const mapBySuburb = new Map();
  const suburbSaleEvents = new Map();
  rows.forEach((row) => {
    if (!row.Suburb) return;
    const current = mapBySuburb.get(row.Suburb) || {
      Suburb: row.Suburb,
      count: 0,
      prices: [],
      psmValues: [],
      yearPrices: new Map(),
      sumDistance: 0,
      distanceCount: 0,
      sumLat: 0,
      sumLon: 0,
      geoCount: 0,
    };
    current.count += 1;
    current.prices.push(row.Price);
    if (Number.isFinite(row.Year) && Number.isFinite(row.Price)) {
      const bucket = current.yearPrices.get(row.Year) || [];
      bucket.push(row.Price);
      current.yearPrices.set(row.Year, bucket);
    }
    if (Number.isFinite(row.Price) && Number.isFinite(row.Land_Size) && row.Land_Size > 0) {
      current.psmValues.push(row.Price / row.Land_Size);
    }
    if (Number.isFinite(row.Distance_to_CBD)) {
      current.sumDistance += row.Distance_to_CBD;
      current.distanceCount += 1;
    }
    if (Number.isFinite(row.Latitude) && Number.isFinite(row.Longitude)) {
      current.sumLat += row.Latitude;
      current.sumLon += row.Longitude;
      current.geoCount += 1;
    }
    mapBySuburb.set(row.Suburb, current);
    if (!suburbSaleEvents.has(row.Suburb)) suburbSaleEvents.set(row.Suburb, new Map());
    const byHouse = suburbSaleEvents.get(row.Suburb);
    const hk = houseKey(row);
    if (!byHouse.has(hk)) byHouse.set(hk, []);
    byHouse.get(hk).push(row);
  });
  return [...mapBySuburb.values()]
    .map((v) => {
      const sorted = v.prices.sort((a, b) => a - b);
      const psmSorted = v.psmValues.sort((a, b) => a - b);
      const mid = Math.floor((sorted.length - 1) * 0.5);
      const psmMid = Math.floor((psmSorted.length - 1) * 0.5);
      const years = [...v.yearPrices.keys()].sort((a, b) => a - b);
      let variationPct = NaN;
      let latestYear = null;
      let previousYear = null;
      let latestMedianPrice = NaN;
      let previousMedianPrice = NaN;
      if (years.length >= 2) {
        latestYear = years[years.length - 1];
        previousYear = years[years.length - 2];
        latestMedianPrice = median(v.yearPrices.get(latestYear) || []);
        previousMedianPrice = median(v.yearPrices.get(previousYear) || []);
        if (Number.isFinite(previousMedianPrice) && previousMedianPrice > 0 && Number.isFinite(latestMedianPrice)) {
          variationPct = ((latestMedianPrice - previousMedianPrice) / previousMedianPrice) * 100;
        }
      }
      const growthInfo = suburbAnnualGrowthBySuburb.get(v.Suburb);
      const growthCapPct = MAX_ANNUAL_CAGR_RATIO * 100;
      const rawGrowthPct = growthInfo && Number.isFinite(growthInfo.avgPct) ? growthInfo.avgPct : NaN;
      const avgAnnualGrowthPct = Number.isFinite(rawGrowthPct)
        ? Math.min(Math.max(rawGrowthPct, -growthCapPct), growthCapPct)
        : NaN;
      const annualGrowthIntervalN = growthInfo ? growthInfo.count : 0;
      const annualGrowthYearCount = growthInfo && Number.isFinite(growthInfo.yearCount) ? growthInfo.yearCount : 0;
      const medianPriceVal = sorted[mid] ?? 0;
      const prediction_price_2y = conservativeProjectedMedianPrice(medianPriceVal, avgAnnualGrowthPct);
      let salesCount = v.count;
      const byHouse = suburbSaleEvents.get(v.Suburb);
      if (byHouse) {
        let dedupTotal = 0;
        for (const [, houseRows] of byHouse) {
          dedupTotal += collapseSalesSamePropertyDay(houseRows).length;
        }
        if (dedupTotal > 0) salesCount = dedupTotal;
      }
      return {
        Suburb: v.Suburb,
        count: salesCount,
        median_price: medianPriceVal,
        variation_pct: variationPct,
        avg_annual_growth_pct: avgAnnualGrowthPct,
        annual_growth_interval_n: annualGrowthIntervalN,
        annual_growth_year_count: annualGrowthYearCount,
        prediction_price_2y,
        highest_price: sorted.length ? sorted[sorted.length - 1] : 0,
        lowest_price: sorted.length ? sorted[0] : 0,
        avg_price: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        median_price_m2: psmSorted[psmMid] ?? 0,
        avg_price_per_sqm: psmSorted.length ? psmSorted.reduce((a, b) => a + b, 0) / psmSorted.length : 0,
        avg_distance_to_cbd: v.distanceCount ? v.sumDistance / v.distanceCount : 0,
        latitude: v.geoCount ? v.sumLat / v.geoCount : null,
        longitude: v.geoCount ? v.sumLon / v.geoCount : null,
        latest_year: latestYear,
        previous_year: previousYear,
        latest_median_price: latestMedianPrice,
        previous_median_price: previousMedianPrice,
      };
    })
    .sort((a, b) => b.count - a.count || b.median_price - a.median_price);
}

function aggregateAddressStats(rows) {
  const mapByKey = new Map();
  const soldDateMs = (row) => {
    const t = Date.parse(String(row.Date_Sold || ""));
    return Number.isFinite(t) ? t : -Infinity;
  };
  rows.forEach((row) => {
    const key = houseKey(row);
    if (!key) return;
    const addr = String(row.Address || "").trim() || "Address unavailable";
    const current = mapByKey.get(key) || {
      Address: addr,
      rawRows: [],
      count: 0,
      prices: [],
      psmValues: [],
      yearPrices: new Map(),
      sumDistance: 0,
      distanceCount: 0,
      sumLat: 0,
      sumLon: 0,
      geoCount: 0,
    };
    current.rawRows.push(row);
    current.count += 1;
    current.prices.push(row.Price);
    if (Number.isFinite(row.Year) && Number.isFinite(row.Price)) {
      const bucket = current.yearPrices.get(row.Year) || [];
      bucket.push(row.Price);
      current.yearPrices.set(row.Year, bucket);
    }
    if (Number.isFinite(row.Price) && Number.isFinite(row.Land_Size) && row.Land_Size > 0) {
      current.psmValues.push(row.Price / row.Land_Size);
    }
    if (Number.isFinite(row.Distance_to_CBD)) {
      current.sumDistance += row.Distance_to_CBD;
      current.distanceCount += 1;
    }
    if (Number.isFinite(row.Latitude) && Number.isFinite(row.Longitude)) {
      current.sumLat += row.Latitude;
      current.sumLon += row.Longitude;
      current.geoCount += 1;
    }
    mapByKey.set(key, current);
  });
  return [...mapByKey.entries()]
    .map(([propertyKey, v]) => {
      const sorted = v.prices.sort((a, b) => a - b);
      const psmSorted = v.psmValues.sort((a, b) => a - b);
      const mid = Math.floor((sorted.length - 1) * 0.5);
      const psmMid = Math.floor((psmSorted.length - 1) * 0.5);
      const years = [...v.yearPrices.keys()].sort((a, b) => a - b);
      let variationPct = NaN;
      let latestYear = null;
      let previousYear = null;
      let latestMedianPrice = NaN;
      let previousMedianPrice = NaN;
      if (years.length >= 2) {
        latestYear = years[years.length - 1];
        previousYear = years[years.length - 2];
        latestMedianPrice = median(v.yearPrices.get(latestYear) || []);
        previousMedianPrice = median(v.yearPrices.get(previousYear) || []);
        if (Number.isFinite(previousMedianPrice) && previousMedianPrice > 0 && Number.isFinite(latestMedianPrice)) {
          variationPct = ((latestMedianPrice - previousMedianPrice) / previousMedianPrice) * 100;
        }
      }
      let latestListing = null;
      for (const rr of v.rawRows) {
        if (!latestListing) {
          latestListing = rr;
          continue;
        }
        const a = soldDateMs(latestListing);
        const b = soldDateMs(rr);
        if (b > a) {
          latestListing = rr;
          continue;
        }
        if (b < a) continue;
        const aid = Number.isFinite(latestListing.Listing_ID) ? latestListing.Listing_ID : -Infinity;
        const bid = Number.isFinite(rr.Listing_ID) ? rr.Listing_ID : -Infinity;
        if (bid > aid) latestListing = rr;
      }
      const propGrowth = propertyStabilizedAnnualGrowth(v.rawRows);
      const uniqueSaleEvents = collapseSalesSamePropertyDay(v.rawRows);
      const salesCount = uniqueSaleEvents.length || v.count;
      const medianPriceVal = sorted[mid] ?? 0;
      const prediction_price_2y = conservativeProjectedMedianPrice(medianPriceVal, propGrowth.avgPct);
      return {
        property_key: propertyKey,
        Address: v.Address,
        count: salesCount,
        median_price: medianPriceVal,
        variation_pct: variationPct,
        avg_annual_growth_pct: propGrowth.avgPct,
        annual_growth_interval_n: propGrowth.intervalN,
        annual_growth_year_count: propGrowth.yearCount,
        prediction_price_2y,
        highest_price: sorted.length ? sorted[sorted.length - 1] : 0,
        lowest_price: sorted.length ? sorted[0] : 0,
        avg_price: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        median_price_m2: psmSorted[psmMid] ?? 0,
        avg_price_per_sqm: psmSorted.length ? psmSorted.reduce((a, b) => a + b, 0) / psmSorted.length : 0,
        avg_distance_to_cbd: v.distanceCount ? v.sumDistance / v.distanceCount : 0,
        latitude: v.geoCount ? v.sumLat / v.geoCount : null,
        longitude: v.geoCount ? v.sumLon / v.geoCount : null,
        latest_year: latestYear,
        previous_year: previousYear,
        latest_median_price: latestMedianPrice,
        previous_median_price: previousMedianPrice,
        latest_bedrooms: Number(latestListing?.Bedrooms),
        latest_bathrooms: Number(latestListing?.Bathrooms),
        latest_parking_spaces: Number(latestListing?.Parking_Spaces),
        latest_land_size: Number(latestListing?.Land_Size),
        latest_sale_price: Number(latestListing?.Price),
        latest_sale_date: String(latestListing?.Date_Sold || ""),
      };
    })
    .sort((a, b) => b.count - a.count || b.median_price - a.median_price);
}

function getFilteredCoreRows() {
  const y = selectedFilters.year;
  const hkLock = selectedFilters.filterHouseKey;
  return listingsCore.filter((row) => {
    if (!rowMeetsPriceFloor(row)) return false;
    const byHouse = !hkLock || houseKey(row) === hkLock;
    const suburb = normalizeSuburbName(row.Suburb);
    const bySuburb = !selectedFilters.suburb || suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    const rowByYear =
      y === "" || y === null || y === undefined
        ? true
        : Number.isFinite(Number(row.Year)) && Number(row.Year) === Number(y);
    return byHouse && bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice && rowByYear;
  });
}

function renderSuburbTable(rows) {
  const body = document.getElementById("suburbTableBody");
  body.innerHTML = "";
  const groupedAll = aggregateSuburbStats(rows);
  const { key, dir } = currentSuburbTableSort;
  const sorted = [...groupedAll].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv));
    }
    return (Number(av) || 0) - (Number(bv) || 0);
  });
  if (dir === "desc") sorted.reverse();
  const grouped = sorted.slice(0, selectedFilters.suburb ? 1 : sorted.length);
  for (const row of grouped) {
    const varMeta = getVariationMeta(row.variation_pct);
    const tooltipText =
      Number.isFinite(row.latest_median_price) && Number.isFinite(row.previous_median_price)
        ? `${row.previous_year}: ${currency.format(row.previous_median_price)} -> ${row.latest_year}: ${currency.format(
            row.latest_median_price
          )}`
        : "Not enough yearly history";
    const growthPct = clampResaleGrowthPercent(row.avg_annual_growth_pct);
    const growthMeta = getVariationMeta(growthPct);
    const growthTooltip =
      Number.isFinite(growthPct) && row.annual_growth_interval_n > 0
        ? `Mean of yearly mean CAGRs (later sale year; hold ≥${MIN_HOLDING_YEARS_FOR_CAGR} yr; omit CAGR >${MAX_ANNUAL_CAGR_RATIO * 100}%/yr; display capped at ±${GROWTH_DISPLAY_CAP_ABS_PCT}%). ${numberFmt.format(
            row.annual_growth_interval_n
          )} interval(s) across ${numberFmt.format(row.annual_growth_year_count)} calendar year(s) with data`
        : "No resale intervals with CAGR data for this suburb";
    const predTip =
      "Illustrative only (not advice): median × (1 + r)^2 over 2 years, r = half of Avg resale growth %, capped to ±6%/yr in the formula — not double the percentage.";
    const predText = Number.isFinite(row.prediction_price_2y) ? currency.format(row.prediction_price_2y) : "N/A";
    const tr = document.createElement("tr");
    const isActiveInteraction =
      !selectedFilters.interactionHouseKey && selectedFilters.interactionSuburb === row.Suburb;
    tr.setAttribute("data-suburb-focus", row.Suburb);
    tr.classList.toggle("table-row--active-filter", isActiveInteraction);
    tr.innerHTML = `
      <td>
        <button type="button" class="table-focus-btn" data-suburb-focus-btn="${escapeHtml(row.Suburb)}" title="Filter charts/map by this suburb">
          ${row.Suburb}
        </button>
      </td>
      <td>${numberFmt.format(row.count)}</td>
      <td>${currency.format(row.median_price)}</td>
      <td><span class="variation-badge ${varMeta.cls}" data-tooltip="${tooltipText}" title="${tooltipText}">${varMeta.arrow} ${varMeta.text}</span></td>
      <td><span class="variation-badge ${growthMeta.cls}" data-tooltip="${growthTooltip}" title="${growthTooltip}">${growthMeta.arrow} ${growthMeta.text}</span></td>
      <td title="${escapeHtml(predTip)}">${predText}</td>
      <td>${asPricePerSqm(row.median_price_m2)}</td>
      <td>${currency.format(row.highest_price)}</td>
      <td>${currency.format(row.lowest_price)}</td>
      <td>${formatDistance(row.avg_distance_to_cbd)}</td>
    `;
    tr.title = "Click to filter charts/map by this suburb (click again to clear)";
    tr.classList.add("table-row--clickable");
    body.appendChild(tr);
  }
}

function renderPropertyTable(coreRows) {
  const body = document.getElementById("propertyTableBody");
  if (!body) return;
  const pagerEl = document.getElementById("propertyTablePager");
  const pagerMeta = document.getElementById("propertyTablePagerMeta");
  const pagerPrev = document.getElementById("propertyTablePagerPrev");
  const pagerNext = document.getElementById("propertyTablePagerNext");
  body.innerHTML = "";
  const ctx = propertyPagerContextKey();
  if (ctx !== lastPropertyPagerContext) {
    propertyTablePage = 1;
    lastPropertyPagerContext = ctx;
  }
  const groupedAll = aggregateAddressStats(coreRows);
  const { key, dir } = currentPropertyTableSort;
  const sorted = [...groupedAll].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv));
    }
    return (Number(av) || 0) - (Number(bv) || 0);
  });
  if (dir === "desc") sorted.reverse();
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PROPERTY_TABLE_PAGE_SIZE));
  propertyTablePage = Math.min(Math.max(1, propertyTablePage), totalPages);
  const start = (propertyTablePage - 1) * PROPERTY_TABLE_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PROPERTY_TABLE_PAGE_SIZE);
  for (const row of pageRows) {
    const varMeta = getVariationMeta(row.variation_pct);
    const tooltipText =
      Number.isFinite(row.latest_median_price) && Number.isFinite(row.previous_median_price)
        ? `${row.previous_year}: ${currency.format(row.previous_median_price)} -> ${row.latest_year}: ${currency.format(
            row.latest_median_price
          )}`
        : "Not enough yearly history";
    const hasOwnGrowth = Number.isFinite(row.avg_annual_growth_pct);
    const growthSourcePct = hasOwnGrowth ? row.avg_annual_growth_pct : propertyFallbackGrowthPct;
    const growthPct = clampResaleGrowthPercent(growthSourcePct);
    const growthMeta = getVariationMeta(growthPct);
    const growthTooltip =
      Number.isFinite(growthPct) && hasOwnGrowth && row.annual_growth_interval_n > 0
        ? `Mean of yearly mean CAGRs for this property (same rules as suburb column; display capped at ±${GROWTH_DISPLAY_CAP_ABS_PCT}%). ${numberFmt.format(
            row.annual_growth_interval_n
          )} resale interval(s) across ${numberFmt.format(row.annual_growth_year_count)} calendar year(s)`
        : Number.isFinite(growthPct)
        ? `Fallback to general annual growth (${formatSignedPercent(growthPct)}) because this address has insufficient valid resale intervals`
        : "No eligible resale CAGR and no fallback growth available";
    const predictedCurrent = predictCurrentPriceFromLastSale(row.latest_sale_price, growthPct, row.latest_sale_date);
    const predTip =
      "Prediction Current Price = last sale price adjusted linearly by annual growth and elapsed months since last sale.";
    const predText = Number.isFinite(predictedCurrent) ? currency.format(predictedCurrent) : "N/A";
    const tr = document.createElement("tr");
    tr.setAttribute("data-property-focus", row.property_key);
    const isActiveInteraction = selectedFilters.interactionHouseKey && selectedFilters.interactionHouseKey === row.property_key;
    tr.classList.toggle("table-row--active-filter", isActiveInteraction);
    tr.innerHTML = `
      <td>
        <button type="button" class="table-focus-btn table-focus-btn--address" data-property-focus-btn="${escapeHtml(
          row.property_key
        )}" title="Filter charts/map by this property">
          ${escapeHtml(row.Address)}
        </button>
      </td>
      <td>
        <span class="table-physical-cell">
          <img class="table-physical-cell__icon" src="./assets/bed.png" alt="Beds" loading="lazy" decoding="async" />
          <span>${formatCountOrDash(row.latest_bedrooms)}</span>
        </span>
      </td>
      <td>
        <span class="table-physical-cell">
          <img class="table-physical-cell__icon" src="./assets/bath.png" alt="Baths" loading="lazy" decoding="async" />
          <span>${formatCountOrDash(row.latest_bathrooms)}</span>
        </span>
      </td>
      <td>
        <span class="table-physical-cell">
          <img class="table-physical-cell__icon" src="./assets/parking.png" alt="Parking" loading="lazy" decoding="async" />
          <span>${formatCountOrDash(row.latest_parking_spaces)}</span>
        </span>
      </td>
      <td>
        <span class="table-physical-cell">
          <img class="table-physical-cell__icon" src="./assets/land_size.png" alt="Land Size" loading="lazy" decoding="async" />
          <span>${formatLandSizeOrDash(row.latest_land_size)}</span>
        </span>
      </td>
      <td>${numberFmt.format(row.count)}</td>
      <td><span class="variation-badge ${varMeta.cls}" data-tooltip="${escapeHtml(tooltipText)}" title="${escapeHtml(tooltipText)}">${varMeta.arrow} ${varMeta.text}</span></td>
      <td><span class="variation-badge ${growthMeta.cls}" data-tooltip="${escapeHtml(growthTooltip)}" title="${escapeHtml(growthTooltip)}">${growthMeta.arrow} ${growthMeta.text}</span></td>
      <td title="${escapeHtml(predTip)}">${predText}</td>
      <td>${asPricePerSqm(row.median_price_m2)}</td>
      <td>${currency.format(row.highest_price)}</td>
      <td>${currency.format(row.lowest_price)}</td>
      <td>${formatDistance(row.avg_distance_to_cbd)}</td>
    `;
    tr.title = "Click to filter charts/map by this property (click again to clear)";
    tr.classList.add("table-row--clickable");
    body.appendChild(tr);
  }
  if (pagerEl && pagerMeta && pagerPrev && pagerNext) {
    const showPager = total > PROPERTY_TABLE_PAGE_SIZE;
    pagerEl.hidden = !showPager;
    if (showPager) {
      const from = total === 0 ? 0 : start + 1;
      const to = Math.min(start + PROPERTY_TABLE_PAGE_SIZE, total);
      pagerMeta.textContent = `${from}–${to} of ${numberFmt.format(total)} · page ${propertyTablePage}/${totalPages}`;
      pagerPrev.disabled = propertyTablePage <= 1;
      pagerNext.disabled = propertyTablePage >= totalPages;
    }
  }
}

function updateSuburbTableSortIndicators() {
  document.querySelectorAll("#suburbTableWrap th.sortable").forEach((header) => {
    const label = header.getAttribute("data-label") || "";
    const key = header.getAttribute("data-sort-key");
    if (key === currentSuburbTableSort.key) {
      const arrow = currentSuburbTableSort.dir === "asc" ? "▲" : "▼";
      header.textContent = `${label} ${arrow}`;
    } else {
      header.textContent = label;
    }
  });
}

function updatePropertyTableSortIndicators() {
  document.querySelectorAll("#propertyTableWrap th.sortable").forEach((header) => {
    const label = header.getAttribute("data-label") || "";
    const key = header.getAttribute("data-sort-key");
    if (key === currentPropertyTableSort.key) {
      const arrow = currentPropertyTableSort.dir === "asc" ? "▲" : "▼";
      header.textContent = `${label} ${arrow}`;
    } else {
      header.textContent = label;
    }
  });
}

function setSalesTableView(view) {
  salesTableView = view === "properties" ? "properties" : "suburbs";
  const propertyPanel = document.getElementById("propertyTablePanel");
  if (salesTableView === "properties") {
    propertyPanel?.classList.remove("hidden");
    document.getElementById("suburbTableWrap")?.classList.add("hidden");
    document.getElementById("suburbDistributionWrap")?.classList.add("hidden");
  } else {
    propertyPanel?.classList.add("hidden");
    updateSuburbViewUi();
  }
  document.querySelectorAll(".sales-title-tab").forEach((btn) => {
    const on = btn.dataset.tableView === salesTableView;
    btn.classList.toggle("sales-title-tab--active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  updateSuburbTableSortIndicators();
  updatePropertyTableSortIndicators();
}

function getRowsForYearlyChart() {
  const hk = selectedFilters.chartHouseKey || selectedFilters.filterHouseKey;
  if (hk) {
    return listingsCore.filter(
      (r) =>
        houseKey(r) === hk &&
        Number.isFinite(r.Year) &&
        rowMeetsPriceFloor(r)
    );
  }
  const baseRows = listingsLatest.filter((row) => {
    if (!rowMeetsPriceFloor(row)) return false;
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    return bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice;
  });
  return applyTableInteractionToRows(baseRows);
}

function yearlyChartDatasetLabel() {
  const hkFocus = selectedFilters.chartHouseKey || selectedFilters.filterHouseKey;
  if (!hkFocus) return "Median Price (AUD)";
  const row = listingsCore.find((r) => houseKey(r) === hkFocus);
  const addr = row ? String(row.Address || "").trim() : "";
  if (!addr) return "Property sale price (AUD)";
  const short = addr.length > 44 ? `${addr.slice(0, 42)}…` : addr;
  return `Price: ${short}`;
}

function getFilteredRows() {
  const rows = getFilteredRowsBase();
  return applyTableInteractionToRows(rows);
}

function getFilteredRowsBase() {
  const y = selectedFilters.year;
  const hkLock = selectedFilters.filterHouseKey;
  return listingsLatest.filter((row) => {
    if (!rowMeetsPriceFloor(row)) return false;
    const byHouse = !hkLock || houseKey(row) === hkLock;
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    const rowByYear =
      y === "" || y === null || y === undefined
        ? true
        : Number.isFinite(Number(row.Year)) && Number(row.Year) === Number(y);
    return byHouse && bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice && rowByYear;
  });
}

function getDistributionRows() {
  const y = selectedFilters.year;
  const hkLock = selectedFilters.filterHouseKey;
  const rows = listingsLatest.filter((row) => {
    if (!rowMeetsPriceFloor(row)) return false;
    const byHouse = !hkLock || houseKey(row) === hkLock;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    const rowByYear =
      y === "" || y === null || y === undefined
        ? true
        : Number.isFinite(Number(row.Year)) && Number(row.Year) === Number(y);
    return byHouse && byBeds && byBaths && byMinPrice && byMaxPrice && rowByYear;
  });
  return applyTableInteractionToRows(rows);
}

function setSuburbFilter(nextSuburb, applyNow = true) {
  selectedFilters.suburb = normalizeSuburbName(nextSuburb || "");
  if (!selectedFilters.suburb) {
    selectedFilters.filterHouseKey = "";
    selectedFilters.chartHouseKey = "";
  }
  if (suburbSelectControl) {
    const sel = suburbSelectControl;
    const v = selectedFilters.suburb;
    const hasOpt = [...sel.options].some((o) => o.value === v);
    if (hasOpt) {
      sel.value = v;
    } else if (v) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
      sel.value = v;
    } else {
      sel.value = "";
    }
  }
  if (applyNow) applyFilters();
}

/**
 * Map picks a suburb. Optional listingRow: if that property has 2+ sales in core data,
 * yearly chart switches to that address price history.
 */
function setSuburbFilterFromMap(suburb, options = {}) {
  const listingRow = options.listingRow;
  selectedFilters.year = "";
  if (listingRow) {
    const hk = houseKey(listingRow);
    selectedFilters.filterHouseKey = hk;
    const hist = listingsCore.filter(
      (r) => houseKey(r) === hk && Number.isFinite(r.Year) && rowMeetsPriceFloor(r)
    );
    selectedFilters.chartHouseKey = hist.length >= 2 ? hk : "";
  } else {
    selectedFilters.chartHouseKey = "";
    selectedFilters.filterHouseKey = "";
  }
  setSuburbFilter(suburb);
}

function buildLatestListings(rows) {
  const byProperty = new Map();
  const soldDateMs = (row) => {
    const t = Date.parse(String(row.Date_Sold || ""));
    return Number.isFinite(t) ? t : -Infinity;
  };
  rows.forEach((row) => {
    const key = houseKey(row);
    const current = byProperty.get(key);
    if (!current) {
      byProperty.set(key, row);
      return;
    }
    const curSold = soldDateMs(current);
    const nextSold = soldDateMs(row);
    if (nextSold > curSold) {
      byProperty.set(key, row);
      return;
    }
    if (nextSold < curSold) return;
    const curId = Number.isFinite(current.Listing_ID) ? current.Listing_ID : -Infinity;
    const nextId = Number.isFinite(row.Listing_ID) ? row.Listing_ID : -Infinity;
    if (nextId > curId) {
      byProperty.set(key, row);
    }
  });
  const latest = [...byProperty.values()];
  return distinctBy(latest, (row) => {
    const latKey = Number.isFinite(row.Latitude) ? row.Latitude.toFixed(7) : "";
    const lonKey = Number.isFinite(row.Longitude) ? row.Longitude.toFixed(7) : "";
    const priceKey = Number.isFinite(row.Price) ? String(row.Price) : "";
    const soldKey = String(row.Date_Sold || "");
    return `${latKey}|${lonKey}|${priceKey}|${soldKey}`;
  });
}

/** Always-on value labels for the yearly median / property chart only. */
const yearlyValueLabelsPlugin = {
  id: "yearlyValueLabels",
  afterDatasetsDraw(chart) {
    if (chart.canvas?.id !== "yearlyChart") return;
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.length || meta.hidden) return;
    const { ctx } = chart;
    const values = chart.data.datasets[0]?.data;
    if (!values?.length) return;
    ctx.save();
    ctx.font = "600 10px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "#1e293b";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const isBar = chart.config.type === "bar";
    meta.data.forEach((element, i) => {
      const v = values[i];
      if (!Number.isFinite(v)) return;
      const text = currency.format(v);
      if (isBar) {
        const x = element.x;
        const y = element.y;
        const base = element.base;
        if (!Number.isFinite(x)) return;
        const topY = Number.isFinite(y) && Number.isFinite(base) ? Math.min(y, base) : y;
        ctx.fillText(text, x, topY - 5);
      } else {
        const pos = typeof element.tooltipPosition === "function" ? element.tooltipPosition() : { x: element.x, y: element.y };
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
        ctx.fillText(text, pos.x, pos.y - 10);
      }
    });
    ctx.restore();
  },
};

function getYearlySeries(rows) {
  const yearMap = new Map();
  rows.forEach((r) => {
    if (!Number.isFinite(r.Year)) return;
    const values = yearMap.get(r.Year) || [];
    values.push(r.Price);
    yearMap.set(r.Year, values);
  });
  return [...yearMap.entries()]
    .map(([year, prices]) => {
      const sorted = prices.sort((a, b) => a - b);
      const idx = Math.floor((sorted.length - 1) * 0.5);
      return { Year: year, median_price: sorted[idx] ?? 0 };
    })
    .sort((a, b) => a.Year - b.Year);
}

function renderYearlyChart(chartType = "line", rows = [], activeYear = "") {
  const series = getYearlySeries(rows);
  const ctx = document.getElementById("yearlyChart");
  if (yearlyChart) yearlyChart.destroy();

  const activeNum =
    activeYear === "" || activeYear === null || activeYear === undefined ? NaN : Number(activeYear);
  const activeOk = Number.isFinite(activeNum);
  const isSelectedYear = (yr) => activeOk && Number(yr) === activeNum;

  const linePointBg = series.map((r) => (isSelectedYear(r.Year) ? "#ea580c" : "#60a5fa"));
  const linePointBorder = series.map((r) => (isSelectedYear(r.Year) ? "#c2410c" : "#1d4ed8"));
  const linePointR = series.map((r) => (isSelectedYear(r.Year) ? 7 : 4));
  const linePointHoverR = series.map((r) => (isSelectedYear(r.Year) ? 9 : 6));

  const barBg = series.map((r) =>
    isSelectedYear(r.Year) ? "rgba(234, 88, 12, 0.88)" : "rgba(59, 130, 246, 0.7)"
  );
  const barBorder = series.map((r) =>
    isSelectedYear(r.Year) ? "rgba(194, 65, 12, 0.95)" : "rgba(37, 99, 235, 0.9)"
  );

  yearlyChart = new Chart(ctx, {
    type: chartType,
    plugins: [yearlyValueLabelsPlugin],
    data: {
      labels: series.map((r) => r.Year),
      datasets: [
        {
          label: yearlyChartDatasetLabel(),
          data: series.map((r) => r.median_price),
          backgroundColor:
            chartType === "line" ? "rgba(59, 130, 246, 0.25)" : barBg,
          borderColor: chartType === "line" ? "#1d4ed8" : barBorder,
          borderWidth: chartType === "line" ? 2 : 1,
          pointRadius: chartType === "line" ? linePointR : 0,
          pointHoverRadius: chartType === "line" ? linePointHoverR : 0,
          pointBackgroundColor: chartType === "line" ? linePointBg : undefined,
          pointBorderColor: chartType === "line" ? linePointBorder : undefined,
          pointBorderWidth: 2,
          fill: chartType === "line",
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: chartType === "line" ? 22 : 16 },
      },
      interaction: {
        mode: "index",
        intersect: false,
      },
      onClick: (_evt, elements, chart) => {
        if (!elements?.length) return;
        selectedFilters.chartHouseKey = "";
        const idx = elements[0].index;
        const year = Number(chart.data.labels[idx]);
        if (!Number.isFinite(year)) return;
        const cur =
          selectedFilters.year === "" || selectedFilters.year === null || selectedFilters.year === undefined
            ? NaN
            : Number(selectedFilters.year);
        if (Number.isFinite(cur) && cur === year) {
          selectedFilters.year = "";
        } else {
          selectedFilters.year = year;
        }
        applyFilters();
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            usePointStyle: true,
            generateLabels(chart) {
              if (chart.config.type !== "line") {
                const gen = Chart?.defaults?.plugins?.legend?.labels?.generateLabels;
                if (typeof gen === "function") return gen(chart);
                const d = chart.data.datasets[0];
                const meta = chart.getDatasetMeta(0);
                const fill = typeof d.backgroundColor === "string" ? d.backgroundColor : "rgba(59, 130, 246, 0.7)";
                const stroke = typeof d.borderColor === "string" ? d.borderColor : "#1d4ed8";
                return [
                  {
                    text: d.label || "",
                    fillStyle: fill,
                    strokeStyle: stroke,
                    lineWidth: 1,
                    hidden: meta.hidden === true,
                    index: 0,
                    datasetIndex: 0,
                  },
                ];
              }
              const d = chart.data.datasets[0];
              const meta = chart.getDatasetMeta(0);
              const stroke = typeof d.borderColor === "string" ? d.borderColor : "#1d4ed8";
              return [
                {
                  text: d.label || "",
                  fillStyle: "transparent",
                  strokeStyle: stroke,
                  lineWidth: 2,
                  hidden: meta.hidden === true,
                  index: 0,
                  datasetIndex: 0,
                  pointStyle: "line",
                },
              ];
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#334155",
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
        },
        y: {
          ticks: {
            callback: (v) => currency.format(v),
          },
        },
      },
    },
  });
}

function updateSuburbViewUi() {
  const tableWrap = document.getElementById("suburbTableWrap");
  const distributionWrap = document.getElementById("suburbDistributionWrap");
  const toggleButtons = document.querySelectorAll("#suburbViewToggle .suburb-menu-item");
  if (salesTableView !== "suburbs") {
    if (tableWrap) tableWrap.classList.add("hidden");
    if (distributionWrap) distributionWrap.classList.add("hidden");
    toggleButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === currentSuburbView);
    });
    return;
  }
  const showTable = currentSuburbView === "table";
  if (tableWrap) tableWrap.classList.toggle("hidden", !showTable);
  if (distributionWrap) distributionWrap.classList.toggle("hidden", showTable);
  toggleButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === currentSuburbView);
  });
}

function renderSuburbDistribution(rows) {
  const plotEl = document.getElementById("suburbDistributionChart");
  const inner = document.getElementById("suburbDistributionInner");
  if (!plotEl) return;
  const houseRows = distinctBy(rows, (r) => houseKey(r));

  // Correct structure for boxplot: one numeric array per suburb.
  const grouped = {};
  houseRows.forEach((row) => {
    const suburb = normalizeSuburbName(row.Suburb);
    const price = Number(row.Price);
    if (!suburb || !Number.isFinite(price) || price < MIN_PRICE_AUD) return;
    if (!grouped[suburb]) grouped[suburb] = [];
    grouped[suburb].push(price); // push number, NOT [number]
  });

  const sorted = Object.entries(grouped)
    .filter(([, prices]) => prices.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sorted.map(([suburb]) => suburb);
  const values = sorted.map(([, prices]) => prices);
  const medianValues = values.map((prices) => median(prices));
  const minValues = values.map((prices) => Math.min(...prices));
  const maxValues = values.map((prices) => Math.max(...prices));
  if (inner) {
    inner.style.height = "420px";
    inner.style.width = "100%";
  }
  if (suburbDistributionChart?.__kind === "chartjs" && typeof suburbDistributionChart.destroy === "function") {
    suburbDistributionChart.destroy();
  }
  if (suburbDistributionChart?.__kind === "plotly" && window.Plotly?.purge) {
    window.Plotly.purge(plotEl);
  }
  if (distributionAxisTooltipEl) distributionAxisTooltipEl.style.display = "none";

  if (window.Plotly?.newPlot) {
    const boxTraces = labels.map((suburb, idx) => ({
      type: "box",
      name: suburb,
      y: values[idx],
      boxpoints: false,
      marker: { color: "rgba(59, 130, 246, 0.55)" },
      line: { color: "rgba(37, 99, 235, 0.95)", width: 1 },
      hovertemplate: `${suburb}<br>Price: %{y:$,.0f}<extra></extra>`,
    }));
    const medianTrace = {
      type: "scatter",
      mode: "lines+markers",
      name: "Median",
      x: labels,
      y: medianValues,
      line: { color: "rgba(30, 64, 175, 0.95)", width: 2 },
      marker: { size: 5, color: "rgba(30, 64, 175, 0.95)" },
      hovertemplate: "%{x}<br>Median: %{y:$,.0f}<extra></extra>",
    };

    window.Plotly.newPlot(plotEl, [...boxTraces, medianTrace], {
      margin: { l: 70, r: 16, t: 18, b: 130 },
      xaxis: {
        title: "Suburb",
        tickangle: -65,
        automargin: true,
        type: "category",
      },
      yaxis: {
        title: "Price (AUD)",
        tickformat: "$,.0f",
        automargin: true,
      },
      legend: { orientation: "h", y: 1.15 },
      showlegend: true,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
    }, {
      responsive: true,
      displaylogo: false,
    });
    suburbDistributionChart = { __kind: "plotly" };
    return;
  }

  const rangeValues = minValues.map((minV, idx) => [minV, maxValues[idx]]);
  const allPrices = values.flat();
  const globalMin = allPrices.length ? Math.min(...allPrices) : 0;
  const globalMax = allPrices.length ? Math.max(...allPrices) : 1;

  suburbDistributionChart = new Chart(plotEl, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Price Range (fallback)",
          data: rangeValues,
          backgroundColor: "rgba(59, 130, 246, 0.2)",
          borderColor: "rgba(37, 99, 235, 0.85)",
          borderWidth: 1,
          borderRadius: 2,
        },
        {
          type: "line",
          label: "Median",
          data: medianValues,
          borderColor: "rgba(30, 64, 175, 0.95)",
          backgroundColor: "rgba(30, 64, 175, 0.95)",
          borderWidth: 1,
          pointRadius: 1.8,
          pointHoverRadius: 2.2,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "x",
      plugins: { legend: { display: true } },
      scales: {
        x: {
          ticks: { autoSkip: false, color: "#334155", font: { size: 9 }, maxRotation: 65, minRotation: 65 },
          grid: { display: false },
          title: { display: true, text: "Suburb" },
        },
        y: {
          ticks: { callback: (v) => currency.format(v), color: "#334155" },
          beginAtZero: false,
          min: globalMin * 0.98,
          max: globalMax * 1.02,
          grid: { display: true, color: "rgba(148, 163, 184, 0.2)" },
          title: { display: true, text: "Price (AUD)" },
        },
      },
    },
  });
  suburbDistributionChart.__kind = "chartjs";
}

function hasActiveDataFilters() {
  if (selectedFilters.suburb) return true;
  if (selectedFilters.bedrooms) return true;
  if (selectedFilters.bathrooms) return true;
  if (selectedFilters.year !== "" && selectedFilters.year != null) return true;
  if (selectedFilters.filterHouseKey) return true;
  if (selectedFilters.chartHouseKey) return true;
  if (selectedFilters.interactionSuburb) return true;
  if (selectedFilters.interactionHouseKey) return true;
  if (Number(selectedFilters.minPrice) > 0) return true;
  if (
    dashboardDefaultMaxPrice != null &&
    Number.isFinite(selectedFilters.maxPrice) &&
    selectedFilters.maxPrice < dashboardDefaultMaxPrice
  ) {
    return true;
  }
  return false;
}

function getActiveFilterChipDescriptors() {
  const chips = [];
  if (selectedFilters.suburb) {
    chips.push({ id: "suburb", label: selectedFilters.suburb });
  }
  if (selectedFilters.bedrooms) {
    chips.push({ id: "bedrooms", label: `${selectedFilters.bedrooms} Beds` });
  }
  if (selectedFilters.bathrooms) {
    chips.push({ id: "bathrooms", label: `${selectedFilters.bathrooms} Baths` });
  }
  if (selectedFilters.year !== "" && selectedFilters.year != null) {
    chips.push({ id: "year", label: String(selectedFilters.year) });
  }
  const priceFiltered =
    Number(selectedFilters.minPrice) > 0 ||
    (dashboardDefaultMaxPrice != null &&
      Number.isFinite(selectedFilters.maxPrice) &&
      selectedFilters.maxPrice < dashboardDefaultMaxPrice);
  if (priceFiltered) {
    const pv = document.getElementById("priceRangeValue");
    chips.push({ id: "price", label: pv ? pv.textContent.trim() : "Price range" });
  }
  if (selectedFilters.filterHouseKey) {
    const row = listingsCore.find((r) => houseKey(r) === selectedFilters.filterHouseKey);
    const addr = row ? String(row.Address || "").trim() : "";
    const short = addr.length > 36 ? `${addr.slice(0, 34)}…` : addr || "Property";
    chips.push({ id: "filterHouse", label: short });
  } else if (selectedFilters.chartHouseKey) {
    const row = listingsCore.find((r) => houseKey(r) === selectedFilters.chartHouseKey);
    const addr = row ? String(row.Address || "").trim() : "";
    const short = addr.length > 36 ? `${addr.slice(0, 34)}…` : addr || "Property chart";
    chips.push({ id: "chartHouse", label: short });
  }
  if (selectedFilters.interactionHouseKey) {
    const row = listingsCore.find((r) => houseKey(r) === selectedFilters.interactionHouseKey);
    const addr = row ? String(row.Address || "").trim() : "";
    const short = addr.length > 36 ? `${addr.slice(0, 34)}…` : addr || "Property focus";
    chips.push({ id: "tableFocus", label: `Table focus: ${short}` });
  } else if (selectedFilters.interactionSuburb) {
    chips.push({ id: "tableFocus", label: `Table focus: ${selectedFilters.interactionSuburb}` });
  }
  return chips;
}

function clearFilterChip(chipId) {
  switch (chipId) {
    case "suburb":
      selectedFilters.chartHouseKey = "";
      selectedFilters.filterHouseKey = "";
      setSuburbFilter("", true);
      return;
    case "bedrooms":
      selectedFilters.bedrooms = "";
      document.getElementById("bedroomSelect").value = "";
      applyFilters();
      return;
    case "bathrooms":
      selectedFilters.bathrooms = "";
      document.getElementById("bathroomSelect").value = "";
      applyFilters();
      return;
    case "year":
      selectedFilters.year = "";
      applyFilters();
      return;
    case "filterHouse":
      selectedFilters.filterHouseKey = "";
      selectedFilters.chartHouseKey = "";
      applyFilters();
      return;
    case "chartHouse": {
      const hk = selectedFilters.chartHouseKey;
      selectedFilters.chartHouseKey = "";
      if (selectedFilters.filterHouseKey === hk) selectedFilters.filterHouseKey = "";
      applyFilters();
      return;
    }
    case "tableFocus":
      selectedFilters.interactionSuburb = "";
      selectedFilters.interactionHouseKey = "";
      applyFilters();
      return;
    case "price": {
      const defMax = dashboardDefaultMaxPrice;
      const minR = document.getElementById("minPriceRange");
      const maxR = document.getElementById("maxPriceRange");
      if (defMax != null && minR && maxR) {
        selectedFilters.minPrice = 0;
        selectedFilters.maxPrice = defMax;
        minR.value = "0";
        maxR.value = String(defMax);
        minR.dispatchEvent(new Event("input", { bubbles: true }));
        maxR.dispatchEvent(new Event("input", { bubbles: true }));
        minR.dispatchEvent(new Event("change", { bubbles: true }));
        maxR.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        selectedFilters.minPrice = 0;
        if (defMax != null) selectedFilters.maxPrice = defMax;
        applyFilters();
      }
      return;
    }
    default:
      return;
  }
}

function renderFilterChips() {
  const host = document.getElementById("filterActiveChips");
  if (!host) return;
  host.replaceChildren();
  for (const { id, label } of getActiveFilterChipDescriptors()) {
    const wrap = document.createElement("span");
    wrap.className = "filter-chip";
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className = "filter-chip__x";
    xBtn.setAttribute("data-chip-id", id);
    xBtn.setAttribute("aria-label", `Remove filter: ${label}`);
    xBtn.textContent = "×";
    const lab = document.createElement("span");
    lab.className = "filter-chip__label";
    lab.textContent = label;
    wrap.appendChild(xBtn);
    wrap.appendChild(lab);
    host.appendChild(wrap);
  }
}

function updateClearFiltersButtonHighlight() {
  document.getElementById("clearFiltersBtn")?.classList.toggle("clear-filters-btn--filtered", hasActiveDataFilters());
  renderFilterChips();
}

function applyFilters() {
  const filteredRows = getFilteredRows();
  const tableRows = getFilteredRowsBase();
  const tableCoreRows = getFilteredCoreRows();
  const fallbackCandidates = aggregateSuburbStats(filteredRows)
    .map((s) => s.avg_annual_growth_pct)
    .filter((v) => Number.isFinite(v));
  propertyFallbackGrowthPct = fallbackCandidates.length ? median(fallbackCandidates) : NaN;
  renderKpis(summaryStats, filteredRows);
  renderSuburbTable(tableRows);
  renderPropertyTable(tableCoreRows);
  updateSuburbViewUi();
  renderMap(filteredRows);
  const chartType = document.getElementById("chartTypeSelect").value;
  renderYearlyChart(chartType, getRowsForYearlyChart(), selectedFilters.year);
  updateSuburbTableSortIndicators();
  updatePropertyTableSortIndicators();
  updateClearFiltersButtonHighlight();
}

function radiusByPrice(avgPrice, minPrice, maxPrice) {
  if (maxPrice <= minPrice) return 10;
  const normalized = (avgPrice - minPrice) / (maxPrice - minPrice);
  return 6 + normalized * 22;
}

function colorByPrice(avgPrice, minPrice, maxPrice) {
  if (maxPrice <= minPrice) return "#2563eb";
  const normalized = (avgPrice - minPrice) / (maxPrice - minPrice);
  if (normalized < 0.2) return "#93c5fd";
  if (normalized < 0.4) return "#60a5fa";
  if (normalized < 0.6) return "#3b82f6";
  if (normalized < 0.8) return "#1d4ed8";
  return "#1e3a8a";
}

const listingTooltipOptions = { sticky: true, interactive: false };

function syncChartTypeSegmentControls() {
  const sel = document.getElementById("chartTypeSelect");
  if (!sel) return;
  const v = sel.value;
  document.querySelectorAll(".chart-type-segment__btn").forEach((btn) => {
    const on = btn.dataset.chartType === v;
    btn.classList.toggle("chart-type-segment__btn--active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function getMapLayerToggles() {
  return {
    suburbs: document.getElementById("mapLayerSuburbs")?.checked !== false,
    properties: Boolean(document.getElementById("mapLayerProperties")?.checked),
    schools: Boolean(document.getElementById("mapLayerSchools")?.checked),
    publicTransport: Boolean(document.getElementById("mapLayerPublicTransport")?.checked),
  };
}

function handleMapClickNearestListing(e) {
  const t = e.originalEvent?.target;
  if (t?.closest?.(".leaflet-control")) return;
  if (!getMapLayerToggles().properties) return;
  if (!listingsLayer || !map?.hasLayer(listingsLayer)) return;
  const clickPt = map.latLngToContainerPoint(e.latlng);
  const maxPx = 56;
  let bestRow = null;
  let bestD = Infinity;
  listingsLayer.eachLayer((ly) => {
    const row = ly._listingRow;
    if (!row) return;
    const ll = typeof ly.getLatLng === "function" ? ly.getLatLng() : null;
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return;
    const c = map.latLngToContainerPoint(ll);
    const d = clickPt.distanceTo(c);
    if (d < bestD) {
      bestD = d;
      bestRow = row;
    }
  });
  if (bestRow && bestD <= maxPx) setSuburbFilterFromMap(bestRow.Suburb, { listingRow: bestRow });
}

function ensureMapInteractionPanes() {
  if (!map) return;
  if (!map.getPane("suburbAvgPane")) {
    map.createPane("suburbAvgPane");
    map.getPane("suburbAvgPane").style.zIndex = "420";
  }
  if (!map.getPane("listingPointsPane")) {
    map.createPane("listingPointsPane");
    map.getPane("listingPointsPane").style.zIndex = "430";
  }
  if (!map.getPane("schoolMarkersPane")) {
    map.createPane("schoolMarkersPane");
    map.getPane("schoolMarkersPane").style.zIndex = "425";
  }
}

function renderMap(rows) {
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: false }).setView([-31.95, 115.86], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    map.createPane("publicTransportPane");
    const ptPane = map.getPane("publicTransportPane");
    if (ptPane) ptPane.style.zIndex = "350";
    map.on("click", handleMapClickNearestListing);
  }
  ensureMapInteractionPanes();

  if (listingsLayer) map.removeLayer(listingsLayer);
  if (suburbPriceLayer) map.removeLayer(suburbPriceLayer);
  if (schoolLayer) map.removeLayer(schoolLayer);

  const mapRows = rows.slice(0, 7000);
  const listingMarkers = mapRows.map((row) => {
    const marker = L.circleMarker([row.Latitude, row.Longitude], {
      pane: "listingPointsPane",
      radius: 11,
      color: "#ef4444",
      fillColor: "#ef4444",
      fillOpacity: 0.38,
      weight: 1,
    }    ).bindTooltip(
      `<b>${row.Address || "Address unavailable"}</b><br/>Suburb: ${row.Suburb}<br/>Beds: ${
        Number.isFinite(row.Bedrooms) ? numberFmt.format(row.Bedrooms) : "—"
      }<br/>Baths: ${
        Number.isFinite(row.Bathrooms) ? numberFmt.format(row.Bathrooms) : "—"
      }<br/>Price: ${currency.format(row.Price)}<br/>Distance to CBD: ${formatDistance(
        row.Distance_to_CBD
      )}<br/>Primary school distance: ${formatDistance(row.Primary_School_Distance)}<br/>Secondary school distance: ${formatDistance(
        row.Secondary_School_Distance
      )}`,
      listingTooltipOptions
    );
    marker._listingRow = row;
    marker.on("click", (ev) => {
      if (ev?.originalEvent) L.DomEvent.stop(ev.originalEvent);
      setSuburbFilterFromMap(row.Suburb, { listingRow: row });
    });
    return marker;
  });
  listingsLayer = L.layerGroup(listingMarkers);

  const filteredSuburb = aggregateSuburbStats(rows).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
  const prices = filteredSuburb.map((r) => r.avg_price);
  const hasSuburbMarkers = filteredSuburb.length > 0 && prices.length > 0;
  const minPrice = hasSuburbMarkers ? Math.min(...prices) : 0;
  const maxPrice = hasSuburbMarkers ? Math.max(...prices) : 1;
  suburbPriceLayer = L.layerGroup(
    hasSuburbMarkers
      ? filteredSuburb.map((row) => {
          const marker = L.circleMarker([row.latitude, row.longitude], {
            pane: "suburbAvgPane",
            radius: radiusByPrice(row.avg_price, minPrice, maxPrice),
            color: colorByPrice(row.avg_price, minPrice, maxPrice),
            fillColor: colorByPrice(row.avg_price, minPrice, maxPrice),
            fillOpacity: 0.25,
            weight: 2,
          }).bindTooltip(
            `<b>${row.Suburb}</b><br/>Average price: ${currency.format(row.avg_price)}<br/>Median price: ${currency.format(
              row.median_price
            )}<br/>Variation: ${getVariationMeta(row.variation_pct).arrow} ${getVariationMeta(row.variation_pct).text}<br/>Avg resale CAGR: ${(() => {
              const g = clampResaleGrowthPercent(row.avg_annual_growth_pct);
              if (!Number.isFinite(g)) return "N/A";
              const m = getVariationMeta(g);
              return `${m.arrow} ${m.text}`;
            })()}<br/>Prediction Current Price (2y, conservative): ${
              Number.isFinite(row.prediction_price_2y) ? currency.format(row.prediction_price_2y) : "N/A"
            }<br/>Median Price M²: ${asPricePerSqm(
              row.median_price_m2
            )}<br/>Highest: ${currency.format(
              row.highest_price
            )}<br/>Lowest: ${currency.format(row.lowest_price)}<br/>Sales: ${numberFmt.format(row.count)}`,
            listingTooltipOptions
          );
          marker.on("click", (ev) => {
            if (ev?.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
            setSuburbFilterFromMap(row.Suburb);
          });
          return marker;
        })
      : []
  );
  const schoolMarkers = schoolPoints
    .filter((s) => s.count >= 8)
    .map((s) =>
      L.circleMarker([s.latitude, s.longitude], {
        pane: "schoolMarkersPane",
        radius: 6,
        color: "#0f766e",
        fillColor: "#14b8a6",
        fillOpacity: 0.35,
        weight: 2,
      }).bindTooltip(
        `<b>${s.school_name}</b><br/>Estimated location<br/>Nearby listings: ${numberFmt.format(
          s.count
        )}<br/>Avg nearby price: ${currency.format(s.avg_price)}`,
        listingTooltipOptions
      )
    );
  schoolLayer = L.layerGroup(schoolMarkers);

  const ml = getMapLayerToggles();
  if (ml.properties) listingsLayer.addTo(map);
  if (ml.suburbs) suburbPriceLayer.addTo(map);
  if (ml.schools) schoolLayer.addTo(map);

  const boundsLayers = [];
  if (ml.properties) boundsLayers.push(...listingMarkers);
  if (ml.suburbs) {
    boundsLayers.push(...filteredSuburb.map((row) => L.marker([row.latitude, row.longitude])));
  }
  if (ml.schools) boundsLayers.push(...schoolMarkers);
  const boundsGroup = L.featureGroup(boundsLayers);
  if (boundsGroup.getLayers().length > 0) {
    map.fitBounds(boundsGroup.getBounds().pad(0.12));
  }

  const ptEl = document.getElementById("mapLayerPublicTransport");
  if (ptEl?.checked) {
    syncPublicTransportLayer().catch((err) => console.error(err));
  } else {
    removePublicTransportLayer();
  }
}

function removePublicTransportLayer() {
  if (ptOverlayGroup && map) map.removeLayer(ptOverlayGroup);
}

async function syncPublicTransportLayer() {
  if (!map) return;
  const ptToggle = document.getElementById("mapLayerPublicTransport");
  if (!ptToggle?.checked) {
    removePublicTransportLayer();
    return;
  }
  if (ptOverlayGroup && map.hasLayer(ptOverlayGroup)) return;

  if (!ptLoadPromise) {
    ptLoadPromise = Promise.all([
      loadJson("./data/public_transport_stops.geojson"),
      loadJson("./data/public_transport_routes.geojson"),
    ])
      .then(([stopsFc, routesFc]) => {
        const routesLayer = L.geoJSON(routesFc, {
          pane: "publicTransportPane",
          style: () => ({
            color: "#6d28d9",
            weight: 2,
            opacity: 0.45,
          }),
          onEachFeature(feature, layer) {
            const p = feature.properties || {};
            const name = escapeHtml(p.routename);
            const svc = escapeHtml(p.servicenam);
            const from = escapeHtml(p.departure);
            const to = escapeHtml(p.destinatio);
            layer.bindTooltip(`Route ${name} (${svc})<br/>${from} → ${to}`, { sticky: true });
          },
        });
        const stopsLayer = L.geoJSON(stopsFc, {
          pane: "publicTransportPane",
          pointToLayer(feature, latlng) {
            return L.circleMarker(latlng, {
              radius: 3,
              color: "#0f766e",
              fillColor: "#14b8a6",
              weight: 1,
              fillOpacity: 0.7,
            });
          },
          onEachFeature(feature, layer) {
            const p = feature.properties || {};
            const title = escapeHtml(p.stopname);
            const suburb = escapeHtml(p.suburb);
            const stype = escapeHtml(p.stoptype);
            layer.bindTooltip(`${title}<br/>${suburb} · ${stype}`, { sticky: true });
          },
        });
        ptOverlayGroup = L.layerGroup([routesLayer, stopsLayer]);
      })
      .catch((err) => {
        ptLoadPromise = null;
        throw err;
      });
  }

  try {
    await ptLoadPromise;
    if (ptToggle.checked && ptOverlayGroup && map && !map.hasLayer(ptOverlayGroup)) {
      ptOverlayGroup.addTo(map);
    }
  } catch (err) {
    console.error(err);
    ptToggle.checked = false;
    alert(
      "Could not load public transport layers. Generate dashboard files with: python scripts/build_public_transport_data.py"
    );
  }
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

function setupGlobalFilterSearch() {
  const container = document.getElementById("filterGlobalSearch");
  const input = document.getElementById("globalFilterSearchInput");
  const dropdown = document.getElementById("globalFilterSearchDropdown");
  if (!container || !input || !dropdown) return;

  const allSuburbsSorted = [...new Set(listingsLatest.map((r) => r.Suburb).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  let debounceT = null;
  const setExpanded = (open) => {
    input.setAttribute("aria-expanded", open ? "true" : "false");
    dropdown.hidden = !open;
  };

  const hide = () => {
    dropdown.replaceChildren();
    setExpanded(false);
  };

  const show = () => {
    setExpanded(true);
  };

  function runSearch() {
    const q = input.value.trim().toLowerCase();
    dropdown.replaceChildren();
    if (q.length < 2) {
      hide();
      return;
    }
    const maxSub = 10;
    const maxAddr = 10;
    const suburbs = allSuburbsSorted.filter((s) => s.toLowerCase().includes(q)).slice(0, maxSub);
    const addresses = [];
    const seenAddr = new Set();
    for (const row of listingsLatest) {
      if (addresses.length >= maxAddr) break;
      const addr = String(row.Address || "").trim();
      if (!addr || !addr.toLowerCase().includes(q)) continue;
      const dedupe = `${addr.toLowerCase()}|${String(row.Suburb || "")}`;
      if (seenAddr.has(dedupe)) continue;
      seenAddr.add(dedupe);
      addresses.push(row);
    }
    if (suburbs.length === 0 && addresses.length === 0) {
      const empty = document.createElement("div");
      empty.className = "filter-global-search__empty";
      empty.textContent = "No matches";
      dropdown.appendChild(empty);
      show();
      return;
    }
    if (suburbs.length) {
      const lab = document.createElement("div");
      lab.className = "filter-global-search__group-label";
      lab.textContent = "Suburbs";
      dropdown.appendChild(lab);
      for (const s of suburbs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "filter-global-search__opt filter-global-search__opt--suburb";
        btn.setAttribute("role", "option");
        btn.textContent = s;
        btn.addEventListener("click", () => {
          selectedFilters.chartHouseKey = "";
          selectedFilters.filterHouseKey = "";
          setSuburbFilter(s, true);
          input.value = "";
          hide();
        });
        dropdown.appendChild(btn);
      }
    }
    if (addresses.length) {
      const lab = document.createElement("div");
      lab.className = "filter-global-search__group-label";
      lab.textContent = "Addresses";
      dropdown.appendChild(lab);
      for (const row of addresses) {
        const addr = String(row.Address || "").trim();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "filter-global-search__opt";
        btn.setAttribute("role", "option");
        const main = document.createElement("span");
        main.className = "filter-global-search__addr-main";
        main.textContent = addr || "(Address)";
        const sub = document.createElement("span");
        sub.className = "filter-global-search__addr-sub";
        sub.textContent = row.Suburb ? ` · ${row.Suburb}` : "";
        btn.appendChild(main);
        btn.appendChild(sub);
        btn.addEventListener("click", () => {
          setSuburbFilterFromMap(row.Suburb, { listingRow: row });
          input.value = "";
          hide();
        });
        dropdown.appendChild(btn);
      }
    }
    show();
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(runSearch, 160);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) runSearch();
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) hide();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hide();
      input.blur();
    }
  });
}

async function init() {
  registerBoxPlotPlugin();
  const [summary, listings, schools] = await Promise.all([
    loadJson("./data/summary.json"),
    loadJson("./data/listings_core.json"),
    loadJson("./data/school_points_estimated.json"),
  ]);

  summaryStats = summary;
  listingsCore = filterListingsByPriceFloor(Array.isArray(listings) ? listings : []);
  listingsLatest = buildLatestListings(listingsCore);
  listingsLatest = distinctBy(listingsLatest, (row) => houseKey(row));
  listingsLatest = distinctBy(listingsLatest, (row) => {
    const addressKey = canonicalAddressKey(row.Address);
    const soldKey = String(row.Date_Sold || "");
    const priceKey = Number.isFinite(row.Price) ? String(row.Price) : "";
    return `${addressKey}|${soldKey}|${priceKey}`;
  });
  listingsLatest = listingsLatest.map((row) => ({
    ...row,
    Suburb: normalizeSuburbName(row.Suburb),
  }));
  schoolPoints = schools;

  suburbAnnualGrowthBySuburb = sanitizeSuburbGrowthMap(buildSuburbAnnualGrowthMapFromCore(listingsCore));
  try {
    const intervals = await loadJson("./data/property_annual_return_intervals.json");
    const fromFile = buildSuburbAnnualGrowthMap(Array.isArray(intervals) ? intervals : []);
    if (fromFile.size > 0) suburbAnnualGrowthBySuburb = sanitizeSuburbGrowthMap(fromFile);
  } catch {
    /* keep client-built map from listings_core */
  }

  renderSuburbOptions();
  renderBedroomBathroomOptions();
  setupGlobalFilterSearch();
  const minPriceRange = document.getElementById("minPriceRange");
  const maxPriceRange = document.getElementById("maxPriceRange");
  const priceRangeValue = document.getElementById("priceRangeValue");
  const priceDualRange = document.getElementById("priceDualRange");
  let dataMinPrice = Infinity;
  let dataMaxPrice = 0;
  for (const row of listingsLatest) {
    if (!Number.isFinite(row.Price)) continue;
    if (row.Price < dataMinPrice) dataMinPrice = row.Price;
    if (row.Price > dataMaxPrice) dataMaxPrice = row.Price;
  }
  if (!Number.isFinite(dataMinPrice)) dataMinPrice = 0;
  const maxAvailablePrice = dataMaxPrice;
  const safeMaxPrice = Math.max(10000, Math.ceil(maxAvailablePrice / 10000) * 10000);
  minPriceRange.max = String(safeMaxPrice);
  minPriceRange.min = "0";
  minPriceRange.step = "10000";
  minPriceRange.value = "0";
  maxPriceRange.max = String(safeMaxPrice);
  maxPriceRange.min = "0";
  maxPriceRange.step = "10000";
  maxPriceRange.value = String(safeMaxPrice);
  selectedFilters.minPrice = 0;
  selectedFilters.maxPrice = safeMaxPrice;
  dashboardDefaultMaxPrice = safeMaxPrice;
  let applyFiltersTimer = null;
  const scheduleApplyFilters = (delayMs = 140) => {
    if (applyFiltersTimer) clearTimeout(applyFiltersTimer);
    applyFiltersTimer = setTimeout(() => {
      applyFiltersTimer = null;
      applyFilters();
    }, delayMs);
  };
  const flushScheduledApply = () => {
    if (applyFiltersTimer) {
      clearTimeout(applyFiltersTimer);
      applyFiltersTimer = null;
    }
    applyFilters();
  };

  document.getElementById("filterActiveChips")?.addEventListener("click", (e) => {
    const t = e.target.closest(".filter-chip__x");
    if (!t) return;
    e.preventDefault();
    const id = t.getAttribute("data-chip-id");
    if (id) clearFilterChip(id);
  });

  applyFilters();

  const suburbSelect = document.getElementById("suburbSelect");
  suburbSelectControl = suburbSelect;
  const clearFiltersBtn = document.getElementById("clearFiltersBtn");
  suburbSelect.addEventListener("change", (e) => {
    selectedFilters.chartHouseKey = "";
    selectedFilters.filterHouseKey = "";
    setSuburbFilter(e.target.value || "");
  });
  const bedroomSelect = document.getElementById("bedroomSelect");
  bedroomSelect.addEventListener("change", (e) => {
    selectedFilters.filterHouseKey = "";
    selectedFilters.bedrooms = e.target.value || "";
    applyFilters();
  });
  const bathroomSelect = document.getElementById("bathroomSelect");
  bathroomSelect.addEventListener("change", (e) => {
    selectedFilters.filterHouseKey = "";
    selectedFilters.bathrooms = e.target.value || "";
    applyFilters();
  });
  const updatePriceRangeLabel = () => {
    const minValue = Number(minPriceRange.value);
    const maxValue = Number(maxPriceRange.value);
    const minText =
      minValue <= 0 ? currency.format(dataMinPrice) : currency.format(minValue);
    const maxText =
      maxValue >= safeMaxPrice ? currency.format(dataMaxPrice) : currency.format(maxValue);
    priceRangeValue.textContent = `${minText} - ${maxText}`;
  };
  const updatePriceRangeTrack = () => {
    if (!priceDualRange || safeMaxPrice <= 0) return;
    const minValue = Number(minPriceRange.value);
    const maxValue = Number(maxPriceRange.value);
    const minPct = (minValue / safeMaxPrice) * 100;
    const maxPct = (maxValue / safeMaxPrice) * 100;
    priceDualRange.style.setProperty("--min-pct", `${minPct}%`);
    priceDualRange.style.setProperty("--max-pct", `${maxPct}%`);
  };
  const resetFilters = () => {
    selectedFilters.suburb = "";
    selectedFilters.bedrooms = "";
    selectedFilters.bathrooms = "";
    selectedFilters.year = "";
    selectedFilters.chartHouseKey = "";
    selectedFilters.filterHouseKey = "";
    selectedFilters.interactionSuburb = "";
    selectedFilters.interactionHouseKey = "";
    selectedFilters.minPrice = 0;
    selectedFilters.maxPrice = safeMaxPrice;
    suburbSelect.value = "";
    bedroomSelect.value = "";
    bathroomSelect.value = "";
    minPriceRange.value = "0";
    maxPriceRange.value = String(safeMaxPrice);
    const gfs = document.getElementById("globalFilterSearchInput");
    const gfd = document.getElementById("globalFilterSearchDropdown");
    if (gfs) gfs.value = "";
    if (gfd) {
      gfd.replaceChildren();
      gfd.hidden = true;
    }
    if (gfs) gfs.setAttribute("aria-expanded", "false");
    updatePriceRangeLabel();
    updatePriceRangeTrack();
    flushScheduledApply();
  };
  minPriceRange.addEventListener("input", (e) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value)) return;
    const currentMax = Number(maxPriceRange.value);
    if (value > currentMax) {
      maxPriceRange.value = String(value);
    }
    selectedFilters.filterHouseKey = "";
    selectedFilters.minPrice = value;
    selectedFilters.maxPrice = Number(maxPriceRange.value);
    updatePriceRangeLabel();
    updatePriceRangeTrack();
    scheduleApplyFilters();
  });
  maxPriceRange.addEventListener("input", (e) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value)) return;
    const currentMin = Number(minPriceRange.value);
    if (value < currentMin) {
      minPriceRange.value = String(value);
    }
    selectedFilters.filterHouseKey = "";
    selectedFilters.minPrice = Number(minPriceRange.value);
    selectedFilters.maxPrice = value;
    updatePriceRangeLabel();
    updatePriceRangeTrack();
    scheduleApplyFilters();
  });
  minPriceRange.addEventListener("change", flushScheduledApply);
  maxPriceRange.addEventListener("change", flushScheduledApply);
  updatePriceRangeLabel();
  updatePriceRangeTrack();

  const chartTypeSelect = document.getElementById("chartTypeSelect");
  chartTypeSelect.addEventListener("change", () => {
    syncChartTypeSegmentControls();
    applyFilters();
  });
  document.querySelectorAll(".chart-type-segment__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.chartType;
      if (!t || chartTypeSelect.value === t) return;
      chartTypeSelect.value = t;
      chartTypeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  syncChartTypeSegmentControls();

  clearFiltersBtn?.addEventListener("click", resetFilters);
  ["mapLayerSuburbs", "mapLayerProperties", "mapLayerSchools", "mapLayerPublicTransport"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => applyFilters());
  });

  document.querySelectorAll("#suburbTableWrap th.sortable").forEach((cell) => {
    cell.addEventListener("click", () => {
      const nextKey = cell.getAttribute("data-sort-key");
      if (!nextKey) return;
      if (currentSuburbTableSort.key === nextKey) {
        currentSuburbTableSort.dir = currentSuburbTableSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentSuburbTableSort.key = nextKey;
        currentSuburbTableSort.dir = nextKey === "Suburb" ? "asc" : "desc";
      }
      updateSuburbTableSortIndicators();
      applyFilters();
    });
  });
  document.getElementById("suburbTableBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-suburb-focus-btn]");
    if (btn) {
      const suburbFromBtn = btn.getAttribute("data-suburb-focus-btn");
      setTableInteractionSuburb(suburbFromBtn);
      return;
    }
    const row = e.target.closest("tr[data-suburb-focus]");
    if (!row) return;
    const suburb = row.getAttribute("data-suburb-focus");
    setTableInteractionSuburb(suburb);
  });
  document.querySelectorAll("#propertyTableWrap th.sortable").forEach((cell) => {
    cell.addEventListener("click", () => {
      const nextKey = cell.getAttribute("data-sort-key");
      if (!nextKey) return;
      if (currentPropertyTableSort.key === nextKey) {
        currentPropertyTableSort.dir = currentPropertyTableSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentPropertyTableSort.key = nextKey;
        currentPropertyTableSort.dir = nextKey === "Address" ? "asc" : "desc";
      }
      updatePropertyTableSortIndicators();
      applyFilters();
    });
  });
  document.getElementById("propertyTableBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-property-focus-btn]");
    if (btn) {
      const keyFromBtn = btn.getAttribute("data-property-focus-btn");
      setTableInteractionProperty(keyFromBtn);
      return;
    }
    const row = e.target.closest("tr[data-property-focus]");
    if (!row) return;
    const key = row.getAttribute("data-property-focus");
    setTableInteractionProperty(key);
  });
  document.getElementById("propertyTablePagerPrev")?.addEventListener("click", () => {
    if (propertyTablePage <= 1) return;
    propertyTablePage -= 1;
    renderPropertyTable(getFilteredCoreRows());
    updatePropertyTableSortIndicators();
  });
  document.getElementById("propertyTablePagerNext")?.addEventListener("click", () => {
    propertyTablePage += 1;
    renderPropertyTable(getFilteredCoreRows());
    updatePropertyTableSortIndicators();
  });
  document.querySelectorAll(".sales-title-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.tableView;
      if (v) setSalesTableView(v);
    });
  });
  setSalesTableView("suburbs");

  const suburbViewToggle = document.getElementById("suburbViewToggle");
  suburbViewToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    currentSuburbView = btn.getAttribute("data-view") || "table";
    updateSuburbViewUi();
  });
  suburbViewToggle?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    e.preventDefault();
    currentSuburbView = btn.getAttribute("data-view") || "table";
    updateSuburbViewUi();
  });
}

init().catch((err) => {
  console.error(err);
  const runningFromFile = window.location.protocol === "file:";
  const tip = runningFromFile
    ? "Open via a local server (e.g., python -m http.server 8000) and access http://localhost:8000/dashboard/."
    : "Check whether JSON files in ./data/ are published and accessible.";
  alert(`Failed to load dashboard data. ${err?.message || ""} ${tip}`);
});
