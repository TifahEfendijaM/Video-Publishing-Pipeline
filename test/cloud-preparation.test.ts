import {describe,it,expect,vi} from 'vitest';
import {flexibleInterpretation,matchingResponse,parsePreparation,preparedCaptionModel,requestPayload,validateNormalized,type Preparation} from '../runner/src/cloud-preparation';
import {makeCaptions} from '../runner/src/captioner';
import {parseTimetable,nextTimetable,dueTimetable,timetablesOverlap} from '../src/shared/timetable';
import {changePlan,planView} from '../worker/src/plan';
import {makeDb} from './d1-shim';
const NOW=Date.parse('2026-11-07T15:00:00Z');
const empty=():Preparation=>({schemaVersion:1,updatedAt:null,captions:[],responses:[]});
const output={topic_caption:'You can bring a little Bosnian into your next coffee break.',website_invitation:'Learn Bosnian with EasyBosnian and make your next conversation feel more familiar.',youtube_title:'Ordering coffee in Bosnian',youtube_description:'Explore the topic of ordering coffee in Bosnian. You can learn useful Bosnian with EasyBosnian and enjoy the language one conversation at a time.'};

describe('subscription-based cloud preparation',()=>{
 it('accepts a Google export BOM and rejects duplicate records and malformed transport',()=>{
   expect(parsePreparation('\uFEFF'+JSON.stringify(empty()))).toEqual(empty());
   const caption={fileId:'video_source_12345',fileName:'Coffee.mp4',output};
   expect(()=>parsePreparation(JSON.stringify({...empty(),captions:[caption,caption]}))).toThrow(/Duplicate/);
   expect(()=>parsePreparation('```json\n{}\n```')).toThrow();
 });
 it('ties prepared text to both the Drive ID and current filename and retains caption validation',async()=>{
   const p={...empty(),captions:[{fileId:'video_source_12345',fileName:'Coffee.mp4',output}]};
   expect((await makeCaptions('Coffee.mp4',preparedCaptionModel(p,'video_source_12345','Coffee.mp4'))).source).toBe('generated');
   for(const [id,name] of [['other_source_12345','Coffee.mp4'],['video_source_12345','Renamed.mp4']]) expect((await makeCaptions(name,preparedCaptionModel(p,id,name))).source).toBe('generic');
   p.captions[0].output={...output,topic_caption:'You can learn at CEFR A2 with this video.'};
   expect((await makeCaptions('Coffee.mp4',preparedCaptionModel(p,'video_source_12345','Coffee.mp4'))).source).toBe('generic');
 });
 it('requires the exact request digest, fails clarification/expiration and validates normalized output',async()=>{
   const request=requestPayload('plan','tomorrow at 6pm newest first',NOW);
   expect(request.referenceTime).toBe('2026-11-07T15:00:00.000Z');
   const response={requestId:request.id,digest:request.digest,status:'ready' as const,normalized:'Once on 2026-11-08 at 18:00: lifo',explanation:'One upload tomorrow.'};
   const p={...empty(),responses:[{...response,digest:'a'.repeat(64)}]};
   expect(matchingResponse(p,request,NOW)).toBeNull();
   p.responses=[response];expect(matchingResponse(p,request,NOW)).toBe(response.normalized);
   expect(()=>matchingResponse(p,request,NOW+70*60000)).toThrow(/timed out/);
   expect(()=>matchingResponse({...p,responses:[{...response,status:'needs_clarification',normalized:null}]},request,NOW)).toThrow(/Clarification/);
   await expect(validateNormalized('plan','Do something unrelated')).rejects.toThrow();
 });
 it('keeps formatted entries instant without touching a connector or AI',async()=>{
   const d={preparationText:vi.fn(),createPreparationRequest:vi.fn(),trashPreparationRequest:vi.fn()};
   const text='Once on 2026-11-07 at 21:00: custom: "Coffee.mp4"; outro: none | every 3 days at 18:00 starting 2026-11-08: lifo; outro: "Ending.mp4"';
   expect(await flexibleInterpretation('plan',text,d,'doc')).toBe(text);
   expect(d.preparationText).not.toHaveBeenCalled();
 });
 it('waits for a matching private result, validates it, then cleans up only its request',async()=>{
   let payload:ReturnType<typeof requestPayload>|undefined,reads=0;
   const normalized='Every 3 days at 18:00 starting 2026-11-08: lifo; outro: none';
   const d={preparationText:vi.fn(async()=>JSON.stringify(reads++<2?empty():{...empty(),responses:[{requestId:payload!.id,digest:payload!.digest,status:'ready',normalized,explanation:'Every third day from tomorrow.'}]})),createPreparationRequest:vi.fn(async(_id:string,p:unknown)=>{payload=p as typeof payload;return 'private_request_file';}),trashPreparationRequest:vi.fn(async()=>{})};
   const sleep=vi.fn(async()=>{});
   expect(await flexibleInterpretation('plan','Every third day from tomorrow at six pm, newest first without an outro',d,'doc',{now:()=>NOW,sleep})).toBe(normalized);
   expect(sleep).toHaveBeenCalledTimes(1);
   expect(d.trashPreparationRequest).toHaveBeenCalledWith('private_request_file',payload!.id);
 });
 it('does not accept invalid AI interpretations and cleans up on rejection',async()=>{
   let payload:ReturnType<typeof requestPayload>|undefined;
   const d={preparationText:vi.fn(async()=>JSON.stringify(payload?{...empty(),responses:[{requestId:payload.id,digest:payload.digest,status:'ready',normalized:'Tomorrow at 9: choose something',explanation:'Invalid example.'}]}:empty())),createPreparationRequest:vi.fn(async(_id:string,p:unknown)=>{payload=p as typeof payload;return 'request';}),trashPreparationRequest:vi.fn(async()=>{})};
   await expect(flexibleInterpretation('plan','Tomorrow at nine upload the newest video',d,'doc',{now:()=>NOW})).rejects.toThrow();
   expect(d.trashPreparationRequest).toHaveBeenCalledOnce();
 });
});

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
