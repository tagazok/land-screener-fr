"""Contamination: pesticides and PFAS in tap water (2025), polluted-soil inventories (Géorisques).

Tap water: per-substance results (reduced by water_fetch) are tied to their sample
(referenceprel), the sample to its distribution network (cdreseau, PLV files), and the
network to the communes it serves (COM_UDI). A commune served by several networks pools
their samples.

Soil: counts per commune of CASIAS sites (former polluting activities, not proof of
pollution), sites with known pollution under State action (ex-BASOL) and SIS sectors.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

from .cog import ARRONDISSEMENTS, remap

PESTICIDE_LIMITS = {"<=0,1 µg/L": 0.1, "<=0.1 µg/L": 0.1, "<=0,03 µg/L": 0.03, "<=0.03 µg/L": 0.03}
PFAS_SUM = "SPFAS"        # "Somme de 20 PFAS", limit 0.1 µg/L (in force from 2026)
PFAS_LIMIT = 0.1
PEST_TOTAL = "PESTOT"     # "Total des pesticides analysés", limit 0.5 µg/L
PEST_TOTAL_LIMIT = 0.5


def water_substances(results: list[Path], plvs: list[Path], com_udi: Path, depts: list[str], x: dict) -> pl.DataFrame:
    r = pl.concat([pl.read_parquet(f) for f in results if f.exists()], how="diagonal_relaxed")
    lim = pl.col("limitequal").replace_strict(PESTICIDE_LIMITS, default=None, return_dtype=pl.Float64)
    code = pl.col("cdparametresiseeaux")
    pest = r.filter((lim.is_not_null() & (code != PFAS_SUM)) | (code == PEST_TOTAL)).with_columns(
        pl.when(code == PEST_TOTAL).then(pl.col("valtraduite") > PEST_TOTAL_LIMIT)
        .otherwise(pl.col("valtraduite") > lim).fill_null(False).alias("over"))
    pest_s = pest.group_by("referenceprel").agg(pl.col("over").any().alias("pest_over"))
    pfas_s = (r.filter(code == PFAS_SUM).group_by("referenceprel")
              .agg(pl.col("valtraduite").max().alias("pfas")))

    plv = pl.concat([pl.read_csv(f, infer_schema_length=0, columns=["referenceprel", "cdreseau"]) for f in plvs if f.exists()])
    plv = plv.unique()
    pest_n = plv.join(pest_s, on="referenceprel").group_by("cdreseau").agg(
        pl.len().alias("pest_n"), pl.col("pest_over").sum().alias("pest_bad"))
    pfas_n = plv.join(pfas_s, on="referenceprel").group_by("cdreseau").agg(
        pl.len().alias("pfas_n"), pl.col("pfas").max().alias("pfas_max"),
        (pl.col("pfas") > PFAS_LIMIT).sum().alias("pfas_bad"))

    link = pl.read_csv(com_udi, infer_schema_length=0).filter(pl.col("inseecommune").str.slice(0, 2).is_in(depts))
    link = link.select(pl.col("inseecommune").alias("code"), "cdreseau").unique()
    j = remap(link.join(pest_n, on="cdreseau", how="left").join(pfas_n, on="cdreseau", how="left"), x)
    return j.group_by("code").agg(
        pl.col("pest_n").sum().alias("pesticide_samples"),
        (pl.col("pest_bad").sum() / pl.col("pest_n").sum()).alias("pesticide_breach_share"),
        pl.col("pfas_n").sum().alias("pfas_samples"),
        pl.col("pfas_max").max().alias("pfas_max"),
        (pl.col("pfas_bad").sum() / pl.col("pfas_n").sum()).alias("pfas_breach_share"),
    ).with_columns(
        # No analysis at all means unknown, not clean.
        pl.when(pl.col("pesticide_samples") > 0).then(pl.col("pesticide_breach_share")).alias("pesticide_breach_share"),
        pl.when(pl.col("pfas_samples") > 0).then(pl.col("pfas_breach_share")).alias("pfas_breach_share"),
    )


def soil(casias: Path, instruction: Path, sis: Path, x: dict) -> pl.DataFrame:
    def count(path: Path, name: str) -> pl.DataFrame:
        d = pl.read_csv(path, infer_schema_length=0).filter(pl.col("code_insee").str.len_chars() == 5)
        # Points are listed under the arrondissement or the city: add both up, never drop one.
        d = d.select(pl.col("code_insee").replace(ARRONDISSEMENTS).alias("code"))
        d = remap(d, x)
        return d.group_by("code").agg(pl.len().alias(name))

    out = count(casias, "casias_count")
    for path, name in ((instruction, "polluted_site_count"), (sis, "sis_count")):
        out = out.join(count(path, name), on="code", how="full", coalesce=True)
    return out.with_columns(pl.exclude("code").fill_null(0))
