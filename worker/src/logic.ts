// Scheduler + state logic. Runs inside the Cloudflare Worker against D1; tests run it against node:sqlite.
import {
  DEFAULT_SCHEDULE,
  ScheduleParseError,
  dueOccurrence,
  formatSchedule,
  nextOccurrences,
  parseSchedule,
  type Slot,
} from "../../src/shared/schedule";

// Minimal subset of the D1 API we rely on.
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Db {
  prepare(sql: string): Stmt;
}

export interface Env {
  DB: Db;
  STATE_API_TOKEN: string;
  GH_DISPATCH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string; // scheduled-publish.yml
  GITHUB_REF: string; // branch the scheduled workflow is dispatched on
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Settings {
  automationEnabled: boolean;
  automationEnabledAt: string | null;
  scheduleSaved: Slot[] | null;
  scheduleEffective: Slot[];
  scheduleText: string;
  scheduleIsDefault: boolean;
  selectionPolicy: "fifo" | "lifo";
  pendingCustom: { fileId: string; fileName: string | null; configVersion: number } | null;
  publishingEnabled: boolean;
  configVersion: number;
  updatedAt: string;
  updatedBy: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function log(db: Db, kind: string, detail: unknown, nowMs = Date.now()): Promise<void> {
  const text = JSON.stringify(detail);
  console.log(JSON.stringify({ kind, ...((typeof detail === "object" && detail) || { detail }) }));
  await db.prepare("INSERT INTO event_log (at, kind, detail) VALUES (?, ?, ?)").bind(iso(nowMs), kind, text).run();
}

export async function getSettings(db: Db): Promise<Settings> {
  const r = await db.prepare("SELECT * FROM settings WHERE id = 1").first<Record<string, any>>();
  if (!r) throw new HttpError(500, "settings row missing — run the D1 migrations");
  const saved: Slot[] | null = r.schedule_json ? JSON.parse(r.schedule_json) : null;
  const effective = saved ?? DEFAULT_SCHEDULE;
  return {
    automationEnabled: r.automation_enabled === 1,
    automationEnabledAt: r.automation_enabled_at ?? null,
    scheduleSaved: saved,
    scheduleEffective: effective,
    scheduleText: formatSchedule(effective),
    scheduleIsDefault: saved === null,
    selectionPolicy: r.selection_policy,
    pendingCustom: r.pending_custom_file_id
      ? { fileId: r.pending_custom_file_id, fileName: r.pending_custom_file_name, configVersion: r.pending_custom_config_version }
      : null,
    publishingEnabled: r.publishing_enabled === 1,
    configVersion: r.config_version,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ?? null,
  };
}

export async function stateView(db: Db, nowMs: number) {
  const settings = await getSettings(db);
  const upcoming = nextOccurrences(settings.scheduleEffective, nowMs, 5).map((o) => ({ key: o.key, local: o.localLabel }));
  const runs = (await db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 10").all()).results;
  const claims = (await db.prepare("SELECT occurrence_key, kind, config_version, claimed_at, dispatch_http_status, dispatch_note, state FROM occurrence_claims ORDER BY claimed_at DESC LIMIT 10").all()).results;
  const open = (await db.prepare("SELECT * FROM publications WHERE status IN ('initiated','processing','uncertain') ORDER BY updated_at DESC LIMIT 50").all()).results;
  return {
    now: iso(nowMs),
    settings,
    nextOccurrences: settings.automationEnabled ? upcoming : [],
    nextOccurrencesIfEnabled: upcoming,
    recentRuns: runs,
    recentClaims: claims,
    openPublications: open,
  };
}

// ---------------------------------------------------------------------------
// Configuration changes (each bumps config_version, which invalidates queued/stale scheduled runs)

export async function configureManual(db: Db, req: { selectionPolicy?: "fifo" | "lifo" | null; actor?: string }, nowMs: number) {
  const policy = req.selectionPolicy ?? null;
  if (policy !== null && policy !== "fifo" && policy !== "lifo") throw new HttpError(400, "invalid selection policy");
  // Disable automation FIRST and keep the saved schedule; clear any pending custom override.
  await db
    .prepare(
      `UPDATE settings SET automation_enabled = 0, selection_policy = COALESCE(?, selection_policy),
         pending_custom_file_id = NULL, pending_custom_file_name = NULL, pending_custom_config_version = NULL,
         config_version = config_version + 1, updated_at = ?, updated_by = ? WHERE id = 1`,
    )
    .bind(policy, iso(nowMs), req.actor ?? "manual_now")
    .run();
  await log(db, "config.manual_now", { selectionPolicy: policy, actor: req.actor ?? null }, nowMs);
  return stateView(db, nowMs);
}

export async function configureAutomated(
  db: Db,
  req: {
    scheduleText?: string | null;
    selectionPolicy?: "fifo" | "lifo" | null;
    pendingCustom?: { fileId: string; fileName: string } | null;
    actor?: string;
  },
  nowMs: number,
) {
  let parsed: Slot[] | null;
  try {
    parsed = parseSchedule(req.scheduleText ?? null); // throws before anything is written
  } catch (e) {
    if (e instanceof ScheduleParseError) throw new HttpError(400, e.message);
    throw e;
  }
  const policy = req.selectionPolicy ?? null;
  if (policy !== null && policy !== "fifo" && policy !== "lifo") throw new HttpError(400, "invalid selection policy");
  const current = await getSettings(db);
  const slots = parsed ?? current.scheduleSaved ?? DEFAULT_SCHEDULE; // blank keeps the last saved schedule
  const custom = req.pendingCustom ?? null;
  if (custom && (typeof custom.fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(custom.fileId))) throw new HttpError(400, "invalid custom file id");
  const newVersion = current.configVersion + 1;
  const r = await db
    .prepare(
      `UPDATE settings SET automation_enabled = 1, automation_enabled_at = ?, schedule_json = ?,
         selection_policy = COALESCE(?, selection_policy),
         pending_custom_file_id = ?, pending_custom_file_name = ?, pending_custom_config_version = ?,
         config_version = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND config_version = ?`,
    )
    .bind(
      iso(nowMs),
      JSON.stringify(slots),
      policy,
      custom?.fileId ?? null,
      custom?.fileName ?? null,
      custom ? newVersion : null,
      newVersion,
      iso(nowMs),
      req.actor ?? "automated",
      current.configVersion,
    )
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, "configuration changed concurrently; nothing was saved — submit again");
  await log(db, "config.automated", { schedule: formatSchedule(slots), selectionPolicy: policy, pendingCustom: custom?.fileId ?? null }, nowMs);
  return stateView(db, nowMs);
}

export async function setPublishing(db: Db, enabled: boolean, actor: string | undefined, nowMs: number) {
  await db.prepare("UPDATE settings SET publishing_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1").bind(enabled ? 1 : 0, iso(nowMs), actor ?? "tools").run();
  await log(db, "config.publishing", { enabled }, nowMs);
  return stateView(db, nowMs);
}

// ---------------------------------------------------------------------------
// Cron: evaluate the saved Sarajevo schedule at event.scheduledTime, claim atomically, dispatch once.

export async function dispatchWorkflow(env: Env, inputs: Record<string, string>, fetchFn: FetchFn): Promise<{ status: number; note: string }> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "easybosnian-video-scheduler",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF, inputs }),
    });
    let note = res.status === 204 ? "accepted" : `unexpected response ${res.status} ${res.statusText}`;
    if (res.status !== 204) {
      const body = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
      note += `: ${body}`;
    }
    return { status: res.status, note };
  } catch (e) {
    return { status: 0, note: `network error: ${(e as Error).message}`.slice(0, 300) };
  }
}

export async function handleScheduled(env: Env, scheduledTime: number, fetchFn: FetchFn): Promise<{ action: string; key?: string; status?: number }> {
  const db = env.DB;
  const s = await getSettings(db);
  if (!s.automationEnabled) return { action: "automation_disabled" };
  const occ = dueOccurrence(s.scheduleEffective, scheduledTime);
  if (!occ) return { action: "not_due" };
  if (s.automationEnabledAt && occ.utcMs <= Date.parse(s.automationEnabledAt)) {
    return { action: "before_enable_time", key: occ.key }; // never publish for an occurrence at/before the config submission
  }
  const token = randomToken();
  const claim = await db
    .prepare("INSERT INTO occurrence_claims (occurrence_key, kind, config_version, claim_token_hash, claimed_at) VALUES (?, 'scheduled', ?, ?, ?) ON CONFLICT(occurrence_key) DO NOTHING")
    .bind(occ.key, s.configVersion, await sha256Hex(token), iso(Date.now()))
    .run();
  if (claim.meta.changes !== 1) {
    await log(db, "cron.duplicate_delivery", { key: occ.key });
    return { action: "duplicate", key: occ.key };
  }
  // Exactly one dispatch attempt per claimed occurrence. No automatic retry, no catch-up.
  const d = await dispatchWorkflow(env, { occurrence_key: occ.key, claim_token: token, config_version: String(s.configVersion), mode: "publish" }, fetchFn);
  const ok = d.status === 204;
  await db
    .prepare("UPDATE occurrence_claims SET dispatch_http_status = ?, dispatch_note = ?, state = CASE WHEN state = 'claimed' THEN ? ELSE state END WHERE occurrence_key = ?")
    .bind(d.status, d.note, ok ? "dispatched" : "dispatch_failed", occ.key)
    .run();
  await log(db, ok ? "cron.dispatched" : "cron.dispatch_failed", { key: occ.key, local: occ.localLabel, githubStatus: d.status, note: d.note });
  if (!ok) console.error(`DISPATCH FAILED for ${occ.key}: GitHub responded ${d.status} (${d.note})`);
  return { action: ok ? "dispatched" : "dispatch_failed", key: occ.key, status: d.status };
}

export async function dispatchTest(env: Env, fetchFn: FetchFn, nowMs: number) {
  const s = await getSettings(env.DB);
  const token = randomToken();
  const key = `test:${randomToken().slice(0, 16)}`;
  await env.DB
    .prepare("INSERT INTO occurrence_claims (occurrence_key, kind, config_version, claim_token_hash, claimed_at) VALUES (?, 'dispatch_test', ?, ?, ?)")
    .bind(key, s.configVersion, await sha256Hex(token), iso(nowMs))
    .run();
  const d = await dispatchWorkflow(env, { occurrence_key: key, claim_token: token, config_version: String(s.configVersion), mode: "dispatch_test" }, fetchFn);
  await env.DB.prepare("UPDATE occurrence_claims SET dispatch_http_status = ?, dispatch_note = ?, state = ? WHERE occurrence_key = ?").bind(d.status, d.note, d.status === 204 ? "dispatched" : "dispatch_failed", key).run();
  await log(env.DB, "dispatch_test", { key, githubStatus: d.status, note: d.note }, nowMs);
  return { occurrenceKey: key, githubStatus: d.status, note: d.note, target: `${env.GITHUB_OWNER}/${env.GITHUB_REPO} ${env.GITHUB_WORKFLOW} @ ${env.GITHUB_REF}` };
}

// ---------------------------------------------------------------------------
// Runner-facing run lifecycle

export async function beginRun(
  db: Db,
  req: { origin: string; occurrenceKey?: string; claimToken?: string; githubRunId?: string; githubRunUrl?: string },
  nowMs: number,
) {
  const s = await getSettings(db);
  const runId = `${req.origin}-${nowMs}-${randomToken().slice(0, 8)}`;
  const insertRun = (status: string, version: number, note: string | null) =>
    db
      .prepare("INSERT INTO runs (run_id, origin, occurrence_key, config_version, github_run_id, github_run_url, started_at, status, selection_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(runId, req.origin, req.occurrenceKey ?? null, version, req.githubRunId ?? null, req.githubRunUrl ?? null, iso(nowMs), status, note)
      .run();

  if (req.origin === "manual" || req.origin === "retry") {
    await insertRun("running", s.configVersion, null);
    return { allowed: true, reason: null, runId, settings: s, kind: req.origin };
  }
  if (req.origin !== "scheduled") throw new HttpError(400, "unknown origin");
  if (!req.occurrenceKey || !req.claimToken) throw new HttpError(400, "occurrence key and claim token required");

  const claim = await db.prepare("SELECT * FROM occurrence_claims WHERE occurrence_key = ?").bind(req.occurrenceKey).first<Record<string, any>>();
  if (!claim || !timingSafeEqual(claim.claim_token_hash, await sha256Hex(req.claimToken))) {
    await log(db, "run.rejected", { key: req.occurrenceKey, reason: "unknown occurrence or bad claim token" }, nowMs);
    return { allowed: false, reason: "Unknown occurrence or invalid claim token: this run was not dispatched by the scheduler.", runId: null, settings: s, kind: "invalid" };
  }
  const start = await db
    .prepare("UPDATE occurrence_claims SET state = 'started' WHERE occurrence_key = ? AND state IN ('claimed','dispatched','dispatch_failed')")
    .bind(req.occurrenceKey)
    .run();
  if (start.meta.changes !== 1) {
    return { allowed: false, reason: "This occurrence was already started by another run (duplicate).", runId: null, settings: s, kind: claim.kind };
  }
  if (claim.kind === "dispatch_test") {
    await insertRun("dispatch_test", s.configVersion, "non-publishing dispatch verification");
    return { allowed: false, reason: "Dispatch verification run: publishing is never performed in this mode.", runId, settings: s, kind: "dispatch_test" };
  }
  let reason: string | null = null;
  if (!s.automationEnabled) reason = "Automation was disabled after this occurrence was dispatched (manual_now or configuration change); nothing will be published.";
  else if (s.configVersion !== claim.config_version) reason = "The configuration changed after this occurrence was dispatched; this stale run will not publish.";
  await insertRun(reason ? "cancelled_stale" : "running", claim.config_version, reason);
  return { allowed: reason === null, reason, runId, settings: s, kind: "scheduled" };
}

/** Checked immediately before every live publication request. */
export async function mayPublish(db: Db, runId: string) {
  const run = await db.prepare("SELECT * FROM runs WHERE run_id = ?").bind(runId).first<Record<string, any>>();
  if (!run) throw new HttpError(404, "unknown run");
  const s = await getSettings(db);
  if (!s.publishingEnabled) return { allowed: false, status: "disabled", reason: "Global publishing kill switch is OFF." };
  if (run.origin === "scheduled") {
    if (!s.automationEnabled) return { allowed: false, status: "disabled", reason: "Automation was disabled during this run." };
    if (s.configVersion !== run.config_version) return { allowed: false, status: "disabled", reason: "Configuration changed during this run." };
  }
  if (run.origin === "dispatch_test") return { allowed: false, status: "disabled", reason: "Dispatch test runs never publish." };
  return { allowed: true, status: "ok", reason: null };
}

/** Atomically take the one-occurrence custom override for this scheduled run (if it belongs to the run's configuration). */
export async function consumeCustom(db: Db, runId: string) {
  const run = await db.prepare("SELECT * FROM runs WHERE run_id = ?").bind(runId).first<Record<string, any>>();
  if (!run || run.origin !== "scheduled") return { custom: null };
  const s = await getSettings(db);
  const pc = s.pendingCustom;
  if (!pc || pc.configVersion !== run.config_version) return { custom: null };
  const r = await db
    .prepare("UPDATE settings SET pending_custom_file_id = NULL, pending_custom_file_name = NULL, pending_custom_config_version = NULL WHERE id = 1 AND pending_custom_file_id = ? AND pending_custom_config_version = ?")
    .bind(pc.fileId, pc.configVersion)
    .run();
  return { custom: r.meta.changes === 1 ? { fileId: pc.fileId, fileName: pc.fileName } : null };
}

export async function finishRun(db: Db, req: { runId: string; status: string; selectedFileId?: string; selectedFileName?: string; selectionMethod?: string; selectionNote?: string }, nowMs: number) {
  await db
    .prepare("UPDATE runs SET finished_at = ?, status = ?, selected_file_id = COALESCE(?, selected_file_id), selected_file_name = COALESCE(?, selected_file_name), selection_method = COALESCE(?, selection_method), selection_note = COALESCE(?, selection_note) WHERE run_id = ?")
    .bind(iso(nowMs), req.status, req.selectedFileId ?? null, req.selectedFileName ?? null, req.selectionMethod ?? null, req.selectionNote ?? null, req.runId)
    .run();
  const run = await db.prepare("SELECT occurrence_key FROM runs WHERE run_id = ?").bind(req.runId).first<Record<string, any>>();
  if (run?.occurrence_key) await db.prepare("UPDATE occurrence_claims SET state = 'finished' WHERE occurrence_key = ?").bind(run.occurrence_key).run();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Videos / publication history

export async function listVideos(db: Db) {
  return (await db.prepare("SELECT * FROM videos").all()).results;
}

const SOURCE_RANK: Record<string, number> = { created_time_approximation: 0, observed: 1, drive_activity: 2 };

export async function observeVideos(db: Db, items: { fileId: string; name: string; enteredFolderAt: string | null; entrySource: string }[], nowMs: number) {
  for (const it of items) {
    if (!(it.entrySource in SOURCE_RANK)) throw new HttpError(400, "invalid entry source");
    const cur = await db.prepare("SELECT * FROM videos WHERE file_id = ?").bind(it.fileId).first<Record<string, any>>();
    if (!cur) {
      await db.prepare("INSERT INTO videos (file_id, last_known_name, entered_folder_at, entry_source, first_observed_at) VALUES (?, ?, ?, ?, ?)").bind(it.fileId, it.name, it.enteredFolderAt, it.entrySource, iso(nowMs)).run();
      continue;
    }
    const better = (SOURCE_RANK[it.entrySource] ?? -1) > (SOURCE_RANK[cur.entry_source] ?? -1);
    const newerActivity = it.entrySource === "drive_activity" && cur.entry_source === "drive_activity" && it.enteredFolderAt && it.enteredFolderAt > cur.entered_folder_at;
    if (better || newerActivity) {
      await db.prepare("UPDATE videos SET entered_folder_at = ?, entry_source = ?, last_known_name = ? WHERE file_id = ?").bind(it.enteredFolderAt, it.entrySource, it.name, it.fileId).run();
    } else {
      await db.prepare("UPDATE videos SET last_known_name = ? WHERE file_id = ?").bind(it.name, it.fileId).run();
    }
  }
  return { ok: true, count: items.length };
}

export async function consumeVideo(db: Db, req: { fileId: string; runId: string; md5: string | null }, nowMs: number) {
  await db.prepare("UPDATE videos SET consumed = 1, consumed_at = COALESCE(consumed_at, ?), consumed_run_id = COALESCE(consumed_run_id, ?), md5_at_publication = COALESCE(?, md5_at_publication) WHERE file_id = ?").bind(iso(nowMs), req.runId, req.md5, req.fileId).run();
  return { ok: true };
}

const STATUSES = new Set(["initiated", "processing", "confirmed", "failed", "uncertain", "unsupported", "disabled"]);

export async function upsertPublication(
  db: Db,
  p: { runId: string; fileId: string; platform: string; surface: string; provider?: string; format?: string; status: string; remoteId?: string | null; url?: string | null; detail?: string | null },
  nowMs: number,
) {
  if (!STATUSES.has(p.status)) throw new HttpError(400, "invalid status");
  await db
    .prepare(
      `INSERT INTO publications (run_id, file_id, platform, surface, provider, format, status, remote_id, url, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, platform, surface) DO UPDATE SET status = excluded.status,
         provider = COALESCE(excluded.provider, provider), format = COALESCE(excluded.format, format),
         remote_id = COALESCE(excluded.remote_id, remote_id), url = COALESCE(excluded.url, url),
         detail = COALESCE(excluded.detail, detail), updated_at = excluded.updated_at`,
    )
    .bind(p.runId, p.fileId, p.platform, p.surface, p.provider ?? null, p.format ?? null, p.status, p.remoteId ?? null, p.url ?? null, p.detail ?? null, iso(nowMs), iso(nowMs))
    .run();
  return { ok: true };
}

export async function publicationsFor(db: Db, q: { runId?: string; fileId?: string; open?: boolean; id?: number }) {
  if (q.id !== undefined) return (await db.prepare("SELECT * FROM publications WHERE id = ?").bind(q.id).all()).results;
  if (q.runId) return (await db.prepare("SELECT * FROM publications WHERE run_id = ? ORDER BY id").bind(q.runId).all()).results;
  if (q.fileId) return (await db.prepare("SELECT * FROM publications WHERE file_id = ? ORDER BY id").bind(q.fileId).all()).results;
  if (q.open) return (await db.prepare("SELECT * FROM publications WHERE status IN ('initiated','processing','uncertain') ORDER BY id").all()).results;
  return [];
}

export async function getCredential(db: Db, name: string) {
  return db.prepare("SELECT name, ciphertext, updated_at FROM credentials WHERE name = ?").bind(name).first();
}
export async function putCredential(db: Db, name: string, ciphertext: string, nowMs: number) {
  if (!/^[a-z0-9_]{1,64}$/.test(name) || ciphertext.length > 20000) throw new HttpError(400, "invalid credential");
  await db.prepare("INSERT INTO credentials (name, ciphertext, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at").bind(name, ciphertext, iso(nowMs)).run();
  return { ok: true };
}
