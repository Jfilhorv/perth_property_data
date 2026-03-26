const currency = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const numberFmt = new Intl.NumberFormat("en-AU");

let suburbStats = [];
let yearlyStats = [];
let yearlyChart;

function makeKpiCard(label, value) {
  const div = document.createElement("div");
  div.className = "kpi-card";
  div.innerHTML = `<h3>${label}</h3><p>${value}</p>`;
  return div;
}

function renderKpis(summary) {
  const kpis = document.getElementById("kpis");
  kpis.innerHTML = "";

  kpis.appendChild(makeKpiCard("Registros", numberFmt.format(summary.rows)));
  kpis.appendChild(makeKpiCard("Faixa de datas", `${summary.date_min} ate ${summary.date_max}`));
  kpis.appendChild(makeKpiCard("Preco mediano", currency.format(summary.price_median)));
  kpis.appendChild(makeKpiCard("Preco medio", currency.format(summary.price_mean)));
  kpis.appendChild(makeKpiCard("P75", currency.format(summary.price_p75)));
  kpis.appendChild(makeKpiCard("P95", currency.format(summary.price_p95)));
}

function renderSuburbOptions() {
  const select = document.getElementById("suburbSelect");
  const topSuburbs = suburbStats.slice(0, 60);
  for (const row of topSuburbs) {
    const opt = document.createElement("option");
    opt.value = row.Suburb;
    opt.textContent = `${row.Suburb} (${row.count})`;
    select.appendChild(opt);
  }
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

function renderYearlyChart() {
  const ctx = document.getElementById("yearlyChart");
  if (yearlyChart) yearlyChart.destroy();

  yearlyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: yearlyStats.map((r) => r.Year),
      datasets: [
        {
          label: "Preco mediano (AUD)",
          data: yearlyStats.map((r) => r.median_price),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.2)",
          fill: true,
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

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Erro ao carregar ${path}`);
  return res.json();
}

async function init() {
  const [summary, yearly, suburbs] = await Promise.all([
    loadJson("./data/summary.json"),
    loadJson("./data/yearly.json"),
    loadJson("./data/suburb_stats.json"),
  ]);

  yearlyStats = yearly;
  suburbStats = suburbs;

  renderKpis(summary);
  renderSuburbOptions();
  renderSuburbTable();
  renderYearlyChart();

  const select = document.getElementById("suburbSelect");
  select.addEventListener("change", (e) => renderSuburbTable(e.target.value));
}

init().catch((err) => {
  console.error(err);
  alert("Falha ao carregar dados do dashboard.");
});
