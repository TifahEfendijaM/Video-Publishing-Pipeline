// GitHub Actions runner entry point.
//   configure  — "Publish video" form (run_mode manual_now | automated)
//   scheduled  — dispatched by the Cloudflare Worker (or dispatch test)
//   tools      — status / verify / preview / dispatch_test / kill switch / reconcile / resolve / retry
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, secrets, type PipelineConfig } from "./config";
import { StateClient } from "./state-client";
import { Drive, DRIVE_SCOPES, serviceAccountEmail, serviceAccountToken, oauthAccessToken, syncEntryTimes } from "./google";
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
import { anyMayBeLive, buildTasks, executeTasks, type Identities, type Providers, type StoryFiles, type TaskResult } from "./publish";
import { Summary, statusLabel } from "./summary";
import { NO_ELIGIBLE_MESSAGE, selectVideo, type FolderVideo, type SelectionPolicy, type VideoRecord } from "../../src/shared/selection";
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

async function drive(): Promise<Drive> {
  const sa = sec("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured");
  return new Drive(await serviceAccountToken(sa, DRIVE_SCOPES), cfg.driveFolderId);
}

async function folderState(d: Drive, state: StateClient) {
  const videos = await d.listVideos(); // throws on auth/network errors — never treated as "not found"
  const rows = (await state.videos()).videos;
  const known = new Map(rows.map((r: any) => [r.file_id, { entrySource: r.entry_source }]));
  const sync = await syncEntryTimes(d, state, videos, known);
  const fresh = (await state.videos()).videos;
  const records = new Map<string, VideoRecord>(
    fresh.map((r: any) => [r.file_id, { fileId: r.file_id, enteredFolderAt: r.entered_folder_at, entrySource: r.entry_source, consumed: r.consumed === 1, md5AtPublication: r.md5_at_publication }]),
  );
  return { videos, records, notes: sync.notes, exactCount: sync.exactCount };
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
    ["Saved weekly schedule (Europe/Sarajevo)", `${s.scheduleText}${s.scheduleIsDefault ? " (initial default)" : ""}`],
    ["Saved selection policy", s.selectionPolicy.toUpperCase()],
    ["Pending one-time custom video", s.pendingCustom ? `${s.pendingCustom.fileName ?? ""} (${s.pendingCustom.fileId})` : "none"],
    ["Outros", ["youtube", "tiktok", "instagram", "facebook"].map((p) => `${p}: ${s.outros?.[p] === null ? "none (switched off)" : s.outros?.[p]?.fileName ?? (cfg.outros?.defaultFileName ? `default (${cfg.outros.defaultFileName})` : "none")}`).join("\n")],
    ["Live publishing kill switch", s.publishingEnabled ? "ON (live publishing allowed)" : "OFF (nothing will be published)"],
    ["Next scheduled occurrences", s.automationEnabled ? next.map((o) => o.local).join("\n") || "none" : "none (automation disabled)"],
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
  /** manual_now outro choices for this run only (platform -> clip, or null = no outro); not saved */
  outroOverrides?: Record<string, { fileId: string; fileName: string } | null>;
  summary: Summary;
  state: StateClient;
}

async function publishFlow(o: PublishOpts): Promise<string> {
  const s = o.summary;
  const d = await drive();
  const folder = await folderState(d, o.state);
  const savedOutros: Record<string, { fileId: string; fileName: string } | null> = (await o.state.state()).settings.outros ?? {};
  const outros = Object.fromEntries(
    (["youtube", "tiktok", "instagram", "facebook"] as const).map((p) => [p, effectiveOutro(o.outroOverrides && p in o.outroOverrides ? o.outroOverrides[p] : savedOutros[p], folder.videos, cfg.outros?.defaultFileName ?? "")]),
  );
  const excludeIds = new Set(Object.values(outros).flatMap((x) => (x ? [x.fileId] : [])));
  let sel;
  if (o.forcedFileId) {
    const v = folder.videos.find((x) => x.id === o.forcedFileId);
    if (!v) throw new Error(`Video ${o.forcedFileId} is no longer in the folder; cannot retry.`);
    sel = { ...selectVideo({ policy: o.policy, pendingCustomFileId: v.id, pendingCustomFileName: v.name, videos: [v], records: folder.records }), method: "retry" as const };
  } else {
    sel = selectVideo({ policy: o.policy, customName: o.customName, pendingCustomFileId: o.pendingCustom?.fileId, pendingCustomFileName: o.pendingCustom?.fileName, videos: folder.videos, records: folder.records, excludeIds });
  }
  s.h(2, "Video selection");
  s.kv([
    ["Method", sel.method === "custom" ? "custom (one-run override)" : sel.method.toUpperCase()],
    ["Fallback", sel.fallback ?? "none"],
    ["Eligible (not yet published) videos", sel.eligibleCount],
    ["Folder-entry times", `${folder.exactCount}/${folder.videos.length} exact from Drive Activity; others labelled approximations`],
  ]);
  if (folder.notes.length || sel.notes.length) s.list([...folder.notes, ...sel.notes]);
  if (!sel.video) {
    s.p(`**${NO_ELIGIBLE_MESSAGE}** Nothing was published.`);
    await o.state.finishRun({ runId: o.runId, status: "no_eligible_video", selectionMethod: sel.method, selectionNote: sel.fallback ?? undefined });
    return "no_eligible_video";
  }
  const v = sel.video;
  const rec = folder.records.get(v.id);
  s.kv([
    ["Selected file", v.name],
    ["Drive file ID", v.id],
    ["Entered folder", `${v.enteredAt} (${v.entrySource.replace(/_/g, " ")})`],
  ]);
  if (rec?.consumed && rec.md5AtPublication && v.md5 && rec.md5AtPublication !== v.md5) {
    s.p("Note: this file's content changed since it was published. Under the current policy an edited file is the same video (same Drive ID).");
  }

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
      s.h(2, "Planned destinations (preview — nothing was published, selection history unchanged)");
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
    if (anyMayBeLive(results)) await o.state.consumeVideo({ fileId: v.id, runId: o.runId, md5: v.md5 });
    // Keep hosted media only while a URL-fetching provider may still need it (lifecycle rule deletes it anyway).
    const urlPending = results.some((r) => (r.provider === "buffer" || r.platform === "instagram") && (r.status === "processing" || r.status === "initiated"));
    if (host && !urlPending) for (const k of hostedKeys) await host.remove(k).catch(() => {});

    reportResults(s, results);
    const status = results.every((r) => r.status === "confirmed" || r.status === "unsupported") ? "completed" : results.some((r) => r.status === "confirmed") ? "partial" : "not_published";
    await o.state.finishRun({ runId: o.runId, status, selectedFileId: v.id, selectedFileName: v.name, selectionMethod: sel.method, selectionNote: sel.fallback ?? undefined });
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
  const selection = env("VIDEO_SELECTION");
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
  if (!["fifo", "lifo", "custom"].includes(selection)) throw new Error("video_selection must be fifo, lifo or custom");
  const policyChoice = selection === "custom" ? null : (selection as SelectionPolicy);

  s.h(1, `EasyBosnian video — ${mode}`);
  if (mode === "manual_now") {
    const ignored: string[] = [];
    if (scheduleText.trim()) ignored.push("schedule (only used in automated mode)");
    if (selection !== "custom" && customName.trim()) ignored.push("custom_video_name (only used when video_selection = custom)");
    // 1) disable automation FIRST (retaining the saved schedule), 2) select, 3) publish now.
    const cfgView = await state.configureManual({ selectionPolicy: policyChoice, actor });
    const { notes: outroNotes, changes: outroOverrides } = await applyOutros(false);
    const begin = await state.beginRun({ origin: "manual", githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
    s.kv([
      ["Origin", "manual (manual_now)"],
      ["Started", new Date().toISOString()],
      ["Run ID", begin.runId],
      ["Ignored fields", ignored.join("; ") || "none"],
    ]);
    if (outroNotes.length) s.list(outroNotes);
    s.h(2, "Saved configuration (automation disabled before publishing)");
    s.kv(settingsRows(cfgView.settings, cfgView.nextOccurrences));
    try {
      const status = await publishFlow({
        runId: begin.runId!,
        origin: "manual",
        policy: cfgView.settings.selectionPolicy,
        customName: selection === "custom" ? customName : null,
        outroOverrides,
        summary: s,
        state,
      });
      s.p(`Run result: **${status}**. No further automatic publication is planned.`);
    } catch (e) {
      s.p(`Run failed before completion: ${summarizeError(e)}`);
      await state.finishRun({ runId: begin.runId!, status: "error" }).catch(() => {});
      s.write();
      throw e;
    }
    s.write();
    return;
  }

  // automated: validate locally (the Worker re-validates); resolve custom to a Drive file ID; save; do NOT publish.
  let normalized: string | null = null;
  try {
    const slots = parseSchedule(scheduleText);
    normalized = slots ? formatSchedule(slots) : null;
  } catch (e) {
    if (e instanceof ScheduleParseError) {
      s.p(`❌ Invalid schedule: ${e.message} The previous configuration was left unchanged.`);
      s.write();
      throw e;
    }
    throw e;
  }
  let pending: { fileId: string; fileName: string } | null = null;
  const notes: string[] = [];
  if (selection === "custom") {
    if (!customName.trim()) notes.push("Custom selected but the filename was empty: the saved FIFO/LIFO policy will be used.");
    else {
      const d = await drive(); // auth/network failures abort here and leave the configuration untouched
      const videos = await d.listVideos();
      const { resolveCustomName } = await import("../../src/shared/selection");
      const r = resolveCustomName(customName, videos);
      if (r.kind === "match") pending = { fileId: r.video.id, fileName: r.video.name };
      else if (r.kind === "not_found") notes.push(`No video named "${r.name}" in the folder: the saved FIFO/LIFO policy will be used.`);
      else if (r.kind === "ambiguous") notes.push(`${r.count} videos are named "${r.name}": ambiguous, so the saved FIFO/LIFO policy will be used.`);
    }
  } else if (customName.trim()) notes.push("custom_video_name ignored because video_selection is not custom.");
  notes.push(...(await applyOutros(true)).notes);
  const view = await state.configureAutomated({ scheduleText: normalized, selectionPolicy: policyChoice, pendingCustom: pending, actor });
  s.kv([
    ["Origin", "manual configuration (automated)"],
    ["Submitted schedule", scheduleText.trim() ? `${scheduleText.trim()} → ${normalized}` : "(empty — kept the saved schedule)"],
    ["Published now?", "No — the next video is published at the first future occurrence below."],
  ]);
  if (notes.length) s.list(notes);
  if (pending) s.p(`One-time custom video for the next occurrence: ${pending.fileName} (${pending.fileId}). Afterwards the saved ${view.settings.selectionPolicy.toUpperCase()} policy resumes.`);
  s.h(2, "Effective saved configuration");
  s.kv(settingsRows(view.settings, view.nextOccurrences));
  const perMonth = Math.round(view.settings.scheduleEffective.length * 4.35 * 10) / 10;
  if (cfg.destinations.youtube.regular.enabled && perMonth > cfg.destinations.youtube.regular.uploadPostMonthlyLimit) {
    s.p(`⚠️ This schedule means about ${perMonth} videos per month, but Upload-Post's free plan allows ${cfg.destinations.youtube.regular.uploadPostMonthlyLimit} uploads per month (used for the regular YouTube video). Once the limit is reached, those uploads are refused (never billed) and reported as failed until the next month.`);
  }
  if (!view.settings.publishingEnabled) s.p("⚠️ The live publishing kill switch is OFF: scheduled runs will run and report, but will not publish until it is switched on (Tools → publishing_enable).");
  s.write();
}

async function cmdScheduled() {
  const s = new Summary();
  const state = stateClient();
  const begin = await state.beginRun({ origin: "scheduled", occurrenceKey: env("OCCURRENCE_KEY"), claimToken: process.env.CLAIM_TOKEN, githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
  const st = await state.state();
  const key = env("OCCURRENCE_KEY");
  const scheduledLocal = /^\d{4}-/.test(key) ? (await import("../../src/shared/schedule")).localLabel(Date.parse(key)) : "n/a (dispatch test)";
  s.h(1, begin.kind === "dispatch_test" ? "EasyBosnian video — dispatch test" : "EasyBosnian video — scheduled run");
  s.kv([
    ["Origin", begin.kind === "dispatch_test" ? "dispatch test (non-publishing)" : "scheduled (Cloudflare Worker)"],
    ["Scheduled Sarajevo time", scheduledLocal],
    ["Actual start", new Date().toISOString()],
    ["Run ID", begin.runId ?? "—"],
  ]);
  s.h(2, "Saved configuration");
  s.kv(settingsRows(st.settings, st.nextOccurrences));
  if (!begin.allowed) {
    s.p(`${begin.kind === "dispatch_test" ? "✅ Dispatch verified: the Worker reached this workflow on the intended branch with a valid claim." : "⏹️ Not publishing."} ${begin.reason ?? ""}`);
    if (begin.runId) await state.finishRun({ runId: begin.runId, status: begin.kind === "dispatch_test" ? "dispatch_verified" : "cancelled_stale" });
    s.write();
    return;
  }
  const custom = (await state.consumeCustom(begin.runId!)).custom;
  try {
    const status = await publishFlow({ runId: begin.runId!, origin: "scheduled", scheduledLocal, policy: begin.settings.selectionPolicy, pendingCustom: custom, summary: s, state });
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
  } else if (action === "verify") {
    await verify(s, state);
  } else if (action === "preview") {
    const st = await state.state();
    const begin = { runId: `preview-${Date.now()}` };
    s.p("Private preview: selection is computed read-only, nothing is published and the selection history is not changed. Story renditions are attached as a workflow artifact.");
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
  } else if (action === "retry_failed") {
    if (!target) throw new Error("retry_failed needs target = the run ID from the original run summary");
    const pubs = (await state.publications({ runId: target })).publications;
    const failed = pubs.filter((p: any) => isRetryable(p.status as PublicationStatus));
    if (!failed.length) {
      s.p("Nothing to retry: no definitively failed destinations in that run (uncertain/processing outcomes are never retried automatically).");
    } else {
      const begin = await state.beginRun({ origin: "retry", githubRunId: env("GITHUB_RUN_ID"), githubRunUrl: runUrl() });
      const st = await state.state();
      s.p(`Retrying only: ${failed.map((p: any) => `${p.platform}/${p.surface}`).join(", ")}`);
      await publishFlow({ runId: begin.runId!, origin: "retry", policy: st.settings.selectionPolicy, forcedFileId: failed[0].file_id, filter: new Set(failed.map((p: any) => `${p.platform}:${p.surface}`)), summary: s, state });
    }
  } else throw new Error(`unknown tool action ${action}`);
  s.write();
}

/** Wrap the state client so preview mode cannot write selection history or publications. */
function readOnly(state: StateClient): StateClient {
  return new Proxy(state, {
    get(target, prop, recv) {
      if (prop === "observe") return async () => ({ ok: true, readOnly: true });
      if (["consumeVideo", "upsertPublication", "finishRun", "consumeCustom", "configureManual", "configureAutomated", "setPublishing"].includes(String(prop))) {
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
    add("Google Drive folder", f.id === cfg.driveFolderId && f.mimeType === "application/vnd.google-apps.folder", `"${f.name}" (${f.id}) via ${serviceAccountEmail(sa!)}; ${vids.length} videos`);
    try {
      const at = await d.folderEntryTimes();
      add("Drive Activity (folder-entry times)", true, `${vids.filter((v) => at.has(v.id)).length}/${vids.length} videos have an exact create/move-in time`);
    } catch (e) {
      add("Drive Activity (folder-entry times)", false, summarizeError(e, 200));
    }
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
  s.p("Verification mode: read-only identity and permission checks. Nothing is published and no selection history changes.");
  s.table(["Check", "OK", "Detail"], rows);
}

async function reconcile(s: Summary, state: StateClient) {
  const open = (await state.publications({ open: true })).publications;
  if (!open.length) {
    s.p("No open publications.");
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
  s.p("Reconcile only reads provider status; it never re-sends a publication.");
  s.table(["ID", "Platform", "Surface", "Status", "Link / ID"], rows);
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
