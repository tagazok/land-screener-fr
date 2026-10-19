import json
import zipfile

from lsfr import vigieau


def _zip(tmp_path, communes):
    p = tmp_path / "h.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("historique_communes.json", json.dumps(communes, separators=(",", ":")))
    return p


def _c(code, days):
    return {"commune": {"code": code, "nom": code},
            "restrictions": [{"AEP": a, "SOU": s, "SUP": u, "date": d} for d, a, s, u in days]}


def test_stream_keeps_only_department_and_stops(tmp_path):
    data = [_c("32001", []), _c("33001", [("2024-07-01", None, None, "crise")]),
            _c("33002", []), _c("34001", [])]
    got = list(vigieau.iter_communes(_zip(tmp_path, data), "33", chunk=40))
    assert [o["commune"]["code"] for o in got] == ["33001", "33002"]


def test_summary_counts_thresholds_per_year():
    c = _c("33001", [
        ("2024-07-01", None, None, "crise"),
        ("2024-07-02", "alerte", None, "alerte_renforcee"),
        ("2024-07-03", None, "vigilance", None),
        ("2019-07-01", None, None, "crise"),  # outside window
    ])
    s = vigieau.summarise(c, ["2024", "2025"])
    assert s["drought_days_avg"] == 1.0   # 2 days >= alerte renforcée / 2 years
    assert s["crisis_days_avg"] == 0.5
    assert s["drinking_water_days_avg"] == 0.5
