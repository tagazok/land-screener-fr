"""Build the v0 web artifacts for one département.

Outputs (in web/public/data/):
  communes.json   one record per commune (metrics, nulls kept as null)
  communes.geojson  simplified polygons, properties: code, nom
  metadata.json   sources, vintages, credits, column dictionary, coverage
"""

from __future__ import annotations

import json
import zipfile
from datetime import date
from pathlib import Path

import polars as pl
from shapely.geometry import mapping, shape

from . import contamination, demand, dvf, living, vigieau
from .cog import load_crosswalk, remap
from .sources import DEPTS, DIS_2025, DVF_YEARS, SOURCES, dep_dir

DVF_END = "2025-12-31"  # last complete half-year in the April/October 2026 release
DROUGHT_YEARS = ["2021", "2022", "2023", "2024", "2025"]
CATNAT_SINCE = "1996-01-01"


def _zip_csv(path: Path, member: str, **kw) -> pl.DataFrame:
    with zipfile.ZipFile(path) as z:
        return pl.read_csv(z.open(member).read(), infer_schema_length=0, **kw)


def _num(cols: list[str]) -> list[pl.Expr]:
    return [pl.col(c).str.replace(",", ".").cast(pl.Float64, strict=False) for c in cols]


def _round(g):
    def r(c):
        return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], float) else [r(x) for x in c]
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


# ---------------------------------------------------------------- spine
def spine(raw: Path) -> tuple[pl.DataFrame, list[dict]]:
    """One row per commune (code, name, centre) and its polygon features, all départements."""
    rows, feats = [], []
    for d in DEPTS:
        gj = json.loads((raw / dep_dir(d) / "communes.geojson").read_text())
        for f in gj["features"]:
            p = f["properties"]
            geom = shape(f["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            c = geom.representative_point()  # always inside the commune, unlike a centroid
            rows.append({"code": p["code"], "nom": p["nom"], "dep": d, "epci": p.get("codeEpci"),
                         "lon": round(c.x, 5), "lat": round(c.y, 5)})
            feats.append({"type": "Feature", "properties": {"code": p["code"], "nom": p["nom"], "dep": d},
                          "geometry": mapping(geom)})
    return pl.DataFrame(rows), feats


# ---------------------------------------------------------------- themes
def rents(raw: Path, x: dict) -> pl.DataFrame:
    out = None
    for key, fn in (("apt", "rent-apt-2025.csv"), ("house", "rent-house-2025.csv")):
        r = pl.read_csv(raw / fn, separator=";", encoding="latin1", infer_schema_length=0)
        r = r.filter(pl.col("INSEE_C").str.slice(0, 2).is_in(DEPTS)).rename({"INSEE_C": "code"})
        r = r.with_columns(*_num(["loypredm2", "lwr.IPm2", "upr.IPm2", "R2_adj", "nbobs_com"]))
        r = remap(r, x).group_by("code").agg(
            pl.col("loypredm2").mean().alias(f"rent_m2_{key}"),
            pl.col("lwr.IPm2").mean().alias(f"rent_m2_{key}_low"),
            pl.col("upr.IPm2").mean().alias(f"rent_m2_{key}_high"),
            pl.col("TYPPRED").first().alias(f"rent_level_{key}"),
            pl.col("nbobs_com").sum().alias(f"rent_nobs_{key}"),
            pl.col("R2_adj").mean().alias("_r2"),
        )
        # ANIL guidance: distrust if R2 < 0.5, < 30 observations, or a wide interval.
        width = (pl.col(f"rent_m2_{key}_high") - pl.col(f"rent_m2_{key}_low")) / pl.col(f"rent_m2_{key}")
        r = r.with_columns(
            pl.when((pl.col("_r2") >= 0.5) & (pl.col(f"rent_nobs_{key}") >= 30) & (width < 0.6))
            .then(pl.lit("high"))
            .when(pl.col("_r2") >= 0.5)
            .then(pl.lit("medium"))
            .otherwise(pl.lit("low"))
            .alias(f"rent_confidence_{key}")
        ).drop("_r2")
        out = r if out is None else out.join(r, on="code", how="full", coalesce=True)
    return out


def rei(raw: Path, x: dict) -> pl.DataFrame:
    cols = ["E12", "E22", "E32", "E52", "E52gGEMAPI", "E13", "E14", "TXMAJOTHRS", "B12"]
    r = _zip_csv(raw / "rei-2025.zip", "REI_2025.csv", separator=";", encoding="latin1",
                 columns=["DEP", "COM", *cols])
    r = r.filter(pl.col("DEP").is_in(DEPTS)).with_columns((pl.col("DEP") + pl.col("COM")).alias("code"), *_num(cols))
    r = r.with_columns(
        (pl.sum_horizontal("E12", "E22", "E32", "E52", "E52gGEMAPI")).alias("tfpb_rate"),
        (pl.col("E13") / pl.col("E14")).alias("tfpb_commune_avg_eur"),
        pl.col("TXMAJOTHRS").fill_null(0).alias("second_home_surcharge"),
        pl.col("B12").alias("tfnb_rate_commune"),
    )
    # Average TOTAL property tax per tax account: the commune's share (E13/E14)
    # scaled by total rate / commune rate (all bodies tax the same base).
    r = r.with_columns(
        pl.when(pl.col("E12") > 0).then(pl.col("tfpb_commune_avg_eur") * pl.col("tfpb_rate") / pl.col("E12"))
        .alias("tfpb_total_avg_eur")
    )
    return remap(r, x).group_by("code").agg(
        pl.col("tfpb_rate").mean(), pl.col("tfpb_commune_avg_eur").mean(), pl.col("tfpb_total_avg_eur").mean(),
        pl.col("second_home_surcharge").max(), pl.col("tfnb_rate_commune").mean(),
    )


def zoning(raw: Path, x: dict) -> pl.DataFrame:
    t = pl.read_csv(raw / "zonage-tlv-2025.csv", separator=";", infer_schema_length=0)
    t = t.select(pl.col("CODGEO25").alias("code"),
                 pl.col("Zonage TLV post décret 22/12/2025").alias("tlv"))
    t = t.filter(pl.col("code").str.slice(0, 2).is_in(DEPTS)).with_columns(
        # Category 1 = zone tendue, 2 = zone touristique et tendue (also tense), 3 = non tendue.
        pl.col("tlv").str.contains(r"^[12]").alias("zone_tendue"),
        pl.col("tlv").str.starts_with("2").alias("zone_tendue_touristique"),
    )
    a = pl.read_csv(raw / "zonage-abc-2026.csv", separator=";", infer_schema_length=0)
    a = a.select(pl.col("CODGEO").alias("code"), pl.col(a.columns[3]).alias("zone_abc"))
    a = a.filter(pl.col("code").str.slice(0, 2).is_in(DEPTS))
    t = remap(t, x).group_by("code").agg(pl.col("zone_tendue").any(), pl.col("zone_tendue_touristique").any(),
                                         pl.col("tlv").first())
    a = remap(a, x).group_by("code").agg(pl.col("zone_abc").first())
    return t.join(a, on="code", how="full", coalesce=True)


def gaspar(raw: Path, x: dict) -> pl.DataFrame:
    z = zipfile.ZipFile(raw / "gaspar.zip")
    name = {n.split("_")[0]: n for n in z.namelist()}

    c = pl.read_csv(z.open(name["catnat"]).read(), separator=";", infer_schema_length=0)
    c = c.filter(pl.col("code_commune").str.slice(0, 2).is_in(DEPTS) & (pl.col("date_debut") >= CATNAT_SINCE))
    c = c.rename({"code_commune": "code"}).with_columns(
        pl.when(pl.col("lib_risque_jo").str.contains("(?i)inondation|coulée|nappe")).then(pl.lit("flood"))
        .when(pl.col("lib_risque_jo").str.contains("(?i)sécheresse")).then(pl.lit("drought"))
        .when(pl.col("lib_risque_jo").str.contains("(?i)vagues")).then(pl.lit("coast"))
        .otherwise(pl.lit("other")).alias("kind")
    )
    # One arrêté can list several perils: count distinct events per kind.
    c = remap(c, x).unique(subset=["code", "id_gaspar", "kind"])
    cat = c.group_by("code").agg(
        *(((pl.col("kind") == k).sum()).alias(f"catnat_{k}") for k in ("flood", "drought", "coast", "other")),
        pl.len().alias("catnat_total"),
    )

    d = pl.read_csv(z.open(name["ddrm"]).read(), separator=";", infer_schema_length=0)
    d = remap(d.filter(pl.col("cod_commune").str.slice(0, 2).is_in(DEPTS)).rename({"cod_commune": "code"}), x)
    flags = {
        "risk_flood": ["11", "112", "113", "114", "116"],
        "risk_marine_flood": ["117"],
        "risk_clay": ["127"],
        "risk_coast_erosion": ["125", "126"],
        "risk_forest_fire": ["16"],
        "risk_seismic": ["13"],
        "risk_industrial": ["21", "211", "212", "213", "214"],
        "risk_nuclear": ["22"],
        "risk_dam": ["23"],
        "risk_mining": ["31", "311", "312", "313", "314", "315", "316", "317"],
    }
    ddrm = d.group_by("code").agg(*(pl.col("num_risque").is_in(v).any().alias(k) for k, v in flags.items()))

    def plans(prefix: str) -> pl.DataFrame:
        p = pl.read_csv(z.open(name[prefix]).read(), separator=";", infer_schema_length=0)
        p = p.filter(pl.col("CODE INSEE COMMUNE").str.slice(0, 2).is_in(DEPTS)
                     & pl.col("LIBELLE ETAT").is_in(["Opposable", "Prescrit"]))
        return remap(p.rename({"CODE INSEE COMMUNE": "code"}), x)

    pn = plans("pprn")
    risk_text = pl.concat_str([pl.col("LIBELLE RISQUE 2").fill_null(""), pl.col("LIBELLE RISQUE 3").fill_null("")])
    ppr = pn.group_by("code").agg(
        risk_text.str.contains("Inondation").any().alias("ppr_flood"),
        risk_text.str.contains("submersion").any().alias("ppr_marine"),
        risk_text.str.contains("Feu").any().alias("ppr_fire"),
        risk_text.str.contains("trait de côte|dunaire").any().alias("ppr_coast"),
    )
    pt = plans("pprt").group_by("code").agg(pl.lit(True).alias("ppr_industrial"))

    out = cat
    for t in (ddrm, ppr, pt):
        out = out.join(t, on="code", how="full", coalesce=True)
    return out


def radon(raw: Path, x: dict) -> pl.DataFrame:
    r = pl.read_csv(raw / "radon.csv", separator=";", infer_schema_length=0)
    r = r.with_columns(pl.col("insee_com").str.zfill(5).alias("code"),
                       pl.col("classe_potentiel").cast(pl.Int8, strict=False).alias("radon_class"))
    r = r.filter(pl.col("code").str.slice(0, 2).is_in(DEPTS))
    return remap(r, x).group_by("code").agg(pl.col("radon_class").max())


def insee(raw: Path, x: dict) -> pl.DataFrame:
    h = _zip_csv(raw / "serie-historique-2022.zip", "base-cc-serie-historique-2022.CSV", separator=";")
    h = h.filter(pl.col("CODGEO").str.slice(0, 2).is_in(DEPTS)).rename({"CODGEO": "code"})
    num = ["P22_POP", "P11_POP", "SUPERF", "P22_LOG", "P22_RSECOCC", "P22_LOGVAC", "P22_RP"]
    h = remap(h.with_columns(*_num(num)), x).group_by("code").agg(*(pl.col(c).sum() for c in num))
    h = h.with_columns(
        pl.col("P22_POP").alias("pop"),
        ((pl.col("P22_POP") / pl.col("P11_POP")) ** (1 / 11) - 1).alias("pop_cagr_11y"),
        (pl.col("P22_POP") / pl.col("SUPERF")).alias("density"),
        (pl.col("P22_RSECOCC") / pl.col("P22_LOG")).alias("second_home_share"),
        (pl.col("P22_LOGVAC") / pl.col("P22_LOG")).alias("vacancy_rate"),
        pl.col("P22_LOG").alias("dwellings"),
    ).select("code", "pop", "pop_cagr_11y", "density", "second_home_share", "vacancy_rate", "dwellings")

    f = _zip_csv(raw / "filosofi-2021.zip", "DS_FILOSOFI_CC_data.csv", separator=";")
    f = f.filter(pl.col("GEO").str.slice(0, 2).is_in(DEPTS) & (pl.col("GEO_OBJECT") == "COM")
                 & pl.col("FILOSOFI_MEASURE").is_in(["MED_SL", "PR_MD60"]))
    f = f.with_columns(pl.col("OBS_VALUE").cast(pl.Float64, strict=False)).pivot(
        on="FILOSOFI_MEASURE", index="GEO", values="OBS_VALUE", aggregate_function="first")
    f = f.rename({"GEO": "code", "MED_SL": "median_income"})
    f = f.rename({"PR_MD60": "poverty_rate"}) if "PR_MD60" in f.columns else f
    f = remap(f, x).group_by("code").agg(pl.all().mean())

    t = _zip_csv(raw / "tourism-2025.zip", "DS_TOUR_CAP_2025_data.csv", separator=";")
    t = t.filter(pl.col("GEO").str.slice(0, 2).is_in(DEPTS) & (pl.col("GEO_OBJECT") == "COM")
                 & (pl.col("UNIT_LOC_RANKING") == "_T") & (pl.col("L_STAY") == "_T"))
    t = t.with_columns(pl.col("OBS_VALUE").cast(pl.Float64, strict=False))
    sel = {
        ("I551", "PLACE"): "hotel_rooms",
        ("I553", "PLACE"): "camping_pitches",
        ("I552", "BEDPLACE"): "other_tourist_beds",
    }
    t = t.with_columns(
        pl.concat_str(["ACTIVITY", "TOUR_MEASURE"], separator="|").alias("k")
    ).filter(pl.col("k").is_in(["|".join(k) for k in sel]))
    t = t.with_columns(pl.col("k").replace({"|".join(k): v for k, v in sel.items()}))
    t = t.pivot(on="k", index="GEO", values="OBS_VALUE", aggregate_function="sum").rename({"GEO": "code"})
    for v in sel.values():
        if v not in t.columns:
            t = t.with_columns(pl.lit(0.0).alias(v))
    t = remap(t, x).group_by("code").agg(*(pl.col(v).sum() for v in sel.values()))
    # INSEE convention for tourist-bed capacity: hotel room = 2 beds, camping pitch = 3.
    t = t.with_columns((2 * pl.col("hotel_rooms") + 3 * pl.col("camping_pitches")
                        + pl.col("other_tourist_beds")).alias("tourist_beds"))
    return h.join(f, on="code", how="full", coalesce=True).join(t, on="code", how="full", coalesce=True)


def drought(raw: Path, x: dict) -> pl.DataFrame:
    rows = vigieau.drought_metrics(raw / "vigieau" / "historique-communes.zip", DEPTS, DROUGHT_YEARS)
    d = remap(pl.DataFrame(rows), x)
    return d.group_by("code").agg(pl.all().max())


def living_themes(raw: Path, x: dict, base: pl.DataFrame, feats: list[dict]) -> dict[str, pl.DataFrame]:
    ex = raw / "extra"
    centres = {r["code"]: (r["lon"], r["lat"]) for r in base.iter_rows(named=True)}
    counts = living.bpe_counts(ex / "bpe-com.zip", set(DEPTS))
    clay_parts = []
    for d in DEPTS:
        z = raw / dep_dir(d) / "alearg.zip"
        if z.exists():
            clay_parts.append(living.clay(z, {"features": [f for f in feats if f["properties"]["dep"] == d]}))
    return {
        "clay": pl.concat(clay_parts, how="vertical_relaxed").with_columns(pl.exclude("code").cast(pl.Float64)),
        "apl": living.apl(ex / "apl-medecins.xlsx", DEPTS, x),
        "coast": living.coast_decree(ex / "trait-de-cote-2026.csv", DEPTS, x),
        "fibre": living.fibre(ex / "arcep-debit-filaire.csv", DEPTS, x),
        "aav": living.aav(ex / "aav2020.zip", DEPTS, x),
        "water": living.water_quality([raw / dep_dir(d) / "dis-plv-2025.txt" for d in DEPTS],
                                      ex / "dis-com-udi-2025.txt", DEPTS, x),
        "services": living.services(counts, centres, base, x),
    }


def dvf_themes(raw: Path, x: dict) -> dict[str, pl.DataFrame]:
    """DVF is processed one département at a time to keep memory low."""
    parts: dict[str, list[pl.DataFrame]] = {"prices": [], "trend": [], "land": [], "history": []}
    for d in DEPTS:
        files = [raw / dep_dir(d) / f"dvf-{y}.csv.gz" for y in DVF_YEARS]
        files = [f for f in files if f.exists()]
        if not files:
            continue
        df = dvf.load(files)
        sales = remap(dvf.dwelling_sales(df), x)
        parts["prices"].append(dvf.price_metrics(sales, DVF_END))
        parts["trend"].append(dvf.price_trend(sales, DVF_END))
        parts["land"].append(dvf.land_metrics(remap(df, x, col="code_commune"), DVF_END))
        parts["history"].append(dvf.price_by_year(sales, DVF_YEARS))
    return {k: pl.concat(v, how="diagonal_relaxed") for k, v in parts.items()}


def demand_themes(raw: Path, x: dict, base: pl.DataFrame) -> dict[str, pl.DataFrame]:
    ex = raw / "extra"
    return {
        "census": demand.census(ex / "rp2023-communes.json", DEPTS, x),
        "dpe": demand.dpe(ex / "dpe-communes.json", DEPTS, x),
        "crime": demand.crime(ex / "delinquance-2025.parquet", DEPTS, x),
        "schools": demand.schools(ex / "fr-en-ips-colleges-ap2023.csv", ex / "fr-en-indicateurs-de-resultat-des-lycees-gt_v2.csv", base, x),
        "students": demand.students(ex / "students-2025.json", DEPTS, x, base),
    }


def contamination_themes(raw: Path, x: dict) -> dict[str, pl.DataFrame]:
    ex = raw / "extra"
    return {
        "tapwater": contamination.water_substances(
            [raw / dep_dir(d) / "dis-result-2025.parquet" for d in DEPTS],
            [raw / dep_dir(d) / "dis-plv-2025.txt" for d in DEPTS], ex / "dis-com-udi-2025.txt", DEPTS, x),
        "soil": contamination.soil(ex / "casias.csv", ex / "ssp-instruction.csv", ex / "sis.csv", x),
    }


# Heavy steps cached as parquet in raw/build/ (delete theme-<step>.json to recompute one).
CACHED = ("dvf", "drought", "living", "demand", "contamination")

# ---------------------------------------------------------------- assemble
COLUMNS = {
    # key: (unit, description)
    "price_m2_apt": ("€/m²", "Median sale price per m², flats, last 24 months (DVF)"),
    "price_m2_house": ("€/m²", "Median sale price per m², houses, last 24 months (DVF)"),
    "price_median_house": ("€", "Median house sale price, last 24 months (DVF)"),
    "n_sales_apt": ("count", "Single-flat sales used"),
    "n_sales_house": ("count", "Single-house sales used"),
    "price_trend_3y": ("ratio", "All-dwelling €/m² change, last 12 months vs 3 years earlier"),
    "land_price_m2": ("€/m²", "Median building-land price per m², last 36 months (DVF)"),
    "n_land_sales": ("count", "Building-land sales used"),
    "rent_m2_apt": ("€/m²/month", "Listing rent, flats, charges incl., unfurnished (ANIL 2025)"),
    "rent_m2_house": ("€/m²/month", "Listing rent, houses, charges incl., unfurnished (ANIL 2025)"),
    "rent_confidence_apt": ("enum", "ANIL reliability: high / medium / low"),
    "rent_confidence_house": ("enum", "ANIL reliability: high / medium / low"),
    "gross_yield_apt": ("ratio", "rent_m2_apt × 12 / price_m2_apt"),
    "gross_yield_house": ("ratio", "rent_m2_house × 12 / price_m2_house"),
    "tfpb_rate": ("%", "Total built-property tax rate (commune+EPCI+syndicates+TSE+GEMAPI), REI 2025"),
    "tfpb_commune_avg_eur": ("€", "Average commune share of taxe foncière per tax unit, REI 2025"),
    "second_home_surcharge": ("%", "Taxe d'habitation surcharge on second homes (0–60), REI 2025"),
    "zone_tendue": ("bool", "Zone tendue (TLV), décret 22/12/2025"),
    "zone_tendue_touristique": ("bool", "Tense tourist zone (TLV category 2)"),
    "zone_abc": ("enum", "Housing zone A bis / A / B1 / B2 / C (26/06/2026)"),
    "pop": ("people", "Population 2022 (INSEE RP)"),
    "pop_cagr_11y": ("ratio/yr", "Population growth per year 2011–2022"),
    "density": ("people/km²", "Population density 2022"),
    "second_home_share": ("ratio", "Second homes / all dwellings 2022"),
    "vacancy_rate": ("ratio", "Vacant / all dwellings 2022"),
    "median_income": ("€/yr", "Median disposable income per consumption unit 2021 (Filosofi)"),
    "poverty_rate": ("%", "Poverty rate 2021 (Filosofi)"),
    "tourist_beds": ("beds", "Hotel rooms×2 + camping pitches×3 + other collective beds (INSEE 2025)"),
    "tourist_beds_per_1000": ("beds/1000 hab", "Tourist beds per 1000 residents"),
    "catnat_flood": ("count", "Flood / mudflow natural-disaster decrees since 1996"),
    "catnat_drought": ("count", "Drought (clay subsidence) natural-disaster decrees since 1996"),
    "catnat_total": ("count", "All natural-disaster decrees since 1996"),
    "risk_flood": ("bool", "Flood risk declared (GASPAR)"),
    "risk_marine_flood": ("bool", "Marine submersion risk declared"),
    "risk_forest_fire": ("bool", "Forest-fire risk declared"),
    "risk_clay": ("bool", "Clay shrink-swell (tassements différentiels) risk declared"),
    "risk_industrial": ("bool", "Industrial risk declared"),
    "ppr_flood": ("bool", "Flood risk-prevention plan in force or prescribed"),
    "ppr_fire": ("bool", "Forest-fire risk-prevention plan in force or prescribed"),
    "ppr_industrial": ("bool", "Technological risk-prevention plan (PPRT)"),
    "radon_class": ("1–3", "Radon potential class (ASNR)"),
    "drought_days_avg": ("days/yr", "Days at ≥ 'alerte renforcée' water restriction, avg 2021–2025 (VigiEau)"),
    "crisis_days_avg": ("days/yr", "Days at 'crise' water restriction, avg 2021–2025"),
    "drinking_water_days_avg": ("days/yr", "Days with drinking-water restriction ≥ 'alerte', avg 2021–2025"),
    "catnat_coast": ("count", "Wave-shock natural-disaster decrees since 1996"),
    "risk_coast_erosion": ("bool", "Coastal erosion / dune advance risk declared"),
    "ppr_coast": ("bool", "Coastal risk-prevention plan in force or prescribed"),
    "coast_retreat_decree": ("bool", "Listed by decree as exposed to coastline retreat (2026)"),
    "clay_high_share": ("ratio", "Share of commune area in high clay shrink-swell exposure (2026 map)"),
    "clay_medium_share": ("ratio", "Share of commune area in medium clay exposure"),
    "clay_med_high_share": ("ratio", "Share of commune area in medium or high clay exposure"),
    "apl_gp": ("consult/yr/hab", "GP accessibility (DREES APL)"),
    "apl_gp_65": ("consult/yr/hab", "GP accessibility counting only GPs aged 65 or less"),
    "fibre_share": ("ratio", "Share of premises eligible to ≥1 Gbit/s (fibre), ARCEP"),
    "thd_share": ("ratio", "Share of premises eligible to ≥30 Mbit/s"),
    "aav_category": ("enum", "Position in INSEE city attraction area 2020"),
    "aav_name": ("text", "City attraction area"),
    "aav_size": ("enum", "Size class of the attraction area"),
    "water_limit_breach_share": ("ratio", "Share of 2025 drinking-water samples breaking a health limit"),
    "water_reference_breach_share": ("ratio", "Share of 2025 samples breaking a quality reference"),
    "pesticide_samples": ("count", "2025 tap-water samples analysed for pesticides"),
    "pesticide_breach_share": ("ratio", "Share of those samples with a pesticide or metabolite over its limit"),
    "pfas_samples": ("count", "2025 tap-water samples analysed for the sum of 20 PFAS"),
    "pfas_max": ("µg/L", "Highest sum of 20 PFAS measured in 2025 (limit 0.1 µg/L)"),
    "pfas_breach_share": ("ratio", "Share of PFAS samples over 0.1 µg/L"),
    "casias_count": ("count", "CASIAS former industrial / service sites (Géorisques)"),
    "casias_per_km2": ("sites/km²", "CASIAS sites per km²"),
    "polluted_site_count": ("count", "Sites with known soil pollution under State action (ex-BASOL)"),
    "sis_count": ("count", "Secteurs d'information sur les sols (SIS)"),
    "gp_count": ("count", "GPs in the commune (BPE 2025)"),
    "tfpb_total_avg_eur": ("€", "Average total property tax per tax account (estimate from REI 2025)"),
    "tenant_share": ("ratio", "Tenants / main residences (RP 2023)"),
    "private_rent_share": ("ratio", "Private unfurnished tenants / main residences"),
    "furnished_share": ("ratio", "Furnished tenants / main residences"),
    "social_share": ("ratio", "Social housing tenants / main residences"),
    "unemployment_rate": ("ratio", "Unemployed / active population aged 15-64 (RP 2023)"),
    "jobs": ("count", "Jobs located in the commune (RP 2023)"),
    "jobs_per_active": ("ratio", "Jobs in the commune / active residents"),
    "students": ("count", "Higher-education students enrolled in the commune (2025-26)"),
    "students_per_1000": ("per 1000", "Students per 1000 residents"),
    "dpe_count": ("count", "Energy diagnostics (DPE) since July 2021"),
    "dpe_fg_share": ("ratio", "Share of DPE rated F or G"),
    "dpe_g_share": ("ratio", "Share of DPE rated G"),
    "crime_burglary": ("per 1000 dwellings", "Residential burglaries 2025 (SSMSI)"),
    "crime_violence": ("per 1000", "Physical violence outside the family 2025"),
    "crime_damage": ("per 1000", "Deliberate damage 2025"),
    "crime_theft": ("per 1000", "Theft without violence against people 2025"),
    "crime_estimated": ("bool", "Crime figures are département averages for small numbers"),
    "college_ips": ("index", "Social-position index of public collèges (100 ≈ national average)"),
    "lycee_success": ("%", "Baccalauréat success rate of public general/technological lycées"),
    "lycee_value_added": ("points", "Lycée value added (success vs expected)"),
    **{f"dist_{k}_km": ("km", f"Distance to nearest commune with: {k} (BPE 2025)") for k in living.SERVICES},
}


def build(raw: Path, out: Path) -> None:
    import time

    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    x = load_crosswalk(raw / "v_mvt_commune_2026.csv")
    base, feats = spine(raw)
    valid = set(base["code"].to_list())
    print(f"spine: {base.height} communes in {len(DEPTS)} départements ({time.time() - t0:.0f}s)", flush=True)

    themes: dict[str, pl.DataFrame] = {}
    steps = [
        ("dvf", lambda: dvf_themes(raw, x)),
        ("rents", lambda: {"rents": rents(raw, x)}),
        ("tax", lambda: {"tax": rei(raw, x)}),
        ("zoning", lambda: {"zoning": zoning(raw, x)}),
        ("risk", lambda: {"risk": gaspar(raw, x)}),
        ("radon", lambda: {"radon": radon(raw, x)}),
        ("insee", lambda: {"insee": insee(raw, x)}),
        ("drought", lambda: {"drought": drought(raw, x)}),
        ("living", lambda: living_themes(raw, x, base, feats)),
        ("demand", lambda: demand_themes(raw, x, base)),
        ("contamination", lambda: contamination_themes(raw, x)),
    ]
    for name, fn in steps:
        t = time.time()
        # Heavy steps are cached as parquet in raw/build/ (delete the folder to recompute).
        cache = raw / "build" / f"theme-{name}.json"
        if name in CACHED and cache.exists():
            names = json.loads(cache.read_text())
            themes.update({k: pl.read_parquet(raw / "build" / f"theme-{k}.parquet") for k in names})
            print(f"  {name:8s} cached", flush=True)
            continue
        part = fn()
        themes.update(part)
        if name in CACHED:
            (raw / "build").mkdir(exist_ok=True)
            for k, v in part.items():
                v.write_parquet(raw / "build" / f"theme-{k}.parquet")
            cache.write_text(json.dumps(list(part)))
        print(f"  {name:8s} done ({time.time() - t:.0f}s)", flush=True)

    df = base
    report = {}
    for name, t in themes.items():
        codes = set(t["code"].to_list())
        report[name] = {"matched": len(codes & valid), "unmatched": sorted(codes - valid)[:20]}
        df = df.join(t, on="code", how="left")

    df = df.with_columns(
        (pl.col("rent_m2_apt") * 12 / pl.col("price_m2_apt")).alias("gross_yield_apt"),
        (pl.col("rent_m2_house") * 12 / pl.col("price_m2_house")).alias("gross_yield_house"),
        (pl.col("tourist_beds") / pl.col("pop") * 1000).alias("tourist_beds_per_1000"),
        (pl.col("students").fill_null(0) / pl.col("pop") * 1000).alias("students_per_1000"),
        # Absent from the Géorisques inventories = no site listed.
        *(pl.col(c).fill_null(0) for c in ("casias_count", "polluted_site_count", "sis_count") if c in df.columns),
    )
    if "casias_count" in df.columns:  # area (km²) = population / density
        df = df.with_columns((pl.col("casias_count") * pl.col("density") / pl.col("pop")).alias("casias_per_km2"))
    # Boolean risk flags: absent from a source list means "not declared", not unknown.
    bool_cols = [c for c, (u, _) in COLUMNS.items() if u == "bool" and c in df.columns]
    df = df.with_columns(*(pl.col(c).fill_null(False) for c in bool_cols))
    count_cols = ["catnat_flood", "catnat_drought", "catnat_coast", "catnat_other", "catnat_total",
                  "n_sales_apt", "n_sales_house", "n_land_sales", "hotel_rooms", "camping_pitches",
                  "tourist_beds", "gp_count", "students", "dpe_count"]
    df = df.with_columns(*(pl.col(c).fill_null(0) for c in count_cols if c in df.columns))
    df = df.sort("code")
    # Divisions by zero (0 dwellings, 0 population, a zero-area polygon) give NaN/inf: treat as missing.
    floats = [c for c, t in df.schema.items() if t == pl.Float64]
    bad = {c: int(df[c].is_nan().sum() + df[c].is_infinite().sum()) for c in floats}
    bad = {c: n for c, n in bad.items() if n}
    if bad:
        print("  NaN/inf -> null:", bad, flush=True)
    df = df.with_columns(*(pl.when(pl.col(c).is_finite()).then(pl.col(c)).otherwise(None).alias(c) for c in floats))

    floats = [c for c, t in df.schema.items() if t == pl.Float64]
    df = df.with_columns(*(pl.col(c).round(4) for c in floats))
    # Columnar JSON: one array per column. ~35k communes compress far better
    # this way than as an array of objects repeating every key.
    keep = [c for c in df.columns if not c.endswith(("_low", "_high")) and not c.startswith("rent_level")
            and c not in ("epci",)]
    cols = {c: df[c].to_list() for c in keep}
    (out / "communes.json").write_text(json.dumps({"n": df.height, "cols": cols}, ensure_ascii=False,
                                                  separators=(",", ":"), allow_nan=False))
    write_tiles(raw, out, feats)

    coverage = {c: round(1 - df[c].null_count() / df.height, 3) for c in COLUMNS if c in df.columns}
    seen_groups: set[str] = set()
    sources = []
    for s in SOURCES:
        if s.group:
            if s.group in seen_groups:
                continue
            seen_groups.add(s.group)
        sources.append({"key": s.group or s.key, "producer": s.producer, "licence": s.licence,
                        "vintage": s.vintage + (" (fichiers par département)" if s.group else ""),
                        "url": s.url, "credit": s.credit})
    # Datasets fetched by dedicated scripts (dpe_fetch, melodi_fetch) or as single extra files.
    sources += [
        {"key": "dpe", "producer": "ADEME – DPE logements existants (depuis juillet 2021)", "licence": "Licence Ouverte 2.0",
         "vintage": "extraction 2026-10", "url": "https://data.ademe.fr/datasets/dpe03existant", "credit": None},
        {"key": "census", "producer": "INSEE – Recensement de la population 2023 (API Melodi)", "licence": "Licence Ouverte 2.0",
         "vintage": "RP 2023", "url": "https://api.insee.fr/melodi/", "credit": None},
        {"key": "crime", "producer": "Ministère de l’Intérieur – SSMSI, délinquance enregistrée par commune", "licence": "Licence Ouverte 2.0",
         "vintage": "2016–2025", "url": "https://www.data.gouv.fr/fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/", "credit": None},
        {"key": "schools", "producer": "Ministère de l’Éducation nationale – IPS des collèges, IVAL des lycées GT", "licence": "Licence Ouverte 2.0",
         "vintage": "rentrée 2025 / session 2025", "url": "https://data.education.gouv.fr/", "credit": None},
        {"key": "students", "producer": "MESR – Atlas régional des effectifs étudiants", "licence": "Licence Ouverte 2.0",
         "vintage": "rentrée 2025", "url": "https://data.enseignementsup-recherche.gouv.fr/", "credit": None},
        {"key": "tapwater", "producer": "Ministère de la Santé – contrôle sanitaire de l’eau distribuée, résultats par paramètre (pesticides, PFAS)",
         "licence": "Licence Ouverte 2.0", "vintage": "analyses 2025", "url": DIS_2025, "credit": None},
        {"key": "soil", "producer": "Géorisques / BRGM – CASIAS, sites et sols pollués (ex-BASOL), secteurs d’information sur les sols (SIS)",
         "licence": "Licence Ouverte 2.0", "vintage": "extraction 2026-10", "url": "https://www.georisques.gouv.fr/donnees/bases-de-donnees", "credit": None},
    ]
    meta = {
        "built": date.today().isoformat(),
        "scope": {"label": "France métropolitaine", "departements": len(DEPTS), "communes": df.height},
        "dvf_window_end": DVF_END,
        "drought_years": DROUGHT_YEARS,
        "sources": sources,
        "columns": {k: {"unit": u, "label": l} for k, (u, l) in COLUMNS.items()},
        "coverage": coverage,
        "join_report": report,
    }
    (out / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"wrote {df.height} communes -> {out} ({time.time() - t0:.0f}s)")
    for k, v in report.items():
        print(f"  {k:8s} matched {v['matched']:5d}  unmatched {len(v['unmatched'])}")
    print("  coverage < 95%:", {k: v for k, v in coverage.items() if v < 0.95})


def write_tiles(raw: Path, out: Path, feats: list[dict]) -> None:
    """Commune polygons -> one PMTiles file (vector tiles) with tippecanoe; département outlines -> small GeoJSON."""
    import subprocess

    tmp = raw / "build"
    tmp.mkdir(exist_ok=True)
    nd = tmp / "communes.geojsonl"
    with nd.open("w") as f:
        for ft in feats:
            f.write(json.dumps(ft, separators=(",", ":")) + "\n")
    target = out / "communes.pmtiles"
    cmd = ["tippecanoe", "-o", str(target), "--force", "-l", "communes", "-Z4", "-z11",
           "--detect-shared-borders", "--no-feature-limit", "--no-tile-size-limit",
           "--simplification=4", "--read-parallel", "-q", str(nd)]
    subprocess.run(cmd, check=True)
    nd.unlink()
    # Département outlines: dissolve the communes of each département (names from geo.api.gouv.fr).
    from shapely.ops import unary_union

    names = {d["code"]: d["nom"] for d in json.loads((raw / "departements.geojson").read_text())}
    by_dep: dict[str, list] = {}
    for ft in feats:
        by_dep.setdefault(ft["properties"]["dep"], []).append(shape(ft["geometry"]).buffer(0.0005).simplify(0.001))
    dep_feats = []
    for d in DEPTS:
        if d not in by_dep:
            continue
        g = unary_union(by_dep[d]).buffer(-0.0005).simplify(0.003, preserve_topology=True)
        dep_feats.append({"type": "Feature", "properties": {"code": d, "nom": names.get(d, d)}, "geometry": _round(mapping(g))})
    (out / "departements.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": dep_feats},
                                                         ensure_ascii=False, separators=(",", ":")))
    old = out / "communes.geojson"
    if old.exists():
        old.unlink()
    print(f"  tiles: {target.stat().st_size / 1e6:.1f} MB", flush=True)
