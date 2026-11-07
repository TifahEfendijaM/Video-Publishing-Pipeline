# On-demand Codex through the ChatGPT subscription

The existing Cloudflare scheduler dispatches GitHub only when publishing is due. Codex CLI runs
inside that workflow if a selected video's meaningful filename needs captions. Publish video also
uses Codex to interpret natural input, while Tools can preview interpretations and captions.
There is no hourly ChatGPT task, polling, Drive request inbox, or preparation Doc dependency.
Codex uses the ChatGPT subscription's limits. API keys and automatic paid-provider fallback are refused.

## Activation prerequisites

Keep this migration unmerged until the video repository is **private**, and a new sign-in dedicated to
this video pipeline is ready. OpenAI's [non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
says: "Do not use this workflow for public or open-source repositories."
The wrapper checks the repository ID, owner, main branch, workflow_dispatch event and private-repository
context before loading account credentials. Pull requests, forks and local commands cannot use them.
This is independent of the image pipeline; no image or desktop credentials are copied.

Private GitHub-hosted workflow runs draw from the account's included compute allowance; additional
usage can be billed or blocked according to payment/budget settings. Public standard-runner jobs are
free. Review the account's allowance and budget before activation; avoiding OpenAI API billing does
not guarantee unlimited free GitHub compute. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Dedicated sign-in

1. Install the pinned official CLI: `npm install --global @openai/codex@0.160.0`.
2. Sign in once in a **new, empty temporary CODEX_HOME** with file-based credentials. Complete the
   device-code sign-in yourself; do not paste account tokens into a chat or commit them.
3. Save that new directory's `auth.json` directly as the video repository secret
   `VIDEO_CODEX_AUTH_JSON`, then securely remove the temporary login directory.
   Do not read/copy `~/.codex/auth.json`, the desktop session, or another pipeline's secret.
4. Ensure `CREDENTIALS_ENCRYPTION_KEY` and the existing state API are configured. Each invocation
   prefers the encrypted D1 credential `video_codex_auth` over the seed secret, lets Codex refresh it,
   then saves and reads it back before returning. A failed save stops publishing. No secret-write
   GitHub token is needed. Main publishing and AI preview workflows share one concurrency group.
5. Run Tools → verify, then nonpublishing **plan_preview** and **caption_preview** tests on main.
6. Only after both succeed, delete the obsolete hourly ChatGPT task. The old result Doc/inbox may
   then be removed; no workflow reads or updates them after migration.

For example, on a trusted computer, with the video repository already private:

```sh
VIDEO_CODEX_LOGIN_DIR="$(mktemp -d)"
CODEX_HOME="$VIDEO_CODEX_LOGIN_DIR" codex -c 'cli_auth_credentials_store="file"' login --device-auth
gh secret set VIDEO_CODEX_AUTH_JSON --repo TifahEfendijaM/Video-Publishing-Pipeline < "$VIDEO_CODEX_LOGIN_DIR/auth.json"
rm -rf "$VIDEO_CODEX_LOGIN_DIR"
```

This one-time login uses a computer; subsequent workflow runs remain fully cloud-hosted.
The account can eventually require signing in again, and subscription usage limits still apply.
To replace a revoked login, update the dedicated secret **and** reset the encrypted `video_codex_auth`
record through the authenticated credential API; an existing encrypted record intentionally takes
precedence over the seed. Never reset it while a publishing/AI workflow is running.

## Interpretation and captions

The complete natural-language request is interpreted using a fixed reference timestamp captured when
input preparation starts, Europe/Sarajevo time, the full saved plan, and current source filenames.
The prompt is versioned in `runner/prompts/interpretation.md`. Ambiguous requests return clarification
and change nothing. The result must pass the existing timetable, selection, list and outro validators;
the save step rechecks filenames and the plan revision. Formatted input skips AI entirely.
Scheduled runs reuse the saved selection rules; they do not reinterpret the plan on each occurrence.

Meaningful filenames generate captions/titles for the selected video on demand. Generic filenames
use reviewed generic copy without a model call. Ordinary model failures or rejected text use the
reported generic fallback; credential integrity/storage failures stop the run before uploading.
Each CLI invocation has a five-minute timeout. Validation can request one caption revision.

The child process receives an isolated temporary home and an allowlisted environment, not provider,
state, GitHub, encryption or API credentials. Shell tools, web search, apps and remote plugins are
disabled. Codex runs read-only in an empty temporary workspace, uses an output JSON schema, and has
no access through the prompt to videos, publishing tools or repository files. Raw model events and
credentials are never logged or uploaded as artifacts; the temporary directory is removed afterward.

`captions.model = "default"` means the account's Codex default, rather than a pinned model name.
A supported explicit model can be configured later; this setting applies to interpretation and captions.
The pinned CLI version is separate from the model selection.
