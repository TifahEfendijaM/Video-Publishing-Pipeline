import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidateTimes, chooseThumbnail, extractThumbnail, validateThumbnailDuration } from '../runner/src/thumbnails';
import { parseThumbnailTime } from '../src/shared/thumbnail';
import { interpretManualEntry, interpretPlan, resolvePlan, resolveManualEntry } from '../runner/src/publishing-plan';
import { interpretManualBatch, preflightManualBatch } from '../runner/src/manual-batch';
import { noModel } from '../runner/src/interpretation';
import { makeDb } from './d1-shim';
import { changePlan } from '../worker/src/plan';
import { advanceCustomJobs } from '../worker/src/jobs';
import { Meta } from '../runner/src/providers/meta';
import { buildTasks } from '../runner/src/publish';
import { loadConfig } from '../runner/src/config';
import { planFeed, planStory, planYouTubeVersions } from '../src/shared/media';
import { UploadPost } from '../runner/src/providers/uploadpost';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const video=(id:string,name:string)=>({id,name,mimeType:'video/mp4',sizeBytes:100,md5:'x',createdTime:'2026-10-01T00:00:00Z',modifiedTime:'2026-10-01T00:00:00Z'});
const videos=[video('first_video_12345','First.mp4'),video('second_video_12345','Second.mp4')];

describe('independent video thumbnail choices',()=>{
  it('parses precise timestamps, blank/auto, and rejects malformed values',()=>{
    expect(parseThumbnailTime('00:18.5')).toBe(18.5);
    expect(parseThumbnailTime('01:02:03.125')).toBe(3723.125);
    expect(parseThumbnailTime('0')).toBe(0);
    expect(parseThumbnailTime('')).toBeNull();expect(parseThumbnailTime('auto')).toBeNull();
    for(const t of ['-1','NaN','1:70','25:00:00','1.2345','nonsense'])expect(()=>parseThumbnailTime(t)).toThrow();
    for(const t of [-1,10,Infinity])expect(()=>validateThumbnailDuration(t,10)).toThrow();
    expect(candidateTimes(.1).every(t=>t>=0&&t<.1)).toBe(true);
  });
  it('keeps manual batch choices attached to the right exact filename',async()=>{
    const entries=await interpretManualBatch('custom: "First.mp4"; thumbnail: 00:12; outro: none | custom: "Second.mp4"; thumbnail: ; outro: none',noModel);
    const resolved=entries.map(e=>resolveManualEntry(e,videos));
    expect(resolved[0].thumbnailSec).toBe(12);expect(resolved[1].thumbnailSec).toBeNull();
    expect(resolved[0].pendingCustom?.fileId).toBe(videos[0].id);
    expect(resolved[1].pendingCustom?.fileId).toBe(videos[1].id);
    await expect(interpretManualEntry('custom: "First.mp4" @ 12; thumbnail: 13',noModel)).rejects.toThrow(/once/);
    const at=await interpretManualEntry('custom: "Email @ home.mp4"; thumbnail: 0',noModel);
    expect(at.selection?.filenames).toEqual(['Email @ home.mp4']);
  });
  it('validates every explicit batch timestamp before execution can begin',async()=>{
    const parsed=await interpretManualBatch('custom: "First.mp4"; thumbnail: 1; outro: none | custom: "Second.mp4"; thumbnail: 99; outro: none',noModel);
    const check=vi.fn(async(_id:string,t:number)=>validateThumbnailDuration(t,10));
    await expect(preflightManualBatch(parsed,{videos,jobs:[],publications:async()=>[],stillInFolder:async()=>true,validateThumbnail:check})).rejects.toThrow(/outside/);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it('persists distinct scheduled choices, changes them without restarting progress, and defaults independently',async()=>{
    const db=makeDb(),now=Date.parse('2026-11-09T00:00:00Z');
    const parse=async(text:string,saved:any[]=[])=>resolvePlan(await interpretPlan(text,noModel),videos,saved);
    const entries=await parse('Sun 18:00: custom: "First.mp4" @ 12, "Second.mp4" @ auto; outro: none');
    let p=await changePlan(db,{action:'edit',expectedRevision:0,entries},now);
    expect(p.entries[0].originalCustom.map(v=>v.thumbnailSec)).toEqual([12,undefined]);
    const id=p.entries[0].id;
    await advanceCustomJobs(db,videos[0].id);
    const after=await import('../worker/src/plan').then(m=>m.planView(db,now));
    p=await changePlan(db,{action:'edit',expectedRevision:after.revision,entries:await parse('Sun 18:00: custom: "First.mp4" @ 9, "Second.mp4" @ 4; outro: none',after.entries)},now);
    expect(p.entries[0].id).toBe(id);
    expect(p.entries[0].remaining).toEqual([{fileId:videos[1].id,fileName:'Second.mp4',thumbnailSec:4}]);
    p=await changePlan(db,{action:'edit',expectedRevision:p.revision,entries:await parse('Sun 18:00: custom: "First.mp4", "Second.mp4"; outro: none',p.entries)},now);
    expect(p.entries[0].remaining[0].thumbnailSec).toBeUndefined();
    await expect(interpretPlan('Sun 18:00: custom: "First.mp4", "Second.mp4"; thumbnail: 12',noModel)).rejects.toThrow(/each thumbnail/);
    db.raw.close();
  });
  it('extracts real frames and visually inspects each video separately; explicit timestamps skip Codex',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'thumb-test-'));dirs.push(dir);
    const inspections:any[]=[];
    const inspect=vi.fn(async(_sys:string,user:string,_schema:object,images:string[])=>{
      inspections.push({input:JSON.parse(user),bytes:readFileSync(images[0])});
      return {candidate:0,reason:'Clear representative content'};
    });
    for(const [i,color] of ['red','blue'].entries()) {
      const source=join(dir,`${i}.mp4`),work=join(dir,`work${i}`);mkdirSync(work);
      execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=160x90:d=1:r=10`,'-c:v','libx264','-threads','1',source]);
      const result=await chooseThumbnail({source,work,duration:1,filename:`Video${i}.mp4`,inspect});
      expect(result.seconds).toBe(.5);
      const target=join(work,'chosen.jpg');await extractThumbnail(source,target,result.seconds);
      expect(readFileSync(target).subarray(0,2)).toEqual(Buffer.from([255,216]));
      await chooseThumbnail({source,work,duration:1,filename:`Video${i}.mp4`,seconds:0,inspect});
      await expect(chooseThumbnail({source,work,duration:1,filename:'x',inspect:async()=>({candidate:50,reason:'invented'})})).rejects.toThrow(/valid thumbnail candidate/);
    }
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspections[0].input.filename).not.toBe(inspections[1].input.filename);
    expect(inspections[0].bytes.equals(inspections[1].bytes)).toBe(false);
  },15000);
  it('routes each selected frame correctly and keeps a published video confirmed if only its thumbnail fails',async()=>{
    const cfg=loadConfig();cfg.destinations.youtube.short.bufferChannelId='channel';
    const info={durationSec:100,width:1920,height:1080,videoCodec:'h264',audioCodec:'aac',audioSampleRate:48000,fps:30,sizeBytes:100,container:'mp4',pixFmt:'yuv420p'};
    const ids:any=Object.fromEntries(['instagram','facebook','tiktok','youtube','youtubeBuffer','youtubeUploadPost'].map(k=>[k,{ok:true,detail:''}]));
    const sent=vi.fn(async()=>({status:'confirmed',remoteId:'id',detail:'Published'}));
    const ig=vi.fn(async(..._args:any[])=>sent()),buffer=vi.fn(async(..._args:any[])=>sent()),upload=vi.fn(async(..._args:any[])=>sent()),fb=vi.fn(async(..._args:any[])=>sent()),cover=vi.fn(async()=>{throw new Error('cover rejected');});
    const feed=planFeed(info);feed.facebook.format='page_video';
    const tasks=buildTasks({cfg,info,feed,stories:{plan:planStory(info,'segment'),files:[]},originalPath:'source',captions:{caption:'x',youtubeTitle:'t',youtubeDescription:'d'},
      providers:{meta:{instagram:ig,facebookPageVideo:fb,facebookThumbnail:cover} as any,buffer:{publish:buffer} as any,uploadPost:{upload} as any},identities:ids,
      youtube:{plan:planYouTubeVersions(info),shortPath:'short',regularPath:'regular'},thumbnail:{seconds:12.5,youtubePath:'yt.jpg',facebookPath:'fb.jpg'}});
    const ctx={url:'url',gate:async()=>({allowed:true,reason:null}),progress:async()=>{}};
    for(const key of ['instagram:feed','tiktok:feed','youtube:short','youtube:video','facebook:feed']) {
      const [platform,surface]=key.split(':');const task=tasks.find(t=>t.platform===platform&&t.surface===surface)!;
      const result=await task.run!(ctx);
      if(key==='facebook:feed'){expect(result.status).toBe('confirmed');expect(result.detail).toContain('Do not re-upload');}
    }
    expect(ig.mock.calls[0].at(-1)).toBe(12.5);
    expect((buffer.mock.calls[0] as any)[0].thumbnailOffset).toBe(12500);
    expect((buffer.mock.calls[1] as any)[0].thumbnailOffset).toBeUndefined();
    expect((upload.mock.calls[0] as any)[1].thumbnailPath).toBe('yt.jpg');
  });
  it('sends the selected JPEG to Upload-Post and Facebook without a real upload',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'thumb-form-'));dirs.push(dir);
    const path=join(dir,'image.jpg');writeFileSync(path,Buffer.from([255,216,255,217]));
    const videoPath=join(dir,'video.mp4');writeFileSync(videoPath,'fixture');
    const requests:any[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
      requests.push({url,init});
      if(url.includes('/thumbnails'))return Response.json({success:true});
      if(url.includes('/status?'))return Response.json({status:'completed',results:[{platform:'youtube',success:true,video_id:'test-id',url:'https://youtu.be/test-id'}]});
      return Response.json({success:true});
    }));
    const result=await new UploadPost('test','profile',0).upload(videoPath,{title:'t',description:'d',categoryId:'27',madeForKids:false,thumbnailPath:path},async()=>({allowed:true,reason:null}),async()=>{});
    expect(result.status).toBe('confirmed');
    expect((requests[0].init.body as FormData).get('thumbnail')).toBeInstanceOf(Blob);
    await new Meta('test','v25.0',0).facebookThumbnail('video',path);
    const form=requests.at(-1).init.body as FormData;
    expect(form.get('is_preferred')).toBe('true');expect(form.get('source')).toBeInstanceOf(Blob);
  });
});
