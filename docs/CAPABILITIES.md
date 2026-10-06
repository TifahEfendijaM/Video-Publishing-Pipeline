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
| **YouTube** [@EasyBosnian](https://www.youtube.com/@EasyBosnian) | ✅ **Shorts via Buffer** (public, no Google audit). Your clips are vertical and 10–40 s, so they qualify. Anything that is not a Short (horizontal or > 3 min) is uploaded **PRIVATE** through the official API and reported as a manual step (you make it public in YouTube Studio), until the free YouTube API audit is passed. | n/a | Buffer: @EasyBosnian connected in Buffer. Official API: Google OAuth client (`youtube.upload`, `youtube.readonly`), consent screen **In production** (Testing = refresh token dies after 7 days). | Official API without audit = private only. Buffer = Shorts only, no custom thumbnail. | Buffer for Shorts; YouTube Data API (private) for anything else |

### Status vocabulary in every run summary
⏳ Upload initiated · 🔄 Media processing · ✅ Publication confirmed (read back from the platform) ·
❌ Failed (nothing was published) · ⚠️ Outcome uncertain (never retried automatically) ·
🚫 Unsupported / manual · ⏸️ Disabled (kill switch, cancelled schedule, or unverified identity)

A provider accepting an upload, or Buffer accepting a post, is shown as *processing*, not *confirmed*.

### Genuine blockers today
1. **TikTok Stories**: no supported API → always *Unsupported / manual*.
2. **YouTube public uploads of horizontal or >3 min videos**: need the YouTube API compliance audit
   (free, typically weeks). Until then they are uploaded private for you to publish (your choice).
3. **YouTube Shorts via Buffer** need @EasyBosnian connected in Buffer (free plan: 3 channels).

### Free third-party alternatives for regular (non-Short) YouTube videos — checked 2026-10-06
- **Upload-Post** (upload-post.com): legitimate posting API with an audited YouTube integration; its free
  plan allows **10 posts per month**, no card, and covers regular videos and Shorts. It would be another
  third party holding access to your channel. Not enabled; it could replace the private-upload fallback if you want.
- PostPeer: only a one-off trial (20 credits). Ayrshare / Zernio: no free tier. Self-hosted tools (e.g. Postiz)
  use your own Google project, so they hit the same audit restriction.
- Conclusion: since your videos are Shorts, Buffer covers them; the rare non-Short is uploaded private.
4. Everything else needs only your authorizations (see `SETUP.md`).

### Sources
- [TikTok Content Posting API – Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) (unverified projects after 2020-07-28 → private)
- [Buffer API reference](https://developers.buffer.com/reference.html), [Create video post](https://developers.buffer.com/examples/create-video-post.html), [Using YouTube Shorts with Buffer](https://support.buffer.com/article/562-using-youtube-shorts-with-buffer), [Troubleshooting video uploads](https://support.buffer.com/en-us/articles/troubleshooting-video-uploads-in-buffer-LK0CldlFNB), [What is Buffer's API](https://support.buffer.com/article/859-does-buffer-have-an-api)
- [Meta Page Stories API](https://developers.facebook.com/docs/page-stories-api/), [Reels Publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing), [IG content publishing / resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing)
- [Google OAuth: 7-day refresh tokens in Testing](https://developers.google.com/identity/protocols/oauth2#expiration), [Drive Activity API data model](https://developers.google.com/drive/activity/v2/datamodel)
