"""Relief, forest cover and nearest town per commune.

- Relief: IGN BD ALTI 75 m (Lambert-93 ASC tiles in raw/extra/bdalti/), averaged to 150 m.
  Per commune: mean, min, max altitude and relief = 95th - 5th percentile of altitude,
  which separates hills and mountains from flat land without being fooled by one peak.
- Forest: ESA WorldCover 2021 (10 m, class 10 = tree cover), read remotely from its
  cloud-optimised GeoTIFFs at ~80 m through their overviews (no full download).
  Per commune: share of land under trees, and share within ~5 km around it.
- Nearest town: distance from the commune centre to the nearest commune of 3,000+ residents.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import polars as pl
from scipy.spatial import cKDTree

from .living import TO_L93

WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{}_Map.tif"
# 3°x3° tiles covering metropolitan France and Corsica.
WC_TILES = [f"{lat}{lon}" for lat in ("N39", "N42", "N45", "N48", "N51") for lon in ("W006", "W003", "E000", "E003", "E006", "E009")]
WC_DECIMATE = 8          # 10 m -> ~80 m
AROUND_KM = 5


def _index(feats: list[dict]) -> tuple[list[str], list]:
    return [f["properties"]["code"] for f in feats], [f["geometry"] for f in feats]


def relief(asc_dir: Path, feats: list[dict]) -> pl.DataFrame:
    import rasterio.features
    from rasterio.transform import from_origin
    from shapely.geometry import mapping, shape
    from shapely.ops import transform

    codes, geoms = _index(feats)
    l93 = [transform(TO_L93, shape(g)) for g in geoms]
    bounds = np.array([g.bounds for g in l93])
    ids, alts = [], []
    for asc in sorted(asc_dir.glob("*.asc")):
        with asc.open() as fh:
            head = {k.lower(): float(v) for k, v in (fh.readline().split() for _ in range(6))}
            z = np.loadtxt(fh, dtype=np.float32)
        n, cs = int(head["nrows"]), head["cellsize"]
        x0, y_top = head["xllcorner"], head["yllcorner"] + n * cs
        z[z <= head["nodata_value"] + 1] = np.nan
        with np.errstate(all="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            z = np.nanmean(z.reshape(n // 2, 2, -1, 2), axis=(1, 3))  # 75 m -> 150 m
        tr = from_origin(x0, y_top, cs * 2, cs * 2)
        x1, y0 = x0 + n * cs, y_top - n * cs
        hit = np.where((bounds[:, 0] < x1) & (bounds[:, 2] > x0) & (bounds[:, 1] < y_top) & (bounds[:, 3] > y0))[0]
        if not len(hit):
            continue
        grid = rasterio.features.rasterize(((mapping(l93[i]), int(i) + 1) for i in hit), out_shape=z.shape,
                                           transform=tr, fill=0, dtype="int32")
        ok = (grid > 0) & np.isfinite(z)
        ids.append(grid[ok] - 1)
        alts.append(z[ok])
    d = pl.DataFrame({"i": np.concatenate(ids), "alt": np.concatenate(alts)})
    out = d.group_by("i").agg(
        pl.col("alt").mean().alias("alt_mean"), pl.col("alt").min().alias("alt_min"),
        pl.col("alt").max().alias("alt_max"),
        (pl.col("alt").quantile(0.95) - pl.col("alt").quantile(0.05)).alias("relief_m"),
    )
    return out.with_columns(pl.col("i").map_elements(lambda i: codes[i], return_dtype=pl.Utf8).alias("code")).drop("i")


def forest(feats: list[dict]) -> pl.DataFrame:
    import rasterio
    import rasterio.features
    from rasterio.enums import Resampling
    from scipy.ndimage import uniform_filter
    from shapely.geometry import shape

    codes, geoms = _index(feats)
    shp = [shape(g) for g in geoms]
    bounds = np.array([g.bounds for g in shp])
    n = len(codes)
    land, trees, around = np.zeros(n), np.zeros(n), np.zeros(n)
    for tile in WC_TILES:
        lat0 = int(tile[1:3])
        lon0 = (-1 if tile[3] == "W" else 1) * int(tile[4:])
        hit = np.where((bounds[:, 0] < lon0 + 3) & (bounds[:, 2] > lon0) & (bounds[:, 1] < lat0 + 3) & (bounds[:, 3] > lat0))[0]
        if not len(hit):
            continue
        with rasterio.open("/vsicurl/" + WORLDCOVER.format(tile)) as src:
            h, w = src.height // WC_DECIMATE, src.width // WC_DECIMATE
            v = src.read(1, out_shape=(h, w), resampling=Resampling.nearest)
            tr = src.transform * src.transform.scale(src.width / w, src.height / h)
        grid = rasterio.features.rasterize(((shp[i], int(i) + 1) for i in hit), out_shape=v.shape, transform=tr,
                                           fill=0, dtype="int32")
        valid = (v != 0) & (v != 80)  # 0 = no data, 80 = permanent water: not land
        is_tree = (v == 10).astype(np.float32)
        # Tree share within a square of ~2 x AROUND_KM side around each pixel (land pixels only).
        px_km = abs(tr.a) * 111.32 * np.cos(np.radians(lat0 + 1.5))
        size = max(3, int(round(2 * AROUND_KM / px_km)))
        num = uniform_filter(is_tree * valid, size=size, mode="constant")
        den = uniform_filter(valid.astype(np.float32), size=size, mode="constant")
        ring = np.divide(num, den, out=np.zeros_like(num), where=den > 0)
        sel = (grid > 0) & valid
        idx = grid[sel] - 1
        land += np.bincount(idx, minlength=n)
        trees += np.bincount(idx, weights=is_tree[sel], minlength=n)
        around += np.bincount(idx, weights=ring[sel], minlength=n)
        print(f"    worldcover {tile}: {len(hit)} communes", flush=True)
    keep = land > 0
    return pl.DataFrame({
        "code": [c for c, k in zip(codes, keep) if k],
        "forest_share": (trees[keep] / land[keep]),
        "forest_around_share": (around[keep] / land[keep]),
    })


def nearest_town(base: pl.DataFrame, min_pop: int = 3000) -> pl.DataFrame:
    rows = base.select("code", "nom", "lon", "lat", "pop").to_dicts()
    xy = np.array([TO_L93(r["lon"], r["lat"]) for r in rows])
    towns = [i for i, r in enumerate(rows) if (r["pop"] or 0) >= min_pop]
    tree = cKDTree(xy[towns])
    dist, j = tree.query(xy)
    return pl.DataFrame({
        "code": [r["code"] for r in rows],
        "town3000_km": [0.0 if (r["pop"] or 0) >= min_pop else round(float(d) / 1000, 1) for r, d in zip(rows, dist)],
        "town3000_name": [r["nom"] if (r["pop"] or 0) >= min_pop else rows[towns[k]]["nom"] for r, k in zip(rows, j)],
    })
