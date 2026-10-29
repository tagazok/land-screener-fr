"""Soil-pollution inventories from Géorisques (BRGM WFS), saved as CSV in raw/extra/.

- CASIAS (etablissement_point): former industrial sites and service activities (~350 k points).
  A listing means a polluting activity took place, not that the soil is polluted.
- Sites pollués (instruction_point): sites with known pollution, under State action (ex-BASOL).
- SIS (classification): Secteurs d'information sur les sols, land where the State knows of a
  pollution and requires a soil study before building.

    uv run python -m lsfr.soil_fetch
"""

from __future__ import annotations

import io
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.parse
import urllib.request
from pathlib import Path

import polars as pl

from .sources import DEPTS

WFS = "https://mapsref.brgm.fr/wxs/georisques/georisques_dl"
OUT = Path(__file__).resolve().parents[3] / "raw" / "extra"
PAGE = 50_000
LAYERS = {
    "casias": ("ms:etablissement_point", "code_metier,code_insee,etat_activite,nature_localisation,x_wgs84,y_wgs84"),
    "ssp-instruction": ("ms:instruction_point", "cd_metier,stat_instr,code_insee,x_wgs84,y_wgs84"),
    "sis": ("ms:classification", "code_metier,nom_usuel,code_insee,x_wgs84,y_wgs84"),
}


def _get(params: dict) -> str:
    url = WFS + "?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "land-screener-fr/0.1"}),
                                        timeout=600) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            if attempt == 5:
                raise
            print(f"  retry {attempt + 1}: {e}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise AssertionError


def _dept_filter(d: str) -> str:
    return ('<Filter xmlns="http://www.opengis.net/fes/2.0"><PropertyIsEqualTo><ValueReference>code_departement'
            f'</ValueReference><Literal>{d}</Literal></PropertyIsEqualTo></Filter>')


def fetch_casias(workers: int = 6) -> Path:
    """CASIAS is large and paging through it is slow (~10 min per page): one request per département."""
    dest = OUT / "casias.csv"
    if dest.exists():
        print("casias: already there", flush=True)
        return dest
    typename, props = LAYERS["casias"]
    part_dir = OUT / "casias-parts"
    part_dir.mkdir(exist_ok=True)

    def one(d: str) -> int:
        part = part_dir / f"{d}.csv"
        if not part.exists():
            text = _get({"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typename": typename,
                         "outputformat": "csvtext", "filter": _dept_filter(d)})
            df = pl.read_csv(io.StringIO(text), separator=";", infer_schema_length=0)
            df.select([c for c in props.split(",") if c in df.columns]).write_csv(part)
        return pl.read_csv(part, infer_schema_length=0).height

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for d, n in zip(DEPTS, pool.map(one, DEPTS)):
            print(f"casias {d}: {n}", flush=True)
    out = pl.concat([pl.read_csv(part_dir / f"{d}.csv", infer_schema_length=0) for d in DEPTS]).unique()
    out.write_csv(dest)
    print(f"casias: {out.height} sites", flush=True)
    return dest


def fetch_layer(key: str) -> Path:
    if key == "casias":
        return fetch_casias()
    dest = OUT / f"{key}.csv"
    if dest.exists():
        print(f"{key}: already there", flush=True)
        return dest
    typename, props = LAYERS[key]
    frames, start = [], 0
    while True:
        text = _get({"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typename": typename,
                     "propertyname": props, "outputformat": "csvtext", "count": PAGE, "startindex": start,
                     "sortby": props.split(",")[0]})
        df = pl.read_csv(io.StringIO(text), separator=";", infer_schema_length=0)
        frames.append(df)
        print(f"{key}: {start + df.height} rows", flush=True)
        if df.height < PAGE:
            break
        start += PAGE
    out = pl.concat(frames).unique()
    tmp = dest.with_suffix(".csv.tmp")
    out.write_csv(tmp)
    tmp.replace(dest)
    return dest


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for k in ("sis", "ssp-instruction", "casias"):  # small layers first
        fetch_layer(k)
    print("done", flush=True)


if __name__ == "__main__":
    main()
