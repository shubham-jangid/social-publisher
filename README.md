# social-publisher

A small command-line tool that posts one video, image or set of images to Facebook,
Instagram, YouTube, Pinterest and LinkedIn through their official APIs, with a free Cloudflare
Worker that posts on time while your computer is off.

## Who it is for

- One person (or a very small team with one owner) running a few brands or pages.
- People who make content with AI agents (Claude Code or any MCP client) and want the agent to
  prepare posts, but want a human to say "yes" before anything goes public.
- People who are fine with a terminal and with creating their own developer app on each
  platform.

If you want a team tool with roles, a web editor and comments, this is not it.

## Why not Buffer / Postiz / Mixpost?

They are good tools. This one makes different trade-offs.

- **Buffer**'s free plan is small (a few channels, a few scheduled posts per channel at a time).
  **Hootsuite** and **Later** have no free plan at the time of writing. Check their pricing pages
  for the current limits.
- **Postiz** and **Mixpost** are great open-source apps with a full web interface. But you host
  them yourself: a server, a database and a queue that you keep running and patched.
- **This tool** is a CLI plus one Cloudflare Worker. There is no server to run. The Worker, its
  database (D1) and its bucket (R2) fit in Cloudflare's free plan. It was built to be driven by
  AI agents through MCP, with a hard approval gate: the agent can write and preview a post, but
  scheduling needs approved media and an explicit human "yes".

The cost of this approach: you set up your own app on every platform, and some platforms make
you wait for a review (see [Requirements](#requirements)).

## Features

Everything below is in the code today.

**Platforms (official APIs only)**

| Platform | What it posts | Scheduling |
|---|---|---|
| Facebook Pages | Reels, videos, photos, multi-photo posts, text/link posts | Native (Facebook schedules it, 10 min to 29 days ahead) |
| Instagram (professional accounts) | Reels (with cover), single images, carousels (up to 10) | Cloud scheduler |
| YouTube | Videos and Shorts, thumbnail, tags, playlist, made-for-kids, AI-content flag | Native (uploaded private with a publish time) |
| Pinterest | Video Pins, image Pins and multi-image Pins, to a board by name, id or alias | Cloud scheduler |
| LinkedIn (company Page or your profile) | Text, link, image, multi-image and video posts | Cloud scheduler |

**Posting**

- One JSON post file goes to every platform. Each platform can override the caption, title,
  link, account, board and more.
- Platforms are independent: one failing never stops the others. Results go to
  `<post>.result.json`, so running the same post again never double-posts (`--force` overrides).
- `--dry-run` shows the final caption, title, link and warnings for every platform.
- Links to your own site get UTM tags (`utm_source=<platform>`).
- `"ai": true` sets YouTube's synthetic-media flag, and adds your brand's AI disclosure line on
  platforms whose API has no AI label.
- **Metadata stripping.** Before upload, every PNG, JPEG, MP4 and MOV is copied without its
  metadata (C2PA / Content Credentials, XMP, EXIF, IPTC). Pixels and the video stream are not
  changed, and your original file is never touched. `social strip FILE…` does the same in place.

**Cloud scheduler** (Cloudflare Worker + Durable Object alarm + D1 + R2)

- Posts Instagram, Pinterest and LinkedIn at the minute, while your computer is off.
- Prepares about 20 minutes early, never retries the final publish step, and marks a post
  **missed** instead of posting it more than 3 hours late.
- Media sits in a private bucket. Platforms get 6-hour signed links. Media is deleted after posting.
- Renews Pinterest and LinkedIn sign-ins and warns 14 days before one expires.
- Alerts by Telegram and/or email (Resend) when a post fails or is missed.
- Without the Worker, a local queue plus a macOS launchd runner can post instead (your Mac must
  be awake).

**Calendar and dashboard**

- A password-protected dashboard at `<your worker>/app` with four views: Today, Schedule,
  Calendar and Performance. Filters, search, CSV export.
- Every 3 hours the Worker reads what is really live on Facebook, Instagram, YouTube and
  Pinterest, so posts made by hand in the platforms' own apps count too.
- A **plan**: add what should go out (CLI, MCP or the dashboard). A plan item is done when a
  post on that platform within 36 hours contains its match words. If its time passes with no
  such post, it shows as **not published**. Facebook posts still "scheduled" after their time
  show as **stuck**.
- Nothing is posted from the dashboard. It can only add, skip or close plan items and trigger
  a sync.

**Analytics (where the APIs allow it)**

- The same sync stores each post's numbers: views, likes, comments, shares, saves, and on
  YouTube watch time and % watched (YouTube Analytics API).
- Facebook, Instagram, YouTube and Pinterest. No numbers for LinkedIn.
- `social analytics` and the MCP `analytics` tool rank posts per brand and platform, compare
  formats, and compare the same video across platforms. Numbers not refreshed for 30 days are
  deleted.

**MCP server with an approval gate**

- 11 tools for any MCP client. See [MCP server](#mcp-server).
- `schedule_post` refuses media, covers and caption files outside the brand's approved folders.
- Two Claude Code hooks (included) make the client ask you before every schedule or cancel,
  through MCP or through the shell. They catch mistakes; see [the limits](#what-the-gate-does-not-do).

**Optional: scheduled Sanity blog publishing**

- `social blog schedule` makes the Worker publish a Sanity draft (all languages in one
  transaction) at a set time. It assumes a specific document id pattern: see
  [docs/BRAND-FILE.md](docs/BRAND-FILE.md#blog-optional-scheduled-sanity-publishing).

## Requirements

- **Node.js 20 or newer.** Node 22+ for the cloud commands (`social cloud …` runs wrangler 4)
  and for the full test suite. No npm dependencies, no build step.
- **ffmpeg** on your PATH, to strip metadata from videos before upload.
- **macOS** for a few extras: `sips` converts PNG covers and images to JPEG (Instagram images
  must be JPEG; YouTube thumbnails must be under 2 MB), and the local runner uses launchd. On
  Linux or Windows, give Instagram JPEG images and use the cloud scheduler.
- **A Cloudflare account** on the free plan, with R2 switched on (Cloudflare asks for a card
  even for R2's free tier). Only needed for the cloud scheduler, calendar and dashboard.
- **Your own developer app on each platform you use.** Be ready to wait:
  - **Meta**: an app in Development mode works for your own Pages right away. Wider use, or
    Facebook Login for Business on some accounts, needs business verification and App Review.
  - **YouTube**: new Google Cloud projects can only upload **private** videos until Google's
    API audit passes. That can take weeks. Until then you make videos public by hand in Studio.
  - **Pinterest**: new apps get Trial access, where Pins are refused in production. Standard
    access needs a demo video and a review.
  - **LinkedIn**: posting as your own profile works at once. Posting as a company Page needs the
    Community Management API, which LinkedIn reviews (days to weeks).

## Quick start

```sh
git clone <this repo> social-publisher && cd social-publisher
npm link                       # optional: puts `social` on your PATH
social init                    # creates ~/.config/social-publisher/apps.json
```

1. Copy `brands/example.json` to `brands/<your-brand>.json`. Keep only the platforms you use.
   Every field is explained in [docs/BRAND-FILE.md](docs/BRAND-FILE.md).
2. Set up the platforms you need (next section) and fill in the app keys in `apps.json`.
3. Sign in: `social auth meta`, `social auth youtube --brand <brand>`, and so on.
4. Optional but recommended: `social cloud setup` (see [Cloud deploy](#cloud-deploy)).
5. Check everything: `social check`.
6. Write a post file and dry-run it:

```json
{
  "brand": "example",
  "id": "spring-reel",
  "media": "media/spring-reel.mp4",
  "cover": "media/spring-cover.jpg",
  "caption": "Spring is here.\n\n#garden",
  "title": "Spring in the garden",
  "link": "https://example.com/spring",
  "ai": false,
  "at": "2026-11-20 18:30",
  "platforms": { "facebook": {}, "instagram": {}, "youtube": { "tags": ["garden"] } }
}
```

```sh
social post posts/spring-reel.json --dry-run    # shows what would go where; posts nothing
social post posts/spring-reel.json              # schedules / posts
```

More shapes are in `examples/` (a carousel, a Reel to a second YouTube channel, a text post).

### Post file fields

| Field | What it does |
|---|---|
| `brand` | Brand key (file name in `brands/`). Required. |
| `id` | Used in UTM `utm_content`. Default: the file name. |
| `media` | One video, one image, or a list of up to 20 images. Leave out for a text post (Facebook, LinkedIn). |
| `cover` | Image used as the video cover / thumbnail. |
| `caption` or `captionFile` | The text. `{link}` in it is replaced with the tagged link. |
| `title` | YouTube title (required for YouTube), also used by Facebook video and Pinterest. |
| `link`, `tags`, `alt`, `campaign` | Link, YouTube tags, image alt text, UTM campaign. |
| `ai` | `true` if the visuals are AI-made. |
| `at` | `"2026-11-20 18:30"` in the brand's time zone, or ISO with an offset. Leave out to post now. |
| `platforms` | Which platforms, each with optional overrides (`caption`, `captionFile`, `title`, `link`, `account`, `board`, `as`, `tags`, `privacy`, …). `false` skips one. Leave out to use the brand's `defaults.platforms`. |

Paths are relative to the post file. `~` works.

## Per-platform setup

Each guide is short and step by step:

- [Facebook + Instagram (Meta)](docs/SETUP-META.md): one app, one sign-in for every Page and
  its linked Instagram account. Do this part yourself in a normal browser, not with a browser
  automation agent: Meta can flag accounts for automated behaviour.
- [YouTube (Google Cloud)](docs/SETUP-YOUTUBE.md): one project, one sign-in per channel. Ask
  for the upload audit on day one.
- [Pinterest](docs/SETUP-PINTEREST.md): one app, one sign-in per account. Trial vs Standard.
- [LinkedIn](docs/SETUP-LINKEDIN.md): company Page app vs personal profile app.
- [Cloudflare Worker](docs/SETUP-CLOUD.md): the cloud scheduler, calendar and dashboard.
- [R2 media host](docs/SETUP-R2.md): only if you post Instagram images without the Worker.

All sign-ins use a local redirect to `http://localhost:8585/callback`. The tool prints the
sign-in link and never opens a browser itself. If the redirect can't reach your machine, add
`--manual` and paste the address the browser lands on.

## CLI reference

```
social init                         create ~/.config/social-publisher/apps.json (app keys go there)
social auth meta [--token T]        one sign-in for every Facebook Page + Instagram account
social auth youtube --brand B [--account A]
social auth pinterest --brand B
social auth linkedin [--app NAME | --brand B]
      (add --manual if the localhost redirect does not work)
social accounts [meta|youtube|pinterest|linkedin]   what the saved sign-ins can reach
social check [BRAND…]               test every platform set up for a brand (and the Worker)
social post SPEC.json [--dry-run] [--at "2026-11-05 18:30"|now] [--only a,b] [--skip a,b] [--force] [--approved-only]
social queue [remove ID | retry ID [--at T]]   posts waiting (cloud scheduler + local queue)
social history [N]                  what was sent, newest last
social blog schedule --brand B --slug S --at "2026-11-21 09:00" [--title T]
social strip FILE…                  remove C2PA, XMP, EXIF metadata from images/videos, in place
social calendar [--brand B] [--past 7] [--days 14] [--problems]
social analytics [--brand B] [--days 30] [--platform P] [--top 10] [--json]
social plan add --brand B --platforms instagram,facebook --at "2026-11-06 19:00" --title T [--match "a|b"] [--note N]
social plan import FILE.json        a list of { brand, platform(s), at, title, match?, note? }
social plan skip|done|open|delete ID
social sync [BRAND]                 read every platform now (the Worker also does it every 3 h)
social cloud setup|deploy|status|push
social cloud password [--set PW]    sign-in for the dashboard at <worker>/app
social cloud alerts --telegram | --to EMAIL --from "Name <addr>" [--on-publish] | --test
social run                          post the local queue's items that are due (the runner calls this)
social runner install|uninstall|status   macOS launchd runner, only needed without the Worker
```

`social help` prints the same list. Cloud job ids start with `j_`; plan ids with `p_`.

### Files and environment variables

| Where | What |
|---|---|
| `brands/<brand>.json` | Ids and settings per brand. No secrets. |
| `~/.config/social-publisher/apps.json` | App keys (Meta, Google, Pinterest, LinkedIn, R2, Sanity) and the Worker address + API key. |
| `~/.config/social-publisher/tokens.json` | Saved sign-ins. |
| `~/.config/social-publisher/history.jsonl` | Everything sent from this computer. |
| `~/.config/social-publisher/cloud/wrangler.jsonc` | Generated Worker config. |
| `~/.config/social-publisher/queue.json`, `runner.log` | Local queue and runner (without the Worker). |

| Variable | What it does |
|---|---|
| `SOCIAL_CONFIG_DIR` | Use another folder instead of `~/.config/social-publisher`. |
| `SOCIAL_BRANDS_DIR` | Use another folder for brand files (for example, brand files kept in a private repo). |
| `SOCIAL_DEFAULT_TZ` | Time zone for brands without `timezone`. Default `UTC`. |
| `SOCIAL_NO_CLOUD=1` | Don't use the Worker for this command; use the local queue. |
| `SOCIAL_NO_CLEAN=1` | Skip metadata stripping (used by the tests with fake media). |

## Cloud deploy

```sh
npx wrangler login
social cloud setup        # creates D1 + R2, deploys the Worker, sets its secrets, sends your sign-ins
social cloud password     # prints the dashboard password once
social cloud alerts --telegram      # or --to/--from for email
```

After any `social auth …`, run `social cloud push`. After updating this code, run
`social cloud deploy`. Full details, limits and what each piece does:
[docs/SETUP-CLOUD.md](docs/SETUP-CLOUD.md).

## MCP server

`mcp/server.mjs` is a stdio MCP server with no dependencies. It runs the `social` CLI for every
action, so the rules are the same as in the terminal.

**Claude Code:**

```sh
claude mcp add --scope user social-publisher -- node /path/to/social-publisher/mcp/server.mjs
```

**Other MCP clients** (Claude Desktop, Cursor, …): add a stdio server with command `node` and
argument `/path/to/social-publisher/mcp/server.mjs`. Pass `SOCIAL_CONFIG_DIR` or
`SOCIAL_BRANDS_DIR` in its `env` if you moved those folders.

**Tools:** `list_brands`, `check_accounts`, `create_post`, `preview_post`, `schedule_post`,
`list_queue`, `cancel_post`, `post_history`, `calendar`, `analytics`, `add_to_plan`.

### How the approval gate works

The intended flow is `create_post` → `preview_post` → a human reads the preview and says yes →
`schedule_post`. Three things back it up:

1. **Approved folders (in the server).** `schedule_post` refuses any media, cover or caption
   file that is not inside one of the brand's `approvedDirs` (symlinks are judged by where they
   point). It runs `social post --approved-only`, which checks every file again as it loads the
   post, copies each one once and uploads only that copy, so a file swapped after the check is
   never posted. Keep drafts somewhere else, and move a file into the approved folder only once
   a human has approved it. `create_post` and `preview_post` warn early when a file is outside.
   A text-only post with an inline caption has no file to check, so for those the hook below is
   the only gate: it shows the caption.
2. **Confirmation hooks (in the client).** See [Approval hooks](#approval-hooks).
3. **Instructions.** The server tells the agent to show the preview and wait for an explicit
   yes. This one relies on the agent, which is why 1 and 2 exist.

The server also checks every argument before it reaches the CLI: `at` must be `now`,
`"2026-11-06 18:30"` or ISO with an offset; `only` / `skip` must be platform names; brands must
exist; and values are passed as `--name=value`, so an argument like `"--force"` can never become
a flag. `create_post` refuses to write inside the config folder (`~/.config/social-publisher` or
`SOCIAL_CONFIG_DIR`), the brands folder, this repo, `~/.claude` or any `.claude` folder, and
validates the post before writing it.

The other tools are read-only or only write local files and plan rows. Nothing else posts.

### Approval hooks

Two Claude Code PreToolUse hooks ship in `hooks/`. Both answer "ask", so Claude Code shows you a
prompt even in modes that skip other prompts.

- `hooks/confirm-social-post.mjs` runs for `schedule_post` and `cancel_post`. The prompt shows
  the post file, its brand, media, the first 200 characters of its caption, and the `at`,
  `only` and `skip` the agent passed.
- `hooks/confirm-social-bash.mjs` runs for every Bash command. It asks when the command posts,
  schedules, retries or cancels with the CLI (`social post`, `social blog schedule`,
  `social queue retry|remove`, `social cloud deploy|push`, also as `node …/social.mjs …`), or
  calls the cloud scheduler with `curl`, `wget` or `fetch` on a `*.workers.dev/…/api/` URL. For
  any other command it says nothing and your normal permissions apply.

Add both to `~/.claude/settings.json` (use your real path):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__social-publisher__(schedule_post|cancel_post)",
        "hooks": [{ "type": "command", "command": "node /path/to/social-publisher/hooks/confirm-social-post.mjs", "timeout": 5 }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/social-publisher/hooks/confirm-social-bash.mjs", "timeout": 5 }]
      }
    ]
  }
}
```

Other clients: mark `schedule_post` and `cancel_post` as "always ask" in their tool permission
settings. The tools also carry `destructiveHint` annotations.

#### What the gate does not do

The hooks catch mistakes: an agent that skips the preview, picks the wrong file, or reaches for
the CLI instead of the MCP tool. They do **not** stop a hostile agent that has shell access. Such
an agent can write its own script, rename the binary, call the platform APIs directly, or read
the API token and sign-ins from `~/.config/social-publisher/`. If you can't trust the agent,
don't give it a shell on the machine that holds these files.

## Security notes

- **On your computer**, app keys and sign-in tokens are stored as plain JSON in
  `~/.config/social-publisher/` with owner-only permissions (folder `0700`, files `0600`). They
  are not encrypted. Anyone who can read your home folder can read them. Never put them in git.
- **On the Worker**, sign-ins and the app keys it needs are stored in D1, encrypted with AES-GCM.
  The key (`TOKEN_KEY`) is a Worker secret made during setup and never saved on your computer.
  The Worker also stores the job queue (final captions, ids, media keys), your plan, the posts
  it reads back from the platforms and their numbers, and failed-login counters per IP address.
  Media stays in a private R2 bucket until it is posted, then is deleted.
- **The Worker gets a copy of each brand's YouTube refresh token** (with the Google client id
  and secret) so the calendar can list uploads. That token also has upload rights. There is no
  switch to turn this off yet.
- **The API** (`/api/…`, used by the CLI) needs a random bearer token from setup.
- **The dashboard** uses one password (a Worker secret set by `social cloud password`). Sign-in
  gives an HMAC-signed, HttpOnly, Secure, SameSite=Strict cookie for 30 days. Changing the
  password signs every browser out. After 8 wrong passwords an address waits 15 minutes. Pages
  send a strict Content-Security-Policy and `noindex`. The dashboard can't read or change
  sign-ins and can't post.
- Media links given to Instagram and Pinterest are signed, for one file, and expire in 6 hours.
- **Fixed hosts.** The Worker sends stored sign-ins only to hosts written in its code
  (graph.facebook.com, api.pinterest.com or api-sandbox.pinterest.com, LinkedIn,
  `<projectId>.api.sanity.io`). Jobs and brand settings sent through the API can't name a host:
  the Graph version must look like `v24.0`, a Sanity `projectId` like `abc123` and its dataset
  like `production`, and a job's `tokenRef` / `appRef` must belong to its own platform (a blog
  job may only use `sanity:<its projectId>`). Bad jobs are refused when sent and again before
  they run.
- `npx` runs one pinned wrangler release (`WRANGLER_VERSION` in `src/cloud.mjs`). Raise it on
  purpose.
- The dashboard's CSV export prefixes cells starting with `=`, `+`, `-` or `@` with `'`, so a
  post title can't run as a spreadsheet formula.
- HTTP errors are logged with tokens in URLs replaced by `***`. Only GET requests are retried,
  so a failed POST can't publish twice.

## Limitations

- No X (Twitter), TikTok, Threads, Bluesky or Mastodon.
- Single user. No team mode, roles, approvals by other people, or per-user logins.
- No web editor: posts are JSON files. The dashboard is for viewing and planning.
- Instagram links in captions are not clickable (Instagram's rule). No Stories.
- No LinkedIn analytics, and the calendar can't see LinkedIn posts made outside this tool.
- YouTube's daily quota allows only a handful of uploads per day per Google Cloud project.
- Some helpers are macOS-only (see [Requirements](#requirements)).
- Built for a few brands and a few posts a day, not for agencies with hundreds of accounts.

## Tests

```sh
npm test      # Node 22+ runs everything; on Node 20 the Worker tests are skipped
```

The Worker tests run `cloud/worker.mjs` against a fake D1 (SQLite), a fake R2 and fake
platform APIs with a hand-moved clock. An end-to-end test runs `social post` against the Worker
on localhost (macOS, because it uses `sips`). The MCP test talks to the server over stdio. No
test calls a real network.

## Contributing

This is a personal tool, shared as is. Issues and pull requests are welcome, but there is no
promised support or roadmap. Platform APIs change often; if something breaks, an issue with
the error text helps most.

## License

MIT. See [LICENSE](LICENSE).
