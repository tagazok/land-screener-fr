"""Individual property sales as map points: web/public/data/sales.pmtiles (layer "sales").

DVF géolocalisées, the 24 months ending at DVF_END. One point per mutation, at the
position of its first geolocated row. Kept: sales ("Vente" and off-plan "VEFA") of
exactly one house or flat (outbuildings allowed), of building land only, or of one
standalone outbuilding (garage, parking, cellar). Mutations mixing several dwellings
or commercial premises are left out: their price cannot be split.

Point properties (short names keep the tiles small):
  p price €, t type (M house, A flat, T land, D outbuilding), s living m², l land m²,
  r rooms, d date YYYY-MM, n 1 = new (VEFA).

    uv run lsfr sales
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import polars as pl

from .sources import DEPTS, DVF_YEARS, dep_dir

TYPES = {"Maison": "M", "Appartement": "A"}


def mutations(paths: list[Path], end: str) -> pl.DataFrame:
    cols = ["id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere", "type_local", "surface_reelle_bati",
            "nombre_pieces_principales", "surface_terrain", "code_nature_culture", "longitude", "latitude",
            "numero_disposition", "lot1_numero", "id_parcelle"]
    df = pl.concat([pl.read_csv(p, columns=cols, infer_schema_length=0) for p in paths], how="vertical_relaxed")
    df = df.with_columns(
        pl.col("date_mutation").str.to_date(),
        *(pl.col(c).cast(pl.Float64, strict=False) for c in ("valeur_fonciere", "surface_reelle_bati", "surface_terrain",
                                                            "nombre_pieces_principales", "longitude", "latitude")),
    )
    end_d = pl.lit(end).str.to_date()
    df = df.filter(pl.col("nature_mutation").is_in(["Vente", "Vente en l'état futur d'achèvement"])
                   & (pl.col("date_mutation") > end_d.dt.offset_by("-24mo")) & (pl.col("date_mutation") <= end_d))
    locals_ = df.filter(pl.col("type_local").is_not_null()).unique(
        subset=["id_mutation", "type_local", "surface_reelle_bati", "nombre_pieces_principales", "lot1_numero"])
    loc = locals_.group_by("id_mutation").agg(
        pl.col("type_local").is_in(list(TYPES)).sum().alias("n_dw"),
        (pl.col("type_local") == "Dépendance").sum().alias("n_dep"),
        (pl.col("type_local") == "Local industriel. commercial ou assimilé").sum().alias("n_com"),
        pl.col("type_local").filter(pl.col("type_local").is_in(list(TYPES))).first().alias("tl"),
        pl.col("surface_reelle_bati").filter(pl.col("type_local").is_in(list(TYPES))).first().alias("s"),
        pl.col("nombre_pieces_principales").filter(pl.col("type_local").is_in(list(TYPES))).first().alias("r"),
    )
    # Land surface: one value per parcel (rows repeat a parcel for each local).
    land = df.unique(subset=["id_mutation", "id_parcelle", "code_nature_culture"]).group_by("id_mutation").agg(
        pl.col("surface_terrain").sum().alias("l"),
        (pl.col("code_nature_culture") == "AB").any().alias("ab"),
    )
    head = df.filter(pl.col("longitude").is_not_null()).group_by("id_mutation").agg(
        pl.col("date_mutation").first().alias("date"), pl.col("valeur_fonciere").first().alias("p"),
        pl.col("nature_mutation").first().alias("nat"), pl.col("longitude").first().alias("lon"),
        pl.col("latitude").first().alias("lat"), pl.col("numero_disposition").n_unique().alias("n_disp"))
    m = head.join(loc, on="id_mutation", how="left").join(land, on="id_mutation", how="left").with_columns(
        *(pl.col(c).fill_null(0) for c in ("n_dw", "n_dep", "n_com")))
    m = m.filter((pl.col("n_disp") == 1) & (pl.col("n_com") == 0) & (pl.col("p") >= 500))
    t = (pl.when(pl.col("n_dw") == 1).then(pl.col("tl").replace_strict(TYPES, default=None))
         .when((pl.col("n_dw") == 0) & (pl.col("n_dep") == 0) & pl.col("ab")).then(pl.lit("T"))
         .when((pl.col("n_dw") == 0) & (pl.col("n_dep") == 1) & (pl.col("l").fill_null(0) <= 100)).then(pl.lit("D")))
    m = m.with_columns(t.alias("t")).filter(pl.col("t").is_not_null())
    # Same plausibility guard as the medians for dwellings (€/m² of living area).
    pm2 = pl.col("p") / pl.col("s")
    m = m.filter(~pl.col("t").is_in(["M", "A"]) | ((pl.col("s") >= 9) & pm2.is_between(300, 20_000)))
    return m.select(
        "lon", "lat", pl.col("p").round(0).cast(pl.Int64), "t", pl.col("s").round(0).cast(pl.Int32),
        pl.col("l").round(0).cast(pl.Int32), pl.when(pl.col("r") <= 30).then(pl.col("r")).cast(pl.Int16), pl.col("date").dt.strftime("%Y-%m").alias("d"),
        (pl.col("nat") != "Vente").cast(pl.Int8).alias("n"))


def write(raw: Path, out: Path, end: str) -> None:
    tmp = raw / "build" / "sales.geojsonl"
    tmp.parent.mkdir(exist_ok=True)
    n = 0
    with tmp.open("w") as f:
        for d in DEPTS:
            files = [raw / dep_dir(d) / f"dvf-{y}.csv.gz" for y in DVF_YEARS[-3:]]
            files = [p for p in files if p.exists()]
            if not files:
                continue
            m = mutations(files, end)
            for r in m.iter_rows(named=True):
                props = {k: v for k, v in r.items() if k not in ("lon", "lat") and v is not None and v != 0 or k == "p"}
                f.write(json.dumps({"type": "Feature", "properties": props,
                                    "geometry": {"type": "Point", "coordinates": [round(r["lon"], 5), round(r["lat"], 5)]}},
                                   separators=(",", ":")) + "\n")
            n += m.height
            print(f"  {d}: {m.height} sales", flush=True)
    target = out / "sales.pmtiles"
    # One zoom level only (12, ~2 m precision): the map overzooms it, and nothing is stored below,
    # so the national map stays light and the file stays under the 100 MB GitHub limit.
    subprocess.run(["tippecanoe", "-o", str(target), "--force", "-l", "sales", "-Z12", "-z12", "-B12", "-r1", "--extend-zooms-if-still-dropping",
                    "--no-feature-limit", "--no-tile-size-limit", "--read-parallel", "-q", str(tmp)], check=True)
    tmp.unlink()
    print(f"wrote {n} sales -> {target} ({target.stat().st_size / 1e6:.1f} MB)", flush=True)
