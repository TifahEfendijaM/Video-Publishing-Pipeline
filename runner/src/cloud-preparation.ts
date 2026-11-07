import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { interpretPlan, interpretManualEntry, interpretSelection } from './publishing-plan';
import type { CaptionModel } from './captioner';

const Output=z.object({topic_caption:z.string().max(600),website_invitation:z.string().max(300),youtube_title:z.string().max(100),youtube_description:z.string().max(1000)}).strict();
const Response=z.object({requestId:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(['ready','needs_clarification']),normalized:z.string().max(16000).nullable(),explanation:z.string().min(1).max(2000)}).strict();
const Prepared=z.object({schemaVersion:z.literal(1),updatedAt:z.iso.datetime().nullable(),captions:z.array(z.object({fileId:z.string().min(10).max(200),fileName:z.string().min(1).max(300),output:Output}).strict()).max(1000),responses:z.array(Response).max(100)}).strict();
export type Preparation= z.infer<typeof Prepared>;
export type InterpretationKind='plan'|'manual'|'rule';
export const noModel:CaptionModel={model:'deterministic validation',run:async()=>{throw new Error('This request requires cloud ChatGPT interpretation');}};

export function parsePreparation(text:string):Preparation {
  const parsed=Prepared.parse(JSON.parse(text.trim().replace(/^\uFEFF/,'')));
  if(new Set(parsed.captions.map(c=>c.fileId)).size!==parsed.captions.length || new Set(parsed.responses.map(r=>r.requestId)).size!==parsed.responses.length) throw new Error('Duplicate preparation records');
  return parsed;
}

export function preparedCaptionModel(prepared:Preparation, fileId:string, fileName:string):CaptionModel {
  const match=prepared.captions.find(c=>c.fileId===fileId && c.fileName.normalize('NFC')===fileName.normalize('NFC'));
  return {model:'ChatGPT cloud task',run:async()=>{
    if(!match) throw new Error('ChatGPT has not prepared this video filename yet; the hourly cloud task will prepare it');
    return match.output;
  }};
}

export async function validateNormalized(kind:InterpretationKind,text:string):Promise<void> {
  if(!text.trim()) throw new Error('ChatGPT returned an empty interpretation');
  if(kind==='plan') await interpretPlan(text,noModel);
  else if(kind==='manual') await interpretManualEntry(text,noModel);
  else await interpretSelection(text,noModel);
}

export function requestPayload(kind:InterpretationKind,text:string,referenceMs:number,savedPlan?:string) {
  if(!text.trim() || text.length>16000) throw new Error('Enter 1–16000 characters');
  const body={schemaVersion:1 as const,id:randomUUID(),kind,text,referenceTime:new Date(referenceMs).toISOString(),expiresAt:new Date(referenceMs+70*60000).toISOString(),timeZone:'Europe/Sarajevo',...(savedPlan!==undefined?{savedPlan}:{})};
  return {...body,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}

export function matchingResponse(prepared:Preparation,payload:ReturnType<typeof requestPayload>,nowMs:number):string|null {
  if(nowMs>=Date.parse(payload.expiresAt)) throw new Error('ChatGPT preparation timed out; no settings changed. Try again or use a formatted entry');
  const response=prepared.responses.find(r=>r.requestId===payload.id && r.digest===payload.digest);
  if(!response) return null;
  if(response.status!=='ready') throw new Error(`Clarification needed: ${response.explanation}. No settings changed`);
  if(!response.normalized?.trim()) throw new Error('ChatGPT returned an empty interpretation');
  return response.normalized;
}

export interface PreparationDrive {
  preparationText(documentId:string):Promise<string>;
  createPreparationRequest(id:string,payload:unknown):Promise<string>;
  clearPreparationRequest(fileId:string,id:string):Promise<void>;
}

/** Strict entries remain instant. Natural text goes through the subscription's hourly cloud task. */
export async function flexibleInterpretation(kind:InterpretationKind,text:string,drive:PreparationDrive,documentId:string,options:{savedPlan?:string;now?:()=>number;sleep?:(ms:number)=>Promise<void>;onWaiting?:()=>void}={}):Promise<string> {
  try {await validateNormalized(kind,text);return text;} catch { /* Whole-entry interpretation below. */ }
  const now=options.now??Date.now;
  const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  // Fail before writing a request if preparation is not configured/readable.
  for(let attempt=0;;attempt++) {
    try {parsePreparation(await drive.preparationText(documentId));break;}
    catch(e) {if(attempt===2) throw e;await sleep(2000);}
  }
  const payload=requestPayload(kind,text,now(),options.savedPlan);
  const fileId=await drive.createPreparationRequest(payload.id,payload);
  options.onWaiting?.();
  try {
    for(;;) {
      if(now()>=Date.parse(payload.expiresAt)) throw new Error('ChatGPT preparation timed out; no settings changed. Check the cloud task/result Doc or use a formatted entry');
      let prepared:Preparation;
      try {prepared=parsePreparation(await drive.preparationText(documentId));}
      catch {
        // Docs exports can briefly reflect an in-progress rewrite. Never consume partial output;
        // retry read-only until a valid snapshot arrives or this request expires.
        await sleep(30000);
        continue;
      }
      const result=matchingResponse(prepared,payload,now());
      if(result!==null) {await validateNormalized(kind,result);return result;}
      await sleep(30000);
    }
  } finally {
    // Cleanup failure must never discard an otherwise valid interpretation; expired IDs cannot act later.
    await drive.clearPreparationRequest(fileId,payload.id).catch(()=>{});
  }
}

export function writeWorkflowOutput(path:string,name:string,value:string) {
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid output name');
  let delimiter:string;
  do {delimiter='EB_'+randomUUID();} while(value.split(/\r?\n/).includes(delimiter));
  appendFileSync(path,`${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
