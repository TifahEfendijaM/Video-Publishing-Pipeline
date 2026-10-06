import { readFileSync } from "node:fs";
import { registerSecret } from "../../src/shared/redact";

export interface PipelineConfig {
  driveFolderId: string;
  driveFolderName: string;
  timeZone: string;
  editedFilePolicy: "same_video";
  destinations: {
    instagram: { enabled: boolean; provider: "meta_graph"; expectedUserId: string; expectedUsername: string; reel: boolean; story: boolean };
    facebook: { enabled: boolean; provider: "meta_graph"; expectedPageId: string; expectedPageName: string; story: boolean };
    tiktok: { enabled: boolean; provider: "buffer"; expectedBufferChannelId: string; expectedUsername: string; story: "unsupported" };
    youtube: {
      enabled: boolean;
      expectedChannelId: string;
      provider: "auto" | "official" | "buffer";
      apiProjectAudited: boolean;
      uploadPrivateWhenUnaudited: boolean;
      bufferChannelId: string;
      categoryId: string;
      madeForKids: boolean;
    };
  };
  stories: { longVideoPolicy: "skip" | "segment" };
  captions: { model: string; effort: "low" | "medium" | "high" };
  meta: { graphVersion: string };
  hosting: { presignedUrlTtlSeconds: number };
  polling: { metaMaxMinutes: number; bufferMaxMinutes: number; youtubeMaxMinutes: number };
}

export function loadConfig(path = new URL("../../config/pipeline.json", import.meta.url)): PipelineConfig {
  return JSON.parse(readFileSync(path, "utf8")) as PipelineConfig;
}

export const SECRET_NAMES = [
  "STATE_API_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "META_PAGE_ACCESS_TOKEN",
  "META_APP_ID",
  "META_APP_SECRET",
  "BUFFER_API_KEY",
  "ANTHROPIC_API_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/** Register every secret value for redaction, and return a typed accessor. */
export function secrets(): (name: SecretName) => string | undefined {
  for (const n of SECRET_NAMES) {
    const v = process.env[n];
    registerSecret(v);
    if (n === "GOOGLE_SERVICE_ACCOUNT_JSON" && v) {
      try {
        registerSecret(JSON.parse(v).private_key);
      } catch {
        /* reported by verify */
      }
    }
  }
  return (n) => {
    const v = process.env[n];
    return v && v.trim() !== "" ? v : undefined;
  };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required setting ${name}`);
  return v;
}
