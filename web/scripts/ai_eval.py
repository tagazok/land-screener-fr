"""Replay the assistant's planning prompts against Bedrock (local AWS profile) and score them.

    cd web && npx vite-node scripts/ai-eval-prompts.ts > ../raw/ai/eval-prompts.json
    cd ../pipeline && uv run python ../web/scripts/ai_eval.py [model-id]
"""

import json
import sys
import time
from pathlib import Path

import boto3

MODEL = sys.argv[1] if len(sys.argv) > 1 else "us.anthropic.claude-haiku-5-5"
qs = json.loads((Path(__file__).resolve().parents[2] / "raw" / "ai" / "eval-prompts.json").read_text())
client = boto3.client("bedrock-runtime", region_name="us-east-1")
ok = 0
for q in qs:
    t = time.time()
    def call(choice):
        return client.converse(
            modelId=MODEL,
            system=[{"text": q["bedrock"]["system"] + "\nRéponds toujours en appelant l'outil apply_plan."}],
            messages=[{"role": "user", "content": [{"text": q["text"]}]}],
            inferenceConfig={"maxTokens": 4000},
            toolConfig={"tools": [{"toolSpec": {"name": "apply_plan", "description": "Applique les critères.",
                                                "inputSchema": {"json": q["bedrock"]["schema"]}}}],
                        "toolChoice": choice},
        )

    try:  # same fallback as the app: models that reason first refuse a forced tool
        r = call({"tool": {"name": "apply_plan"}})
    except client.exceptions.ValidationException as e:
        if "tool_choice" not in str(e):
            raise
        r = call({"auto": {}})
    use = next(c["toolUse"] for c in r["output"]["message"]["content"] if "toolUse" in c)
    plan = use["input"]
    got = {f"{f['column']}:{f['op']}" for f in plan.get("filters", [])}
    if plan.get("tiers"):
        got.add("tiers:" + "".join(sorted(plan["tiers"])))
    if q["expect"] == ["none"]:  # a follow-up question must not add filters
        missing = sorted(got) if got else []
    else:
        missing = [e for e in q["expect"] if not any(alt in got for alt in e.split("|"))]
    web_ok = bool(plan.get("web_search")) == bool(q.get("web", False))
    if not web_ok:
        missing = missing + [f"web_search should be {bool(q.get('web', False))}"]
    good = not missing and plan.get("mode") == q["mode"]
    ok += good
    print(f"{'OK ' if good else 'BAD'} {q['id']:15s} {time.time() - t:4.1f}s mode={plan.get('mode')} "
          f"strategy={plan.get('strategy')} deps={plan.get('departements')} color={plan.get('color_by')} "
          f"forest={plan.get('forest_layer')} tiers={plan.get('tiers')}")
    print("     filters:", ", ".join(f"{f['column']} {f['op']} {f['value']}" for f in plan.get("filters", [])))
    if missing:
        print("     MISSING:", missing)
print(f"{ok}/{len(qs)} correct with {MODEL}; nano prompt sizes:", [q["nano"]["chars"] for q in qs])
