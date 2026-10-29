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
    r = client.converse(
        modelId=MODEL,
        system=[{"text": q["bedrock"]["system"]}],
        messages=[{"role": "user", "content": [{"text": q["text"]}]}],
        inferenceConfig={"maxTokens": 1500},
        toolConfig={"tools": [{"toolSpec": {"name": "apply_plan", "description": "Applique les critères.",
                                            "inputSchema": {"json": q["bedrock"]["schema"]}}}],
                    "toolChoice": {"tool": {"name": "apply_plan"}}},
    )
    use = next(c["toolUse"] for c in r["output"]["message"]["content"] if "toolUse" in c)
    plan = use["input"]
    got = {f"{f['column']}:{f['op']}" for f in plan.get("filters", [])}
    if plan.get("tiers"):
        got.add("tiers:" + "".join(sorted(plan["tiers"])))
    missing = [e for e in q["expect"] if not any(alt in got for alt in e.split("|"))]
    good = not missing and plan.get("mode") == q["mode"]
    ok += good
    print(f"{'OK ' if good else 'BAD'} {q['id']:15s} {time.time() - t:4.1f}s mode={plan.get('mode')} "
          f"strategy={plan.get('strategy')} deps={plan.get('departements')} color={plan.get('color_by')} "
          f"forest={plan.get('forest_layer')} tiers={plan.get('tiers')}")
    print("     filters:", ", ".join(f"{f['column']} {f['op']} {f['value']}" for f in plan.get("filters", [])))
    if missing:
        print("     MISSING:", missing)
print(f"{ok}/{len(qs)} correct with {MODEL}; nano prompt sizes:", [q["nano"]["chars"] for q in qs])
