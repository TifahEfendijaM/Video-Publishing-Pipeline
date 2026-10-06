// In-memory D1 stand-in backed by node:sqlite, used to test the Worker logic with the real migration SQL.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Db, Stmt } from "../worker/src/logic";

export function makeDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_outros.sql"]) raw.exec(readFileSync(new URL(`../worker/migrations/${m}`, import.meta.url), "utf8"));
  const prepare = (sql: string): Stmt => {
    let params: unknown[] = [];
    const stmt: Stmt = {
      bind(...values: unknown[]) {
        params = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
        return stmt;
      },
      async first<T>() {
        return ((raw.prepare(sql).get(...(params as any[])) as T) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(params as any[])) as T[] };
      },
      async run() {
        const r = raw.prepare(sql).run(...(params as any[]));
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare, raw };
}
