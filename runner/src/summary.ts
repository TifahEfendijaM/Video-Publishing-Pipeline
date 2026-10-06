// Private GitHub Actions run summary (Markdown). Everything is redacted and escaped; no raw provider output.
import { appendFileSync } from "node:fs";
import { redact } from "../../src/shared/redact";
import { STATUS_LABEL, type PublicationStatus } from "../../src/shared/status";

export class Summary {
  private lines: string[] = [];

  h(level: number, text: string) {
    this.lines.push(`${"#".repeat(level)} ${esc(text)}`, "");
    return this;
  }
  p(text: string) {
    this.lines.push(esc(text), "");
    return this;
  }
  kv(rows: [string, string | number | boolean | null | undefined][]) {
    this.lines.push("| | |", "|---|---|");
    for (const [k, v] of rows) this.lines.push(`| **${cell(k)}** | ${cell(v === null || v === undefined || v === "" ? "—" : String(v))} |`);
    this.lines.push("");
    return this;
  }
  table(head: string[], rows: (string | null | undefined)[][]) {
    this.lines.push(`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`);
    for (const r of rows) this.lines.push(`| ${r.map((c) => cell(c ?? "—")).join(" | ")} |`);
    this.lines.push("");
    return this;
  }
  code(text: string) {
    const t = redact(text).replace(/```/g, "ʼʼʼ");
    this.lines.push("```text", t, "```", "");
    return this;
  }
  list(items: string[]) {
    for (const i of items) this.lines.push(`- ${esc(i)}`);
    this.lines.push("");
    return this;
  }
  text(): string {
    return this.lines.join("\n");
  }
  write() {
    const out = this.text();
    const f = process.env.GITHUB_STEP_SUMMARY;
    if (f) appendFileSync(f, out + "\n");
    else console.log(out);
  }
}

function esc(s: string): string {
  return redact(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function cell(s: string): string {
  return esc(s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function statusLabel(s: PublicationStatus | string): string {
  return (STATUS_LABEL as Record<string, string>)[s] ?? s;
}
