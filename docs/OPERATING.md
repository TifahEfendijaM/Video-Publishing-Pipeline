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
| `publishing_plan` | Describe the whole plan naturally, or pair timetables/rules with newlines or ` | `. Natural text is interpreted by Codex during this run. Blank Edit retains saved pairs/progress. Ignored for Pause/Resume/manual. |
| `video_selection` | Manual only: one combined video/destinations/outro entry, such as `lifo; outro: "End.mp4"` or `custom: "Video.mp4"; outro: none`. Blank uses saved defaults. |
| `manual_schedule_action` | Manual only: `keep_schedule` (default) leaves the plan untouched; `pause_schedule` pauses it before the one-off upload. |

### Write paired timetables and rules

You may instead enter ordinary language with explicit times and exact filenames, for example:

```text
Replace the plan: publish "Lesson.mp4" tonight at 21:00 without an outro. Starting tomorrow at 18:00, publish the newest video every third day with "Ending.mp4" as the outro.
```

Codex interprets natural input immediately within the GitHub run, then the existing validators check
its result. Ambiguity, an invalid result or a concurrent plan/progress edit fails without saving.
Formatted entries below skip AI. Specify whether to replace the whole plan or add/change an existing
entry when writing naturally. Formatted Edit still replaces the entire plan.
Manual natural text uses the same on-demand interpretation; exact manual entries skip that call.
Missing clock times or unclear filenames/order need clarification. Submit time-sensitive requests
before the intended upload. Relative dates use the timestamp when input preparation starts in
Europe/Sarajevo. A model call has a five-minute timeout; there is no hourly polling delay.

True one-time dates are supported, e.g. `Once on 2026-11-07 at 21:00: custom: "Lesson.mp4"; outro: none`.
This has only one possible occurrence. A new entry in the past is rejected; missed occurrences are
never backfilled. A one-time Custom entry takes exactly one filename.

For example, enter this as lines or as one line with ` | ` between entries:

```text
Monday and Wednesday at 06:00: newest video first
Friday at 21:00: Pick a random video whose title ends with [available].
Sunday at 18:00: publish this list in order: "Video A.mp4", "Video B.mp4"
```

The timetable comes first, followed by a colon and space, then its rule. `=>` can also separate them.
Use **weekly weekdays and times**, **every N days at a time**, or **Once on YYYY-MM-DD at HH:MM**, in Europe/Sarajevo time. A start date is optional for day intervals. Natural relative-date instructions are normalized by Codex before validation.
The parser pairs each timetable with its rule before interpreting it; rules never depend on a matching
position in a separate field. Overlapping occurrences (two rules for the same weekday/time) are rejected.
There can be at most 20 entries and 50 timetable slots. Title-rule interpretation uses the existing
on-demand Codex at Edit time; scheduled runs reuse the saved selection without interpreting it again.
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

### Every N days

Examples (each belongs in the complete publishing plan):

```text
every two days at 18:00: lifo; outro: none
every 3 days at 07:30 starting 2026-11-06: random; outro: "End.mp4"
daily at noon: fifo
```

Numeric intervals from 1–365 days are supported, as are written numbers one through twelve, `daily`,
`every day` and `every other day`. Use exactly one clock time per interval entry. Short forms and 12-hour
times such as `every two days at 6pm` are accepted. These are deterministic schedule forms, separate from
AI interpretation of video-title filters.

A new interval without a start date is anchored to the Sarajevo calendar date on which you save it.
If today's time is already past, it starts at the next matching date. The summary/copyable plan includes
`starting YYYY-MM-DD` and upcoming dates. Re-entering the same interval and time without a date retains
its saved anchor. If several phases exist for that interval/time, specify the start date explicitly.
The start date can be past or future. It defines the cycle; missed occurrences are never backfilled.

For example, `every 2 days at 18:00 starting 2026-11-06` means November 6, 8, 10, 12, and so on at
18:00 Sarajevo time. It does not restart each week or drift with upload completion. Daylight-saving
changes preserve the local clock time, so elapsed hours between runs may differ from exactly 48.
Pause/Resume retains the anchor and continues on the next future matching date.

Interval entries can share a plan with weekly entries and use the same selection, Custom-list and outro
options. Timetables that eventually collide at the same local clock time are rejected before saving.
For example, every two days at 18:00 will eventually coincide with Friday at 18:00; give them different
times. Monthly, hourly and arbitrary conversational recurrence rules are not supported.

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

### Choose publishing destinations

Use natural language in either `video_selection` or each scheduled plan rule. Codex interprets the
platform and format restrictions, then code validates the resulting destination list before publishing.
If no destinations are specified, the default is every configured platform, including **both** a YouTube
Short (when eligible) and a regular non-Short video.

Manual examples (replace the filename with an exact source filename):

```text
"Video.mp4" publish only on YouTube as a regular video
"Video.mp4" publish only as a Short on YouTube
"Video.mp4" publish on all platforms except on YouTube as a regular video (but still as a Short)
"Video.mp4" publish on all except TikTok
```

For a scheduled plan, give each timetable/rule its own choices, for example:

```text
Replace the plan: every Monday at 18:00 publish the newest video only on YouTube as a regular video. Every Friday at 21:00 pick a random video whose title ends with [available] and publish everywhere except TikTok.
```

Equivalent formatted entries skip AI:

```text
Mon 18:00: lifo; destinations: youtube/video
Fri 21:00: random video whose title ends with "[available]"; destinations: all except tiktok
Sun 19:00: custom: "Video.mp4"; destinations: youtube/short; outro: none
```

Supported destination names are `instagram/reel`, `instagram/story`, `facebook/feed`, `facebook/story`,
`tiktok/feed`, `youtube/short`, and `youtube/video`. A bare platform name selects all its supported
surfaces; `youtube` selects both versions. Lists are comma-separated; `all` and `all except ...` are
supported. An empty list or unknown destination is rejected. Destination restrictions do not bypass
account verification, global enable switches or media eligibility, and an unavailable Short never
falls back to another destination you excluded.

Each scheduled entry's choices apply to every video selected by that rule (including its Custom list).
They survive Pause/Resume and are shown in status, previews and the copyable plan. Updating only
choices retains Custom progress. Omission in a supplied replacement entry means **all** again; blank
Edit keeps the complete saved plan. Codex preserves unchanged entries' choices in an explicitly partial
or additive edit. Manual choices affect only the current upload and do not become saved defaults.

Only selected destinations get publication checkpoints. Excluded platforms neither upload nor block
completion: after selected publications are confirmed, the existing Drive archival and Custom-list
advancement rules still apply. Stories select all generated chronological parts.

Use **Tools → manual_preview / plan_preview** to inspect an entry without saving or publishing.

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

Weekly, every-N-days recurring, or dated one-time, Europe/Sarajevo time (summer/winter time handled automatically).

- Practical: `tuesday-5pm monday-6am friday 9-pm` → `Mon 06:00; Tue 17:00; Fri 21:00`
- Recommended format: `Mon 06:00; Wed 17:00; Fri 21:00` (24-hour clock).
- Select `run_mode = automated`, then Edit, and pair each timetable with a rule in `publishing_plan`.
  Blank retains the plan. The next upload is at a future slot, never immediately.
- Also accepted: `fri 5 a.m.`, `wed 19.30`, `mon 0600`, `tue 17h`, `noon`, `midnight`, `mon wed 5pm`
  (both days 17:00), `mon 6am 6pm` (two times), Bosnian day names (`petak 05:00`).
- Rejected with an explanation (old settings kept): `friday 9` (am or pm?), `5pm` (no day), `fri 13pm`,
  `fri 24:00`, bare dates like `2026-10-09` without the `Once on ... at ...` form.
- Duplicates are removed and slots are sorted Monday-first.
- DST edge cases: a time that doesn't exist on the spring-forward night (02:00–02:59) runs one hour later;
  a time that happens twice on the autumn night runs once (the first time).

## Tools (Actions → Pipeline tools)

| Action | What it does | Publishes? |
|---|---|---|
| `status` | Saved plan, paused/running state, full remaining Custom lists, defaults, next times, recent runs and open publications | no |
| `manual_preview` | Validate one-off video/outro text in `target` without changing settings or publishing | no |
| `plan_preview` | Interpret paired timetables/rules in `target` without saving or publishing | no |
| `verify` | Checks account identities, permissions, folder, Buffer schema, temporary-hosting privacy, dedicated Codex sign-in and Worker target; does not call Codex | no |
| `preview` | Read-only selection + media/format plan + captions + Story renders. Artifacts are uploaded only when the repository is private. `target` = optional filename | no |
| `caption_preview` | Generate and validate captions/title for the exact filename in `target`; no media upload, settings or queue changes | no |
| `dispatch_test` | Worker dispatches the scheduled workflow in non-publishing verification mode | no |
| `publishing_enable` / `publishing_disable` | Global kill switch (checked right before every publication) | — |
| `reconcile` | Re-reads provider status and retries Drive cleanup of confirmed sources; never re-sends | no |
| `resolve_publication` | After you checked manually: mark an uncertain item `confirmed` or `failed` (`target` = publication ID), then clean up if complete | no |
| `retry_failed` | Re-attempts only current **failed or skipped/disabled** destinations in a run (`target` = run ID); optional `destinations` narrows it to e.g. `instagram/feed,youtube/short,tiktok/feed` | yes (only those) |

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
  To exclude a destination reported as failed that you can already see live, set the Tools form's
  `destinations` field to only the destinations you want to recover. Unknown or ineligible destination
  names stop the retry before anything is sent. A blank field retains the existing retry-all-failures behavior.
  Upload-Post responses without definitive evidence are now treated as processing/uncertain rather than
  safe failures; this does not retroactively repair old checkpoints.
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
versions as an artifact only when the repository is private; public runs retain the text summary without uploading preview media. Note: posting the same clip twice on one channel is your explicit choice;
YouTube may treat near-duplicate uploads as repetitive content, so keep an eye on channel feedback.
Upload-Post's free plan (10/month) is used only for the regular video.

Instagram and Buffer fetch videos through temporary hosting. Files up to 24 MB use the existing free
Workers KV route unchanged. When R2 is not configured, larger files are automatically re-encoded to
fit below that limit with two-pass H.264/AAC encoding. The complete frame, full duration and audio are
retained; visual quality may be reduced. The source file in Drive is unchanged. The runner verifies the
encoded file's actual size and duration before uploading it; an encoding that cannot fit fails without
cutting the video. This also applies to Story renditions and clips with outros. The run summary reports
the original and compressed sizes. Shared media is encoded/hosted once per run and deleted after use.
An already configured optional R2 route still hosts oversized originals without this compression.

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
- Meaningful filenames (e.g. `na vrh brda vrba mrda.mp4`) get a topic caption generated by Codex
  during this GitHub run, using only the filename hint as data. Text must read as English and pass
  checks for Cyrillic, banned content (CEFR levels, corrections, earlier/deleted posts or internal
  tooling, foreign links) and platform limits. The runner appends `👉easybosnian.com`. Invalid text
  or an ordinary model failure uses the reported generic fallback; text is never truncated.
  Credential persistence/integrity failures stop the run before publishing.
- **Tools → caption_preview**, with an exact filename in `target`, tests captions without publishing,
  changing the queue or editing the plan. It consumes included subscription usage when AI is needed.

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


## Manual batch publishing (GitHub-hosted only)

From **Actions → Publish video → Run workflow**, choose `manual_now`, keep `manual_schedule_action=keep_schedule`, and put 2–20 exact Drive filenames in `video_selection`. Separate entries by ` | ` or newlines, including independent platform/YouTube-format and outro choices. Natural language is interpreted by the dedicated subscription Codex CLI on GitHub-hosted Actions; canonical entries can be entered directly. A missing destinations clause means every configured platform, including both eligible YouTube Short and regular video versions.

Example:

```text
custom: "Lesson One.mp4"; destinations: youtube/short; outro: none | custom: "Lesson Two.mp4"; destinations: instagram/reel, youtube/video; outro: "Ending.mp4"
```

Batch preflight resolves every exact filename and explicit outro, rejects duplicates, scheduled Custom reservations, missing/ambiguous or non-video files, overlap between source videos and outro assets, and existing confirmed or possibly-live publication checkpoints. It checks Drive folder membership before any publishing begins. A failure aborts the entire batch before allocating per-video runs. During execution, videos are published sequentially, each with its own durable run ID and publication recovery records. Successful uploads must **not** be replayed; use **Pipeline tools → reconcile**, **resolve_publication**, or **retry_failed** with the affected run ID and destination. Reused outro files stay in the source folder and are not independently selected for publication.

For a read-only validation, use **Actions → Pipeline tools → manual_preview** with the same text in `target`. It previews the whole batch's resolved filenames, destinations and outro choices without uploading, archiving, allocating publishing runs, or modifying the saved plan. The original single-video manual behavior remains available. Batch runs deliberately require `keep_schedule`; scheduled publishing is unaffected.


## Per-video thumbnail selection

Manual entries and each line of a manual batch accept `; thumbnail: 00:18.5` (MM:SS, HH:MM:SS or seconds). This refers to the main clip before an appended outro. Omit it, leave it blank, or use `thumbnail: auto` for Codex visual selection from up to twelve sampled frames of that specific video. No choice or image is shared between videos or cached for an entire job. A timestamp outside the main clip is rejected; an invalid automatic model selection stops before uploads for that video. Automatic inspection uses the dedicated existing Codex subscription sign-in, no paid API key, and consumes account usage.

For a scheduled Custom list use a timestamp after the corresponding filename:

```
Sun 18:00: custom: "First.mp4" @ 00:12, "Second.mp4" @ auto; outro: none
```

Unannotated filenames are automatic. Editing the timestamps retains list progress and already completed videos. A shared scheduled `thumbnail:` clause is rejected to prevent accidental reuse across a list. Deploy the updated Worker before saving timestamps in a scheduled list. No database migration is needed: the choice travels with that video's existing saved JSON item.

Applied routes: Instagram Reel cover timestamp; TikTok Buffer thumbnail offset; regular YouTube via Upload-Post custom JPEG; regular Facebook Page video preferred thumbnail. The current Buffer YouTube Shorts, Facebook Reels and Story routes keep their platform default cover; the run summary reports this limitation. Facebook thumbnail failures are reported separately from an already-confirmed video and never cause re-uploading.

`manual_preview` validates/displays each entry and any explicit batch timestamps without sending videos or calling image inspection. Tools `preview` prepares media and inspects that video's candidate frames without publishing. Timestamped batches validate all explicit timestamps against Drive video-duration metadata before starting the first upload.


## Manual re-uploads

Explicitly selecting an exact source filename in a manual run requests a new upload. Earlier completed/failed publication records do not permanently block it: after whole-request validation, those terminal checkpoints are retained in audit history and cleared for the exact selected files. No extra dropdown or entry clause is needed. Current active, processing or uncertain uploads and scheduled reservations still require reconciliation first. Selecting FIFO/LIFO/random without an exact filename does not opt into re-uploading a previously published source. `manual_preview` stays read-only and does not reset records or publish.

## Failure reports

Failed preparation, preflight and publishing runs now write a **Video pipeline failure report** in the Actions summary and a downloadable **video-failure-report** artifact (7-day retention). It identifies the failing stage, redacted cause, whether any upload may have started, and recovery instructions. Earlier video results remain visible if a later batch video fails. Failed/skipped/pending destinations make the publishing job require attention even when another destination succeeds. Setup failures get a fallback report pointing to the failed step. Provider secrets and raw tokens are not included.
