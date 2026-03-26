const currency = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const numberFmt = new Intl.NumberFormat("en-AU");

let suburbStats = [];
let yearlyStats = [];
let yearlyBySuburb = [];
let listingsSample = [];
let suburbMapStats = [];
let yearlyChart;
let map;
let listingsLayer;
let suburbPriceLayer;
let selectedSuburb = "";

function makeKpiCard(label, value) {
  const div = document.createElement("div");
  div.className = "kpi-card";
  div.innerHTML = `<h3>${label}</h3><p>${value}</p>`;
  return div;
}

function renderKpis(summary) {
  const kpis = document.getElementById("kpis");
  const footnote = document.getElementById("kpiFootnote");
  kpis.innerHTML = "";

  kpis.appendChild(makeKpiCard("Registros", numberFmt.format(summary.rows)));
  kpis.appendChild(makeKpiCard("Preco mediano", currency.format(summary.price_median)));
  kpis.appendChild(makeKpiCard("Preco medio", currency.format(summary.price_mean)));
  kpis.appendChild(makeKpiCard("P75", currency.format(summary.price_p75)));
  kpis.appendChild(makeKpiCard("P95", currency.format(summary.price_p95)));
  footnote.textContent = `Cobertura de datas: ${summary.date_min} ate ${summary.date_max}`;
}

function renderSuburbOptions() {
  const list = document.getElementById("suburbOptions");
  list.innerHTML = '<option value="Todos"></option>';
  for (const row of suburbStats) {
    const opt = document.createElement("option");
    opt.value = row.Suburb;
    list.appendChild(opt);
  }
}

function parseSuburbSearchValue(rawValue) {
  const value = (rawValue || "").trim();
  if (!value || value.toLowerCase() === "todos") return "";
  const exists = suburbStats.some((row) => row.Suburb.toLowerCase() === value.toLowerCase());
  if (!exists) return "";
  const exact = suburbStats.find((row) => row.Suburb.toLowerCase() === value.toLowerCase());
  return exact ? exact.Suburb : "";
}

function renderSuburbTable(filterSuburb = "") {
  const body = document.getElementById("suburbTableBody");
  body.innerHTML = "";

  const rows = suburbStats
    .filter((r) => !filterSuburb || r.Suburb === filterSuburb)
    .slice(0, filterSuburb ? 1 : 15);

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.Suburb}</td>
      <td>${numberFmt.format(row.count)}</td>
      <td>${currency.format(row.median_price)}</td>
      <td>${numberFmt.format(Math.round(row.avg_distance_to_cbd))}</td>
    `;
    body.appendChild(tr);
  }
}

function getYearlySeries(filterSuburb = "") {
  if (!filterSuburb) return yearlyStats;
  return yearlyBySuburb.filter((row) => row.Suburb === filterSuburb);
}

function renderYearlyChart(chartType = "line", filterSuburb = "") {
  const series = getYearlySeries(filterSuburb);
  const ctx = document.getElementById("yearlyChart");
  if (yearlyChart) yearlyChart.destroy();

  yearlyChart = new Chart(ctx, {
    type: chartType,
    data: {
      labels: series.map((r) => r.Year),
      datasets: [
        {
          label: filterSuburb ? `Preco mediano (AUD) - ${filterSuburb}` : "Preco mediano (AUD)",
          data: series.map((r) => r.median_price),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.2)",
          fill: chartType === "line",
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true },
      },
      scales: {
        y: {
          ticks: {
            callback: (v) => currency.format(v),
          },
        },
      },
    },
  });
}

function applySelectedSuburb(suburb) {
  selectedSuburb = suburb;
  renderSuburbTable(suburb);
  renderMap(suburb);
  const chartType = document.getElementById("chartTypeSelect").value;
  renderYearlyChart(chartType, suburb);
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

function renderMap(filterSuburb = "") {
  if (!map) {
    map = L.map("map").setView([-31.95, 115.86], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }

  if (listingsLayer) map.removeLayer(listingsLayer);
  if (suburbPriceLayer) map.removeLayer(suburbPriceLayer);

  const filteredListings = listingsSample.filter((row) => !filterSuburb || row.Suburb === filterSuburb);
  const listingMarkers = filteredListings.map((row) =>
    L.circleMarker([row.Latitude, row.Longitude], {
      radius: 3,
      color: "#ef4444",
      fillColor: "#ef4444",
      fillOpacity: 0.35,
      weight: 1,
    }).bindTooltip(`<b>${row.Suburb}</b><br/>Preco: ${currency.format(row.Price)}`, { sticky: true })
  );
  listingsLayer = L.layerGroup(listingMarkers);

  const filteredSuburb = suburbMapStats.filter((row) => !filterSuburb || row.Suburb === filterSuburb);
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
        `<b>${row.Suburb}</b><br/>Preco medio: ${currency.format(row.avg_price)}<br/>Preco mediano: ${currency.format(
          row.median_price
        )}<br/>Vendas: ${numberFmt.format(row.count)}`,
        { sticky: true }
      )
    )
  );
  const mapView = document.getElementById("mapViewSelect").value;
  if (mapView === "both" || mapView === "listings") {
    listingsLayer.addTo(map);
  }
  if (mapView === "both" || mapView === "suburb") {
    suburbPriceLayer.addTo(map);
  }

  const group = L.featureGroup([...listingMarkers, ...filteredSuburb.map((row) => L.marker([row.latitude, row.longitude]))]);
  if (group.getLayers().length > 0) {
    map.fitBounds(group.getBounds().pad(0.12));
  }
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Erro ao carregar ${path}`);
  return res.json();
}

async function init() {
  const [summary, yearly, yearlySuburb, suburbs, listings, suburbMap] = await Promise.all([
    loadJson("./data/summary.json"),
    loadJson("./data/yearly.json"),
    loadJson("./data/yearly_by_suburb.json"),
    loadJson("./data/suburb_stats.json"),
    loadJson("./data/listings_sample.json"),
    loadJson("./data/suburb_map_stats.json"),
  ]);

  yearlyStats = yearly;
  yearlyBySuburb = yearlySuburb;
  suburbStats = suburbs;
  listingsSample = listings;
  suburbMapStats = suburbMap;

  renderKpis(summary);
  renderSuburbOptions();
  applySelectedSuburb("");

  const suburbSearch = document.getElementById("suburbSearch");
  suburbSearch.addEventListener("input", (e) => {
    const value = parseSuburbSearchValue(e.target.value);
    applySelectedSuburb(value);
  });
  suburbSearch.addEventListener("change", (e) => {
    const value = parseSuburbSearchValue(e.target.value);
    applySelectedSuburb(value);
    e.target.value = value || "Todos";
  });

  const chartTypeSelect = document.getElementById("chartTypeSelect");
  chartTypeSelect.addEventListener("change", (e) => renderYearlyChart(e.target.value, selectedSuburb));

  const mapViewSelect = document.getElementById("mapViewSelect");
  mapViewSelect.addEventListener("change", () => {
    renderMap(selectedSuburb);
  });

  suburbSearch.value = "Todos";
}

init().catch((err) => {
  console.error(err);
  alert("Falha ao carregar dados do dashboard.");
});
