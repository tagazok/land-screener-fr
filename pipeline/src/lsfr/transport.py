"""Train and air access per commune.

Sources (raw/extra/transport/):
- gares.json: SNCF passenger stations with coordinates and UIC codes (Licence Ouverte).
- frequentation.json: passengers per station and year (SNCF, Licence Ouverte).
- sncf-gtfs.zip: SNCF timetable, all trains (TGV INOUI, OUIGO, Intercités, TER), GTFS (ODbL).
- airports.csv: OurAirports (public domain). Only airports with scheduled flights count:
  "medium_airport" and "large_airport"; small aerodromes and heliports are left out.

Per commune, from its centre (straight-line distances):
- nearest station that has rail departures on a typical weekday, its trains a day and passengers;
- fastest DIRECT train to a big city (150,000+ residents) and to Paris, from any station within 20 km;
- nearest airport with scheduled flights, and nearest large airport.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import polars as pl
from scipy.spatial import cKDTree

from .living import TO_L93

BIG_CITY_POP = 150_000
# Major airports: about 1 million passengers a year or more (French airports' 2024 traffic, UAF).
MAJOR_AIRPORTS = {"CDG", "ORY", "NCE", "LYS", "MRS", "TLS", "BOD", "NTE", "BSL", "LIL", "BVA", "MPL", "SXB", "BIQ", "AJA", "BIA"}
STATION_RADIUS_KM = 20
# Arrondissements of Paris, Lyon and Marseille -> the commune (stations carry the arrondissement code).
ARR = [("751", "75056"), ("6938", "69123"), ("132", "13055")]


def _commune(code: str | None) -> str | None:
    if not code:
        return None
    for pre, c in ARR:
        if code.startswith(pre) and code != c:
            return c
    return code


def _minutes(t: pl.Expr) -> pl.Expr:
    p = t.str.split(":")
    return p.list.get(0).cast(pl.Int32) * 60 + p.list.get(1).cast(pl.Int32)


def stations(d: Path) -> pl.DataFrame:
    """One row per station: uic, name, commune code, lon, lat, passengers."""
    rows = []
    for g in json.loads((d / "gares.json").read_text()):
        pos = g.get("position_geographique") or {}
        for uic in str(g.get("codes_uic") or "").split(";"):
            if uic and pos.get("lon") is not None:
                rows.append({"uic": uic.strip()[-8:], "name": g["nom"], "insee": _commune(g.get("codeinsee")),
                             "lon": pos["lon"], "lat": pos["lat"]})
    st = pl.DataFrame(rows).unique("uic")
    fr = pl.DataFrame([{"uic": str(f["code_uic_complet"])[-8:], "passengers": f.get("total_voyageurs_2024")}
                       for f in json.loads((d / "frequentation.json").read_text())])
    return st.join(fr.unique("uic"), on="uic", how="left")


def timetable(d: Path) -> tuple[pl.DataFrame, str]:
    """Rail stop times (no coaches) with the station UIC, minutes, and the busiest Tuesday's trips flagged."""
    z = zipfile.ZipFile(d / "sncf-gtfs.zip")
    rd = lambda n: pl.read_csv(io.BytesIO(z.read(n)), infer_schema_length=0)  # noqa: E731
    routes = rd("routes.txt").filter(pl.col("route_type") == "2").select("route_id")
    trips = rd("trips.txt").join(routes, on="route_id").select("trip_id", "service_id")
    cal = rd("calendar_dates.txt").filter(pl.col("exception_type") == "1")
    cal = cal.with_columns(pl.col("date").str.to_date("%Y%m%d"))
    tues = cal.filter(pl.col("date").dt.weekday() == 2).join(trips, on="service_id").group_by("date").len()
    day = tues.sort("len", descending=True)["date"][0]
    running = set(cal.filter(pl.col("date") == day)["service_id"].to_list())
    st = rd("stop_times.txt").select("trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time")
    st = st.join(trips, on="trip_id").with_columns(
        pl.col("stop_id").str.extract(r"(\d{8})$").alias("uic"),
        pl.col("stop_sequence").cast(pl.Int32),
        _minutes(pl.col("arrival_time")).alias("arr"),
        _minutes(pl.col("departure_time")).alias("dep"),
        pl.col("service_id").is_in(running).alias("today"),
    ).drop("stop_id", "arrival_time", "departure_time")
    return st, day.isoformat()


def station_metrics(st: pl.DataFrame, stations_df: pl.DataFrame, big: set[str]) -> pl.DataFrame:
    """Per station: departures on the reference day, fastest direct trip to a big city and to Paris."""
    last = st.group_by("trip_id").agg(pl.col("stop_sequence").max().alias("last"))
    st = st.join(last, on="trip_id")
    deps = (st.filter(pl.col("today") & (pl.col("stop_sequence") < pl.col("last")))
            .group_by("uic").agg(pl.col("trip_id").n_unique().alias("trains_day")))
    city = stations_df.select("uic", pl.col("insee").alias("dest_insee"))
    dest = st.join(city, on="uic").filter(pl.col("dest_insee").is_in(list(big)))
    pairs = st.select("trip_id", "uic", "stop_sequence", "dep").join(
        dest.select("trip_id", pl.col("uic").alias("to"), pl.col("stop_sequence").alias("seq_to"), "arr", "dest_insee"),
        on="trip_id").filter(pl.col("seq_to") > pl.col("stop_sequence"))
    pairs = pairs.with_columns(((pl.col("arr") - pl.col("dep")) % 1440).alias("min"))
    origin = stations_df.select("uic", pl.col("insee").alias("orig_insee"))
    # A station inside a big city is "0 min" from it; only count trips to ANOTHER big city for it.
    pairs = pairs.join(origin, on="uic", how="left").filter(pl.col("orig_insee") != pl.col("dest_insee"))
    best = pairs.sort("min").group_by("uic").agg(pl.col("min").first().alias("bigcity_min"),
                                                  pl.col("dest_insee").first().alias("bigcity_insee"))
    paris = pairs.filter(pl.col("dest_insee") == "75056").group_by("uic").agg(pl.col("min").min().alias("paris_min"))
    return stations_df.join(deps, on="uic", how="inner").join(best, on="uic", how="left").join(paris, on="uic", how="left")


def airports(d: Path) -> pl.DataFrame:
    a = pl.read_csv(d / "airports.csv", infer_schema_length=0)
    a = a.filter((pl.col("iso_country") == "FR") & (pl.col("scheduled_service") == "yes")
                 & pl.col("type").is_in(["large_airport", "medium_airport"]))
    return a.select("name", "type", "iata_code", pl.col("longitude_deg").cast(pl.Float64).alias("lon"),
                    pl.col("latitude_deg").cast(pl.Float64).alias("lat"))


def _xy(lon, lat) -> np.ndarray:
    return np.array([TO_L93(x, y) for x, y in zip(lon, lat)])


def metrics(d: Path, base: pl.DataFrame, pop: pl.DataFrame) -> pl.DataFrame:
    """base: code, nom, lon, lat; pop: code, pop."""
    names = dict(zip(base["code"], base["nom"]))
    big = set(pop.filter(pl.col("pop") >= BIG_CITY_POP)["code"].to_list())
    st_all = stations(d)
    tt, day = timetable(d)
    st = station_metrics(tt, st_all, big)
    print(f"    transport: {st.height} stations with trains on {day}, {len(big)} big cities", flush=True)
    cx = _xy(base["lon"], base["lat"])
    sx = _xy(st["lon"], st["lat"])
    dist, idx = cKDTree(sx).query(cx)
    srow = st.to_dicts()
    # Fastest direct trains from any station within the radius.
    near = cKDTree(sx).query_ball_point(cx, STATION_RADIUS_KM * 1000)
    out = []
    for i, code in enumerate(base["code"]):
        s = srow[idx[i]]
        bc = [(srow[j]["bigcity_min"], j) for j in near[i] if srow[j]["bigcity_min"] is not None]
        pa = [(srow[j]["paris_min"], j) for j in near[i] if srow[j]["paris_min"] is not None]
        b = min(bc) if bc else None
        p = min(pa) if pa else None
        out.append({
            "code": code,
            "station_name": s["name"], "station_km": round(float(dist[i]) / 1000, 1),
            "station_trains_day": s["trains_day"], "station_passengers": s["passengers"],
            "bigcity_train_min": b[0] if b else None,
            "bigcity_train_city": names.get(srow[b[1]]["bigcity_insee"]) if b else None,
            "bigcity_train_station": srow[b[1]]["name"] if b else None,
            "paris_train_min": p[0] if p else None,
            "paris_train_station": srow[p[1]]["name"] if p else None,
        })
    df = pl.DataFrame(out, infer_schema_length=None).with_columns(
        pl.col("station_passengers").cast(pl.Float64, strict=False),
        pl.col("bigcity_train_min").cast(pl.Float64), pl.col("paris_train_min").cast(pl.Float64),
        pl.col("station_trains_day").cast(pl.Float64))
    # Big cities themselves: 0 min to a big city.
    inbig = pl.col("code").is_in(list(big))
    df = df.with_columns(pl.when(inbig).then(0.0).otherwise(pl.col("bigcity_train_min")).alias("bigcity_train_min"),
                         pl.when(inbig).then(pl.col("code").replace_strict(names, default=None)).otherwise(pl.col("bigcity_train_city")).alias("bigcity_train_city"),
                         pl.when(inbig).then(None).otherwise(pl.col("bigcity_train_station")).alias("bigcity_train_station"),
                         pl.when(pl.col("code") == "75056").then(0.0).otherwise(pl.col("paris_train_min")).alias("paris_train_min"))
    ap = airports(d)
    for key, sel in (("airport", ap), ("big_airport", ap.filter(pl.col("iata_code").is_in(list(MAJOR_AIRPORTS))))):
        dd, ii = cKDTree(_xy(sel["lon"], sel["lat"])).query(cx)
        nm = sel["name"].to_list()
        df = df.with_columns(pl.Series(f"{key}_km", np.round(dd / 1000, 1)), pl.Series(f"{key}_name", [nm[k] for k in ii]))
    return df
