// The content calendar: what was planned, what the tool scheduled, and what is
// really live on each platform, merged per brand and platform.
//
// Three sources:
//   plan  rows the owner or an agent adds ("Spring reel on Instagram, 5 Nov 19:00")
//   jobs  the cloud scheduler's own posts (Instagram, Pinterest, LinkedIn)
//   seen  what each platform's API says is published or scheduled, synced every few
//         hours, so posts made by hand, in Business Suite or in YouTube Studio count too
//
// A plan row is "done" when a seen post or a job of the same brand and platform,
// within a day and a half of its time, contains its match text. A plan row whose
// time has passed with no such post is "overdue" (not published).

export const SYNC_EVERY = 3 * 3600_000

// ---- fixed hosts -----------------------------------------------------------------------
// Stored sign-ins are only ever sent to these hosts. Values that reach the Worker through
// its API (a job, the brands list) may pick between them, never name a host of their own.
export const PINTEREST_API = 'https://api.pinterest.com/v5'
export const PINTEREST_SANDBOX = 'https://api-sandbox.pinterest.com/v5'

/** The Pinterest API base: production unless the caller asked for the sandbox. Any other value is refused. */
export function pinterestBase(base, sandbox = false) {
  if (base === undefined || base === null || base === '') return sandbox ? PINTEREST_SANDBOX : PINTEREST_API
  if (base === PINTEREST_API || base === PINTEREST_SANDBOX) return base
  throw new Error(`Pinterest API base "${String(base).slice(0, 80)}" is not allowed`)
}

/** Graph API version such as v24.0. Anything else is refused (it becomes part of the URL). */
export function graphVersion(v) {
  if (v === undefined || v === null || v === '') return 'v24.0'
  if (typeof v === 'string' && /^v\d+\.\d+$/.test(v)) return v
  throw new Error(`Graph API version "${String(v).slice(0, 40)}" is not allowed (use e.g. v24.0)`)
}
const MATCH_WINDOW = 36 * 3600_000
const FETCH_LIMIT = 50

// ---- matching ------------------------------------------------------------------------

/** Lower case, letters/numbers/marks only (keeps Devanagari), single spaces. */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
}

export function matchesText(match, ...texts) {
  const alts = [].concat(match || []).map(norm).filter(Boolean)
  if (!alts.length) return false
  const hay = texts.map(norm).join(' \n ')
  return alts.some((a) => hay.includes(a))
}

// ---- sync from the platforms ---------------------------------------------------------------

/**
 * Pulls the latest posts of every brand the Mac pushed (kv "brands") into `seen`.
 * deps: { getSecret, putSecret, fetch } (fetch counts against the run's budget).
 * Each platform is independent: one failing leaves the others' rows untouched.
 */
export async function syncPlatforms(env, deps, { only } = {}) {
  const brands = await loadBrandsCfg(env)
  const report = { at: Date.now(), results: [] }
  const google = { token: new Map() }
  for (const [key, b] of Object.entries(brands)) {
    if (only && only !== key) continue
    const jobs = []
    if (b.facebook?.pageId) jobs.push(['facebook', () => syncFacebook(env, deps, key, b)])
    if (b.instagram?.userId && b.facebook?.pageId) jobs.push(['instagram', () => syncInstagram(env, deps, key, b)])
    if (b.youtube?.channelId) jobs.push(['youtube', () => syncYouTube(env, deps, key, b, google)])
    if (b.pinterest?.username) jobs.push(['pinterest', () => syncPinterest(env, deps, key, b)])
    for (const [platform, fn] of jobs) {
      try {
        const items = await fn()
        await replaceSeen(env, key, platform, items)
        report.results.push({ brand: key, platform, ok: true, count: items.length, ...(items.limited?.length ? { limited: items.limited } : {}) })
      } catch (e) {
        report.results.push({ brand: key, platform, ok: false, error: String(e.message || e).slice(0, 300) })
      }
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('sync', ?)").bind(JSON.stringify(report)).run()
  return report
}

export async function loadBrandsCfg(env) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'brands'").first()
  return r ? JSON.parse(r.v) : {}
}

export async function lastSync(env) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'sync'").first()
  return r ? JSON.parse(r.v) : null
}

/**
 * Writes one platform's fresh list. Rows that were scheduled/private/stuck and are no
 * longer listed are dropped (posted, deleted or moved), and so are published rows inside
 * the fetched window that the platform no longer returns (deleted).
 */
async function replaceSeen(env, brand, platform, items) {
  const now = Date.now()
  const stmts = items.map((it) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO seen (platform, ext_id, brand, at, status, kind, title, text, url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(platform, String(it.id), brand, it.at, it.status, it.kind || null, it.title || null, (it.text || '').slice(0, 2000), it.url || null, now),
  )
  const published = items.filter((i) => i.status === 'published').map((i) => i.at)
  const oldest = published.length >= FETCH_LIMIT - 5 ? Math.min(...published) : 0
  for (const it of items)
    if (it.metrics && Object.keys(it.metrics).length)
      stmts.push(
        env.DB.prepare(`INSERT OR REPLACE INTO metrics (platform, ext_id, brand, at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
          platform,
          String(it.id),
          brand,
          it.at,
          JSON.stringify(it.metrics),
          now,
        ),
      )
  stmts.push(
    env.DB.prepare(
      `DELETE FROM seen WHERE brand = ? AND platform = ? AND synced_at < ? AND (status != 'published' OR at >= ?)`,
    ).bind(brand, platform, now, oldest),
  )
  // Numbers of posts that are gone, and any number not refreshed for 30 days (YouTube's
  // developer policies: API data is refreshed or deleted within 30 days).
  stmts.push(
    env.DB.prepare(
      `DELETE FROM metrics WHERE brand = ? AND platform = ? AND (updated_at < ? OR NOT EXISTS (SELECT 1 FROM seen s WHERE s.platform = metrics.platform AND s.ext_id = metrics.ext_id))`,
    ).bind(brand, platform, now - METRICS_TTL),
  )
  await env.DB.batch(stmts)
}

const METRICS_TTL = 30 * 86400_000

/** Number or undefined (APIs send counts as strings, or leave them out). */
const n = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
/** Drops undefined values so an empty result stays empty. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** Tries the rich request first (needs extra permissions), then the plain one. */
async function richOrPlain(rich, plain) {
  try {
    return { data: await rich(), rich: true }
  } catch (e) {
    return { data: await plain(), rich: false, why: String(e.message || e).slice(0, 160) }
  }
}

async function getJson(deps, platform, url, init) {
  const res = await deps.fetch(url, init)
  const text = await res.text()
  let data = text
  try {
    data = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const e = data?.error
    const msg = typeof e === 'object' ? e.message || JSON.stringify(e) : e || data?.message || String(text).slice(0, 200)
    throw new Error(`${platform} ${res.status}: ${msg}`)
  }
  return data
}

const GRAPH = (b) => `https://graph.facebook.com/${graphVersion(b.graphVersion)}`
const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 120)

async function syncFacebook(env, deps, key, b) {
  const { token } = await deps.getSecret(env, `meta:page:${b.facebook.pageId}`)
  const page = b.facebook.pageId
  const q = (path, fields) =>
    getJson(deps, 'facebook', `${GRAPH(b)}/${page}/${path}?fields=${fields}&limit=${FETCH_LIMIT}&access_token=${encodeURIComponent(token)}`)
  const PUB = 'id,created_time,message,permalink_url'
  const REELS = 'id,description,permalink_url,status'
  const [pub, sch, reels] = await Promise.all([
    // Reactions/comments/shares need pages_read_user_content; reel plays need read_insights.
    richOrPlain(
      () => q('published_posts', `${PUB},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares`),
      () => q('published_posts', PUB),
    ),
    q('scheduled_posts', 'id,scheduled_publish_time,message,permalink_url'),
    // Reels scheduled through the API show up here, not in scheduled_posts.
    richOrPlain(
      () => q('video_reels', `${REELS},video_insights`),
      () => q('video_reels', REELS),
    ).catch(() => ({ data: { data: [] } })),
  ])
  // Plays and reach of each reel, by reel id (a reel's post links to /reel/<id>/).
  const reelStats = new Map()
  for (const r of reels.data.data || []) {
    const v = {}
    for (const x of r.video_insights?.data || []) v[x.name] = x.values?.[0]?.value
    if (!Object.keys(v).length) continue
    reelStats.set(
      String(r.id),
      clean({
        views: n(v.fb_reels_total_plays),
        reach: n(v.post_impressions_unique),
        replays: n(v.fb_reels_replay_count),
        avgWatchSec: n(v.post_video_avg_time_watched) !== undefined ? Math.round(n(v.post_video_avg_time_watched) / 100) / 10 : undefined,
        followers: n(v.post_video_followers),
      }),
    )
  }
  const now = Date.now()
  const items = []
  for (const p of pub.data.data || []) {
    const reelId = String(p.permalink_url || '').match(/\/reel\/(\d+)/)?.[1]
    const metrics = clean({
      likes: n(p.reactions?.summary?.total_count),
      comments: n(p.comments?.summary?.total_count),
      shares: pub.rich ? n(p.shares?.count) ?? 0 : undefined,
      ...(reelId ? reelStats.get(reelId) : {}),
    })
    items.push({ id: p.id, at: Date.parse(p.created_time), status: 'published', kind: reelId ? 'reel' : undefined, text: p.message, title: firstLine(p.message), url: p.permalink_url, metrics })
  }
  for (const p of sch.data || []) {
    const at = Number(p.scheduled_publish_time) * 1000
    // A Page post whose time is more than an hour gone and still "scheduled" did not go out.
    items.push({ id: p.id, at, status: at < now - 3600_000 ? 'stuck' : 'scheduled', text: p.message, title: firstLine(p.message), url: p.permalink_url })
  }
  const texts = new Set(items.map((i) => norm(i.text).slice(0, 60)).filter(Boolean))
  for (const r of reels.data.data || []) {
    const ph = r.status?.publishing_phase
    if (ph?.publish_status !== 'scheduled' || !ph.publish_time) continue
    if (texts.has(norm(r.description).slice(0, 60))) continue
    const at = Date.parse(ph.publish_time) || Number(ph.publish_time) * 1000
    items.push({ id: `reel_${r.id}`, at, kind: 'reel', status: at < now - 3600_000 ? 'stuck' : 'scheduled', text: r.description, title: firstLine(r.description), url: r.permalink_url && `https://www.facebook.com${r.permalink_url}` })
  }
  items.limited = [!pub.rich && 'reactions/comments', !reels.rich && 'reel plays'].filter(Boolean)
  return items
}

async function syncInstagram(env, deps, key, b) {
  const { token } = await deps.getSecret(env, `meta:page:${b.facebook.pageId}`)
  const BASE = 'id,timestamp,caption,permalink,media_product_type,like_count,comments_count'
  const q = (fields) =>
    getJson(deps, 'instagram', `${GRAPH(b)}/${b.instagram.userId}/media?fields=${fields}&limit=${FETCH_LIMIT}&access_token=${encodeURIComponent(token)}`)
  // Views, reach, saves and shares need instagram_manage_insights.
  const r = await richOrPlain(() => q(`${BASE},insights.metric(views,reach,saved,shares,total_interactions)`), () => q(BASE))
  const items = (r.data.data || []).map((p) => {
    const ins = {}
    for (const x of p.insights?.data || []) ins[x.name] = x.values?.[0]?.value ?? x.total_value?.value
    return {
      id: p.id,
      at: Date.parse(p.timestamp),
      status: 'published',
      kind: p.media_product_type === 'REELS' ? 'reel' : 'post',
      text: p.caption,
      title: firstLine(p.caption),
      url: p.permalink,
      metrics: clean({
        views: n(ins.views),
        reach: n(ins.reach),
        likes: n(p.like_count),
        comments: n(p.comments_count),
        saves: n(ins.saved),
        shares: n(ins.shares),
        interactions: n(ins.total_interactions),
      }),
    }
  })
  items.limited = r.rich ? [] : ['views/reach/saves/shares']
  return items
}

async function googleToken(env, deps, channelId, google) {
  if (google.token.has(channelId)) return google.token.get(channelId)
  const s = await deps.getSecret(env, `youtube:${channelId}`)
  google.app ??= await deps.getSecret(env, 'app:google')
  const t = await getJson(deps, 'youtube', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: google.app.clientId, client_secret: google.app.clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' }),
  })
  google.token.set(channelId, t.access_token)
  return t.access_token
}

async function syncYouTube(env, deps, key, b, google) {
  const ch = b.youtube.channelId
  const token = await googleToken(env, deps, ch, google)
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const uploads = 'UU' + ch.slice(2) // every channel's uploads playlist
  const pl = await getJson(deps, 'youtube', `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=${FETCH_LIMIT}&playlistId=${uploads}`, auth)
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId)
  if (!ids.length) return []
  const v = await getJson(deps, 'youtube', `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics&id=${ids.join(',')}`, auth)
  // Watch time and % watched from the YouTube Analytics API (covered by the `youtube` scope; the
  // API must be enabled in the Google Cloud project). Without it, counts only.
  const deep = new Map()
  let limited = []
  try {
    const today = new Date().toISOString().slice(0, 10)
    const metricsList = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,shares,subscribersGained'
    const r = await getJson(
      deps,
      'youtube',
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2005-01-01&endDate=${today}&metrics=${metricsList}&dimensions=video&filters=${encodeURIComponent('video==' + ids.join(','))}&maxResults=200&sort=-views`,
      auth,
    )
    const cols = (r.columnHeaders || []).map((c) => c.name)
    for (const row of r.rows || []) {
      const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]))
      deep.set(o.video, o)
    }
  } catch {
    limited = ['watch time/retention']
  }
  const items = (v.items || []).map((x) => {
    const s = x.status
    const st = x.statistics || {}
    const a = deep.get(x.id) || {}
    const status = s.privacyStatus === 'public' || s.privacyStatus === 'unlisted' ? 'published' : s.publishAt ? 'scheduled' : 'private'
    return {
      id: x.id,
      at: Date.parse(s.publishAt || x.snippet.publishedAt),
      status,
      kind: /#shorts/i.test(x.snippet.title + x.snippet.description) ? 'short' : 'video',
      title: x.snippet.title,
      text: `${x.snippet.title}\n${x.snippet.description || ''}`,
      url: `https://youtu.be/${x.id}`,
      metrics: clean({
        views: n(st.viewCount),
        likes: n(st.likeCount),
        comments: n(st.commentCount),
        shares: n(a.shares),
        watchMinutes: n(a.estimatedMinutesWatched),
        avgWatchSec: n(a.averageViewDuration),
        avgPctWatched: n(a.averageViewPercentage) !== undefined ? Math.round(n(a.averageViewPercentage) * 10) / 10 : undefined,
        subscribers: n(a.subscribersGained),
      }),
    }
  })
  items.limited = limited
  return items
}

async function syncPinterest(env, deps, key, b) {
  const ref = `pinterest:${b.pinterest.username}`
  let s = await deps.getSecret(env, ref)
  const base = pinterestBase(b.pinterest.base)
  if (Date.parse(s.expiresAt) - Date.now() < 24 * 3600_000) {
    const app = await deps.getSecret(env, 'app:pinterest')
    const t = await getJson(deps, 'pinterest', `${base}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${app.appId}:${app.appSecret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken }),
    })
    const now = Date.now()
    s = {
      ...s,
      accessToken: t.access_token,
      refreshToken: t.refresh_token || s.refreshToken,
      expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
      refreshExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : s.refreshExpiresAt,
      savedAt: new Date().toISOString(),
    }
    await deps.putSecret(env, ref, s)
  }
  const r = await getJson(deps, 'pinterest', `${base}/pins?page_size=${FETCH_LIMIT}&pin_metrics=true`, { headers: { Authorization: `Bearer ${s.accessToken}` } })
  return (r.items || []).map((p) => ({
    id: p.id,
    at: Date.parse(p.created_at),
    status: 'published',
    kind: p.media?.media_type === 'video' ? 'video' : 'pin',
    title: p.title || firstLine(p.description),
    text: `${p.title || ''}\n${p.description || ''}`,
    url: `https://www.pinterest.com/pin/${p.id}/`,
    metrics: pinMetrics(p.pin_metrics?.lifetime_metrics || p.pin_metrics?.['90d']),
  }))
}

function pinMetrics(m) {
  if (!m) return undefined
  return clean({
    impressions: n(m.impression),
    views: n(m.video_views),
    clicks: n(m.pin_click),
    outbound: n(m.outbound_click),
    saves: n(m.save),
    likes: n(m.reaction),
    comments: n(m.comment),
    avgWatchSec: n(m.video_average_time) !== undefined ? Math.round(n(m.video_average_time) / 100) / 10 : undefined,
  })
}

// ---- the plan ------------------------------------------------------------------------------

const PLATFORM_NAMES = ['facebook', 'instagram', 'youtube', 'pinterest', 'linkedin']

/** Same brand + platform + minute + title → same id, so importing a plan twice changes nothing. */
async function planId(p) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${p.brand}|${p.platform}|${Math.floor(p.at / 60000)}|${p.title}`))
  return 'p_' + [...new Uint8Array(d)].slice(0, 6).map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function upsertPlan(env, items) {
  const now = Date.now()
  const ids = []
  const stmts = []
  for (const p of items) {
    if (!p.brand || !p.platform || !p.at || !p.title) throw Object.assign(new Error('each plan item needs brand, platform, at and title'), { httpStatus: 400 })
    if (!PLATFORM_NAMES.includes(p.platform)) throw Object.assign(new Error(`unknown platform ${p.platform}`), { httpStatus: 400 })
    const at = Number(p.at)
    const id = p.id || (await planId({ ...p, at }))
    ids.push(id)
    const match = p.match === undefined ? null : JSON.stringify([].concat(p.match))
    stmts.push(
      env.DB.prepare(
        `INSERT INTO plan (id, brand, platform, at, title, match, spec, note, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, title = excluded.title, match = excluded.match,
           spec = excluded.spec, note = excluded.note, updated_at = excluded.updated_at`,
      ).bind(id, p.brand, p.platform, at, String(p.title).slice(0, 200), match, p.spec || null, p.note || null, now, now),
    )
  }
  if (stmts.length) await env.DB.batch(stmts)
  return ids
}

export async function setPlanState(env, id, state) {
  if (!['open', 'skipped', 'done'].includes(state)) throw Object.assign(new Error('state must be open, skipped or done'), { httpStatus: 400 })
  const r = await env.DB.prepare('UPDATE plan SET state = ?, updated_at = ? WHERE id = ?').bind(state, Date.now(), id).run()
  if (!r.meta.changes) throw Object.assign(new Error(`no plan item ${id}`), { httpStatus: 404 })
}

export async function deletePlan(env, id) {
  const r = await env.DB.prepare('DELETE FROM plan WHERE id = ?').bind(id).run()
  if (!r.meta.changes) throw Object.assign(new Error(`no plan item ${id}`), { httpStatus: 404 })
}

// ---- the merged calendar ------------------------------------------------------------------

/**
 * Every entry between `from` and `to` (ms), newest last. Each entry:
 * { key, brand, platform, at, status, title, text, url, kind, source, planId, jobId, error }
 * status: published | scheduled | preparing | private | stuck | failed | missed | planned | overdue | skipped
 */
export async function buildCalendar(env, { from, to, brand } = {}) {
  const now = Date.now()
  from ??= now - 30 * 86400_000
  to ??= now + 30 * 86400_000
  const pad = MATCH_WINDOW
  const where = (col, t = '') => `${t}${col} >= ? AND ${t}${col} <= ?${brand ? ` AND ${t}brand = ?` : ''}`
  const args = (a, b) => (brand ? [a, b, brand] : [a, b])

  const [seen, jobs, plan] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*, m.data AS metrics, m.updated_at AS metrics_at FROM seen s
         LEFT JOIN metrics m ON m.platform = s.platform AND m.ext_id = s.ext_id
       WHERE ${where('at', 's.')} ORDER BY s.at`,
    )
      .bind(...args(from - pad, to + pad))
      .all(),
    env.DB.prepare(`SELECT id, brand, platform, spec, spec_id, at, status, step, result, error, job FROM jobs WHERE ${where('at')} AND status != 'cancelled' ORDER BY at`)
      .bind(...args(from - pad, to + pad))
      .all(),
    env.DB.prepare(`SELECT * FROM plan WHERE ${where('at')} ORDER BY at`).bind(...args(from, to)).all(),
  ])

  const entries = []
  const byExt = new Map()
  for (const s of seen.results) {
    const e = {
      key: `s:${s.platform}:${s.ext_id}`,
      brand: s.brand,
      platform: s.platform,
      at: s.at,
      status: s.status,
      title: s.title || firstLine(s.text),
      text: s.text,
      url: s.url,
      kind: s.kind,
      source: 'platform',
      ...(s.metrics ? { metrics: JSON.parse(s.metrics), metricsAt: s.metrics_at } : {}),
    }
    entries.push(e)
    byExt.set(`${s.platform}:${s.ext_id}`, e)
  }
  for (const j of jobs.results) {
    const result = j.result ? JSON.parse(j.result) : null
    const live = result?.id && byExt.get(`${j.platform}:${result.id}`)
    if (live) {
      // The platform has it: the job just adds where it came from.
      Object.assign(live, { source: 'tool', jobId: j.id })
      continue
    }
    let job = {}
    try {
      job = JSON.parse(j.job)
    } catch {}
    entries.push({
      key: `j:${j.id}`,
      brand: j.brand,
      platform: j.platform,
      at: j.at,
      // A published result is final even if a later step errored.
      status: result?.id ? 'published' : j.status,
      title: job.title || firstLine(job.caption) || j.spec_id || j.spec.split('/').pop(),
      text: job.caption || '',
      url: result?.url || null,
      kind: job.kind,
      source: 'tool',
      jobId: j.id,
      spec: j.spec,
      error: result?.id ? null : j.error,
    })
  }

  // Plans claim the closest matching post; one post satisfies one plan row.
  const claimed = new Set()
  const out = []
  for (const p of plan.results) {
    const match = p.match ? JSON.parse(p.match) : [p.title]
    let best = null
    for (const e of entries) {
      if (claimed.has(e.key) || e.brand !== p.brand || e.platform !== p.platform) continue
      const dt = Math.abs(e.at - p.at)
      if (dt > MATCH_WINDOW) continue
      if (!matchesText(match, e.title, e.text)) continue
      if (!best || dt < Math.abs(best.at - p.at)) best = e
    }
    if (best) {
      claimed.add(best.key)
      Object.assign(best, { planId: p.id, planTitle: p.title, planAt: p.at, note: p.note })
      continue
    }
    const status = p.state === 'skipped' ? 'skipped' : p.state === 'done' ? 'published' : p.at < now ? 'overdue' : 'planned'
    out.push({ key: `p:${p.id}`, brand: p.brand, platform: p.platform, at: p.at, status, title: p.title, note: p.note, source: 'plan', planId: p.id, spec: p.spec, manual: p.state === 'done' })
  }
  for (const e of entries) if (e.at >= from && e.at <= to) out.push(e)
  out.sort((a, b) => a.at - b.at || a.platform.localeCompare(b.platform))
  return out
}
