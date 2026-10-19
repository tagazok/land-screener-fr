"""Energy ratings (DPE) per commune from the ADEME open API, without downloading 15 M rows.

The data-fair API aggregates server side: one call per département gives the
number of DPE per commune, a second the number rated F or G.

    uv run python -m lsfr.dpe_fetch      # writes raw/extra/dpe-communes.json
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .sources import DEPTS

API = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/values_agg?"
OUT = Path(__file__).resolve().parents[3] / "raw" / "extra" / "dpe-communes.json"


def _agg(qs: str) -> dict[str, int]:
    params = {"field": "code_insee_ban", "agg_size": "1000", "qs": qs}
    for attempt in range(6):
        try:
            req = urllib.request.Request(API + urllib.parse.urlencode(params), headers={"User-Agent": "land-screener-fr/0.1"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            if d.get("total_other"):
                raise RuntimeError(f"agg_size too small for {qs}: {d['total_other']} rows not aggregated")
            return {a["value"]: a["total"] for a in d["aggs"]}
        except Exception:
            if attempt == 5:
                raise
            time.sleep(3 * (attempt + 1))
    return {}


def main() -> None:
    out = json.loads(OUT.read_text()) if OUT.exists() else {}
    for d in DEPTS:
        if d in out:
            continue
        total = _agg(f"code_insee_ban:{d}*")
        fg = _agg(f"code_insee_ban:{d}* AND etiquette_dpe:(F OR G)")
        g = _agg(f"code_insee_ban:{d}* AND etiquette_dpe:G")
        out[d] = {c: [n, fg.get(c, 0), g.get(c, 0)] for c, n in total.items()}
        OUT.write_text(json.dumps(out))
        print(d, len(total), "communes", sum(total.values()), "DPE", flush=True)
    print("done", OUT)


if __name__ == "__main__":
    main()
