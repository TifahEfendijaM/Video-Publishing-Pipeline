// Filename analysis and caption validation. Generation itself happens in runner/src/captioner.ts.

export const WEBSITE_ENDING = "👉easybosnian.com";

// Technical words that carry no topic on their own (camera/export/AI-tool labels).
const TECHNICAL = new Set(
  [
    "gemini", "generated", "video", "videos", "vid", "img", "image", "mov", "mvi", "dsc", "dji", "gopr", "pxl", "screen",
    "recording", "screenrecording", "screencast", "export", "exported", "final", "copy", "kopija", "edit", "edited",
    "untitled", "bez", "naslova", "clip", "output", "render", "rendered", "capture", "whatsapp", "signal", "telegram",
    "sora", "veo", "runway", "kling", "pika", "ai", "hd", "uhd", "fhd", "4k", "8k", "1080p", "720p", "2160p", "480p",
    "mp4", "mov", "webm", "mkv", "avi", "m4v", "reel", "reels", "short", "shorts", "story", "tiktok", "instagram", "ig",
    "fb", "yt", "youtube", "draft", "new", "novi", "test", "temp", "tmp", "file", "camera", "cam", "snapchat", "inshot",
    "capcut", "canva", "trim", "trimmed", "compressed", "converted", "version", "ver", "rev", "take", "scene", "part",
    "vertical", "horizontal", "landscape", "portrait", "audio", "sound", "music", "fps", "raw", "proxy", "master", "mux",
    // AI tools and "made with / created by" style labels
    "aigenerated", "generation", "generate", "gen", "chatgpt", "openai", "midjourney", "luma", "hailuo", "minimax", "heygen",
    "synthesia", "imagen", "grok", "nano", "banana", "dalle", "stable", "diffusion", "pixverse", "vidu", "seedance", "wan",
    "clipchamp", "made", "created", "creation", "with", "by", "using", "via", "from", "my", "our", "the", "and", "of",
    // Bosnian/regional generic labels
    "snimak", "snimka", "snimci", "generisano", "generiran", "generirano", "generisan", "napravljeno", "pomoću", "pomocu",
    "uz", "sa", "od", "moj", "moja", "moje", "videozapis", "videa", "klip", "verzija", "konačno", "konacno", "finalno",
  ].map((w) => w.toLowerCase()),
);

const VOWELS = /[aeiouyàáâäåèéêëìíîïòóôöùúûü]/i;

export interface FilenameAnalysis {
  meaningful: boolean;
  topicHint: string | null; // filename-derived topic hint (data, never instructions)
  stem: string;
  reason: string;
}

function isNoiseToken(tok: string): boolean {
  const t = tok.toLowerCase();
  if (TECHNICAL.has(t)) return true;
  if (/^\d+$/.test(t)) return true; // numbers, IDs, dates without separators
  if (/^v\d+$/.test(t) || /^(final|copy)\d*$/.test(t)) return true;
  if (/^\(?\d+\)?$/.test(t)) return true;
  if (/^[0-9a-f]{6,}$/i.test(t) && /\d/.test(t)) return true; // hex IDs
  if (/\d/.test(t) && /\p{L}/u.test(t)) return true; // mixed letters+digits: IDs, codes, camera labels
  if (t.length <= 2) return true;
  if (!VOWELS.test(t) && !/r/.test(t)) return true; // consonant soup (Bosnian syllabic r allowed: "prst", "crn")
  if (/(.)\1\1/.test(t)) return true; // "aaaa", "xxx"
  return false;
}

export function analyzeFilename(filename: string): FilenameAnalysis {
  const base = filename.normalize("NFC").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const spaced = base
    .replace(/[_\-.+~=,;:()[\]{}#@!'"`]+/g, " ")
    .split(/\s+/)
    // split camelCase ("KakoNaruciti" -> "Kako Naruciti") unless the whole token is a known label ("ChatGPT")
    .map((t) => (TECHNICAL.has(t.toLowerCase()) ? t : t.replace(/([a-zčćšžđ])([A-ZČĆŠŽĐ])/g, "$1 $2")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // Remove dates / times before tokenising further.
  const noDates = spaced
    .replace(/\b\d{4}\s?\d{2}\s?\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\s\d{1,2}\s\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = noDates.split(" ").filter(Boolean);
  const words = tokens.filter((t) => !isNoiseToken(t));
  const letters = words.join("").replace(/[^\p{L}]/gu, "").length;
  if (words.length === 0 || letters < 4) {
    return {
      meaningful: false,
      topicHint: null,
      stem: base,
      reason: "filename consists of IDs, numbers, dates or generic camera/export/AI-tool labels",
    };
  }
  const hint = words.join(" ").slice(0, 120);
  return { meaningful: true, topicHint: hint, stem: base, reason: "filename contains topic words" };
}

// ---------------------------------------------------------------------------
// Platform text limits (checked by validateCaptionSet). Counting rules:
//  - instagram caption: 2,200 characters, max 30 hashtags, max 20 @-mentions (counted in UTF-16 units, conservative)
//  - facebook description: 63,206 characters (UTF-16 units)
//  - tiktok caption via Buffer: 2,200 (TikTok counts UTF-16 runes)
//  - youtube title: 100 characters, no "<" or ">"; description: 5,000 BYTES (UTF-8), no "<" or ">"

export const LIMITS = {
  instagramCaption: 2200,
  instagramHashtags: 30,
  instagramMentions: 20,
  facebookText: 63206,
  tiktokCaption: 2200,
  youtubeTitleChars: 100,
  youtubeDescriptionBytes: 5000,
} as const;

export interface CaptionSet {
  caption: string; // Instagram Reel, Facebook, TikTok
  youtubeTitle: string;
  youtubeDescription: string;
}

const CEFR = /\b(A1|A2|B1|B2|C1|C2)\b/;
const FORBIDDEN: [RegExp, string][] = [
  [/mala ispravka/i, 'mentions "mala ispravka"'],
  [/\b(obrisan\w*|izbrisan\w*|ponovo objavljen\w*|ranij\w* verzij\w*|prethodn\w* verzij\w*)\b/i, "references deleted/earlier posts or versions"],
  [/\b(pipeline|automatizacij\w*|automatsk\w* objav\w*|github|cloudflare|drive|api)\b/i, "references internal pipeline operations"],
  [/Ã|Ä|Å¡|Å¾|Ä‡|Ä/, "contains broken (mojibake) characters"],
];

export function utf16Length(s: string): number {
  return s.length;
}
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function validateLearnerText(text: string, label: string): string[] {
  const errs: string[] = [];
  if (text !== text.normalize("NFC")) errs.push(`${label}: not NFC-normalised`);
  if (CEFR.test(text)) errs.push(`${label}: contains a CEFR level, which must not be invented`);
  for (const [re, why] of FORBIDDEN) if (re.test(text)) errs.push(`${label}: ${why}`);
  const domains = text.match(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[\p{L}\p{N}-]+\.(com|ba|net|org|io|me|co|app|link|ly)\b/giu) ?? [];
  for (const d of domains) {
    if (!/^(https?:\/\/)?(www\.)?easybosnian\.com\/?$/i.test(d)) errs.push(`${label}: contains a link other than easybosnian.com`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) errs.push(`${label}: contains control characters`);
  return errs;
}

export function validateCaptionSet(c: CaptionSet): string[] {
  const errs: string[] = [];
  const caption = c.caption.trimEnd();
  if (!caption.endsWith(WEBSITE_ENDING)) errs.push(`caption must end exactly with "${WEBSITE_ENDING}"`);
  if (caption.split(WEBSITE_ENDING).length - 1 !== 1) errs.push("caption must contain the website ending exactly once");
  errs.push(...validateLearnerText(caption, "caption"));
  if (utf16Length(caption) > LIMITS.instagramCaption) errs.push(`caption is ${utf16Length(caption)} characters (Instagram limit ${LIMITS.instagramCaption})`);
  if (utf16Length(caption) > LIMITS.tiktokCaption) errs.push(`caption exceeds TikTok limit ${LIMITS.tiktokCaption}`);
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtags > LIMITS.instagramHashtags) errs.push(`caption has ${hashtags} hashtags (Instagram max ${LIMITS.instagramHashtags})`);
  const mentions = caption.match(/@[\p{L}\p{N}_.]+/gu)?.length ?? 0;
  if (mentions > LIMITS.instagramMentions) errs.push(`caption has ${mentions} mentions (Instagram max ${LIMITS.instagramMentions})`);

  const title = c.youtubeTitle.trim();
  if (title.length === 0) errs.push("YouTube title is empty");
  if ([...title].length > LIMITS.youtubeTitleChars || utf16Length(title) > LIMITS.youtubeTitleChars) errs.push(`YouTube title exceeds ${LIMITS.youtubeTitleChars} characters`);
  if (/[<>]/.test(title)) errs.push('YouTube title contains "<" or ">"');
  errs.push(...validateLearnerText(title, "YouTube title"));

  const desc = c.youtubeDescription.trimEnd();
  if (utf8Bytes(desc) > LIMITS.youtubeDescriptionBytes) errs.push(`YouTube description is ${utf8Bytes(desc)} bytes (limit ${LIMITS.youtubeDescriptionBytes})`);
  if (/[<>]/.test(desc)) errs.push('YouTube description contains "<" or ">"');
  if (!desc.includes("easybosnian.com")) errs.push("YouTube description must include easybosnian.com");
  errs.push(...validateLearnerText(desc, "YouTube description"));
  return errs;
}
