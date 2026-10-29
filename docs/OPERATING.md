# Operating guide

## The "Publish video" form (Actions → Publish video → Run workflow)

GitHub shows all form fields every time; fields that don't apply are ignored and the summary says so.
The default form action is Scheduled → List jobs, which does not publish or change settings.
The dropdowns are static — they don't show your saved settings. To see those, run **Tools → status**
(or read the summary of any run).

| Field | Meaning |
|---|---|
| `run_mode` | `manual_now` publishes once; `automated` manages named scheduled jobs without publishing immediately. |
| `manual_schedule_action` | Manual only: `keep_schedule` (default) preserves every existing job; `stop_schedule` stops all active jobs before the one-off upload. |
| `job_action` | Scheduled only: `create`, `edit`, `delete`, or `list` (safe default). No Pause/Resume controls. |
| `job_name` | Create: unique new name. Edit/Delete: an existing name or ID copied from List jobs. Ignored for List/manual. |
| `video_selection` | `fifo`, `lifo`, `random`, `custom`, `rule`, or `keep_existing`. Create requires a real choice. Edit can keep the saved rule. Manual choices apply only to that upload. |
| `custom_video_name` | Manual Custom: one exact filename. Scheduled Custom: ordered CSV/newline list of exact filenames, quoting names containing commas. Blank on Edit preserves the remaining list. |
| `video_rule` | Scheduled `rule`: plain-English selection instruction, interpreted once by Workers AI, validated and shown in the run summary. Blank on Edit preserves an existing title rule. |
| `schedule` | Europe/Sarajevo weekly times. Required for Create; blank on Edit retains only that job's times. Ignored for List/Delete/manual. |

### Named jobs

Create adds a separate job without changing existing jobs. Duplicate names fail; names are matched
case-insensitively. Edit changes only the named job and invalidates its older queued occurrences, leaving
other jobs valid. Delete removes only that job and releases its unused Custom reservations; video files
and published posts are not deleted. Unknown names fail rather than creating a new job by accident.

**List jobs** ignores all other form fields and reports every job's name, times, selection rule, status,
next occurrence and **every remaining Custom filename in publication order**, as well as the count.
A Custom job publishes one item per occurrence, advances only after confirmed archival, and becomes
completed when its queue is empty. Missing files or uncertain/partial outcomes retain the queue and
require editing/recovery; the job never silently switches to an automatic video. Blank Custom input
on Edit keeps progress; entering a replacement list replaces only that job's remaining queue.

Files in exact Custom lists are reserved from other jobs and manual selections. FIFO/LIFO/Random and
title-rule jobs share the remaining live source folder. A video archived by one job is no longer available
to another. Outro assets are excluded from automatic rules and cannot be scheduled as standalone Custom
entries; deliberate manual Custom outro publication remains available.

For example, create `friday-newest` with `Fri 05:00` + LIFO, and separately create `midweek-random` with
`Wed 17:00` + Random. To change only the first job's rule, Edit `friday-newest`, leave schedule blank,
and choose FIFO. To stop the second job, Delete `midweek-random`.

### Plain-English selection rules

Choose `video_selection = rule` and enter, for example:

```text
Pick a random video whose title ends with [available].
```

The existing Cloudflare Workers AI connection interprets the sentence at configuration time, separately
from caption generation. The summary shows the saved interpretation, such as literal, case-insensitive
`ends_with "[available]"; RANDOM`. Runs then apply that saved rule consistently without an AI decision
every time. Matching checks the title before a known video extension, so `Lesson [available].mp4`
matches an ending rule, while `Lesson [available] draft.mp4` does not.

Supported interpretation: FIFO/LIFO/Random, optionally one literal title contains/starts-with/ends-with
condition. Ambiguous/unsupported requests fail before saving rather than becoming an approximate rule.
No code, regex, wildcards, content understanding or arbitrary file operations are executed. Use
**Tools → rule_preview**, putting the sentence in `target`, to inspect the interpretation without saving.

Title-rule jobs include future matching uploads. When no eligible file matches, they skip the occurrence
and wait for future matches. List jobs shows the rule and titles matching now; pending publishing outcomes
may hold a matching file. A fixed Custom list, in contrast, finishes when its entered queue is exhausted.

### Outro fields (`outro_youtube`, `outro_tiktok`, `outro_instagram`, `outro_facebook`)

- Enter the exact filename of a clip in the Drive folder (as Drive shows it) to choose that platform's outro.
- **With scheduled Create/Edit** the choice is **saved for that job** and used for its posts until edited.
- **With `manual_now`** the choice applies to **that one video only**; later posts go back to the saved outro.
- **Empty = no change.** Type `none` to switch that platform's outro off.
- **Default outro:** a platform with no saved choice uses the clip named exactly `outro` in the folder
  (`outros.defaultFileName` in `config/pipeline.json`). This applies to scheduled and manual runs alike;
  a clip entered in the form overrides it, and `none` turns it off for that platform.
- The outro is appended to the end of the main post (YouTube video and Short, TikTok video, Instagram Reel,
  Facebook video). Stories are posted without outros. The joined file keeps the main video's frame size;
  an outro of a different shape is fitted inside it with black bars, and a silent clip gets silence.
- Outro clips are never chosen by FIFO/LIFO/Random: neither the configured outro files nor **any file whose name
  contains "outro"** (name your outro clips e.g. `outro_youtube.mp4` so they are excluded even before you
  configure them). They can still be selected deliberately with `custom`.
- If an outro file is deleted or moved out of the folder, that platform is published without it and the
  summary says so. Changing outros never cancels an already-planned scheduled run.

### Manual uploads and existing jobs

`keep_schedule` leaves all jobs, their times, selection rules and remaining Custom lists untouched.
The manual selection/outro applies only to the current upload. It does not enable jobs or change the
publishing kill switch. A reserved Custom entry cannot be stolen by a one-off upload.

`stop_schedule` marks all active named jobs stopped before the upload and invalidates their queued
occurrences, retaining their settings and remaining queues. Edit a stopped job to start it again from its
next future occurrence, or Delete it to remove it and release reservations. There are no separate
Pause/Resume actions. Already-submitted platform publications cannot necessarily be recalled.

## Schedule syntax

Weekly recurring, Europe/Sarajevo time (summer/winter time handled automatically).

- Practical: `tuesday-5pm monday-6am friday 9-pm` → `Mon 06:00; Tue 17:00; Fri 21:00`
- Recommended format: `Mon 06:00; Wed 17:00; Fri 21:00` (24-hour clock).
- Select `run_mode = automated`, then Create/Edit and a job name. Create requires times; blank on Edit
  keeps that job's timetable. The next upload is at the next future slot, never immediately.
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
| `status` | All named jobs with full remaining Custom lists, defaults, next occurrences, recent runs and open publications | no |
| `rule_preview` | Interpret the plain-English instruction in `target` without saving or publishing | no |
| `verify` | Checks every account identity, permission, folder, Buffer schema, temporary-hosting privacy, free caption model, Worker target | no |
| `preview` | Read-only selection + media/format plan + captions + Story renders (artifact). `target` = optional filename | no |
| `dispatch_test` | Worker dispatches the scheduled workflow in non-publishing verification mode | no |
| `publishing_enable` / `publishing_disable` | Global kill switch (checked right before every publication) | — |
| `reconcile` | Re-reads provider status and retries Drive cleanup of confirmed sources; never re-sends | no |
| `resolve_publication` | After you checked manually: mark an uncertain item `confirmed` or `failed` (`target` = publication ID), then clean up if complete | no |
| `retry_failed` | Re-attempts only current **failed or skipped/disabled** destinations in a run (`target` = run ID) | yes (only those) |

## How videos advance, and failures

- The live source folder is the queue. FIFO/LIFO chooses by Drive upload/creation date; Random chooses
  uniformly from eligible sources; Custom chooses a filename. No permanent consumed-video table is used.
- After every supported destination confirms publication, the source moves into **Published videos**,
  and its temporary publication checkpoints and saved file references in run records are cleared.
  Unsupported/manual-only surfaces
  (such as TikTok Stories) do not block cleanup; there must be at least one confirmed publication.
  Outro clips (by name or saved/configured ID) are retained.
- Processing, uncertain, failed or skipped destinations prevent cleanup. If any destination may already be
  live, its source is temporarily excluded from automatic **and custom** publication to prevent duplicates.
  Other queued videos can advance. Recovery tools use per-destination checkpoints, rather than a permanent
  publishing-history cursor. Scheduler/run statuses remain for troubleshooting, with archived file details cleared.
- Cleanup failure is reported in the summary. The confirmed video cannot be re-uploaded accidentally;
  cleanup is retried before the next publishing run or via **Tools → reconcile**, even if there are no open
  publications. Reconcile and manual resolution also archive sources whose last pending destination confirms.
  If the move succeeded but checkpoint deletion failed, a later publishing run/reconcile clears those
  records after finding the source in the archive; the video is never re-uploaded.
- When no eligible source remains, the run reports **"No eligible videos available."** and publishes nothing.
- Every destination is attempted independently. Facebook failing doesn't stop Instagram, TikTok or YouTube.
- **Failed** means nothing was published there; `retry_failed` re-attempts only those, never the ones
  that succeeded. Skipped/disabled destinations can also be explicitly retried after fixing their configuration.
  A retry targeting an old run will not resend a destination that succeeded in a later retry.
  **Uncertain** (e.g. a response lost after the publish request) is never retried
  automatically: check the account, then `resolve_publication`.
- Editing/deleting a job invalidates only its queued occurrences. Manual `stop_schedule` stops all active jobs.
  Manual `keep_schedule` leaves all other runs valid. The kill switch
  is re-checked immediately before each live publication step.

## Upload dates and the Published videos folder

FIFO/LIFO reads each file's `createdTime` directly from Drive. Renaming, modifying or moving an old
file into the source folder does not change that original creation date. Equal dates are broken by file ID.
No Drive Activity API or stored folder-entry timestamps are needed.

By default, the pipeline finds or creates a **Published videos** child folder inside the source folder.
Only direct video children of the source folder are candidates, so archived videos are excluded.
To use a separate existing folder, set the GitHub repository variable `PUBLISHED_DRIVE_FOLDER_ID`
(or `publishedFolderId` in `config/pipeline.json`). It must differ from the source folder.
Duplicate default archive names require an explicit folder ID. Verify/preview never create folders or move files.
The move updates the file's parent and preserves its Drive ID; it never trashes or permanently deletes a file.

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
this ID while publication or cleanup is pending; renaming or replacing content does not bypass those
recovery checkpoints. Once the confirmed source is removed and checkpoints are cleared, a newly uploaded
copy (or a source deliberately restored to the folder) is eligible again, subject to live job reservations.

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


## Jobs due together

The Worker durably claims each due job independently, then dispatches a batch that processes pending job
occurrences sequentially. This avoids losing a job if GitHub replaces an older pending concurrency run.
Another batch can drain still-pending claims; started claims cannot be executed twice. One job failing
does not discard the other jobs. Missed clock ticks are not invented or backfilled.
