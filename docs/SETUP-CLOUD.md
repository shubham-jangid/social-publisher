# Cloud scheduler (Cloudflare Worker)

Instagram, Pinterest and LinkedIn have no "schedule for later" in their APIs. The cloud
scheduler is a small Cloudflare Worker that posts them at the right time, so your computer can
be off. Facebook and YouTube don't need it: they schedule on their own side.

It also runs the calendar, the dashboard and the analytics sync.

## What it is

| Piece | What it does | Cloudflare free plan |
|---|---|---|
| Worker `social-scheduler` | moves each due post a few steps forward; serves the dashboard | 100,000 requests/day |
| Durable Object `Clock` | the alarm that wakes the Worker: at the earliest due job, at most once a minute, at least every 6 hours | included (SQLite-backed) |
| D1 database `social-scheduler` | the queue, the plan, synced posts and numbers, and the sign-ins (encrypted) | 5 GB |
| R2 bucket `social-scheduler-media` (private) | videos and images until they are posted | 10 GB, no download fees |

- **Nothing in the bucket is public.** Instagram and Pinterest get a signed link that works for
  6 hours and only for that one file. The Worker serves it; the bucket has no public URL.
- **Media is deleted** right after a post goes out (or is cancelled). A failed post keeps its
  media so it can be retried. A bucket rule deletes anything left after 60 days.
- **Sign-ins** are stored encrypted (AES-GCM) with a key that only the Worker has. It is made
  during setup and never saved on your computer. The Worker renews Pinterest and LinkedIn
  tokens itself and warns you 14 days before a sign-in needs doing again.
- **Prepared early, posted on time.** About 20 minutes before the post time the Worker uploads
  the media and lets the platform process the video, then publishes at the minute.
- **Never twice.** The step that publishes is never retried automatically. If it fails you get
  an alert and decide. Steps before it retry up to 3 times. A post that still isn't ready
  3 hours after its time is marked **missed**, not posted late.
- **Stays on the free plan.** A run makes at most 40 outside requests; a long upload (a big
  LinkedIn video goes up in pieces) carries on in the next run.

**Why an alarm, not a cron:** the free plan allows only 5 cron triggers per Cloudflare account,
and you may already use them for other projects. The alarm does the same job and doesn't count.
If you have a cron slot (or Workers Paid), set `"cron": true` in `apps.json` → `cloud` to add an
every-minute cron as well (both are safe together).

## Set up (once, about 5 minutes)

You need a Cloudflare account (the free plan is enough) with R2 switched on: dashboard → R2 →
enable it. Cloudflare asks for a payment card even for R2's free tier.

```sh
npx wrangler login
social cloud setup          # creates the database + bucket, deploys, sets the secrets
social cloud status
social cloud password       # makes the dashboard password and prints it once
```

`setup` is safe to run again. It saves the Worker address and its API key in
`~/.config/social-publisher/apps.json` → `cloud`. If wrangler can reach more than one
Cloudflare account, put the right `accountId` in that block first. You can also set `name`,
`database` and `bucket` there before the first run to use other names.

The generated wrangler config lives in `~/.config/social-publisher/cloud/wrangler.jsonc`.
`social cloud deploy` rewrites it from `apps.json`, so edit `apps.json`, not that file.

### Alerts

Failure alerts (and sign-in expiry warnings) go to Telegram, email, or both:

```sh
# Telegram: any bot from @BotFather and your chat id (or set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
social cloud alerts --telegram
# Email through Resend (asks for the API key, or set RESEND_API_KEY)
social cloud alerts --to you@example.com --from "Social <alerts@your-domain.example>"
social cloud alerts --test         # send a test message
# add --on-publish to also get a message each time something goes out
```

### Dashboard time zone

The dashboard shows times in the viewer's browser time zone. To fix one zone for everyone, set
`"dashboardTimezone": "Europe/London"` in `apps.json` → `cloud`, then `social cloud deploy`.

## Day to day

Nothing changes: `social post <file>` (or the MCP `schedule_post`) sends Instagram, Pinterest
and LinkedIn to the Worker automatically once it is set up.

```sh
social queue                 # what's waiting, plus failures from the last 7 days
social queue remove j_…      # cancel
social queue retry j_… [--at "2026-11-08 18:30"]
social cloud push            # after any `social auth …`, send the new sign-in (and brand ids) to the Worker
social cloud deploy          # after updating this tool's code
```

`SOCIAL_NO_CLOUD=1 social post …` skips the cloud and uses the local queue instead (your
computer must then be awake; see `social runner install`, macOS only).

## Brands you have switched off

A brand file with `"publishing": false` is never posted to. `social cloud deploy` passes these
brands to the Worker as `BLOCKED_BRANDS`, so it refuses new jobs for them and cancels old ones.
Add `"calendar": true` to keep such a brand visible (read-only) on the dashboard.

## If something looks wrong

- `social cloud status`: job counts, whether alerts are on, and every sign-in with days left.
- Logs: Cloudflare dashboard → Workers → social-scheduler → Logs.
- `social queue` shows the error text of any failed or missed job.
