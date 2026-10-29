import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDb } from './d1-shim';
import { changePlan, planView } from '../worker/src/plan';
import { planState } from '../worker/src/plan-state';
import { advanceCustomJobs, dispatchJobs } from '../worker/src/jobs';
import { beginRun, configureManual, mayPublish, setPublishing, type Env } from '../worker/src/logic';
import { route } from '../worker/src/index';
import { interpretPlan, interpretSelection, resolvePlan } from '../runner/src/publishing-plan';
import type { PlanEntryInput } from '../src/shared/publishing-plan';
import type { FolderVideo } from '../src/shared/selection';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const DUE = Date.parse('2026-10-30T04:00:00Z'); // Fri 05:00 Sarajevo
const a = {fileId:'video_first_12345',fileName:'First.mp4'}, b = {fileId:'video_second_12345',fileName:'Second.mp4'};
const automatic = (scheduleText='Fri 05:00'): PlanEntryInput => ({scheduleText,policy:'lifo',titleRule:null,custom:[]});
const custom = (scheduleText='Sun 18:00'): PlanEntryInput => ({scheduleText,policy:'custom',titleRule:null,custom:[a,b]});
const model = {model:'test',run:async()=>({understood:true,match:'ends_with',text:'[available]',order:'random'})};
const video = (v:typeof a): FolderVideo => ({id:v.fileId,name:v.fileName,mimeType:'video/mp4',createdTime:'2026-10-01T00:00:00Z',modifiedTime:'2026-10-01T00:00:00Z',sizeBytes:10,md5:'x'});
const env = (): Env => ({DB:makeDb(),STATE_API_TOKEN:'state',GH_DISPATCH_TOKEN:'dispatch',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',GITHUB_WORKFLOW:'scheduled-publish.yml',GITHUB_REF:'main'});
async function edit(db:ReturnType<typeof makeDb>, entries?:PlanEntryInput[], at=NOW) {
  return changePlan(db,{action:'edit',expectedRevision:(await planState(db)).revision,entries},at);
}

describe('one publishing plan',()=> {
  it('atomically replaces timetable/rule pairs, preserves their displayed order and removes omitted pairs',async()=> {
    const db=makeDb();
    let p=await edit(db,[custom(),automatic()]);
    expect(p.entries.map(e=>e.scheduleText)).toEqual(['Sun 18:00','Fri 05:00']);
    const id=p.entries[0].id;
    p=await edit(db,[automatic('Mon 06:00'),custom('Tue 08:00')]);
    expect(p.entries.map(e=>e.scheduleText)).toEqual(['Mon 06:00','Tue 08:00']);
    expect(p.entries[1].id).toBe(id);
    p=await edit(db,[automatic()]);
    expect(p.entries).toHaveLength(1);
    expect(db.raw.prepare('SELECT * FROM job_reservations').all()).toHaveLength(0);
  });
  it('retains Custom progress across reordered/rescheduled unchanged lists, including completed lists',async()=> {
    const db=makeDb(); await edit(db,[custom(),automatic()]);
    await advanceCustomJobs(db,a.fileId);
    let p=await edit(db,[automatic(),custom('Mon 07:00')]);
    expect(p.entries[1].remaining).toEqual([b]);
    expect(p.entries[1].originalCustom).toEqual([a,b]);
    await advanceCustomJobs(db,b.fileId);
    p=await edit(db,[custom('Wed 19:00'),automatic()]);
    expect(p.entries[0]).toMatchObject({status:'completed',remaining:[],originalCustom:[a,b]});
    expect(p.entries[0].nextOccurrences).toEqual([]);
    const snapshot=await planView(db,NOW);
    expect(await edit(db)).toEqual(snapshot); // blank edit is read-only
  });
  it('rejects an invalid replacement, overlaps, duplicate list ownership and stale progress without losing the saved plan',async()=> {
    const db=makeDb(); const p=await edit(db,[custom(),automatic()]);
    await expect(edit(db,[custom('Fri 05:00'),automatic()])).rejects.toThrow(/same weekday/);
    await expect(edit(db,[custom(),custom('Mon 06:00')])).rejects.toThrow(/only one/);
    await expect(edit(db,[])).rejects.toThrow(/1–20/);
    expect(await planView(db,NOW)).toEqual(p);
    await advanceCustomJobs(db,a.fileId);
    await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[custom()]},NOW)).rejects.toThrow(/changed/);
    expect((await planView(db,NOW)).entries[0].remaining).toEqual([b]);
  });
  it('rolls back the whole replacement if a reservation write fails',async()=> {
    const db=makeDb();const p=await edit(db,[automatic()]);
    db.raw.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON job_reservations BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    await expect(edit(db,[custom()])).rejects.toThrow(/injected failure/);
    expect(await planView(db,NOW)).toEqual(p);
  });
  it('rejects a revision race at commit time and preserves the newer queue',async()=> {
    const db=makeDb();const p=await edit(db,[custom()]);
    const originalBatch=db.batch.bind(db);
    db.batch=async statements=> {
      db.raw.prepare('UPDATE publishing_plan SET revision=revision+1 WHERE id=1').run();
      return originalBatch(statements);
    };
    await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[automatic()]},NOW)).rejects.toThrow(/no edits saved/);
    expect((await planView(db,NOW)).entries[0].remaining).toEqual([a,b]);
  });
  it('saves separate outros and preserves them when omitted or when selection changes',async()=> {
    const db=makeDb(); const outro={fileId:'outro_asset_12345',fileName:'end.mp4'};
    let p=await edit(db,[{...automatic(),outros:{youtube:outro,tiktok:null}}, {...custom(),outros:{youtube:null}}]);
    expect(p.entries[0].outros.youtube).toEqual(outro);
    expect(p.entries[1].outros.youtube).toBeNull();
    await advanceCustomJobs(db,a.fileId);
    p=await edit(db,[{...automatic(),policy:'random'},custom()]);
    expect(p.entries[0].outros).toEqual({youtube:outro,tiktok:null});
    expect(p.entries[1].outros.youtube).toBeNull();
    expect(p.entries[1].remaining).toEqual([b]);
    p=await edit(db,[{...automatic(),policy:'random'},custom(),automatic('Mon 07:00')]);
    expect(p.entries[2].outros).toEqual({}); // new timetable does not inherit another entry's choices
    await expect(edit(db,[{...custom(),custom:[outro],outros:{youtube:outro}}])).rejects.toThrow(/Outros/);
    await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,outros:{youtube:outro}},NOW)).rejects.toThrow(/universal/);
  });
  it('pauses queued and in-flight work, retains Custom lists, and resumes only future slots',async()=> {
    const e=env();const db=e.DB as ReturnType<typeof makeDb>;
    await edit(db,[automatic(),custom()]);await setPublishing(db,true,'test',NOW);
    let dispatch:any;
    const send=async(_u:string,init:RequestInit)=>{dispatch=JSON.parse(String(init.body)).inputs;return new Response(null,{status:204});};
    await dispatchJobs(e,DUE,send);
    const key=db.raw.prepare('SELECT occurrence_key FROM occurrence_claims').get()!.occurrence_key as string;
    const run=await beginRun(db,{origin:'scheduled',occurrenceKey:key,claimToken:dispatch.claim_token,batchId:dispatch.occurrence_key},DUE+1);
    expect((await mayPublish(db,run.runId!)).allowed).toBe(true);
    await changePlan(db,{action:'pause'},DUE+2);
    expect((await mayPublish(db,run.runId!)).allowed).toBe(false);
    expect((await dispatchJobs(e,DUE+60000,send))?.action).toBe('plan_paused');
    let p=await planView(db,DUE+3);expect(p.paused).toBe(true);
    expect(p.entries.every(j=>!j.nextOccurrences.length)).toBe(true);
    expect(p.entries[1].remaining).toEqual([a,b]);
    await changePlan(db,{action:'resume'},DUE+60000);
    expect((await dispatchJobs(e,DUE+60000,send))?.action).toBe('not_due');
    p=await planView(db,DUE+60000);expect(p.paused).toBe(false);
    expect(p.entries[0].nextOccurrences[0].key).toBe('2026-11-06T04:00Z');
    const revision=p.revision;
    await changePlan(db,{action:'resume'},DUE+120000);
    expect((await planState(db)).revision).toBe(revision); // idempotent, no future slot reset
  });
  it('cancels unstarted claims on Pause and does not revive them on Resume',async()=> {
    const e=env();await edit(e.DB as any,[automatic()]);
    await dispatchJobs(e,DUE,async()=>new Response(null,{status:204}));
    await changePlan(e.DB,{action:'pause'},DUE+1);
    await changePlan(e.DB,{action:'resume'},DUE+2);
    expect((e.DB as any).raw.prepare('SELECT state FROM occurrence_claims').get().state).toBe('cancelled');
  });
  it('keeps a paused plan paused on Edit; one-off Keep leaves it untouched and explicit Pause is resumable',async()=> {
    const db=makeDb();await edit(db,[custom()]);
    await configureManual(db,{scheduleBehavior:'stop'},NOW+1);
    let p=await planView(db,NOW);expect(p.paused).toBe(true);
    await configureManual(db,{scheduleBehavior:'keep',selectionPolicy:'random'},NOW+2);
    expect(await planView(db,NOW)).toEqual(p);
    p=await edit(db,[custom('Mon 08:00')]);expect(p.paused).toBe(true);
    await changePlan(db,{action:'resume'},NOW+3);
    expect((await planView(db,NOW)).entries[0].remaining).toEqual([a,b]);
    expect((await planView(db,NOW)).entries[0].nextOccurrences.length).toBeGreaterThan(0);
  });
  it('authenticates plan controls and retires named-job writes',async()=> {
    const e=env();expect((await route(new Request('https://w/api/plan'),e)).status).toBe(401);
    const headers={authorization:'Bearer state'};
    let p=await (await route(new Request('https://w/api/plan',{headers}),e)).json();
    expect(p.entries).toEqual([]);
    const response=await route(new Request('https://w/api/plan/change-with-outros',{method:'POST',headers,body:JSON.stringify({action:'edit',expectedRevision:p.revision,entries:[custom()]})}),e);
    p=await response.json();expect(p.entries[0].remaining).toEqual([a,b]);
    await expect(route(new Request('https://w/api/jobs/change',{method:'POST',headers,body:'{}'}),e)).rejects.toThrow(/retired/);
  });
  it('migrates existing stopped lists to one paused plan without losing reservations',async()=> {
    const db=makeDb(['0001_init.sql','0002_outros.sql','0003_folder_queue.sql','0004_scheduled_jobs.sql']);
    db.raw.prepare("INSERT INTO scheduled_jobs(id,name,name_key,schedule_json,policy,remaining_json,status,enabled_at,created_at,updated_at) VALUES('a','Old','old',?,'custom',?,'stopped',?,?,?)").run('[{"day":5,"minute":300}]',JSON.stringify([a,b]),new Date(NOW).toISOString(),new Date(NOW).toISOString(),new Date(NOW).toISOString());
    db.raw.prepare("INSERT INTO job_reservations(file_id,job_id) VALUES(?,'a')").run(a.fileId);
    db.raw.exec(readFileSync(new URL('../worker/migrations/0005_publishing_plan.sql',import.meta.url),'utf8'));
    const p=await planView(db,NOW);expect(p.paused).toBe(true);
    expect(p.entries[0]).toMatchObject({remaining:[a,b],originalCustom:[a,b]});
    expect(db.raw.prepare('SELECT * FROM job_reservations').all()).toHaveLength(1);
  });
});

describe('paired timetable and selection entry',()=> {
  it('accepts the agreed natural weekday example, uses AI for title instructions and keeps filenames with commas or pipes intact',async()=> {
    const plan=await interpretPlan('Monday and Wednesday at 06:00: newest video first | Friday at 21:00: Pick a random video whose title ends with [available].\nSunday at 18:00: publish this list in order: "Yes, please.mp4", "A | B.mp4"',model);
    expect(plan.map(e=>e.scheduleText)).toEqual(['Mon 06:00; Wed 06:00','Fri 21:00','Sun 18:00']);
    expect(plan[0].policy).toBe('lifo');expect(plan[1].titleRule).toMatchObject({match:'ends_with',text:'[available]',order:'random'});
    expect(plan[2].filenames).toEqual(['Yes, please.mp4','A | B.mp4']);
    expect(await interpretSelection('custom: "One.mp4"',model)).toMatchObject({policy:'custom',filenames:['One.mp4']});
  });
  it('rejects unsupported schedules, missing rules, overlapping slots, malformed quotes and ambiguous AI interpretations',async()=> {
    for(const value of ['Tomorrow: lifo','2026-11-01 08:00: lifo','Monday 08:00','Monday: lifo','Mon 08:00: lifo | Mon 08:00: random','Sun 18:00: custom: "unclosed']) await expect(interpretPlan(value,model)).rejects.toThrow();
    await expect(interpretPlan('Friday 21:00: videos about travel',{...model,run:async()=>({understood:false,match:null,text:null,order:'fifo'})})).rejects.toThrow(/unsupported/);
  });
  it('resolves new Custom lists against Drive but recognizes an unchanged original list after its first file is archived',async()=> {
    const spec=await interpretPlan('Sun 18:00: custom: "First.mp4", "Second.mp4"',model);
    expect(resolvePlan(spec,[video(b)],[{originalCustom:[a,b]}])[0].custom).toEqual([a,b]);
    expect(()=>resolvePlan(spec,[video(b)],[])).toThrow(/not in the source/);
    expect(resolvePlan(spec,[video(a),video(b)],[])[0].custom).toEqual([a,b]);
    const duplicate=await interpretPlan('Sun 18:00: custom: "First.mp4" | Mon 18:00: custom: "First.mp4"',model);
    expect(()=>resolvePlan(duplicate,[video(a)],[])).toThrow(/only one/);
  });
  it('parses the displayed literal title rule without asking AI to reinterpret it',async()=> {
    const noAI={model:'test',run:async()=>{throw new Error('AI must not run');}};
    expect(await interpretSelection('random video whose title ends with "[available]"',noAI)).toMatchObject({policy:'title_rule',titleRule:{match:'ends_with',text:'[available]',order:'random'}});
  });
});

describe('per-timetable outro text',()=> {
  it('resolves different clips, platform overrides and explicit none without altering Custom identity',async()=> {
    const outro={fileId:'outro_asset_12345',fileName:'End; yes, please.mp4'};
    const parsed=await interpretPlan('Fri 05:00: lifo; outro: "End; yes, please.mp4" | Sun 18:00: custom: "First.mp4", "Second.mp4"; youtube outro: none; facebook outro: "End; yes, please.mp4"',model);
    const entries=resolvePlan(parsed,[video(a),video(b),video(outro)],[]);
    expect(entries[0].outros).toEqual({youtube:outro,tiktok:outro,instagram:outro,facebook:outro});
    expect(entries[1].outros).toEqual({youtube:null,facebook:outro});
    expect(entries[1].custom).toEqual([a,b]);
  });
  it('rejects missing, ambiguous, duplicate and malformed outro choices before saving',async()=> {
    const parsed=await interpretPlan('Mon 06:00: random; outro: "Missing.mp4"',model);
    expect(()=>resolvePlan(parsed,[],[])).toThrow(/missing or ambiguous/);
    for(const text of ['Mon 06:00: lifo; outro: "A.mp4", "B.mp4"','Mon 06:00: lifo; youtube outro: none; youtube outro: off','Mon 06:00: random; something: none']) await expect(interpretPlan(text,model)).rejects.toThrow();
  });
});
