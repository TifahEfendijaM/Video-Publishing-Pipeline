import { describe, expect, it, vi } from 'vitest';
import { DESTINATIONS, destinationClause, parseDestinations, taskDestination, validateDestinations, type Destination } from '../src/shared/destinations';
import { flexibleInterpretation, noModel, validateNormalized } from '../runner/src/interpretation';
import { interpretManualEntry, interpretPlan, resolveManualEntry, resolvePlan } from '../runner/src/publishing-plan';
import { buildTasks, executeTasks, type Identities, type Providers } from '../runner/src/publish';
import { loadConfig } from '../runner/src/config';
import { planFeed, planStory, planYouTubeVersions } from '../src/shared/media';
import { confirmedForCleanup } from '../runner/src/queue';
import { changePlan, planView } from '../worker/src/plan';
import { advanceCustomJobs, dispatchJobs } from '../worker/src/jobs';
import { beginRun, setPublishing } from '../worker/src/logic';
import { makeDb } from './d1-shim';
import { readFileSync } from 'node:fs';

const info = { durationSec: 100, width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: 48000, fps: 30, sizeBytes: 1024, container: 'mp4', pixFmt: 'yuv420p' };
const cfg = loadConfig();
const identities: Identities = Object.fromEntries(['instagram','facebook','tiktok','youtube','youtubeBuffer','youtubeUploadPost'].map(k=>[k,{ok:true,detail:'verified'}])) as unknown as Identities;
const video = { id:'video_first_12345', name:'First.mp4', mimeType:'video/mp4', createdTime:'2026-10-01T00:00:00Z', modifiedTime:'2026-10-01T00:00:00Z', sizeBytes:1024, md5:'x' };
const custom = { fileId:video.id, fileName:video.name };
const context = async()=>({savedPlan:'Mon 06:00: lifo; destinations: youtube/video',filenames:['First.mp4'],referenceTime:'2026-11-08T15:00:00Z'});
const examples = [
  ['First.mp4 publish only on youtube as a regular video','youtube/video',['youtube/video']],
  ['First.mp4 publish only as a short on youtube','youtube/short',['youtube/short']],
  ['First.mp4 publish on all platforms except on youtube as a regular video (but still as a short)','all except youtube/video',DESTINATIONS.filter(d=>d!=='youtube/video')],
  ['First.mp4 publish on all except on tiktok','all except tiktok',DESTINATIONS.filter(d=>d!=='tiktok/feed')],
] as const;

function tasks(destinations?: Destination[], media=info, providers: Providers={} as Providers) {
  return buildTasks({cfg,info:media,feed:planFeed(media),stories:{plan:planStory(media,'segment'),files:[{path:'/story1.mp4',surface:'story_part_1',label:'1/2'},{path:'/story2.mp4',surface:'story_part_2',label:'2/2'}]},
    originalPath:'/original.mp4',captions:{caption:'caption',youtubeTitle:'title',youtubeDescription:'description'},providers,identities,destinations,
    youtube:{plan:planYouTubeVersions(media),shortPath:'/short.mp4',regularPath:'/regular.mp4'}});
}

describe('destination interpretation and defaults',()=>{
  it('defaults to every destination, expands platforms, and rejects empty/unknown choices',()=>{
    expect(validateDestinations()).toEqual(DESTINATIONS);
    expect(parseDestinations('youtube')).toEqual(['youtube/short','youtube/video']);
    expect(parseDestinations('Instagram, Facebook')).toEqual(['instagram/reel','instagram/story','facebook/feed','facebook/story']);
    for(const value of ['', 'none', 'youtube/regular', 'all except instagram,facebook,tiktok,youtube', 'youtube/video,']) expect(()=>parseDestinations(value)).toThrow();
    for(const value of [[],null,'youtube/video',['unknown'],['youtube/video','youtube/video']]) expect(()=>validateDestinations(value)).toThrow();
  });
  it.each(examples)('uses Codex for natural manual wording and validates its destination allowlist: %s',async(text,clause,expected)=>{
    const normalized=`custom: "First.mp4"; destinations: ${clause}`;
    const run=vi.fn(async(_system:string,_user:string)=>({status:'ready',normalized,explanation:'Selected the requested destinations.'}));
    const formatted=await flexibleInterpretation('manual',text,{model:'Codex test',run},context);
    const resolved=resolveManualEntry(await interpretManualEntry(formatted,noModel),[video]);
    expect(resolved.pendingCustom).toEqual(custom);
    expect(resolved.destinations).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('never ignore an explicit platform or format restriction');
  });
  it('validates the same restrictions for scheduled rules and copy/paste round trips',async()=>{
    const text='Mon 18:00: lifo; destinations: youtube/video | Tue 19:00: custom: "First.mp4"; destinations: all except tiktok';
    const run=vi.fn(async()=>({status:'ready',normalized:text,explanation:'Two different destination rules.'}));
    const normalized=await flexibleInterpretation('plan','Newest each Monday only as a regular YouTube video, First on Tuesday everywhere except TikTok',{model:'Codex test',run},context);
    const interpreted=await interpretPlan(normalized,noModel);
    expect(resolvePlan(interpreted,[video],[]).map(e=>e.destinations)).toEqual([['youtube/video'],DESTINATIONS.filter(d=>d!=='tiktok/feed')]);
    const clause=destinationClause(interpreted[1].destinations);
    expect((await interpretPlan(`Tue 19:00: lifo${clause}`,noModel))[0].destinations).toEqual(interpreted[1].destinations);
    await expect(validateNormalized('rule','random video whose title ends with "[available]"; destinations: youtube/short')).resolves.toBeUndefined();
  });
  it('omitted manual/plan choices always mean all rather than retaining a previous restriction',async()=>{
    expect(resolveManualEntry(await interpretManualEntry('',noModel),[]).destinations).toEqual(DESTINATIONS);
    expect((await interpretManualEntry('custom: "First.mp4"',noModel)).destinations).toEqual(DESTINATIONS);
    expect((await interpretPlan('Mon 18:00: lifo',noModel))[0].destinations).toEqual(DESTINATIONS);
  });
  it('refuses unsupported, duplicate or empty interpreted destinations without broadening to all',async()=>{
    for(const suffix of ['destinations: spotify','destinations: none','destinations: youtube/short; destinations: all','destinations:']){
      const output=`custom: "First.mp4"; ${suffix}`;
      await expect(flexibleInterpretation('manual','First only somewhere',{model:'test',run:async()=>({status:'ready',normalized:output,explanation:'invalid'})},context)).rejects.toThrow();
    }
  });
  it('keeps destination-looking text inside a quoted filename as filename data',async()=>{
    const parsed=await interpretManualEntry('custom: "youtube; destinations: tiktok.mp4"; destinations: youtube/video',noModel);
    expect(parsed.selection?.filenames).toEqual(['youtube; destinations: tiktok.mp4']);
    expect(parsed.destinations).toEqual(['youtube/video']);
  });
});

describe('publishing only the selected surfaces',()=>{
  it.each(examples)('sends and records only the interpreted destinations: %s',async(_text,clause,expected)=>{
    const sent: string[]=[];
    const confirmed=async (name:string)=>{sent.push(name);return {status:'confirmed' as const};};
    const providers = {
      meta:{instagram:async(_id:string,kind:string)=>confirmed(kind==='REELS'?'instagram/reel':'instagram/story'),facebookReel:async()=>confirmed('facebook/feed'),facebookPageVideo:async()=>confirmed('facebook/feed'),facebookStory:async()=>confirmed('facebook/story')},
      buffer:{publish:async(o:{channelId:string})=>confirmed(o.channelId===cfg.destinations.youtube.short.bufferChannelId?'youtube/short':'tiktok/feed')},
      uploadPost:{upload:async()=>confirmed('youtube/video')},
    } as unknown as Providers;
    const planned=tasks(parseDestinations(clause),info,providers);
    const recorded: any[]=[];
    const {results}=await executeTasks('run',video.id,planned,{mayPublish:async()=>({allowed:true,reason:null}),record:async r=>{recorded.push(r);},host:async()=>({key:'k',url:'https://temporary/media'})});
    expect([...new Set(sent)].sort()).toEqual([...expected].sort());
    expect(recorded.every(r=>expected.includes(taskDestination(r.platform,r.surface) as never))).toBe(true);
    expect(confirmedForCleanup(results.map((r,i)=>({...r,id:i,file_id:video.id})))).toBe(true);
    if(clause==='youtube/video') expect(results.map(r=>[r.platform,r.surface])).toEqual([['youtube','video']]);
    if(clause==='youtube/short') expect(results.map(r=>[r.platform,r.surface])).toEqual([['youtube','short']]);
  });
  it('default routing retains both YouTube versions and excludes both TikTok rows when TikTok is excluded',()=>{
    const full=tasks();
    expect(full.filter(t=>t.platform==='youtube').map(t=>t.surface)).toEqual(['short','video']);
    expect(full.some(t=>t.platform==='tiktok'&&t.surface==='story')).toBe(true);
    expect(tasks(parseDestinations('all except tiktok')).some(t=>t.platform==='tiktok')).toBe(false);
    expect(tasks(parseDestinations('instagram/story')).map(t=>t.surface)).toEqual(['story_part_1','story_part_2']);
  });
  it('does not substitute a regular video or other platforms when a requested Short is impossible',()=>{
    const selected=tasks(['youtube/short'],{...info,durationSec:181});
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({platform:'youtube',surface:'short',blocked:{status:'unsupported'}});
  });
});

describe('saved scheduled destination rules',()=>{
  const NOW=Date.parse('2026-11-08T15:00:00Z');
  it('persists independent choices, returns them in scheduled claims, and retains them across pause/resume',async()=>{
    const db=makeDb();
    const p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[
      {scheduleText:'Mon 18:00',policy:'lifo',custom:[],titleRule:null,destinations:['youtube/video']},
      {scheduleText:'Tue 19:00',policy:'custom',custom:[custom],titleRule:null,destinations:['youtube/short']},
    ]},NOW);
    expect(p.features.destinationSelection).toBe(true);
    expect(p.entries.map(e=>e.destinations)).toEqual([['youtube/video'],['youtube/short']]);
    await changePlan(db,{action:'pause'},NOW+1);await changePlan(db,{action:'resume'},NOW+2);
    expect((await planView(db,NOW)).entries.map(e=>e.destinations)).toEqual([['youtube/video'],['youtube/short']]);
    await setPublishing(db,true,'test',NOW);
    let dispatch:any;
    await dispatchJobs({DB:db,STATE_API_TOKEN:'state',GH_DISPATCH_TOKEN:'dispatch',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',GITHUB_WORKFLOW:'scheduled.yml',GITHUB_REF:'main'},Date.parse('2026-11-09T17:00:00Z'),async(_url,init)=>{dispatch=JSON.parse(String(init.body)).inputs;return new Response(null,{status:204});});
    const key=db.raw.prepare('SELECT occurrence_key FROM occurrence_claims').get()!.occurrence_key as string;
    const begin=await beginRun(db,{origin:'scheduled',occurrenceKey:key,claimToken:dispatch.claim_token,batchId:dispatch.occurrence_key},Date.parse('2026-11-09T17:00:01Z'));
    expect(begin.allowed).toBe(true);
    expect(begin.job?.destinations).toEqual(['youtube/video']);
  });
  it('changing destinations retains Custom progress; omitting the restriction resets that entry to all',async()=>{
    const db=makeDb();const second={fileId:'video_second_12345',fileName:'Second.mp4'};
    const entry={scheduleText:'Mon 18:00',policy:'custom' as const,custom:[custom,second],titleRule:null};
    let p=await changePlan(db,{action:'edit',expectedRevision:0,entries:[{...entry,destinations:['youtube/video']}]},NOW);
    const id=p.entries[0].id;
    await advanceCustomJobs(db,custom.fileId);
    p=await changePlan(db,{action:'edit',expectedRevision:(await planView(db,NOW)).revision,entries:[{...entry,destinations:['youtube/short']}]},NOW);
    expect(p.entries[0]).toMatchObject({id,remaining:[second],destinations:['youtube/short']});
    p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[entry]},NOW);
    expect(p.entries[0]).toMatchObject({id,remaining:[second],destinations:[...DESTINATIONS]});
    await expect(changePlan(db,{action:'edit',expectedRevision:p.revision,entries:[{...entry,destinations:[]}]},NOW)).rejects.toThrow();
    expect(await planView(db,NOW)).toEqual(p);
  });
  it('migration defaults existing jobs to all without changing reservations, queues or version',async()=>{
    const db=makeDb(['0001_init.sql','0002_outros.sql','0003_folder_queue.sql','0004_scheduled_jobs.sql','0005_publishing_plan.sql']);
    db.raw.prepare("INSERT INTO scheduled_jobs(id,name,name_key,schedule_json,policy,remaining_json,status,version,enabled_at,created_at,updated_at) VALUES('old','Old','old',?,'custom',?,'active',7,'now','now','now')").run('[{"day":1,"minute":1080}]',JSON.stringify([custom]));
    db.raw.prepare("INSERT INTO job_reservations(file_id,job_id) VALUES(?,'old')").run(custom.fileId);
    db.raw.exec(readFileSync(new URL('../worker/migrations/0006_destinations.sql',import.meta.url),'utf8'));
    expect((await planView(db,NOW)).entries[0]).toMatchObject({version:7,remaining:[custom],destinations:[...DESTINATIONS]});
    expect(db.raw.prepare('SELECT * FROM job_reservations').all()).toHaveLength(1);
  });
});
