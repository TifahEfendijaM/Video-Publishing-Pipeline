import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { interpretPlan, interpretManualEntry, interpretSelection } from './publishing-plan';
import type { CaptionModel } from './captioner';

export type InterpretationKind = 'plan' | 'manual' | 'rule';
export const noModel: CaptionModel = {model:'deterministic validation', run:async()=>{throw new Error('This entry requires AI interpretation');}};
const Response = z.object({status:z.enum(['ready','needs_clarification']), normalized:z.string().max(16000).nullable(), explanation:z.string().min(1).max(2000)}).strict();
export const INTERPRETATION_SCHEMA = {
  type:'object', properties:{status:{type:'string',enum:['ready','needs_clarification']}, normalized:{type:['string','null']}, explanation:{type:'string'}},
  required:['status','normalized','explanation'], additionalProperties:false,
};

export async function validateNormalized(kind: InterpretationKind, text: string): Promise<void> {
  if (!text.trim()) throw new Error('AI returned an empty interpretation');
  if (kind === 'plan') await interpretPlan(text, noModel);
  else if (kind === 'manual') await interpretManualEntry(text, noModel);
  else await interpretSelection(text, noModel);
}

export interface InterpretationContext { savedPlan: string; filenames: string[]; referenceTime: string }
/** Formatted entries skip AI. The model interprets natural text; code validates all resulting rules. */
export async function flexibleInterpretation(kind: InterpretationKind, text: string, model: CaptionModel, context:()=>Promise<InterpretationContext>): Promise<string> {
  if (!text.trim() || text.length > (kind === 'manual' ? 2000 : 16000)) throw new Error('Entry is empty or too long');
  try { await validateNormalized(kind, text); return text; } catch { /* Natural entry below. */ }
  if (!model.run) throw new Error('On-demand interpretation is not configured');
  const system = readFileSync(new URL('../prompts/interpretation.md', import.meta.url), 'utf8');
  const data = {kind, text, timeZone:'Europe/Sarajevo', ...await context()};
  const result = Response.parse(await model.run(system, JSON.stringify(data)));
  if (result.status !== 'ready') throw new Error(`Clarification needed: ${result.explanation}. No settings changed`);
  if (!result.normalized?.trim()) throw new Error('AI returned an empty interpretation');
  await validateNormalized(kind, result.normalized);
  return result.normalized;
}

export function writeWorkflowOutput(path: string, name: string, value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid output name');
  let delimiter: string;
  do { delimiter='EB_'+randomUUID(); } while(value.split(/\r?\n/).includes(delimiter));
  appendFileSync(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
