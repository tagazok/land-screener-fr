import polars as pl

from lsfr import demand
from lsfr.cog import ARRONDISSEMENTS


def test_dpe_adds_arrondissements_to_the_city(tmp_path):
    import json

    p = tmp_path / "dpe.json"
    p.write_text(json.dumps({"75": {"75056": [10, 1, 0], "75101": [100, 20, 5], "75102": [90, 9, 1]},
                             "33": {"33001": [10, 9, 9], "33002": [5, 5, 5]}}))
    out = {r["code"]: r for r in demand.dpe(p, ["75", "33"], ARRONDISSEMENTS).to_dicts()}
    assert out["75056"]["dpe_count"] == 200
    assert out["75056"]["dpe_fg_share"] == 30 / 200
    assert out["33002"]["dpe_fg_share"] is None  # fewer than 20 diagnostics
    assert "75101" not in out


def test_crime_uses_department_average_when_not_published(tmp_path):
    p = tmp_path / "c.parquet"
    pl.DataFrame({
        "CODGEO_2026": ["33001", "33002"],
        "annee": [2025, 2025],
        "indicateur": ["Cambriolages de logement", "Cambriolages de logement"],
        "taux_pour_mille": [4.0, None],
        "est_diffuse": ["diff", "ndiff"],
        "complement_info_taux": [None, 1.5],
    }).write_parquet(p)
    out = {r["code"]: r for r in demand.crime(p, ["33"], {}).to_dicts()}
    assert out["33001"]["crime_burglary"] == 4.0 and out["33001"]["crime_estimated"] is False
    assert out["33002"]["crime_burglary"] == 1.5 and out["33002"]["crime_estimated"] is True


def test_census_shares(tmp_path):
    import json

    p = tmp_path / "rp.json"
    p.write_text(json.dumps({
        "rp_main": {"33001": 100}, "rp_tenants": {"33001": 40}, "rp_private_rent": {"33001": 25},
        "rp_furnished": {"33001": 5}, "rp_social": {"33001": 10},
        "active_15_64": {"33001": 50}, "unemployed_15_64": {"33001": 5}, "jobs": {"33001": 75},
    }))
    r = demand.census(p, ["33"], {}).to_dicts()[0]
    assert r["tenant_share"] == 0.4 and r["social_share"] == 0.1
    assert r["unemployment_rate"] == 0.1 and r["jobs_per_active"] == 1.5


def test_census_parking_gap(tmp_path):
    import json

    p = tmp_path / "rp.json"
    base = {"rp_main": 100, "rp_tenants": 40, "rp_private_rent": 25, "rp_furnished": 5, "rp_social": 10,
            "active_15_64": 50, "unemployed_15_64": 5, "jobs": 75, "rp_cars_ge1": 80, "rp_cars_ge2": 30, "rp_with_spot": 50}
    p.write_text(json.dumps({k: {"33001": v, "33002": v if k != "rp_with_spot" else 95} for k, v in base.items()}))
    r = {x["code"]: x for x in demand.census(p, ["33"], {}).to_dicts()}
    assert r["33001"]["car_share"] == 0.8 and r["33001"]["cars_per_household"] == 1.1
    assert r["33001"]["parking_gap"] == 30 and r["33001"]["parking_gap_share"] == 0.3
    # More spots than car households: no deficit, never negative.
    assert r["33002"]["parking_gap"] == 0
