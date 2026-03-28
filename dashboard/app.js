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
};
let currentTableSort = { key: "count", dir: "desc" };
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

function makeKpiCard(label, value) {
  const div = document.createElement("div");
  div.className = "kpi-card";
  div.innerHTML = `<h3>${label}</h3><p>${value}</p>`;
  return div;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * 0.5);
  return sorted[idx];
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
  cardEl.appendChild(div);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return "N/A";
  if (meters < 1000) return `${numberFmt.format(Math.round(meters))} m`;
  return `${distanceKmFmt.format(meters / 1000)} km`;
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

  kpis.appendChild(makeKpiCard("Records", numberFmt.format(filteredRows.length)));
  const medianCard = makeKpiCard("Median Price", asCurrencyOrNA(medianPrice));
  attachKpiVariation(medianCard, medianYoY);
  kpis.appendChild(medianCard);
  const avgCard = makeKpiCard("Average Price", asCurrencyOrNA(mean));
  attachKpiVariation(avgCard, avgYoY);
  kpis.appendChild(avgCard);
  const m2Card = makeKpiCard("Median Price M2", asPricePerSqm(medianPsm));
  attachKpiVariation(m2Card, m2YoY);
  kpis.appendChild(m2Card);
  kpis.appendChild(makeKpiCard("P75", asCurrencyOrNA(p75)));
  kpis.appendChild(makeKpiCard("P95", asCurrencyOrNA(p95)));
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
      return {
        Suburb: v.Suburb,
        count: v.count,
        median_price: sorted[mid] ?? 0,
        variation_pct: variationPct,
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

function renderSuburbTable(rows) {
  const body = document.getElementById("suburbTableBody");
  body.innerHTML = "";
  const groupedAll = aggregateSuburbStats(rows);
  const { key, dir } = currentTableSort;
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.Suburb}</td>
      <td>${numberFmt.format(row.count)}</td>
      <td>${currency.format(row.median_price)}</td>
      <td><span class="variation-badge ${varMeta.cls}" data-tooltip="${tooltipText}" title="${tooltipText}">${varMeta.arrow} ${varMeta.text}</span></td>
      <td>${asPricePerSqm(row.median_price_m2)}</td>
      <td>${currency.format(row.highest_price)}</td>
      <td>${currency.format(row.lowest_price)}</td>
      <td>${formatDistance(row.avg_distance_to_cbd)}</td>
    `;
    body.appendChild(tr);
  }
}

function updateSortIndicators() {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header) => {
    const label = header.getAttribute("data-label") || header.textContent || "";
    const key = header.getAttribute("data-sort-key");
    if (key === currentTableSort.key) {
      const arrow = currentTableSort.dir === "asc" ? "▲" : "▼";
      header.textContent = `${label} ${arrow}`;
    } else {
      header.textContent = label;
    }
  });
}

function getRowsForYearlyChart() {
  const hk = selectedFilters.chartHouseKey;
  if (hk) {
    return listingsCore.filter(
      (r) => houseKey(r) === hk && Number.isFinite(r.Year) && Number.isFinite(r.Price)
    );
  }
  return listingsLatest.filter((row) => {
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    return bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice;
  });
}

function yearlyChartDatasetLabel() {
  if (!selectedFilters.chartHouseKey) return "Median Price (AUD)";
  const row = listingsCore.find((r) => houseKey(r) === selectedFilters.chartHouseKey);
  const addr = row ? String(row.Address || "").trim() : "";
  if (!addr) return "Property sale price (AUD)";
  const short = addr.length > 44 ? `${addr.slice(0, 42)}…` : addr;
  return `Price: ${short}`;
}

function getFilteredRows() {
  const y = selectedFilters.year;
  return listingsLatest.filter((row) => {
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    const rowByYear =
      y === "" || y === null || y === undefined
        ? true
        : Number.isFinite(Number(row.Year)) && Number(row.Year) === Number(y);
    return bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice && rowByYear;
  });
}

function getDistributionRows() {
  const y = selectedFilters.year;
  return listingsLatest.filter((row) => {
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    const rowByYear =
      y === "" || y === null || y === undefined
        ? true
        : Number.isFinite(Number(row.Year)) && Number(row.Year) === Number(y);
    return byBeds && byBaths && byMinPrice && byMaxPrice && rowByYear;
  });
}

function setSuburbFilter(nextSuburb, applyNow = true) {
  selectedFilters.suburb = normalizeSuburbName(nextSuburb || "");
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
    const hist = listingsCore.filter(
      (r) => houseKey(r) === hk && Number.isFinite(r.Year) && Number.isFinite(r.Price)
    );
    selectedFilters.chartHouseKey = hist.length >= 2 ? hk : "";
  } else {
    selectedFilters.chartHouseKey = "";
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
        legend: { display: true },
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
    if (!suburb || !Number.isFinite(price) || price <= 0) return;
    if (!grouped[suburb]) grouped[suburb] = [];
    grouped[suburb].push(price); // push number, NOT [number]
  });

  // Mandatory debug from requested checklist.
  console.log("boxplot_grouped_by_suburb", grouped);

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

function applyFilters() {
  const filteredRows = getFilteredRows();
  renderKpis(summaryStats, filteredRows);
  renderSuburbTable(filteredRows);
  updateSuburbViewUi();
  renderMap(filteredRows);
  const chartType = document.getElementById("chartTypeSelect").value;
  renderYearlyChart(chartType, getRowsForYearlyChart(), selectedFilters.year);
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

function handleMapClickNearestListing(e) {
  const t = e.originalEvent?.target;
  if (t?.closest?.(".leaflet-control")) return;
  const mv = document.getElementById("mapViewSelect")?.value;
  if (mv !== "listings" && mv !== "both") return;
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
    }).bindTooltip(
      `<b>${row.Address || "Address unavailable"}</b><br/>Suburb: ${row.Suburb}<br/>Price: ${currency.format(
        row.Price
      )}<br/>Distance to CBD: ${formatDistance(row.Distance_to_CBD)}<br/>Primary school distance: ${formatDistance(
        row.Primary_School_Distance
      )}<br/>Secondary school distance: ${formatDistance(row.Secondary_School_Distance)}`,
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
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  suburbPriceLayer = L.layerGroup(
    filteredSuburb.map((row) => {
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
        )}<br/>Variation: ${getVariationMeta(row.variation_pct).arrow} ${getVariationMeta(row.variation_pct).text}<br/>Median Price M2: ${asPricePerSqm(
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

  const mapView = document.getElementById("mapViewSelect").value;
  if (mapView === "both" || mapView === "listings") {
    listingsLayer.addTo(map);
  }
  if (mapView === "both" || mapView === "suburb") {
    suburbPriceLayer.addTo(map);
  }
  if (mapView === "schools") {
    schoolLayer.addTo(map);
  }

  const group = L.featureGroup([...listingMarkers, ...filteredSuburb.map((row) => L.marker([row.latitude, row.longitude]))]);
  if (group.getLayers().length > 0) {
    map.fitBounds(group.getBounds().pad(0.12));
  }

  const ptToggle = document.getElementById("publicTransportToggle");
  if (ptToggle?.checked) {
    syncPublicTransportLayer().catch((err) => console.error(err));
  }
}

function removePublicTransportLayer() {
  if (ptOverlayGroup && map) map.removeLayer(ptOverlayGroup);
}

async function syncPublicTransportLayer() {
  if (!map) return;
  const ptToggle = document.getElementById("publicTransportToggle");
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

async function init() {
  registerBoxPlotPlugin();
  const [summary, listings, schools] = await Promise.all([
    loadJson("./data/summary.json"),
    loadJson("./data/listings_core.json"),
    loadJson("./data/school_points_estimated.json"),
  ]);

  summaryStats = summary;
  listingsCore = listings;
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

  renderSuburbOptions();
  renderBedroomBathroomOptions();
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
  applyFilters();

  const suburbSelect = document.getElementById("suburbSelect");
  suburbSelectControl = suburbSelect;
  const clearFiltersBtn = document.getElementById("clearFiltersBtn");
  suburbSelect.addEventListener("change", (e) => {
    selectedFilters.chartHouseKey = "";
    setSuburbFilter(e.target.value || "");
  });
  const bedroomSelect = document.getElementById("bedroomSelect");
  bedroomSelect.addEventListener("change", (e) => {
    selectedFilters.bedrooms = e.target.value || "";
    applyFilters();
  });
  const bathroomSelect = document.getElementById("bathroomSelect");
  bathroomSelect.addEventListener("change", (e) => {
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
    selectedFilters.minPrice = 0;
    selectedFilters.maxPrice = safeMaxPrice;
    suburbSelect.value = "";
    bedroomSelect.value = "";
    bathroomSelect.value = "";
    minPriceRange.value = "0";
    maxPriceRange.value = String(safeMaxPrice);
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
  chartTypeSelect.addEventListener("change", () => applyFilters());

  const mapViewSelect = document.getElementById("mapViewSelect");
  mapViewSelect.addEventListener("change", () => {
    applyFilters();
  });
  clearFiltersBtn?.addEventListener("click", resetFilters);
  document.getElementById("publicTransportToggle")?.addEventListener("change", (e) => {
    if (e.target.checked) syncPublicTransportLayer();
    else removePublicTransportLayer();
  });

  const headerCells = document.querySelectorAll("th.sortable");
  headerCells.forEach((cell) => {
    cell.addEventListener("click", () => {
      const nextKey = cell.getAttribute("data-sort-key");
      if (!nextKey) return;
      if (currentTableSort.key === nextKey) {
        currentTableSort.dir = currentTableSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentTableSort.key = nextKey;
        currentTableSort.dir = nextKey === "Suburb" ? "asc" : "desc";
      }
      updateSortIndicators();
      applyFilters();
    });
  });
  updateSortIndicators();

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
