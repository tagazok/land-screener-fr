# Land Screener FR — status

## Gironde v0 — built 2026-10-19

Run it:

```bash
# data (only needed after changing the pipeline; raw/ is cached)
cd pipeline && uv run lsfr fetch && uv run lsfr build && uv run pytest -q
# web
cd web && npm install && npm run dev        # http://127.0.0.1:5180
#   or: npm run build && npm run preview    # http://127.0.0.1:5181
```

On this host use `/Users/oleplus/.local/share/mise/shims/npm`.

What exists:
- `pipeline/src/lsfr/`: `sources.py` (every URL), `fetch.py` (resumable download + provenance),
  `cog.py` (commune-code crosswalk), `dvf.py` (per-mutation dedupe, €/m², trend, land),
  `vigieau.py` (streams the 11.9 GB drought JSON from the zip, ~7 s), `build.py` (joins all themes).
  Output: `web/public/data/{communes.json,communes.geojson,metadata.json}`. 9 pytest tests.
- `web/src/`: `engine.ts` (pure filters/scoring/tiers), `strategies.ts` (4 presets + derived columns),
  `url.ts` (shareable hash state), `components/app-root.ts`, `components/map-view.ts`
  (MapLibre + OpenFreeMap basemap, feature-state colouring). 11 Vitest tests.

Known limits / next:
- INSEE RP logement base never downloads intact from insee.fr here; housing counts come from séries historiques instead.
- Flat prices exist for only 19% of communes (few flat sales outside towns) — expected.
- UI is in French. Every column, filter, weight, stat card and detail field has a "?" tooltip
  (`components/info-tip.ts`): meaning + "Calcul : …". Texts live in `web/src/strategies.ts`
  (`COLUMNS`, `FILTERS`, `SIGNALS`, `HELP`). A test fails if a shown column/filter/weight has no text.
- CSV export is for French Excel: `;` separator, `,` decimals, UTF-8 BOM.
- Pipeline output is deterministic (fixed 2026-10-19: DVF dedupe kept an arbitrary row).
- 2026-10-19: added "Habiter (long terme)" strategy and a right-hand side panel (replaces the map popup).
  New data (`pipeline/src/lsfr/living.py`, sources in `sources.py`, files in `raw/extra/`):
  clay exposure map 2026 (Géorisques ws `telechargements/formats/zip/alearg_25?echelle=departementale&codeDepartement=33`),
  DREES APL 2024, coast-retreat decree list 2026, ARCEP fibre (30/06/2026), INSEE AAV 2020,
  BPE 2025 commune counts → distance to nearest commune with each service (centre to centre, incl. neighbouring départements),
  drinking-water quality 2025 (2 members range-read from the 290 MB national zip).
  Not done: DRIAS 2050 climate (needs a personal account + licence check), groundwater levels (Hub'Eau).
  Note: insee.fr cuts big downloads (no range support): the geolocated BPE (136 MB) never completes, hence commune counts.
  VigiEau has no drinking-water restriction for Gironde 2021–2025 (all 0) → Habiter uses "jours de crise" instead.
- Next candidates: national scale (PMTiles, typed-array bundle), net yield with taxe foncière, DRIAS climate.
- 2026-10-19 redesign: filters/weights moved to a drawer ("Filtres et poids", closed by default, summary chips in main view);
  good/bad colouring from fixed thresholds in `web/src/judge.ts`; side panel has "Points forts / Points faibles".
- 2026-10-19: map "Colorer par" (score or any indicator, `web/src/scale.ts`) + colour key on the right; table column picker
  (12 columns by default, sticky commune name); light/dark/auto theme (saved in localStorage, dark basemap = OpenFreeMap "dark").
- 2026-10-19: SCALED TO ALL OF METROPOLITAN FRANCE (96 départements, 34,746 communes).
  `uv run lsfr fetch` (771 files, 1.5 GB in raw/dep/<code>/ + national files; 4 parallel, resumable, ~35 min),
  `uv run lsfr build` (~7 min cold; dvf/drought/living cached in raw/build/theme-*.parquet, ~2 min warm;
  delete raw/build to recompute). Quick test build: `LSFR_DEPTS=01,33 uv run lsfr build`.
  Output: communes.json (columnar, 21 MB / 4 MB gzip), communes.pmtiles (35 MB, tippecanoe z4–11,
  range-read by the browser via the pmtiles protocol), departements.geojson (dissolved from communes).
  Web: "Zone" selector (France or one département: scores/medians recomputed within it, map zooms),
  commune search (accent-insensitive), table paginated by 200, derive/evaluate cached (~70 ms per weight change).
  Paris/Lyon/Marseille: arrondissement rows are mapped to the city (cog.ARRONDISSEMENTS), and dropped when
  a file also has the city row (no double count).
  Known gaps: no DVF for 57/67/68 (Alsace-Moselle); no clay map for Paris; 248 communes split back out
  in 2024–2026 have no INSEE 2022 data.
- AI summaries exist only for Gironde (534). `uv run lsfr summarize --depts 40 47` adds départements;
  comparisons now use each commune's own département median. All of France = ~34,200 more Bedrock calls
  (Gironde run: 534 communes ≈ 2.5 M input + 0.43 M output tokens) — ask the user before running it. (pipeline/src/lsfr/summarize.py) calls Bedrock `us.anthropic.claude-haiku-5-5`
  (us-east-1, default AWS profile, thinking disabled) and writes `web/public/data/summaries.json`. Cached by facts+prompt
  hash in `raw/ai/summaries-cache.json`: re-runs only regenerate changed communes. First full run: 534 communes,
  2.48 M input + 0.43 M output tokens.
- 2026-10-19 later: map toolbar has a multi-département picker (URL `z=33,40,64`; map hides other communes,
  table/scores/medians restricted to them). AI prompt v2026-10-19.4 explains for which of the 5 strategies the
  commune passes and why the others fail: `cd web && npx vite-node scripts/strategy-fit.ts` writes
  raw/ai/strategy-fit.json (pass/fail with value vs threshold, computed by the app's own engine) which
  `lsfr summarize` feeds to the model. National run started ~07:33 (8 workers, ~65 communes/min, ~9 h,
  log raw/logs/summarize-france.log). If interrupted, re-run the same command: it resumes from the cache.
- 2026-10-19 six new features (all new filters OFF by default, so the national AI summaries stay valid):
  net yield + monthly cash flow (`web/src/finance.ts`; assumptions in the drawer "Hypothèses d’achat", saved in the
  URL as `fi=rate:0.032,years:25`; step-by-step "Simulation d’achat" in the side panel; property tax =
  `tfpb_total_avg_eur` from REI); energy rating `dpe_fg_share`/`dpe_g_share` (ADEME, `lsfr.dpe_fetch` →
  raw/extra/dpe-communes.json; for Paris/Lyon/Marseille arrondissements are ADDED to the city row);
  rental demand (tenants, furnished, social, unemployment, jobs per active person, from INSEE RP 2023 via
  `lsfr.melodi_fetch`; students MESR 2025); crime 2025 (SSMSI; unpublished small communes get the département
  average, flagged `crime_estimated`, ~29 % of communes); schools (collège IPS, lycée success / value added,
  nearest commune with a school otherwise); price history `hist_{house|apt}_{2021..2025}` chart in the side panel.
  Code: `pipeline/src/lsfr/demand.py`, build step "demand" (cached). Default weights changed: long term now
  favours net yield (and tenants, unemployment, F-G share), medium term students/jobs, live term crime/IPS.
  Scores and ranks moved accordingly, pass/fail counts did not. Tests: 14 pytest, 22 vitest.
- 2026-10-29: AI summaries are now published as `web/public/data/summaries/<dep>.json` (one per département, ~90 KB gzipped)
  and fetched when a commune of that département is opened; `summaries.json` is gone. `uv run lsfr summarize --publish-only`
  rewrites them from `raw/ai/summaries-cache.json` without calling Bedrock. Startup shows a loading card with MB received.
  New filters `pop` (min) and `popmax` (max inhabitants) on every strategy, off by default (medium keeps pop ≥ 8 000 on).
