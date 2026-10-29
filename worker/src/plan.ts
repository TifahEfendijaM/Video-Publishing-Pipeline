import { HttpError, randomToken, type Db, type Outros } from './logic';
import { listJobs } from './jobs';
import { planState, setPlanPaused } from './plan-state';
import { selectionKey, validatePlanEntries, type PlanEntryInput } from '../../src/shared/publishing-plan';
import { parseSchedule } from '../../src/shared/schedule';

export interface PlanChange {
  action: 'edit' | 'pause' | 'resume';
  expectedRevision?: number;
  entries?: PlanEntryInput[];
  outros?: Outros;
}

export async function planView(db: Db, nowMs: number) {
  const meta = await planState(db);
  return { paused: !!meta.paused, revision: meta.revision, outros: JSON.parse(meta.outros_json) as Outros, updatedAt: meta.updated_at, entries: await listJobs(db, nowMs) };
}

/** Replace the whole plan atomically, preserving progress by unchanged selection identity. */
export async function changePlan(db: Db, request: PlanChange, nowMs: number) {
  if (!['edit', 'pause', 'resume'].includes(request.action)) throw new HttpError(400, 'Choose Edit, Pause or Resume');
  if (request.action !== 'edit') {
    await setPlanPaused(db, request.action === 'pause', nowMs);
    return planView(db, nowMs);
  }
  const old = await listJobs(db, nowMs), meta = await planState(db);
  if (request.expectedRevision !== meta.revision) throw new HttpError(409, 'The plan or Custom progress changed; read it again before editing');
  let entries: PlanEntryInput[] | undefined;
  try { entries = request.entries === undefined ? undefined : validatePlanEntries(request.entries); }
  catch(e) { throw new HttpError(400, (e as Error).message); }
  if (request.outros && Object.keys(request.outros).length) throw new HttpError(400, 'Specify outros inside each timetable entry; universal scheduled outro changes are retired');
  if (entries === undefined) return planView(db, nowMs);
  const at = new Date(nowMs).toISOString();
  const planOutros = JSON.parse(meta.outros_json);
  const used = new Set<string>();
  const desired = (entries ?? old.map(j => ({scheduleText: j.scheduleText, policy: j.policy, custom: j.policy === 'custom' ? j.originalCustom : [], titleRule: j.titleRule}))).map((entry, index) => {
    const key = selectionKey(entry);
    const candidates = old.filter(j => !used.has(j.id) && selectionKey({policy: j.policy, custom: j.policy === 'custom' ? j.originalCustom : [], titleRule: j.titleRule}) === key);
    const prior = candidates.find(j => j.scheduleText === entry.scheduleText) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (prior) used.add(prior.id);
    const remaining = prior ? prior.remaining : entry.custom;
    const outroSource = prior ?? old.find(j => j.scheduleText === entry.scheduleText);
    return { entry, prior, remaining, position: index, id: prior?.id ?? randomToken().slice(0,24), name: `Plan entry ${index+1}`, outros: {...outroSource?.outros, ...entry.outros} };
  });
  const protectedIds = new Set<string>();
  const saved = await db.prepare('SELECT outros_json FROM settings WHERE id=1').first<{outros_json: string | null}>();
  for (const o of [...old.map(j=>j.outros), ...desired.map(j=>j.outros), saved?.outros_json ? JSON.parse(saved.outros_json) : {}]) {
    for (const v of Object.values(o) as any[]) if (v) protectedIds.add(v.fileId);
  }
  const added = desired.flatMap(d => d.remaining.filter(v => !d.prior?.remaining.some(p=>p.fileId===v.fileId)));
  if (added.some(v => /outro/i.test(v.fileName) || protectedIds.has(v.fileId))) throw new HttpError(400, 'Outros cannot be standalone scheduled entries');
  if (added.length) {
    const held = await db.prepare("SELECT file_id FROM publications WHERE file_id IN (SELECT value FROM json_each(?)) AND status IN ('initiated','processing','confirmed','uncertain')").bind(JSON.stringify(added.map(v=>v.fileId))).all();
    if (held.results.length) throw new HttpError(409, 'New Custom entries have pending publishing outcomes; resolve them before editing');
  }
  const statements = [
    // A NOT NULL failure rolls the entire batch back if an archival checkpoint raced this edit.
    db.prepare('UPDATE publishing_plan SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END,updated_at=?,outros_json=? WHERE id=1').bind(request.expectedRevision, at, JSON.stringify(planOutros)),
    db.prepare('DELETE FROM job_reservations'),
    db.prepare("UPDATE occurrence_claims SET state='cancelled' WHERE job_id IS NOT NULL AND state IN ('claimed','dispatched','dispatch_failed')"),
    db.prepare('DELETE FROM scheduled_jobs WHERE id NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(desired.map(d=>d.id))),
  ];
  const rows = JSON.stringify(desired.map(d=>({
    id:d.id, name:d.prior?.name ?? d.name, nameKey:d.prior ? d.prior.name.toLowerCase() : d.id,
    schedule:JSON.stringify(parseSchedule(d.entry.scheduleText)), policy:d.entry.policy,
    remaining:JSON.stringify(d.remaining), rule:d.entry.titleRule ? JSON.stringify(d.entry.titleRule) : null,
    outros:JSON.stringify(d.outros), status:d.entry.policy==='custom' && !d.remaining.length ? 'completed' : 'active',
    version:(d.prior?.version ?? 0)+1, original:d.entry.policy==='custom' ? JSON.stringify(d.entry.custom) : null, position:d.position,
  })));
  // Bulk statements keep request/query counts bounded as a plan grows.
  statements.push(db.prepare(`INSERT INTO scheduled_jobs(id,name,name_key,schedule_json,policy,remaining_json,title_rule_json,outros_json,status,version,enabled_at,created_at,updated_at,custom_original_json,plan_position)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.nameKey'),json_extract(value,'$.schedule'),
      json_extract(value,'$.policy'),json_extract(value,'$.remaining'),json_extract(value,'$.rule'),json_extract(value,'$.outros'),
      json_extract(value,'$.status'),json_extract(value,'$.version'),?,?,?,json_extract(value,'$.original'),json_extract(value,'$.position')
    FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET schedule_json=excluded.schedule_json,policy=excluded.policy,
      remaining_json=excluded.remaining_json,title_rule_json=excluded.title_rule_json,outros_json=excluded.outros_json,status=excluded.status,
      version=excluded.version,enabled_at=excluded.enabled_at,updated_at=excluded.updated_at,custom_original_json=excluded.custom_original_json,plan_position=excluded.plan_position`)
    .bind(at,at,at,rows));
  statements.push(db.prepare(`INSERT INTO job_reservations(file_id,job_id)
    SELECT json_extract(file.value,'$.fileId'),json_extract(entry.value,'$.id')
    FROM json_each(?) entry JOIN json_each(json_extract(entry.value,'$.remaining')) file`).bind(rows));

  try { await db.batch(statements); }
  catch(e) {
    if (/constraint|UNIQUE|NOT NULL/i.test(String(e))) throw new HttpError(409, 'The plan changed or Custom lists conflict; no edits saved. Read the plan again');
    throw e;
  }
  return planView(db,nowMs);
}
