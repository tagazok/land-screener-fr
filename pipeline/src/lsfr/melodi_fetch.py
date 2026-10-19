"""Census (RP 2023) indicators per commune from INSEE's Melodi API, filtered server side.

The full Melodi files are 100–130 MB zipped (1.2 GB of CSV) and insee.fr
transfers stall here, so we ask the data API only for the cells we need.

    uv run python -m lsfr.melodi_fetch     # writes raw/extra/rp2023-communes.json
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.insee.fr/melodi/data/"
OUT = Path(__file__).resolve().parents[3] / "raw" / "extra" / "rp2023-communes.json"

# name -> (dataset, filters). Every dimension not listed is pinned to its total.
QUERIES = {
    "rp_main": ("DS_RP_LOGEMENT_PRINC", dict(TIME_PERIOD="2023", OCS="DW_MAIN", TSH="_T", TDW="_T", BUILD_END="_T", NRG_SRC="_T",
                                             CARS="_T", CARPARK="_T", NOR="_T", L_STAY="_T", RP_MEASURE="DWELLINGS")),
    "rp_tenants": ("DS_RP_LOGEMENT_PRINC", dict(TIME_PERIOD="2023", OCS="DW_MAIN", TSH="200", TDW="_T", BUILD_END="_T", NRG_SRC="_T",
                                                CARS="_T", CARPARK="_T", NOR="_T", L_STAY="_T", RP_MEASURE="DWELLINGS")),
    "rp_private_rent": ("DS_RP_LOGEMENT_PRINC", dict(TIME_PERIOD="2023", OCS="DW_MAIN", TSH="211", TDW="_T", BUILD_END="_T", NRG_SRC="_T",
                                                     CARS="_T", CARPARK="_T", NOR="_T", L_STAY="_T", RP_MEASURE="DWELLINGS")),
    "rp_furnished": ("DS_RP_LOGEMENT_PRINC", dict(TIME_PERIOD="2023", OCS="DW_MAIN", TSH="212_222", TDW="_T", BUILD_END="_T", NRG_SRC="_T",
                                                  CARS="_T", CARPARK="_T", NOR="_T", L_STAY="_T", RP_MEASURE="DWELLINGS")),
    "rp_social": ("DS_RP_LOGEMENT_PRINC", dict(TIME_PERIOD="2023", OCS="DW_MAIN", TSH="221", TDW="_T", BUILD_END="_T", NRG_SRC="_T",
                                               CARS="_T", CARPARK="_T", NOR="_T", L_STAY="_T", RP_MEASURE="DWELLINGS")),
    "active_15_64": ("DS_RP_EMPLOI_LR_PRINC", dict(TIME_PERIOD="2023", AGE="Y15T64", EDUC="_T", SEX="_T", EMPSTA_ENQ="1T2", RP_MEASURE="POP")),
    "unemployed_15_64": ("DS_RP_EMPLOI_LR_PRINC", dict(TIME_PERIOD="2023", AGE="Y15T64", EDUC="_T", SEX="_T", EMPSTA_ENQ="2", RP_MEASURE="POP")),
    "jobs": ("DS_RP_EMPLOI_LT_PRINC", dict(TIME_PERIOD="2023", AGE="_T", EMPFORM="_T", SEX="_T", WKTIME="_T", EMPSTA_ENQ="1", RP_MEASURE="NBEMP")),
}
PAGE = 1000


def _get(url: str) -> dict:
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "land-screener-fr/0.1"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception:
            if attempt == 7:
                raise
            time.sleep(3 * (attempt + 1))
    return {}


def fetch_query(ds: str, filters: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    page = 1
    while True:
        q = urllib.parse.urlencode({"GEO": "COM", **filters, "maxResult": PAGE, "page": page})
        d = _get(f"{API}{ds}?{q}")
        obs = d.get("observations", [])
        for o in obs:
            code = o["dimensions"]["GEO"].split("-")[-1]
            v = (o.get("measures", {}).get("OBS_VALUE_NIVEAU") or {}).get("value")
            if v is not None:
                out[code] = float(v)
        if d.get("paging", {}).get("isLast", len(obs) < PAGE) or not obs:
            return out
        page += 1


def main() -> None:
    from concurrent.futures import ThreadPoolExecutor

    res = json.loads(OUT.read_text()) if OUT.exists() else {}
    todo = [n for n in QUERIES if n not in res]

    def one(name: str) -> tuple[str, dict, float]:
        t = time.time()
        ds, f = QUERIES[name]
        return name, fetch_query(ds, f), time.time() - t

    with ThreadPoolExecutor(max_workers=len(todo) or 1) as pool:
        for name, data, secs in pool.map(one, todo):
            res[name] = data
            OUT.write_text(json.dumps(res))
            print(f"{name}: {len(data)} communes ({secs:.0f}s)", flush=True)
    print("done", OUT)


if __name__ == "__main__":
    main()
