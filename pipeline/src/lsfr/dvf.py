"""DVF transforms: per-mutation dedupe, €/m² medians, price trend, land prices.

In DVF géolocalisées, `valeur_fonciere` is repeated on every row of a mutation
(one row per parcel × local), so prices must be computed per mutation, never
per row.
"""

from __future__ import annotations

import polars as pl

DWELLING = ("Maison", "Appartement")
PRICE_M2_BOUNDS = (300.0, 20_000.0)  # plausibility guard for Gironde
LAND_M2_BOUNDS = (2.0, 2_000.0)
MIN_SALES = 5


def load(paths: list) -> pl.DataFrame:
    df = pl.concat([pl.read_csv(p, infer_schema_length=0) for p in paths], how="vertical_relaxed")
    return df.with_columns(
        pl.col("valeur_fonciere").cast(pl.Float64, strict=False),
        pl.col("surface_reelle_bati").cast(pl.Float64, strict=False),
        pl.col("surface_terrain").cast(pl.Float64, strict=False),
        pl.col("date_mutation").str.to_date(),
    )


def dwelling_sales(df: pl.DataFrame) -> pl.DataFrame:
    """One row per mutation selling exactly one house or flat (outbuildings allowed).

    Returns: id_mutation, code, date, type_local, price, surface, price_m2.
    """
    sales = df.filter(pl.col("nature_mutation") == "Vente")
    # Count dispositions on ALL rows of the mutation, before any dedupe: a
    # dedupe that ignores numero_disposition keeps an arbitrary row and made
    # this count (and so the whole output) change from run to run.
    n_disp = sales.group_by("id_mutation").agg(pl.col("numero_disposition").n_unique().alias("n_dispositions"))
    # Dedupe locals repeated across parcels of the same mutation.
    locals_ = sales.unique(
        subset=["id_mutation", "type_local", "surface_reelle_bati", "nombre_pieces_principales", "lot1_numero"],
        maintain_order=True,
    )
    per_mut = locals_.group_by("id_mutation").agg(
        pl.col("code_commune").first().alias("code"),
        pl.col("date_mutation").first().alias("date"),
        pl.col("valeur_fonciere").first().alias("price"),
        pl.col("type_local").is_in(DWELLING).sum().alias("n_dwellings"),
        (pl.col("type_local") == "Local industriel. commercial ou assimilé").sum().alias("n_commercial"),
        pl.col("type_local").filter(pl.col("type_local").is_in(DWELLING)).first().alias("type_local"),
        pl.col("surface_reelle_bati").filter(pl.col("type_local").is_in(DWELLING)).first().alias("surface"),
    ).join(n_disp, on="id_mutation", how="left")
    lo, hi = PRICE_M2_BOUNDS
    return (
        per_mut.filter(
            (pl.col("n_dwellings") == 1)
            & (pl.col("n_commercial") == 0)
            & (pl.col("n_dispositions") == 1)
            & (pl.col("surface") >= 9)
            & (pl.col("price") > 0)
        )
        .with_columns((pl.col("price") / pl.col("surface")).alias("price_m2"))
        .filter(pl.col("price_m2").is_between(lo, hi))
        .select("id_mutation", "code", "date", "type_local", "price", "surface", "price_m2")
    )


def price_metrics(sales: pl.DataFrame, end: str) -> pl.DataFrame:
    """Median €/m² per commune and type over the 24 months ending at `end` (ISO date)."""
    end_d = pl.lit(end).str.to_date()
    recent = sales.filter((pl.col("date") > end_d.dt.offset_by("-24mo")) & (pl.col("date") <= end_d))
    out = []
    for t, key in (("Appartement", "apt"), ("Maison", "house")):
        g = (
            recent.filter(pl.col("type_local") == t)
            .group_by("code")
            .agg(
                pl.col("price_m2").median().alias(f"price_m2_{key}"),
                pl.col("price").median().alias(f"price_median_{key}"),
                pl.col("surface").median().alias(f"surface_median_{key}"),
                pl.len().alias(f"n_sales_{key}"),
            )
        )
        g = g.with_columns(
            pl.when(pl.col(f"n_sales_{key}") >= MIN_SALES).then(pl.col(f"price_m2_{key}")).alias(f"price_m2_{key}"),
            pl.when(pl.col(f"n_sales_{key}") >= MIN_SALES)
            .then(pl.col(f"price_median_{key}"))
            .alias(f"price_median_{key}"),
        )
        out.append(g)
    return out[0].join(out[1], on="code", how="full", coalesce=True)


def price_trend(sales: pl.DataFrame, end: str, min_n: int = 10) -> pl.DataFrame:
    """All-dwelling median €/m², last 12 months vs the 12 months three years earlier."""
    end_d = pl.lit(end).str.to_date()
    s = sales.with_columns(
        pl.when(pl.col("date") > end_d.dt.offset_by("-12mo"))
        .then(pl.lit("now"))
        .when((pl.col("date") > end_d.dt.offset_by("-48mo")) & (pl.col("date") <= end_d.dt.offset_by("-36mo")))
        .then(pl.lit("then"))
        .alias("window")
    ).filter(pl.col("window").is_not_null())
    g = s.group_by("code", "window").agg(pl.col("price_m2").median().alias("m"), pl.len().alias("n"))
    w = g.pivot(on="window", index="code", values=["m", "n"])
    for c in ("m_now", "m_then", "n_now", "n_then"):
        if c not in w.columns:
            w = w.with_columns(pl.lit(None).alias(c))
    return w.select(
        "code",
        pl.when((pl.col("n_now") >= min_n) & (pl.col("n_then") >= min_n))
        .then(pl.col("m_now") / pl.col("m_then") - 1)
        .alias("price_trend_3y"),
    )


def land_metrics(df: pl.DataFrame, end: str) -> pl.DataFrame:
    """Median €/m² for building-land sales (no built local) over the last 36 months."""
    end_d = pl.lit(end).str.to_date()
    land = df.filter(
        (pl.col("date_mutation") > end_d.dt.offset_by("-36mo"))
        & (
            (pl.col("nature_mutation") == "Vente terrain à bâtir")
            | ((pl.col("nature_mutation") == "Vente") & (pl.col("code_nature_culture") == "AB"))
        )
    )
    # A parcel appears once per land-use sub-part (nature de culture), each with
    # its own surface: keep every distinct sub-part, then sum.
    per_mut = (
        land.unique(subset=["id_mutation", "id_parcelle", "code_nature_culture", "surface_terrain"],
                    maintain_order=True)
        .group_by("id_mutation")
        .agg(
            pl.col("code_commune").first().alias("code"),
            pl.col("valeur_fonciere").first().alias("price"),
            pl.col("surface_terrain").sum().alias("area"),
            pl.col("type_local").drop_nulls().len().alias("n_locals"),
        )
        .filter((pl.col("n_locals") == 0) & (pl.col("area") >= 100) & (pl.col("price") > 0))
        .with_columns((pl.col("price") / pl.col("area")).alias("land_m2"))
        .filter(pl.col("land_m2").is_between(*LAND_M2_BOUNDS))
    )
    return per_mut.group_by("code").agg(
        pl.col("land_m2").median().alias("land_price_m2"),
        pl.col("area").median().alias("land_plot_median_m2"),
        pl.len().alias("n_land_sales"),
    ).with_columns(
        pl.when(pl.col("n_land_sales") >= 3).then(pl.col("land_price_m2")).alias("land_price_m2")
    )


def price_by_year(sales: pl.DataFrame, years: list[str], min_n: int = 5) -> pl.DataFrame:
    """Median €/m² and number of single-dwelling sales per commune, type and calendar year.

    Columns: hist_{house|apt}_{year} (null under `min_n` sales) and nhist_{house|apt}_{year}.
    """
    s = sales.with_columns(pl.col("date").dt.year().cast(pl.Utf8).alias("y"))
    s = s.filter(pl.col("y").is_in(years))
    out = None
    for t, key in (("Maison", "house"), ("Appartement", "apt")):
        g = s.filter(pl.col("type_local") == t).group_by("code", "y").agg(
            pl.col("price_m2").median().alias("m"), pl.len().alias("n"))
        g = g.with_columns(pl.when(pl.col("n") >= min_n).then(pl.col("m")).alias("m"))
        m = g.pivot(on="y", index="code", values="m")
        n = g.pivot(on="y", index="code", values="n")
        m = m.rename({y: f"hist_{key}_{y}" for y in years if y in m.columns})
        n = n.rename({y: f"nhist_{key}_{y}" for y in years if y in n.columns})
        part = m.join(n, on="code", how="full", coalesce=True)
        out = part if out is None else out.join(part, on="code", how="full", coalesce=True)
    return out