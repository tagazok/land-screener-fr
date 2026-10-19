"""Source registry: every raw file the pipeline downloads.

URLs were checked live on 2026-10-17/19 (see docs/data-spec.md). Scope:
metropolitan France, 96 départements (Corsica = 2A, 2B). National files are
downloaded once; files published per département live under raw/dep/<code>/.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEPTS: list[str] = [f"{i:02d}" for i in range(1, 20)] + ["2A", "2B"] + [f"{i:02d}" for i in range(21, 96)]
# For quick test builds: LSFR_DEPTS=01,33 uv run lsfr build
if os.environ.get("LSFR_DEPTS"):
    DEPTS = [d for d in os.environ["LSFR_DEPTS"].split(",") if d in DEPTS]
# DVF does not cover Alsace-Moselle (livre foncier): no file is published.
NO_DVF = {"57", "67", "68"}
DVF_YEARS = ["2021", "2022", "2023", "2024", "2025"]


@dataclass(frozen=True)
class Source:
    key: str
    url: str
    filename: str
    producer: str
    licence: str
    vintage: str
    credit: str | None = None
    #: when set, `url` is a zip and only this member is extracted (HTTP ranges).
    member: str | None = None
    #: per-département sources share a group, listed once in the attribution.
    group: str | None = None


S = "https://static.data.gouv.fr/resources"
INSEE = "https://www.insee.fr/fr/statistiques/fichier"

SOURCES: list[Source] = [
    Source(
        "cog_mvt",
        f"{INSEE}/8740222/v_mvt_commune_2026.csv",
        "v_mvt_commune_2026.csv",
        "INSEE – Code officiel géographique",
        "Licence Ouverte 2.0",
        "COG 2026",
    ),
    Source(
        "departements",
        "https://geo.api.gouv.fr/departements?fields=code,nom&format=geojson&geometry=contour",
        "departements.geojson",
        "IGN ADMIN EXPRESS via API Découpage administratif (geo.api.gouv.fr)",
        "Licence Ouverte 2.0",
        "COG en vigueur",
    ),
    Source(
        "rent_apt",
        f"{S}/carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-2025/20251211-145010/pred-app-mef-dhup.csv",
        "rent-apt-2025.csv",
        "ANIL / DGALN – Carte des loyers",
        "Licence Ouverte 2.0",
        "3e trimestre 2025 (COG 2025)",
        "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin",
    ),
    Source(
        "rent_house",
        f"{S}/carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-2025/20251211-145039/pred-mai-mef-dhup.csv",
        "rent-house-2025.csv",
        "ANIL / DGALN – Carte des loyers",
        "Licence Ouverte 2.0",
        "3e trimestre 2025 (COG 2025)",
        "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin",
    ),
    Source(
        "gaspar",
        "https://files.georisques.fr/GASPAR/gaspar.zip",
        "gaspar.zip",
        "Géorisques / DGPR – GASPAR",
        "Licence Ouverte",
        "mise à jour hebdomadaire",
    ),
    Source(
        "rei",
        "https://data.economie.gouv.fr/api/v2/catalog/datasets/"
        "impots-locaux-fichier-de-recensement-des-elements-dimposition-a-la-fiscalite-dir/"
        "attachments/rei_2025_fichier_notice_tracezip",
        "rei-2025.zip",
        "DGFiP – REI",
        "Licence Ouverte 2.0",
        "2025",
    ),
    Source(
        "tlv",
        f"{S}/liste-des-communes-selon-le-zonage-tlv-1/20251230-094759/zonage-tlv-decret-22-dec-2025.csv",
        "zonage-tlv-2025.csv",
        "Ministère de la Transition écologique – zonage TLV",
        "Licence Ouverte 2.0",
        "décret 2025-1267",
    ),
    Source(
        "abc",
        f"{S}/liste-des-communes-selon-le-zonage-abc/20260703-091314/"
        "liste-ensemble-des-communes-zonage-abc-en-vigueur-26-juin-2026.csv",
        "zonage-abc-2026.csv",
        "Ministère de la Transition écologique – zonage ABC",
        "Licence Ouverte 2.0",
        "en vigueur au 26 juin 2026",
    ),
    Source(
        "radon",
        f"{S}/connaitre-le-potentiel-radon-de-ma-commune/20190506-174309/radon.csv",
        "radon.csv",
        "ASNR (ex-IRSN) – potentiel radon",
        "Licence Ouverte",
        "arrêté 27/06/2018 (COG 2016)",
    ),
    # Housing counts (LOG, RSECOCC, LOGVAC) come from the séries historiques
    # file below; the separate RP logement base (20 MB) never downloads intact
    # from insee.fr on this network (no Content-Length, no range support).
    Source(
        "histo",
        f"{INSEE}/8582555/base-cc-serie-historique-2022_csv.zip",
        "serie-historique-2022.zip",
        "INSEE – séries historiques RP",
        "Licence Ouverte 2.0",
        "1968–2022 (géographie 2025)",
    ),
    Source(
        "filosofi",
        f"{INSEE}/7756729/base-cc-filosofi-2021-geo2025_csv.zip",
        "filosofi-2021.zip",
        "INSEE – Filosofi",
        "Licence Ouverte 2.0",
        "2021 (géographie 2025)",
    ),
    Source(
        "tourism",
        f"{INSEE}/2021703/DS_TOUR_CAP_CSV_2025_geo25.zip",
        "tourism-2025.zip",
        "INSEE – capacité des communes en hébergement touristique",
        "Licence Ouverte 2.0",
        "2025 (géographie 2025)",
    ),
    Source(
        "vigieau_history",
        f"{S}/donnee-secheresse-vigieau/20260915-045824/historique-communes.zip",
        "vigieau/historique-communes.zip",
        "Ministère de la Transition écologique – VigiEau",
        "Licence Ouverte 2.0",
        "historique 2010 – sept. 2026",
    ),
]

DIS_2025 = f"{S}/resultats-du-controle-sanitaire-de-leau-distribuee-commune-par-commune/20260710-140314/dis-2025-dept.zip"

SOURCES += [
    Source(
        "apl",
        "https://data.drees.solidarites-sante.gouv.fr/api/v2/catalog/datasets/530_l-accessibilite-potentielle-localisee-apl/attachments/indicateur_d_apl_aux_medecins_generalistes_xlsx",
        "extra/apl-medecins.xlsx",
        "DREES – accessibilité potentielle localisée aux médecins généralistes",
        "Licence Ouverte 2.0",
        "2024",
    ),
    Source(
        "coast",
        f"{S}/liste-des-communes-volontaires-pour-sadapter-au-recul-du-trait-de-cote/20260218-105039/trait-de-cote-commune-2026-95.csv",
        "extra/trait-de-cote-2026.csv",
        "Ministère de la Transition écologique – communes listées par décret (recul du trait de côte)",
        "Licence Ouverte 2.0",
        "décret du 13 février 2026",
    ),
    Source(
        "fibre",
        "https://data.arcep.fr/fixe/maconnexioninternet/statistiques/last/commune/commune_debit_filaire.csv",
        "extra/arcep-debit-filaire.csv",
        "ARCEP – Ma connexion internet",
        "Licence Ouverte 2.0",
        "30 juin 2026",
    ),
    Source(
        "aav",
        f"{INSEE}/4803954/AAV2020_au_01-01-2024.zip",
        "extra/aav2020.zip",
        "INSEE – aires d’attraction des villes 2020",
        "Licence Ouverte 2.0",
        "géographie 2024",
    ),
    Source(
        "bpe",
        f"{INSEE}/8217527/DS_BPE_CSV_FR.zip",
        "extra/bpe-com.zip",
        "INSEE – base permanente des équipements (dénombrements par commune)",
        "Licence Ouverte 2.0",
        "BPE 2025",
    ),
    Source(
        "water_udi",
        DIS_2025,
        "extra/dis-com-udi-2025.txt",
        "Ministère de la Santé – communes et réseaux de distribution d’eau",
        "Licence Ouverte 2.0",
        "2025",
        member="DIS_COM_UDI_2025.txt",
    ),
]


def dep_dir(d: str) -> str:
    return f"dep/{d}"


def _per_dept(d: str) -> list[Source]:
    out = [
        Source(
            f"communes_{d}",
            f"https://geo.api.gouv.fr/departements/{d}/communes"
            "?fields=code,nom,population,codeEpci&format=geojson&geometry=contour",
            f"{dep_dir(d)}/communes.geojson",
            "IGN ADMIN EXPRESS via API Découpage administratif (geo.api.gouv.fr)",
            "Licence Ouverte 2.0",
            "COG en vigueur",
            group="communes",
        ),
        Source(
            f"clay_{d}",
            f"https://files.georisques.fr/argiles/2025/AleaRG_2025_{d}_L93.zip",
            f"{dep_dir(d)}/alearg.zip",
            "Géorisques / BRGM – exposition au retrait-gonflement des argiles",
            "Licence Ouverte",
            "carte d’exposition 2026 (arrêté du 9 janvier 2026)",
            group="clay",
        ),
        Source(
            f"water_plv_{d}",
            DIS_2025,
            f"{dep_dir(d)}/dis-plv-2025.txt",
            "Ministère de la Santé – contrôle sanitaire de l’eau distribuée",
            "Licence Ouverte 2.0",
            "prélèvements 2025",
            member=f"DIS_PLV_2025_0{d}.txt",
            group="water_plv",
        ),
    ]
    if d not in NO_DVF:
        out += [
            Source(
                f"dvf_{y}_{d}",
                f"https://files.data.gouv.fr/geo-dvf/latest/csv/{y}/departements/{d}.csv.gz",
                f"{dep_dir(d)}/dvf-{y}.csv.gz",
                "DGFiP – DVF géolocalisées (Etalab)",
                "Licence Ouverte 2.0 + CGU DGFiP",
                "2021–2025",
                group="dvf",
            )
            for y in DVF_YEARS
        ]
    return out


# Paris has no clay map (the national map excludes the city of Paris).
SOURCES += [s for d in DEPTS for s in _per_dept(d) if not (s.group == "clay" and d == "75")]
