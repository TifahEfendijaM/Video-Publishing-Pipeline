import { afterEach, describe, expect, it, vi } from "vitest";
import { Drive } from "../runner/src/google";

const archive = { id: "archive", name: "Published videos", mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: true } };
const source = () => ({ id: "video", name: "lesson.mp4", parents: ["input"], trashed: false, capabilities: { canMoveItemWithinDrive: true } });

describe("Drive archive moves", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves in a single parent update, then reads back membership without deleting anything", async () => {
    const file = source();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.method === "PATCH") {
        expect(u.searchParams.get("addParents")).toBe("archive");
        expect(u.searchParams.get("removeParents")).toBe("input");
        expect(u.searchParams.get("supportsAllDrives")).toBe("true");
        expect(JSON.parse(String(init.body))).toEqual({});
        file.parents = ["archive"];
      }
      return Response.json(u.pathname.endsWith("/archive") ? archive : file);
    });
    vi.stubGlobal("fetch", fetch);
    await new Drive("token", "input", { folderId: "archive" }).archive("video");
    expect(fetch.mock.calls.filter(([, i]) => i.method === "PATCH")).toHaveLength(1);
    expect(fetch.mock.calls.some(([, i]) => i.method === "DELETE")).toBe(false);
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("/files/video?");
  });

  it("creates the default child folder only when archiving, and uses it for later files", async () => {
    const file = source();
    let exists = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ name: "Published videos", mimeType: "application/vnd.google-apps.folder", parents: ["input"] });
        exists = true;
        return Response.json(archive);
      }
      if (u.pathname.endsWith("/files")) return Response.json({ files: exists ? [archive] : [] });
      if (u.pathname.endsWith("/archive")) return Response.json(archive);
      if (init.method === "PATCH") file.parents = ["archive"];
      return Response.json(file);
    });
    vi.stubGlobal("fetch", fetch);
    const d = new Drive("token", "input");
    expect(await d.publishedFolder(false)).toBeNull();
    expect(fetch.mock.calls.every(([, i]) => !i.method || i.method === "GET")).toBe(true);
    await d.archive("video");
    await d.archive("video"); // already moved: no duplicate folder or move
    expect(fetch.mock.calls.filter(([, i]) => i.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, i]) => i.method === "PATCH")).toHaveLength(1);
  });

  it("reuses an existing default archive and rejects ambiguous names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ files: [archive] })));
    expect((await new Drive("token", "input").publishedFolder(false))?.id).toBe("archive");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ files: [archive, { ...archive, id: "other" }] })));
    await expect(new Drive("token", "input").publishedFolder(true)).rejects.toThrow(/Multiple/);
  });

  it("refuses the source folder itself as the archive", async () => {
    await expect(new Drive("token", "input", { folderId: "input" }).publishedFolder()).rejects.toThrow(/must differ/);
  });

  it("leaves an inaccessible or externally moved source untouched", async () => {
    for (const file of [{ ...source(), parents: ["elsewhere"] }, { ...source(), capabilities: { canMoveItemWithinDrive: false } }]) {
      const fetch = vi.fn(async (url: string) => Response.json(new URL(url).pathname.endsWith("/archive") ? archive : file));
      vi.stubGlobal("fetch", fetch);
      await expect(new Drive("token", "input", { folderId: "archive" }).archive("video")).rejects.toThrow(/checkpoints retained|cannot move/);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("does not accept an unconfirmed move or failed provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(new URL(url).pathname.endsWith("/archive") ? archive : source())));
    await expect(new Drive("token", "input", { folderId: "archive" }).archive("video")).rejects.toThrow(/did not confirm/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("permission denied", { status: 403 })));
    await expect(new Drive("token", "input", { folderId: "archive" }).archive("video")).rejects.toThrow(/403/);
  });

  it("checks move/destination permissions without creating a folder", async () => {
    const fetch = vi.fn(async (url: string) => Response.json(new URL(url).pathname.endsWith("/archive") ? archive : source()));
    vi.stubGlobal("fetch", fetch);
    expect(await new Drive("token", "input", { folderId: "archive" }).canArchive("video")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
