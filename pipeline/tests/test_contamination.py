import polars as pl

from lsfr.contamination import soil, water_substances


def _write(tmp_path, name, df):
    p = tmp_path / name
    if name.endswith(".parquet"):
        df.write_parquet(p)
    else:
        df.write_csv(p)
    return p


def test_water_substances_pesticides_and_pfas(tmp_path):
    res = _write(tmp_path, "r.parquet", pl.DataFrame({
        "referenceprel": ["s1", "s1", "s2", "s3", "s4", "s4"],
        "cdparametresiseeaux": ["ATRZ", "PESTOT", "CLDZ_D", "DIELD", "SPFAS", "NO3"],
        "libmajparametre": ["ATRAZINE", "TOTAL", "CHLORIDAZONE DESPHÉNYL", "DIELDRINE", "SOMME DE 20 PFAS", "NITRATES"],
        "limitequal": ["<=0,1 µg/L", "<=0,5 µg/L", "<=0,1 µg/L", "<=0,03 µg/L", "<=0,1 µg/L", "<=50 mg/L"],
        "valtraduite": [0.05, 0.2, 0.3, 0.04, 0.12, 60.0],
    }))
    plv = _write(tmp_path, "plv.csv", pl.DataFrame({"referenceprel": ["s1", "s2", "s3", "s4"], "cdreseau": ["A", "A", "B", "B"]}))
    udi = _write(tmp_path, "udi.csv", pl.DataFrame({"inseecommune": ["33001", "33002", "33003"], "cdreseau": ["A", "B", "C"]}))
    out = {r["code"]: r for r in water_substances([res], [plv], udi, ["33"], {}).iter_rows(named=True)}
    # Network A: s1 under limits, s2 over (0.3 > 0.1) -> 1/2.
    assert out["33001"]["pesticide_samples"] == 2 and out["33001"]["pesticide_breach_share"] == 0.5
    assert out["33001"]["pfas_max"] is None and out["33001"]["pfas_breach_share"] is None
    # Network B: dieldrin 0.04 > 0.03 -> over; PFAS 0.12 > 0.1. Nitrates (not a pesticide) ignored.
    assert out["33002"]["pesticide_samples"] == 1 and out["33002"]["pesticide_breach_share"] == 1.0
    assert out["33002"]["pfas_max"] == 0.12 and out["33002"]["pfas_breach_share"] == 1.0
    # Network with no analysis: unknown, not clean.
    assert out["33003"]["pesticide_breach_share"] is None


def test_soil_counts_add_arrondissements_to_city(tmp_path):
    cas = _write(tmp_path, "c.csv", pl.DataFrame({"code_insee": ["75056", "75101", "75102", "33063", ""]}))
    ins = _write(tmp_path, "i.csv", pl.DataFrame({"code_insee": ["33063"]}))
    sis = _write(tmp_path, "s.csv", pl.DataFrame({"code_insee": ["40001"]}))
    out = {r["code"]: r for r in soil(cas, ins, sis, {}).iter_rows(named=True)}
    assert out["75056"]["casias_count"] == 3
    assert out["33063"] == {"code": "33063", "casias_count": 1, "polluted_site_count": 1, "sis_count": 0}
    assert out["40001"]["sis_count"] == 1 and out["40001"]["casias_count"] == 0
