import { isVideo, resolveCustomName, type FolderVideo, type SelectionPolicy } from "./selection";

export type JobPolicy = SelectionPolicy | "custom" | "title_rule";
export interface CustomVideo { fileId: string; fileName: string }
export interface TitleRule { match: "contains" | "starts_with" | "ends_with"; text: string; order: SelectionPolicy }

/** CSV or newline-separated exact filenames. Quoted names may contain commas; doubled quotes escape quotes. */
export function parseCustomList(text: string): string[] {
  const names: string[] = [];
  let field = "", quoted = false, closed = false;
  const push = () => {
    const value = field.normalize("NFC").trim();
    if (value) names.push(value);
    field = ""; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === "," || c === "\n" || c === "\r") push();
    else if (c === '"' && !field.trim() && !closed) { field = ""; quoted = true; }
    else if (closed && c.trim()) throw new Error("Unexpected text after a quoted filename");
    else if (!closed) field += c;
  }
  if (quoted) throw new Error("Custom list has an unclosed quote");
  push();
  if (!names.length) throw new Error("Custom list must contain at least one filename");
  if (names.length > 500) throw new Error("Custom list supports at most 500 videos");
  return names;
}

export function resolveCustomList(text: string, videos: FolderVideo[]): CustomVideo[] {
  const ids = new Set<string>();
  return parseCustomList(text).map((name) => {
    const match = resolveCustomName(name, videos.filter(isVideo));
    if (match.kind !== "match") throw new Error(`Custom video "${name}" is ${match.kind === "ambiguous" ? "ambiguous" : "not in the source folder"}`);
    if (ids.has(match.video.id)) throw new Error(`Custom list repeats "${name}"`);
    ids.add(match.video.id);
    return { fileId: match.video.id, fileName: match.video.name };
  });
}

/** Match literal text, case-insensitively, against the title before a known video extension. */
export function matchesTitle(name: string, rule: TitleRule): boolean {
  const title = name.normalize("NFC").replace(/\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|wmv)$/i, "").trim().toLowerCase();
  const text = rule.text.normalize("NFC").trim().toLowerCase();
  if (!text) return false;
  return rule.match === "contains" ? title.includes(text) : rule.match === "starts_with" ? title.startsWith(text) : title.endsWith(text);
}
