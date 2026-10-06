// Buffer GraphQL API (https://api.buffer.com) for TikTok video posts and, where eligible, YouTube Shorts.
//
// Buffer's public API is new; field names are discovered by schema introspection at runtime and checked
// in "verify" mode. If the schema does not offer what we need, the request is NOT sent (safe failure).
// A GraphQL validation error also means nothing was created.
import { HttpStatusError, NetworkError, json, sleep } from "../http";
import { AmbiguousOutcome, SafeFailure } from "../../../src/shared/status";
import { summarizeError } from "../../../src/shared/redact";
import type { Gate, IdentityCheck, Outcome, Progress } from "./types";

const ENDPOINT = "https://api.buffer.com";

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  type: TypeRef;
  args?: { name: string; type: TypeRef }[];
}
interface FullType {
  name: string;
  kind: string;
  fields?: Field[] | null;
  inputFields?: Field[] | null;
  enumValues?: { name: string }[] | null;
  possibleTypes?: { name: string }[] | null;
}

const TYPE_FIELDS = `name kind fields { name type { ...T } args { name type { ...T } } } inputFields { name type { ...T } } enumValues { name } possibleTypes { name }`;
const T_FRAG = `fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;

const unwrap = (t: TypeRef | null | undefined): TypeRef | null => {
  let x = t ?? null;
  while (x && (x.kind === "NON_NULL" || x.kind === "LIST")) x = x.ofType ?? null;
  return x;
};
const isList = (t: TypeRef | null | undefined): boolean => {
  let x = t ?? null;
  while (x) {
    if (x.kind === "LIST") return true;
    x = x.ofType ?? null;
  }
  return false;
};

export interface BufferPlan {
  createArgsOk: boolean;
  problems: string[];
  mutation: string;
  buildInput: (o: { channelId: string; text: string; videoUrl: string; youtube?: { title: string; categoryId: string; madeForKids: boolean } }) => Record<string, unknown>;
  postQuery: string;
  postVars: (id: string) => Record<string, unknown>;
  summary: string;
}

export class Buffer {
  private types = new Map<string, FullType | null>();
  private plan: BufferPlan | null = null;

  constructor(private apiKey: string, private pollMaxMinutes: number) {}

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}, label = "buffer"): Promise<{ data: T | null; errors?: { message: string }[] }> {
    return json(ENDPOINT, {
      label,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      timeoutMs: 120_000,
    });
  }

  private async type(name: string): Promise<FullType | null> {
    if (this.types.has(name)) return this.types.get(name)!;
    const r = await this.gql<{ __type: FullType | null }>(`query($n: String!) { __type(name: $n) { ${TYPE_FIELDS} } } ${T_FRAG}`, { n: name }, "buffer introspection");
    const t = r.data?.__type ?? null;
    this.types.set(name, t);
    return t;
  }

  /** Discover how to create a video post and read its status. */
  async discover(): Promise<BufferPlan> {
    if (this.plan) return this.plan;
    const problems: string[] = [];
    const schema = await this.gql<any>(`{ __schema { mutationType { name } queryType { name } } }`, {}, "buffer schema");
    const mutType = await this.type(schema.data?.__schema?.mutationType?.name ?? "Mutation");
    const qType = await this.type(schema.data?.__schema?.queryType?.name ?? "Query");
    const create = mutType?.fields?.find((f) => f.name === "createPost");
    if (!create) problems.push("mutation createPost not found");
    const inputArg = create?.args?.find((a) => a.name === "input");
    const inputTypeName = unwrap(inputArg?.type)?.name ?? "CreatePostInput";
    const input = await this.type(inputTypeName);
    const fields = new Map((input?.inputFields ?? []).map((f) => [f.name, f]));
    for (const need of ["channelId", "text", "schedulingType", "mode", "assets"]) if (!fields.has(need)) problems.push(`${inputTypeName}.${need} missing`);

    const enumHas = async (field: string, value: string) => {
      const t = unwrap(fields.get(field)?.type);
      const e = t?.name ? await this.type(t.name) : null;
      return !!e?.enumValues?.some((v) => v.name === value);
    };
    if (fields.has("schedulingType") && !(await enumHas("schedulingType", "automatic"))) problems.push("schedulingType has no 'automatic' value");
    if (fields.has("mode") && !(await enumHas("mode", "shareNow"))) problems.push("mode has no 'shareNow' value");

    // assets: either [{ video: { url } }] or { videos: [{ url }] }
    const assetsType = unwrap(fields.get("assets")?.type);
    const assetsT = assetsType?.name ? await this.type(assetsType.name) : null;
    const assetFields = new Map((assetsT?.inputFields ?? []).map((f) => [f.name, f]));
    let assetShape: "list_video" | "videos" | null = null;
    if (isList(fields.get("assets")?.type) && assetFields.has("video")) assetShape = "list_video";
    else if (assetFields.has("videos")) assetShape = "videos";
    else problems.push("assets input has neither video nor videos");

    // metadata.youtube
    const metaT = fields.has("metadata") ? await this.type(unwrap(fields.get("metadata")!.type)!.name!) : null;
    const ytField = metaT?.inputFields?.find((f) => f.name === "youtube");
    const ytT = ytField ? await this.type(unwrap(ytField.type)!.name!) : null;
    const ytFields = new Map((ytT?.inputFields ?? []).map((f) => [f.name, f]));
    let ytPrivacy: string | null = null;
    if (ytFields.has("privacy")) {
      const pe = await this.type(unwrap(ytFields.get("privacy")!.type)!.name!);
      ytPrivacy = pe?.enumValues?.find((v) => /^public$/i.test(v.name))?.name ?? null;
    }

    // payload: union/interface with a success member containing "post" and an error member with "message"
    const payloadName = unwrap(create?.type)?.name ?? "";
    const payload = payloadName ? await this.type(payloadName) : null;
    let selection = "";
    if (payload?.kind === "UNION" || payload?.kind === "INTERFACE") {
      const parts: string[] = ["__typename"];
      for (const pt of payload.possibleTypes ?? []) {
        const t = await this.type(pt.name);
        const names = new Set((t?.fields ?? []).map((f) => f.name));
        if (names.has("post")) parts.push(`... on ${pt.name} { post { id } }`);
        else if (names.has("message")) parts.push(`... on ${pt.name} { message }`);
      }
      selection = parts.join(" ");
    } else if (payload?.kind === "OBJECT") {
      const names = new Set((payload.fields ?? []).map((f) => f.name));
      selection = names.has("post") ? `post { id }` : names.has("id") ? "id" : "";
    }
    if (!/post \{ id \}|^id$/.test(selection)) problems.push(`cannot find the created post id in ${payloadName || "createPost result"}`);

    // reading a post back
    const postField = qType?.fields?.find((f) => f.name === "post");
    const postT = await this.type("Post");
    const postFieldNames = new Map((postT?.fields ?? []).map((f) => [f.name, f]));
    const wanted = ["id", "status", "externalLink", "dueAt", "sentAt"].filter((n) => {
      const f = postFieldNames.get(n);
      const k = unwrap(f?.type)?.kind;
      return f && (k === "SCALAR" || k === "ENUM");
    });
    const errField = postFieldNames.get("error");
    let errSel = "";
    if (errField) {
      const et = unwrap(errField.type);
      if (et?.kind === "SCALAR") errSel = "error";
      else if (et?.name) {
        const t = await this.type(et.name);
        if (t?.fields?.some((f) => f.name === "message")) errSel = "error { message }";
      }
    }
    let postQuery = "";
    let postVars: (id: string) => Record<string, unknown> = () => ({});
    const pArg = postField?.args?.[0];
    if (postField && pArg?.name === "input") {
      const it = unwrap(pArg.type)?.name;
      postQuery = `query($input: ${it}!) { post(input: $input) { ${[...wanted, errSel].filter(Boolean).join(" ")} } }`;
      postVars = (id) => ({ input: { id } });
    } else if (postField && pArg?.name === "id") {
      postQuery = `query($id: ${unwrap(pArg.type)?.name ?? "ID"}!) { post(id: $id) { ${[...wanted, errSel].filter(Boolean).join(" ")} } }`;
      postVars = (id) => ({ id });
    } else problems.push("query post(...) not found; cannot confirm publication");
    if (!wanted.includes("status")) problems.push("Post.status not available; cannot confirm publication");

    const mutation = `mutation($input: ${inputTypeName}!) { createPost(input: $input) { ${selection} } }`;
    const plan: BufferPlan = {
      createArgsOk: problems.length === 0,
      problems,
      mutation,
      postQuery,
      postVars,
      buildInput: (o) => {
        const inp: Record<string, unknown> = { channelId: o.channelId, text: o.text, schedulingType: "automatic", mode: "shareNow" };
        inp.assets = assetShape === "videos" ? { videos: [{ url: o.videoUrl }] } : [{ video: { url: o.videoUrl } }];
        if (o.youtube) {
          if (!ytFields.has("title")) throw new SafeFailure("Buffer schema has no YouTube title field");
          const y: Record<string, unknown> = { title: o.youtube.title };
          if (ytFields.has("categoryId")) y.categoryId = o.youtube.categoryId;
          if (ytFields.has("madeForKids")) y.madeForKids = o.youtube.madeForKids;
          if (ytPrivacy) y.privacy = ytPrivacy;
          if (ytFields.has("notifySubscribers")) y.notifySubscribers = true;
          inp.metadata = { youtube: y };
        }
        return inp;
      },
      summary: `createPost(${inputTypeName}; assets=${assetShape}; payload=${payloadName}); post fields: ${[...wanted, errSel].filter(Boolean).join(", ")}; youtube metadata: ${[...ytFields.keys()].join(", ") || "none"}`,
    };
    this.plan = plan;
    return plan;
  }

  async channels(): Promise<{ id: string; name: string; service: string; extra: string }[]> {
    const acct = await this.gql<any>(`{ account { organizations { id name } } }`, {}, "buffer account");
    if (acct.errors?.length) throw new Error(`Buffer account query failed: ${acct.errors[0].message}`);
    const out: { id: string; name: string; service: string; extra: string }[] = [];
    const chT = await this.type("Channel");
    const optional = ["serviceId", "displayName", "isDisconnected", "isLocked", "type"].filter((n) => chT?.fields?.some((f) => f.name === n && ["SCALAR", "ENUM"].includes(unwrap(f.type)?.kind ?? "")));
    const q = await this.type("Query");
    const chArg = q?.fields?.find((f) => f.name === "channels")?.args?.find((a) => a.name === "input");
    const chInput = chArg ? await this.type(unwrap(chArg.type)!.name!) : null;
    const orgType = unwrap(chInput?.inputFields?.find((f) => f.name === "organizationId")?.type)?.name ?? "String";
    const inputType = unwrap(chArg?.type)?.name ?? "ChannelsInput";
    for (const org of acct.data?.account?.organizations ?? []) {
      const r = await this.gql<any>(`query($i: ${inputType}!) { channels(input: $i) { id name service ${optional.join(" ")} } }`, { i: { organizationId: org.id } }, "buffer channels");
      if (r.errors?.length) throw new Error(`Buffer channels query failed (${orgType}): ${r.errors[0].message}`);
      for (const c of r.data?.channels ?? []) out.push({ id: c.id, name: c.name, service: c.service, extra: optional.map((k) => `${k}=${c[k]}`).join(", ") });
    }
    return out;
  }

  async verifyChannel(channelId: string, service: "tiktok" | "youtube", expectedName: string | null): Promise<IdentityCheck> {
    if (!channelId) return { ok: false, detail: `Buffer ${service} channel ID is not configured` };
    try {
      const chans = await this.channels();
      const c = chans.find((x) => x.id === channelId);
      if (!c) return { ok: false, detail: `Buffer channel ${channelId} not found. Connected: ${chans.map((x) => `${x.service}:${x.name} (${x.id})`).join("; ") || "none"}` };
      if (c.service.toLowerCase() !== service) return { ok: false, detail: `Buffer channel ${channelId} is ${c.service}, expected ${service}` };
      if (/isDisconnected=true|isLocked=true/.test(c.extra)) return { ok: false, detail: `Buffer channel ${c.name} is disconnected/locked (${c.extra})` };
      const nameOk = !expectedName || c.name.replace(/^@/, "").toLowerCase() === expectedName.toLowerCase();
      if (!nameOk) return { ok: false, detail: `Buffer ${service} channel is "${c.name}", expected "${expectedName}"` };
      return { ok: true, detail: `Buffer ${service} channel "${c.name}" (${c.id})${c.extra ? `; ${c.extra}` : ""}` };
    } catch (e) {
      return { ok: false, detail: `Buffer check failed: ${summarizeError(e, 200)}` };
    }
  }

  async publish(o: { channelId: string; text: string; videoUrl: string; youtube?: { title: string; categoryId: string; madeForKids: boolean } }, gate: Gate, progress: Progress): Promise<Outcome> {
    let plan: BufferPlan;
    try {
      plan = await this.discover();
    } catch (e) {
      throw new SafeFailure(`Buffer schema discovery failed (nothing sent): ${summarizeError(e, 200)}`);
    }
    if (!plan.createArgsOk) throw new SafeFailure(`Buffer API schema mismatch, post not sent: ${plan.problems.join("; ")}`);
    const input = plan.buildInput(o);
    const g = await gate();
    if (!g.allowed) return { status: "disabled", detail: `Not sent to Buffer: ${g.reason}` };
    let res: { data: any; errors?: { message: string }[] };
    try {
      res = await this.gql(plan.mutation, { input }, "buffer createPost");
    } catch (e) {
      if (e instanceof HttpStatusError && e.status >= 400 && e.status < 500) throw new SafeFailure(`Buffer refused the post: HTTP ${e.status} ${e.bodySummary.slice(0, 200)}`);
      if (e instanceof NetworkError && !e.afterSend) throw new SafeFailure(`Buffer request not sent: ${e.message}`);
      throw new AmbiguousOutcome(`Buffer createPost response lost (${summarizeError(e, 150)}); a post may exist in Buffer — check the Buffer queue/history, then resolve.`);
    }
    const payload = res.data?.createPost;
    if (!payload) {
      if (res.errors?.length) throw new SafeFailure(`Buffer rejected the post: ${res.errors.map((x) => x.message).join("; ").slice(0, 300)}`);
      throw new AmbiguousOutcome("Buffer returned no post and no error; check Buffer, then resolve.");
    }
    const postId: string | undefined = payload.post?.id ?? payload.id;
    if (!postId) throw new SafeFailure(`Buffer did not create the post: ${String(payload.message ?? payload.__typename ?? "unknown error").slice(0, 300)}`);
    await progress("processing", postId, "accepted by Buffer (not yet proof of publication)");
    return this.poll(postId, this.pollMaxMinutes);
  }

  async poll(postId: string, maxMinutes: number): Promise<Outcome> {
    const plan = await this.discover();
    const deadline = Date.now() + maxMinutes * 60_000;
    let last = "unknown";
    do {
      try {
        const r = await this.gql<any>(plan.postQuery, plan.postVars(postId), "buffer post status");
        const p = r.data?.post;
        if (p) {
          last = String(p.status);
          const err = typeof p.error === "string" ? p.error : p.error?.message;
          if (/^sent$/i.test(last)) {
            if (p.externalLink) return { status: "confirmed", remoteId: postId, url: p.externalLink, detail: `Buffer reports sent${p.sentAt ? ` at ${p.sentAt}` : ""}` };
            return { status: "processing", remoteId: postId, detail: "Buffer reports sent but has no platform link yet; run reconcile to confirm." };
          }
          if (/^error$/i.test(last)) return { status: "failed", remoteId: postId, detail: `Buffer reports error: ${String(err ?? "").slice(0, 250)}` };
          if (/needs_approval|draft/i.test(last)) return { status: "failed", remoteId: postId, detail: `Buffer post is in "${last}" state and will not be published automatically.` };
        }
      } catch {
        /* transient */
      }
      if (maxMinutes > 0) await sleep(60_000); // Buffer free plan: 3,000 API requests / 30 days
    } while (Date.now() < deadline);
    return { status: "processing", remoteId: postId, detail: `Buffer status "${last}" after ${maxMinutes} min; run reconcile later.` };
  }
}
