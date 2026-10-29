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

Scheduled mode provides **Edit / Pause / Resume** for one plan. Pair each timetable with its rule in
one text field, for example `Mon and Wed 06:00: lifo | Fri 21:00: random`. Ordered Custom lists and
plain-English title filters work in the same field. The summary shows each rule and every remaining
Custom filename. Unchanged lists retain progress across edits; Pause/Resume retain the full plan.
Manual uploads default to **Keep schedule**, with an optional **Pause schedule** choice.

```
Cloudflare Worker (cron * * * * *, UTC)            GitHub Actions (ubuntu runner)
  ├─ reads the Sarajevo publishing plan from D1           ├─ checks claim / kill switch / staleness
  ├─ due? → durable occurrence claims + batch           ├─ Drive: list folder, upload dates, download once
  └─ workflow_dispatch → scheduled-publish.yml ───▶  ├─ ffprobe → format plan; ffmpeg Story canvas
      (exact repo, workflow, branch; 1 attempt)      ├─ captions (generic, or free Workers AI, validated)
                                                     ├─ Meta Graph · Buffer (TikTok, Shorts) · Upload-Post (YT video)
  D1 = single source of truth  ◀── state API ──────  └─ confirmed read-back → GitHub run summary
```

- **Use it:** [docs/OPERATING.md](docs/OPERATING.md) — the form fields, schedule syntax, tools, failure handling.
- **Set it up:** [docs/SETUP.md](docs/SETUP.md) — accounts, scopes, secrets, deployment, costs.
- **What each platform allows:** [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

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
