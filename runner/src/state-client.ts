import type { ScheduledJob } from "../../worker/src/jobs";
import type { PlanChange, planView } from '../../worker/src/plan';
// Client for the Worker's authenticated state API (D1 is the single source of truth).
import type { SelectionPolicy } from "../../src/shared/selection";
import { json } from "./http";

export class StateClient {
  constructor(private baseUrl: string, private token: string) {}

  private async call<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return json<T>(this.baseUrl.replace(/\/$/, "") + path, {
      label: `state ${path}`,
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 30_000,
    });
  }

  jobs() { return this.call<{ jobs: (ScheduledJob & { nextOccurrences: { key: string; local: string }[] })[] }>("GET", "/api/jobs"); }
  plan() { return this.call<Awaited<ReturnType<typeof planView>>>('GET','/api/plan'); }
  changePlan(request: PlanChange) { return this.call<Awaited<ReturnType<typeof planView>>>('POST','/api/plan/change-with-outros',request); }
  jobBatch(batchId: string, token: string) { return this.call<{ claims: string[] }>("POST", "/api/jobs/batch", { batchId, token }); }
  state() {
    return this.call("GET", "/api/state");
  }
  target() {
    return this.call("GET", "/api/target");
  }
  configureManual(b: { selectionPolicy: SelectionPolicy | null; scheduleBehavior: "keep" | "stop"; actor: string }) {
    // A separate route prevents an older Worker from silently ignoring Keep and stopping automation.
    return this.call("POST", "/api/config/manual-choice", b);
  }
  configureAutomated(b: { scheduleText: string | null; selectionPolicy: SelectionPolicy | null; pendingCustom: { fileId: string; fileName: string } | null; actor: string }) {
    return this.call("POST", "/api/config/automated", b);
  }
  setOutros(changes: Record<string, { fileId: string; fileName: string } | null>, actor: string) {
    return this.call("POST", "/api/config/outros", { changes, actor });
  }
  setPublishing(enabled: boolean, actor: string) {
    return this.call("POST", "/api/config/publishing", { enabled, actor });
  }
  beginRun(b: { origin: string; occurrenceKey?: string; claimToken?: string; batchId?: string; githubRunId?: string; githubRunUrl?: string }) {
    return this.call<{ allowed: boolean; reason: string | null; runId: string | null; settings: any; kind: string; job?: ScheduledJob | null }>("POST", "/api/run/begin", b);
  }
  mayPublish(runId: string) {
    return this.call<{ allowed: boolean; status: string; reason: string | null }>("POST", "/api/run/may-publish", { runId });
  }
  consumeCustom(runId: string) {
    return this.call<{ custom: { fileId: string; fileName: string | null } | null }>("POST", "/api/run/consume-custom", { runId });
  }
  finishRun(b: { runId: string; status: string; selectedFileId?: string; selectedFileName?: string; selectionMethod?: string; selectionNote?: string }) {
    return this.call("POST", "/api/run/finish", b);
  }
  completeVideo(fileId: string) {
    return this.call("POST", "/api/videos/complete", { fileId });
  }
  checkpointFiles() {
    return this.call<{ fileIds: string[] }>("GET", "/api/publications/files");
  }
  upsertPublication(p: { runId: string; fileId: string; platform: string; surface: string; provider?: string; format?: string; status: string; remoteId?: string | null; url?: string | null; detail?: string | null }) {
    return this.call("POST", "/api/publications/upsert", p);
  }
  publications(q: { runId?: string; fileId?: string; open?: boolean; id?: number }) {
    const qs = new URLSearchParams();
    if (q.runId) qs.set("run_id", q.runId);
    if (q.fileId) qs.set("file_id", q.fileId);
    if (q.open) qs.set("open", "1");
    if (q.id !== undefined) qs.set("id", String(q.id));
    return this.call<{ publications: any[] }>("GET", `/api/publications?${qs}`);
  }
  getCredential(name: string) {
    return this.call<{ credential: { ciphertext: string; updated_at: string } | null }>("POST", "/api/credentials/get", { name });
  }
  putCredential(name: string, ciphertext: string) {
    return this.call("POST", "/api/credentials/put", { name, ciphertext });
  }
  dispatchTest() {
    return this.call("POST", "/api/dispatch-test", {});
  }
}
