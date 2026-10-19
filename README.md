# Land Screener FR

A screener for the 34,746 communes of metropolitan France, built entirely from French open data. It helps find places to buy property to rent (long, medium or short term), land, or a house to live in.

Live site: https://tagazok.github.io/land-screener-fr/

## How it works

- `pipeline/`: Python (uv, Polars). It downloads the open datasets into `raw/` (not committed, about 2 GB) and joins them into one row per commune in `web/public/data/`.
- `web/`: a static Lit + Vite + TypeScript + MapLibre app with no backend. At startup it loads `communes.json` (every indicator); the map reads `communes.pmtiles` with HTTP range requests.
- `.github/workflows/pages.yml`: on every push to `main`, runs the tests, builds `web/` and publishes it to GitHub Pages.

## Commands

```sh
cd pipeline
uv run lsfr fetch                   # download sources (resumable)
uv run lsfr build                   # rebuild web/public/data
uv run lsfr summarize --workers 8   # AI summaries (Amazon Bedrock, local AWS profile)

cd ../web
npm ci && npm run dev               # local dev server
npx vitest run                      # tests
```

## Data sources

All are open data, mostly under Licence Ouverte 2.0: DVF (sale prices), ANIL rent map, INSEE (census, income, communes), GASPAR / Géorisques (risks), BRGM (clay shrink-swell), VigiEau, DREES, ARCEP, ADEME (DPE energy ratings), SSMSI (crime), Éducation nationale (IPS, IVAL), MESR. The full list with vintages is in `web/public/data/metadata.json` and in the app.
