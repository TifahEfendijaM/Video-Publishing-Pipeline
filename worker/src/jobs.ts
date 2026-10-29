import { dispatchWorkflow, HttpError, randomToken, sha256Hex, timingSafeEqual, type Db, type Env, type FetchFn, type Outros } from "./logic";
import { dueOccurrence, nextOccurrences, parseSchedule, formatSchedule, type Slot } from "../../src/shared/schedule";
import type { CustomVideo, JobPolicy, TitleRule } from "../../src/shared/job-selection";

export interface ScheduledJob {
  id: string; name: string; schedule: Slot[]; scheduleText: string; policy: JobPolicy;
  remaining: CustomVideo[]; titleRule: TitleRule | null; outros: Outros;
  status: "active" | "completed" | "stopped"; version: number; enabledAt: string;
}
const iso = (n: number) => new Date(n).toISOString();
function read(r: any): ScheduledJob {
  const schedule = JSON.parse(r.schedule_json);
  return { id: r.id, name: r.name, schedule, scheduleText: formatSchedule(schedule), policy: r.policy,
    remaining: JSON.parse(r.remaining_json), titleRule: r.title_rule_json ? JSON.parse(r.title_rule_json) : null,
    outros: JSON.parse(r.outros_json), status: r.status, version: r.version, enabledAt: r.enabled_at };
}
export async function jobById(db: Db, id: string): Promise<ScheduledJob | null> {
  const row = await db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").bind(id).first();
  return row ? read(row) : null;
}
export async function listJobs(db: Db, nowMs: number) {
  const rows = (await db.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at, id").all()).results;
  return rows.map((r) => {
    const job = read(r);
    return { ...job, nextOccurrences: job.status === "active" ? nextOccurrences(job.schedule, nowMs, 5).map((o) => ({ key: o.key, local: o.localLabel })) : [] };
  });
}
export interface JobChange {
  action: "create" | "edit" | "delete"; name: string; scheduleText?: string | null;
  policy?: JobPolicy | null; remaining?: CustomVideo[]; titleRule?: TitleRule | null; outros?: Outros;
}

export async function changeJob(db: Db, req: JobChange, nowMs: number) {
  if (!["create", "edit", "delete"].includes(req.action)) throw new HttpError(400, "Choose create, edit, delete or list");
  const name = (req.name ?? "").normalize("NFC").trim();
  if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new HttpError(400, "A job name of 1–100 characters is required");
  const key = name.toLowerCase();
  const row = await db.prepare("SELECT * FROM scheduled_jobs WHERE name_key = ? OR id = ?").bind(key, name).first<any>();
  const old = row ? read(row) : null;
  if (req.action === "create" && old) throw new HttpError(409, "Job already exists; use Edit");
  if (req.action !== "create" && !old) throw new HttpError(404, "No job with that name; use List jobs to copy its name");
  if (req.action === "delete") {
    await db.batch([
      db.prepare("DELETE FROM job_reservations WHERE job_id = ?").bind(old!.id),
      db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").bind(old!.id),
      db.prepare("UPDATE occurrence_claims SET state = 'cancelled' WHERE job_id = ? AND state IN ('claimed','dispatched','dispatch_failed')").bind(old!.id),
    ]);
    return { deleted: old!.name };
  }
  let schedule: Slot[] | null;
  try { schedule = parseSchedule(req.scheduleText ?? null); } catch (e) { throw new HttpError(400, (e as Error).message); }
  schedule ??= old?.schedule ?? null;
  if (!schedule) throw new HttpError(400, "Create requires a schedule; blank only keeps an existing job's times");
  const policy = req.policy ?? old?.policy;
  if (!policy || !["fifo", "lifo", "random", "custom", "title_rule"].includes(policy)) throw new HttpError(400, "Create requires a selection rule");
  if (req.remaining !== undefined && !Array.isArray(req.remaining)) throw new HttpError(400, "Invalid Custom list");
  const remaining = policy === "custom" ? req.remaining ?? old?.remaining ?? [] : req.policy == null ? old?.remaining ?? [] : [];
  if (policy === "custom" && !remaining.length) throw new HttpError(400, "A Custom job needs at least one remaining video");
  if (remaining.length > 500 || remaining.some((v) => !v || !/^[A-Za-z0-9_-]{10,200}$/.test(v.fileId) || typeof v.fileName !== "string" || v.fileName.length > 300)) throw new HttpError(400, "Invalid Custom list");
  if (new Set(remaining.map((v) => v.fileId)).size !== remaining.length) throw new HttpError(400, "Custom list repeats a video");
  const rule = policy === "title_rule" ? req.titleRule ?? old?.titleRule : null;
  if (policy === "title_rule" && (!rule || !["contains", "starts_with", "ends_with"].includes(rule.match) || typeof rule.text !== "string" || !rule.text.trim() || rule.text.length > 200 || !["fifo", "lifo", "random"].includes(rule.order))) throw new HttpError(400, "Invalid interpreted title rule");
  const outros = { ...old?.outros, ...req.outros };
  for (const [platform, outro] of Object.entries(outros)) {
    if (!["youtube", "tiktok", "instagram", "facebook"].includes(platform) || (outro !== null && (!outro || !/^[A-Za-z0-9_-]{10,200}$/.test(outro.fileId) || typeof outro.fileName !== "string"))) throw new HttpError(400, "Invalid outro");
  }
  const id = old?.id ?? randomToken().slice(0, 24);
  const protectedRows = (await db.prepare("SELECT outros_json FROM scheduled_jobs UNION ALL SELECT outros_json FROM settings WHERE id=1").all<{ outros_json: string | null }>()).results;
  const protectedIds = new Set([...protectedRows.map((r) => r.outros_json ? JSON.parse(r.outros_json) : {}), outros].flatMap((o) => Object.values(o).flatMap((v: any) => v ? [v.fileId] : [])));
  const added = remaining.filter((v) => !old?.remaining.some((p) => p.fileId === v.fileId));
  if (added.some((v) => /outro/i.test(v.fileName) || protectedIds.has(v.fileId))) throw new HttpError(400, "Outro assets cannot be scheduled as standalone Custom entries; use manual Custom for an intentional outro upload");
  if (added.length) {
    const held = await db.prepare("SELECT DISTINCT file_id FROM publications WHERE file_id IN (SELECT value FROM json_each(?)) AND status IN ('initiated','processing','confirmed','uncertain')")
      .bind(JSON.stringify(added.map((v) => v.fileId))).all();
    if (held.results.length) throw new HttpError(409, "A new Custom entry has pending/previous publishing outcomes. Reconcile or resolve those before assigning it");
  }
  const version = (old?.version ?? 0) + 1;
  const statements = [db.prepare(`INSERT INTO scheduled_jobs(id,name,name_key,schedule_json,policy,remaining_json,title_rule_json,outros_json,status,version,enabled_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET schedule_json=excluded.schedule_json,policy=excluded.policy,
    remaining_json=excluded.remaining_json,title_rule_json=excluded.title_rule_json,outros_json=excluded.outros_json,status='active',version=excluded.version,enabled_at=excluded.enabled_at,updated_at=excluded.updated_at`)
    .bind(id, old?.name ?? name, old?.name.toLowerCase() ?? key, JSON.stringify(schedule), policy, JSON.stringify(remaining), rule ? JSON.stringify(rule) : null, JSON.stringify(outros), version, iso(nowMs), row?.created_at ?? iso(nowMs), iso(nowMs)),
    db.prepare("DELETE FROM job_reservations WHERE job_id = ?").bind(id)];
  statements.push(db.prepare("INSERT INTO job_reservations(file_id,job_id) SELECT json_extract(value,'$.fileId'),? FROM json_each(?)").bind(id, JSON.stringify(remaining)));
  try { await db.batch(statements); } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "Job name or Custom video is already assigned to another job; no changes saved");
    throw e;
  }
  return { job: await jobById(db, id) };
}

/** Advance only after Drive read-back confirms archival; never on processing/partial outcomes. */
export async function advanceCustomJobs(db: Db, fileId: string) {
  const reservation = await db.prepare("SELECT job_id FROM job_reservations WHERE file_id = ?").bind(fileId).first<{ job_id: string }>();
  if (!reservation) return;
  const job = await jobById(db, reservation.job_id);
  if (!job) return;
  const remaining = job.remaining.filter((v) => v.fileId !== fileId);
  const status = job.policy === "custom" && !remaining.length ? "completed" : job.status;
  await db.batch([
    db.prepare("UPDATE scheduled_jobs SET remaining_json=?,status=? WHERE id=?").bind(JSON.stringify(remaining), status, job.id),
    db.prepare("DELETE FROM job_reservations WHERE file_id=? AND job_id=?").bind(fileId, job.id),
  ]);
}

/** Durable per-job claims survive cancellation/replacement of GitHub's single pending concurrency slot. */
export async function dispatchJobs(env: Env, nowMs: number, fetchFn: FetchFn) {
  const db = env.DB;
  const jobs = (await listJobs(db, nowMs)).filter((j) => j.status === "active");
  const claims: { key: string; version: number; jobId: string }[] = [];
  for (const job of jobs) {
    const occurrence = dueOccurrence(job.schedule, nowMs);
    if (!occurrence || occurrence.utcMs <= Date.parse(job.enabledAt)) continue;
    claims.push({ key: `${job.id}|${occurrence.key}`, version: job.version, jobId: job.id });
  }
  if (claims.length) await db.prepare(`INSERT INTO occurrence_claims(occurrence_key,kind,config_version,claim_token_hash,claimed_at,state,job_id)
    SELECT json_extract(value,'$.key'),'scheduled',json_extract(value,'$.version'),'batch-authorized',?,'claimed',json_extract(value,'$.jobId')
    FROM json_each(?) WHERE 1 ON CONFLICT(occurrence_key) DO NOTHING`).bind(iso(nowMs), JSON.stringify(claims)).run();
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM occurrence_claims WHERE job_id IS NOT NULL AND state IN ('claimed','dispatched','dispatch_failed')").first<{ n: number }>();
  if (!pending?.n) return jobs.length ? { action: "not_due" } : null;
  const id = `jobs:${new Date(Math.floor(nowMs / 60000) * 60000).toISOString()}`;
  const token = randomToken();
  const inserted = await db.prepare("INSERT INTO job_batches(id,token_hash,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, await sha256Hex(token), iso(nowMs)).run();
  if (!inserted.meta.changes) return { action: "duplicate", key: id };
  const outcome = await dispatchWorkflow(env, { occurrence_key: id, claim_token: token, config_version: "0", mode: "jobs" }, fetchFn);
  await db.prepare("UPDATE job_batches SET dispatch_status=?,dispatch_note=? WHERE id=?").bind(outcome.status, outcome.note, id).run();
  return { action: outcome.status === 204 ? "jobs_dispatched" : "dispatch_failed", key: id, status: outcome.status };
}

export async function validBatch(db: Db, id: string, token: string) {
  const batch = await db.prepare("SELECT token_hash,created_at FROM job_batches WHERE id=?").bind(id).first<{ token_hash: string; created_at: string }>();
  return !!batch && timingSafeEqual(batch.token_hash, await sha256Hex(token));
}
export async function batchClaims(db: Db, id: string, token: string) {
  if (!await validBatch(db, id, token)) throw new HttpError(403, "Invalid scheduler batch token");
  const rows = await db.prepare("SELECT occurrence_key FROM occurrence_claims WHERE job_id IS NOT NULL AND state IN ('claimed','dispatched','dispatch_failed') ORDER BY claimed_at,occurrence_key LIMIT 100").all<{ occurrence_key: string }>();
  return { claims: rows.results.map((r) => r.occurrence_key) };
}
