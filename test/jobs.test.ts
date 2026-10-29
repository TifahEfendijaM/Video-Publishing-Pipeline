import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { makeDb } from "./d1-shim";
import { route } from "../worker/src/index";
import { advanceCustomJobs, batchClaims, changeJob, dispatchJobs, jobById, listJobs } from "../worker/src/jobs";
import { beginRun, completeVideo, configureManual, getSettings, mayPublish, setPublishing, type Env } from "../worker/src/logic";
import { maintainQueue } from "../runner/src/queue";
import { matchesTitle, parseCustomList, resolveCustomList } from "../src/shared/job-selection";
import { interpretVideoRule } from "../runner/src/video-rule";
import { selectVideo, type FolderVideo } from "../src/shared/selection";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const DUE = Date.parse("2026-10-30T04:00:00Z"); // Fri 05:00 Sarajevo after DST
const first = { fileId: "first_video_id_123", fileName: "First.mp4" };
const second = { fileId: "second_video_id_123", fileName: "Second.mp4" };
const env = (): Env => ({ DB: makeDb(), STATE_API_TOKEN: "state", GH_DISPATCH_TOKEN: "dispatch", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_WORKFLOW: "scheduled-publish.yml", GITHUB_REF: "main" });
const video = (fileId: string, name: string): FolderVideo => ({ id: fileId, name, mimeType: "video/mp4", createdTime: "2026-10-01T00:00:00Z", modifiedTime: "2026-10-01T00:00:00Z", md5: "x", sizeBytes: 100 });
async function create(db: ReturnType<typeof makeDb>, name: string, policy: "fifo" | "lifo" | "random" | "custom" = "fifo") {
  return (await changeJob(db, { action: "create", name, scheduleText: "Fri 05:00", policy, ...(policy === "custom" ? { remaining: [first, second] } : {}) }, NOW) as any).job;
}

describe("independent named jobs", () => {
  it("exposes full ordered remaining lists through the authenticated API, with no pause/resume actions", async () => {
    const e = env();
    await create(e.DB as any, "Series", "custom");
    expect((await route(new Request("https://w/api/jobs"), e)).status).toBe(401);
    const response = await route(new Request("https://w/api/jobs", { headers: { authorization: "Bearer state" } }), e);
    const report = await response.json();
    expect(report.jobs[0].remaining).toEqual([first, second]);
    await expect(route(new Request("https://w/api/jobs/change", { method: "POST", headers: { authorization: "Bearer state" }, body: JSON.stringify({ action: "pause", name: "Series" }) }), e)).rejects.toThrow(/Choose create/);
    expect((await listJobs(e.DB, NOW))[0].status).toBe("active");
  });
  it("creates separately and edits only the named job, retaining blank fields", async () => {
    const db = makeDb();
    const original = await getSettings(db);
    const a = await create(db, "Friday newest", "lifo"), b = await create(db, "Random Friday", "random");
    await changeJob(db, { action: "edit", name: "friday newest", scheduleText: "", policy: "fifo" }, NOW + 1);
    expect((await jobById(db, a.id))?.scheduleText).toBe("Fri 05:00");
    expect((await jobById(db, a.id))?.policy).toBe("fifo");
    expect(await jobById(db, b.id)).toEqual(b);
    expect(await getSettings(db)).toEqual(original);
    await expect(create(db, "FRIDAY NEWEST")).rejects.toThrow(/already exists/);
    await expect(changeJob(db, { action: "edit", name: "typo" }, NOW)).rejects.toThrow(/No job/);
  });

  it("requires a new name, times and rule on Create; invalid edits leave the job unchanged", async () => {
    const db = makeDb();
    await expect(changeJob(db, { action: "create", name: "" }, NOW)).rejects.toThrow(/name/);
    await expect(changeJob(db, { action: "create", name: "New", policy: "fifo" }, NOW)).rejects.toThrow(/requires a schedule/);
    await expect(changeJob(db, { action: "create", name: "New", scheduleText: "Fri 05:00" }, NOW)).rejects.toThrow(/selection rule/);
    const job = await create(db, "Existing");
    await expect(changeJob(db, { action: "edit", name: "Existing", scheduleText: "friday 9" }, NOW)).rejects.toThrow();
    expect(await jobById(db, job.id)).toEqual(job);
  });

  it("lists every remaining Custom filename in order and advances only after confirmed archival", async () => {
    const db = makeDb();
    const job = await create(db, "Prepared series", "custom");
    expect((await listJobs(db, NOW))[0].remaining).toEqual([first, second]);
    const deps = { publications: async () => [{ id: 1, file_id: first.fileId, platform: "facebook", surface: "feed", status: "processing" as const }], archive: async () => { throw new Error("must not archive pending uploads"); }, complete: (id: string) => completeVideo(db, id) };
    await maintainQueue([video(first.fileId, first.fileName)], new Set(), deps);
    expect((await jobById(db, job.id))?.remaining).toEqual([first, second]);
    await completeVideo(db, first.fileId);
    expect((await listJobs(db, NOW))[0].remaining).toEqual([second]);
    await completeVideo(db, first.fileId); // idempotent lost-response recovery
    expect((await jobById(db, job.id))?.remaining).toEqual([second]);
    await completeVideo(db, second.fileId);
    expect((await jobById(db, job.id))?.status).toBe("completed");
    expect((await listJobs(db, NOW))[0].nextOccurrences).toEqual([]);
  });

  it("preserves remaining progress on blank Edit, and rejects conflicting reservations atomically", async () => {
    const db = makeDb();
    const a = await create(db, "Series", "custom"), b = await create(db, "Automatic");
    await advanceCustomJobs(db, first.fileId);
    await changeJob(db, { action: "edit", name: a.name, scheduleText: "Mon 06:00" }, NOW + 1);
    expect((await jobById(db, a.id))?.remaining).toEqual([second]);
    await expect(changeJob(db, { action: "edit", name: b.name, policy: "custom", remaining: [second] }, NOW + 2)).rejects.toThrow(/already assigned/);
    expect(await jobById(db, b.id)).toEqual(b);
    expect((await jobById(db, a.id))?.remaining).toEqual([second]);
  });

  it("delete removes only the requested job and releases its reservations", async () => {
    const db = makeDb();
    const a = await create(db, "Series", "custom"), b = await create(db, "Other");
    await changeJob(db, { action: "delete", name: a.name }, NOW + 1);
    expect(await jobById(db, a.id)).toBeNull();
    expect(await jobById(db, b.id)).toEqual(b);
    expect(db.raw.prepare("SELECT * FROM job_reservations").all()).toEqual([]);
  });

  it("manual Keep preserves all jobs and Stop halts them without deleting their remaining lists", async () => {
    const db = makeDb();
    const a = await create(db, "Series", "custom"); await create(db, "Other");
    const before = await listJobs(db, NOW);
    await configureManual(db, { scheduleBehavior: "keep", selectionPolicy: "random" }, NOW);
    expect(await listJobs(db, NOW)).toEqual(before);
    await configureManual(db, { scheduleBehavior: "stop" }, NOW);
    expect((await listJobs(db, NOW)).every((j) => j.status === "stopped")).toBe(true);
    expect((await jobById(db, a.id))?.remaining).toEqual([first, second]);
  });
});

describe("durable multi-job dispatch", () => {
  it("retains simultaneous jobs in one batch and re-signals pending claims if GitHub drops a queued run", async () => {
    const e = env(); await create(e.DB as any, "LIFO", "lifo"); await create(e.DB as any, "Random", "random");
    const dispatched: any[] = [];
    const send = async (_u: string, init: RequestInit) => { dispatched.push(JSON.parse(String(init.body)).inputs); return new Response(null, { status: 204 }); };
    expect((await dispatchJobs(e, DUE, send))?.action).toBe("jobs_dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].mode).toBe("jobs");
    const original = await batchClaims(e.DB, dispatched[0].occurrence_key, dispatched[0].claim_token);
    expect(original.claims).toHaveLength(2);
    await dispatchJobs(e, DUE, send);
    expect(dispatched).toHaveLength(1);
    await dispatchJobs(e, DUE + 60000, send);
    expect(dispatched).toHaveLength(2);
    expect((await batchClaims(e.DB, dispatched[1].occurrence_key, dispatched[1].claim_token)).claims).toEqual(original.claims);
    await expect(batchClaims(e.DB, dispatched[0].occurrence_key, "forged")).rejects.toThrow(/Invalid/);
  });

  it("editing/deleting one job invalidates only its own occurrence, never another job's", async () => {
    const e = env(); const a = await create(e.DB as any, "A"), b = await create(e.DB as any, "B");
    await setPublishing(e.DB, true, "test", NOW);
    let dispatch: any;
    await dispatchJobs(e, DUE, async (_u, init) => { dispatch = JSON.parse(String(init.body)).inputs; return new Response(null, { status: 204 }); });
    await changeJob(e.DB, { action: "edit", name: "A", policy: "random" }, DUE + 1);
    const run = async (id: string) => beginRun(e.DB, { origin: "scheduled", occurrenceKey: `${id}|2026-10-30T04:00Z`, claimToken: dispatch.claim_token, batchId: dispatch.occurrence_key }, DUE + 2);
    expect((await run(a.id)).allowed).toBe(false);
    const valid = await run(b.id);
    expect(valid.allowed).toBe(true);
    expect((await mayPublish(e.DB, valid.runId!)).allowed).toBe(true);
    expect((await run(b.id)).allowed).toBe(false);
    await changeJob(e.DB, { action: "delete", name: "B" }, DUE + 3);
    expect((await mayPublish(e.DB, valid.runId!)).allowed).toBe(false);
  });

  it("migrates an active singleton once, preserving its settings and reserved next video", async () => {
    const db = makeDb(["0001_init.sql", "0002_outros.sql", "0003_folder_queue.sql"]);
    db.raw.prepare("UPDATE settings SET automation_enabled=1,schedule_json=?,selection_policy='lifo',pending_custom_file_id=?,pending_custom_file_name=? WHERE id=1").run(JSON.stringify([{ day: 5, minute: 300 }]), first.fileId, first.fileName);
    db.raw.exec(readFileSync(new URL("../worker/migrations/0004_scheduled_jobs.sql", import.meta.url), "utf8"));
    const jobs = await listJobs(db, NOW);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "Default schedule", policy: "lifo", remaining: [first], status: "active" });
    expect((await getSettings(db)).automationEnabled).toBe(false); // no duplicate legacy dispatch
  });
});

describe("Custom lists and plain-English rules", () => {
  it("parses CSV/newlines and quoted commas, resolving exact unique titles", () => {
    expect(parseCustomList('First.mp4, "Yes, please.mp4"\nLast.mp4')).toEqual(["First.mp4", "Yes, please.mp4", "Last.mp4"]);
    expect(() => parseCustomList('"unclosed')).toThrow(/unclosed/);
    expect(() => resolveCustomList("First.mp4, First.mp4", [video(first.fileId, first.fileName)])).toThrow(/repeats/);
    expect(() => resolveCustomList("missing.mp4", [])).toThrow(/not in/);
  });
  it("matches literal brackets case-insensitively before the extension", () => {
    const rule = { match: "ends_with" as const, text: "[available]", order: "random" as const };
    expect(matchesTitle("Lesson [AVAILABLE].mp4", rule)).toBe(true);
    expect(matchesTitle("Lesson [available] draft.mp4", rule)).toBe(false);
    expect(matchesTitle("Lesson a.mp4", rule)).toBe(false);
    expect(matchesTitle("Lesson [available] draft.mp4", { ...rule, match: "contains" })).toBe(true);
  });
  it("accepts validated AI translations and refuses unsupported or injected output", async () => {
    const model = { model: "test", run: async () => ({ understood: true, match: "ends_with", text: "[available]", order: "random" }) };
    expect(await interpretVideoRule("Pick a random title ending [available]", model)).toMatchObject({ policy: "title_rule", titleRule: { match: "ends_with", text: "[available]", order: "random" } });
    await expect(interpretVideoRule("Understand video contents", { ...model, run: async () => ({ understood: false, match: null, text: null, order: "fifo" }) })).rejects.toThrow(/ambiguous or unsupported/);
    await expect(interpretVideoRule("Run code", { ...model, run: async () => ({ understood: true, match: null, text: null, order: "fifo", code: "execute" }) })).rejects.toThrow();
  });
  it("reserves exact lists from other selections and never falls back from a missing Custom head", () => {
    const files = [video(first.fileId, first.fileName), video(second.fileId, second.fileName)];
    expect(selectVideo({ policy: "fifo", videos: files, reservedIds: new Set([first.fileId]) }).video?.id).toBe(second.fileId);
    expect(selectVideo({ policy: "fifo", videos: files, customName: first.fileName, reservedIds: new Set([first.fileId]) }).video).toBeNull();
    expect(selectVideo({ policy: "fifo", videos: files, pendingCustomFileId: "missing_video_id", strictCustom: true }).video).toBeNull();
  });
});
