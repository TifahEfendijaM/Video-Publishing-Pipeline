// Orchestration: build per-destination tasks from the media plan, then run them independently.
import type { PipelineConfig } from "./config";
import type { CaptionSet } from "../../src/shared/captions";
import type { FeedPlan, MediaInfo, StoryPlan } from "../../src/shared/media";
import { AmbiguousOutcome, SafeFailure, mayBeLive, type Platform, type PublicationStatus } from "../../src/shared/status";
import { summarizeError } from "../../src/shared/redact";
import type { Gate, IdentityCheck, Outcome, Progress } from "./providers/types";
import type { Meta } from "./providers/meta";
import type { Buffer } from "./providers/buffer";
import type { YouTube } from "./providers/youtube";

export interface TaskCtx {
  url?: string; // temporary hosted URL of mediaPath (only when needsUrl)
  gate: Gate;
  progress: Progress;
}

export interface Task {
  platform: Platform;
  surface: string;
  provider: string;
  format: string;
  mediaPath?: string;
  needsUrl: boolean;
  blocked?: { status: PublicationStatus; detail: string };
  run?: (ctx: TaskCtx) => Promise<Outcome>;
}

export interface TaskResult {
  platform: Platform;
  surface: string;
  provider: string;
  format: string;
  status: PublicationStatus;
  remoteId?: string | null;
  url?: string | null;
  detail?: string | null;
}

export interface ExecDeps {
  mayPublish: (runId: string) => Promise<{ allowed: boolean; reason: string | null }>;
  record: (r: TaskResult & { runId: string; fileId: string }) => Promise<void>;
  host?: (path: string) => Promise<{ key: string; url: string }>;
  unhost?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}

/** Run every task independently. One failure never stops the others; nothing is retried automatically. */
export async function executeTasks(runId: string, fileId: string, tasks: Task[], deps: ExecDeps): Promise<{ results: TaskResult[]; hostedKeys: string[] }> {
  const results: TaskResult[] = [];
  const hosted = new Map<string, Promise<{ key: string; url: string }>>();
  let stopAll: string | null = null;

  const gate: Gate = async () => {
    try {
      const g = await deps.mayPublish(runId);
      return { allowed: g.allowed, reason: g.reason };
    } catch (e) {
      return { allowed: false, reason: `could not confirm the kill switch / schedule state (${summarizeError(e, 100)}); failing closed` };
    }
  };

  for (const t of tasks) {
    const base = { platform: t.platform, surface: t.surface, provider: t.provider, format: t.format };
    const save = async (r: TaskResult) => {
      try {
        await deps.record({ ...r, runId, fileId });
      } catch (e) {
        deps.log?.(`WARNING: could not persist ${t.platform}/${t.surface} status: ${summarizeError(e, 120)}`);
      }
    };
    if (t.blocked) {
      const r = { ...base, status: t.blocked.status, detail: t.blocked.detail };
      results.push(r);
      await save(r);
      continue;
    }
    if (stopAll) {
      const r = { ...base, status: "disabled" as const, detail: stopAll };
      results.push(r);
      await save(r);
      continue;
    }
    const g = await gate();
    if (!g.allowed) {
      stopAll = `Not attempted: ${g.reason}`;
      const r = { ...base, status: "disabled" as const, detail: stopAll };
      results.push(r);
      await save(r);
      continue;
    }
    let current: TaskResult = { ...base, status: "initiated" };
    const progress: Progress = async (status, remoteId, detail) => {
      current = { ...current, status, remoteId: remoteId ?? current.remoteId, detail: detail ?? current.detail };
      await save(current);
    };
    try {
      let url: string | undefined;
      if (t.needsUrl) {
        if (!deps.host || !t.mediaPath) throw new SafeFailure("temporary video hosting (R2) is not configured; this destination needs a public video URL");
        if (!hosted.has(t.mediaPath)) hosted.set(t.mediaPath, deps.host(t.mediaPath));
        try {
          url = (await hosted.get(t.mediaPath)!).url;
        } catch (e) {
          throw new SafeFailure(`temporary hosting failed: ${summarizeError(e, 150)}`);
        }
      }
      const o = await t.run!({ url, gate, progress });
      current = { ...current, ...o, remoteId: o.remoteId ?? current.remoteId };
    } catch (e) {
      if (e instanceof SafeFailure) current = { ...current, status: "failed", detail: e.message };
      else if (e instanceof AmbiguousOutcome) current = { ...current, status: "uncertain", detail: e.message };
      else {
        // Unknown error after work started: we cannot prove nothing was published.
        const started = current.status !== "initiated" || !!current.remoteId;
        current = { ...current, status: started ? "uncertain" : "failed", detail: summarizeError(e, 250) };
      }
    }
    results.push(current);
    await save(current);
  }
  const hostedKeys: string[] = [];
  for (const p of hosted.values()) {
    try {
      hostedKeys.push((await p).key);
    } catch {
      /* failed upload */
    }
  }
  return { results, hostedKeys };
}

export function anyMayBeLive(results: TaskResult[]): boolean {
  return results.some((r) => mayBeLive(r.status));
}

// ---------------------------------------------------------------------------

export interface Providers {
  meta?: Meta;
  buffer?: Buffer;
  youtube?: YouTube;
  youtubeScopes?: string[];
}
export interface Identities {
  instagram: IdentityCheck;
  facebook: IdentityCheck;
  tiktok: IdentityCheck;
  youtube: IdentityCheck;
  youtubeBuffer: IdentityCheck;
}

export interface StoryFiles {
  plan: StoryPlan;
  files: { path: string; surface: string; label: string }[];
}

export function buildTasks(o: {
  cfg: PipelineConfig;
  info: MediaInfo;
  feed: FeedPlan;
  stories: StoryFiles;
  originalPath: string;
  captions: CaptionSet;
  providers: Providers;
  identities: Identities;
}): Task[] {
  const { cfg, feed, stories, originalPath, captions, providers, identities } = o;
  const d = cfg.destinations;
  const tasks: Task[] = [];
  const storyBlock = (): Task["blocked"] | undefined => {
    if (stories.plan.kind === "none") return { status: "unsupported", detail: stories.plan.reason };
    if (stories.plan.kind === "needs_decision") return { status: "unsupported", detail: stories.plan.reason };
    return undefined;
  };
  const storySurfaces = stories.files.length ? stories.files : [{ path: originalPath, surface: "story", label: "" }];

  // Instagram
  if (d.instagram.enabled && d.instagram.reel) {
    tasks.push({
      platform: "instagram",
      surface: "feed",
      provider: "meta_graph",
      format: "reel",
      mediaPath: originalPath,
      needsUrl: true,
      blocked: identityBlock(identities.instagram) ?? (!feed.instagram.check.ok ? { status: "unsupported", detail: `Source incompatible with Instagram Reels: ${feed.instagram.check.problems.join("; ")}. Not uploaded.` } : undefined) ?? (!providers.meta ? { status: "disabled", detail: "META_PAGE_ACCESS_TOKEN not configured" } : undefined),
      run: (c) => providers.meta!.instagram(d.instagram.expectedUserId, "REELS", c.url!, captions.caption, c.gate, c.progress),
    });
  }
  if (d.instagram.enabled && d.instagram.story) {
    for (const s of storySurfaces) {
      tasks.push({
        platform: "instagram",
        surface: s.surface,
        provider: "meta_graph",
        format: "story",
        mediaPath: s.path,
        needsUrl: true,
        blocked: identityBlock(identities.instagram) ?? storyBlock() ?? (!providers.meta ? { status: "disabled", detail: "META_PAGE_ACCESS_TOKEN not configured" } : undefined),
        run: (c) => providers.meta!.instagram(d.instagram.expectedUserId, "STORIES", c.url!, null, c.gate, c.progress),
      });
    }
  }
  // Facebook
  if (d.facebook.enabled) {
    tasks.push({
      platform: "facebook",
      surface: "feed",
      provider: "meta_graph",
      format: feed.facebook.format,
      mediaPath: originalPath,
      needsUrl: false,
      blocked: identityBlock(identities.facebook) ?? (!feed.facebook.check.ok ? { status: "unsupported", detail: `Source incompatible with Facebook: ${feed.facebook.check.problems.join("; ")}. Not uploaded.` } : undefined) ?? (!providers.meta ? { status: "disabled", detail: "META_PAGE_ACCESS_TOKEN not configured" } : undefined),
      run: (c) =>
        feed.facebook.format === "reel"
          ? providers.meta!.facebookReel(d.facebook.expectedPageId, originalPath, captions.caption, c.gate, c.progress)
          : providers.meta!.facebookPageVideo(d.facebook.expectedPageId, originalPath, captions.youtubeTitle, captions.caption, c.gate, c.progress),
    });
    if (d.facebook.story) {
      for (const s of storySurfaces) {
        tasks.push({
          platform: "facebook",
          surface: s.surface,
          provider: "meta_graph",
          format: "story",
          mediaPath: s.path,
          needsUrl: false,
          blocked: identityBlock(identities.facebook) ?? storyBlock() ?? (!providers.meta ? { status: "disabled", detail: "META_PAGE_ACCESS_TOKEN not configured" } : undefined),
          run: (c) => providers.meta!.facebookStory(d.facebook.expectedPageId, s.path, c.gate, c.progress),
        });
      }
    }
  }
  // TikTok (Buffer)
  if (d.tiktok.enabled) {
    tasks.push({
      platform: "tiktok",
      surface: "feed",
      provider: "buffer",
      format: "video",
      mediaPath: originalPath,
      needsUrl: true,
      blocked: identityBlock(identities.tiktok) ?? (!feed.tiktok.check.ok ? { status: "unsupported", detail: `Source incompatible with TikTok: ${feed.tiktok.check.problems.join("; ")}. Not uploaded.` } : undefined) ?? (!providers.buffer ? { status: "disabled", detail: "BUFFER_API_KEY not configured" } : undefined),
      run: (c) => providers.buffer!.publish({ channelId: d.tiktok.expectedBufferChannelId, text: captions.caption, videoUrl: c.url! }, c.gate, c.progress),
    });
    tasks.push({
      platform: "tiktok",
      surface: "story",
      provider: "none",
      format: "story",
      needsUrl: false,
      blocked: { status: "unsupported", detail: "No official TikTok API or Buffer route publishes TikTok Stories. Manual step: post the Story in the TikTok app if wanted." },
    });
  }
  // YouTube
  if (d.youtube.enabled) {
    tasks.push(youtubeTask(o));
  }
  return tasks;
}

function youtubeTask(o: Parameters<typeof buildTasks>[0]): Task {
  const { cfg, feed, originalPath, captions, providers, identities } = o;
  const y = cfg.destinations.youtube;
  const base = { platform: "youtube" as const, surface: "feed", format: feed.youtube.format, mediaPath: originalPath };
  const official = y.provider === "official" || (y.provider === "auto" && y.apiProjectAudited);
  const viaBuffer = !official && (y.provider === "buffer" || y.provider === "auto") && feed.youtube.format === "short" && !!y.bufferChannelId;

  if (official || (y.provider !== "buffer" && y.uploadPrivateWhenUnaudited)) {
    const privacy: "public" | "private" = y.apiProjectAudited ? "public" : "private";
    return {
      ...base,
      provider: "youtube_data_api",
      needsUrl: false,
      blocked: identityBlock(identities.youtube) ?? (!providers.youtube ? { status: "disabled", detail: "YouTube OAuth credentials not configured" } : undefined),
      run: (c) =>
        providers.youtube!.upload(originalPath, { title: captions.youtubeTitle, description: captions.youtubeDescription, categoryId: y.categoryId, madeForKids: y.madeForKids, privacyStatus: privacy }, c.gate, c.progress),
    };
  }
  if (viaBuffer) {
    return {
      ...base,
      provider: "buffer",
      needsUrl: true,
      blocked: identityBlock(identities.youtubeBuffer) ?? (!providers.buffer ? { status: "disabled", detail: "BUFFER_API_KEY not configured" } : undefined),
      run: (c) =>
        providers.buffer!.publish(
          { channelId: y.bufferChannelId, text: captions.youtubeDescription, videoUrl: c.url!, youtube: { title: captions.youtubeTitle, categoryId: y.categoryId, madeForKids: y.madeForKids } },
          c.gate,
          c.progress,
        ),
    };
  }
  const why =
    feed.youtube.format === "short"
      ? y.bufferChannelId
        ? "YouTube provider configuration excludes both routes"
        : "Shorts-eligible, but no YouTube channel is connected in Buffer (youtube.bufferChannelId empty) and the official API project is not audited for public uploads"
      : `${feed.youtube.reason}. Buffer only publishes YouTube Shorts, and the official YouTube API project is not audited (unaudited uploads are locked private)`;
  return { ...base, provider: "none", needsUrl: false, blocked: { status: "unsupported", detail: `${why}. Manual step: upload to YouTube Studio, or complete the YouTube API audit and set apiProjectAudited=true.` } };
}

function identityBlock(id: IdentityCheck) {
  return id.ok ? undefined : { status: "disabled" as const, detail: `Destination identity not verified: ${id.detail}` };
}
