import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeError, redact } from '../../src/shared/redact';
import { Summary } from './summary';

export function failureReport(error:unknown,command:string,mayHavePublished:boolean,input='') {
  const reason=summarizeError(error,1200);
  let next='Open the failed step and its publication results. Retry only destinations confirmed as failed; reconcile pending or uncertain outcomes first.';
  if(/checkpoint|previous.*publish|fresh_after_deleting/i.test(reason)) next='Earlier publication records block a fresh upload. If old posts are still live, use Tools → retry_failed or reconcile. If you deleted the earlier posts, choose manual_publication_action = fresh_after_deleting, or Tools → reset_deleted with previous_posts_deleted checked. Never clear records for posts still live or processing.';
  else if(/clarification|ambiguous|filename|missing.*file/i.test(reason)) next='Use the full exact filename including extension and any (2) suffix. If multiple files have the same exact name, rename them uniquely in Drive.';
  else if(/thumbnail|timestamp|candidate/i.test(reason)) next='Use a thumbnail timestamp inside the main video, or thumbnail: auto. If visual inspection failed, provide an explicit timestamp or check Codex sign-in/account availability.';
  else if(/Codex|sign-in|credential/i.test(reason)) next='Check the dedicated video Codex sign-in, account usage and encrypted credential storage; retry only after checking existing publication results.';
  const s=new Summary().h(1,'Video pipeline failure report').kv([['Stage',command],['Cause',reason],['Upload status',mayHavePublished?'Some destinations may already be live; use their recovery run IDs. Do not replay successful uploads.':'No new platform upload was started by this attempt.']]).h(2,'Next action').p(next);
  if(input) s.h(2,'Entry used').code(input.slice(0,8000));
  return redact(s.text());
}
export function saveFailureReport(error:unknown,command:string,mayHavePublished:boolean,input='') {
  const report=failureReport(error,command,mayHavePublished,input);
  if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,report+'\n');
  appendFileSync(join(process.env.RUNNER_TEMP || tmpdir(),'video-failure-report.md'),report+'\n');
  console.error(report);
}
