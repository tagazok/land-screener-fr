from datetime import date

import polars as pl

from lsfr import dvf
from lsfr.cog import resolve


def _rows(rows):
    cols = ["id_mutation", "date_mutation", "numero_disposition", "nature_mutation", "valeur_fonciere",
            "code_commune", "type_local", "surface_reelle_bati", "nombre_pieces_principales", "lot1_numero"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows]).with_columns(
        pl.col("date_mutation").str.to_date(),
        pl.col("valeur_fonciere").cast(pl.Float64),
        pl.col("surface_reelle_bati").cast(pl.Float64),
    )


def test_house_with_outbuilding_counts_once():
    # Same mutation: a house and its garage, price repeated on both rows.
    df = _rows([
        ("m1", "2025-03-01", "1", "Vente", 200000, "33001", "Maison", 100, "4", None),
        ("m1", "2025-03-01", "1", "Vente", 200000, "33001", "Dépendance", None, "0", None),
    ])
    s = dvf.dwelling_sales(df)
    assert s.height == 1
    assert s["price_m2"][0] == 2000


def test_house_repeated_across_parcels_is_deduped():
    df = _rows([
        ("m1", "2025-03-01", "1", "Vente", 300000, "33001", "Maison", 120, "5", None),
        ("m1", "2025-03-01", "1", "Vente", 300000, "33001", "Maison", 120, "5", None),
    ])
    assert dvf.dwelling_sales(df).height == 1


def test_multi_dwelling_and_mixed_sales_are_dropped():
    df = _rows([
        ("m1", "2025-03-01", "1", "Vente", 400000, "33001", "Maison", 100, "4", None),
        ("m1", "2025-03-01", "1", "Vente", 400000, "33001", "Appartement", 50, "2", "3"),
        ("m2", "2025-03-01", "1", "Vente", 500000, "33001", "Maison", 100, "4", None),
        ("m2", "2025-03-01", "1", "Vente", 500000, "33001", "Local industriel. commercial ou assimilé", 80, "0", None),
        ("m3", "2025-03-01", "1", "Echange", 100000, "33001", "Maison", 100, "4", None),
    ])
    assert dvf.dwelling_sales(df).height == 0


def test_price_outliers_dropped():
    df = _rows([
        ("m1", "2025-03-01", "1", "Vente", 1, "33001", "Maison", 100, "4", None),          # 0.01 €/m²
        ("m2", "2025-03-01", "1", "Vente", 9_000_000, "33001", "Maison", 100, "4", None),  # 90k €/m²
    ])
    assert dvf.dwelling_sales(df).height == 0


def test_price_metrics_window_and_min_sales():
    sales = pl.DataFrame({
        "id_mutation": [f"m{i}" for i in range(7)],
        "code": ["33001"] * 7,
        "date": [date(2025, 6, 1)] * 5 + [date(2025, 7, 1), date(2022, 1, 1)],  # last one outside 24 months
        "type_local": ["Maison"] * 6 + ["Maison"],
        "price": [200000.0] * 7,
        "surface": [100.0] * 7,
        "price_m2": [1000.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 99999.0],
    })
    m = dvf.price_metrics(sales, "2025-12-31")
    row = m.filter(pl.col("code") == "33001").to_dicts()[0]
    assert row["n_sales_house"] == 6
    assert row["price_m2_house"] == 3500.0
    assert row["price_m2_apt"] is None


def test_price_metrics_below_min_sales_is_null():
    sales = pl.DataFrame({
        "id_mutation": ["a", "b"], "code": ["33002"] * 2, "date": [date(2025, 6, 1)] * 2,
        "type_local": ["Appartement"] * 2, "price": [1.0, 1.0], "surface": [1.0, 1.0],
        "price_m2": [3000.0, 3000.0],
    })
    row = dvf.price_metrics(sales, "2025-12-31").to_dicts()[0]
    assert row["n_sales_apt"] == 2 and row["price_m2_apt"] is None


def test_two_dispositions_always_excluded():
    # The garage row carries a second disposition; whatever row a dedupe keeps,
    # the mutation must be excluded (it was kept or dropped at random before).
    rows = [
        ("m1", "2025-03-01", "1", "Vente", 200000, "33001", "Maison", 100, "4", None),
        ("m1", "2025-03-01", "2", "Vente", 200000, "33001", "Dépendance", None, "0", None),
        ("m1", "2025-03-01", "1", "Vente", 200000, "33001", "Dépendance", None, "0", None),
    ]
    for order in (rows, rows[::-1], [rows[1], rows[0], rows[2]]):
        assert dvf.dwelling_sales(_rows(order)).height == 0


    def test_arrondissements_map_to_city(tmp_path):
        from lsfr.cog import ARRONDISSEMENTS
        assert ARRONDISSEMENTS["75118"] == "75056" and ARRONDISSEMENTS["69381"] == "69123" and ARRONDISSEMENTS["13216"] == "13055"
        assert len(ARRONDISSEMENTS) == 20 + 9 + 16


def test_crosswalk_resolves_chains():
    step = {"33091": "33268", "33268": "33999"}
    assert resolve("33091", step) == "33999"
    assert resolve("33063", step) == "33063"


def test_remap_does_not_double_count_city_and_arrondissements():
    from lsfr.cog import ARRONDISSEMENTS, remap

    both = pl.DataFrame({"code": ["75056", "75101", "75102", "33063"], "pop": [100, 40, 60, 5]})
    only_arr = pl.DataFrame({"code": ["75101", "75102"], "pop": [40, 60]})
    agg = lambda d: dict(remap(d, ARRONDISSEMENTS).group_by("code").agg(pl.col("pop").sum()).rows())
    assert agg(both) == {"75056": 100, "33063": 5}
    assert agg(only_arr) == {"75056": 100}


def test_parking_metrics_keeps_single_outbuilding_sales():
    import polars as pl

    from lsfr.dvf import parking_metrics

    def row(m, typ, price, land=None, disp="1", code="33063", date="2025-03-01"):
        return {"id_mutation": m, "nature_mutation": "Vente", "date_mutation": date, "code_commune": code,
                "valeur_fonciere": price, "type_local": typ, "numero_disposition": disp, "surface_terrain": land}

    rows = [row(f"p{i}", "Dépendance", 20000 + i * 1000) for i in range(5)]
    rows += [row("h", "Maison", 300000), row("h", "Dépendance", 300000)]          # house + garage: excluded
    rows += [row("f", "Dépendance", 15000, land=2000)]                             # field with a shed: excluded
    rows += [row("two", "Dépendance", 40000), row("two", "Dépendance", 40000)]     # two spaces: excluded
    rows += [row("old", "Dépendance", 9000, date="2021-01-01")]                    # outside the 36 months
    df = pl.DataFrame(rows).with_columns(pl.col("date_mutation").str.to_date(), pl.col("surface_terrain").cast(pl.Float64),
                                         pl.col("valeur_fonciere").cast(pl.Float64))
    out = parking_metrics(df, "2025-06-30").to_dicts()[0]
    assert out["n_parking_sales"] == 5 and out["parking_price"] == 22000
