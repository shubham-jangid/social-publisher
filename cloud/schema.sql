-- social-scheduler D1 schema. Safe to run again (IF NOT EXISTS).

-- One row per platform per post. `job` is everything the Mac worked out (final
-- caption, title, ids, media keys); the Worker only carries it out.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,               -- j_<hex>
  brand       TEXT NOT NULL,
  platform    TEXT NOT NULL,                  -- instagram | pinterest | linkedin
  spec        TEXT NOT NULL,                  -- post file path on the Mac (shown in lists)
  spec_id     TEXT,
  at          INTEGER NOT NULL,               -- post time, ms since epoch
  next_at     INTEGER NOT NULL,               -- when the Worker next looks at it
  status      TEXT NOT NULL,                  -- scheduled | preparing | published | failed | missed | cancelled
  step        TEXT NOT NULL DEFAULT 'start',
  job         TEXT NOT NULL,                  -- JSON
  state       TEXT NOT NULL DEFAULT '{}',     -- JSON, progress between steps
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,                        -- a run holding this row
  result      TEXT,                           -- JSON { id, url }
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, next_at);

-- Sign-ins and app keys, AES-GCM encrypted with the TOKEN_KEY secret.
CREATE TABLE IF NOT EXISTS secrets (
  ref        TEXT PRIMARY KEY,                -- meta:page:<id> | pinterest:<user> | linkedin:<app> | app:pinterest | app:linkedin:<app>
  iv         TEXT NOT NULL,
  data       TEXT NOT NULL,
  saved_at   TEXT,                            -- when the sign-in was made or renewed
  expires_at TEXT,                            -- when it stops working, if it does
  updated_at INTEGER NOT NULL
);

-- Small key/value notes (e.g. when an expiry warning was last sent).
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- ---- content calendar (cloud/calendar.mjs) ----

-- What each platform's API says is live or scheduled, refreshed every few hours.
CREATE TABLE IF NOT EXISTS seen (
  platform   TEXT NOT NULL,
  ext_id     TEXT NOT NULL,                   -- the platform's own post / video / pin id
  brand      TEXT NOT NULL,
  at         INTEGER NOT NULL,                -- published or scheduled time, ms
  status     TEXT NOT NULL,                   -- published | scheduled | private | stuck
  kind       TEXT,
  title      TEXT,
  text       TEXT,
  url        TEXT,
  synced_at  INTEGER NOT NULL,
  PRIMARY KEY (platform, ext_id)
);
CREATE INDEX IF NOT EXISTS seen_at ON seen (at);

-- What is meant to go out, one row per platform. Matched against seen + jobs.
CREATE TABLE IF NOT EXISTS plan (
  id         TEXT PRIMARY KEY,                -- p_<hex>
  brand      TEXT NOT NULL,
  platform   TEXT NOT NULL,
  at         INTEGER NOT NULL,
  title      TEXT NOT NULL,
  match      TEXT,                            -- JSON list of phrases that identify the post (default: title)
  spec       TEXT,
  note       TEXT,
  state      TEXT NOT NULL DEFAULT 'open',    -- open | skipped | done (done = marked by hand)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_at ON plan (at);

-- Performance numbers of each published post (views, likes, …), refreshed with every sync.
-- `data` is JSON with whatever the platform gives: views, reach, likes, comments, shares,
-- saves, impressions, clicks, watchMinutes, avgWatchSec, avgPctWatched, subscribers.
-- Rows not refreshed for 30 days are deleted (YouTube developer policies).
CREATE TABLE IF NOT EXISTS metrics (
  platform   TEXT NOT NULL,
  ext_id     TEXT NOT NULL,
  brand      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (platform, ext_id)
);
