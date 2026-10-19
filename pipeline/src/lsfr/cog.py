"""Commune code crosswalk to the current COG (built from INSEE v_mvt_commune)."""

from __future__ import annotations

from pathlib import Path

import polars as pl

# Event codes that move a commune's data to another code:
# 31 fusion simple, 32 création de commune nouvelle, 33 fusion-association,
# 34 transformation de fusion-association en fusion simple.
MERGE_MODS = {"31", "32", "33", "34"}

# Paris, Lyon and Marseille: many sources publish one row per arrondissement
# municipal (75101–75120, 69381–69389, 13201–13216). The app has one row per
# commune, so arrondissement codes are mapped to the city. Remapped rows are
# then aggregated by each theme's own group_by (sums for counts, means for
# rates); for prices the city median is recomputed from the pooled sales.
ARRONDISSEMENTS = {
    **{f"751{i:02d}": "75056" for i in range(1, 21)},
    **{f"6938{i}": "69123" for i in range(1, 10)},
    **{f"132{i:02d}": "13055" for i in range(1, 17)},
}


def load_crosswalk(mvt_csv: Path) -> dict[str, str]:
    m = pl.read_csv(mvt_csv, infer_schema_length=0)
    edges = (
        m.filter(
            pl.col("MOD").is_in(MERGE_MODS)
            & (pl.col("TYPECOM_AV") == "COM")
            & (pl.col("TYPECOM_AP") == "COM")
            & (pl.col("COM_AV") != pl.col("COM_AP"))
        )
        .sort("DATE_EFF")
        .select("COM_AV", "COM_AP")
        .rows()
    )
    step: dict[str, str] = {}
    for old, new in edges:
        step[old] = new
    out = {old: resolve(old, step) for old in step}
    out.update(ARRONDISSEMENTS)
    return out


def resolve(code: str, step: dict[str, str]) -> str:
    seen = set()
    while code in step and code not in seen:
        seen.add(code)
        code = step[code]
    return code


def remap(df: pl.DataFrame, xwalk: dict[str, str], col: str = "code") -> pl.DataFrame:
    """Replace retired commune codes by their current successor.

    Some files list Paris/Lyon/Marseille both as the city and as arrondissements:
    the arrondissement rows are then dropped so sums are not counted twice.
    """
    cities = set(ARRONDISSEMENTS.values())
    present = set(df[col].unique().to_list()) & cities
    if present:
        dup = [a for a, city in ARRONDISSEMENTS.items() if city in present]
        df = df.filter(~pl.col(col).is_in(dup))
    return df.with_columns(pl.col(col).replace(xwalk))
