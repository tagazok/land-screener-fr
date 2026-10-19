"""Themes for the "Habiter / long terme" view: clay, doctors, coast, fibre,
city attraction area, drinking-water quality, everyday services (BPE).

Every function returns one row per commune code (current COG) or less.
"""

from __future__ import annotations


import io

import zipfile
from pathlib import Path

import polars as pl
import shapefile
from pyproj import Transformer
from python_calamine import CalamineWorkbook
from shapely.geometry import shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

from .cog import remap

TO_L93 = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True).transform


# ---------------------------------------------------------------- clay (RGA)
def clay(path: Path, communes_geojson: dict) -> pl.DataFrame:
    """Share of each commune's area in medium / high clay shrink-swell exposure.

    Source zones: niveau 1 = faible, 2 = moyen, 3 = fort (Lambert-93).
    Areas not covered by any zone have no exposure.
    """
    z = zipfile.ZipFile(path)
    base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
    sf = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")),
                          shx=io.BytesIO(z.read(base + ".shx")))
    lvl_idx = [f[0] for f in sf.fields[1:]].index("niveau")
    by_level: dict[int, list] = {1: [], 2: [], 3: []}
    for sr in sf.iterShapeRecords():
        lvl = int(sr.record[lvl_idx])
        g = shape(sr.shape.__geo_interface__)
        if not g.is_valid:
            g = g.buffer(0)
        by_level.setdefault(lvl, []).append(g)
    trees = {lvl: (STRtree(gs), gs) for lvl, gs in by_level.items() if gs}

    rows = []
    for f in communes_geojson["features"]:
        geom = transform(TO_L93, shape(f["geometry"]))
        if not geom.is_valid:
            geom = geom.buffer(0)
        area = geom.area
        shares = {}
        for lvl in (2, 3):
            if lvl not in trees:
                shares[lvl] = 0.0
                continue
            tree, gs = trees[lvl]
            hits = [gs[i] for i in tree.query(geom, predicate="intersects")]
            inter = unary_union([geom.intersection(h) for h in hits]).area if hits else 0.0
            shares[lvl] = inter / area if area else None
        rows.append({
            "code": f["properties"]["code"],
            "clay_high_share": shares[3],
            "clay_medium_share": shares[2],
            "clay_med_high_share": (shares[2] or 0) + (shares[3] or 0),
        })
    return pl.DataFrame(rows)


# ---------------------------------------------------------------- doctors (APL)
def apl(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    wb = CalamineWorkbook.from_path(str(path))
    sheet = sorted(s for s in wb.sheet_names if s.startswith("APL "))[-1]  # latest year
    rows = wb.get_sheet_by_name(sheet).to_python()
    head = next(i for i, r in enumerate(rows) if r and r[0] == "Code commune INSEE")
    out = []
    for r in rows[head + 2:]:
        code = str(r[0]).strip()
        if code[:2] not in depts:
            continue
        apl_all = r[2] if isinstance(r[2], (int, float)) else None
        apl_65 = r[3] if isinstance(r[3], (int, float)) else None
        pop_std = r[6] if isinstance(r[6], (int, float)) else 0.0
        out.append({"code": code, "apl_gp": apl_all, "apl_gp_65": apl_65, "_w": pop_std})
    df = remap(pl.DataFrame(out), x)
    # DREES: aggregate APL weighted by standardised population.
    return df.group_by("code").agg(
        ((pl.col("apl_gp") * pl.col("_w")).sum() / pl.col("_w").sum()).alias("apl_gp"),
        ((pl.col("apl_gp_65") * pl.col("_w")).sum() / pl.col("_w").sum()).alias("apl_gp_65"),
    ).with_columns(pl.lit(sheet[4:]).alias("apl_year"))


# ---------------------------------------------------------------- coast retreat decree
def coast_decree(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    d = pl.read_csv(path, infer_schema_length=0)
    d = d.filter(pl.col("code_commune").str.slice(0, 2).is_in(depts) & (pl.col("is_currently_active") == "True"))
    d = remap(d.rename({"code_commune": "code"}), x)
    return d.select("code").unique().with_columns(pl.lit(True).alias("coast_retreat_decree"))


# ---------------------------------------------------------------- fibre (ARCEP)
def fibre(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    d = pl.read_csv(path, separator=";", infer_schema_length=0)
    d = d.filter(pl.col("code_insee").str.slice(0, 2).is_in(depts)).rename({"code_insee": "code"})
    d = d.with_columns(*(pl.col(c).cast(pl.Float64) for c in ("nbr", "elig_thd30", "elig_thd1g", "inel_hd")))
    d = remap(d, x).group_by("code").agg(pl.col("nbr").sum(), pl.col("elig_thd30").sum(), pl.col("elig_thd1g").sum(),
                                         pl.col("inel_hd").sum(), pl.col("date").first())
    return d.select(
        "code",
        (pl.col("elig_thd1g") / pl.col("nbr")).alias("fibre_share"),
        (pl.col("elig_thd30") / pl.col("nbr")).alias("thd_share"),
        (pl.col("inel_hd") / pl.col("nbr")).alias("no_good_internet_share"),
    )


# ---------------------------------------------------------------- city attraction areas (AAV 2020)
AAV_CATEGORY = {
    "11": "Commune-centre d’une aire",
    "12": "Autre commune du pôle",
    "13": "Commune secondaire du pôle",
    "20": "Commune de la couronne",
    "30": "Hors attraction des villes",
}
AAV_SIZE = {
    "0": "hors aire", "1": "aire < 50 000 hab.", "2": "aire 50 000 – 200 000 hab.",
    "3": "aire 200 000 – 700 000 hab.", "4": "aire ≥ 700 000 hab. (hors Paris)", "5": "aire de Paris",
}


def aav(path: Path, depts: list[str], x: dict) -> pl.DataFrame:
    z = zipfile.ZipFile(path)
    wb = CalamineWorkbook.from_filelike(io.BytesIO(z.read(z.namelist()[0])))
    comp = wb.get_sheet_by_name("Composition_communale").to_python()
    aires = wb.get_sheet_by_name("AAV2020").to_python()
    i = next(k for k, r in enumerate(aires) if r and r[0] == "AAV2020")
    size = {str(r[0]): str(r[2]) for r in aires[i + 1:] if r and r[0]}
    j = next(k for k, r in enumerate(comp) if r and r[0] == "CODGEO")
    rows = [
        {"code": str(r[0]), "aav_name": r[3], "aav_category": AAV_CATEGORY.get(str(r[4]), str(r[4])),
         "aav_size": AAV_SIZE.get(size.get(str(r[2]), ""), None)}
        for r in comp[j + 1:] if r and str(r[0])[:2] in depts
    ]
    return remap(pl.DataFrame(rows), x).group_by("code").agg(pl.all().first())


# ---------------------------------------------------------------- drinking-water quality
def water_quality(plvs: list[Path], com_udi: Path, depts: list[str], x: dict) -> pl.DataFrame:
    """Share of 2025 drinking-water samples that broke a quality LIMIT, for the networks serving each commune.

    Limits (limites de qualité, health-based) are columns plvconformitebacterio /
    plvconformitechimique = 'N'. Quality REFERENCES (indicators, not health
    limits) are tracked separately. A network can cross a département line, so
    every département's samples are pooled before joining to communes.
    """
    p = pl.concat([pl.read_csv(f, infer_schema_length=0) for f in plvs if f.exists()], how="diagonal_relaxed")
    p = p.with_columns(
        ((pl.col("plvconformitebacterio") == "N") | (pl.col("plvconformitechimique") == "N")).alias("bad_limit"),
        ((pl.col("plvconformitereferencebact") == "N") | (pl.col("plvconformitereferencechim") == "N")).alias("bad_ref"),
    )
    net = p.group_by("cdreseau").agg(pl.len().alias("n"), pl.col("bad_limit").sum(), pl.col("bad_ref").sum())
    link = pl.read_csv(com_udi, infer_schema_length=0).filter(pl.col("inseecommune").str.slice(0, 2).is_in(depts))
    link = link.select(pl.col("inseecommune").alias("code"), "cdreseau").unique()
    j = remap(link.join(net, on="cdreseau", how="inner"), x)
    return j.group_by("code").agg(
        (pl.col("bad_limit").sum() / pl.col("n").sum()).alias("water_limit_breach_share"),
        (pl.col("bad_ref").sum() / pl.col("n").sum()).alias("water_reference_breach_share"),
        pl.col("n").sum().alias("water_samples"),
    )


# ---------------------------------------------------------------- everyday services (BPE)
# BPE 2025 equipment codes (FACILITY_TYPE), checked against DS_BPE_2025_metadata.csv.
SERVICES = {
    "gp": ["D265"],                    # médecin généraliste
    "pharmacy": ["D307"],              # pharmacie
    "emergency": ["D106"],             # urgences
    "supermarket": ["B104", "B105"],   # hypermarché, supermarché
    "bakery": ["B207"],                # boulangerie-pâtisserie
    "primary_school": ["C107", "C108", "C109"],  # école maternelle / primaire / élémentaire
    "college": ["C201"],               # collège
    "lycee": ["C301", "C302"],         # lycée général/techno, lycée pro
    "train": ["E107", "E108", "E109"],  # gares de voyageurs
    "post": ["A206", "A207", "A208"],  # bureau de poste, relais, agence postale
}


def bpe_counts(path: Path, depts: set[str]) -> dict[str, dict[str, float]]:
    """Commune code -> {service: number of equipments}, for the given départements."""
    kind_of = {c: k for k, cs in SERVICES.items() for c in cs}
    z = zipfile.ZipFile(path)
    d = pl.read_csv(z.open("DS_BPE_2025_data.csv").read(), separator=";", infer_schema_length=0,
                    columns=["GEO", "GEO_OBJECT", "FACILITY_TYPE", "BPE_MEASURE", "OBS_VALUE"])
    d = d.filter((pl.col("GEO_OBJECT") == "COM") & (pl.col("BPE_MEASURE") == "FACILITIES")
                 & pl.col("FACILITY_TYPE").is_in(list(kind_of)) & pl.col("GEO").str.slice(0, 2).is_in(list(depts)))
    d = d.with_columns(pl.col("FACILITY_TYPE").replace(kind_of).alias("kind"),
                       pl.col("OBS_VALUE").cast(pl.Float64, strict=False))
    out: dict[str, dict[str, float]] = {}
    for code, kind, n in d.group_by("GEO", "kind").agg(pl.col("OBS_VALUE").sum()).iter_rows():
        if n and n > 0:
            out.setdefault(code, {})[kind] = n
    return out


def services(counts: dict[str, dict[str, float]], centres: dict[str, tuple[float, float]],
             communes: pl.DataFrame, x: dict) -> pl.DataFrame:
    """Distance (km, straight line) from each commune to the nearest commune that has each service.

    0 means the service exists in the commune itself. Distances are measured
    between commune centres, so they are an approximation (a few km) of what
    a resident at a given address experiences. A k-d tree keeps this fast for
    35 000 communes.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    counts = {x.get(c, c): v for c, v in counts.items()}
    rows = list(communes.iter_rows(named=True))
    xy = np.array([TO_L93(r["lon"], r["lat"]) for r in rows])
    out: dict[str, list] = {"code": [r["code"] for r in rows],
                            "gp_count": [counts.get(r["code"], {}).get("gp", 0.0) for r in rows]}
    for k in SERVICES:
        have = [c for c, kinds in counts.items() if kinds.get(k) and c in centres]
        if not have:
            out[f"dist_{k}_km"] = [None] * len(rows)
            continue
        tree = cKDTree(np.array([TO_L93(*centres[c]) for c in have]))
        dist, _ = tree.query(xy)
        out[f"dist_{k}_km"] = [0.0 if counts.get(r["code"], {}).get(k) else float(d) / 1000 for r, d in zip(rows, dist)]
    return pl.DataFrame(out)
