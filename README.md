# Perth Property Data Dashboard

Projeto para analise de dados imobiliarios de Perth com pipeline simples em Python e dashboard estatico.

## Estrutura

- `perth_property_data.csv`: base principal de imoveis vendidos
- `scripts/build_dashboard_data.py`: transforma CSV em JSON para o dashboard
- `scripts/run_update.py`: entrypoint para atualizar os dados do dashboard
- `dashboard/`: front-end estatico (HTML/CSS/JS)
- `dashboard/data/`: arquivos JSON gerados para visualizacao
- `data_schema.md`: documentacao de colunas, tipos e nulos

## Como atualizar os dados

```bash
python scripts/run_update.py
```

## Como abrir o dashboard localmente

```bash
python -m http.server 8000
```

Depois abra:

`http://localhost:8000/dashboard/`

## Features atuais

- KPIs principais (registros, datas, mediana/media/P75/P95)
- Evolucao anual do preco mediano
- Tabela de suburbs com filtro rapido

## Proximos passos sugeridos

- Filtros por ano, tipo de imovel e faixa de preco
- Mapa com pontos por latitude/longitude
- Exportacao CSV/PNG no dashboard
