"""Stream the VigiEau per-commune restriction history (11.9 GB JSON inside a zip).

The JSON is a top-level array of {"commune": {...}, "restrictions": [...]},
sorted by commune code. We scan it in chunks, json-parse only the objects of
the wanted département, and stop once the codes pass that département.
"""

from __future__ import annotations

import json
import zipfile
from collections import defaultdict
from pathlib import Path

LEVELS = {"vigilance": 1, "alerte": 2, "alerte_renforcee": 3, "crise": 4}
MARKER = b'{"commune":'


def iter_communes(zip_path: Path, depts: set[str] | str, chunk: int = 16 << 20):
    """Yield the commune objects whose code starts with one of `depts`."""
    if isinstance(depts, str):
        depts = {depts}
    last = max(depts)
    with zipfile.ZipFile(zip_path) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            buf = b""
            while True:
                data = f.read(chunk)
                buf += data
                parts = buf.split(MARKER)
                # Last part may be incomplete unless we hit EOF.
                complete, buf = (parts, b"") if not data else (parts[:-1], MARKER + parts[-1])
                for p in complete:
                    if not p.strip(b"[ \n,"):
                        continue
                    code = p[9:14].decode()  # after '{"code":"'
                    if code[:2] not in depts:
                        if code[:2] > last:  # file is sorted by code: nothing left to find
                            return
                        continue
                    body = (MARKER + p).rstrip().rstrip(b",]").rstrip()
                    yield json.loads(body)
                if not data:
                    return


def summarise(obj: dict, years: list[str]) -> dict:
    """Days per year at each threshold (max over AEP/SOU/SUP), averaged over `years`."""
    ar = defaultdict(int)  # >= alerte renforcée, any water type
    crise = defaultdict(int)
    aep = defaultdict(int)  # drinking water >= alerte
    for r in obj["restrictions"]:
        y = r["date"][:4]
        if y not in years:
            continue
        lv = max(LEVELS.get(r.get(k) or "", 0) for k in ("AEP", "SOU", "SUP"))
        if lv >= 3:
            ar[y] += 1
        if lv == 4:
            crise[y] += 1
        if LEVELS.get(r.get("AEP") or "", 0) >= 2:
            aep[y] += 1
    n = len(years)
    return {
        "code": obj["commune"]["code"],
        "drought_days_avg": sum(ar.values()) / n,
        "crisis_days_avg": sum(crise.values()) / n,
        "drinking_water_days_avg": sum(aep.values()) / n,
    }


def drought_metrics(zip_path: Path, depts, years: list[str]) -> list[dict]:
    return [summarise(o, years) for o in iter_communes(zip_path, set(depts) if not isinstance(depts, str) else depts)]
