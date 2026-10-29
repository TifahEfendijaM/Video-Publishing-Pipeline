# Operating guide

## The "Publish video" form (Actions → Publish video → Run workflow)

There is one publishing plan. You do not name, create or delete separate jobs. Scheduled mode offers
**Edit / Pause / Resume**. GitHub shows all fields every time; manual-only fields are ignored in scheduled
mode and plan-only fields are ignored for one-off uploads. The default is Scheduled → Edit with a blank
plan, which simply reports the saved plan without changing it.

| Field | Meaning |
|---|---|
| `run_mode` | `automated` edits/pauses/resumes the plan, never publishes immediately. `manual_now` publishes one video now. |
| `plan_action` | `edit` replaces the complete plan when text is supplied; `pause` and `resume` retain its rules and Custom progress. |
| `publishing_plan` | Pair every weekly timetable with its selection rule, separated by newlines or ` | `. Blank Edit retains the saved pairs and Custom progress. Ignored for Pause/Resume/manual. |
| `video_selection` | Manual only: one combined video/outro entry, such as `lifo; outro: "End.mp4"` or `custom: "Video.mp4"; outro: none`. Blank uses saved defaults. |
| `manual_schedule_action` | Manual only: `keep_schedule` (default) leaves the plan untouched; `pause_schedule` pauses it before the one-off upload. |

### Write paired timetables and rules

For example, enter this as lines or as one line with ` | ` between entries:

```text
Monday and Wednesday at 06:00: newest video first
Friday at 21:00: Pick a random video whose title ends with [available].
Sunday at 18:00: publish this list in order: "Video A.mp4", "Video B.mp4"
```

The timetable comes first, followed by a colon and space, then its rule. `=>` can also separate them.
Use **weekly weekdays and times**, in Europe/Sarajevo time, rather than calendar dates or relative dates.
The parser pairs each timetable with its rule before interpreting it; rules never depend on a matching
position in a separate field. Overlapping occurrences (two rules for the same weekday/time) are rejected.
There can be at most 20 entries and 50 weekly occurrences. Title-rule interpretation uses the existing
Workers AI connection at Edit time; scheduled runs use the saved interpretation without calling AI again.
Simple FIFO/LIFO/Random and exact lists are interpreted directly.

Supported selections:

- `fifo` / `oldest video first`: oldest Drive upload/creation date.
- `lifo` / `newest video first`: newest Drive upload/creation date.
- `random`: an eligible random source video.
- `custom: "First.mp4", "Second.mp4"` or `publish this list in order: ...`: a fixed ordered list of exact
  Drive filenames, including extensions. Quote names containing commas or `|`; double an embedded quote.
- Plain English such as `Pick a random video whose title ends with [available].`: FIFO/LIFO/Random,
  optionally one literal, case-insensitive title contains/starts-with/ends-with condition. Matching checks
  the title before its video extension, so `Lesson [available].mp4` matches that ending condition.

Ambiguous or unsupported schedules/rules fail before anything is saved. No regex, arbitrary code,
video-content understanding or external actions are executed. **Tools → plan_preview** interprets a plan
entered in `target`, without saving it or publishing; Custom filename existence is validated when saving.
The summary after Edit shows the saved interpretation, next times, a copyable plan and every remaining
Custom filename in order. **Tools → status** shows the same saved plan.

### Edit, Pause and Resume

**Edit** with nonblank plan text replaces the complete set of timetable/rule pairs. Include all pairs you
want to retain; omit a pair to remove it. No video files or published posts are deleted. Blank Edit leaves
all pairs and progress unchanged. The manual entry is ignored for scheduled runs. Edits validate
and save atomically, and invalidate older queued scheduled work.

An unchanged ordered Custom list keeps its remaining progress even if moved to different days, reordered
within the plan, or resubmitted with already archived filenames. A completed unchanged list stays completed.
Changing the list itself defines a replacement list, whose filenames must all exist in the source folder.
To retain progress when editing a list, enter only the desired remaining filenames. Edit while paused
keeps the plan paused; use Resume explicitly to restart it.

**Pause** retains all timetables, rules, outro choices, reservations and remaining Custom lists. It cancels
queued scheduled occurrences and prevents further publishing steps in running scheduled work. Posts
already submitted to a platform cannot necessarily be recalled. **Resume** continues at the next future
slot; paused or missed occurrences are not backfilled. Pause/Resume ignore the text and outro fields.

A Custom list publishes one item per occurrence and advances only after confirmed archival. Partial,
uncertain or missing files keep the head in place; the list never falls back to an unrelated video.
An empty list completes. Title-filter and automatic selections continue waiting for future eligible
uploads when none remain. Exact-list videos are reserved from other plan entries and manual selections.
Outros are excluded from automatic rules and cannot be scheduled as standalone Custom items; deliberate
manual `custom: "outro"` remains available.

### Per-timetable outros

Add an optional clause after the selection, for example:

```text
Mon 06:00: lifo; outro: "Outro A.mp4"
Fri 21:00: random; outro: "Outro B.mp4"
Sun 18:00: custom: "First.mp4", "Second.mp4"; outro: none
```

`outro:` sets all four main-video platforms for that entry. To choose separately per platform, use
`; youtube outro: "YT end.mp4"; tiktok outro: none; instagram outro: "IG end.mp4"; facebook outro: none`
instead. Quote filenames containing commas, semicolons or pipes. Each platform can be specified only once.
Missing or ambiguous newly specified filenames reject the entire edit before saving.

Omitting the clause keeps an existing entry's saved choices, including when its selection rule changes.
A new timetable defaults to the clip named `outro`. Use `outro: none` to disable it explicitly. Editing
outros never restarts an unchanged Custom list. The summary includes each entry's choices and a copyable
plan. A saved clip missing at publishing time is reported and that platform publishes without it.

### One-off video and outro entry

For `manual_now`, use the single `video_selection` field for both choices:

```text
custom: "Video.mp4"; outro: "End.mp4"
lifo; outro: "End.mp4"
random; outro: none
default; outro: "End.mp4"
```

These are alternative one-off entries, not a multi-line plan. `default` uses the saved one-off video
rule. Omit `; outro: ...` to use the existing saved/default outro choices; `outro: none` disables it.
An explicitly chosen outro applies to all four main-video platforms for this upload only. The separate
platform outro fields have been removed from the form. Missing or ambiguous requested video/outro
filenames fail before changing the schedule or publishing anything. Tools → `manual_preview` interprets
and validates the entry in `target` without publishing or changing settings.

Outros are appended to the main video posts, including both YouTube versions; Stories have no outro.
Configured clips and filenames containing "outro" are excluded from automatic standalone selection.
A deliberate manual Custom upload can still select one. A previously saved outro that goes missing is
reported at publishing time and the affected platform publishes without it.

### Manual uploads and the plan

`keep_schedule` leaves the plan, its paused/running state and remaining Custom lists untouched. The
manual selection/outro applies only to the current upload. It does not enable scheduling or change the
publishing kill switch. A reserved Custom entry cannot be stolen by a one-off upload.

`pause_schedule` pauses the plan before the upload, retaining its configuration and lists. Restart it
later with Scheduled → Resume. One-off uploads work while the scheduled plan is paused.

## Schedule syntax

Weekly recurring, Europe/Sarajevo time (summer/winter time handled automatically).

- Practical: `tuesday-5pm monday-6am friday 9-pm` → `Mon 06:00; Tue 17:00; Fri 21:00`
- Recommended format: `Mon 06:00; Wed 17:00; Fri 21:00` (24-hour clock).
- Select `run_mode = automated`, then Edit, and pair each timetable with a rule in `publishing_plan`.
  Blank retains the plan. The next upload is at a future slot, never immediately.
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
| `status` | Saved plan, paused/running state, full remaining Custom lists, defaults, next times, recent runs and open publications | no |
| `manual_preview` | Validate one-off video/outro text in `target` without changing settings or publishing | no |
| `plan_preview` | Interpret paired timetables/rules in `target` without saving or publishing | no |
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
- Editing or pausing the plan invalidates older scheduled occurrences. Manual `pause_schedule` pauses it.
  Manual `keep_schedule` leaves scheduled work valid. The kill switch
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
copy (or a source deliberately restored to the folder) is eligible again, subject to live Custom-list reservations.

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


## Timetables due together

The Worker durably claims each due plan entry independently, then dispatches a batch that processes pending
occurrences sequentially. This avoids losing an occurrence if GitHub replaces an older pending concurrency run.
Another batch can drain still-pending claims; started claims cannot be executed twice. One entry failing
does not discard the other entries. Missed clock ticks are not invented or backfilled.
