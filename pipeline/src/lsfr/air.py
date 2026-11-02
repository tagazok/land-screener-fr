"""Air quality per commune from the daily ATMO index (raw/air/YYYY-MM-DD.parquet, see air_fetch.py).

The ATMO index gives each day and pollutant a class: 1 bon, 2 moyen, 3 dégradé, 4 mauvais,
5 très mauvais, 6 extrêmement mauvais. A day counts as "dégradé" or "mauvais" when at least
one pollutant reaches that class. Counts are scaled to 365 days when some days are missing.
Communes are only covered where the regional AASQA publishes the index per commune.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

POLLUTANTS = {"code_no2": "dioxyde d’azote (NO₂)", "code_o3": "ozone (O₃)", "code_pm10": "particules PM10",
              "code_pm25": "particules fines PM2,5", "code_so2": "dioxyde de soufre (SO₂)"}
MIN_DAYS = 200


def metrics(folder: Path, x: dict) -> pl.DataFrame:
    from .cog import remap

    files = sorted(folder.glob("*.parquet"))
    df = pl.concat([pl.read_parquet(f) for f in files], how="diagonal_relaxed").rename({"code_zone": "code"})
    df = remap(df, x)
    cols = list(POLLUTANTS)
    df = df.with_columns(pl.max_horizontal(cols).alias("worst"))
    # The pollutant that sets the worst class that day (ties: the first in POLLUTANTS order).
    df = df.with_columns(pl.coalesce([pl.when(pl.col(c) == pl.col("worst")).then(pl.lit(c)) for c in cols]).alias("cause"))
    per_day = df.group_by("code", "date_ech").agg(pl.col("worst").max(), pl.col("cause").first())
    out = per_day.group_by("code").agg(
        pl.len().alias("air_days_known"),
        (pl.col("worst") >= 3).sum().alias("_deg"),
        (pl.col("worst") >= 4).sum().alias("_bad"),
        pl.col("cause").filter(pl.col("worst") >= 3).mode().first().alias("_cause"),
    ).filter(pl.col("air_days_known") >= MIN_DAYS)
    scale = 365 / pl.col("air_days_known")
    return out.select(
        "code", "air_days_known",
        (pl.col("_deg") * scale).round(0).alias("air_days_degraded"),
        (pl.col("_bad") * scale).round(0).alias("air_days_bad"),
        pl.col("_cause").replace_strict(POLLUTANTS, default=None).alias("air_main_pollutant"),
    )
