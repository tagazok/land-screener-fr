"""Tourist capacity per commune, year by year (INSEE, 2015-2026), and second homes (census 1968-2022).

Beds follow INSEE's convention: hotel room = 2 beds, camping pitch = 3 beds, plus the
beds of holiday villages, tourist residences and hostels. Three file formats over the years:
- 2015-2023 "base-cc-tourisme" (xls/xlsx/csv): HTCHyy, CPGEyy, VVLITyy, RTLITyy, AJCSLITyy.
- 2024-2025 "DS_TOUR_CAP" long CSV: ACTIVITY x TOUR_MEASURE.
- 2026 "TOUR_CAP.xlsx": one column per activity / measure / ranking, labelled in French.
Files live in raw/extra/tourism/tYYYY.zip.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import polars as pl

from .cog import remap

YEARS = list(range(2015, 2027))


def _old(z: zipfile.ZipFile, year: int) -> pl.DataFrame:
    name = next(n for n in z.namelist() if "meta" not in n.lower())
    b = z.read(name)
    if name.endswith((".xls", ".xlsx")):
        df = pl.read_excel(b, sheet_name="COM", read_options={"header_row": 5, "dtypes": "string"})
    else:
        df = pl.read_csv(io.BytesIO(b), separator=";", infer_schema_length=0)
    yy = f"{year % 100:02d}"
    num = lambda c: pl.col(c).cast(pl.Float64, strict=False).fill_null(0) if c in df.columns else pl.lit(0.0)
    return df.select(
        pl.col("CODGEO").cast(pl.Utf8).alias("code"),
        num(f"HTCH{yy}").alias("rooms"), num(f"CPGE{yy}").alias("pitches"),
        (num(f"VVLIT{yy}") + num(f"RTLIT{yy}") + num(f"AJCSLIT{yy}")).alias("other"),
    )


def _ds(z: zipfile.ZipFile) -> pl.DataFrame:
    name = next(n for n in z.namelist() if n.endswith("_data.csv"))
    t = pl.read_csv(io.BytesIO(z.read(name)), separator=";", infer_schema_length=0)
    t = t.filter((pl.col("GEO_OBJECT") == "COM") & (pl.col("UNIT_LOC_RANKING") == "_T") & (pl.col("L_STAY") == "_T"))
    t = t.with_columns(pl.col("OBS_VALUE").cast(pl.Float64, strict=False).fill_null(0),
                       pl.concat_str(["ACTIVITY", "TOUR_MEASURE"], separator="|").alias("k"))
    sel = {"I551|PLACE": "rooms", "I553|PLACE": "pitches", "I552|BEDPLACE": "other"}
    t = t.filter(pl.col("k").is_in(list(sel))).with_columns(pl.col("k").replace(sel))
    t = t.pivot(on="k", index="GEO", values="OBS_VALUE", aggregate_function="sum").rename({"GEO": "code"})
    for v in sel.values():
        if v not in t.columns:
            t = t.with_columns(pl.lit(0.0).alias(v))
    return t.select("code", "rooms", "pitches", "other")


def _xlsx2026(z: zipfile.ZipFile) -> pl.DataFrame:
    b = z.read(next(n for n in z.namelist() if n.endswith(".xlsx")))
    frames = []
    for sheet in ("COM", "ARM"):
        df = pl.read_excel(b, sheet_name=sheet, read_options={"header_row": None, "dtypes": "string"})
        head = [str(v or "") for v in df.row(0)]
        df = df.slice(1)

        def col(activity: str, measure: str) -> pl.Expr:
            for i, h in enumerate(head):
                parts = [p.strip() for p in h.split("*")]
                if len(parts) == 3 and parts[0].startswith(activity) and parts[1] == measure and parts[2] == "Total":
                    return pl.col(df.columns[i]).cast(pl.Float64, strict=False).fill_null(0)
            raise KeyError(f"{activity} / {measure}")

        frames.append(df.select(
            pl.col(df.columns[0]).alias("code"),
            col("Hôtels", "Nombre de places").alias("rooms"),
            col("Terrains de camping", "Nombre de places").alias("pitches"),
            (col("Villages vacances", "Nombre de place-lits") + col("Résidences de tourisme", "Nombre de place-lits")
             + col("Auberges de jeunesse", "Nombre de place-lits")).alias("other"),
        ))
    return pl.concat(frames)


def capacity_history(folder: Path, depts: list[str], x: dict) -> pl.DataFrame:
    """One row per commune: tour_beds_<year> for every year with a file, plus the 2019->2026 change."""
    out: pl.DataFrame | None = None
    for y in YEARS:
        path = folder / f"t{y}.zip"
        if not path.exists():
            continue
        z = zipfile.ZipFile(path)
        df = _xlsx2026(z) if y >= 2026 else _ds(z) if y >= 2024 else _old(z, y)
        df = df.filter(pl.col("code").str.slice(0, 2).is_in(depts))
        df = df.with_columns((2 * pl.col("rooms") + 3 * pl.col("pitches") + pl.col("other")).alias(f"tour_beds_{y}"))
        # Old vintages use old commune codes: remap to today's commune and sum merged communes.
        df = remap(df.select("code", f"tour_beds_{y}"), x).group_by("code").agg(pl.col(f"tour_beds_{y}").sum())
        out = df if out is None else out.join(df, on="code", how="full", coalesce=True)
    assert out is not None, "no tourism file"
    first, last = "tour_beds_2019", f"tour_beds_{max(y for y in YEARS if (folder / f't{y}.zip').exists())}"
    return out.with_columns(
        # Change in beds over the period; null when the commune had too few beds to compare.
        pl.when(pl.col(first) >= 20).then(pl.col(last) / pl.col(first) - 1).alias("tour_beds_change"),
        (pl.col(last) - pl.col(first)).alias("tour_beds_added"),
    )


def second_homes(serie_zip: Path, depts: list[str], x: dict) -> pl.DataFrame:
    """Second homes 2011, 2016, 2022 (census series) and their growth."""
    z = zipfile.ZipFile(serie_zip)
    name = next(n for n in z.namelist() if not n.startswith("meta") and n.upper().endswith(".CSV"))
    cols = ["CODGEO", "P22_RSECOCC", "P16_RSECOCC", "P11_RSECOCC", "P22_LOG", "P11_LOG"]
    d = pl.read_csv(io.BytesIO(z.read(name)), separator=";", columns=cols, infer_schema_length=0)
    d = d.rename({"CODGEO": "code"}).filter(pl.col("code").str.slice(0, 2).is_in(depts))
    d = d.with_columns(pl.exclude("code").cast(pl.Float64, strict=False))
    d = remap(d, x).group_by("code").agg(pl.all().sum())
    return d.select(
        "code",
        pl.col("P11_RSECOCC").alias("second_homes_2011"), pl.col("P16_RSECOCC").alias("second_homes_2016"),
        pl.col("P22_RSECOCC").alias("second_homes_2022"),
        pl.when(pl.col("P11_RSECOCC") >= 10).then(pl.col("P22_RSECOCC") / pl.col("P11_RSECOCC") - 1)
        .alias("second_homes_change"),
        (pl.col("P22_RSECOCC") / pl.col("P22_LOG") - pl.col("P11_RSECOCC") / pl.col("P11_LOG")).alias("second_home_share_change"),
    )
