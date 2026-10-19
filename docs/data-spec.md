# Land Screener FR — v1 Data Spec

Status: verified draft, 2026-10-17. Companion to `docs/architecture.md`.

Every line below was checked live on 2026-10-17 (data.gouv.fr API, insee.fr,
producer docs, or by downloading and opening the file) unless marked
**(to verify)**. "Licence Ouverte" = Etalab Licence Ouverte 2.0 (`lov2`/`fr-lo`):
free reuse incl. commercial, attribution required. INSEE confirms all its site
data is under Licence Ouverte 2.0 ([insee.fr/fr/information/2008466](https://www.insee.fr/fr/information/2008466)).

## 1. Ground rules

- **Join key:** INSEE commune code, 5-char **string** (`01001`, `2A004`). Some
  sources drop the leading zero (radon: `9313`) or split it (REI: `DEP`+`COM`),
  so every loader normalises to 5 chars. Paris/Lyon/Marseille arrondissements
  are rolled up to the commune for v1.
- **Canonical geography: COG 2026.** Sources ship in different vintages (table
  below), so each one passes through a crosswalk built from INSEE
  `v_mvt_commune_2026.csv` before joining. Additive counts are summed on mergers;
  rates/medians are re-weighted by population.
- **Missing ≠ zero.** Nulls carry a reason code (`secret`, `not_covered`,
  `estimated_from_neighbours`, `no_sales`) and render as "no data".
- **Scope v1:** metropolitan France incl. Corsica.
- **Attribution page** lists every source, licence, vintage and required credit line.

## 2. v1 core datasets

| # | Theme | Source (file) | Producer | Licence | Size | Update | Geo vintage |
|---|---|---|---|---|---|---|---|
| D1 | Sale prices | [DVF géolocalisées](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees) `dvf.csv.gz` (2021-01 → 2025-12); also per dept at `files.data.gouv.fr/geo-dvf/latest/csv/` | Etalab ← DGFiP | lov2 + DGFiP CGU (see §4.4) | 523 MB gz | semiannual (Apr/Oct) | current COG + `ancien_code_commune` |
| D1b | Sale prices, freshest | [DVF brut](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres) yearly `.txt.zip`, incl. **2026 S1** (published 2026-10-12) | DGFiP | lov2 + CGU | 30–90 MB/yr | semiannual | — |
| D2 | Rents | [Carte des loyers 2025](https://www.data.gouv.fr/datasets/carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-2025): `pred-app-mef-dhup.csv`, `pred-app12-…`, `pred-app3-…`, `pred-mai-…` | ANIL / DGALN | lov2, credit line mandatory | 4.8 MB each | yearly (Dec) | COG 2025 |
| D3 | Risks | [GASPAR](https://files.georisques.fr/GASPAR/gaspar.zip): `catnat`, `ddrm_risq`, `azi`, `pprn`, `pprt`, `pprm`, `dicrim`, `tim` (dated 2026-10-05) | Géorisques / DGPR | fr-lo | 8 MB zip, 72 MB CSV | weekly | current |
| D4 | Drought restrictions | [VigiEau](https://www.data.gouv.fr/datasets/donnee-secheresse-vigieau): `restrictions-communes-<year>.zip`, `historique-communes.zip`, `arretes-<year>.csv` (2012→) | MTE | lov2 | 2026: 7.8 MB zip → 559 MB JSON; history 587 MB zip | daily | current |
| D5 | Local taxes | [REI 2025](https://www.data.gouv.fr/datasets/impots-locaux-fichier-de-recensement-des-elements-dimposition-a-la-fiscalite-directe-locale-rei-4) `REI_2025.csv` + `TRACE_REI_2025.xlsx` (column dictionary) | DGFiP | lov2 | 18 MB zip, 112 MB CSV, 34,907 rows | annual (May) | 2025 |
| D6 | Zone tendue | [Zonage TLV](https://www.data.gouv.fr/datasets/liste-des-communes-selon-le-zonage-tlv-1) (décret 2025-1267, 22 Dec 2025) | MTE | lov2 | 3.4 MB | on decree | — |
| D7 | Zonage ABC | [Zonage ABC](https://www.data.gouv.fr/datasets/liste-des-communes-selon-le-zonage-abc) in force 26 June 2026 | MTE | lov2 | 0.9 MB | on decree | — |
| D8 | Housing stock | INSEE RP 2023 logement ([8997194](https://www.insee.fr/fr/statistiques/8997194)): `DS_RP_LOGEMENT_COMP_2023_CSV_FR.zip` (long format). Fallback: RP 2022 `base-cc-logement-2022-COM_csv.zip` ([8581474](https://www.insee.fr/fr/statistiques/8581474)) | INSEE | LO 2.0 | — | annual | 2025/2026 |
| D9 | Population trend | INSEE séries historiques `base-cc-serie-historique-2022-COM_csv.zip` ([8582555](https://www.insee.fr/fr/statistiques/8582555)) | INSEE | LO 2.0 | — | annual | 2025 |
| D10 | Income | INSEE Filosofi 2021 `base-cc-filosofi-2021-geo2025_csv.zip` ([7756729](https://www.insee.fr/fr/statistiques/7756729)) — latest vintage per INSEE | INSEE | LO 2.0 | — | irregular | COG 2025 |
| D11 | Amenities | INSEE **BPE 2025** `BPE25.zip` ([8217525](https://www.insee.fr/fr/statistiques/8217525)), geolocated, 229 equipment types | INSEE | LO 2.0 | — | annual | — |
| D12 | Tourism capacity | INSEE capacity of communes ([2021703](https://insee.fr/fr/statistiques/2021703)): 2026 XLSX `ds_tour_cap_2026_geo2026_XLSX.zip`, 2025 CSV `DS_TOUR_CAP_CSV_2025_geo25.zip` (long format + metadata CSV) | INSEE | LO 2.0 | ~1 MB | annual | COG 2026 |
| D13 | Boundaries | IGN **ADMIN EXPRESS COG CARTO 4.0, 2026-01-01**, available as **GeoParquet / FlatGeobuf (WGS84, FRA)** and GPKG (Lambert-93, FXX) via [data.geopf.fr](https://data.geopf.fr/telechargement/resource/ADMIN-EXPRESS-COG-CARTO) | IGN | lov2 | — | yearly edition | COG 2026 |
| D14 | Crosswalk | [COG 2026](https://www.data.gouv.fr/datasets/code-officiel-geographique-cog): `v_commune_2026`, `v_mvt_commune_2026.csv` | INSEE | fr-lo | — | annual | 2026 |
| D15 | Radon | [Potentiel radon par commune](https://www.data.gouv.fr/datasets/connaitre-le-potentiel-radon-de-ma-commune) `radon.csv` (classes 1/2/3, arrêté 27 June 2018) | ASNR (ex-IRSN/ASN) | fr-lo | 1.2 MB, 36k rows | static | **COG 2016** (old codes → crosswalk) |
| D16 | Students | MESR "effectifs d'étudiants inscrits… agrégeables" (atlas régional, by site commune, up to 2024-25) | MESR | lov2 | — | annual (last 2026-10-12) | current |

## 3. Field-level facts verified in the files

**D1 DVF** — header confirmed: `id_mutation, date_mutation, nature_mutation,
valeur_fonciere, code_commune, code_type_local (1 maison, 2 appartement,
3 dépendance, 4 local industriel/commercial), type_local, surface_reelle_bati,
nombre_pieces_principales, code_nature_culture (AB = terrain à bâtir, …),
surface_terrain, nombre_lots, longitude, latitude`.
- `valeur_fonciere` is **repeated on every row of a mutation** (a house + its
  outbuilding = 2 rows, same price). Aggregate per `id_mutation` first; keep only
  mutations with exactly one dwelling (`code_type_local` 1 or 2, outbuildings
  allowed) to get a clean €/m².
- `nature_mutation` values: Vente, VEFA, vente de terrain à bâtir, adjudication,
  expropriation, échange. Price metrics use `Vente` (+ VEFA flagged separately).
- Land price: `nature_mutation = "Vente terrain à bâtir"` and/or
  `code_nature_culture = AB`, no `code_type_local`.
- Coverage (DGFiP notice): **excludes Bas-Rhin, Haut-Rhin, Moselle** (livre
  foncier) **and the DROM except Mayotte**. Mayotte is in.
- Freshness: April release = deeds registered by 31 Dec; October release adds
  H1. The newest semester is always incomplete (FAQ) — weight it down or drop it.
- Agency fees are included only when paid by the seller; furniture value excluded.

**D2 Rents** — `id_zone; INSEE_C; LIBGEO; EPCI; DEP; REG; loypredm2;
lwr.IPm2; upr.IPm2; TYPPRED; nbobs_com; nbobs_mail; R2_adj`. `;`-separated,
**decimal comma, latin-1**. 34,900 rows.
- Meaning: predicted €/m² **charges included, unfurnished**, listings Q3 2025,
  reference flat 52 m² / house 92 m². Hedonic model, not a median.
- **Only 4,871 communes (14 %) have a commune-level prediction**; 30,029 use a
  "maille" (group of similar neighbouring communes). ANIL's own reliability rule:
  distrust if `R2_adj < 0.5`, `nbobs_com < 30`, or a wide interval. We expose a
  `rent_confidence` (high/medium/low) from those three.
- Editions are **not comparable year to year** (mesh changes) → no rent trend.
- Mandatory credit: « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin ».

**D3 GASPAR**
- `catnat`: `code_commune, lib_risque_jo, date_debut, date_fin,
  date_signature_arrete, date_publication_jo` — 247,140 rows, 1982 → Dec 2025.
  Top perils: floods/mudflows (139k), drought/clay subsidence "Sécheresse" (43k),
  landslides, storms, wave shocks, seismic.
- `ddrm_risq`: `cod_commune, lib_risque, num_risque` — 176k rows, 31,733
  communes. Risks declared per commune incl. 11x floods (112 slow river, 113 flash
  flood, 114 runoff, 116 groundwater, **117 marine submersion**), 12x ground
  movement (127 tassements = clay), **13 séisme**, 14 avalanche, **16 feu de
  forêt**, 18 radon, 21x industrial, 22 nuclear, 23 dam break, 24 hazmat
  transport, 31x mining. **Presence only — no intensity**.

**D4 VigiEau** — JSON: per commune, per day, level for `AEP` (drinking water),
`SOU` (groundwater), `SUP` (surface water) ∈ {null, `vigilance`, `alerte`,
`alerte_renforcee`, `crise`}. Metric: days/year at ≥ `alerte_renforcee` and at
`crise`, averaged over the last 5 seasons. The JSON is 559 MB/year unzipped →
stream-parse, never load whole. First year of the per-commune history file **(to verify, arrêtés go back to 2012)**.

**D5 REI** (`;`, latin-1, rates as `0.16400` = %). Columns we need, from TRACE:

| Column | Meaning |
|---|---|
| `DEP`+`COM` | commune code |
| `E12` | TFPB rate, commune (net, applied) |
| `E22` | TFPB rate, syndicates |
| `E32` | TFPB rate, EPCI |
| `E52` | TSE rate (EPF) |
| `E52gGEMAPI` | GEMAPI rate |
| `E11` / `E13` / `E14` | commune base / amount / number of tax units → **average TFPB actually paid** |
| `F13` / `F14` | TEOM (bin tax) total amount / units |
| `TXMAJOTHRS` | **surcharge on second-home taxe d'habitation (0–60 %)** — strong signal for STR/second-home investors (e.g. Bordeaux 60 %, Mérignac 20 %) |

`tfpb_total_rate = E12 + E22 + E32 + E52 + E52gGEMAPI`.

**D15 Radon** — `nom_comm; nom_dept; insee_com; classe_potentiel; reg`;
`insee_com` not zero-padded; COG 2016 → must go through the crosswalk.

## 4. v1.1 / later

| # | Theme | Source | Licence | Status |
|---|---|---|---|---|
| L1 | Clay shrink-swell (RGA), commune grain | Géorisques "RGA – carte d'exposition (2026)", shapefile **per département** (Lambert-93), metropole excl. Paris → intersect with communes | Géorisques terms (to verify) | Host `georisques.gouv.fr` **times out from this machine**; download manually or from another network. v1 proxy: catnat "Sécheresse" count + ddrm 127. The SDES RGA dataset (fr-lo) is **EPCI-level only** — usable for the EPCI layer, not communes. |
| L2 | Seismic zone 1–5 | Décret 2010-1255 (COG 2008). Only a 2018 third-party shapefile on data.gouv (org "wpd", fr-lo, 129 MB) | fr-lo | v1 uses ddrm "Séisme" presence; zone level later from the official list. |
| L3 | Forest-fire history | [BDIFF](https://bdiff.agriculture.gouv.fr/) — CSV export **from the search UI** (zip: CSV + legal notice + definitions), no static bulk file. Licence lov2 per data.gouv | lov2 | Manual export by department, 2006→. v1 uses ddrm "Feu de forêt". |
| L4 | Rent control | Paris (ODbL), Lyon (lov2), Bordeaux, Plaine Commune, Lille… | mixed | v1: curated flag list with source + date. |
| L5 | Stations | [SNCF gares de voyageurs](https://www.data.gouv.fr/datasets/gares-de-voyageurs-1) | **ODbL** | Share-alike applies to a *derived database*. Shipping a "distance to station" column in our public bundle may trigger it → legal check first. Alternative: BPE 2025 already lists train stations (code E107/E108 **to verify**) under LO 2.0 → **prefer BPE**. |
| L6 | Future climate | [DRIAS](https://www.drias-climat.fr/) TRACC indicators (+2 / +2.7 / +4 °C France; incl. IFM40 fire-weather days, SWI04 dry-soil days), CSV/NetCDF on 8 km grid | Free, **account required, data must not be altered**, credit "DRIAS, données Météo-France, CERFACS, IPSL" | Aggregating grid → commune may count as "altering" → read full CGU / ask Météo-France before publishing. |
| L7 | Short-term rental listings | [Inside Airbnb](https://insideairbnb.com/get-the-data/) — Paris, Lyon, Bordeaux + France archive | Site says CC BY 4.0, **but the data policy says "do not republish the data"** and it targets activists/journalists | **Do not ship.** At most an internal sanity check of our STR proxies. |

## 5. Known gaps — shown in the UI

1. **No national open data on short-term rental rules per commune.** Loi Le Meur
   (2024-1039) lets mayors cap principal-residence STR at 90 days, set quotas and
   require registration; the national registration téléservice was due by
   20 May 2026 but several sources say it opens in Q4 2026 (**to verify on
   service-public.gouv.fr**). v1 = proxy flag "STR likely regulated" from zone
   tendue (D6) + `TXMAJOTHRS > 0` (D5) + second-home share (D8) + tourism
   capacity (D12), plus a curated list for the big regulated cities.
2. **No open STR revenue data** (AirDNA/Airbtics are paid). Short-term = demand
   score, not €/night.
3. **Rents are listing-based model estimates**, mostly at "maille" level (86 % of
   communes). Shown with confidence.
4. **No DVF prices for Moselle, Bas-Rhin, Haut-Rhin** (~2,000 communes). Price and
   yield = null `not_covered`; filters must not silently exclude them — offer
   "include communes without price data".
5. Income is 2021 (latest Filosofi), masked for small communes.

## 6. Derived metrics (per commune)

| Metric | Formula / source |
|---|---|
| `price_m2_apt`, `price_m2_house`, `n_sales_*` | D1/D1b: per-mutation dedupe; single-dwelling `Vente`; median `valeur_fonciere / surface_reelle_bati`; last 24 complete months; drop €/m² outside p1–p99 per dept; null if `n_sales < 5` |
| `price_trend_3y` | median €/m² last 12 m ÷ same window 3 years earlier − 1 (needs ≥ 10 sales in each) |
| `land_price_m2`, `n_land_sales` | D1: terrain à bâtir sales, `valeur_fonciere / surface_terrain` |
| `rent_m2_apt`, `rent_m2_house`, `rent_confidence` | D2 `loypredm2` + interval, `TYPPRED`, `nbobs_com`, `R2_adj` |
| `gross_yield_apt` / `_house` | `rent_m2 × 12 / price_m2` (rents incl. charges → slight overstatement, noted) |
| `tfpb_total_rate`, `avg_tfpb_paid` | D5 (see §3) |
| `second_home_surcharge` | D5 `TXMAJOTHRS` |
| `catnat_*_30y` | D3 catnat by peril, `date_debut ≥ 1996` |
| `risk_flags` | D3 ddrm codes 117, 113, 16, 13, 21x, 23, 31x; PPR presence from pprn/pprt/pprm |
| `radon_class` | D15 |
| `drought_days_5y`, `crisis_days_5y` | D4 |
| `zone_tendue`, `zone_abc` | D6, D7 |
| `secondary_home_share`, `vacancy_rate` | D8 |
| `pop`, `pop_cagr_10y` | D9 |
| `median_income` | D10 |
| `amenity_*` | D11 counts (doctor, pharmacy, school, supermarket, station…) + per 1,000 hab |
| `hotel_rooms`, `camping_pitches`, `tourism_beds_per_hab` | D12 (bed weighting = our assumption, documented) |
| `students` | D16 |

## 7. Pipeline volume

Raw downloads ≈ 1.5 GB compressed (DVF 0.5 GB, VigiEau history 0.6 GB, REI
0.02 GB…), ~3–4 GB unpacked (VigiEau JSON dominates → streaming parser).
Output: ~35k rows × ~60 columns, a few MB — matches the architecture budget.

**Network note:** from this machine large `static.data.gouv.fr` downloads were
cut off mid-stream (HTTP/2 CANCEL); `curl --http1.1 -C -` with retries completed
them. The downloader must support resume + checksum/size check.
`georisques.gouv.fr` (site + API) timed out; `files.georisques.fr` works.

## 8. Still to verify (small)

- First year in VigiEau `historique-communes.zip`.
- BPE 2025 codes for train stations / doctors / schools.
- Le Meur téléservice opening date.
- Géorisques RGA 2026 per-département download (needs another network).
- DRIAS CGU on derived/aggregated values.
