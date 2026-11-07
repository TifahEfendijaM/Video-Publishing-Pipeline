import { parseSchedule, formatSchedule, nextOccurrences, dueOccurrence, wallClock, localToUtc, localLabel, occurrenceKey, type Slot, type Occurrence } from './schedule';

export interface DayInterval { kind: 'every_days'; days: number; minute: number; startDate?: string }
export interface OneTime { kind: 'once'; date: string; minute: number }
export type Timetable = Slot[] | DayInterval | OneTime;
const DAY_MS=86400000;
const WORDS: Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
function epochDay(date:string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use a start date in YYYY-MM-DD format');
  const ms=Date.parse(date+'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==date) throw new Error('Invalid start date');
  return ms/DAY_MS;
}
function dateAt(day:number) { return new Date(day*DAY_MS).toISOString().slice(0,10); }
function localDay(ms:number) { const w=wallClock(ms); return Date.UTC(w.year,w.month-1,w.day)/DAY_MS; }

/** Weekly syntax remains unchanged. Intervals use local calendar days, never elapsed 24-hour timers. */
export function parseTimetable(text:string): Timetable | null {
  if(text.length>1000) throw new Error('Timetable text is too long');
  const value=text.trim().toLowerCase().replace(/^daily\b/,'every day').replace(/^every other day\b/,'every 2 days');
  const once=/^once\s+on\s+(\d{4}-\d{2}-\d{2})\s+at\s+(.+)$/.exec(value);
  if(once) {
    epochDay(once[1]);
    const slots=parseSchedule('Mon '+once[2]);
    if(!slots || slots.length!==1) throw new Error('A one-time entry needs exactly one clock time');
    return {kind:'once',date:once[1],minute:slots[0].minute};
  }
  const match=/^every\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?days?\s+(?:at\s+)?(.+?)(?:\s+(?:starting|from)\s+(\d{4}-\d{2}-\d{2}))?$/.exec(value);
  if(!match) return parseSchedule(text);
  const days=match[1] ? WORDS[match[1]] ?? Number(match[1]) : 1;
  if(!Number.isInteger(days)||days<1||days>365) throw new Error('Choose every 1–365 days');
  if (/[^\d\s:.,apmh-]/i.test(match[2]) && !/^(noon|midnight)$/i.test(match[2])) throw new Error('Use one clock time after every N days');
  // Reuse the existing strict clock parser, including am/pm and DST policy.
  const slots=parseSchedule('Mon '+match[2]);
  if(!slots || slots.length!==1) throw new Error('Each every-N-days entry needs exactly one time');
  if(match[3]) epochDay(match[3]);
  return {kind:'every_days',days,minute:slots[0].minute,...(match[3]?{startDate:match[3]}:{})};
}
export function formatTimetable(t:Timetable):string {
  if(Array.isArray(t)) return formatSchedule(t);
  const clock=formatSchedule([{day:1,minute:t.minute}]).slice(4);
  if(t.kind==='once') return `Once on ${t.date} at ${clock}`;
  return `Every ${t.days} ${t.days===1?'day':'days'} at ${clock}${t.startDate?' starting '+t.startDate:''}`;
}

/** Keep the established phase across edits/resumes; a new interval starts on the local edit date. */
export function anchorTimetable(t:Timetable,nowMs:number,previous:Timetable[]=[]):Timetable {
  if(Array.isArray(t)||t.kind==='once'||t.startDate) return t;
  const candidates=previous.filter((p):p is DayInterval=>!Array.isArray(p)&&p.kind==='every_days'&&p.days===t.days&&p.minute===t.minute&&!!p.startDate);
  const anchors=[...new Set(candidates.map(p=>p.startDate!))];
  if(anchors.length>1) throw new Error('More than one matching interval exists; specify its starting YYYY-MM-DD date');
  return {...t,startDate:anchors[0] ?? dateAt(localDay(nowMs))};
}
function intervalStart(t:DayInterval) {
  if(!t.startDate) throw new Error('Interval start date must be saved before scheduling');
  return epochDay(t.startDate);
}
function atDay(t:{minute:number},day:number):Occurrence {
  const d=new Date(day*DAY_MS);
  const utcMs=localToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),t.minute);
  return {key:occurrenceKey(utcMs),utcMs,slot:{day:((day+3)%7+7)%7+1,minute:t.minute},localLabel:localLabel(utcMs)};
}
export function nextTimetable(t:Timetable,afterMs:number,count:number):Occurrence[] {
  if(Array.isArray(t)) return nextOccurrences(t,afterMs,count);
  if(count<=0) return [];
  if(t.kind==='once') { const o=atDay(t,epochDay(t.date)); return o.utcMs>afterMs ? [o] : []; }
  const start=intervalStart(t),today=localDay(afterMs),out:Occurrence[]=[];
  let index=Math.max(0,Math.floor((today-start)/t.days));
  while(out.length<count) {
    const occurrence=atDay(t,start+index*t.days);
    if(occurrence.utcMs>afterMs) out.push(occurrence);
    index++;
  }
  return out;
}
export function dueTimetable(t:Timetable,scheduledMs:number):Occurrence|null {
  if(Array.isArray(t)) return dueOccurrence(t,scheduledMs);
  if(t.kind==='once') {
    const o=atDay(t,epochDay(t.date));
    return Math.floor(o.utcMs/60000)===Math.floor(scheduledMs/60000) ? o : null;
  }
  const day=localDay(scheduledMs),delta=day-intervalStart(t);
  if(delta<0||delta%t.days!==0) return null;
  const occurrence=atDay(t,day);
  return Math.floor(occurrence.utcMs/60000)===Math.floor(scheduledMs/60000) ? occurrence : null;
}
function gcd(a:number,b:number):number {return b?gcd(b,a%b):a;}
function mod(n:number,m:number) {return ((n%m)+m)%m;}
/** Recurring dates eventually meet iff their calendar-day phases agree modulo the GCD. */
export function timetablesOverlap(a:Timetable,b:Timetable):boolean {
  if(!Array.isArray(a)&&a.kind==='once') return dueTimetable(b,atDay(a,epochDay(a.date)).utcMs)!==null;
  if(!Array.isArray(b)&&b.kind==='once') return timetablesOverlap(b,a);
  if(Array.isArray(a)&&Array.isArray(b)) return a.some(x=>b.some(y=>x.day===y.day&&x.minute===y.minute));
  if(Array.isArray(a)) return timetablesOverlap(b,a);
  if(Array.isArray(b)) return b.some(slot=>slot.minute===a.minute && mod(intervalStart(a)-(slot.day+3)%7,gcd(a.days,7))===0);
  return a.minute===b.minute && mod(intervalStart(a)-intervalStart(b),gcd(a.days,b.days))===0;
}
