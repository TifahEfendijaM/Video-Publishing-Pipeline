import {describe,it,expect,vi} from 'vitest';
import {flexibleInterpretation, validateNormalized} from '../runner/src/interpretation';

const normalized='Once on 2026-11-07 at 21:00: custom: "Coffee.mp4"; outro: none | Every 3 days at 18:00 starting 2026-11-08: lifo; outro: "Ending.mp4"';
const context=()=>Promise.resolve({savedPlan:'Mon 06:00: fifo',filenames:['Coffee.mp4','Ending.mp4'],referenceTime:'2026-11-07T15:00:00Z'});
describe('on-demand whole-entry interpretation',()=>{
  it('keeps formatted entries deterministic without reading Drive or calling Codex',async()=>{
    const model={model:'test',run:vi.fn()},ctx=vi.fn(context);
    expect(await flexibleInterpretation('plan',normalized,model,ctx)).toBe(normalized);
    expect(model.run).not.toHaveBeenCalled();expect(ctx).not.toHaveBeenCalled();
  });
  it('provides fixed Sarajevo reference, full saved plan and filenames, and validates the complete result',async()=>{
    const run=vi.fn(async(_system:string,_user:string)=>({status:'ready',normalized,explanation:'Tonight once, then every third day from tomorrow.'}));
    expect(await flexibleInterpretation('plan','Upload Coffee tonight at nine, then newest first every third day from tomorrow at six with Ending',{model:'test',run},context)).toBe(normalized);
    const input=JSON.parse(run.mock.calls[0][1]);
    expect(input).toMatchObject({kind:'plan',timeZone:'Europe/Sarajevo',referenceTime:'2026-11-07T15:00:00Z',filenames:['Coffee.mp4','Ending.mp4'],savedPlan:'Mon 06:00: fifo'});
  });
  it('requires clarification and rejects malformed or unsupported model outputs before settings can change',async()=>{
    for(const output of [{status:'needs_clarification',normalized:null,explanation:'Choose a clock time.'},{status:'ready',normalized:null,explanation:'Empty.'},{status:'ready',normalized:'Every month: publish anything',explanation:'Unsupported.'},{status:'ready',normalized:'Mon 06:00: lifo | Mon 06:00: fifo',explanation:'Overlaps.'},{}]){
      await expect(flexibleInterpretation('plan','Upload tonight',{model:'test',run:async()=>output},context)).rejects.toThrow();
    }
  });
  it('validates manual and title-filter entries with the same strict interpreter',async()=>{
    await expect(validateNormalized('manual','custom: "Coffee.mp4"; outro: none')).resolves.toBeUndefined();
    await expect(validateNormalized('manual','Once on 2026-11-08 at 09:00: lifo')).rejects.toThrow();
    await expect(validateNormalized('rule','random video whose title ends with "[available]"')).resolves.toBeUndefined();
    await expect(validateNormalized('rule','Delete everything')).rejects.toThrow();
  });
});
