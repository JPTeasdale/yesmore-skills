---
name: yesmore-landing-dev
description: Generate, locally preview, verify, and upload sandboxed YesMore landing-page index.html bundles; also configure the private upload credential. Trigger for YesMore hosted landing pages, landing bundle previews, and landing uploads.
---

# YesMore landing development

Handle four explicit actions: `configure`, `build`, `preview`, and `upload`. When invoked without an action, ask for the page brief and whether to build, preview, configure, or upload.

## Protect credentials and deployment authority

- Never ask for, accept, reveal, print, log, or copy a credential in chat, command arguments, source control, project files, shell history, tickets, reports, or this skill folder.
- Require an API key with both `landing_bundles:read:all` and `landing_bundles:write:all`. Direct the user to create or revoke production keys at `https://yesmore.co/admin/api-keys`, or staging keys at `https://yesmoreco.com/admin/api-keys` only when staging is explicitly specified. Never try to assign permissions from this skill.
- Resolve the credential from inherited `YESMORE_LANDING_BUNDLE_TOKEN` first, then the raw `${XDG_CONFIG_HOME:-$HOME/.config}/yesmore/landing-dev/credential` file. Treat a present malformed environment value as a hard error; never fall back to the file.
- Run credential operations only through `scripts/ensure-credential.sh`. Never accept a credential as a command-line argument.
- Authenticate only explicit staging uploads through the installed `cloudflared` CLI. Keep the short-lived Cloudflare Access token in memory, send it only as `cf-access-token` to the exact `https://yesmoreco.com` staging origin, and never print or persist it.
- Treat upload as a separate, explicit action. Build or preview permission never authorizes upload.
- Never activate a bundle or assign a segment. Those remain separate admin-only actions.

## Use the current YesMore URL contract

- Treat `https://yesmore.co` as the production application origin and `https://yesmoreco.com` as staging.
- Use `/api/p/*` for every publicly allowlisted YesMore API route. Landing bundles upload through `/api/p/landing-bundles/{landingPageId}`, and the trusted sign-in surface is `/api/p/auth/landing-surface`. Never use the legacy `/api/v1/landing-bundles/*` or `/api/auth/landing-*` paths.
- Production landing pages are served from `{landingPageId}.yesmore.co`; staging landing pages are served from `{landingPageId}.yesmoreco.com`.
- Successful sign-in continues to `/account` on the configured application origin. Do not use the removed `/me` or `/dashboard` routes.
- When a YesMore media upload response is provided, use its returned URLs unchanged: `/m/{slug}` is the rich-preview HTML page, and `/m/{slug}/{filename}` is the directly rendered file. Never reconstruct legacy `/d/*` or `/media/*` URLs.

## Configure

Run:

```sh
"<skill-directory>/scripts/ensure-credential.sh" --configure
```

Use the nonce-based visible terminal prompt when the protected file is the active source, even when the existing file has a valid shape. When `YESMORE_LANDING_BUNDLE_TOKEN` is present, explain that it has precedence and the user must update or remove that host-managed encrypted secret. If no GUI terminal is available, direct the user to the host encrypted-secret facility; never request the value in conversation.

## Build

1. Gather the page brief, landing page ID, title, target `index.html` path, existing project assets, and brand direction.
2. Inspect and reuse available brand assets before inventing a visual language.
3. Validate the landing page ID: 1–63 lowercase letters, numbers, or hyphens; alphanumeric at both ends; not `default`, `next`, `staging`, or `www`.
4. Create or edit one complete UTF-8 `index.html` no larger than 2 MiB. Include doctype, `html`, `head`, `body`, and all closing tags. Prefer self-contained inline CSS and JavaScript.
5. Produce a polished, responsive, keyboard-accessible interface.
6. Design for an opaque sandboxed origin. Do not use cookies, local/session storage, frames, workers, objects, `<base>`, custom form actions/targets, custom sessions, or custom redirects.
7. Do not use `fetch`, XHR, EventSource, WebSocket, or other direct network calls. The trusted renderer owns authentication and network activity.
8. To offer sign-up, render a normal accessible `<button type="button" data-yesmore-action="sign-up">`. Do not build phone or OTP fields, call `window.YesMoreAuth`, create a session, or redirect from bundle code. The trusted renderer supplies the desktop modal/mobile drawer and finishes successful validation at `/account` on the configured application origin.
9. Theme only the trusted authentication surface's colors, when needed, by defining valid accessible colors on `:root` for `--yesmore-auth-surface`, `--yesmore-auth-text`, `--yesmore-auth-muted`, `--yesmore-auth-border`, `--yesmore-auth-accent`, and `--yesmore-auth-accent-text`. These variables do not control layout, typography, spacing, or behavior.
10. Validate with the preview script before calling the build complete.

## Preview

Run:

```sh
node "<skill-directory>/scripts/preview-bundle.mjs" "<path-to-index.html>"
```

The script validates the bundle, binds only to `127.0.0.1`, injects a behavior-equivalent trusted sign-up mock in memory, applies a production-like sandbox policy, and blocks real network, SMS, session, and handoff activity without editing the source.

Inspect at 390×844 and 1440×900. Exercise every marked sign-up button and the phone, code, resend, change-number, close, loading, success, and error states. Confirm the six optional theme colors, horizontal overflow, keyboard order, focus trapping/restoration and visibility, labels, contrast, reduced motion, mobile drawer/desktop modal behavior, and page console. Iterate until every check passes.

## Upload

Proceed only after explicit upload authorization. Default to production at `yesmore.co`:

```sh
node "<skill-directory>/scripts/upload-bundle.mjs" "<landing-page-id>" "<title>" "<path-to-index.html>"
```

Only when the user explicitly specifies staging, pass `--staging` to target `yesmoreco.com`:

```sh
node "<skill-directory>/scripts/upload-bundle.mjs" --staging "<landing-page-id>" "<title>" "<path-to-index.html>"
```

Never infer staging from the current project, browser, prior upload, or development context. Without the explicit staging request and flag, always use production `yesmore.co`.

The script revalidates the credential source, landing ID, document, and declarative sign-up contract; posts raw HTML to the selected YesMore origin without following redirects; validates the inactive immutable bundle response; enforces the YesMore preview-origin allowlist; performs API-key remote preview verification; and opens the exact uploaded version at `/admin/landing-bundles/{landingPageId}/preview/{bundle.id}` on that same selected origin. Explicit staging additionally obtains an in-memory Cloudflare Access token for `yesmoreco.com`.

Require the API-key remote preview to return a complete HTML document with the trusted injected sign-up runtime. When the uploaded source includes a sign-up trigger, require that trigger in the remote document too. Treat the API response's bearer-protected `previewUrl` as verification-only; never open it in a browser or add the API key to a URL. Open and report only the version-specific authenticated admin preview. Never persist the credential or authenticated response body.

On HTTP 401, direct environment-backed users to update or remove the host encrypted secret. Direct file-backed users to run `$yesmore-landing-dev configure`. Never retry by requesting the token in conversation.

Report only the requested landing page ID, immutable version ID (`bundle.id`), checksum, version-specific authenticated admin preview URL, and API-key verification result. Never report the credential.

Prefer: build → local preview → visual/accessibility checks → explicit upload → API-key remote verification → authenticated version preview.
