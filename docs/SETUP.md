# Setup, authorization and deployment

Everything runs in the cloud: a Cloudflare Worker (timing + dispatch + small state API on D1) and GitHub
Actions runners (download, ffprobe/ffmpeg, captions, uploads). Nothing depends on your computer or on Claude.

**This project shares nothing with the image-card pipeline**: its own repository, Worker
(`easybosnian-video-scheduler`), D1 database (`easybosnian-video-pipeline`), KV namespace and secrets.
Do not reuse that project's tokens; create new ones below.

## 1. Accounts, scopes and approvals

| # | What | Where | Exact settings | Status |
|---|---|---|---|---|
| 1 | **Google service account** (Drive read + archive) | Google Cloud console → new project "easybosnian-video" → IAM → Service accounts → create → Keys → JSON | Enable **Google Drive API**. Share the Drive folder *EasyBosnian educational videos* with the service-account email as **Editor** (nothing else is shared; the folder stays private). | ⏳ you |
| 1b | **Drive OAuth** (alternative if the service account cannot move sources) | Google Cloud console → OAuth client (Web application), with consent screen **In production** | Authorize as the **owner of the video files**, with `https://www.googleapis.com/auth/drive`. OAuth takes precedence over the service account. The signed-in account must be able to move sources into the archive folder. | ⏳ you |
| 2 | **YouTube OAuth client** — *optional fallback only* (private uploads if Upload-Post is not configured) | Same project → APIs: enable **YouTube Data API v3** → OAuth consent screen (External) → **Publish app → In production** → Credentials → OAuth client (Web application, see below) | Scopes `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly`. Sign in **as the EasyBosnian channel owner**. Unverified-app warning is expected for your own use. | ⏳ you (then I help generate the refresh token) |
| 3 | **YouTube API compliance audit** — *optional, not needed with Upload-Post* | [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) | Required for **public** uploads via the official API. Until approved, `apiProjectAudited` stays `false`. | ⏳ optional / weeks |
| 4 | **Meta app + system user** | developers.facebook.com → Create app (Business) linked to your Business portfolio; business.facebook.com → Users → **System users** → add (Admin) → assign the Easy Bosnian **Page** (full control) and the **@easy_bosnian** Instagram account → Generate token (never expires) | Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`. Then exchange for the **Page** token: `GET /{page-id}?fields=access_token` with the system-user token. | ⏳ you |
| 5 | **Buffer API key** (TikTok + YouTube Shorts) | publish.buffer.com/settings/api; Buffer → Channels → connect YouTube **@EasyBosnian** | Personal API key of the Buffer account where @easy.bosnian TikTok is connected. TikTok and YouTube (@EasyBosnian, for Shorts) must be connected in Buffer (free plan: 3 channels). | ⏳ you |
| 5b | **Upload-Post** (YouTube regular videos) | app.upload-post.com → sign up (free, no card) → create a profile named `easybosnian` → connect YouTube as the **@EasyBosnian** channel → API Keys → create key | Free plan: 10 uploads/month. | ⏳ you |
| 6 | **Cloudflare Workers AI token** (free captions) | dash.cloudflare.com → API Tokens → Create custom token | Account permission **Workers AI: Read** only. Keep the account on the **Workers Free plan**: the free allowance is 10,000 Neurons/day (one caption ≈ 100) and usage above it is refused, never billed. | ⏳ you |
| 7 | **Cloudflare deploy token** | dash.cloudflare.com → My Profile → API Tokens → Create custom token | Account permissions: **Workers Scripts: Edit**, **D1: Edit**, **Workers KV Storage: Edit**; Account Resources: your account only. No payment method needed: temporary video hosting uses the free Workers KV (≤24 MB per video). R2 is optional and only for videos over 24 MB (R2 requires a card on file, so it is left off). | ⏳ you |
| 8 | **GitHub dispatch token** for the Worker | github.com/settings/personal-access-tokens → Fine-grained | Resource owner TifahEfendijaM; **Only select repositories: Video-Publishing-Pipeline**; Repository permissions: **Actions: Read and write** (Metadata: read is automatic). Nothing else. Expiry: up to 1 year (calendar a renewal). | ⏳ you |

### Getting the YouTube refresh token (browser only, no local install)
1. In the OAuth client (type **Web application**) add the redirect URI `https://developers.google.com/oauthplayground`.
2. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) → ⚙️ → *Use your own OAuth credentials* → paste client ID/secret.
3. In "Input your own scopes" enter `https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly` → Authorize APIs → sign in as the **EasyBosnian channel** (choose the brand account if asked).
4. *Exchange authorization code for tokens* → copy the **refresh token** into the `YOUTUBE_REFRESH_TOKEN` secret. Then remove the Playground redirect URI if you like.
5. Run Tools → `verify`: it must show the expected channel ID and "upload scope granted".

### Drive access for automatic archival

The pipeline moves confirmed sources into **Published videos**, preserving the original files.
The simplest setup is to grant the existing service account **Editor** access to the source folder.
The archive is created inside it automatically on the first successful publication. If using a separate
existing archive folder, grant the same identity Editor access there and set `PUBLISHED_DRIVE_FOLDER_ID`.
Run **Tools → verify** and check **Drive source cleanup permission**. Capabilities depend on folder and
shared-drive restrictions, so the verification check is authoritative; Viewer access is insufficient.
See [Google's file-move guidance](https://developers.google.com/workspace/drive/api/guides/folder).

If the service account cannot move files under your Drive's permissions, use the OAuth Playground
procedure above with scope `https://www.googleapis.com/auth/drive`. Sign in as the file owner or an
account with move permission, then save the Client ID, Client secret and refresh token in the three
`GOOGLE_DRIVE_*` GitHub secrets. Use your own OAuth client and an **In production** consent screen.
Keep these credentials separate from YouTube credentials. Drive Activity access is no longer required.

To activate after merging this update:

1. Disable live publishing with **Tools → publishing_disable** during the update.
2. Run **Deploy scheduler Worker** on `main`. It applies migration `0003_folder_queue.sql`, which preserves
   saved schedules/outros/pending custom choices, adds the Random policy, and drops the old consumed-video
   and folder-entry table. Existing publication checkpoints remain until sources are verified in the archive.
   An old consumed marker without provider evidence becomes an uncertain checkpoint for manual review.
3. Run **Tools → verify**, check archive move permissions, then **Tools → publishing_enable**.
4. **Tools → reconcile** can archive previously confirmed sources and clear their old publishing records.
   Pending/partial sources are retained. Verify and preview never create folders or move files.

## 2. GitHub repository secrets and variables

Settings → Secrets and variables → Actions.

**Secrets**

| Name | Value |
|---|---|
| `STATE_API_TOKEN` | random: `openssl rand -hex 32` (shared Worker ↔ runner secret) |
| `CREDENTIALS_ENCRYPTION_KEY` | random: `openssl rand -base64 32` (encrypts rotated refresh tokens stored in D1) |
| `GH_DISPATCH_TOKEN` | fine-grained PAT from step 8 (deploy copies it into the Worker; runners never use it) |
| `CLOUDFLARE_API_TOKEN` | step 7 API token (deploy workflow only) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | full JSON key from step 1 |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` | step 1b; optional alternative to service-account access, all three required together |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | step 2 (optional fallback) |
| `META_PAGE_ACCESS_TOKEN` | Page token from step 4 |
| `META_APP_ID`, `META_APP_SECRET` | step 4 app (only used to inspect token scopes in `verify`) |
| `BUFFER_API_KEY` | step 5 |
| `UPLOAD_POST_API_KEY` | step 5b |
| `CLOUDFLARE_AI_TOKEN` | step 6 (Workers AI: Read) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | optional, only for videos over 24 MB |

**Variables**

| Name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |
| `R2_BUCKET` | optional; leave unset |
| `PUBLISHED_DRIVE_FOLDER_ID` | optional existing archive folder ID; empty = auto-create Published videos inside the source folder |
| `STATE_API_URL` | Worker URL printed by the deploy run, e.g. `https://easybosnian-video-scheduler.<subdomain>.workers.dev` |

Fill in `config/pipeline.json` (via a commit): `instagram.expectedUserId`, `facebook.expectedPageId`,
`tiktok.expectedBufferChannelId`, `youtube.short.bufferChannelId` (both printed by `verify`), and `youtube.regular.uploadPostProfile` if your profile is not named `easybosnian`.
`verify` prints the IDs it finds so you can copy them; an empty expected ID keeps that destination *Disabled*.

## 3. Deploy the Worker

Actions → **Deploy scheduler Worker** → Run workflow → type `deploy`. It runs the tests, creates/updates
the D1 database, applies migrations, deploys, sets `GH_DISPATCH_TOKEN` + `STATE_API_TOKEN` as Worker
secrets, creates the free KV namespace for temporary videos, and **reads back the live cron triggers,
deployments, secret names and `/api/target`** into the run summary.

Equivalent local commands (with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exported):

```bash
npm ci && npm test
npx wrangler d1 create easybosnian-video-pipeline            # once; copy the id
sed -e "s/__D1_DATABASE_ID__/<d1-id>/" -e "s/__KV_NAMESPACE_ID__/<kv-id>/" worker/wrangler.toml > worker/wrangler.generated.toml
npx wrangler d1 migrations apply easybosnian-video-pipeline --remote --config worker/wrangler.generated.toml
npx wrangler deploy --config worker/wrangler.generated.toml
echo -n "$GH_DISPATCH_TOKEN" | npx wrangler secret put GH_DISPATCH_TOKEN --config worker/wrangler.generated.toml
echo -n "$STATE_API_TOKEN"   | npx wrangler secret put STATE_API_TOKEN   --config worker/wrangler.generated.toml
npx wrangler kv namespace create easybosnian-video-media   # put its id into the generated toml (__KV_NAMESPACE_ID__)
# read back
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/easybosnian-video-scheduler/schedules
npx wrangler deployments list --config worker/wrangler.generated.toml
```

The Worker dispatches **only** `TifahEfendijaM/Video-Publishing-Pipeline` → `scheduled-publish.yml` on
branch `main` (hard-coded `[vars]` in `worker/wrangler.toml`). Its cron is a fixed UTC `* * * * *`
wake-up; the real schedule is the Sarajevo slot list in D1.

## 4. First checks (none of these publish)

1. Tools → `verify` — identities, scopes, Drive folder, Activity API, Buffer schema, temporary-hosting privacy, free caption model.
2. Tools → `dispatch_test` — Worker → GitHub dispatch round trip; a "Scheduled publish (Worker)" run
   appears and exits with "Dispatch verified".
3. Tools → `preview` — selects (read-only), downloads, probes, plans formats, writes captions, renders
   Story files as a private artifact.
4. Only when you decide: Tools → `publishing_enable` (kill switch ON). It starts **OFF**.

## 5. Costs (expected)

| Service | Expected cost |
|---|---|
| Cloudflare Workers (1,440 cron wake-ups/day), D1 | free plan |
| Cloudflare Workers KV (temporary videos, deleted after use, 6 h expiry) | free plan; over-limit writes fail rather than bill |
| GitHub Actions (private repo) | ~3–8 min per publish run; free plan includes 2,000 min/month |
| Captions (Cloudflare Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | $0: about 100 of the 10,000 free daily Neurons per topic caption; generic filenames use no model at all. On the Workers Free plan nothing can be billed. |
| Upload-Post (YouTube) | free plan, 10 uploads/month, no card |
| Buffer | your existing plan; the API is included on all plans (free: 3,000 requests/30 days; we poll once per minute, ≤20 per post) |
| Meta, YouTube Data API, Drive APIs | free (YouTube default quota 10,000 units/day suffices for a daily upload) |


## Updating named-job scheduling

During the update, disable live publishing, merge the tested form/runner changes and deploy the updated
Worker. Deployment applies migration `0004_scheduled_jobs.sql`: an enabled old singleton becomes
`Default schedule`, retaining its times, automatic policy, outro settings and next Custom override.
An inactive old schedule creates no active job. The singleton is disabled to prevent double dispatch;
older queued singleton claims fail closed. The old automated-configuration API returns a clear retirement
error rather than silently overwriting named jobs.

The new form needs the updated Worker and jobs migration before named-job commands can run. An older
Worker cannot silently interpret the new manual Keep choice as Stop: the separate endpoint fails closed.
Run Tools → verify/status and optionally rule_preview, then restore the previous publishing kill switch.
No user video needs to be published as an activation test. Job settings and pending Custom lists are kept
in D1; archived videos still leave no permanent selection-history cursor.
