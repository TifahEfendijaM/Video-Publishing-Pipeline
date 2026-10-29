import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeDb } from "./d1-shim";
import {
  beginRun,
  finishRun,
  configureAutomated,
  configureManual,
  consumeCustom,
  dispatchTest,
  getSettings,
  handleScheduled,
  mayPublish,
  upsertPublication,
  publicationsFor,
  setPublishing,
  setOutros,
  type Env,
} from "../worker/src/logic";
import { route } from "../worker/src/index";

const T = (s: string) => Date.parse(s);
const NOW = T("2026-10-06T19:00:00Z"); // Tuesday

describe("source cleanup checkpoint completion", () => {
  it("clears only the removed source's temporary state, idempotently, through the authenticated API", async () => {
    const e = env();
    for (const fileId of ["file1", "file2"]) {
      await upsertPublication(e.DB, { runId: fileId, fileId, platform: "facebook", surface: "feed", status: "confirmed" }, NOW);
    }
    const run = await beginRun(e.DB, { origin: "manual" }, NOW);
    await finishRun(e.DB, { runId: run.runId!, status: "completed", selectedFileId: "file1", selectedFileName: "lesson.mp4" }, NOW);
    const request = (authorized: boolean) => new Request("https://state.test/api/videos/complete", { method: "POST", headers: { "content-type": "application/json", authorization: authorized ? `Bearer ${e.STATE_API_TOKEN}` : "" }, body: JSON.stringify({ fileId: "file1" }) });
    expect((await route(request(false), e)).status).toBe(401);
    expect((await publicationsFor(e.DB, { fileId: "file1" }))).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await route(request(true), e)).status).toBe(200);
    expect(await publicationsFor(e.DB, { fileId: "file1" })).toEqual([]);
    expect(e.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'videos'").get()).toBeUndefined();
    expect(await publicationsFor(e.DB, { fileId: "file2" })).toHaveLength(1);
    expect(e.DB.raw.prepare("SELECT selected_file_id, selected_file_name, status FROM runs WHERE run_id = ?").get(run.runId!)).toMatchObject({ selected_file_id: null, selected_file_name: null, status: "completed" });
    const response = await route(new Request("https://state.test/api/publications/files", { headers: { authorization: `Bearer ${e.STATE_API_TOKEN}` } }), e);
    expect(await response.json()).toEqual({ fileIds: ["file2"] });
  });
});

function env() {
  return {
    DB: makeDb(),
    STATE_API_TOKEN: "state-secret-123456",
    GH_DISPATCH_TOKEN: "gh-dispatch-secret",
    GITHUB_OWNER: "TifahEfendijaM",
    GITHUB_REPO: "Video-Publishing-Pipeline",
    GITHUB_WORKFLOW: "scheduled-publish.yml",
    GITHUB_REF: "main",
  } satisfies Env;
}

function fakeGitHub(status = 204) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(status === 204 ? null : "boom", { status });
  });
  return { fetchFn, calls };
}

describe("configuration", () => {
  it("initial state: automation off, publishing off, default Friday 05:00, FIFO", async () => {
    const e = env();
    const s = await getSettings(e.DB);
    expect(s.automationEnabled).toBe(false);
    expect(s.publishingEnabled).toBe(false);
    expect(s.scheduleText).toBe("Fri 05:00");
    expect(s.scheduleIsDefault).toBe(true);
    expect(s.selectionPolicy).toBe("fifo");
  });

  it("automated with blank schedule and never-saved schedule uses Friday 05:00, enables, does not dispatch", async () => {
    const e = env();
    const v = await configureAutomated(e.DB, { scheduleText: "" }, NOW);
    expect(v.settings.automationEnabled).toBe(true);
    expect(v.settings.scheduleText).toBe("Fri 05:00");
    expect(v.nextOccurrences[0].key).toBe("2026-10-09T03:00Z");
  });

  it("blank schedule retains the previously saved schedule", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "tuesday-5pm monday-6am friday 9-pm" }, NOW);
    const v = await configureAutomated(e.DB, { scheduleText: "  " }, NOW + 1000);
    expect(v.settings.scheduleText).toBe("Mon 06:00; Tue 17:00; Fri 21:00");
  });

  it("invalid schedule leaves the previous configuration untouched", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "mon 6am", selectionPolicy: "lifo" }, NOW);
    const before = await getSettings(e.DB);
    await expect(configureAutomated(e.DB, { scheduleText: "friday 9", selectionPolicy: "fifo" }, NOW + 1)).rejects.toThrow(/ambiguous/);
    expect(await getSettings(e.DB)).toEqual(before);
  });

  it("fifo/lifo persists; custom does not reset it; newer config replaces pending custom", async () => {
    const e = env();
    await configureAutomated(e.DB, { selectionPolicy: "lifo" }, NOW);
    await configureAutomated(e.DB, { selectionPolicy: null, pendingCustom: { fileId: "1Edf0K75AQEhJOLWsWYYY61C96B_HrojG", fileName: "x.mp4" } }, NOW + 1);
    let s = await getSettings(e.DB);
    expect(s.selectionPolicy).toBe("lifo");
    expect(s.pendingCustom?.fileId).toBe("1Edf0K75AQEhJOLWsWYYY61C96B_HrojG");
    await configureAutomated(e.DB, { selectionPolicy: "fifo" }, NOW + 2);
    s = await getSettings(e.DB);
    expect(s.pendingCustom).toBeNull();
    expect(s.selectionPolicy).toBe("fifo");
  });

  it("manual_now disables automation, keeps the saved schedule and clears pending custom", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "wed 7pm", pendingCustom: { fileId: "1Edf0K75AQEhJOLWsWYYY61C96B_HrojG", fileName: "x.mp4" } }, NOW);
    const v = await configureManual(e.DB, { selectionPolicy: "lifo" }, NOW + 1);
    expect(v.settings.automationEnabled).toBe(false);
    expect(v.settings.scheduleText).toBe("Wed 19:00");
    expect(v.settings.pendingCustom).toBeNull();
    expect(v.settings.selectionPolicy).toBe("lifo");
    expect(v.nextOccurrences).toEqual([]); // nothing planned
  });

  it("keep_schedule preserves every saved setting, including policy, pending custom, version and next occurrences", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "wed 19:00; fri 05:00", selectionPolicy: "random", pendingCustom: { fileId: "custom_video_id_123", fileName: "next.mp4" } }, NOW);
    await setPublishing(e.DB, true, "test", NOW);
    await setOutros(e.DB, { youtube: { fileId: "outro_video_id_123", fileName: "outro.mp4" } }, "test", NOW);
    const before = await getSettings(e.DB);
    const initial = await configureManual(e.DB, { scheduleBehavior: "keep", selectionPolicy: "fifo", actor: "manual" }, NOW + 1);
    expect(await getSettings(e.DB)).toEqual(before);
    expect(initial.manualScheduleBehavior).toBe("keep");
    expect(initial.settings.selectionPolicy).toBe("random");
    expect(initial.nextOccurrences.length).toBeGreaterThan(0);
    const later = await configureManual(e.DB, { scheduleBehavior: "keep", selectionPolicy: null }, NOW + 2);
    expect(later.nextOccurrences).toEqual(initial.nextOccurrences);
    expect(await getSettings(e.DB)).toEqual(before);
  });

  it("keeping an inactive schedule does not enable automation", async () => {
    const e = env();
    const before = await getSettings(e.DB);
    const result = await configureManual(e.DB, { scheduleBehavior: "keep", selectionPolicy: "random" }, NOW);
    expect(result.settings).toEqual(before);
    expect(result.nextOccurrences).toEqual([]);
  });

  it("explicit stop_schedule disables automation and cancels the custom override, retaining timetable and automatic policy", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "wed 19:00", selectionPolicy: "lifo", pendingCustom: { fileId: "custom_video_id_123", fileName: "next.mp4" } }, NOW);
    const before = await getSettings(e.DB);
    const result = await configureManual(e.DB, { scheduleBehavior: "stop", selectionPolicy: "random" }, NOW + 1);
    expect(result.settings.automationEnabled).toBe(false);
    expect(result.settings.scheduleText).toBe(before.scheduleText);
    expect(result.settings.selectionPolicy).toBe("lifo");
    expect(result.settings.pendingCustom).toBeNull();
    expect(result.settings.configVersion).toBe(before.configVersion + 1);
    expect(result.manualScheduleBehavior).toBe("stop");
  });

  it("rejects unknown manual schedule behavior without changing settings", async () => {
    const e = env();
    const before = await getSettings(e.DB);
    await expect(configureManual(e.DB, { scheduleBehavior: "replace" as any }, NOW)).rejects.toThrow(/invalid manual schedule behavior/);
    expect(await getSettings(e.DB)).toEqual(before);
  });

  it("submitting automated repeatedly does not create duplicate schedulers (one settings row, one claim per occurrence)", async () => {
    const e = env();
    await configureAutomated(e.DB, {}, NOW);
    await configureAutomated(e.DB, {}, NOW + 1);
    await configureAutomated(e.DB, {}, NOW + 2);
    const gh = fakeGitHub();
    await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    expect(gh.calls).toHaveLength(1);
    expect(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 1 });
  });
});

describe("cron dispatch", () => {
  it("does nothing when automation is disabled or not due", async () => {
    const e = env();
    const gh = fakeGitHub();
    expect((await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn)).action).toBe("automation_disabled");
    await configureAutomated(e.DB, {}, NOW);
    expect((await handleScheduled(e, T("2026-10-09T03:01:00Z"), gh.fetchFn)).action).toBe("not_due");
    expect(gh.calls).toHaveLength(0);
  });

  it("dispatches exactly the configured repo/workflow/branch with the dedicated token", async () => {
    const e = env();
    await configureAutomated(e.DB, {}, NOW);
    const gh = fakeGitHub();
    const r = await handleScheduled(e, T("2026-10-09T03:00:20Z"), gh.fetchFn);
    expect(r).toMatchObject({ action: "dispatched", key: "2026-10-09T03:00Z", status: 204 });
    expect(gh.calls[0].url).toBe("https://api.github.com/repos/TifahEfendijaM/Video-Publishing-Pipeline/actions/workflows/scheduled-publish.yml/dispatches");
    expect(gh.calls[0].body.ref).toBe("main");
    expect(gh.calls[0].body.inputs.occurrence_key).toBe("2026-10-09T03:00Z");
    expect(gh.calls[0].headers.Authorization).toBe("Bearer gh-dispatch-secret");
  });

  it("deduplicates repeated cron deliveries of the same occurrence", async () => {
    const e = env();
    await configureAutomated(e.DB, {}, NOW);
    const gh = fakeGitHub();
    const a = await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    const b = await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    const [c, d] = await Promise.all([
      handleScheduled(e, T("2026-10-09T03:00:30Z"), gh.fetchFn),
      handleScheduled(e, T("2026-10-09T03:00:45Z"), gh.fetchFn),
    ]);
    expect([a.action, b.action, c.action, d.action]).toEqual(["dispatched", "duplicate", "duplicate", "duplicate"]);
    expect(gh.calls).toHaveLength(1);
  });

  it("records a non-204 response visibly and does not retry or catch up", async () => {
    const e = env();
    await configureAutomated(e.DB, {}, NOW);
    const gh = fakeGitHub(422);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    expect(r).toMatchObject({ action: "dispatch_failed", status: 422 });
    expect(err).toHaveBeenCalled();
    const claim = e.DB.raw.prepare("SELECT * FROM occurrence_claims").get() as any;
    expect(claim.dispatch_http_status).toBe(422);
    expect(claim.state).toBe("dispatch_failed");
    await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn); // redelivery: still no retry
    await handleScheduled(e, T("2026-10-09T03:05:00Z"), gh.fetchFn); // later minute: no catch-up
    expect(gh.calls).toHaveLength(1);
    err.mockRestore();
  });

  it("does not publish for an occurrence at or before the configuration time (no immediate publish)", async () => {
    const e = env();
    await configureAutomated(e.DB, {}, T("2026-10-09T03:00:10Z"));
    const gh = fakeGitHub();
    expect((await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn)).action).toBe("before_enable_time");
    expect((await handleScheduled(e, T("2026-10-16T03:00:00Z"), gh.fetchFn)).action).toBe("dispatched");
  });
});

describe("scheduled run validation (stale / cancelled / duplicate)", () => {
  async function dispatched() {
    const e = env();
    await configureAutomated(e.DB, {}, NOW);
    const gh = fakeGitHub();
    await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    return { e, inputs: gh.calls[0].body.inputs };
  }

  it("valid run is allowed once; a second run for the same occurrence is rejected", async () => {
    const { e, inputs } = await dispatched();
    const r1 = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW);
    expect(r1.allowed).toBe(true);
    const r2 = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toMatch(/already started/);
  });

  it("forged token or manual run of the scheduled workflow is rejected", async () => {
    const { e, inputs } = await dispatched();
    const r = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: "nope" }, NOW);
    expect(r.allowed).toBe(false);
  });

  it("queued run after manual_now does not publish", async () => {
    const { e, inputs } = await dispatched();
    await configureManual(e.DB, {}, NOW + 5);
    const r = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW + 10);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Automation was disabled/);
  });

  it("a queued scheduled occurrence and its pending custom choice survive a keep_schedule manual upload", async () => {
    const e = env();
    await configureAutomated(e.DB, { pendingCustom: { fileId: "custom_video_id_123", fileName: "next.mp4" } }, NOW);
    await setPublishing(e.DB, true, "test", NOW);
    const gh = fakeGitHub();
    await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    const inputs = gh.calls[0].body.inputs;
    const before = await getSettings(e.DB);
    await configureManual(e.DB, { scheduleBehavior: "keep", selectionPolicy: "random" }, NOW + 5);
    expect(await getSettings(e.DB)).toEqual(before);
    const scheduled = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW + 10);
    expect(scheduled.allowed).toBe(true);
    expect((await mayPublish(e.DB, scheduled.runId!)).allowed).toBe(true);
    const manual = await beginRun(e.DB, { origin: "manual" }, NOW + 11);
    expect((await consumeCustom(e.DB, manual.runId!)).custom).toBeNull();
    await configureManual(e.DB, { scheduleBehavior: "keep", selectionPolicy: "fifo" }, NOW + 12);
    expect((await mayPublish(e.DB, scheduled.runId!)).allowed).toBe(true);
    expect((await consumeCustom(e.DB, scheduled.runId!)).custom).toEqual({ fileId: "custom_video_id_123", fileName: "next.mp4" });
  });

  it("queued run after a configuration update does not publish under the cancelled settings", async () => {
    const { e, inputs } = await dispatched();
    await configureAutomated(e.DB, { scheduleText: "sat 9am" }, NOW + 5);
    const r = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW + 10);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/configuration changed/);
  });

  it("change during a run is caught by the pre-publication check; kill switch too", async () => {
    const { e, inputs } = await dispatched();
    await setPublishing(e.DB, true, "test", NOW);
    // setPublishing does not bump config_version, so the claimed run is still valid
    const r = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: inputs.occurrence_key, claimToken: inputs.claim_token }, NOW);
    expect(r.allowed).toBe(true);
    expect((await mayPublish(e.DB, r.runId!)).allowed).toBe(true);
    await setPublishing(e.DB, false, "test", NOW);
    expect(await mayPublish(e.DB, r.runId!)).toMatchObject({ allowed: false, status: "disabled" });
    await setPublishing(e.DB, true, "test", NOW);
    await configureManual(e.DB, {}, NOW + 1);
    expect((await mayPublish(e.DB, r.runId!)).allowed).toBe(false);
  });

  it("custom override lasts exactly one occurrence", async () => {
    const e = env();
    await configureAutomated(e.DB, { pendingCustom: { fileId: "1Edf0K75AQEhJOLWsWYYY61C96B_HrojG", fileName: "x.mp4" } }, NOW);
    const gh = fakeGitHub();
    await handleScheduled(e, T("2026-10-09T03:00:00Z"), gh.fetchFn);
    const in1 = gh.calls[0].body.inputs;
    const r1 = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: in1.occurrence_key, claimToken: in1.claim_token }, NOW);
    expect((await consumeCustom(e.DB, r1.runId!)).custom?.fileId).toBe("1Edf0K75AQEhJOLWsWYYY61C96B_HrojG");
    expect((await consumeCustom(e.DB, r1.runId!)).custom).toBeNull();
    await handleScheduled(e, T("2026-10-16T03:00:00Z"), gh.fetchFn);
    const in2 = gh.calls[1].body.inputs;
    const r2 = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: in2.occurrence_key, claimToken: in2.claim_token }, NOW);
    expect(r2.allowed).toBe(true);
    expect((await consumeCustom(e.DB, r2.runId!)).custom).toBeNull();
    expect((await getSettings(e.DB)).selectionPolicy).toBe("fifo");
  });

  it("dispatch test never publishes", async () => {
    const e = env();
    const gh = fakeGitHub();
    const d = await dispatchTest(e, gh.fetchFn, NOW);
    expect(d.githubStatus).toBe(204);
    expect(gh.calls[0].body.inputs.mode).toBe("dispatch_test");
    const r = await beginRun(e.DB, { origin: "scheduled", occurrenceKey: d.occurrenceKey, claimToken: gh.calls[0].body.inputs.claim_token }, NOW);
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe("dispatch_test");
    await setPublishing(e.DB, true, "t", NOW);
    expect((await mayPublish(e.DB, r.runId!)).allowed).toBe(false);
  });
});

describe("HTTP API", () => {
  it("requires an explicit Keep/Stop on the new route while preserving the legacy manual API", async () => {
    const e = env();
    await configureAutomated(e.DB, { scheduleText: "fri 05:00", selectionPolicy: "lifo" }, NOW);
    const before = await getSettings(e.DB);
    const request = (path: string, body: object) => new Request(`https://w${path}`, { method: "POST", headers: { authorization: `Bearer ${e.STATE_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(route(request("/api/config/manual-choice", { selectionPolicy: "random" }), e)).rejects.toThrow(/manual schedule choice required/);
    expect(await getSettings(e.DB)).toEqual(before);
    const keep = await route(request("/api/config/manual-choice", { scheduleBehavior: "keep", selectionPolicy: "random" }), e);
    expect(keep.status).toBe(200);
    expect((await keep.json()).manualScheduleBehavior).toBe("keep");
    expect(await getSettings(e.DB)).toEqual(before);
    await route(request("/api/config/manual", { selectionPolicy: "fifo" }), e);
    expect((await getSettings(e.DB)).automationEnabled).toBe(false);
  });

  it("requires the bearer token and validates config", async () => {
    const e = env();
    const unauth = await route(new Request("https://w/api/state"), e);
    expect(unauth.status).toBe(401);
    const health = await route(new Request("https://w/health"), e);
    expect(health.status).toBe(200);
    const bad = await route(
      new Request("https://w/api/config/automated", { method: "POST", headers: { authorization: "Bearer state-secret-123456" }, body: JSON.stringify({ scheduleText: "fri 9" }) }),
      e,
    ).catch((x) => x);
    expect(bad.status).toBe(410);
  });
});

describe("temporary media hosting (Workers KV)", () => {
  function kvEnv() {
    const store = new Map<string, { value: ArrayBuffer; metadata: unknown; ttl?: number }>();
    const MEDIA = {
      async put(k: string, v: ArrayBuffer, o?: { expirationTtl?: number; metadata?: unknown }) {
        store.set(k, { value: v, metadata: o?.metadata ?? null, ttl: o?.expirationTtl });
      },
      async getWithMetadata(k: string) {
        const e = store.get(k);
        return { value: e?.value ?? null, metadata: (e?.metadata as any) ?? null };
      },
      async delete(k: string) {
        store.delete(k);
      },
    };
    return { e: { ...env(), MEDIA, MEDIA_TTL_SECONDS: "21600" }, store };
  }
  const auth = { authorization: "Bearer state-secret-123456" };
  const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

  it("requires auth to upload, serves by unguessable key, supports ranges, expires and deletes", async () => {
    const { e, store } = kvEnv();
    const unauth = await route(new Request("https://w/api/media", { method: "POST", body: bytes, headers: { "content-length": "1000" } }), e);
    expect(unauth.status).toBe(401);
    const up = await route(new Request("https://w/api/media", { method: "POST", body: bytes, headers: { ...auth, "content-type": "video/mp4", "content-length": "1000" } }), e);
    const { key, url } = (await up.json()) as any;
    expect(url).toBe(`https://w/media/${key}.mp4`);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(key)!.ttl).toBe(21600);
    const full = await route(new Request(url), e);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    const part = await route(new Request(url, { headers: { range: "bytes=10-19" } }), e);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...bytes.slice(10, 20)]);
    const tail = await route(new Request(url, { headers: { range: "bytes=-5" } }), e);
    expect(tail.headers.get("content-range")).toBe("bytes 995-999/1000");
    expect((await route(new Request(url.replace(key, "0".repeat(64))), e)).status).toBe(404);
    expect((await route(new Request("https://w/media/../api/state"), e)).status).not.toBe(200);
    await route(new Request(`https://w/api/media/${key}`, { method: "DELETE", headers: auth }), e);
    expect((await route(new Request(url), e)).status).toBe(404);
  });

  it("refuses files over the free 25 MiB KV value limit", async () => {
    const { e } = kvEnv();
    const r = await route(new Request("https://w/api/media", { method: "POST", body: "x", headers: { ...auth, "content-length": String(30 * 1024 * 1024) } }), e);
    expect(r.status).toBe(413);
  });
});

describe("outros", () => {
  it("set / keep / remove per platform without invalidating queued runs", async () => {
    const e = env();
    const v0 = (await getSettings(e.DB)).configVersion;
    await setOutros(e.DB, { youtube: { fileId: "1Edf0K75AQEhJOLWsWYYY61C96B_HrojG", fileName: "outro_yt.mp4" }, tiktok: { fileId: "1p6_I1DeHCe2fKSSdDo3F69aqDiwUrmak", fileName: "outro_tt.mp4" } }, "t", NOW);
    await setOutros(e.DB, { tiktok: null }, "t", NOW); // switch TikTok off explicitly, YouTube unchanged
    const s = await getSettings(e.DB);
    expect(s.outros).toEqual({ youtube: { fileId: "1Edf0K75AQEhJOLWsWYYY61C96B_HrojG", fileName: "outro_yt.mp4" }, tiktok: null });
    expect(s.configVersion).toBe(v0);
    await expect(setOutros(e.DB, { snapchat: null } as any, "t", NOW)).rejects.toThrow(/unknown outro platform/);
  });
});


describe("folder queue migration", () => {
  it("preserves saved settings, enables random, drops selection history and keeps upload recovery evidence", async () => {
    const db = makeDb(["0001_init.sql", "0002_outros.sql"]);
    db.raw.prepare("UPDATE settings SET automation_enabled=1,automation_enabled_at=?,schedule_json=?,selection_policy='lifo',pending_custom_file_id='custom_video_id_123',pending_custom_file_name='lesson.mp4',pending_custom_config_version=2,publishing_enabled=1,config_version=2,outros_json=? WHERE id=1")
      .run(new Date(NOW).toISOString(), JSON.stringify([{ day: 1, minute: 360 }, { day: 5, minute: 1260 }]), JSON.stringify({ youtube: { fileId: "outro_video_id_123", fileName: "outro.mp4" } }));
    const before = await getSettings(db);
    for (const file of ["confirmed", "missing-outcome"]) db.raw.prepare("INSERT INTO videos(file_id, first_observed_at, consumed) VALUES (?, ?, 1)").run(file, new Date(NOW).toISOString());
    await upsertPublication(db, { runId: "old", fileId: "confirmed", platform: "facebook", surface: "feed", status: "confirmed" }, NOW);
    db.raw.exec(readFileSync(new URL("../worker/migrations/0003_folder_queue.sql", import.meta.url), "utf8"));
    expect(await getSettings(db)).toEqual(before);
    expect(await publicationsFor(db, { fileId: "confirmed" })).toMatchObject([{ status: "confirmed" }]);
    expect(await publicationsFor(db, { fileId: "missing-outcome" })).toMatchObject([{ status: "uncertain", platform: "pipeline" }]);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'videos'").get()).toBeUndefined();
    db.raw.exec(readFileSync(new URL("../worker/migrations/0004_scheduled_jobs.sql", import.meta.url), "utf8"));
    await configureAutomated(db, { selectionPolicy: "random" }, NOW + 1);
    expect((await getSettings(db)).selectionPolicy).toBe("random");
    await configureManual(db, { selectionPolicy: "random" }, NOW + 2);
    expect((await getSettings(db)).selectionPolicy).toBe("random");
  });
});
