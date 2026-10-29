import { interpretVideoRule } from './video-rule';
import type { CaptionModel } from './captioner';
import { parseCustomList, resolveCustomList, type CustomVideo, type TitleRule, type JobPolicy } from '../../src/shared/job-selection';
import { resolveCustomName } from '../../src/shared/selection';
import { validatePlanEntries, type PlanEntryInput } from '../../src/shared/publishing-plan';
import { parseSchedule, formatSchedule } from '../../src/shared/schedule';
import type { FolderVideo } from '../../src/shared/selection';

export interface SelectionEntry { policy: JobPolicy; titleRule: TitleRule | null; filenames: string[]; outroNames?: Partial<Record<'youtube'|'tiktok'|'instagram'|'facebook',string|null>> }
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
    const [rule, ...clauses] = splitOutsideQuotes(line.slice(delimiter.index+delimiter[0].length), c=>c===';');
    const outroNames: NonNullable<SelectionEntry['outroNames']> = {};
    for (const clause of clauses) {
      const match = /^(?:(youtube|tiktok|instagram|facebook)\s+)?outro\s*:\s*(.+)$/i.exec(clause);
      if (!match) throw new Error('Use ; outro: "Clip.mp4" or ; youtube outro: none after the selection rule');
      const names = parseCustomList(match[2]);
      if (names.length !== 1) throw new Error('Choose one outro filename per outro clause');
      const name = /^(none|off)$/i.test(match[2].trim()) ? null : names[0];
      const platforms = match[1] ? [match[1].toLowerCase()] : ['youtube','tiktok','instagram','facebook'];
      for (const platform of platforms) {
        if (platform in outroNames) throw new Error('Specify each platform outro only once in an entry');
        outroNames[platform as keyof typeof outroNames] = name;
      }
    }
    const selection = await interpretSelection(rule,model);
    entries.push({...selection,scheduleText:formatSchedule(slots), ...(clauses.length ? {outroNames} : {})});
  }
  // Validate schedules/overlaps before any Drive reads or saved changes.
  validatePlanEntries(entries.map((entry,index)=>({...entry,custom:entry.filenames.map((fileName,i)=>({fileId:`preview_${index}_${String(i).padStart(5,'0')}`,fileName}))})));
  return entries;
}

function splitEntries(text: string) { return splitOutsideQuotes(text,c=>c==='|' || c==='\n' || c==='\r'); }
function splitOutsideQuotes(text: string, separator: (c:string)=>boolean) {
  const entries: string[] = []; let field='', quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {
      if(quoted && text[i+1]==='"') {field+='""';i++;continue;}
      quoted=!quoted;
    }
    if(!quoted && separator(c)) {if(field.trim())entries.push(field.trim());field='';}
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
    const outros: NonNullable<PlanEntryInput['outros']> = {};
    for (const [platform, name] of Object.entries(entry.outroNames ?? {})) {
      if (name === null) outros[platform as keyof typeof outros] = null;
      else {
        const match = resolveCustomName(name, videos);
        if (match.kind !== 'match') throw new Error(`Outro "${name}" is missing or ambiguous; no plan changes saved`);
        outros[platform as keyof typeof outros] = {fileId:match.video.id,fileName:match.video.name};
      }
    }
    return {scheduleText:entry.scheduleText,policy:entry.policy,titleRule:entry.titleRule,custom, ...(entry.outroNames ? {outros} : {})};
  }));
}
