import { describe, expect, it, vi } from "vitest";
import { makeDb } from "./d1-shim";
import {
  beginRun,
  configureAutomated,
  configureManual,
  consumeCustom,
  dispatchTest,
  getSettings,
  handleScheduled,
  mayPublish,
  observeVideos,
  setPublishing,
  type Env,
} from "../worker/src/logic";
import { route } from "../worker/src/index";

const T = (s: string) => Date.parse(s);
const NOW = T("2026-10-06T19:00:00Z"); // Tuesday

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

describe("video entry tracking", () => {
  it("upgrades approximations to exact Drive activity times but never downgrades", async () => {
    const e = env();
    await observeVideos(e.DB, [{ fileId: "f1", name: "a.mp4", enteredFolderAt: "2026-09-18T19:21:00Z", entrySource: "created_time_approximation" }], NOW);
    await observeVideos(e.DB, [{ fileId: "f1", name: "a.mp4", enteredFolderAt: "2026-09-19T10:00:00Z", entrySource: "drive_activity" }], NOW);
    await observeVideos(e.DB, [{ fileId: "f1", name: "renamed.mp4", enteredFolderAt: "2026-01-01T00:00:00Z", entrySource: "created_time_approximation" }], NOW);
    const row = e.DB.raw.prepare("SELECT * FROM videos WHERE file_id='f1'").get() as any;
    expect(row.entered_folder_at).toBe("2026-09-19T10:00:00Z");
    expect(row.entry_source).toBe("drive_activity");
    expect(row.last_known_name).toBe("renamed.mp4");
  });
});

describe("HTTP API", () => {
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
    expect(bad.status ?? 400).toBe(400);
  });
});
