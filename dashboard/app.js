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
let selectedFilters = {
  suburb: "",
  bedrooms: "",
  bathrooms: "",
  minPrice: null,
  maxPrice: null,
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

function getFilteredRows() {
  return listingsLatest.filter((row) => {
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    return bySuburb && byBeds && byBaths && byMinPrice && byMaxPrice;
  });
}

function getDistributionRows() {
  return listingsLatest.filter((row) => {
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    const byMinPrice = !Number.isFinite(selectedFilters.minPrice) || row.Price >= selectedFilters.minPrice;
    const byMaxPrice = !Number.isFinite(selectedFilters.maxPrice) || row.Price <= selectedFilters.maxPrice;
    return byBeds && byBaths && byMinPrice && byMaxPrice;
  });
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

function renderYearlyChart(chartType = "line", rows = []) {
  const series = getYearlySeries(rows);
  const ctx = document.getElementById("yearlyChart");
  if (yearlyChart) yearlyChart.destroy();

  yearlyChart = new Chart(ctx, {
    type: chartType,
    data: {
      labels: series.map((r) => r.Year),
      datasets: [
        {
          label: "Median Price (AUD)",
          data: series.map((r) => r.median_price),
          borderColor: "#1d4ed8",
          backgroundColor: chartType === "line" ? "rgba(59, 130, 246, 0.25)" : "rgba(59, 130, 246, 0.7)",
          pointRadius: chartType === "line" ? 4 : 0,
          pointHoverRadius: chartType === "line" ? 6 : 0,
          pointBackgroundColor: "#60a5fa",
          pointBorderColor: "#1d4ed8",
          pointBorderWidth: 2,
          fill: chartType === "line",
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
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
  tableWrap.classList.toggle("hidden", !showTable);
  distributionWrap.classList.toggle("hidden", showTable);
  toggleButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === currentSuburbView);
  });
}

function renderSuburbDistribution(rows) {
  const canvas = document.getElementById("suburbDistributionChart");
  const inner = document.getElementById("suburbDistributionInner");
  if (!canvas) return;
  const suburbLabelByKey = new Map();
  rows.forEach((r) => {
    const key = canonicalSuburbKey(r.Suburb);
    if (!key) return;
    if (!suburbLabelByKey.has(key)) {
      suburbLabelByKey.set(key, normalizeSuburbName(r.Suburb));
    }
  });
  const labels = [...suburbLabelByKey.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([, label]) => label);
  const suburbKeyToIndex = new Map(
    [...suburbLabelByKey.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([key], idx) => [key, idx])
  );
  const houseRows = distinctBy(rows, (r) => houseKey(r));
  const plotRows = houseRows
    .filter((r) => Number.isFinite(r.Price) && suburbKeyToIndex.has(canonicalSuburbKey(r.Suburb)))
    .map((r) => ({
      suburbs: normalizeSuburbName(r.Suburb),
      suburb_key: canonicalSuburbKey(r.Suburb),
      last_price: r.Price,
      house: houseKey(r),
    }));
  const points = plotRows.map((r) => ({
      x: r.last_price,
      y: suburbKeyToIndex.get(r.suburb_key),
    }));
  const rowsVisibleBeforeScroll = 12;
  const rowHeightPx = 30;
  const viewportHeight = rowsVisibleBeforeScroll * rowHeightPx;
  const dynamicHeight = Math.max(viewportHeight, labels.length * rowHeightPx);
  if (inner) inner.style.height = `${dynamicHeight}px`;
  if (suburbDistributionChart) suburbDistributionChart.destroy();
  suburbDistributionChart = new Chart(canvas, {
    plugins: [suburbBandPlugin],
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Properties",
          data: points,
          pointRadius: 0.85,
          pointHoverRadius: 1.5,
          backgroundColor: "rgba(59, 130, 246, 0.32)",
          borderColor: "rgba(59, 130, 246, 0)",
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (event, _activeElements, chartInstance) => {
        const tooltipEl = ensureDistributionAxisTooltip();
        if (!tooltipEl) return;
        const { chartArea, scales } = chartInstance;
        const xScale = scales?.x;
        if (!xScale || !chartArea) {
          tooltipEl.style.display = "none";
          return;
        }
        const x = event?.x;
        const y = event?.y;
        const withinArea =
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= chartArea.left &&
          x <= chartArea.right &&
          y >= chartArea.top &&
          y <= chartArea.bottom;
        if (!withinArea) {
          tooltipEl.style.display = "none";
          return;
        }
        const priceValue = xScale.getValueForPixel(x);
        if (!Number.isFinite(priceValue)) {
          tooltipEl.style.display = "none";
          return;
        }
        tooltipEl.textContent = currency.format(priceValue);
        tooltipEl.style.left = `${x}px`;
        tooltipEl.style.display = "inline-block";
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: { callback: (v) => currency.format(v), color: "#334155" },
          grid: {
            display: false,
            drawOnChartArea: false,
            drawTicks: false,
            drawBorder: true,
          },
          title: { display: true, text: "Price (AUD)" },
        },
        y: {
          min: -0.5,
          max: Math.max(labels.length - 0.5, 0.5),
          ticks: {
            callback: (value) => labels[Math.round(value)] || "",
            autoSkip: false,
            color: "#334155",
            font: { size: 9 },
          },
          grid: {
            display: false,
            drawBorder: true,
          },
          title: { display: true, text: "Suburb" },
        },
      },
    },
  });
  const tooltipEl = ensureDistributionAxisTooltip();
  if (tooltipEl) tooltipEl.style.display = "none";
}

function applyFilters() {
  const filteredRows = getFilteredRows();
  const distributionRows = getDistributionRows();
  renderKpis(summaryStats, filteredRows);
  renderSuburbTable(filteredRows);
  renderSuburbDistribution(distributionRows);
  updateSuburbViewUi();
  renderMap(filteredRows);
  const chartType = document.getElementById("chartTypeSelect").value;
  renderYearlyChart(chartType, filteredRows);
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

function renderMap(rows) {
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: false }).setView([-31.95, 115.86], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
  }

  if (listingsLayer) map.removeLayer(listingsLayer);
  if (suburbPriceLayer) map.removeLayer(suburbPriceLayer);
  if (schoolLayer) map.removeLayer(schoolLayer);

  const mapRows = rows.slice(0, 7000);
  const listingMarkers = mapRows.map((row) =>
    L.circleMarker([row.Latitude, row.Longitude], {
      radius: 3,
      color: "#ef4444",
      fillColor: "#ef4444",
      fillOpacity: 0.35,
      weight: 1,
    }).bindTooltip(
      `<b>${row.Address || "Address unavailable"}</b><br/>Suburb: ${row.Suburb}<br/>Price: ${currency.format(
        row.Price
      )}<br/>Distance to CBD: ${formatDistance(row.Distance_to_CBD)}<br/>Primary school distance: ${formatDistance(
        row.Primary_School_Distance
      )}<br/>Secondary school distance: ${formatDistance(row.Secondary_School_Distance)}`,
      { sticky: true }
    )
  );
  listingsLayer = L.layerGroup(listingMarkers);

  const filteredSuburb = aggregateSuburbStats(rows).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
  const prices = filteredSuburb.map((r) => r.avg_price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  suburbPriceLayer = L.layerGroup(
    filteredSuburb.map((row) =>
      L.circleMarker([row.latitude, row.longitude], {
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
        { sticky: true }
      )
    )
  );
  const schoolMarkers = schoolPoints
    .filter((s) => s.count >= 8)
    .map((s) =>
      L.circleMarker([s.latitude, s.longitude], {
        radius: 6,
        color: "#0f766e",
        fillColor: "#14b8a6",
        fillOpacity: 0.35,
        weight: 2,
      }).bindTooltip(
        `<b>${s.school_name}</b><br/>Estimated location<br/>Nearby listings: ${numberFmt.format(
          s.count
        )}<br/>Avg nearby price: ${currency.format(s.avg_price)}`,
        { sticky: true }
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
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

async function init() {
  const [summary, listings, schools] = await Promise.all([
    loadJson("./data/summary.json"),
    loadJson("./data/listings_core.json"),
    loadJson("./data/school_points_estimated.json"),
  ]);

  summaryStats = summary;
  listingsCore = listings;
  listingsLatest = buildLatestListings(listingsCore);
  listingsLatest = distinctBy(listingsLatest, (row) => houseKey(row));
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
  const maxAvailablePrice = listingsLatest.reduce(
    (max, row) => (Number.isFinite(row.Price) && row.Price > max ? row.Price : max),
    0
  );
  const safeMaxPrice = Math.ceil(maxAvailablePrice / 10000) * 10000;
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
  priceRangeValue.textContent = "Any";
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
  suburbSelect.addEventListener("change", (e) => {
    selectedFilters.suburb = e.target.value || "";
    applyFilters();
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
    const minText = minValue <= 0 ? "Any" : currency.format(minValue);
    const maxText = maxValue >= safeMaxPrice ? "Any" : currency.format(maxValue);
    priceRangeValue.textContent = `${minText} - ${maxText}`;
  };
  const updatePriceRangeTrack = () => {
    if (!priceDualRange) return;
    const minValue = Number(minPriceRange.value);
    const maxValue = Number(maxPriceRange.value);
    const minPct = (minValue / safeMaxPrice) * 100;
    const maxPct = (maxValue / safeMaxPrice) * 100;
    priceDualRange.style.setProperty("--min-pct", `${minPct}%`);
    priceDualRange.style.setProperty("--max-pct", `${maxPct}%`);
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
