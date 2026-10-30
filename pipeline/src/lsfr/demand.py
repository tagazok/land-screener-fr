"""Themes added 2026-10-19: rental demand (census 2023), energy ratings (DPE),
crime (SSMSI 2025), schools (IPS collèges, IVAL lycées) and students.

Every function returns one row per current commune code (or fewer).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import polars as pl
from scipy.spatial import cKDTree

from .cog import ARRONDISSEMENTS, remap
from .living import TO_L93


# ---------------------------------------------------------------- census 2023 (Melodi)
def census(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    """Tenure split of main residences, unemployment and local jobs (RP 2023)."""
    d = json.loads(path.read_text())
    keys = list(d)
    codes = sorted({c for k in keys for c in d[k] if c[:2] in depts})
    df = pl.DataFrame({"code": codes, **{k: [d[k].get(c) for c in codes] for k in keys}})
    df = remap(df, x).group_by("code").agg(*(pl.col(k).sum() for k in keys))
    main = pl.col("rp_main")
    return df.select(
        "code",
        (pl.col("rp_tenants") / main).alias("tenant_share"),
        (pl.col("rp_private_rent") / main).alias("private_rent_share"),
        (pl.col("rp_furnished") / main).alias("furnished_share"),
        (pl.col("rp_social") / main).alias("social_share"),
        (pl.col("unemployed_15_64") / pl.col("active_15_64")).alias("unemployment_rate"),
        pl.col("jobs").alias("jobs"),
        (pl.col("jobs") / pl.col("active_15_64")).alias("jobs_per_active"),
        # Parking demand. INSEE gives only margins (households with a car / with a reserved spot),
        # so the deficit is an estimate: car households minus households with a spot, assuming
        # every household with a spot has a car (it underestimates where spots go unused).
        *((
            (pl.col("rp_cars_ge1") / main).alias("car_share"),
            (pl.col("rp_with_spot") / main).alias("parking_spot_share"),
            ((pl.col("rp_cars_ge1") + pl.col("rp_cars_ge2")) / main).alias("cars_per_household"),
            ((pl.col("rp_cars_ge1") - pl.col("rp_with_spot")).clip(lower_bound=0) / main).alias("parking_gap_share"),
            (pl.col("rp_cars_ge1") - pl.col("rp_with_spot")).clip(lower_bound=0).alias("parking_gap"),
        ) if {"rp_cars_ge1", "rp_cars_ge2", "rp_with_spot"} <= set(keys) else ()),
    )


# ---------------------------------------------------------------- energy ratings
def dpe(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    """Share of diagnostics rated F or G (and G alone) since July 2021, per commune."""
    d = json.loads(path.read_text())
    rows = [(c, v[0], v[1], v[2]) for dep in depts for c, v in d.get(dep, {}).items()]
    df = pl.DataFrame(rows, schema=["code", "n", "fg", "g"], orient="row")
    # Here the city row (75056…) is a small residual of diagnostics geocoded to the
    # city, not a total: add arrondissements to it instead of dropping them.
    df = df.with_columns(pl.col("code").replace(ARRONDISSEMENTS))
    df = remap(df, x).group_by("code").agg(pl.col("n").sum(), pl.col("fg").sum(), pl.col("g").sum())
    return df.select(
        "code",
        pl.col("n").alias("dpe_count"),
        # Below 20 diagnostics a share is too noisy to show.
        pl.when(pl.col("n") >= 20).then(pl.col("fg") / pl.col("n")).alias("dpe_fg_share"),
        pl.when(pl.col("n") >= 20).then(pl.col("g") / pl.col("n")).alias("dpe_g_share"),
    )


# ---------------------------------------------------------------- crime
CRIME = {
    "Cambriolages de logement": "crime_burglary",            # per 1 000 dwellings
    "Violences physiques hors cadre familial": "crime_violence",  # per 1 000 inhabitants
    "Destructions et dégradations volontaires": "crime_damage",
    "Vols sans violence contre des personnes": "crime_theft",
}


def crime(path: Path, depts: list[str], x: dict, year: int = 2025) -> pl.DataFrame:
    """Recorded offences per 1 000 (SSMSI). Unpublished small numbers use the
    département average of unpublished communes, flagged as estimated."""
    d = pl.read_parquet(path, columns=["CODGEO_2026", "annee", "indicateur", "taux_pour_mille", "est_diffuse",
                                       "complement_info_taux"])
    d = d.filter((pl.col("annee") == year) & pl.col("indicateur").cast(pl.Utf8).is_in(list(CRIME))
                 & pl.col("CODGEO_2026").str.slice(0, 2).is_in(depts))
    d = d.with_columns(
        pl.col("indicateur").cast(pl.Utf8).replace(CRIME).alias("k"),
        pl.when(pl.col("est_diffuse") == "diff").then(pl.col("taux_pour_mille"))
        .otherwise(pl.col("complement_info_taux")).alias("rate"),
        (pl.col("est_diffuse") != "diff").alias("est"),
    ).rename({"CODGEO_2026": "code"})
    d = remap(d, x).group_by("code", "k").agg(pl.col("rate").mean(), pl.col("est").all())
    rates = d.pivot(on="k", index="code", values="rate")
    est = d.group_by("code").agg(pl.col("est").all().alias("crime_estimated"))
    return rates.join(est, on="code", how="left")


# ---------------------------------------------------------------- schools
def _nearest(values: dict[str, float], centres: dict[str, tuple[float, float]], communes: pl.DataFrame,
             name: str) -> pl.DataFrame:
    """For each commune: its own value, else the value of the nearest commune that has one (+ distance)."""
    have = [c for c in values if c in centres]
    rows = list(communes.iter_rows(named=True))
    xy = np.array([TO_L93(r["lon"], r["lat"]) for r in rows])
    tree = cKDTree(np.array([TO_L93(*centres[c]) for c in have]))
    dist, idx = tree.query(xy)
    out_v, out_d = [], []
    for r, dd, i in zip(rows, dist, idx):
        if r["code"] in values:
            out_v.append(values[r["code"]])
            out_d.append(0.0)
        else:
            out_v.append(values[have[i]])
            out_d.append(float(dd) / 1000)
    return pl.DataFrame({"code": [r["code"] for r in rows], name: out_v, f"{name}_km": out_d})


def schools(ips_csv: Path, ival_csv: Path, communes: pl.DataFrame, x: dict) -> pl.DataFrame:
    centres = {r["code"]: (r["lon"], r["lat"]) for r in communes.iter_rows(named=True)}

    ips = pl.read_csv(ips_csv, separator=";", infer_schema_length=0)
    last = ips["rentree_scolaire"].max()
    ips = ips.filter((pl.col("rentree_scolaire") == last) & (pl.col("secteur") == "public"))
    ips = ips.select(pl.col("code_insee_de_la_commune").alias("code"), pl.col("ips").cast(pl.Float64, strict=False))
    ips = remap(ips, x).group_by("code").agg(pl.col("ips").mean())
    a = _nearest(dict(ips.rows()), centres, communes, "college_ips")

    iv = pl.read_csv(ival_csv, separator=";", infer_schema_length=0)
    last = iv["annee"].max()
    iv = iv.filter((pl.col("annee") == last) & (pl.col("secteur") == "public"))
    iv = iv.select(pl.col("code_commune").alias("code"),
                   pl.col("taux_reu_total").cast(pl.Float64, strict=False),
                   pl.col("va_reu_total").cast(pl.Float64, strict=False),
                   pl.col("presents_total").cast(pl.Float64, strict=False))
    iv = remap(iv.drop_nulls("taux_reu_total"), x).group_by("code").agg(
        ((pl.col("taux_reu_total") * pl.col("presents_total")).sum() / pl.col("presents_total").sum()).alias("t"),
        ((pl.col("va_reu_total") * pl.col("presents_total")).sum() / pl.col("presents_total").sum()).alias("va"),
    )
    b = _nearest({c: t for c, t, _ in iv.rows()}, centres, communes, "lycee_success")
    c = _nearest({c: v for c, _, v in iv.rows() if v is not None}, centres, communes, "lycee_value_added")
    return a.join(b, on="code").join(c.drop("lycee_value_added_km"), on="code").with_columns(
        pl.lit(last).alias("lycee_year"))


# ---------------------------------------------------------------- students
def students(path: Path, depts: list[str], x: dict, pop: pl.DataFrame) -> pl.DataFrame:
    d = json.loads(path.read_text())["rows"]
    df = pl.DataFrame([(r["com_id"], float(r["students"] or 0)) for r in d if r["com_id"] and r["com_id"][:2] in depts],
                      schema=["code", "students"], orient="row")
    df = remap(df, x).group_by("code").agg(pl.col("students").sum())
    return df
