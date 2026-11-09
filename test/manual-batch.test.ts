import { describe, it, expect, vi } from 'vitest';
import { splitManualBatch, interpretManualBatch, preflightManualBatch } from '../runner/src/manual-batch';
import { noModel } from '../runner/src/interpretation';
import type { FolderVideo } from '../src/shared/selection';

const video=(id:string,name:string):FolderVideo=>({
  id,name,mimeType:'video/mp4',sizeBytes:1000,md5:null,createdTime:'2026-11-01T12:00:00Z',modifiedTime:'2026-11-01T12:00:00Z',
});
const files=[
  video('video-00001','One.mp4'),video('video-00002','Two.mp4'),
  video('video-00003','Ending.mp4'),video('video-00004','SavedOutro.mp4'),
];
const input='custom: "One.mp4"; destinations: youtube/short; outro: none | custom: "Two.mp4"; destinations: instagram/reel, youtube/video; outro: "Ending.mp4"';
const dependencies=()=>({
  videos:files.map(v=>({...v})),
  jobs:[] as {remaining:{fileId:string;fileName:string}[]}[],
  publications:vi.fn(async(_id:string)=>[] as {status:string}[]),
  stillInFolder:vi.fn(async(_id:string)=>true),
  savedOutros:{youtube:{fileId:'video-00004',fileName:'SavedOutro.mp4'}},
});
describe('manual batch parsing and preflight',()=>{
  it('splits only outside filenames, preserving literal commas, pipes and doubled quotes',()=>{
    expect(splitManualBatch('custom: "A|B.mp4"; outro: "X""Y.mp4" | custom: "C.mp4"')).toEqual([
      'custom: "A|B.mp4"; outro: "X""Y.mp4"','custom: "C.mp4"',
    ]);
  });
  it('normalizes independent destinations and per-entry outros without changing the default-all behavior',async()=>{
    const entries=await interpretManualBatch(input,noModel);
    const deps=dependencies();
    const resolved=await preflightManualBatch(entries,deps);
    expect(resolved.map(v=>v.fileName)).toEqual(['One.mp4','Two.mp4']);
    expect(resolved[0].destinations).toEqual(['youtube/short']);
    expect(resolved[1].destinations).toEqual(['instagram/reel','youtube/video']);
    expect(resolved[0].outroOverrides.youtube).toBeNull();
    expect(resolved[1].outroOverrides.youtube).toEqual({fileId:'video-00003',fileName:'Ending.mp4'});
    expect(deps.publications).toHaveBeenCalledTimes(3);
    const defaults=await interpretManualBatch('custom: "One.mp4" | custom: "Two.mp4"',noModel);
    expect(defaults[0].destinations).toContain('youtube/short');
    expect(defaults[0].destinations).toContain('youtube/video');
  });
  it('rejects missing, repeated, ambiguous, non-video and reserved batch inputs before publishing',async()=>{
    for(const text of [
      'custom: "One.mp4" | custom: "One.mp4"',
      'custom: "Missing.mp4" | custom: "Two.mp4"',
      'fifo | custom: "Two.mp4"',
      'custom: "One.mp4"; destinations: xyz | custom: "Two.mp4"',
    ]){
      const deps=dependencies();
      await expect((async()=>preflightManualBatch(await interpretManualBatch(text,noModel),deps))()).rejects.toThrow();
      expect(deps.publications).not.toHaveBeenCalled();
    }
    const reserved=dependencies();
    reserved.jobs.push({remaining:[{fileId:'video-00002',fileName:'Two.mp4'}]});
    await expect(preflightManualBatch(await interpretManualBatch(input,noModel),reserved)).rejects.toThrow(/reservation/);
    const ambiguous=dependencies();
    ambiguous.videos.push(video('video-00005','One.mp4'));
    await expect(preflightManualBatch(await interpretManualBatch(input,noModel),ambiguous)).rejects.toThrow(/missing or ambiguous/);
    const notVideo=dependencies();
    notVideo.videos[0]={...notVideo.videos[0],mimeType:'image/png'};
    await expect(preflightManualBatch(await interpretManualBatch(input,noModel),notVideo)).rejects.toThrow(/not a video/);
  });
  it('guards against archiving any later source used as an outro, including inherited choices',async()=>{
    const cross=await interpretManualBatch('custom: "One.mp4"; outro: "Two.mp4" | custom: "Two.mp4"',noModel);
    await expect(preflightManualBatch(cross,dependencies())).rejects.toThrow(/both a batch video and an outro/);
    const inherited=dependencies();
    inherited.savedOutros={youtube:{fileId:'video-00002',fileName:'Two.mp4'}};
    await expect(preflightManualBatch(await interpretManualBatch('custom: "One.mp4" | custom: "Two.mp4"',noModel),inherited)).rejects.toThrow(/both a batch video and an outro/);
  });
  it('fails closed on missing Drive assets or preexisting live/confirmed checkpoints, including shared outros',async()=>{
    const entries=await interpretManualBatch(input,noModel);
    const disappeared=dependencies();
    disappeared.stillInFolder.mockImplementation(async id=>id!=='video-00003');
    await expect(preflightManualBatch(entries,disappeared)).rejects.toThrow(/no longer/);
    const existing=dependencies();
    existing.publications.mockImplementation(async id=>id==='video-00002'?[{status:'confirmed'}]:[]);
    await expect(preflightManualBatch(entries,existing)).rejects.toThrow(/checkpoints/);
    const pending=dependencies();
    pending.publications.mockImplementation(async id=>id==='video-00003'?[{status:'uncertain'}]:[]);
    await expect(preflightManualBatch(entries,pending)).rejects.toThrow(/checkpoints/);
  });
  it('does not silently turn a multi-video batch into automatic selection',async()=>{
    await expect(interpretManualBatch('fifo | lifo',noModel)).rejects.toThrow(/exactly one Custom/);
    await expect(interpretManualBatch('custom: "One.mp4" | custom: "Two.mp4" | custom: "One.mp4"; destinations: nowhere',noModel)).rejects.toThrow();
    await expect(interpretManualBatch('custom: "One.mp4" | custom: "Two.mp4" |',noModel)).resolves.toHaveLength(2);
  });
});
