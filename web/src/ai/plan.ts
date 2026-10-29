// The assistant never touches the app directly. A model only produces a Plan
// (a small JSON object constrained by PLAN_SCHEMA); the app validates it and
// applies it with its own engine. Anything unknown is dropped, not guessed.

import { CATALOG_IDS, STRATEGY_IDS, STRATEGY_TEXT, describe, relevant, toStored } from './catalog';
import type { FilterDef } from '../engine';
import { COLUMNS, type StrategyId } from '../strategies';

export type PlanOp = 'min' | 'max' | 'is_true' | 'is_false';

export interface Plan {
  /** "answer": the user asked a question and wants a text answer; "action": just change the view. */
  mode: 'answer' | 'action';
  strategy: StrategyId | null;
  /** Département names or codes to restrict to; null = keep; [] = all of France. */
  departements: string[] | null;
  /** Remove the filters added earlier by the assistant before adding these. */
  reset_filters: boolean;
  filters: { column: string; op: PlanOp; value: number | null }[];
  color_by: string | null;
  forest_layer: boolean | null;
  relief_layer: boolean | null;
  /** One short sentence, in French, restating what was understood. */
  summary: string;
}

export function planSchema(columns: string[] = CATALOG_IDS) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'strategy', 'departements', 'reset_filters', 'filters', 'color_by', 'forest_layer', 'relief_layer', 'summary'],
    properties: {
      mode: { type: 'string', enum: ['answer', 'action'] },
      strategy: { type: ['string', 'null'], enum: [...STRATEGY_IDS, null] },
      departements: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20 },
      reset_filters: { type: 'boolean' },
      filters: {
        type: 'array', maxItems: 16,
        items: {
          type: 'object', additionalProperties: false, required: ['column', 'op', 'value'],
          properties: {
            column: { type: 'string', enum: columns },
            op: { type: 'string', enum: ['min', 'max', 'is_true', 'is_false'] },
            value: { type: ['number', 'null'] },
          },
        },
      },
      color_by: { type: ['string', 'null'], enum: [...columns, null] },
      forest_layer: { type: ['boolean', 'null'] },
      relief_layer: { type: ['boolean', 'null'] },
      summary: { type: 'string', maxLength: 300 },
    },
  } as const;
}

export function systemPrompt(question: string, all: boolean): { text: string; columns: string[] } {
  const { entries, hints } = relevant(question, all);
  return {
    columns: entries.map((e) => e.id),
    text: `Tu pilotes une application qui compare les 34 746 communes de France métropolitaine.
Traduis la demande de l'utilisateur en un objet JSON qui modifie l'affichage. Règles :
- filters : une condition par critère. op "min" = au moins, "max" = au plus, "is_true"/"is_false" pour oui/non (value null).
- Les valeurs en % s'écrivent en pourcentage : 5 veut dire 5 %. Les autres valeurs dans l'unité indiquée.
- N'utilise que les colonnes listées. N'invente pas de critère que l'utilisateur n'a pas demandé.
- mode "answer" si l'utilisateur pose une question ou décrit ce qu'il cherche ; "action" s'il demande seulement de changer la carte ou la liste (masquer, afficher, colorer).
- strategy : ${STRATEGY_TEXT}. null si non mentionné ; "live" pour quelqu'un qui veut y habiter.
- departements : noms ou numéros de départements cités, sinon null.
- reset_filters : true si la demande remplace la précédente, false si elle la complète.
- color_by : une colonne pour colorer la carte si l'utilisateur le demande, sinon null.
- forest_layer / relief_layer : true pour afficher les forêts / le relief, false pour les masquer, sinon null.
- summary : une phrase en français qui résume ce que tu as compris.
Correspondances utiles :
${hints.map((h) => `- ${h}`).join('\n') || '- (aucune)'}
Colonnes disponibles :
${describe(entries)}`,
  };
}

export interface Applied {
  filters: FilterDef[];
  dropped: string[];
}

/** Turn plan filters into engine filters; unknown columns or missing values are reported, not applied. */
export function planFilters(plan: Plan): Applied {
  const out: FilterDef[] = [];
  const dropped: string[] = [];
  for (const f of plan.filters ?? []) {
    const col = COLUMNS[f.column];
    if (!col) { dropped.push(f.column); continue; }
    const isBool = col.unit === 'bool';
    if (f.op === 'is_true' || f.op === 'is_false') {
      if (!isBool) { dropped.push(f.column); continue; }
      out.push({ id: `x:${f.column}:${f.op === 'is_true' ? 'isTrue' : 'isFalse'}`, column: f.column, op: f.op === 'is_true' ? 'isTrue' : 'isFalse', enabled: true });
      continue;
    }
    if (isBool || typeof f.value !== 'number' || !Number.isFinite(f.value)) { dropped.push(f.column); continue; }
    out.push({ id: `x:${f.column}:${f.op}`, column: f.column, op: f.op, value: toStored(f.column, f.value), enabled: true });
  }
  return { filters: out, dropped };
}

/** Parse a model's text output into a Plan (tolerates code fences). */
export function parsePlan(text: string): Plan {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('réponse sans JSON');
  const p = JSON.parse(m[0]) as Partial<Plan>;
  return {
    mode: p.mode === 'action' ? 'action' : 'answer',
    strategy: p.strategy && (STRATEGY_IDS as string[]).includes(p.strategy) ? p.strategy : null,
    departements: Array.isArray(p.departements) ? p.departements.map(String) : null,
    reset_filters: !!p.reset_filters,
    filters: Array.isArray(p.filters) ? p.filters : [],
    color_by: p.color_by && p.color_by in COLUMNS ? p.color_by : null,
    forest_layer: typeof p.forest_layer === 'boolean' ? p.forest_layer : null,
    relief_layer: typeof p.relief_layer === 'boolean' ? p.relief_layer : null,
    summary: String(p.summary ?? ''),
  };
}

export const ANSWER_SYSTEM = `Tu es un assistant immobilier. Réponds en français, en 4 à 6 phrases, sans liste à puces.
Appuie-toi UNIQUEMENT sur les communes et les chiffres fournis : n'invente aucun chiffre ni aucune commune.
Cite 3 à 5 communes en expliquant pourquoi elles correspondent, et signale un point de vigilance s'il y en a un.
Si aucune commune ne correspond, dis-le et propose quel critère assouplir.`;
