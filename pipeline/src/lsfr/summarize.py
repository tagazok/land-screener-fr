"""Generate a short AI summary per commune with Amazon Bedrock (offline, cached).

The web app is static, so summaries are produced once here and shipped as
web/public/data/summaries/<dep>.json (one file per département, fetched by the
app when a commune is opened). Each summary is cached by a hash of the facts,
model and prompt version: re-running only calls Bedrock for communes whose
data changed.

    uv run lsfr summarize            # all communes
    uv run lsfr summarize --limit 5  # try a few first
"""

from __future__ import annotations

import hashlib
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

MODEL_ID = "us.anthropic.claude-haiku-5-5"
REGION = "us-east-1"
PROMPT_VERSION = "2026-10-19.4"

# (column, French label, kind) — kind drives formatting.
FACTS: list[tuple[str, str, str]] = [
    ("pop", "Population 2022", "int"),
    ("pop_cagr_11y", "Croissance de la population par an (2011–2022)", "pct2"),
    ("density", "Densité (hab./km²)", "int"),
    ("aav_category", "Position par rapport aux villes (INSEE)", "text"),
    ("aav_name", "Aire d’attraction", "text"),
    ("median_income", "Niveau de vie médian 2021 (€/an)", "int"),
    ("vacancy_rate", "Logements vacants", "pct"),
    ("second_home_share", "Résidences secondaires", "pct"),
    ("tourist_beds_per_1000", "Lits touristiques pour 1000 hab.", "int"),
    ("price_m2_house", "Prix médian maison (€/m², 2024–2025)", "int"),
    ("n_sales_house", "Ventes de maisons utilisées", "int"),
    ("price_m2_apt", "Prix médian appartement (€/m²)", "int"),
    ("price_trend_3y", "Évolution des prix en 3 ans", "pct"),
    ("land_price_m2", "Prix médian terrain à bâtir (€/m²)", "int"),
    ("rent_m2_house", "Loyer estimé maison (€/m²/mois, charges comprises)", "dec"),
    ("rent_confidence_house", "Fiabilité du loyer estimé", "text"),
    ("gross_yield_house", "Rendement brut location maison", "pct"),
    ("gross_yield_apt", "Rendement brut location appartement", "pct"),
    ("tfpb_rate", "Taux total de taxe foncière (%)", "dec"),
    ("second_home_surcharge", "Surtaxe d’habitation résidences secondaires (%)", "int"),
    ("zone_tendue", "Zone tendue", "bool"),
    ("apl_gp", "Accès aux médecins généralistes (consultations/an/hab., désert médical < 2,5)", "dec"),
    ("dist_gp_km", "Distance au médecin le plus proche (km, 0 = dans la commune)", "dec"),
    ("dist_supermarket_km", "Distance au supermarché (km)", "dec"),
    ("dist_college_km", "Distance au collège (km)", "dec"),
    ("dist_lycee_km", "Distance au lycée (km)", "dec"),
    ("dist_emergency_km", "Distance aux urgences (km)", "dec"),
    ("dist_train_km", "Distance à une gare (km)", "dec"),
    ("fibre_share", "Logements éligibles à la fibre", "pct"),
    ("clay_high_share", "Surface en exposition forte aux argiles (fissures des maisons)", "pct"),
    ("catnat_drought", "Arrêtés catastrophe naturelle sécheresse depuis 1996", "int"),
    ("catnat_flood", "Arrêtés catastrophe naturelle inondation depuis 1996", "int"),
    ("ppr_flood", "Plan de prévention inondation", "bool"),
    ("risk_marine_flood", "Risque de submersion marine", "bool"),
    ("coast_retreat_decree", "Commune listée pour le recul du trait de côte", "bool"),
    ("risk_forest_fire", "Risque feu de forêt", "bool"),
    ("ppr_industrial", "Plan de prévention des risques technologiques (site Seveso)", "bool"),
    ("radon_class", "Potentiel radon (1 faible – 3 significatif)", "int"),
    ("drought_days_avg", "Jours par an de restriction d’eau renforcée (moy. 2021–2025)", "int"),
    ("crisis_days_avg", "Jours par an au niveau « crise » (moy. 2021–2025)", "int"),
    ("water_limit_breach_share", "Analyses d’eau du robinet hors limites sanitaires (2025)", "pct"),
]

SYSTEM = """Tu es un analyste immobilier français, factuel et prudent. On te donne des données ouvertes sur UNE commune de France métropolitaine, avec pour comparaison la médiane des communes de son département, et le verdict de l’outil de tri pour 5 projets.

Écris un résumé en français de 5 phrases, 150 mots au maximum, en un seul paragraphe, sans titre ni liste. Les phrases 1 à 3 font 70 mots au plus à elles trois : 2 chiffres par phrase, les plus parlants.
1. Ce qui caractérise la commune (taille, lien à une ville, dynamique de population).
2. Ses principaux atouts, chiffres à l’appui.
3. Ses principaux points de vigilance (risques naturels, eau, accès aux soins, prix), chiffres à l’appui.
4. Pour quel(s) projet(s) l’outil la retient, et ce qui la rend adaptée à ce projet.
5. Pour quels projets elle est écartée, avec le critère décisif et son chiffre (par exemple « écartée pour la location saisonnière : seulement 4 lits touristiques pour 1 000 habitants, contre 100 requis »). Si elle est écartée partout, dis-le et donne les deux critères les plus bloquants. Si elle est retenue partout, dis-le.

Règles strictes :
- Le bloc « VERDICT DE L’OUTIL » fait foi : ne dis jamais qu’un projet est adapté si l’outil l’écarte, ni l’inverse. N’explique pas un rejet par un autre critère que ceux listés.
- Chacun des 5 projets doit apparaître dans la phrase 4 ou 5 : aucun projet écarté ne doit être oublié.
- Regroupe les projets écartés pour la même raison dans une même proposition plutôt que de les énumérer un par un ; pour un projet écarté par plusieurs critères, donne le plus parlant.
- Cite obligatoirement chaque élément de la ligne « RISQUES RÉGLEMENTÉS PRÉSENTS », et ne mentionne pas les risques absents.
- N’utilise QUE les données fournies. N’invente aucun fait, aucun lieu, aucune caractéristique (pas de « vignobles », « plages », « château » si ce n’est pas dans les données).
- Une donnée absente (« n.d. ») est inconnue : ne la commente pas.
- Ne qualifie une valeur de « élevée », « forte » ou « faible » que si elle s’écarte nettement de la médiane de comparaison fournie.
- Compare à cette médiane quand c’est utile, en la nommant comme indiqué dans les données (« médiane du département » ou « médiane nationale »), sans répéter « médiane » à chaque chiffre.
- Une distance de 0 km signifie que le service est dans la commune : écris « dans la commune ».
- Pas de conseil d’investissement ferme, pas de superlatifs commerciaux. Ton neutre et clair.
- Écris les nombres à la française (2 500 €, 5,8 %)."""

# Strategy ids -> how the summary names them (matches the app's tabs).
STRATEGY_NAMES = {
    "long": "location longue durée (location vide à l’année)",
    "medium": "location moyenne durée (meublé, bail mobilité ; calculée pour un appartement)",
    "short": "location courte durée (saisonnière)",
    "live": "habiter sur le long terme",
    "land": "achat de terrain à bâtir",
}


def _fmt(v, kind: str) -> str:
    if v is None:
        return "n.d."
    if kind == "bool":
        return "oui" if v else "non"
    if kind == "text":
        return {"high": "élevée", "medium": "moyenne", "low": "faible"}.get(v, str(v))
    if kind == "int":
        return f"{v:,.0f}".replace(",", " ")
    if kind == "dec":
        return f"{v:.1f}".replace(".", ",")
    if kind == "pct":
        return f"{v * 100:.1f} %".replace(".", ",")
    if kind == "pct2":
        return f"{v * 100:.2f} %".replace(".", ",")
    return str(v)


REGULATED_RISKS = [
    ("ppr_flood", "plan de prévention inondation"),
    ("risk_marine_flood", "risque de submersion marine"),
    ("coast_retreat_decree", "recul du trait de côte (commune listée par décret)"),
    ("risk_forest_fire", "risque feu de forêt"),
    ("ppr_industrial", "plan de prévention des risques technologiques (site industriel Seveso)"),
]

MAX_WORDS = 230


def facts_text(row: dict, medians: dict, ref: str = "médiane du département") -> str:
    present = [label for col, label in REGULATED_RISKS if row.get(col) is True]
    lines = [
        f"Commune : {row['nom']} (code INSEE {row['code']}, département {row.get('dep', '')})",
        f"Les comparaisons entre parenthèses sont la {ref}.",
        "RISQUES RÉGLEMENTÉS PRÉSENTS — à citer tous dans le résumé : " + ("; ".join(present) if present else "aucun"),
    ]
    for col, label, kind in FACTS:
        v = row.get(col)
        line = f"- {label} : {_fmt(v, kind)}"
        if kind in ("int", "dec", "pct", "pct2") and col in medians and v is not None:
            line += f" ({ref} : {_fmt(medians[col], kind)})"
        lines.append(line)
    return "\n".join(lines)


def verdict_text(fit: dict) -> str:
    """The screener's own pass/fail per strategy (default settings), from web/scripts/strategy-fit.ts."""
    lines = ["VERDICT DE L’OUTIL (réglages par défaut, fait foi) :"]
    for sid, name in STRATEGY_NAMES.items():
        f = fit.get(sid)
        if not f:
            continue
        lines.append(f"- {name} : " + ("RETENUE" if f["pass"] else "ÉCARTÉE — " + " ; ".join(f["why"])))
    return "\n".join(lines)


def compute_medians(rows: list[dict]) -> dict:
    out = {}
    for col, _, kind in FACTS:
        if kind in ("int", "dec", "pct", "pct2"):
            vals = [r[col] for r in rows if isinstance(r.get(col), (int, float))]
            if vals:
                out[col] = statistics.median(vals)
    return out


def _key(text: str) -> str:
    return hashlib.sha256(f"{MODEL_ID}|{PROMPT_VERSION}|{SYSTEM}|{text}".encode()).hexdigest()[:20]


def _converse(client, messages: list) -> tuple[str, dict]:
    for attempt in range(6):
        try:
            r = client.converse(
                modelId=MODEL_ID,
                system=[{"text": SYSTEM}],
                messages=messages,
                inferenceConfig={"maxTokens": 700},
                # This model thinks by default and can spend the whole budget on
                # reasoning; a short factual summary does not need it.
                additionalModelRequestFields={"thinking": {"type": "disabled"}},
            )
            # Some models put a reasoning block first: keep only the text blocks.
            parts = [b["text"] for b in r["output"]["message"]["content"] if "text" in b]
            if not parts:
                raise RuntimeError(f"no text in response: {r['output']['message']['content']!r:.200}")
            return "\n".join(parts).strip(), r["usage"]
        except Exception as e:  # throttling / transient
            if attempt == 5:
                raise
            time.sleep(2 * (attempt + 1) + (2 if "Throttl" in str(e) else 0))
    raise RuntimeError("unreachable")


def _call(client, text: str) -> tuple[str, dict]:
    """Generate, then ask once for a shorter version if the model ran long."""
    messages = [{"role": "user", "content": [{"text": text}]}]
    summary, usage = _converse(client, messages)
    if len(summary.split()) > MAX_WORDS:
        messages += [
            {"role": "assistant", "content": [{"text": summary}]},
            {"role": "user", "content": [{"text": "Trop long. Réécris-le en 150 mots maximum, en 5 phrases, en gardant tous les risques réglementés, le verdict pour chaque projet et le critère décisif de chaque rejet."}]},
        ]
        summary, u2 = _converse(client, messages)
        usage = {k: usage.get(k, 0) + u2.get(k, 0) for k in ("inputTokens", "outputTokens")}
    return summary, usage


def write_summaries(data_dir: Path, cache: dict, dep_of: dict[str, str]) -> int:
    """Publish one summaries/<dep>.json per département (the app fetches one when a commune is opened).

    Also writes into web/dist so a running preview picks them up. Returns the number of summaries.
    """
    per_dep: dict[str, dict[str, str]] = {}
    for c, v in sorted(cache.items()):
        if c in dep_of:
            per_dep.setdefault(dep_of[c], {})[c] = v["text"]
    head = {"model": MODEL_ID, "prompt_version": PROMPT_VERSION, "generated": date.today().isoformat()}
    for d in (data_dir, data_dir.parents[1] / "dist" / "data"):
        if not d.is_dir():
            continue
        out_dir = d / "summaries"
        out_dir.mkdir(exist_ok=True)
        for dep, summaries in per_dep.items():
            blob = json.dumps({**head, "summaries": summaries}, ensure_ascii=False, separators=(",", ":"))
            tmp = out_dir / f"{dep}.json.tmp"
            tmp.write_text(blob)
            tmp.replace(out_dir / f"{dep}.json")  # atomic: the browser never reads a half-written file
        (d / "summaries.json").unlink(missing_ok=True)  # old single-file format
    return sum(len(s) for s in per_dep.values())


def summarize(data_dir: Path, cache_path: Path, limit: int | None = None, workers: int = 6,
              depts: list[str] | None = None, publish_only: bool = False) -> None:
    d = json.loads((data_dir / "communes.json").read_text())
    rows = [dict(zip(d["cols"], vals)) for vals in zip(*d["cols"].values())]
    if publish_only:
        cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
        n = write_summaries(data_dir, cache, {r["code"]: r["dep"] for r in rows})
        print(f"published {n} summaries from the cache (no Bedrock call)", flush=True)
        return
    import boto3

    by_dep: dict[str, list[dict]] = {}
    for r in rows:
        by_dep.setdefault(r["dep"], []).append(r)
    dep_medians = {k: compute_medians(v) for k, v in by_dep.items()}
    national = compute_medians(rows)
    # A median over a handful of communes is meaningless (Paris is alone in its
    # département): compare those with the national median instead.
    small = {k for k, v in by_dep.items() if len(v) < 20}
    fit_path = cache_path.parent / "strategy-fit.json"
    if not fit_path.exists():
        raise SystemExit(f"{fit_path} missing: run `npx vite-node scripts/strategy-fit.ts` in web/ first")
    fit = json.loads(fit_path.read_text())["fit"]
    targets = [r for r in rows if not depts or r["dep"] in depts]
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    todo = []
    for r in targets[: limit or len(targets)]:
        if r["dep"] in small:
            text = facts_text(r, national, "médiane des communes de France métropolitaine")
        else:
            text = facts_text(r, dep_medians[r["dep"]])
        text += "\n" + verdict_text(fit.get(r["code"], {}))
        k = _key(text)
        if cache.get(r["code"], {}).get("key") != k:
            todo.append((r["code"], text, k))
    print(f"{len(rows)} communes, {len(todo)} to (re)generate with {MODEL_ID}", flush=True)

    client = boto3.client("bedrock-runtime", region_name=REGION)
    tokens_in = tokens_out = 0
    done = failed = 0
    dep_of = {r["code"]: r["dep"] for r in rows}

    def publish() -> int:
        """Write the cache, then the per-département summary files."""
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=0))
        return write_summaries(data_dir, cache, dep_of)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_call, client, text): (code, k) for code, text, k in todo}
        for fut in as_completed(futs):
            code, k = futs[fut]
            try:
                summary, usage = fut.result()
            except Exception as e:
                failed += 1
                print(f"  ! {code}: {str(e)[:200]}", flush=True)
                continue
            cache[code] = {"key": k, "text": summary}
            tokens_in += usage.get("inputTokens", 0)
            tokens_out += usage.get("outputTokens", 0)
            done += 1
            if done % 250 == 0:
                n = publish()
                print(f"  {done}/{len(todo)} done, {failed} failed, {tokens_in} in + {tokens_out} out tokens, "
                      f"{n} summaries published", flush=True)
    n = publish()
    print(f"FINISHED: {done} generated, {failed} failed (re-run to retry), {n} summaries published; "
          f"this run used {tokens_in} input + {tokens_out} output tokens", flush=True)
