"""Per-substance drinking-water results 2025 (pesticides, PFAS…), reduced per département.

The DIS archive holds one DIS_RESULT_2025_0XX.txt per département (15-35 MB each,
~2.5 GB in total). Each is downloaded, cut down to the analyses of parameters that
have a health limit (limitequal), saved as raw/dep/XX/dis-result-2025.parquet, and
the text file deleted. Resumable: départements already reduced are skipped.

    uv run python -m lsfr.water_fetch [--workers 4]
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import polars as pl

from .fetch import fetch_zip_member
from .sources import DEPTS, DIS_2025, dep_dir

RAW = Path(__file__).resolve().parents[3] / "raw"
KEEP = ["referenceprel", "cdparametresiseeaux", "libmajparametre", "limitequal", "valtraduite"]


def out_path(d: str) -> Path:
    return RAW / dep_dir(d) / "dis-result-2025.parquet"


def reduce(txt: Path, dest: Path) -> int:
    p = pl.read_csv(txt, infer_schema_length=0, columns=KEEP)
    p = p.filter(pl.col("limitequal").is_not_null() & (pl.col("limitequal") != ""))
    p = p.with_columns(pl.col("valtraduite").cast(pl.Float64, strict=False))
    tmp = dest.with_suffix(".parquet.tmp")
    p.write_parquet(tmp)
    tmp.replace(dest)
    return p.height


def one(d: str) -> str:
    dest = out_path(d)
    if dest.exists():
        return f"{d}: already done"
    txt = dest.with_suffix(".txt")
    try:
        fetch_zip_member(DIS_2025, f"DIS_RESULT_2025_0{d}.txt", txt)
        n = reduce(txt, dest)
    finally:
        txt.unlink(missing_ok=True)
        Path(str(txt) + ".part").unlink(missing_ok=True)
    return f"{d}: {n} limited analyses"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {d: pool.submit(one, d) for d in DEPTS}
        for d, f in futs.items():
            try:
                print(f.result(), flush=True)
            except Exception as e:  # keep going; a re-run retries only the missing ones
                failed.append(d)
                print(f"  ! {d}: {e}", flush=True)
    print(f"done, {len(failed)} failed {failed}", flush=True)


if __name__ == "__main__":
    main()
