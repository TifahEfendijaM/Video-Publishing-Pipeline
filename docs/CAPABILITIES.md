# Capability & authorization matrix

Checked on 2026-10-06. The build environment's network policy blocked direct fetches of
developers.tiktok.com, developers.facebook.com, developers.buffer.com and support.buffer.com, so these
facts come from searches of those official pages and their search excerpts (sources at the end). The
pipeline's **`verify` tool re-checks them live** (Buffer schema introspection, Meta token scopes,
YouTube channel/scopes) before anything goes live.

| Platform | Public video publication | Stories | Authorization needed | Main limitations | Provider used |
|---|---|---|---|---|---|
| **Instagram** @easy_bosnian | ✅ Reels via Instagram Graph API (`media_type=REELS`, container → `media_publish`, read back the permalink) | ✅ Video Stories (`media_type=STORIES`), 3–60 s | Meta app (your own, Business type) + Business **system user** token with `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`. App Review is **not** needed for assets your own Business owns (Standard Access). IG must be a professional account linked to the Page. | Reels 3 s–15 min, ≤300 MB, H.264/HEVC + AAC. Stories ≤60 s. 100 API posts / 24 h. Needs a fetchable video URL (we use short-lived unguessable links on the free Workers KV, deleted after use). | Meta Graph API (official) |
| **Facebook** Easy Bosnian Page | ✅ Page **Reels** (`/video_reels`) when the source is 9:16 and 3–90 s; otherwise a regular **Page video** (resumable `/videos`), unchanged | ✅ Page video Stories (`/video_stories`), ≤60 s, 9:16 recommended | Same system user Page token: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`; the user must be able to CREATE_CONTENT on the Page | Reels need 9:16 ≥540×960; we never crop to make one. | Meta Graph API (official) |
| **TikTok** @easy.bosnian | ✅ via **Buffer** (Buffer's TikTok integration is audited, so posts are public) | ❌ **Unsupported / manual.** Neither TikTok's Content Posting API (`post_mode` is only DIRECT_POST / MEDIA_UPLOAD) nor Buffer documents a Story route. | Buffer account with the TikTok channel already connected + Buffer API key | Own unaudited TikTok app = **private (SELF_ONLY) posts only**, max 5 users / 24 h, until TikTok's audit (UX requirements: creator nickname display, commercial-content toggles, music consent). Buffer API free plan: 3,000 requests / 30 days. Buffer fetches media from a public URL. ⚠️ TikTok's content-sharing guidelines forbid apps adding promotional links/branding *to the content*; the caption's `👉easybosnian.com` is your own caption text, but TikTok may still treat promotional captions strictly. | Buffer GraphQL API |
| **YouTube** [@EasyBosnian](https://www.youtube.com/@EasyBosnian) | ✅ Two public uploads per clip: **regular video via Upload-Post** (audited integration, free 10/month) and **Short via Buffer** (Shorts only). The missing shape is made by placing the whole frame on a vertical or widescreen canvas with black bars (owner-approved; nothing cropped). | n/a | Upload-Post profile `easybosnian` with @EasyBosnian connected + API key; @EasyBosnian connected in Buffer. | Upload-Post free: 10 uploads/month. Buffer: Shorts ≤ 3 min. Fallback without Upload-Post: private official-API upload (manual step). | Upload-Post (video) + Buffer (Short) |

### Status vocabulary in every run summary
⏳ Upload initiated · 🔄 Media processing · ✅ Publication confirmed (read back from the platform) ·
❌ Failed (nothing was published) · ⚠️ Outcome uncertain (never retried automatically) ·
🚫 Unsupported / manual · ⏸️ Disabled (kill switch, cancelled schedule, or unverified identity)

A provider accepting an upload, or Buffer accepting a post, is shown as *processing*, not *confirmed*.

### Genuine blockers today
1. **TikTok Stories**: no supported API → always *Unsupported / manual*.
2. **YouTube volume**: Upload-Post's free plan allows 10 uploads per month. A schedule with more than
   ~2 slots per week exceeds it (the run summary warns when you save such a schedule).

### Free third-party alternatives for YouTube — checked 2026-10-06
- **Upload-Post** (chosen): audited YouTube integration, REST API on the free plan (10 uploads/month, no
  card), supports Shorts and regular videos, and lets us send our own request ID so a lost response is looked
  up instead of re-sent.
- PostPeer: only a one-off trial (20 credits). Ayrshare / Zernio: no free tier. Self-hosted tools (e.g.
  Postiz) use your own Google project, so they hit the same audit restriction. Buffer: Shorts only.

### Sources
- [TikTok Content Posting API – Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) (unverified projects after 2020-07-28 → private)
- [Upload-Post upload API](https://docs.upload-post.com/api/upload-video/), [Upload status](https://docs.upload-post.com/api/upload-status/), [Pricing & limits](https://docs.upload-post.com/resources/pricing-and-limits)
- [Buffer API reference](https://developers.buffer.com/reference.html), [Create video post](https://developers.buffer.com/examples/create-video-post.html), [Using YouTube Shorts with Buffer](https://support.buffer.com/article/562-using-youtube-shorts-with-buffer), [Troubleshooting video uploads](https://support.buffer.com/en-us/articles/troubleshooting-video-uploads-in-buffer-LK0CldlFNB), [What is Buffer's API](https://support.buffer.com/article/859-does-buffer-have-an-api)
- [Meta Page Stories API](https://developers.facebook.com/docs/page-stories-api/), [Reels Publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing), [IG content publishing / resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing)
- [Google OAuth: 7-day refresh tokens in Testing](https://developers.google.com/identity/protocols/oauth2#expiration), [Drive Activity API data model](https://developers.google.com/drive/activity/v2/datamodel)
