// Two interchangeable model backends:
// - "nano": Chrome's built-in Gemini Nano (Prompt API). Runs on the device, no key, no network.
// - "bedrock": Amazon Bedrock Converse API, called straight from the browser with the
//   user's own Bedrock API key (kept in this browser's localStorage only).

import { ANSWER_SYSTEM, parsePlan, planSchema, systemPrompt, type Plan } from './plan';

export type ProviderId = 'nano' | 'bedrock';

export interface AiSettings {
  provider: ProviderId;
  bedrockKey: string;
  bedrockRegion: string;
  bedrockModel: string;
}

const KEY = 'lsfr-ai';
export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'nano', bedrockKey: '', bedrockRegion: 'us-east-1', bedrockModel: 'us.anthropic.claude-haiku-5-5',
};

export function loadSettings(): AiSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AiSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

// ------------------------------------------------------------------ Chrome built-in model
/* eslint-disable @typescript-eslint/no-explicit-any */
const LM = () => (globalThis as any).LanguageModel as any | undefined;
const NANO_LANG = { expectedInputs: [{ type: 'text', languages: ['fr', 'en'] }], expectedOutputs: [{ type: 'text', languages: ['fr'] }] };

export type NanoState = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

export async function nanoAvailability(): Promise<NanoState> {
  const lm = LM();
  if (!lm) return 'unsupported';
  try {
    return (await lm.availability(NANO_LANG)) as NanoState;
  } catch {
    return 'unavailable';
  }
}

async function nanoSession(system: string, onProgress?: (p: number) => void): Promise<any> {
  return LM().create({
    ...NANO_LANG,
    initialPrompts: [{ role: 'system', content: system }],
    monitor(m: any) { m.addEventListener('downloadprogress', (e: any) => onProgress?.(e.loaded)); },
  });
}

// ------------------------------------------------------------------ Bedrock
async function converse(s: AiSettings, body: object, signal?: AbortSignal): Promise<any> {
  const url = `https://bedrock-runtime.${s.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(s.bedrockModel)}/converse`;
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.bedrockKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = r.headers.get('x-amzn-ErrorMessage') ?? (await r.text()).slice(0, 300);
    throw new Error(`Bedrock ${r.status} : ${msg}`);
  }
  return r.json();
}

// ------------------------------------------------------------------ public API
export interface Assistant {
  /** Turn a request into a Plan. */
  plan(question: string, signal?: AbortSignal): Promise<Plan>;
  /** Write a short answer from the question and the facts of the top communes. */
  answer(question: string, facts: string, signal?: AbortSignal): Promise<string>;
}

export function assistant(s: AiSettings, onProgress?: (p: number) => void): Assistant {
  if (s.provider === 'bedrock') {
    return {
      async plan(question, signal) {
        const { text, columns } = systemPrompt(question, true);
        const call = (toolChoice: object) => converse(s, {
          system: [{ text: `${text}\nRéponds toujours en appelant l'outil apply_plan.` }],
          messages: [{ role: 'user', content: [{ text: question }] }],
          inferenceConfig: { maxTokens: 4000 },
          toolConfig: {
            tools: [{ toolSpec: { name: 'apply_plan', description: 'Applique les critères à la carte et à la liste des communes.', inputSchema: { json: planSchema(columns) } } }],
            toolChoice,
          },
        }, signal);
        // Forcing the tool is the most reliable, but models that reason first (e.g. Sonnet 5.5)
        // refuse it: fall back to letting the model choose, with the instruction above.
        let res;
        try {
          res = await call({ tool: { name: 'apply_plan' } });
        } catch (e) {
          if (!/tool_choice/.test((e as Error).message)) throw e;
          res = await call({ auto: {} });
        }
        const content = res.output?.message?.content ?? [];
        const use = content.find((c: any) => c.toolUse)?.toolUse;
        if (use) return parsePlan(JSON.stringify(use.input));
        const txt = content.map((c: any) => c.text ?? '').join('');
        if (/\{[\s\S]*\}/.test(txt)) return parsePlan(txt);
        throw new Error('Bedrock n’a pas renvoyé de critères');
      },
      async answer(question, facts, signal) {
        const res = await converse(s, {
          system: [{ text: ANSWER_SYSTEM }],
          messages: [{ role: 'user', content: [{ text: `Demande : ${question}\n\nCommunes retenues (les meilleures d'abord) :\n${facts}` }] }],
          inferenceConfig: { maxTokens: 3000 },
        }, signal);
        // Reasoning models also return a reasoningContent block: keep only the text.
        return res.output?.message?.content?.map((c: any) => c.text ?? '').join('').trim() ?? '';
      },
    };
  }
  return {
    async plan(question, signal) {
      const { text, columns } = systemPrompt(question, false);
      const session = await nanoSession(text, onProgress);
      try {
        const out = await session.prompt(question, { responseConstraint: planSchema(columns), signal });
        return parsePlan(out);
      } finally {
        session.destroy();
      }
    },
    async answer(question, facts, signal) {
      const session = await nanoSession(ANSWER_SYSTEM, onProgress);
      try {
        return await session.prompt(`Demande : ${question}\n\nCommunes retenues (les meilleures d'abord) :\n${facts}`, { signal });
      } finally {
        session.destroy();
      }
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
