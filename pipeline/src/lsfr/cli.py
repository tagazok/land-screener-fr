"""lsfr CLI: `lsfr fetch` downloads raw sources, `lsfr build` produces web artifacts."""

from __future__ import annotations

import argparse
from pathlib import Path

from .fetch import fetch, fetch_zip_member
from .sources import SOURCES

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / "raw"
OUT = ROOT / "web" / "public" / "data"


def cmd_fetch(args: argparse.Namespace) -> None:
    from concurrent.futures import ThreadPoolExecutor

    todo = [s for s in SOURCES if not args.only or s.key in args.only or (s.group and s.group in args.only)]
    failed: list[str] = []

    def one(s):
        dest = RAW / s.filename
        try:
            if s.member:
                fetch_zip_member(s.url, s.member, dest)
            else:
                fetch(s.url, dest, provenance=RAW / "provenance.jsonl")
            return None
        except Exception as e:  # keep going: one missing file must not stop the rest
            return f"{s.key}: {e}"

    # Polite parallelism: a few files at a time per run.
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, err in enumerate(pool.map(one, todo), 1):
            if err:
                failed.append(err)
                print("  !", err.splitlines()[0], flush=True)
            if i % 50 == 0 or i == len(todo):
                print(f"fetched {i}/{len(todo)}", flush=True)
    if failed:
        print(f"{len(failed)} failed; re-run `lsfr fetch` to retry only those", flush=True)


def cmd_build(args: argparse.Namespace) -> None:
    from .build import build

    build(RAW, OUT)


def cmd_summarize(args: argparse.Namespace) -> None:
    from .summarize import summarize

    summarize(OUT, RAW / "ai" / "summaries-cache.json", limit=args.limit, depts=args.depts, workers=args.workers)


def main() -> None:
    p = argparse.ArgumentParser(prog="lsfr")
    sub = p.add_subparsers(required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--only", nargs="*", help="source keys or groups (communes, dvf, clay, water_plv)")
    f.add_argument("--workers", type=int, default=4)
    f.set_defaults(func=cmd_fetch)
    b = sub.add_parser("build")
    b.set_defaults(func=cmd_build)
    s = sub.add_parser("summarize", help="generate AI summaries with Amazon Bedrock (cached)")
    s.add_argument("--limit", type=int)
    s.add_argument("--depts", nargs="*", help="only these départements, e.g. --depts 33 40")
    s.add_argument("--workers", type=int, default=6, help="parallel Bedrock calls")
    s.set_defaults(func=cmd_summarize)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
