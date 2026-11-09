import { describe, expect, it, vi } from 'vitest';
import { majorityConfirmed, platformPublicationCounts, type PublicationOutcome } from '../src/shared/archive-policy';
import { maintainQueue, completeArchived } from '../runner/src/queue';
import { findRetryVideo } from '../runner/src/retry';
import { Drive } from '../runner/src/google';
import { makeDb } from './d1-shim';
import { beginRun, finishRun, upsertPublication, completeVideo, publicationsFor } from '../worker/src/logic';
import { changeJob, jobById } from '../worker/src/jobs';
const id='majority_video_12345', now=Date.parse('2026-11-09T00:00:00Z');
const video={id,name:'First.mp4',mimeType:'video/mp4',sizeBytes:1,md5:null,createdTime:'now',modifiedTime:'now'};
const row=(id:number,platform:string,status:PublicationOutcome['status'],surface='feed')=>({id,platform,status,surface,file_id:video.id});
const outcomes=[row(1,'instagram','confirmed'),row(2,'facebook','confirmed'),row(3,'youtube','confirmed'),row(4,'tiktok','processing')];
const deps=()=>({partialArchiveSupported:true,publications:vi.fn(async()=>outcomes),archive:vi.fn(async()=>{}),complete:vi.fn(async()=>{})});

describe('platform majority archival',()=>{
 it('counts platforms once and requires every selected supported surface on a platform to confirm',()=>{
  const rows=[row(1,'instagram','confirmed'),row(2,'instagram','confirmed','story_part_1'),row(3,'instagram','confirmed','story_part_2'),row(4,'facebook','failed'),row(5,'tiktok','processing'),row(6,'youtube','unsupported')];
  expect(platformPublicationCounts(rows)).toEqual({confirmed:1,unconfirmed:2});expect(majorityConfirmed(rows)).toBe(false);
  rows.push(row(7,'instagram','uncertain','story_part_3'));
  expect(platformPublicationCounts(rows)).toEqual({confirmed:0,unconfirmed:3});
 });
 it('requires a strict majority, ignores unsupported surfaces and counts the latest retry only',()=>{
  expect(majorityConfirmed(outcomes)).toBe(true);
  expect(majorityConfirmed(outcomes.slice(2))).toBe(false);
  expect(majorityConfirmed([row(1,'instagram','confirmed'),row(2,'facebook','confirmed'),row(3,'youtube','failed'),row(4,'tiktok','disabled')])).toBe(false);
  for(const rows of [[],[row(1,'youtube','unsupported')],[row(1,'youtube','failed')]]) expect(majorityConfirmed(rows)).toBe(false);
  expect(platformPublicationCounts([row(1,'youtube','failed'),row(2,'youtube','confirmed'),row(3,'youtube','unsupported','short')].reverse())).toEqual({confirmed:1,unconfirmed:0});
 });
 it('moves a majority without claiming recovery records were cleared',async()=>{
  const d=deps(),q=await maintainQueue([video],new Set(),d);
  expect(d.archive).toHaveBeenCalledExactlyOnceWith(id);expect(d.complete).toHaveBeenCalledExactlyOnceWith(id);
  expect(q.archivedIds.has(id)).toBe(true);expect(q.clearedIds.has(id)).toBe(false);expect(q.blockedIds.has(id)).toBe(true);
  expect(q.notes.join()).toMatch(/3 confirmed.*1 unconfirmed.*retained/);
 });
 it('leaves partial sources in place until the Worker supports retaining recovery records',async()=>{
  const d={...deps(),partialArchiveSupported:false};
  expect((await maintainQueue([video],new Set(),d)).blockedIds.has(id)).toBe(true);
  expect(d.archive).not.toHaveBeenCalled();expect(d.complete).not.toHaveBeenCalled();
 });
 it('recovers a lost completion response without reporting partial records as cleared',async()=>{
  const d=deps();d.complete.mockRejectedValueOnce(new Error('lost response'));
  await maintainQueue([video],new Set(),d);
  expect(await completeArchived(new Set([id]),[id],d)).toBe(0);
  expect(d.archive).toHaveBeenCalledTimes(1);expect(d.complete).toHaveBeenCalledTimes(2);
 });
 it('advances the Custom list after the move while keeping partial checkpoints and run references until all confirm',async()=>{
  const db=makeDb(), next={fileId:'next_video_12345',fileName:'Next.mp4'};
  const job=(await changeJob(db,{action:'create',name:'Series',scheduleText:'Fri 05:00',policy:'custom',remaining:[{fileId:id,fileName:video.name},next]},now) as any).job;
  const run=await beginRun(db,{origin:'manual'},now);
  await finishRun(db,{runId:run.runId!,status:'partial',selectedFileId:id,selectedFileName:video.name},now);
  for(const p of outcomes) await upsertPublication(db,{runId:run.runId!,fileId:id,platform:p.platform,surface:p.surface,status:p.status},now);
  const d={...deps(),publications:async()=>await publicationsFor(db,{fileId:id}) as typeof outcomes,complete:(fileId:string)=>completeVideo(db,fileId)};
  await maintainQueue([video],new Set(),d);
  expect((await jobById(db,job.id))?.remaining).toEqual([next]);
  expect(await publicationsFor(db,{fileId:id})).toHaveLength(4);
  expect(db.raw.prepare('SELECT selected_file_id FROM runs WHERE run_id=?').get(run.runId)).toEqual({selected_file_id:id});
  await completeArchived(new Set([id]),[id],d);
  expect((await jobById(db,job.id))?.remaining).toEqual([next]);
  await upsertPublication(db,{runId:run.runId!,fileId:id,platform:'tiktok',surface:'feed',status:'confirmed'},now);
  expect(await completeArchived(new Set([id]),[id],d)).toBe(1);
  expect(await publicationsFor(db,{fileId:id})).toHaveLength(0);
  expect(db.raw.prepare('SELECT selected_file_id FROM runs WHERE run_id=?').get(run.runId)).toEqual({selected_file_id:null});db.raw.close();
 });
});

describe('recovery after archival',()=>{
 it('finds an archived retry source even if the source listing was fetched before its move',async()=>{
  const drive={stillInFolder:vi.fn(async(_id:string,folder?:string)=>folder==='archive'),publishedFolder:vi.fn(async()=>({id:'archive',name:'Published videos'})),listVideos:vi.fn(async()=>[video])};
  expect(await findRetryVideo(id,[video],drive as unknown as Drive)).toEqual(video);
  expect(drive.publishedFolder).toHaveBeenCalledExactlyOnceWith(false);
  expect(drive.stillInFolder).toHaveBeenLastCalledWith(id,'archive');
 });
 it('does not search elsewhere when the source remains in the main folder',async()=>{
  const drive={stillInFolder:vi.fn(async()=>true),publishedFolder:vi.fn(),listVideos:vi.fn()};
  expect(await findRetryVideo(id,[video],drive as unknown as Drive)).toEqual(video);expect(drive.publishedFolder).not.toHaveBeenCalled();
 });
 it('refuses a retry source no longer in either folder',async()=>{
  const drive={stillInFolder:vi.fn(async()=>false),publishedFolder:vi.fn(async()=>({id:'archive'})),listVideos:vi.fn(async()=>[video])};
  await expect(findRetryVideo(id,[],drive as unknown as Drive)).rejects.toThrow(/no longer/);
 });
});
