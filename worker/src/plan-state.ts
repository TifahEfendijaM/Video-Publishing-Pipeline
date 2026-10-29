import type { Db } from './logic';

export async function planState(db: Db) {
  return (await db.prepare('SELECT paused,revision,outros_json,updated_at FROM publishing_plan WHERE id=1').first<{paused: number; revision: number; outros_json: string; updated_at: string}>())!;
}

/** Pause cancels queued work; Resume starts at future slots, never catches up missed occurrences. */
export async function setPlanPaused(db: Db, paused: boolean, nowMs: number) {
  const old = await planState(db);
  if (!!old.paused === paused) return;
  const at = new Date(nowMs).toISOString();
  await db.batch([
    db.prepare('UPDATE publishing_plan SET paused=?,revision=revision+1,updated_at=? WHERE id=1').bind(paused ? 1 : 0, at),
    db.prepare("UPDATE scheduled_jobs SET version=version+1,enabled_at=?,updated_at=? WHERE status='active'").bind(at, at),
    db.prepare("UPDATE occurrence_claims SET state='cancelled' WHERE job_id IS NOT NULL AND state IN ('claimed','dispatched','dispatch_failed')"),
  ]);
}
