import type { CustomVideo, JobPolicy, TitleRule } from './job-selection';
import { formatSchedule, parseSchedule } from './schedule';
export type EntryOutros = Partial<Record<'youtube'|'tiktok'|'instagram'|'facebook', CustomVideo | null>>;

export interface PlanEntryInput {
  scheduleText: string;
  policy: JobPolicy;
  custom: CustomVideo[];
  titleRule: TitleRule | null;
  outros?: EntryOutros;
}

/** Identity excludes timetable: moving an unchanged list to another day retains its progress. */
export function selectionKey(entry: { policy: JobPolicy; custom: CustomVideo[]; titleRule: TitleRule | null }): string {
  return JSON.stringify([entry.policy, entry.custom.map(v => v.fileId), entry.titleRule && [entry.titleRule.match, entry.titleRule.text.normalize('NFC').toLowerCase(), entry.titleRule.order]]);
}

export function validatePlanEntries(input: PlanEntryInput[]): PlanEntryInput[] {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new Error('Enter 1–20 timetable/rule entries');
  const slots = new Set<string>(), customIds = new Set<string>();
  return input.map(entry => {
    if (!entry || typeof entry.scheduleText !== 'string') throw new Error('Each entry needs a weekly timetable');
    const schedule = parseSchedule(entry.scheduleText);
    if (!schedule?.length) throw new Error('Each entry needs a weekly timetable');
    for (const s of schedule) {
      const key = `${s.day}:${s.minute}`;
      if (slots.has(key)) throw new Error('Two rules use the same weekday and time; give each occurrence one selection rule');
      slots.add(key);
    }
    if (slots.size > 50) throw new Error('The plan supports at most 50 weekly occurrences');
    if (!['fifo', 'lifo', 'random', 'custom', 'title_rule'].includes(entry.policy)) throw new Error('Invalid selection rule');
    if (!Array.isArray(entry.custom) || entry.custom.length > 500) throw new Error('Invalid Custom list');
    if (entry.policy === 'custom' && !entry.custom.length) throw new Error('A Custom list needs at least one filename');
    if (entry.policy !== 'custom' && entry.custom.length) throw new Error('Only a Custom entry can have a filename list');
    for (const v of entry.custom) {
      if (!v || !/^[A-Za-z0-9_-]{10,200}$/.test(v.fileId) || typeof v.fileName !== 'string' || !v.fileName.trim() || v.fileName.length > 300) throw new Error('Invalid Custom filename');
      if (customIds.has(v.fileId)) throw new Error('A video may appear in only one Custom list, once');
      customIds.add(v.fileId);
    }
    const rule = entry.titleRule;
    if (entry.policy === 'title_rule') {
      if (!rule || !['contains', 'starts_with', 'ends_with'].includes(rule.match) || typeof rule.text !== 'string' || !rule.text.trim() || rule.text.length > 200 || !['fifo', 'lifo', 'random'].includes(rule.order)) throw new Error('Invalid interpreted title rule');
    } else if (rule !== null) throw new Error('Unexpected title filter');
    if (entry.outros !== undefined) {
      if (!entry.outros || Array.isArray(entry.outros) || typeof entry.outros !== 'object') throw new Error('Invalid outro choices');
      for (const [platform, outro] of Object.entries(entry.outros)) {
        if (!['youtube','tiktok','instagram','facebook'].includes(platform) || (outro !== null && (!outro || !/^[A-Za-z0-9_-]{10,200}$/.test(outro.fileId) || typeof outro.fileName !== 'string' || !outro.fileName.trim() || outro.fileName.length > 300))) throw new Error('Invalid outro choice');
      }
    }
    return { ...entry, scheduleText: formatSchedule(schedule) };
  });
}
