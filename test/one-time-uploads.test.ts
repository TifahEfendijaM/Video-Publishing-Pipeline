import {describe,it,expect} from 'vitest';
import {parseTimetable,nextTimetable,dueTimetable,timetablesOverlap} from '../src/shared/timetable';
import {changePlan,planView} from '../worker/src/plan';
import {makeDb} from './d1-shim';
const NOW=Date.parse('2026-11-07T15:00:00Z');

describe('dated one-time uploads',()=>{
 it('has exactly one occurrence and never repeats a week later',()=>{
   const t=parseTimetable('Once on 2026-11-07 at 21:00')!;
   const due=Date.parse('2026-11-07T20:00:00Z');
   expect(nextTimetable(t,NOW,10).map(o=>o.key)).toEqual(['2026-11-07T20:00Z']);
   expect(dueTimetable(t,due)?.key).toBe('2026-11-07T20:00Z');
   expect(dueTimetable(t,due+7*86400000)).toBeNull();
   expect(nextTimetable(t,due,1)).toEqual([]);
   expect(()=>parseTimetable('Once on 2026-02-30 at 21:00')).toThrow();
 });
 it('detects collisions on an actual date without rejecting off-cycle dates',()=>{
   const t=parseTimetable('Once on 2026-11-08 at 18:00')!;
   expect(timetablesOverlap(t,parseTimetable('Sun 18:00')!)).toBe(true);
   expect(timetablesOverlap(t,parseTimetable('every 3 days at 18:00 starting 2026-11-08')!)).toBe(true);
   expect(timetablesOverlap(t,parseTimetable('every 3 days at 18:00 starting 2026-11-09')!)).toBe(false);
 });
 it('rejects a new past occurrence atomically and retains a past unchanged entry when editing another entry',async()=>{
   const db=makeDb();
   const once={scheduleText:'Once on 2026-11-07 at 21:00',policy:'lifo' as const,titleRule:null,custom:[]};
   let p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[once]},NOW);
   p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[once,{...once,scheduleText:'Mon 06:00'}]},NOW+86400000);
   expect(p.entries).toHaveLength(2);
   await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[{...once,policy:'fifo'}]},NOW+86400000)).rejects.toThrow(/past/);
   expect((await planView(db,NOW+86400000)).entries).toHaveLength(2);
 });
});
