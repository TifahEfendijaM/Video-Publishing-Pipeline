# Operating guide

## The "Publish video" form (Actions → Publish video → Run workflow)

GitHub shows all four fields every time; fields that don't apply are ignored and the summary says so.
The dropdowns are static — they don't show your saved settings. To see those, run **Tools → status**
(or read the summary of any run).

| Field | Choices | Meaning |
|---|---|---|
| `run_mode` | `manual_now` | 1) turns automation **off** first (the saved schedule is kept for later), 2) picks one video, 3) publishes it now. Nothing else is planned. |
| | `automated` | Saves and enables the weekly schedule. **Does not publish now**; the next video goes out at the first future occurrence. Re-submitting replaces the settings (there is only ever one schedule). |
| `video_selection` | `fifo` / `lifo` | Oldest / newest video by the time it entered the Drive folder. Saved as the policy for future scheduled runs. |
| | `custom` | Uses `custom_video_name` once: in `manual_now` immediately; in `automated` for the next occurrence only. Does not change the saved FIFO/LIFO policy. |
| `custom_video_name` | text | Complete filename including extension. Empty / not found / duplicated name → the saved policy is used and the summary says why. |
| `schedule` | text | Weekly days + times in Europe/Sarajevo (automated only). Empty keeps the last saved schedule; initial default Friday 05:00. |

## Schedule syntax

Weekly recurring, Europe/Sarajevo time (summer/winter time handled automatically).

- Practical: `tuesday-5pm monday-6am friday 9-pm` → `Mon 06:00; Tue 17:00; Fri 21:00`
- Canonical: `Tue 17:00; Mon 06:00; Fri 21:00`
- Also accepted: `fri 5 a.m.`, `wed 19.30`, `mon 0600`, `tue 17h`, `noon`, `midnight`, `mon wed 5pm`
  (both days 17:00), `mon 6am 6pm` (two times), Bosnian day names (`petak 05:00`).
- Rejected with an explanation (old settings kept): `friday 9` (am or pm?), `5pm` (no day), `fri 13pm`,
  `fri 24:00`, dates like `2026-10-09`.
- Duplicates are removed and slots are sorted Monday-first.
- DST edge cases: a time that doesn't exist on the spring-forward night (02:00–02:59) runs one hour later;
  a time that happens twice on the autumn night runs once (the first time).

## Tools (Actions → Pipeline tools)

| Action | What it does | Publishes? |
|---|---|---|
| `status` | Saved settings, next occurrences, recent runs, scheduler dispatches (with GitHub HTTP status), open publications | no |
| `verify` | Checks every account identity, permission, folder, Buffer schema, R2 privacy, Worker target | no |
| `preview` | Read-only selection + media/format plan + captions + Story renders (artifact). `target` = optional filename | no |
| `dispatch_test` | Worker dispatches the scheduled workflow in non-publishing verification mode | no |
| `publishing_enable` / `publishing_disable` | Global kill switch (checked right before every publication) | — |
| `reconcile` | Re-reads provider status of processing/uncertain items; never re-sends | no |
| `resolve_publication` | After you checked manually: mark an uncertain item `confirmed` or `failed` (`target` = publication ID) | no |
| `retry_failed` | Re-attempts only the destinations that **definitively failed** in a run (`target` = run ID) | yes (only those) |

## How videos advance, and failures

- A video counts as published once any destination is processing/confirmed/uncertain; FIFO/LIFO then
  skips it (by Drive file ID — renaming doesn't reset it). Nothing restarts from the beginning: when all
  are used, the run reports **"No eligible videos available."** and publishes nothing.
- Every destination is attempted independently. Facebook failing doesn't stop Instagram, TikTok or YouTube.
- **Failed** means nothing was published there; `retry_failed` re-attempts only those, never the ones
  that succeeded. **Uncertain** (e.g. a response lost after the publish request) is never retried
  automatically: check the account, then `resolve_publication`.
- Scheduled runs that were queued before you changed settings (or chose `manual_now`) detect it and stop
  without publishing. The kill switch is re-checked immediately before each live publication step.

## Folder-entry times (FIFO/LIFO)

Ordering uses the time a file was uploaded or moved into the folder, from the **Drive Activity API**
(create/upload/move-into events). Drive's `createdTime` is *not* folder-entry time; it is used only when
no activity record exists, and is labelled "created time approximation" in summaries. Ties are broken by
Drive file ID.

## Captions

- Filenames made of IDs, numbers, dates or generic camera/export/AI-tool labels (e.g.
  `gemini_generated_video_0A28F2A0.mp4`, `178904548924381.mp4`, `Made with Veo 3.mp4`) get the reviewed
  generic caption in `config/generic-caption.json` — no topic is invented.
- Meaningful filenames (e.g. `kako_naruciti_kafu.mp4`) get a topic caption written by Claude from the
  filename hint only (treated as data), validated for Bosnian diacritics, banned content (CEFR levels,
  "mala ispravka", references to earlier/deleted posts or internal tooling, foreign links) and each
  platform's limits, and always ending with `👉easybosnian.com`. Any failure → generic caption, reported.
  Text is never truncated.

## Stories

- Instagram and Facebook Stories use the original file when it is already 9:16 H.264; otherwise the
  complete frame is letterboxed onto a 1080×1920 black canvas (no crop, no stretch).
- Over 60 s: no Story is posted (reported, nothing discarded) unless you approve chronological
  segmentation by setting `stories.longVideoPolicy` to `"segment"` in `config/pipeline.json`.
- TikTok Stories: unsupported (no API) — reported as manual.
