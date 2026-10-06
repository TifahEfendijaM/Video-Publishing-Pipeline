// Cloudflare Worker: timing + dispatch only (plus the small authenticated state API the runner uses).
// Video download/processing/upload never happens here.
import {
  HttpError,
  beginRun,
  configureAutomated,
  configureManual,
  consumeCustom,
  consumeVideo,
  dispatchTest,
  finishRun,
  getCredential,
  handleScheduled,
  listVideos,
  mayPublish,
  observeVideos,
  publicationsFor,
  putCredential,
  setPublishing,
  stateView,
  timingSafeEqual,
  upsertPublication,
  type Env,
} from "./logic";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function body(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 200_000) throw new HttpError(413, "body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const now = Date.now();
  if (url.pathname === "/health") return json({ ok: true, service: "easybosnian-video-scheduler" });

  const auth = req.headers.get("authorization") ?? "";
  if (!env.STATE_API_TOKEN || !timingSafeEqual(auth, `Bearer ${env.STATE_API_TOKEN}`)) return json({ error: "unauthorized" }, 401);

  const db = env.DB;
  const m = req.method;
  const p = url.pathname;
  if (m === "GET" && p === "/api/state") return json(await stateView(db, now));
  if (m === "GET" && p === "/api/videos") return json({ videos: await listVideos(db) });
  if (m === "GET" && p === "/api/publications") {
    const id = url.searchParams.get("id");
    return json({
      publications: await publicationsFor(db, {
        runId: url.searchParams.get("run_id") ?? undefined,
        fileId: url.searchParams.get("file_id") ?? undefined,
        open: url.searchParams.get("open") === "1",
        id: id ? Number(id) : undefined,
      }),
    });
  }
  if (m === "GET" && p === "/api/target") {
    return json({ owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, workflow: env.GITHUB_WORKFLOW, ref: env.GITHUB_REF });
  }
  if (m !== "POST") return json({ error: "not found" }, 404);

  const b = await body(req);
  switch (p) {
    case "/api/config/manual":
      return json(await configureManual(db, b, now));
    case "/api/config/automated":
      return json(await configureAutomated(db, b, now));
    case "/api/config/publishing":
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
      return json(await setPublishing(db, b.enabled, b.actor, now));
    case "/api/run/begin":
      return json(await beginRun(db, b, now));
    case "/api/run/may-publish":
      return json(await mayPublish(db, String(b.runId)));
    case "/api/run/consume-custom":
      return json(await consumeCustom(db, String(b.runId)));
    case "/api/run/finish":
      return json(await finishRun(db, b, now));
    case "/api/videos/observe":
      if (!Array.isArray(b.items)) throw new HttpError(400, "items must be an array");
      return json(await observeVideos(db, b.items, now));
    case "/api/videos/consume":
      return json(await consumeVideo(db, b, now));
    case "/api/publications/upsert":
      return json(await upsertPublication(db, b, now));
    case "/api/credentials/get":
      return json({ credential: await getCredential(db, String(b.name)) });
    case "/api/credentials/put":
      return json(await putCredential(db, String(b.name), String(b.ciphertext), now));
    case "/api/dispatch-test":
      return json(await dispatchTest(env, (u, i) => fetch(u, i), now));
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled", (e as Error).message);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(event: { scheduledTime: number; cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(
      handleScheduled(env, event.scheduledTime, (u, i) => fetch(u, i)).then(
        (r) => {
          if (r.action !== "not_due" && r.action !== "automation_disabled") console.log(JSON.stringify({ cron: event.cron, scheduledTime: new Date(event.scheduledTime).toISOString(), ...r }));
        },
        (e) => console.error("scheduled handler error", (e as Error).message),
      ),
    );
  },
};
