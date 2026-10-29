// Dumps, for each test question, the exact system prompt and plan schema the app
// would send, so scripts/ai_eval.py can replay them against Bedrock.
//   npx vite-node scripts/ai-eval-prompts.ts > ../raw/ai/eval-prompts.json
import { planSchema, systemPrompt } from '../src/ai/plan';
import { QUESTIONS } from '../src/ai/eval-questions';

const out = QUESTIONS.map((q) => {
  const big = systemPrompt(q.text, true);
  const small = systemPrompt(q.text, false);
  return { ...q, bedrock: { system: big.text, schema: planSchema(big.columns) }, nano: { system: small.text, schema: planSchema(small.columns), chars: small.text.length } };
});
process.stdout.write(JSON.stringify(out));
