import { matchesTitle, resolveCustomList, type JobPolicy } from "../../src/shared/job-selection";
import type { ScheduledJob } from "../../worker/src/jobs";
import { interpretVideoRule } from "./video-rule";
// GitHub Actions runner entry point.
//   configure  — "Publish video" form (run_mode manual_now | automated)
//   scheduled  — dispatched by the Cloudflare Worker (or dispatch test)
//   tools      — status / verify / preview / dispatch_test / kill switch / reconcile / resolve / retry
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, secrets, type PipelineConfig } from "./config";
import { StateClient } from "./state-client";
import { Drive, DRIVE_SCOPES, serviceAccountEmail, serviceAccountToken, oauthAccessToken } from "./google";
import { probe, renderStory, renderCanvas, renderWidescreen, concatWithOutro } from "./media-tools";
import type { MediaInfo } from "../../src/shared/media";
import { resolveCustomName, effectiveOutro } from "../../src/shared/selection";
import { makeCaptions } from "./captioner";
import { KvHosting, R2Hosting } from "./hosting";
import { statSync } from "node:fs";
import { Meta } from "./providers/meta";
import { Buffer } from "./providers/buffer";
import { YouTube } from "./providers/youtube";
import { UploadPost } from "./providers/uploadpost";
import { buildTasks, executeTasks, type Identities, type Providers, type StoryFiles, type TaskResult } from "./publish";
import { completeArchived, latestPublications, maintainQueue } from "./queue";
import { Summary, statusLabel } from "./summary";
import { NO_ELIGIBLE_MESSAGE, selectVideo, type FolderVideo, type SelectionPolicy } from "../../src/shared/selection";
import { ScheduleParseError, formatSchedule, parseSchedule } from "../../src/shared/schedule";
import { planFeed, planStory, planYouTubeVersions } from "../../src/shared/media";
import { redact, summarizeError } from "../../src/shared/redact";
import { isRetryable, type PublicationStatus } from "../../src/shared/status";

const sec = secrets();
const cfg = loadConfig();
const env = (n: string) => (process.env[n] ?? "").trim();
const runUrl = () => (env("GITHUB_RUN_ID") ? `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}` : undefined);

function stateClient(): StateClient {
  const url = env("STATE_API_URL");
  const token = sec("STATE_API_TOKEN");
  if (!url || !token) throw new Error("STATE_API_URL (repository variable) and STATE_API_TOKEN (secret) must be configured");
  return new StateClient(url, token);
}

function archiveOptions() {
  return { folderId: env("PUBLISHED_DRIVE_FOLDER_ID") || cfg.publishedFolderId, folderName: cfg.publishedFolderName };
}

async function drive(): Promise<Drive> {
  const [clientId, clientSecret, refreshToken] = [sec("GOOGLE_DRIVE_CLIENT_ID"), sec("GOOGLE_DRIVE_CLIENT_SECRET"), sec("GOOGLE_DRIVE_REFRESH_TOKEN")];
  if (clientId || clientSecret || refreshToken) {
    if (!clientId || !clientSecret || !refreshToken) throw new Error("Set all three GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN secrets");
    const t = await oauthAccessToken({ clientId, clientSecret, refreshToken, encryptionKey: sec("CREDENTIALS_ENCRYPTION_KEY"), state: stateClient(), credentialName: "drive_refresh_token" });
    if (!t.scopes.includes(DRIVE_SCOPES[0])) throw new Error("Drive owner OAuth token needs the https://www.googleapis.com/auth/drive scope for source archival");
    return new Drive(t.accessToken, cfg.driveFolderId, archiveOptions());
  }
  const sa = sec("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured");
  return new Drive(await serviceAccountToken(sa, DRIVE_SCOPES), cfg.driveFolderId, archiveOptions());
}

function queueDeps(d: Drive, state: StateClient) {
  return { publications: async (fileId: string) => (await state.publications({ fileId })).publications,
    archive: (fileId: string) => d.archive(fileId), complete: (fileId: string) => state.completeVideo(fileId) };
}

async function cleanupFolder(s: Summary, state: StateClient) {
  const d = await drive();
  await recoverArchived(d, state, s);
  const videos = await d.listVideos();
  const saved = (await state.state()).settings.outros ?? {};
  const protectedIds = new Set<string>(Object.values(saved).flatMap((o: any) => o ? [o.fileId] : []));
  for (const p of ["youtube", "tiktok", "instagram", "facebook"]) {
    const outro = effectiveOutro(saved[p], videos, cfg.outros?.defaultFileName ?? "");
    if (outro) protectedIds.add(outro.fileId);
  }
  const q = await maintainQueue(videos, protectedIds, queueDeps(d, state));
  if (q.notes.length) { s.h(2, "Drive source cleanup"); s.list(q.notes); }
}

async function recoverArchived(d: Drive, state: StateClient, s: Summary) {
  const { fileIds } = await state.checkpointFiles();
  if (!fileIds.length) return;
  const folder = await d.publishedFolder(false);
  if (!folder) return;
  const archived = new Set((await d.listVideos(folder.id)).map((v) => v.id));
  const count = await completeArchived(archived, fileIds, queueDeps(d, state));
  if (count) s.p(`Cleared recovery checkpoints for ${count} source(s) already in Published videos.`);
}

async function providers(state: StateClient): Promise<Providers> {
  const p: Providers = {};
  const metaToken = sec("META_PAGE_ACCESS_TOKEN");
  if (metaToken) p.meta = new Meta(metaToken, cfg.meta.graphVersion, cfg.polling.metaMaxMinutes);
  const bufferKey = sec("BUFFER_API_KEY");
  if (bufferKey) p.buffer = new Buffer(bufferKey, cfg.polling.bufferMaxMinutes);
  const upKey = sec("UPLOAD_POST_API_KEY");
  if (upKey) p.uploadPost = new UploadPost(upKey, cfg.destinations.youtube.regular.uploadPostProfile, cfg.polling.uploadPostMaxMinutes);
  const [id, secret, refresh] = [sec("YOUTUBE_CLIENT_ID"), sec("YOUTUBE_CLIENT_SECRET"), sec("YOUTUBE_REFRESH_TOKEN")];
  if (id && secret && refresh) {
    const t = await oauthAccessToken({ clientId: id, clientSecret: secret, refreshToken: refresh, encryptionKey: sec("CREDENTIALS_ENCRYPTION_KEY"), state, credentialName: "youtube_refresh_token" });
    p.youtube = new YouTube(t.accessToken, cfg.polling.youtubeMaxMinutes);
    p.youtubeScopes = t.scopes;
  }
  return p;
}

async function identities(p: Providers): Promise<Identities> {
  const d = cfg.destinations;
  const missing = (what: string) => ({ ok: false, detail: `${what} not configured` });
  const facebook = p.meta ? await p.meta.verifyFacebook(d.facebook.expectedPageId, d.facebook.expectedPageName) : missing("META_PAGE_ACCESS_TOKEN");
  const instagram = p.meta && facebook.ok ? await p.meta.verifyInstagram(d.facebook.expectedPageId, d.instagram.expectedUserId, d.instagram.expectedUsername) : p.meta ? { ok: false, detail: "Facebook Page not verified, so its linked Instagram cannot be verified" } : missing("META_PAGE_ACCESS_TOKEN");
  const tiktok = p.buffer ? await p.buffer.verifyChannel(d.tiktok.expectedBufferChannelId, "tiktok", d.tiktok.expectedUsername) : missing("BUFFER_API_KEY");
  const youtube = p.youtube ? await p.youtube.verify(d.youtube.expectedChannelId, d.youtube.expectedChannelHandle, p.youtubeScopes ?? []) : missing("YouTube OAuth credentials");
  const youtubeBuffer = p.buffer && d.youtube.short.bufferChannelId ? await p.buffer.verifyChannel(d.youtube.short.bufferChannelId, "youtube", null) : { ok: false, detail: "no YouTube channel connected in Buffer (youtube.short.bufferChannelId empty)" };
  const youtubeUploadPost = p.uploadPost ? await p.uploadPost.verify(d.youtube.expectedChannelHandle) : missing("UPLOAD_POST_API_KEY");
  return { instagram, facebook, tiktok, youtube, youtubeBuffer, youtubeUploadPost };
}

function r2(): R2Hosting | null {
  const [ak, sk] = [sec("R2_ACCESS_KEY_ID"), sec("R2_SECRET_ACCESS_KEY")];
  const account = env("CLOUDFLARE_ACCOUNT_ID");
  const bucket = env("R2_BUCKET");
  if (!ak || !sk || !account || !bucket) return null;
  return new R2Hosting(account, bucket, ak, sk, cfg.hosting.presignedUrlTtlSeconds);
}

/** Free Workers KV hosting by default; optional R2 only for files above the KV size limit. */
function hosting(): { put(p: string): Promise<{ key: string; url: string }>; remove(k: string): Promise<void> } | null {
  const url = env("STATE_API_URL");
  const token = sec("STATE_API_TOKEN");
  if (!url || !token) return null;
  const kv = new KvHosting(url, token);
  const big = r2();
  const owner = new Map<string, "kv" | "r2">();
  return {
    async put(p) {
      if (statSync(p).size > KvHosting.MAX_BYTES) {
        if (!big) throw new Error(`file exceeds ${KvHosting.MAX_BYTES / 1048576} MB free hosting limit and optional R2 is not configured`);
        const o = await big.put(p);
        owner.set(o.key, "r2");
        return o;
      }
      const o = await kv.put(p);
      owner.set(o.key, "kv");
      return o;
    },
    async remove(k) {
      if (owner.get(k) === "r2") await big?.remove(k);
      else await kv.remove(k);
    },
  };
}

function settingsRows(s: any, next: any[]): [string, string][] {
  return [
    ["Automation", s.automationEnabled ? "ENABLED" : "disabled"],
    ["Scheduled jobs", "See the Scheduled jobs report; each job has its own timetable and rule"],
    ["Default one-off selection policy", s.selectionPolicy.toUpperCase()],
    ["Outros", ["youtube", "tiktok", "instagram", "facebook"].map((p) => `${p}: ${s.outros?.[p] === null ? "none (switched off)" : s.outros?.[p]?.fileName ?? (cfg.outros?.defaultFileName ? `default (${cfg.outros.defaultFileName})` : "none")}`).join("\n")],
    ["Live publishing kill switch", s.publishingEnabled ? "ON (live publishing allowed)" : "OFF (nothing will be published)"],
    ["Next scheduled occurrences", s.automationEnabled ? next.map((o) => `${o.jobName ? o.jobName + ": " : ""}${o.local}`).join("\n") || "none" : "none (automation disabled)"],
  ];
}

// ---------------------------------------------------------------------------

interface PublishOpts {
  runId: string;
  origin: "manual" | "scheduled" | "retry";
  scheduledLocal?: string;
  policy: SelectionPolicy;
  customName?: string | null;
  pendingCustom?: { fileId: string; fileName: string | null } | null;
  forcedFileId?: string;
  filter?: Set<string>;
  preview?: boolean;
  job?: ScheduledJob;
  /** manual_now outro choices for this run only (platform -> clip, or null = no outro); not saved */
  outroOverrides?: Record<string, { fileId: string; fileName: string } | null>;
  summary: Summary;
  state: StateClient;
}

async function publishFlow(o: PublishOpts): Promise<string> {
  const s = o.summary;
  const d = await drive();
  if (!o.preview) await recoverArchived(d, o.state, s);
  const folder = { videos: await d.listVideos() };
  const { jobs } = await o.state.jobs();
  if (o.job) {
    const fresh = jobs.find((j) => j.id === o.job!.id);
    const gate = await o.state.mayPublish(o.runId);
    if (!fresh || fresh.status !== "active" || !gate.allowed) {
      s.p(`Scheduled job is complete, stopped, deleted or stale: ${gate.reason ?? "no active job"}. Nothing published.`);
      await o.state.finishRun({ runId: o.runId, status: "cancelled_stale" });
      return "cancelled_stale";
    }
    o.job = fresh;
    o.pendingCustom = fresh.remaining[0] ?? null;
    o.policy = fresh.titleRule?.order ?? (fresh.policy === "custom" ? "fifo" : fresh.policy as SelectionPolicy);
  }
  const reservedIds = new Set(jobs.flatMap((j) => j.remaining.map((v) => v.fileId)));
  if (o.job?.remaining[0]) reservedIds.delete(o.job.remaining[0].fileId);
  const savedOutros: Record<string, { fileId: string; fileName: string } | null> = (await o.state.state()).settings.outros ?? {};
  const outros = Object.fromEntries(
    (["youtube", "tiktok", "instagram", "facebook"] as const).map((p) => [p, effectiveOutro(o.outroOverrides && p in o.outroOverrides ? o.outroOverrides[p] : savedOutros[p], folder.videos, cfg.outros?.defaultFileName ?? "")]),
  );
  const excludeIds = new Set(Object.values(outros).flatMap((x) => (x ? [x.fileId] : [])));
  for (const outro of Object.values(savedOutros)) if (outro) excludeIds.add(outro.fileId);
  for (const job of jobs) for (const outro of Object.values(job.outros)) if (outro) excludeIds.add(outro.fileId);
  const queue = await maintainQueue(folder.videos, excludeIds, queueDeps(d, o.state), !!o.preview);
  const candidates = o.job?.titleRule ? folder.videos.filter((v) => matchesTitle(v.name, o.job!.titleRule!)) : folder.videos;
  let sel;
  if (o.forcedFileId) {
    const v = folder.videos.find((x) => x.id === o.forcedFileId);
    if (!v || !await d.stillInFolder(v.id)) throw new Error(`Video ${o.forcedFileId} is no longer in the folder; cannot retry.`);
    sel = { ...selectVideo({ policy: o.policy, pendingCustomFileId: v.id, pendingCustomFileName: v.name, videos: [v] }), method: "retry" as const };
  } else {
    sel = selectVideo({ policy: o.policy, customName: o.customName, pendingCustomFileId: o.pendingCustom?.fileId, pendingCustomFileName: o.pendingCustom?.fileName, videos: candidates, excludeIds, reservedIds, strictCustom: !!o.job, blockedIds: queue.blockedIds });
  }
  s.h(2, "Video selection");
  s.kv([
    ["Job", o.job?.name ?? "one-off"],
    ["Method", sel.method === "custom" ? "custom (one-run override)" : sel.method.toUpperCase()],
    ["Fallback", sel.fallback ?? "none"],
    ["Eligible videos remaining in the folder", sel.eligibleCount],
    ["Date ordering", "Drive upload/creation date (createdTime)"],
  ]);
  if (sel.notes.length || queue.notes.length) s.list([...queue.notes, ...sel.notes]);
  if (!sel.video) {
    s.p(`**${NO_ELIGIBLE_MESSAGE}** Nothing was published.`);
    if (!o.preview) await o.state.finishRun({ runId: o.runId, status: "no_eligible_video", selectionMethod: sel.method, selectionNote: sel.fallback ?? undefined });
    return "no_eligible_video";
  }
  const v = sel.video;
  s.kv([
    ["Selected file", v.name],
    ["Drive file ID", v.id],
    ["Uploaded/created in Drive", v.createdTime],
  ]);

  const work = mkdtempSync(join(tmpdir(), "ebv-"));
  try {
    const original = join(work, "original.mp4");
    await d.download(v.id, original);
    const info = await probe(original);
    // Outros: per platform, the selected video + that platform's outro clip (Stories stay without outro).
    type Base = { path: string; info: MediaInfo; outro: string | null };
    const bases: Record<"youtube" | "tiktok" | "instagram" | "facebook", Base> = {} as any;
    const joined = new Map<string, Base>();
    const outroNotes: string[] = [];
    for (const plat of ["youtube", "tiktok", "instagram", "facebook"] as const) {
      const ou = outros[plat];
      bases[plat] = { path: original, info, outro: null };
      if (!ou) continue;
      if (ou.fileId === v.id) {
        outroNotes.push(`${plat}: the selected video is itself the ${plat} outro, so no outro is appended.`);
        continue;
      }
      const clip = folder.videos.find((x) => x.id === ou.fileId);
      if (!clip) {
        outroNotes.push(`${plat}: outro "${ou.fileName}" is no longer in the folder; published WITHOUT an outro.`);
        continue;
      }
      if (!joined.has(clip.id)) {
        const i = joined.size + 1;
        const op = join(work, `outro_${i}.mp4`);
        await d.download(clip.id, op);
        const oinfo = await probe(op);
        const out = join(work, `with_outro_${i}.mp4`);
        await concatWithOutro(original, info, op, oinfo, out);
        joined.set(clip.id, { path: out, info: await probe(out), outro: clip.name });
      }
      bases[plat] = joined.get(clip.id)!;
    }
    const feed = {
      instagram: planFeed(bases.instagram.info).instagram,
      facebook: planFeed(bases.facebook.info).facebook,
      tiktok: planFeed(bases.tiktok.info).tiktok,
      youtube: planFeed(bases.youtube.info).youtube,
    };
    const ytPlan = planYouTubeVersions(bases.youtube.info);
    const storyPlan = planStory(info, cfg.stories.longVideoPolicy);
    s.h(2, "Media");
    s.kv([
      ["Duration", `${info.durationSec.toFixed(2)} s`],
      ["Dimensions", `${info.width}x${info.height} (${info.height >= info.width ? (info.height === info.width ? "square" : "vertical") : "horizontal"})`],
      ["Video", `${info.videoCodec}, ${info.fps} fps, ${info.pixFmt ?? "?"}`],
      ["Audio", info.audioCodec ? `${info.audioCodec} ${info.audioSampleRate ?? ""} Hz` : "none"],
      ["Size", `${(info.sizeBytes / 1024 / 1024).toFixed(2)} MB`],
      ["Outros", (["youtube", "tiktok", "instagram", "facebook"] as const).map((p) => `${p}: ${bases[p].outro ? `${bases[p].outro} appended (${bases[p].info.durationSec.toFixed(1)} s total)` : "none"}`).join("\n")],
      ["Instagram", `Reel${feed.instagram.check.ok ? "" : ` — incompatible: ${feed.instagram.check.problems.join("; ")}`}`],
      ["Facebook", feed.facebook.reason],
      ["TikTok", feed.tiktok.check.ok ? "video post" : `incompatible: ${feed.tiktok.check.problems.join("; ")}`],
      ["YouTube Short", ytPlan.short.reason],
      ["YouTube regular video", ytPlan.regular.reason],
      ["Stories", storyPlan.kind === "single" ? (storyPlan.needsRendition ? `Story rendition: ${storyPlan.renditionReason}` : "original file used") : storyPlan.kind === "segmented" ? storyPlan.renditionReason : storyPlan.reason],
    ]);
    if (outroNotes.length) s.list(outroNotes);

    const stories: StoryFiles = { plan: storyPlan, files: [] };
    if (storyPlan.kind === "single" && storyPlan.needsRendition) {
      const p = join(work, "story.mp4");
      await renderStory(original, p, info);
      stories.files.push({ path: p, surface: "story", label: "" });
    } else if (storyPlan.kind === "segmented") {
      for (const seg of storyPlan.segments) {
        const p = join(work, `story_${seg.index}.mp4`);
        await renderStory(original, p, info, seg);
        stories.files.push({ path: p, surface: `story_part_${seg.index}`, label: `${seg.index}/${seg.count}` });
      }
    }
    const youtube = { plan: ytPlan, shortPath: null as string | null, regularPath: null as string | null };
    if (cfg.destinations.youtube.enabled) {
      if (cfg.destinations.youtube.short.enabled && ytPlan.short.kind === "vertical_canvas") {
        youtube.shortPath = join(work, "youtube_short.mp4");
        await renderCanvas(bases.youtube.path, youtube.shortPath, bases.youtube.info, { width: 1080, height: 1920 });
      }
      if (cfg.destinations.youtube.regular.enabled && ytPlan.regular.kind === "widescreen_canvas") {
        youtube.regularPath = join(work, "youtube_video.mp4");
        await renderWidescreen(bases.youtube.path, youtube.regularPath, bases.youtube.info);
      }
      // No rendition needed but an outro was appended: the joined file is the version to upload.
      if (!youtube.shortPath && ytPlan.short.kind === "original" && bases.youtube.outro) youtube.shortPath = bases.youtube.path;
      if (!youtube.regularPath && ytPlan.regular.kind === "original" && bases.youtube.outro) youtube.regularPath = bases.youtube.path;
    }
    if (o.preview && env("PREVIEW_DIR")) {
      for (const [name, p] of [["youtube_short", youtube.shortPath], ["youtube_video", youtube.regularPath], ...[...joined.values()].map((b, i) => [`with_outro_${i + 1}`, b.path] as const)] as const) if (p) copyFileSync(p, join(env("PREVIEW_DIR"), `${name}.mp4`));
    }
    if (o.preview && stories.files.length && env("PREVIEW_DIR")) {
      for (const f of stories.files) copyFileSync(f.path, join(env("PREVIEW_DIR"), `${f.surface}.mp4`));
    }

    const captions = await makeCaptions(v.name, { accountId: env("CLOUDFLARE_ACCOUNT_ID") || undefined, token: sec("CLOUDFLARE_AI_TOKEN"), model: cfg.captions.model });
    s.h(2, "Text");
    s.kv([
      ["Filename", captions.analysis.meaningful ? `meaningful — topic hint: "${captions.analysis.topicHint}"` : `generic (${captions.analysis.reason})`],
      ["Caption source", captions.source === "generated" ? `generated by ${cfg.captions.model} (Cloudflare Workers AI, free tier)` : "stored generic caption"],
    ]);
    if (captions.notes.length) s.list(captions.notes);
    s.p("Caption (Instagram Reel, Facebook, TikTok):").code(captions.caption);
    s.p("YouTube title:").code(captions.youtubeTitle);
    s.p("YouTube description:").code(captions.youtubeDescription);

    const prov = await providers(o.state);
    const ids = await identities(prov);
    s.h(2, "Destination identity checks");
    s.table(["Destination", "Verified", "Detail"], Object.entries(ids).map(([k, c]) => [k, c.ok ? "✅" : "❌", c.detail]));

    let tasks = buildTasks({ cfg, info, feed, stories, originalPath: original, captions, providers: prov, identities: ids, youtube, feedPaths: { instagram: bases.instagram.path, facebook: bases.facebook.path, tiktok: bases.tiktok.path } });
    if (o.filter) tasks = tasks.filter((t) => o.filter!.has(`${t.platform}:${t.surface}`));

    if (o.preview) {
      s.h(2, "Planned destinations (preview — nothing was published, source queue unchanged)");
      s.table(["Platform", "Surface", "Format", "Provider", "Would be"], tasks.map((t) => [t.platform, t.surface, t.format, t.provider, t.blocked ? `${statusLabel(t.blocked.status)}: ${t.blocked.detail}` : "attempted"]));
      return "preview";
    }

    const host = hosting();
    const { results, hostedKeys } = await executeTasks(o.runId, v.id, tasks, {
      mayPublish: (id) => o.state.mayPublish(id),
      record: async (r) => {
        await o.state.upsertPublication({ runId: r.runId, fileId: r.fileId, platform: r.platform, surface: r.surface, provider: r.provider, format: r.format, status: r.status, remoteId: r.remoteId ?? null, url: r.url ?? null, detail: r.detail ? redact(r.detail).slice(0, 1000) : null });
      },
      host: host ? (p) => host.put(p) : undefined,
      log: (m) => console.log(redact(m)),
    });
    const cleanup = await maintainQueue([v], excludeIds, queueDeps(d, o.state));
    if (cleanup.notes.length) { s.h(2, "Drive source cleanup"); s.list(cleanup.notes); }
    // Keep hosted media only while a URL-fetching provider may still need it (lifecycle rule deletes it anyway).
    const urlPending = results.some((r) => (r.provider === "buffer" || r.platform === "instagram") && (r.status === "processing" || r.status === "initiated" || r.status === "uncertain"));
    if (host && !urlPending) for (const k of hostedKeys) await host.remove(k).catch(() => {});

    reportResults(s, results);
    const status = results.every((r) => r.status === "confirmed" || r.status === "unsupported") ? "completed" : results.some((r) => r.status === "confirmed") ? "partial" : "not_published";
    await o.state.finishRun({ runId: o.runId, status, selectedFileId: cleanup.archivedIds.has(v.id) ? undefined : v.id, selectedFileName: cleanup.archivedIds.has(v.id) ? undefined : v.name, selectionMethod: sel.method, selectionNote: sel.fallback ?? undefined });
    return status;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function reportResults(s: Summary, results: TaskResult[]) {
  s.h(2, "Publication results");
  s.table(
    ["Platform", "Surface", "Format", "Provider", "Status", "Link / ID", "Detail"],
    results.map((r) => [r.platform, r.surface, r.format, r.provider, statusLabel(r.status), r.url ?? r.remoteId ?? "", r.detail ?? ""]),
  );
  const next: string[] = [];
  for (const r of results) {
    if (r.status === "failed") next.push(`${r.platform}/${r.surface} failed definitively — re-attempt only this destination with Tools → retry_failed (run ID shown above).`);
    if (r.status === "disabled") next.push(`${r.platform}/${r.surface} was skipped — fix its configuration or enable publishing, then use Tools → retry_failed for this run.`);
    if (r.status === "uncertain") next.push(`${r.platform}/${r.surface} outcome is UNCERTAIN — check the account manually, then Tools → resolve_publication. It will never be retried automatically.`);
    if (r.status === "processing" || r.status === "initiated") next.push(`${r.platform}/${r.surface} still processing — Tools → reconcile later to confirm.`);
  }
  if (next.length) {
    s.h(3, "Next actions");
    s.list([...new Set(next)]);
  }
}

// ---------------------------------------------------------------------------
// Commands

async function cmdConfigure() {
  const s = new Summary();
  const state = stateClient();
  const mode = env("RUN_MODE");
  const selection = env("VIDEO_SELECTION") || "keep_existing";
  const customName = process.env.CUSTOM_VIDEO_NAME ?? "";
  const scheduleText = process.env.SCHEDULE_TEXT ?? "";
  const actor = env("GITHUB_ACTOR") || "github";
  if (!["manual_now", "automated"].includes(mode)) throw new Error("run_mode must be manual_now or automated");
  const outroInputs = { youtube: process.env.OUTRO_YOUTUBE ?? "", tiktok: process.env.OUTRO_TIKTOK ?? "", instagram: process.env.OUTRO_INSTAGRAM ?? "", facebook: process.env.OUTRO_FACEBOOK ?? "" };
  /**
   * Resolve the outro fields: empty = unchanged, "none" = off, filename = that clip (if exactly one file matches).
   * save = true (automated): stored for all later runs. save = false (manual_now): applies to this run only.
   */
  const applyOutros = async (save: boolean): Promise<{ notes: string[]; changes: Record<string, { fileId: string; fileName: string } | null> }> => {
    const entries = Object.entries(outroInputs).filter(([, v]) => v.trim() !== "");
    if (!entries.length) return { notes: [], changes: {} };
    const verb = save ? "saved" : "for this video only";
    const notes: string[] = [];
    const changes: Record<string, { fileId: string; fileName: string } | null> = {};
    let videos: FolderVideo[] | null = null;
    for (const [plat, raw] of entries) {
      const val = raw.trim();
      if (/^(none|remove|-)$/i.test(val)) {
        changes[plat] = null;
        notes.push(`${plat} outro switched off (${verb}).`);
        continue;
      }
      videos ??= await (await drive()).listVideos(); // auth/network errors abort; never treated as "not found"
      const r = resolveCustomName(val, videos);
      if (r.kind === "match") {
        changes[plat] = { fileId: r.video.id, fileName: r.video.name };
        notes.push(`${plat} outro: ${r.video.name} (${verb}).`);
      } else if (r.kind === "ambiguous") notes.push(`${plat} outro unchanged: ${r.count} files are named "${r.name}".`);
      else notes.push(`${plat} outro unchanged: no video named "${val}" in the folder.`);
    }
    if (save && Object.keys(changes).length) await state.setOutros(changes, actor);
    return { notes, changes };
  };
  if (!["keep_existing", "fifo", "lifo", "random", "custom", "rule"].includes(selection)) throw new Error("Choose keep_existing, fifo, lifo, random, custom or rule");
  const policyChoice = ["fifo", "lifo", "random"].includes(selection) ? selection as SelectionPolicy : null;

  s.h(1, `EasyBosnian video — ${mode}`);
  if (mode === "manual_now") {
    if (selection === "rule") throw new Error("Plain-English selection rules currently apply to scheduled jobs; choose FIFO/LIFO/Random/Custom for a one-off upload");
    const scheduleAction = env("MANUAL_SCHEDULE_ACTION") || "keep_schedule";
    if (!["keep_schedule", "stop_schedule"].includes(scheduleAction)) throw new Error("manual_schedule_action must be keep_schedule or stop_schedule");
    const scheduleBehavior = scheduleAction === "keep_schedule" ? "keep" : "stop";
    const ignored: string[] = [];
    if (scheduleText.trim()) ignored.push("schedule (only used in automated mode)");
    if (selection !== "custom" && customName.trim()) ignored.push("custom_video_name (only used when video_selection = custom)");
    const cfgView = await state.configureManual({ selectionPolicy: policyChoice, scheduleBehavior, actor });
    if (cfgView.manualScheduleBehavior !== scheduleBehavior) throw new Error("Worker does not support this manual schedule choice; deploy the updated Worker before publishing");
    const { notes: outroNotes, changes: outroOverrides } = await applyOutros(false);
    const begin = await state.beginRun({ origin: "manual", githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
    s.kv([
      ["Origin", "manual (manual_now)"],
      ["Started", new Date().toISOString()],
      ["Run ID", begin.runId],
      ["Existing schedule", scheduleBehavior === "keep" ? "Kept unchanged; manual video selection is for this upload only" : "Automation stopped before this upload; saved timetable retained"],
      ["Ignored fields", ignored.join("; ") || "none"],
    ]);
    if (outroNotes.length) s.list(outroNotes);
    s.h(2, scheduleBehavior === "keep" ? "Saved configuration (schedule kept unchanged)" : "Saved configuration (automation stopped before publishing)");
    s.kv(settingsRows(cfgView.settings, cfgView.nextOccurrences));
    try {
      const status = await publishFlow({
        runId: begin.runId!,
        origin: "manual",
        policy: policyChoice ?? cfgView.settings.selectionPolicy,
        customName: selection === "custom" ? customName : null,
        outroOverrides,
        summary: s,
        state,
      });
      s.p(`Run result: **${status}**. ${scheduleBehavior === "stop" ? "Scheduled automation is stopped." : cfgView.settings.automationEnabled ? "The existing schedule remains enabled." : "The existing schedule remains disabled."}`);
    } catch (e) {
      s.p(`Run failed before completion: ${summarizeError(e)}`);
      await state.finishRun({ runId: begin.runId!, status: "error" }).catch(() => {});
      s.write();
      throw e;
    }
    s.write();
    return;
  }

  // Named-job management never publishes. Resolve and validate before saving anything.
  const action = env("JOB_ACTION") || "list";
  const name = env("JOB_NAME").normalize("NFC");
  if (!["create", "edit", "delete", "list"].includes(action)) throw new Error("Choose Create, Edit, Delete or List jobs");
  if (action === "list") { await reportJobs(s, state); s.write(); return; }
  if (action === "delete") {
    const result = await state.changeJob({ action, name });
    s.p(`Deleted job "${result.deleted}". Other jobs and video files were not changed.`);
    await reportJobs(s, state); s.write(); return;
  }
  const existing = action === "edit" ? (await state.jobs()).jobs.find((j) => j.name.toLowerCase() === name.toLowerCase() || j.id === name) : undefined;
  if (action === "edit" && !existing) throw new Error("No job with that name; run List jobs to copy its name");
  let policy: JobPolicy | null = selection === "keep_existing" ? null : selection === "rule" ? "title_rule" : selection as JobPolicy;
  let titleRule = existing?.titleRule;
  if (selection === "rule") {
    const sentence = env("VIDEO_RULE");
    if (sentence) {
      const rule = await interpretVideoRule(sentence, { accountId: env("CLOUDFLARE_ACCOUNT_ID"), token: sec("CLOUDFLARE_AI_TOKEN"), model: cfg.captions.model });
      policy = rule.policy; titleRule = rule.titleRule;
      s.p(`Interpreted selection rule: ${rule.explanation}`);
    } else if (!existing?.titleRule) throw new Error("Enter a plain-English video rule");
  }
  const effective = policy ?? existing?.policy;
  const remaining = effective === "custom" && customName.trim() ? resolveCustomList(customName, await (await drive()).listVideos()) : undefined;
  const outros = (await applyOutros(false)).changes;
  const result = await state.changeJob({ action: action as "create" | "edit", name, scheduleText, policy, remaining, titleRule, outros });
  s.p(`${action === "create" ? "Created" : "Updated"} job "${result.job.name}". Nothing was published now; other jobs were left unchanged.`);
  await reportJobs(s, state);
  s.write();
}

async function reportJobs(s: Summary, state: StateClient) {
  const { jobs } = await state.jobs();
  s.h(2, "Scheduled jobs");
  if (!jobs.length) { s.p("No scheduled jobs configured."); return; }
  s.table(["Job name", "Schedule (Europe/Sarajevo)", "Selection", "Status", "Next occurrence", "Custom remaining"], jobs.map((j) => [j.name, j.scheduleText, j.policy, j.status, j.nextOccurrences[0]?.local ?? "none", String(j.remaining.length)]));
  let folder: FolderVideo[] | undefined;
  for (const job of jobs) {
    s.h(3, job.name);
    if (job.remaining.length) {
      s.p(`Remaining Custom videos, in publication order (${job.remaining.length}):`);
      s.list(job.remaining.map((v, i) => `${i + 1}. ${v.fileName}`));
    }
    if (job.titleRule) {
      const rule = job.titleRule;
      s.p(`Title ${rule.match.replace(/_/g, " ")} ${JSON.stringify(rule.text)}; ${rule.order.toUpperCase()}. Waiting for future matches when none remain.`);
      folder ??= await (await drive()).listVideos();
      const reserved = new Set(jobs.flatMap((j) => j.remaining.map((v) => v.fileId)));
      const outroIds = new Set(jobs.flatMap((j) => Object.values(j.outros).flatMap((o) => o ? [o.fileId] : [])));
      const matches = folder.filter((v) => matchesTitle(v.name, rule) && !/outro/i.test(v.name) && !outroIds.has(v.id) && !reserved.has(v.id));
      if (matches.length) { s.p("Titles matching now (pending publishing outcomes may still hold a match):"); s.list(matches.map((v) => v.name)); } else s.p("No eligible titles match now.");
    }
  }
}

async function cmdScheduled() {
  const state = stateClient();
  if (env("DISPATCH_MODE") === "jobs") {
    const batchId = env("OCCURRENCE_KEY"), token = env("CLAIM_TOKEN");
    const { claims } = await state.jobBatch(batchId, token);
    let failures = 0;
    for (const key of claims) {
      try { await scheduledOccurrence(state, key, token, batchId); }
      catch (e) { failures++; console.error(`Job occurrence failed: ${summarizeError(e, 250)}`); }
    }
    if (failures) throw new Error(`${failures} job occurrence(s) failed; other claimed jobs were processed independently. See their summaries.`);
    return;
  }
  await scheduledOccurrence(state, env("OCCURRENCE_KEY"), env("CLAIM_TOKEN"));
}

async function scheduledOccurrence(state: StateClient, occurrenceKey: string, claimToken: string, batchId?: string) {
  const s = new Summary();
  const begin = await state.beginRun({ origin: "scheduled", occurrenceKey, claimToken, batchId, githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
  const st = await state.state();
  const key = occurrenceKey.includes("|") ? occurrenceKey.split("|")[1] : occurrenceKey;
  const scheduledLocal = /^\d{4}-/.test(key) ? (await import("../../src/shared/schedule")).localLabel(Date.parse(key)) : "n/a (dispatch test)";
  s.h(1, begin.kind === "dispatch_test" ? "EasyBosnian video — dispatch test" : "EasyBosnian video — scheduled run");
  s.kv([
    ["Origin", begin.kind === "dispatch_test" ? "dispatch test (non-publishing)" : "scheduled (Cloudflare Worker)"],
    ["Scheduled Sarajevo time", scheduledLocal],
    ["Actual start", new Date().toISOString()],
    ["Run ID", begin.runId ?? "—"],
  ]);
  s.h(2, "Saved configuration");
  if (begin.job) s.kv([["Job", begin.job.name], ["Schedule", begin.job.scheduleText], ["Selection", begin.job.policy]]);
  s.kv(settingsRows(st.settings, st.nextOccurrences));
  if (!begin.allowed) {
    s.p(`${begin.kind === "dispatch_test" ? "✅ Dispatch verified: the Worker reached this workflow on the intended branch with a valid claim." : "⏹️ Not publishing."} ${begin.reason ?? ""}`);
    if (begin.runId) await state.finishRun({ runId: begin.runId, status: begin.kind === "dispatch_test" ? "dispatch_verified" : "cancelled_stale" });
    s.write();
    return;
  }
  const custom = begin.job ? begin.job.remaining[0] ?? null : (await state.consumeCustom(begin.runId!)).custom;
  if (begin.job) s.p(`Scheduled job: ${begin.job.name}`);
  try {
    const status = await publishFlow({ runId: begin.runId!, origin: "scheduled", scheduledLocal, policy: begin.job ? begin.job.titleRule?.order ?? (begin.job.policy === "custom" ? "fifo" : begin.job.policy as SelectionPolicy) : begin.settings.selectionPolicy, pendingCustom: custom, job: begin.job ?? undefined, outroOverrides: begin.job?.outros, summary: s, state });
    s.p(`Run result: **${status}**.`);
  } catch (e) {
    s.p(`Run failed before completion: ${summarizeError(e)}`);
    await state.finishRun({ runId: begin.runId!, status: "error" }).catch(() => {});
    s.write();
    throw e;
  }
  s.write();
}

async function cmdTools() {
  const s = new Summary();
  const state = stateClient();
  const action = env("TOOL_ACTION");
  const target = env("TOOL_TARGET");
  const resolution = env("TOOL_RESOLUTION");
  const actor = env("GITHUB_ACTOR") || "github";
  s.h(1, `EasyBosnian video tools — ${action}`);

  if (action === "status") {
    const st = await state.state();
    s.kv(settingsRows(st.settings, st.nextOccurrences));
    s.p(`Configuration version ${st.settings.configVersion}, last changed ${st.settings.updatedAt} by ${st.settings.updatedBy ?? "?"}.`);
    await reportJobs(s, state);
    s.h(2, "Recent runs");
    s.table(["Started", "Origin", "Status", "Video", "Method", "Note"], st.recentRuns.map((r: any) => [r.started_at, r.origin, r.status, r.selected_file_name ? `${r.selected_file_name} (${r.selected_file_id})` : "", r.selection_method, r.selection_note]));
    s.h(2, "Recent scheduler dispatches");
    s.table(["Occurrence (UTC)", "Kind", "GitHub HTTP", "State", "Note"], st.recentClaims.map((c: any) => [c.occurrence_key, c.kind, String(c.dispatch_http_status ?? ""), c.state, c.dispatch_note]));
    s.h(2, "Publications needing attention");
    s.table(["ID", "Run", "Platform", "Surface", "Status", "Remote", "Detail"], st.openPublications.map((p: any) => [String(p.id), p.run_id, p.platform, p.surface, statusLabel(p.status), p.url ?? p.remote_id, p.detail]));
  } else if (action === "publishing_enable" || action === "publishing_disable") {
    const v = await state.setPublishing(action === "publishing_enable", actor);
    s.kv(settingsRows(v.settings, v.nextOccurrences));
  } else if (action === "dispatch_test") {
    const r = await state.dispatchTest();
    s.kv([
      ["Target", r.target],
      ["GitHub dispatch HTTP status", `${r.githubStatus} ${r.githubStatus === 204 ? "(accepted)" : "(NOT accepted)"}`],
      ["Note", r.note],
      ["Next", "A 'Scheduled publish (Worker)' run should appear within a minute; it verifies the claim and exits without publishing."],
    ]);
    if (r.githubStatus !== 204) {
      s.write();
      throw new Error(`dispatch test failed with HTTP ${r.githubStatus}`);
    }
  } else if (action === "rule_preview") {
    const interpreted = await interpretVideoRule(target, { accountId: env("CLOUDFLARE_ACCOUNT_ID"), token: sec("CLOUDFLARE_AI_TOKEN"), model: cfg.captions.model });
    s.p(`Interpreted rule: ${interpreted.explanation} Nothing was saved or published.`);
  } else if (action === "verify") {
    await verify(s, state);
  } else if (action === "preview") {
    const st = await state.state();
    const begin = { runId: `preview-${Date.now()}` };
    s.p("Private preview: selection is computed read-only, nothing is published and the source queue is not changed. Story renditions are attached as a workflow artifact.");
    await publishFlow({ runId: begin.runId, origin: "manual", policy: st.settings.selectionPolicy, customName: target || null, pendingCustom: target ? null : st.settings.pendingCustom, preview: true, summary: s, state: readOnly(state) });
  } else if (action === "reconcile") {
    await reconcile(s, state);
  } else if (action === "resolve_publication") {
    if (!/^\d+$/.test(target) || !["confirmed", "failed"].includes(resolution)) throw new Error("resolve_publication needs target = publication ID and resolution = confirmed|failed");
    const pub = (await state.publications({ id: Number(target) })).publications[0];
    if (!pub) throw new Error("publication not found");
    if (!["uncertain", "processing", "initiated"].includes(pub.status)) throw new Error(`publication ${target} is ${pub.status}; only open outcomes can be resolved`);
    await state.upsertPublication({ runId: pub.run_id, fileId: pub.file_id, platform: pub.platform, surface: pub.surface, status: resolution, detail: `resolved manually as ${resolution} by ${actor} (was ${pub.status})` });
    s.p(`Publication ${target} (${pub.platform}/${pub.surface}) marked ${resolution}.`);
    await cleanupFolder(s, state);
  } else if (action === "retry_failed") {
    if (!target) throw new Error("retry_failed needs target = the run ID from the original run summary");
    const pubs = (await state.publications({ runId: target })).publications;
    const latest = pubs.length ? latestPublications((await state.publications({ fileId: pubs[0].file_id })).publications) : [];
    const failed = pubs.filter((p: any) => isRetryable(p.status as PublicationStatus) && latest.some((q) => q.id === p.id));
    if (!failed.length) {
      s.p("Nothing to retry: no current failed or skipped destinations in that run (confirmed or pending outcomes are never resent).");
    } else {
      const begin = await state.beginRun({ origin: "retry", githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
      const st = await state.state();
      s.p(`Retrying only: ${failed.map((p: any) => `${p.platform}/${p.surface}`).join(", ")}`);
      await publishFlow({ runId: begin.runId!, origin: "retry", policy: st.settings.selectionPolicy, forcedFileId: failed[0].file_id, filter: new Set(failed.map((p: any) => `${p.platform}:${p.surface}`)), summary: s, state });
    }
  } else throw new Error(`unknown tool action ${action}`);
  s.write();
}

/** Wrap the state client so preview mode cannot move sources or write publications. */
function readOnly(state: StateClient): StateClient {
  return new Proxy(state, {
    get(target, prop, recv) {
      if (["completeVideo", "upsertPublication", "finishRun", "consumeCustom", "configureManual", "changeJob", "configureAutomated", "setPublishing"].includes(String(prop))) {
        return async () => {
          throw new Error(`preview is read-only (${String(prop)})`);
        };
      }
      if (prop === "mayPublish") return async () => ({ allowed: false, status: "disabled", reason: "preview mode never publishes" });
      return Reflect.get(target, prop, recv);
    },
  });
}

async function verify(s: Summary, state: StateClient) {
  const rows: [string, string, string][] = [];
  const add = (k: string, ok: boolean | null, d: string) => rows.push([k, ok === null ? "➖" : ok ? "✅" : "❌", d]);
  try {
    const st = await state.state();
    const tgt = await state.target();
    add("Worker state API", true, `reachable; config v${st.settings.configVersion}; kill switch ${st.settings.publishingEnabled ? "ON" : "OFF"}`);
    const expected = `${env("GITHUB_REPOSITORY")}`;
    add("Worker dispatch target", `${tgt.owner}/${tgt.repo}`.toLowerCase() === expected.toLowerCase() && tgt.ref === "main", `${tgt.owner}/${tgt.repo} → ${tgt.workflow} @ ${tgt.ref}`);
  } catch (e) {
    add("Worker state API", false, summarizeError(e, 200));
  }
  try {
    const sa = sec("GOOGLE_SERVICE_ACCOUNT_JSON");
    const d = await drive();
    const f = await d.folder();
    const vids = await d.listVideos();
    add("Google Drive folder", f.id === cfg.driveFolderId && f.mimeType === "application/vnd.google-apps.folder", `"${f.name}" (${f.id}) via ${sec("GOOGLE_DRIVE_REFRESH_TOKEN") ? "Drive owner OAuth" : serviceAccountEmail(sa!)}; ${vids.length} videos`);
    const source = vids.find((v) => !/outro/i.test(v.name));
    add("Drive source cleanup permission", source ? await d.canArchive(source.id) : null, source ? `Source "${source.name}" must allow moving into Published videos; grant Editor access or use Drive OAuth (see docs/SETUP.md).` : "No source video available to check; no file was modified.");

  } catch (e) {
    add("Google Drive folder", false, summarizeError(e, 200));
  }
  let prov: Providers = {};
  try {
    prov = await providers(state);
  } catch (e) {
    add("YouTube OAuth refresh", false, summarizeError(e, 250));
    prov = {};
    const m = sec("META_PAGE_ACCESS_TOKEN");
    if (m) prov.meta = new Meta(m, cfg.meta.graphVersion, 1);
    const b = sec("BUFFER_API_KEY");
    if (b) prov.buffer = new Buffer(b, 1);
    const u = sec("UPLOAD_POST_API_KEY");
    if (u) prov.uploadPost = new UploadPost(u, cfg.destinations.youtube.regular.uploadPostProfile, 1);
  }
  const ids = await identities(prov);
  for (const [k, c] of Object.entries(ids)) add(`Identity: ${k}`, c.ok, c.detail);
  if (prov.meta) {
    const ti = await prov.meta.tokenInfo(sec("META_APP_ID"), sec("META_APP_SECRET"));
    add("Meta token permissions", ti.ok, ti.detail);
  }
  if (prov.buffer) {
    try {
      const plan = await prov.buffer.discover();
      add("Buffer API schema", plan.createArgsOk, plan.createArgsOk ? plan.summary : plan.problems.join("; "));
      const chans = await prov.buffer.channels();
      add("Buffer connected channels", null, chans.map((c) => `${c.service}: ${c.name} (${c.id})`).join("; ") || "none");
    } catch (e) {
      add("Buffer API schema", false, summarizeError(e, 200));
    }
  }
  const y = cfg.destinations.youtube;
  add("YouTube Short route (Buffer)", !!y.short.bufferChannelId && !!prov.buffer, y.short.bufferChannelId ? "Shorts via Buffer (public)" : "youtube.short.bufferChannelId not set — connect @EasyBosnian in Buffer");
  add("YouTube regular-video route (Upload-Post)", !!prov.uploadPost, prov.uploadPost ? `Upload-Post (audited integration, public; free plan ${y.regular.uploadPostMonthlyLimit} uploads/month)` : `UPLOAD_POST_API_KEY missing — fallback: ${y.regular.fallbackPrivateOfficialApi ? "PRIVATE upload via the official API (manual publishing)" : "manual upload"}`);
  add("YouTube OAuth app status", null, "Must be 'In production' in Google Cloud (Testing-status refresh tokens expire after 7 days). Not readable via API — confirm in the console.");
  const url = env("STATE_API_URL");
  const token = sec("STATE_API_TOKEN");
  if (url && token) {
    try {
      const r = await new KvHosting(url, token, 0).selfTest();
      add("Temporary video hosting (Workers KV)", !/problem|failed/.test(r), r);
    } catch (e) {
      add("Temporary video hosting (Workers KV)", false, summarizeError(e, 200));
    }
  } else add("Temporary video hosting (Workers KV)", false, "STATE_API_URL / STATE_API_TOKEN not configured (needed for Instagram and Buffer)");
  const big = r2();
  if (big) {
    try {
      const r = await big.selfTest();
      add("Optional R2 hosting (files > 24 MB)", !/ALLOWED|failed/.test(r), r);
    } catch (e) {
      add("Optional R2 hosting (files > 24 MB)", false, summarizeError(e, 200));
    }
  } else add("Optional R2 hosting (files > 24 MB)", null, "not configured (not needed for videos up to 24 MB)");
  if (sec("CLOUDFLARE_AI_TOKEN") && env("CLOUDFLARE_ACCOUNT_ID")) {
    try {
      const r = await makeCaptions("pozdravi_na_bosanskom.mp4", { accountId: env("CLOUDFLARE_ACCOUNT_ID"), token: sec("CLOUDFLARE_AI_TOKEN"), model: cfg.captions.model });
      add("Free caption model (Workers AI)", r.source === "generated", r.source === "generated" ? `${cfg.captions.model} answered with a valid Bosnian test caption` : r.notes.join(" "));
    } catch (e) {
      add("Free caption model (Workers AI)", false, summarizeError(e, 200));
    }
  } else add("Free caption model (Workers AI)", false, "CLOUDFLARE_AI_TOKEN not configured — the generic caption will always be used");
  add("Rotated-credential encryption key", !!sec("CREDENTIALS_ENCRYPTION_KEY"), sec("CREDENTIALS_ENCRYPTION_KEY") ? "configured" : "missing — a rotated refresh token could not be persisted");
  s.p("Verification mode: read-only identity and permission checks. Nothing is published and no source queue changes.");
  s.table(["Check", "OK", "Detail"], rows);
}

async function reconcile(s: Summary, state: StateClient) {
  const open = (await state.publications({ open: true })).publications;
  if (!open.length) {
    s.p("No open publications.");
    await cleanupFolder(s, state);
    return;
  }
  const prov = await providers(state).catch(() => ({}) as Providers);
  const metaToken = sec("META_PAGE_ACCESS_TOKEN");
  if (!prov.meta && metaToken) prov.meta = new Meta(metaToken, cfg.meta.graphVersion, 1);
  const bk = sec("BUFFER_API_KEY");
  if (!prov.buffer && bk) prov.buffer = new Buffer(bk, 0);
  const uk = sec("UPLOAD_POST_API_KEY");
  if (!prov.uploadPost && uk) prov.uploadPost = new UploadPost(uk, cfg.destinations.youtube.regular.uploadPostProfile, 0);
  const rows: string[][] = [];
  for (const p of open) {
    let o = null as null | { status: string; url?: string | null; detail?: string | null; remoteId?: string | null };
    if (!p.remote_id) o = null;
    else if (p.provider === "buffer" && prov.buffer) o = await prov.buffer.poll(p.remote_id, 0).catch(() => null);
    else if (p.provider === "upload_post" && prov.uploadPost) o = await prov.uploadPost.poll(p.remote_id, 0).catch(() => null);
    else if (p.platform === "youtube" && prov.youtube) o = await prov.youtube.poll(p.remote_id, cfg.destinations.youtube.apiProjectAudited, 0).catch(() => null);
    else if (p.platform === "instagram" && prov.meta && p.status !== "uncertain") o = await prov.meta.refresh("instagram", p.remote_id);
    else if (p.platform === "facebook" && prov.meta) o = await prov.meta.refresh("facebook", p.remote_id);
    if (o && o.status !== p.status && o.status !== "processing") {
      await state.upsertPublication({ runId: p.run_id, fileId: p.file_id, platform: p.platform, surface: p.surface, status: o.status, url: o.url ?? null, detail: `reconcile: ${o.detail ?? ""}` });
      rows.push([String(p.id), p.platform, p.surface, `${statusLabel(p.status)} → ${statusLabel(o.status)}`, o.url ?? ""]);
    } else rows.push([String(p.id), p.platform, p.surface, `${statusLabel(p.status)} (unchanged)`, p.url ?? p.remote_id ?? ""]);
  }
  s.p("Reconcile reads provider status and cleans up confirmed Drive sources; it never re-sends a publication.");
  s.table(["ID", "Platform", "Surface", "Status", "Link / ID"], rows);
  await cleanupFolder(s, state);
}

const cmd = process.argv[2];
const handlers: Record<string, () => Promise<void>> = { configure: cmdConfigure, scheduled: cmdScheduled, tools: cmdTools };
if (!handlers[cmd]) {
  console.error("usage: main.ts configure|scheduled|tools");
  process.exit(2);
}
handlers[cmd]().catch((e) => {
  console.error(`ERROR: ${summarizeError(e, 500)}`);
  process.exit(1);
});
