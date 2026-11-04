import { describe,expect,it } from 'vitest';
import { parseTimetable,formatTimetable,anchorTimetable,dueTimetable,nextTimetable,timetablesOverlap, type Timetable } from '../src/shared/timetable';
import { localToUtc } from '../src/shared/schedule';
import { makeDb } from './d1-shim';
import { changePlan,planView } from '../worker/src/plan';
import { dispatchJobs,batchClaims } from '../worker/src/jobs';
import { beginRun,setPublishing,mayPublish,type Env } from '../worker/src/logic';
import { interpretPlan } from '../runner/src/publishing-plan';
const NOW=Date.parse('2026-11-04T10:00:00Z');
const model={model:'test',run:async()=>{throw new Error('Schedules must not require AI');}};
const entry=(scheduleText:string)=>({scheduleText,policy:'lifo' as const,titleRule:null,custom:[]});
const parsed=(s:string)=>parseTimetable(s)!;
const e=():Env=>({DB:makeDb(),STATE_API_TOKEN:'state',GH_DISPATCH_TOKEN:'dispatch',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',GITHUB_REF:'main',GITHUB_WORKFLOW:'scheduled-publish.yml'});
const send=async()=>new Response(null,{status:204});

describe('calendar-day recurrences',()=> {
 it('accepts numeric/written intervals, daily, every other day and strict clock formats',()=> {
  for(const [s,days,minute] of [['Every two days at 6pm',2,1080],['every 3 days at 07:30',3,450],['daily at noon',1,720],['every day at midnight',1,0],['every other day at 18:00',2,1080]] as const) expect(parsed(s)).toMatchObject({kind:'every_days',days,minute});
  const t=parsed('every two days at 18:00 starting 2026-11-06');expect(formatTimetable(t)).toBe('Every 2 days at 18:00 starting 2026-11-06');
  expect(parseTimetable(formatTimetable(t))).toEqual(t);
  expect(formatTimetable(parsed('Mon Wed 06:00'))).toBe('Mon 06:00; Wed 06:00');
 });
 it('rejects ambiguous hours, invalid dates/intervals and unsupported recurrence types',()=> {
  for(const s of ['every 0 days at 18:00','every 366 days at 18:00','every two days at 9','every two days at 24:00','every two days at 18:00 starting 2026-02-30','every two days at 18:00 starting 2026-2-1','every two days at Mon 18:00','every month at 18:00']) expect(()=>parsed(s)).toThrow();
 });
 it('anchors on the Sarajevo edit date and retains a matching interval phase',()=> {
  const t=parsed('every 2 days at 18:00');
  expect(anchorTimetable(t,Date.parse('2026-11-04T23:30Z'))).toMatchObject({startDate:'2026-11-05'});
  const old=parsed('every 2 days at 18:00 starting 2026-11-01');
  expect(anchorTimetable(t,NOW,[old])).toEqual(old);
  expect(()=>anchorTimetable(t,NOW,[old,parsed('every 2 days at 18:00 starting 2026-11-02')])).toThrow(/specify/);
 });
 it('runs once every two local dates across month/year boundaries, without a weekly reset',()=> {
  const t=parsed('every 2 days at 18:00 starting 2026-12-29');
  expect(nextTimetable(t,Date.parse('2026-12-28T00:00Z'),5).map(o=>o.key)).toEqual(['2026-12-29T17:00Z','2026-12-31T17:00Z','2027-01-02T17:00Z','2027-01-04T17:00Z','2027-01-06T17:00Z']);
  expect(dueTimetable(t,Date.parse('2026-12-31T17:00:40Z'))?.key).toBe('2026-12-31T17:00Z');
  expect(dueTimetable(t,Date.parse('2026-12-30T17:00Z'))).toBeNull();
  expect(dueTimetable(t,Date.parse('2026-12-27T17:00Z'))).toBeNull();
 });
 it('keeps local wall-clock time across both daylight-saving changes',()=> {
  const spring=parsed('every 2 days at 18:00 starting 2026-03-27');
  expect(nextTimetable(spring,Date.parse('2026-03-26T00:00Z'),3).map(o=>o.key)).toEqual(['2026-03-27T17:00Z','2026-03-29T16:00Z','2026-03-31T16:00Z']);
  const fall=parsed('every 2 days at 18:00 starting 2026-10-23');
  expect(nextTimetable(fall,Date.parse('2026-10-22T00:00Z'),3).map(o=>o.key)).toEqual(['2026-10-23T16:00Z','2026-10-25T17:00Z','2026-10-27T17:00Z']);
 });
 it('handles missing spring times and duplicated fall times exactly once',()=> {
  const spring=parsed('every day at 02:30 starting 2026-03-29');
  expect(dueTimetable(spring,Date.parse('2026-03-29T01:30Z'))?.key).toBe('2026-03-29T01:30Z');
  const fall=parsed('every day at 02:30 starting 2026-10-25');
  expect(dueTimetable(fall,Date.parse('2026-10-25T00:30Z'))?.key).toBe('2026-10-25T00:30Z');
  expect(dueTimetable(fall,Date.parse('2026-10-25T01:30Z'))).toBeNull();
 });
 it('detects eventual overlaps by calendar phase, including weekly vs interval',()=> {
  const a=parsed('every 2 days at 18:00 starting 2026-11-04');
  expect(timetablesOverlap(a,parsed('every 2 days at 18:00 starting 2026-11-05'))).toBe(false);
  expect(timetablesOverlap(a,parsed('every 3 days at 18:00 starting 2026-11-05'))).toBe(true);
  expect(timetablesOverlap(a,parsed('Fri 18:00'))).toBe(true);
  expect(timetablesOverlap(a,parsed('Fri 19:00'))).toBe(false);
  const weeklyInterval=parsed('every 7 days at 18:00 starting 2026-11-04');
  expect(timetablesOverlap(weeklyInterval,parsed('Wed 18:00'))).toBe(true);
  expect(timetablesOverlap(weeklyInterval,parsed('Fri 18:00'))).toBe(false);
 });
 it('agrees with actual due dates for many phases and cadences',()=> {
  const base=Date.parse('2026-11-01T00:00Z');
  for(let days=1;days<=12;days++) for(let shift=0;shift<4;shift++) {
   const t=parsed(`every ${days} days at 18:00 starting 2026-11-${String(1+shift).padStart(2,'0')}`);
   const future=nextTimetable(t,base,8);
   for(const o of future) expect(dueTimetable(t,o.utcMs)?.key).toBe(o.key);
   for(let date=1;date<=25;date++) expect(!!dueTimetable(t,localToUtc(2026,11,date,1080))).toBe(date>=1+shift && (date-1-shift)%days===0);
  }
 });
});

describe('interval plan and dispatch',()=> {
 it('parses a combined English recurrence, selection and outro without AI for the schedule',async()=> {
  const entries=await interpretPlan('every two days at 18:00 starting 2026-11-06: lifo; outro: none | Mon 06:00: random',model);
  expect(entries[0]).toMatchObject({scheduleText:'Every 2 days at 18:00 starting 2026-11-06',policy:'lifo',outroNames:{youtube:null}});
 });
 it('saves the anchor, preserves it on matching edits and preserves Custom progress/outros',async()=> {
  const db=makeDb(); const file={fileId:'custom_file_12345',fileName:'First.mp4'};
  let p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[{...entry('every 2 days at 18:00'),policy:'custom',custom:[file],outros:{youtube:null}}]},NOW);
  expect(p.entries[0].scheduleText).toContain('starting 2026-11-04');
  p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[{...entry('every two days at 18:00'),policy:'custom',custom:[file]}]},NOW+86400000);
  expect(p.entries[0]).toMatchObject({remaining:[file],outros:{youtube:null},scheduleText:'Every 2 days at 18:00 starting 2026-11-04'});
 });
 it('rejects overlapping replacements atomically and allows different times',async()=> {
  const db=makeDb();let p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[entry('every 2 days at 18:00')]},NOW);
  await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[entry('every 2 days at 18:00'),entry('Fri 18:00')]},NOW)).rejects.toThrow(/overlapping/);
  expect((await planView(db,NOW)).entries).toHaveLength(1);
  p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[entry('every 2 days at 18:00'),entry('Fri 19:00')]},NOW);
  expect(p.entries).toHaveLength(2);
 });
 it('checks overlaps against the retained phase when an interval is edited on another day',async()=> {
  const db=makeDb();
  let p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[entry('every 7 days at 18:00 starting 2026-11-04')]},NOW);
  const specs=await interpretPlan('every 7 days at 18:00: lifo | Thu 18:00: random',model);
  p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:specs.map(s=>entry(s.scheduleText))},NOW+86400000);
  expect(p.entries[0].scheduleText).toContain('starting 2026-11-04');
  expect(p.entries).toHaveLength(2);
 });
 it('claims an interval once, ignores off days, and resumes on its original future cycle',async()=> {
  const env=e();await changePlan(env.DB,{action:'edit',expectedRevision:0,entries:[entry('every 2 days at 18:00 starting 2026-11-04')]},NOW);
  await setPublishing(env.DB,true,'test',NOW);
  const due=Date.parse('2026-11-04T17:00Z');let dispatched:any;
  const capture=async(_u:string,init:RequestInit)=>{dispatched=JSON.parse(String(init.body)).inputs;return send();};
  expect((await dispatchJobs(env,due,capture))?.action).toBe('jobs_dispatched');
  expect((await dispatchJobs(env,due,capture))?.action).toBe('duplicate');
  const claims=await batchClaims(env.DB,dispatched.occurrence_key,dispatched.claim_token);expect(claims.claims).toHaveLength(1);
  const run=await beginRun(env.DB,{origin:'scheduled',occurrenceKey:claims.claims[0],claimToken:dispatched.claim_token,batchId:dispatched.occurrence_key},due+1);expect(run.allowed).toBe(true);
  expect((await dispatchJobs(env,due+86400000,capture))?.action).toBe('not_due');
  await changePlan(env.DB,{action:'pause'},due+1000);expect((await mayPublish(env.DB,run.runId!)).allowed).toBe(false);
  await changePlan(env.DB,{action:'resume'},Date.parse('2026-11-07T12:00Z'));
  const p=await planView(env.DB,Date.parse('2026-11-07T12:00Z'));
  expect(p.entries[0].nextOccurrences[0].key).toBe('2026-11-08T17:00Z');
  expect((await dispatchJobs(env,Date.parse('2026-11-08T17:00Z'),capture))?.action).toBe('jobs_dispatched');
 });
});
