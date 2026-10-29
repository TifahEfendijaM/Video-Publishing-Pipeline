import { interpretVideoRule } from './video-rule';
import type { CaptionModel } from './captioner';
import { parseCustomList, resolveCustomList, type CustomVideo, type TitleRule, type JobPolicy } from '../../src/shared/job-selection';
import { validatePlanEntries, type PlanEntryInput } from '../../src/shared/publishing-plan';
import { parseSchedule, formatSchedule } from '../../src/shared/schedule';
import type { FolderVideo } from '../../src/shared/selection';

export interface SelectionEntry { policy: JobPolicy; titleRule: TitleRule | null; filenames: string[] }
export async function interpretSelection(text: string, model: CaptionModel): Promise<SelectionEntry> {
  const value = text.trim();
  const custom = /^(?:custom|(?:publish\s+)?(?:this\s+)?list(?:\s+in\s+order)?)\s*:\s*([\s\S]+)$/i.exec(value);
  if (custom) return { policy: 'custom', titleRule: null, filenames: parseCustomList(custom[1]) };
  const aliases: Record<string,'fifo'|'lifo'|'random'> = { fifo:'fifo', 'oldest video first':'fifo', 'oldest first':'fifo', lifo:'lifo', 'newest video first':'lifo', 'newest first':'lifo', random:'random', 'random video':'random' };
  if (aliases[value.toLowerCase()]) return { policy: aliases[value.toLowerCase()], titleRule: null, filenames: [] };
  const literal = /^(fifo|lifo|random) video whose title (contains|starts with|ends with) (".*")$/i.exec(value);
  if (literal) {
    const text: unknown = JSON.parse(literal[3]);
    if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Invalid title filter');
    return {policy:'title_rule', filenames:[], titleRule:{match:literal[2].toLowerCase().replace(/ /g,'_') as TitleRule['match'],text,order:literal[1].toLowerCase() as TitleRule['order']}};
  }
  const interpreted = await interpretVideoRule(value,model);
  return { ...interpreted, filenames: [] };
}

/** Pair each timetable with its rule before interpreting; times and lists never depend on positions in separate fields. */
export async function interpretPlan(text: string, model: CaptionModel) {
  if (!text.trim() || text.length > 16000) throw new Error('Enter a plan of 1–16000 characters');
  const lines = splitEntries(text);
  if (lines.length > 20) throw new Error('The plan supports at most 20 timetable/rule entries');
  const entries: (SelectionEntry & {scheduleText: string})[] = [];
  for (const line of lines) {
    const delimiter = /:\s+|\s*=>\s*/.exec(line);
    if (!delimiter) throw new Error('Pair each timetable with a rule: Monday at 06:00: newest video first');
    const slots = parseSchedule(line.slice(0,delimiter.index));
    if (!slots) throw new Error('Each rule needs a weekly timetable');
    const selection = await interpretSelection(line.slice(delimiter.index+delimiter[0].length),model);
    entries.push({...selection,scheduleText:formatSchedule(slots)});
  }
  // Validate schedules/overlaps before any Drive reads or saved changes.
  validatePlanEntries(entries.map((entry,index)=>({...entry,custom:entry.filenames.map((fileName,i)=>({fileId:`preview_${index}_${String(i).padStart(5,'0')}`,fileName}))})));
  return entries;
}

function splitEntries(text: string) {
  const entries: string[] = []; let field='', quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {
      if(quoted && text[i+1]==='"') {field+='""';i++;continue;}
      quoted=!quoted;
    }
    if(!quoted && (c==='|' || c==='\n' || c==='\r')) {if(field.trim())entries.push(field.trim());field='';}
    else field+=c;
  }
  if(quoted) throw new Error('The plan has an unclosed filename quote');
  if(field.trim())entries.push(field.trim());
  return entries;
}

export function resolvePlan(entries: (SelectionEntry & {scheduleText:string})[], videos: FolderVideo[], saved: {originalCustom:CustomVideo[]}[]): PlanEntryInput[] {
  return validatePlanEntries(entries.map(entry=> {
    let custom: CustomVideo[]=[];
    if(entry.policy==='custom') {
      // Resubmitting an unchanged list can include already archived filenames. Preserve its identity.
      const prior = saved.find(j=>JSON.stringify(j.originalCustom.map(v=>v.fileName.normalize('NFC')))===JSON.stringify(entry.filenames));
      custom = prior?.originalCustom ?? resolveCustomList(entry.filenames.map(n=>`"${n.replace(/"/g,'""')}"`).join(','),videos);
    }
    return {scheduleText:entry.scheduleText,policy:entry.policy,titleRule:entry.titleRule,custom};
  }));
}
