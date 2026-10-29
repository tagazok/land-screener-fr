"""Daily ATMO air-quality index per commune (Atmo France WFS, last 365 days), one parquet per day.

The index gives each pollutant a class 1-6 (bon, moyen, dégradé, mauvais, très mauvais,
extrêmement mauvais). Saved in raw/air/YYYY-MM-DD.parquet; resumable.
Licence: ODbL (Atmo France / AASQA) - credit the source.

    uv run python -m lsfr.air_fetch [--days 365] [--workers 3]
"""

from __future__ import annotations

import argparse
import io
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import polars as pl

WFS = "https://data.atmo-france.org/geoserver/ind/ows"
OUT = Path(__file__).resolve().parents[3] / "raw" / "air"
PROPS = "code_zone,type_zone,date_ech,code_no2,code_o3,code_pm10,code_pm25,code_so2"


def one(day: str) -> str:
    dest = OUT / f"{day}.parquet"
    if dest.exists():
        return f"{day}: already there"
    params = {"service": "WFS", "request": "GetFeature", "version": "2.0.0", "typeNames": "ind:ind_atmo",
              "outputformat": "csv", "propertyName": PROPS, "CQL_FILTER": f"date_ech='{day}'"}
    url = WFS + "?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "land-screener-fr/0.1"}),
                                        timeout=600) as r:
                text = r.read().decode("utf-8", "replace")
            # An overloaded GeoServer answers with its HTML home page instead of CSV.
            if not text.startswith("FID"):
                raise RuntimeError(f"not CSV: {text[:80]!r}")
            break
        except Exception:
            if attempt == 5:
                raise
            time.sleep(30 * (attempt + 1))
    df = pl.read_csv(io.StringIO(text), infer_schema_length=0)
    df = df.filter(pl.col("type_zone") == "commune").drop("FID", "type_zone", strict=False)
    df = df.with_columns(pl.col("^code_(no2|o3|pm10|pm25|so2)$").cast(pl.Int8, strict=False))
    # A commune can be published more than once a day (revised forecast): keep the worst class.
    df = df.group_by("code_zone", "date_ech").agg(pl.col("^code_(no2|o3|pm10|pm25|so2)$").max())
    tmp = dest.with_suffix(".parquet.tmp")
    df.write_parquet(tmp)
    tmp.replace(dest)
    return f"{day}: {df.height} communes"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--workers", type=int, default=1)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    end = date.today() - timedelta(days=1)
    days = [(end - timedelta(days=i)).isoformat() for i in range(args.days)]
    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for day, fut in [(d, pool.submit(one, d)) for d in days]:
            try:
                print(fut.result(), flush=True)
            except Exception as e:  # a re-run retries only the missing days
                failed.append(day)
                print(f"  ! {day}: {e}", flush=True)
    print(f"done, {len(failed)} failed", flush=True)


if __name__ == "__main__":
    main()
