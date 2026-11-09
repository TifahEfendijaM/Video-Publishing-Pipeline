import { describe, expect, it } from 'vitest';
import { makeDb } from './d1-shim';
import { prepareManualReupload, upsertPublication, beginRun, finishRun } from '../worker/src/logic';
import { failureReport } from '../runner/src/failure-report';
import { registerSecret } from '../src/shared/redact';
import { interpretManualBatch, preflightManualBatch } from '../runner/src/manual-batch';
import { noModel } from '../runner/src/interpretation';
const now=Date.parse('2026-11-09T00:00:00Z'),id='video_first_12345';
async function fixture(status='confirmed') {
 const db=makeDb();
 const run=await beginRun(db,{origin:'manual'},now);
 await upsertPublication(db,{runId:run.runId!,fileId:id,platform:'youtube',surface:'video',status},now);
 await finishRun(db,{runId:run.runId!,status:'partial',selectedFileId:id,selectedFileName:'First.mp4'},now);
 return {db,run};
}
describe('explicit recovery after deleting platform copies',()=>{
 it('requires explicit manual intent and exact scoped IDs, audits prior checkpoints and retains run history',async()=>{
  const {db,run}=await fixture();
  await expect(prepareManualReupload(db,{fileIds:[id],intent:''},now)).rejects.toThrow(/exact files/);
  await upsertPublication(db,{runId:run.runId!,fileId:'other_video_12345',platform:'facebook',surface:'feed',status:'confirmed'},now);
  const result=await prepareManualReupload(db,{fileIds:[id],intent:'explicit_manual_reupload',actor:'owner'},now);
  expect(result.cleared).toBe(1);
  expect(db.raw.prepare('SELECT file_id FROM publications').all()).toEqual([{file_id:'other_video_12345'}]);
  expect(db.raw.prepare('SELECT selected_file_id FROM runs WHERE run_id=?').get(run.runId)).toEqual({selected_file_id:id});
  const audit=db.raw.prepare("SELECT detail FROM event_log WHERE kind='publications.manual_reupload'").get() as any;
  expect(JSON.parse(audit.detail).previousCheckpoints).toHaveLength(1);db.raw.close();
 });
 it.each(['initiated','processing','uncertain'])('refuses %s outcomes despite explicit re-upload intent',async(status)=>{
  const {db}=await fixture(status);
  await expect(prepareManualReupload(db,{fileIds:[id],intent:'explicit_manual_reupload'},now)).rejects.toThrow(/Open publication/);
  expect(db.raw.prepare('SELECT COUNT(*) n FROM publications').get()).toEqual({n:1});db.raw.close();
 });
 it('never resets a currently running upload',async()=>{
  const {db,run}=await fixture();db.raw.prepare("UPDATE runs SET status='running' WHERE run_id=?").run(run.runId);
  await expect(prepareManualReupload(db,{fileIds:[id],intent:'explicit_manual_reupload'},now)).rejects.toThrow(/active/);db.raw.close();
 });
 it('allows a dry preflight of deleted sources but still blocks unsafe shared assets',async()=>{
  const entries=await interpretManualBatch('custom: "First.mp4"; outro: none',noModel);
  const deps={videos:[{id,name:'First.mp4',mimeType:'video/mp4',sizeBytes:1,md5:null,createdTime:'now',modifiedTime:'now'}],jobs:[],publications:async()=>[{status:'confirmed'}],stillInFolder:async()=>true};
  await expect(preflightManualBatch(entries,deps)).rejects.toThrow(/reconcile/);
  expect(await preflightManualBatch(entries,{...deps,allowManualReupload:true})).toHaveLength(1);
  await expect(preflightManualBatch(entries,{...deps,allowManualReupload:true,publications:async()=>[{status:'processing'}]})).rejects.toThrow(/reconcile/);
 });
});
describe('actionable failure reports',()=>{
 it('explains the deleted-post recovery without claiming a failed preflight published anything',()=>{
  const report=failureReport(new Error('existing confirmed/live/pending publication checkpoints'),'configure',false,'custom: "First.mp4"');
  expect(report).toContain('automatically prepare');expect(report).toContain('No new platform upload');expect(report).toContain('First.mp4');
 });
 it('distinguishes partial uploads and redacts known credentials',()=>{
  registerSecret('super-private-token-12345');
  const report=failureReport(new Error('API failure super-private-token-12345'),'configure',true);
  expect(report).not.toContain('super-private-token-12345');expect(report).toContain('Some destinations may already be live');
 });
});
