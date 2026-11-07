# EasyBosnian — automated video publishing pipeline

Publishes one video at a time from the Google Drive folder **EasyBosnian educational videos** to
Instagram (Reel + Story), Facebook (Reel or Page video + Story), TikTok (video post via Buffer) and
YouTube (a regular video via Upload-Post and a Short via Buffer for every clip), using one editable Europe/Sarajevo publishing plan or on demand.
Separate from the image-card pipeline: no shared code, Worker, database or credentials.

The source Drive folder is the publishing queue: confirmed sources move into **Published videos**,
then their temporary recovery checkpoints and saved file references are cleared. FIFO/LIFO uses Drive
upload dates, Random picks an eligible source, and Custom matches a filename. Partial/pending uploads
stay protected from duplicates, and outro assets remain in place. The old consumed-video/entry-time table
is removed. [Archive access and migration setup](docs/SETUP.md#drive-access-for-automatic-archival).

Scheduled mode provides **Edit / Pause / Resume** for one plan. You can describe the complete plan in
natural language, including "tonight"/"tomorrow", exact filenames, FIFO/LIFO and outro choices. An hourly
**ChatGPT cloud task** interprets requests and prepares English captions/titles in a private Drive Doc,
using the ChatGPT subscription. GitHub does not call a paid AI API or require an OpenAI API key.
Natural-language preparation can take up to 70 minutes; formatted entries remain immediate. The
preparation job does not hold the publishing lock. Relative dates use the submission time in Sarajevo,
and new past one-time uploads are rejected. Dated uploads use `Once on 2026-11-07 at 21:00: custom: "Video.mp4"`.

You can also pair each timetable with its rule in
one text field, for example `Mon and Wed 06:00: lifo | every two days at 18:00: random`. Day intervals keep a saved start-date anchor and Sarajevo wall-clock time across daylight-saving changes. Ordered Custom lists and
plain-English title filters work in the same field. The summary shows each rule and every remaining
Custom filename. Unchanged lists retain progress across edits; Pause/Resume retain the full plan.
Each timetable can choose its own outro, e.g. `Mon 06:00: lifo; outro: "End.mp4"`; omit it to retain an existing choice or use the default `outro` clip for a new entry. Use `outro: none` to disable it. Manual uploads use one combined entry, e.g. `custom: "Video.mp4"; outro: "End.mp4"`, and default to **Keep schedule**, with an optional **Pause schedule** choice.

```
Cloudflare Worker (cron * * * * *, UTC)            GitHub Actions (ubuntu runner)
  ├─ reads the Sarajevo publishing plan from D1           ├─ checks claim / kill switch / staleness
  ├─ due? → durable occurrence claims + batch           ├─ Drive: list folder, upload dates, download once
  └─ workflow_dispatch → scheduled-publish.yml ───▶  ├─ ffprobe → format plan; ffmpeg Story canvas
      (exact repo, workflow, branch; 1 attempt)      ├─ captions (ChatGPT-prepared or reviewed generic, validated)
                                                     ├─ Meta Graph · Buffer (TikTok, Shorts) · Upload-Post (YT video)
  D1 = single source of truth  ◀── state API ──────  └─ confirmed read-back → GitHub run summary
```

- **Use it:** [docs/OPERATING.md](docs/OPERATING.md) — the form fields, schedule syntax, tools, failure handling.
- **Set it up:** [docs/SETUP.md](docs/SETUP.md) — accounts, scopes, secrets, deployment, costs.
- **What each platform allows:** [docs/CAPABILITIES.md](docs/CAPABILITIES.md).
- **Cloud preparation task:** [docs/CHATGPT_TASK.md](docs/CHATGPT_TASK.md) — private handoff and bounded task procedure.

## Development

```bash
npm ci
npm run typecheck
npm test            # unit + Worker (node:sqlite D1 stand-in) + real ffmpeg tests
```

Layout: `src/shared` (schedule, selection, captions, media rules — used by both sides),
`worker/` (Cloudflare Worker + D1 migration), `runner/` (GitHub Actions side and provider adapters),
`config/` (pipeline settings, generic caption), `.github/workflows/`.

Safety defaults: the live-publishing kill switch starts **OFF**; destinations with unverified or
unconfigured identities are disabled; nothing is retried automatically after an uncertain outcome.
