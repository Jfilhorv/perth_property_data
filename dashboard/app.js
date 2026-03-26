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
let schoolPoints = [];
let yearlyChart;
let map;
let listingsLayer;
let suburbPriceLayer;
let schoolLayer;
let selectedFilters = {
  suburb: "",
  bedrooms: "",
  bathrooms: "",
};
let currentTableSort = { key: "count", dir: "desc" };

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
  const mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const p75 = percentile(0.75);
  const p95 = percentile(0.95);
  const medianPsm = median(pricePerSqm);

  kpis.appendChild(makeKpiCard("Records", numberFmt.format(filteredRows.length)));
  kpis.appendChild(makeKpiCard("Median Price", currency.format(medianPrice)));
  kpis.appendChild(makeKpiCard("Average Price", currency.format(mean)));
  kpis.appendChild(makeKpiCard("Median Price M2", asPricePerSqm(medianPsm)));
  kpis.appendChild(makeKpiCard("P75", currency.format(p75)));
  kpis.appendChild(makeKpiCard("P95", currency.format(p95)));
  footnote.textContent = `Date range: ${summary.date_min} to ${summary.date_max}`;
}

function renderSuburbOptions() {
  const select = document.getElementById("suburbSelect");
  select.innerHTML = '<option value="">All</option>';
  const grouped = aggregateSuburbStats(listingsCore);
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
  const beds = [...new Set(listingsCore.map((r) => r.Bedrooms))].filter(Number.isFinite).sort((a, b) => a - b);
  const baths = [...new Set(listingsCore.map((r) => r.Bathrooms))].filter(Number.isFinite).sort((a, b) => a - b);
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
      sumDistance: 0,
      distanceCount: 0,
      sumLat: 0,
      sumLon: 0,
      geoCount: 0,
    };
    current.count += 1;
    current.prices.push(row.Price);
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
      return {
        Suburb: v.Suburb,
        count: v.count,
        median_price: sorted[mid] ?? 0,
        highest_price: sorted.length ? sorted[sorted.length - 1] : 0,
        lowest_price: sorted.length ? sorted[0] : 0,
        avg_price: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        median_price_m2: psmSorted[psmMid] ?? 0,
        avg_price_per_sqm: psmSorted.length ? psmSorted.reduce((a, b) => a + b, 0) / psmSorted.length : 0,
        avg_distance_to_cbd: v.distanceCount ? v.sumDistance / v.distanceCount : 0,
        latitude: v.geoCount ? v.sumLat / v.geoCount : null,
        longitude: v.geoCount ? v.sumLon / v.geoCount : null,
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.Suburb}</td>
      <td>${numberFmt.format(row.count)}</td>
      <td>${currency.format(row.median_price)}</td>
      <td>${asPricePerSqm(row.median_price_m2)}</td>
      <td>${currency.format(row.highest_price)}</td>
      <td>${currency.format(row.lowest_price)}</td>
      <td>${formatDistance(row.avg_distance_to_cbd)}</td>
    `;
    body.appendChild(tr);
  }
}

function getFilteredRows() {
  return listingsCore.filter((row) => {
    const bySuburb = !selectedFilters.suburb || row.Suburb === selectedFilters.suburb;
    const byBeds = !selectedFilters.bedrooms || String(row.Bedrooms) === selectedFilters.bedrooms;
    const byBaths = !selectedFilters.bathrooms || String(row.Bathrooms) === selectedFilters.bathrooms;
    return bySuburb && byBeds && byBaths;
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

function applyFilters() {
  const filteredRows = getFilteredRows();
  renderKpis(summaryStats, filteredRows);
  renderSuburbTable(filteredRows);
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
    }).bindTooltip(`<b>${row.Suburb}</b><br/>Price: ${currency.format(row.Price)}`, { sticky: true })
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
        )}<br/>Median Price M2: ${asPricePerSqm(row.median_price_m2)}<br/>Highest: ${currency.format(
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
  schoolPoints = schools;

  renderSuburbOptions();
  renderBedroomBathroomOptions();
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
      applyFilters();
    });
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
