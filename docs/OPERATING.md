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

### Outro fields (`outro_youtube`, `outro_tiktok`, `outro_instagram`, `outro_facebook`)

- Enter the exact filename of a clip in the Drive folder (as Drive shows it) to choose that platform's outro.
- **With `automated`** the choice is **saved** and used for every later post until you change it.
- **With `manual_now`** the choice applies to **that one video only**; later posts go back to the saved outro.
- **Empty = no change.** Type `none` to switch that platform's outro off.
- **Default outro:** a platform with no saved choice uses the clip named exactly `outro` in the folder
  (`outros.defaultFileName` in `config/pipeline.json`). This applies to scheduled and manual runs alike;
  a clip entered in the form overrides it, and `none` turns it off for that platform.
- The outro is appended to the end of the main post (YouTube video and Short, TikTok video, Instagram Reel,
  Facebook video). Stories are posted without outros. The joined file keeps the main video's frame size;
  an outro of a different shape is fitted inside it with black bars, and a silent clip gets silence.
- Outro clips are never chosen by FIFO/LIFO: neither the configured outro files nor **any file whose name
  contains "outro"** (name your outro clips e.g. `outro_youtube.mp4` so they are excluded even before you
  configure them). They can still be selected deliberately with `custom`.
- If an outro file is deleted or moved out of the folder, that platform is published without it and the
  summary says so. Changing outros never cancels an already-planned scheduled run.

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
| `verify` | Checks every account identity, permission, folder, Buffer schema, temporary-hosting privacy, free caption model, Worker target | no |
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

## YouTube: a Short AND a regular video for every clip

YouTube treats an upload as a **Short** when it is vertical or square and at most 3 minutes, and as a
**regular video** otherwise. To get both from one clip, the pipeline makes the missing shape without
cutting anything:

| Source clip | Regular video (Upload-Post) | Short (Buffer) |
|---|---|---|
| Horizontal (16:9), ≤ 3 min | original file | whole frame placed in a 1080×1920 vertical frame, black bars above and below |
| Vertical / square, ≤ 3 min | whole frame placed in a 1920×1080 widescreen frame, black bars left and right | original file |
| Longer than 3 min | original file | none (Shorts max 3 min) — reported, nothing is cut |

The shape is read from each file with ffprobe, so mixed folders work. The `preview` tool attaches both
versions as a private artifact. Note: posting the same clip twice on one channel is your explicit choice;
YouTube may treat near-duplicate uploads as repetitive content, so keep an eye on channel feedback.
Upload-Post's free plan (10/month) is used only for the regular video.

## What "same video" means (Drive file ID)

Every file in Google Drive has a permanent ID (the long code in its link, e.g.
`…/file/d/1p6_I1DeHCe2fKSSdDo3F69aqDiwUrmak/view`). Renaming a file, or uploading a new version via
"Manage versions", keeps the ID; uploading a separate copy creates a new ID. The pipeline tracks videos by
this ID, so a renamed or replaced-in-place file counts as the **same** video and is not republished
automatically; a newly uploaded file counts as new. Use `custom` to republish deliberately.

## Captions (English)

All captions, YouTube titles and descriptions are written in **English** (for English speakers learning
Bosnian). A Bosnian word or phrase from the topic may appear, spelled with correct diacritics.

- Filenames made of IDs, numbers, dates or generic camera/export/AI-tool labels (e.g.
  `gemini_generated_video_0A28F2A0.mp4`, `178904548924381.mp4`, `Made with Veo 3.mp4`) get the reviewed
  generic English caption in `config/generic-caption.json` — no topic is invented. Edit that file to change it.
- Meaningful filenames (e.g. `na vrh brda vrba mrda.mp4`) get a topic caption written by a free Cloudflare
  Workers AI model (Llama 3.3 70B) from the filename hint only (treated as data). The output is rejected if it
  does not read as English or uses Cyrillic, and is validated for banned content (CEFR levels, corrections,
  references to earlier/deleted posts or internal tooling, foreign links) and each platform's limits, always
  ending with `👉easybosnian.com`. Any failure → generic caption, reported. Text is never truncated.

## Stories

- Instagram and Facebook Stories use the original file when it is already 9:16 H.264; otherwise the
  complete frame is letterboxed onto a 1080×1920 black canvas (no crop, no stretch).
- Over 60 s (not expected): split chronologically into equal consecutive Stories of ≤ 60 s that cover
  the whole video (`stories.longVideoPolicy = "segment"`, as you approved). Each part is reported separately
  (`story_part_1`, `story_part_2`, …).
- TikTok Stories: unsupported (no API) — reported as manual.
