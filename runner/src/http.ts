// Small fetch wrapper that separates "request never reached the provider" from "response lost".
import { redact } from "../../src/shared/redact";

export class HttpStatusError extends Error {
  constructor(public status: number, public bodySummary: string, public label: string) {
    super(`${label}: HTTP ${status} ${bodySummary}`);
    this.name = "HttpStatusError";
  }
}

export class NetworkError extends Error {
  constructor(public label: string, public cause_: unknown, public afterSend: boolean) {
    super(`${label}: network error (${(cause_ as Error)?.message ?? String(cause_)})`);
    this.name = "NetworkError";
  }
}

export interface RequestOpts extends RequestInit {
  label: string;
  timeoutMs?: number;
}

export async function request(url: string, opts: RequestOpts): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), opts.timeoutMs ?? 120_000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    // We cannot know whether the server processed the request (DNS failure is the only clearly-safe case).
    const msg = String((e as Error)?.message ?? e);
    const notSent = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|certificate/i.test(msg + String((e as any)?.cause?.code ?? ""));
    throw new NetworkError(opts.label, e, !notSent);
  } finally {
    clearTimeout(timer);
  }
}

export async function json<T = any>(url: string, opts: RequestOpts): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  if (!res.ok) throw new HttpStatusError(res.status, redact(text).slice(0, 300), opts.label);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpStatusError(res.status, "non-JSON response", opts.label);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
