// social-scheduler: a Cloudflare Worker that posts Instagram, Pinterest and
// LinkedIn jobs at their scheduled time, so the Mac does not have to be awake.
//
// The Mac does the thinking (final caption, ids, boards) and uploads the media
// to a private R2 bucket. Every minute the cron run moves each job one or more
// small steps forward. Media is handed to Instagram and Pinterest as short-lived
// signed links served by this Worker; nothing in the bucket is public.
//
// Free-plan friendly: each run makes at most BUDGET outside requests and a long
// job (a big LinkedIn video) simply continues on the next run.

import { SYNC_EVERY, buildCalendar, deletePlan, graphVersion, lastSync, loadBrandsCfg, pinterestBase, setPlanState, syncPlatforms, upsertPlan } from './calendar.mjs'
import { APP_CSS, APP_JS, dashboardHtml, loginHtml } from './dashboard.mjs'

const BUDGET = 40 // outside fetches per run (the free plan allows 50)
const PREP_LEAD = 20 * 60_000 // start uploading/processing this long before the post time
const MAX_LATE = 3 * 3600_000 // never post more than this late
const LEASE = 4 * 60_000
const LINK_TTL = 6 * 3600 // seconds a signed media link stays valid
const FINAL_STEP = 'publish'
const ACTIVE = ['scheduled', 'preparing']

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx)
    } catch (e) {
      return json({ error: e.message }, e.httpStatus || 500)
    }
  },
  // Only used if the account has a cron slot free (Workers Paid). Normally the Clock below runs things.
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.log(`tick failed: ${e.stack || e.message}`)))
  },
}

// ---- the clock --------------------------------------------------------------------
// The free plan allows only 5 cron triggers per Cloudflare account, and other projects
// use them. A Durable Object alarm does the same job and doesn't count: after each run
// it sets the next alarm for the earliest due job (at least a minute, at most 6 hours
// away, so the sign-in expiry check still runs) and sleeps when nothing is waiting.
const IDLE_WAKE = 6 * 3600_000

export class Clock {
  constructor(state, env) {
    this.state = state
    this.env = env
  }
  /** Makes sure an alarm is set no later than the earliest due job. */
  async fetch() {
    const want = await nextWake(this.env)
    const cur = await this.state.storage.getAlarm()
    if (cur == null || cur > want) await this.state.storage.setAlarm(want)
    return json({ alarm: new Date(Math.min(cur ?? Infinity, want)).toISOString() })
  }
  async alarm() {
    try {
      await tick(this.env)
    } catch (e) {
      console.log(`tick failed: ${e.stack || e.message}`)
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 60_000, await nextWake(this.env).catch(() => 0)))
  }
}

async function nextWake(env) {
  const r = await env.DB.prepare(`SELECT MIN(next_at) AS t FROM jobs WHERE status IN ('scheduled','preparing')`).first()
  const sync = await syncDueAt(env).catch(() => Infinity)
  return Math.min(Date.now() + IDLE_WAKE, Math.max(Date.now() + 1000, Math.min(r?.t ?? Infinity, sync)))
}

/** When the calendar should next pull from the platforms (Infinity if no brands were pushed). */
async function syncDueAt(env) {
  const brands = await loadBrandsCfg(env)
  if (!Object.keys(brands).length) return Infinity
  const last = await lastSync(env)
  return last ? last.at + SYNC_EVERY : 0
}

const syncDeps = (run) => ({
  getSecret,
  putSecret,
  fetch: (u, o) => {
    run.fetches++
    return fetch(u, o)
  },
})

/** Wakes the Clock (if this Worker has one). Never fails the request. */
async function poke(env) {
  if (!env.CLOCK) return
  try {
    await env.CLOCK.get(env.CLOCK.idFromName('main')).fetch('https://clock/poke')
  } catch (e) {
    console.log(`clock poke: ${e.message}`)
  }
}

// ---- http ---------------------------------------------------------------------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

class HttpError extends Error {
  constructor(status, msg) {
    super(msg)
    this.httpStatus = status
  }
}

async function route(req, env, ctx) {
  const url = new URL(req.url)
  const p = url.pathname

  if (p.startsWith('/m/') && (req.method === 'GET' || req.method === 'HEAD')) return serveMedia(req, env, url)
  if (p === '/favicon.ico' || p === '/robots.txt') return new Response(p === '/robots.txt' ? 'User-agent: *\nDisallow: /\n' : '', { status: p === '/robots.txt' ? 200 : 404 })
  if (p === '/' || p === '/login' || p === '/logout' || p.startsWith('/app')) return dashboard(req, env, url)
  if (!p.startsWith('/api/')) return new Response('Not found', { status: 404 })

  await requireAuth(req, env)
  await rememberOrigin(env, url.origin)
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null

  const cal = await calendarApi(req, env, url, p, body)
  if (cal) return cal
  if (p === '/api/brands' && req.method === 'POST') {
    // The Mac sends the brands' ids (Page, Instagram, channel, Pinterest user) for the calendar sync.
    // A switched-off brand is kept only when marked view-only; posting for it stays blocked (jobs + tick).
    const brands = Object.fromEntries(Object.entries(body.brands || {}).filter(([k, b]) => !blocked(env, k) || b?.viewOnly === true))
    for (const [k, b] of Object.entries(brands)) {
      try {
        checkBrandCfg(b)
      } catch (e) {
        throw new HttpError(400, `brand ${k}: ${e.message}`)
      }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('brands', ?)").bind(JSON.stringify(brands)).run()
    await poke(env)
    return json({ brands: Object.keys(brands) })
  }

  // uploads (the Mac sends media in parts; R2 multipart)
  if (p === '/api/upload/start' && req.method === 'POST') {
    const name = String(body.name || 'file').replace(/[^\w.-]+/g, '-').slice(-80)
    const key = `media/${Date.now()}-${randHex(4)}/${name}`
    const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: body.mime || 'application/octet-stream' } })
    return json({ key, uploadId: mpu.uploadId })
  }
  if (p === '/api/upload/part' && req.method === 'PUT') {
    const key = url.searchParams.get('key')
    const mpu = env.MEDIA.resumeMultipartUpload(key, url.searchParams.get('uploadId'))
    const part = await mpu.uploadPart(Number(url.searchParams.get('n')), await req.arrayBuffer())
    return json(part)
  }
  if (p === '/api/upload/complete' && req.method === 'POST') {
    const mpu = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId)
    const obj = await mpu.complete(body.parts)
    return json({ key: obj.key, size: obj.size })
  }
  if (p === '/api/upload/abort' && req.method === 'POST') {
    await env.MEDIA.resumeMultipartUpload(body.key, body.uploadId).abort()
    return json({ ok: true })
  }

  // jobs
  if (p === '/api/jobs' && req.method === 'POST') {
    const now = Date.now()
    const ids = []
    const stmts = []
    for (const j of body.jobs || []) {
      for (const k of ['brand', 'platform', 'spec', 'job']) if (!j[k]) throw new HttpError(400, `job is missing "${k}"`)
      if (!PLATFORMS[j.platform]) throw new HttpError(400, `unknown platform ${j.platform}`)
      if (blocked(env, j.brand)) throw new HttpError(403, `publishing to ${j.brand} is switched off`)
      try {
        checkJob(j.platform, j.job)
      } catch (e) {
        throw new HttpError(400, e.message)
      }
      const at = Number(j.at) || now
      const id = `j_${randHex(5)}`
      ids.push(id)
      stmts.push(
        env.DB.prepare(
          `INSERT INTO jobs (id, brand, platform, spec, spec_id, at, next_at, status, step, job, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'start', ?, '{}', ?, ?)`,
        ).bind(id, j.brand, j.platform, j.spec, j.specId || null, at, Math.max(now, at - PREP_LEAD), JSON.stringify(j.job), now, now),
      )
    }
    if (stmts.length) await env.DB.batch(stmts)
    // No work here: a request's background time is short, and a big upload would be cut off.
    // The Clock's alarm (or the cron) picks it up.
    await poke(env)
    return json({ ids })
  }
  if (p === '/api/jobs' && req.method === 'GET') {
    const all = url.searchParams.get('all') === '1'
    const limit = Math.min(500, Number(url.searchParams.get('limit') || 100))
    const q = all
      ? env.DB.prepare(`SELECT ${SUMMARY} FROM jobs ORDER BY at DESC LIMIT ?`).bind(limit)
      : env.DB.prepare(`SELECT ${SUMMARY} FROM jobs WHERE status IN ('scheduled','preparing') ORDER BY at LIMIT ?`).bind(limit)
    return json({ jobs: (await q.all()).results.map(summary) })
  }
  const m = p.match(/^\/api\/jobs\/(j_[0-9a-f]+)(\/retry)?$/)
  if (m) {
    const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(m[1]).first()
    if (!row) throw new HttpError(404, `no job ${m[1]}`)
    if (req.method === 'GET' && !m[2]) return json({ ...summary(row), job: JSON.parse(row.job), state: JSON.parse(row.state) })
    if (req.method === 'DELETE' && !m[2]) {
      if (!ACTIVE.includes(row.status)) throw new HttpError(409, `job is already ${row.status}`)
      if (row.lease_until && row.lease_until > Date.now()) throw new HttpError(409, 'job is being worked on right now; try again in a minute')
      if (row.step === FINAL_STEP && Date.now() >= row.at) throw new HttpError(409, 'job is posting right now')
      await setJob(env, row, { status: 'cancelled' })
      await cleanupMedia(env, row).catch((e) => console.log(`cleanup: ${e.message}`))
      return json({ ok: true, id: row.id })
    }
    if (req.method === 'POST' && m[2]) {
      if (ACTIVE.includes(row.status) || row.status === 'published') throw new HttpError(409, `job is ${row.status}`)
      const at = body.at ? Number(body.at) : Math.max(Date.now(), row.at)
      await setJob(env, row, { status: 'scheduled', step: 'start', state: '{}', attempts: 0, error: null, at, next_at: Math.max(Date.now(), at - PREP_LEAD) })
      await poke(env)
      return json({ ok: true, id: row.id })
    }
  }

  // sign-ins and app keys
  if (p === '/api/secrets' && req.method === 'POST') {
    const saved = []
    const kept = []
    for (const [ref, value] of Object.entries(body.items || {})) {
      const cur = await env.DB.prepare('SELECT saved_at FROM secrets WHERE ref = ?').bind(ref).first()
      if (cur?.saved_at && value.savedAt && cur.saved_at > value.savedAt) {
        kept.push(ref) // the Worker renewed it more recently than the Mac's copy
        continue
      }
      await putSecret(env, ref, value)
      saved.push(ref)
    }
    return json({ saved, kept })
  }
  const del = p.match(/^\/api\/secrets\/(.+)$/)
  if (del && req.method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM secrets WHERE ref = ?').bind(decodeURIComponent(del[1])).run()
    return json({ deleted: r.meta.changes })
  }

  if (p === '/api/secrets' && req.method === 'GET') {
    const r = await env.DB.prepare('SELECT ref, saved_at, expires_at FROM secrets ORDER BY ref').all()
    return json({ secrets: r.results })
  }

  if (p === '/api/health') {
    await poke(env) // also restarts the Clock if it ever lost its alarm
    const r = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
    return json({
      ok: true,
      now: new Date().toISOString(),
      clock: env.CLOCK ? 'alarm' : 'cron',
      jobs: Object.fromEntries(r.results.map((x) => [x.status, x.n])),
      alerts: alertsOn(env),
      alertsVia: [env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && 'telegram', env.RESEND_API_KEY && env.ALERT_TO && 'email'].filter(Boolean),
    })
  }
  if (p === '/api/alerts/test' && req.method === 'POST') {
    if (!alertsOn(env)) throw new HttpError(409, 'no alert channel is set up')
    await alert(env, 'Test from social-scheduler', 'Alerts work. You will get a message like this if a scheduled post fails, is missed, or a sign-in is about to expire.')
    return json({ ok: true })
  }
  if (p === '/api/run' && req.method === 'POST') return json(await tick(env))

  throw new HttpError(404, `no route ${req.method} ${p}`)
}

// ---- calendar API (Mac: bearer token · dashboard: session cookie) -----------------------

async function calendarApi(req, env, url, p, body) {
  if (p === '/api/calendar' && req.method === 'GET') {
    const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined)
    const entries = await buildCalendar(env, { from: num('from'), to: num('to'), brand: url.searchParams.get('brand') || undefined })
    const brands = await loadBrandsCfg(env)
    return json({
      now: Date.now(),
      entries,
      sync: await lastSync(env),
      brands: Object.fromEntries(Object.entries(brands).map(([k, b]) => [k, { name: b.name, timezone: b.timezone, platforms: b.platforms || [], ...(b.viewOnly ? { viewOnly: true } : {}) }])),
    })
  }
  if (p === '/api/plan' && req.method === 'POST') return json({ ids: await upsertPlan(env, body.items || []) })
  const pm = p.match(/^\/api\/plan\/(p_[0-9a-f]+)$/)
  if (pm && req.method === 'POST') {
    await setPlanState(env, pm[1], body.state)
    return json({ ok: true })
  }
  if (pm && req.method === 'DELETE') {
    await deletePlan(env, pm[1])
    return json({ ok: true })
  }
  if (p === '/api/sync' && req.method === 'POST') {
    const run = { fetches: 0 }
    return json(await syncPlatforms(env, syncDeps(run), { only: body?.brand }))
  }
  if (p === '/api/sync' && req.method === 'GET') return json((await lastSync(env)) || {})
  return null
}

// ---- dashboard: sign-in + calendar page -----------------------------------------------------

const SESSION_MS = 30 * 86400_000
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}
const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...extra } })
const redirect = (to, extra = {}) => new Response(null, { status: 303, headers: { location: to, ...SECURITY_HEADERS, ...extra } })

function sessionSecret(env) {
  if (!env.DASH_PASSWORD) throw new HttpError(503, 'The dashboard has no password yet. On the Mac: social cloud password')
  // Changing the password signs every browser out.
  return `${env.DASH_PASSWORD}|${env.MEDIA_KEY}`
}

async function newSession(env) {
  const exp = Date.now() + SESSION_MS
  return `${exp}.${await hmacHex(sessionSecret(env), `session\n${exp}`)}`
}

async function hasSession(req, env) {
  if (!env.DASH_PASSWORD) return false
  const m = /(?:^|;\s*)sp_s=(\d+)\.([0-9a-f]{64})/.exec(req.headers.get('cookie') || '')
  if (!m || Number(m[1]) < Date.now()) return false
  return timingSafe(await hmacHex(sessionSecret(env), `session\n${m[1]}`), m[2])
}

const cookie = (v, maxAge) => `sp_s=${v}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`

/** At most 8 wrong passwords per address per 15 minutes. */
async function loginThrottle(env, ip, failed) {
  const k = `login:${ip}`
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first()
  let s = row ? JSON.parse(row.v) : { n: 0, t: Date.now() }
  if (Date.now() - s.t > 15 * 60_000) s = { n: 0, t: Date.now() }
  if (failed) {
    s.n++
    await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, JSON.stringify(s)).run()
  }
  return s.n >= 8
}

async function dashboard(req, env, url) {
  const p = url.pathname
  if (p === '/app/app.css') return new Response(APP_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', ...SECURITY_HEADERS } })
  if (p === '/app/app.js') return new Response(APP_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SECURITY_HEADERS } })

  if (p === '/login' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') || 'local'
    if (await loginThrottle(env, ip, false)) return html(loginHtml('Too many tries. Wait 15 minutes.'), 429)
    const form = await req.formData().catch(() => null)
    const given = String(form?.get('password') || '')
    const [a, b] = await Promise.all([sha256(given), sha256(env.DASH_PASSWORD || randHex(16))])
    let diff = env.DASH_PASSWORD ? 0 : 1
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    if (diff) {
      await loginThrottle(env, ip, true)
      return html(loginHtml(env.DASH_PASSWORD ? 'Wrong password.' : 'No password is set yet. On the Mac run: social cloud password'), 401)
    }
    return redirect('/app', { 'set-cookie': cookie(await newSession(env), SESSION_MS / 1000) })
  }
  if (p === '/logout') return redirect('/login', { 'set-cookie': cookie('', 0) })

  const signedIn = await hasSession(req, env)
  if (p === '/' || p === '/login') return signedIn ? redirect('/app') : html(loginHtml())
  if (!signedIn) return p.startsWith('/app/api/') ? json({ error: 'signed out' }, 401) : redirect('/login')
  if (p === '/app' || p === '/app/') return html(dashboardHtml(env.DASH_TZ))

  if (p.startsWith('/app/api/')) {
    // Same handlers as the Mac's /api/…, but only the calendar ones.
    const apiPath = p.slice(4)
    if (req.method === 'POST' && req.headers.get('content-type') !== 'application/json') return json({ error: 'json only' }, 415)
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null
    if (apiPath === '/api/health') {
      const r = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
      return json({ ok: true, jobs: Object.fromEntries(r.results.map((x) => [x.status, x.n])) })
    }
    const r = await calendarApi(req, env, url, apiPath, body)
    if (r) return r
  }
  return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
}

const SUMMARY = 'id, brand, platform, spec, spec_id, at, next_at, status, step, attempts, result, error, updated_at'
const summary = (r) => ({
  id: r.id,
  brand: r.brand,
  platform: r.platform,
  spec: r.spec,
  specId: r.spec_id,
  at: r.at,
  status: r.status,
  step: r.step,
  attempts: r.attempts,
  result: r.result ? JSON.parse(r.result) : null,
  error: r.error,
  updatedAt: r.updated_at,
})

async function requireAuth(req, env) {
  if (!env.API_TOKEN) throw new HttpError(500, 'API_TOKEN secret is not set')
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const [a, b] = await Promise.all([sha256(got), sha256(env.API_TOKEN)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  if (diff) throw new HttpError(401, 'unauthorized')
}

async function rememberOrigin(env, origin) {
  const cur = await env.DB.prepare("SELECT v FROM kv WHERE k = 'origin'").first()
  if (cur?.v !== origin) await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('origin', ?)").bind(origin).run()
}

// ---- signed media links --------------------------------------------------------

async function mediaUrl(c, m) {
  if (!c.origin) {
    const r = await c.env.DB.prepare("SELECT v FROM kv WHERE k = 'origin'").first()
    c.origin = c.env.PUBLIC_URL || r?.v
    if (!c.origin) throw new Error('Worker URL unknown: call any /api route once (social cloud status)')
  }
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL
  const sig = await hmacHex(c.env.MEDIA_KEY, `${m.key}\n${exp}`)
  return `${c.origin}/m/${m.key.split('/').map(encodeURIComponent).join('/')}?e=${exp}&s=${sig}`
}

async function serveMedia(req, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3))
  const exp = Number(url.searchParams.get('e'))
  const sig = url.searchParams.get('s') || ''
  if (!env.MEDIA_KEY || !exp || exp < Date.now() / 1000) return new Response('Link expired', { status: 403 })
  const want = await hmacHex(env.MEDIA_KEY, `${key}\n${exp}`)
  if (want.length !== sig.length || !timingSafe(want, sig)) return new Response('Forbidden', { status: 403 })

  const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' })
  if (req.method === 'HEAD') {
    const h = await env.MEDIA.head(key)
    if (!h) return new Response(null, { status: 404 })
    h.writeHttpMetadata(headers)
    headers.set('content-length', String(h.size))
    return new Response(null, { headers })
  }
  const hasRange = req.headers.has('range')
  const obj = await env.MEDIA.get(key, hasRange ? { range: req.headers } : {})
  if (!obj) return new Response('Not found', { status: 404 })
  obj.writeHttpMetadata(headers)
  if (hasRange && obj.range) {
    let { offset, length, suffix } = obj.range
    if (suffix !== undefined) {
      offset = obj.size - suffix
      length = suffix
    }
    offset ??= 0
    length ??= obj.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
    headers.set('content-length', String(length))
    return new Response(obj.body, { status: 206, headers })
  }
  headers.set('content-length', String(obj.size))
  return new Response(obj.body, { headers })
}

// ---- the run -------------------------------------------------------------------

/** Brands the owner has switched off (BLOCKED_BRANDS, from brand files with "publishing": false). */
function blocked(env, brand) {
  return String(env.BLOCKED_BRANDS || '').split(',').map((x) => x.trim()).filter(Boolean).includes(brand)
}

export async function tick(env) {
  const now = Date.now()
  const due = await env.DB.prepare(
    `SELECT * FROM jobs WHERE status IN ('scheduled','preparing') AND next_at <= ?
       AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_at LIMIT 20`,
  )
    .bind(now, now)
    .all()
  const run = { fetches: 0, touched: [] }
  for (const row of due.results) {
    if (run.fetches >= BUDGET - 6) break
    const claim = await env.DB.prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)')
      .bind(now + LEASE, row.id, now)
      .run()
    if (!claim.meta.changes) continue
    run.touched.push(row.id)
    await advance(env, run, row)
  }
  await expiryWarnings(env, run).catch((e) => console.log(`expiry check: ${e.message}`))
  // Calendar sync (about 10 requests per brand) only when posting work left room in this run's budget.
  if (run.fetches <= BUDGET - 22 && (await syncDueAt(env)) <= now)
    run.synced = (await syncPlatforms(env, syncDeps(run)).catch((e) => ({ error: e.message }))).results?.length ?? 0
  return { due: due.results.length, worked: run.touched, fetches: run.fetches, synced: run.synced }
}

async function advance(env, run, row) {
  if (blocked(env, row.brand)) {
    await setJob(env, row, { status: 'cancelled', error: 'publishing to this brand is switched off' })
    await cleanupMedia(env, row).catch(() => {})
    return
  }
  const job = JSON.parse(row.job)
  try {
    checkJob(row.platform, job) // also for jobs stored before these checks existed
  } catch (e) {
    await setJob(env, row, { status: 'failed', error: `refused: ${e.message}` })
    return alert(env, `Post refused: ${row.brand} ${row.platform}`, `${row.spec}\n\n${e.message}\n\nNothing was posted.`)
  }
  const state = JSON.parse(row.state || '{}')
  const P = PLATFORMS[row.platform]
  const c = {
    env,
    run,
    job,
    state,
    row,
    low: (n = 3) => run.fetches >= BUDGET - n,
    fetch: (u, o) => {
      run.fetches++
      return fetch(u, o)
    },
  }
  let step = row.step
  try {
    for (let i = 0; i < 20; i++) {
      const now = Date.now()
      if (step === FINAL_STEP && now < row.at - 30_000)
        return setJob(env, row, { status: 'preparing', step, state: JSON.stringify(state), next_at: row.at })
      if (now > row.at + MAX_LATE) {
        const late = Math.round((now - row.at) / 60000)
        await setJob(env, row, { status: 'missed', step, state: JSON.stringify(state), error: `still not ready ${late} min after its time, so not posted` })
        await cleanupMedia(env, row).catch(() => {})
        return alert(env, `Post missed: ${row.brand} ${row.platform}`, `${row.spec}\nIt was still not ready ${late} min after ${new Date(row.at).toISOString()} (stuck at "${step}") and was not posted.`)
      }
      if (c.low()) return setJob(env, row, { status: 'preparing', step, state: JSON.stringify(state), next_at: Date.now() })
      const r = await P[step](c)
      if (r.done) {
        await setJob(env, row, { status: 'published', step: 'done', state: JSON.stringify(state), result: JSON.stringify(r.done), error: null })
        // The post is live. Nothing after this line may turn it into a "failure".
        await cleanupMedia(env, row).catch((e) => console.log(`${row.id} cleanup after publish: ${e.message}`))
        if (env.ALERT_ON_PUBLISH === '1')
          await alert(env, `Posted: ${row.brand} ${row.platform}`, `${row.spec}\n${r.done.url || r.done.id}`).catch(() => {})
        return
      }
      if (r.wait !== undefined)
        return setJob(env, row, { status: 'preparing', step, state: JSON.stringify(state), next_at: Date.now() + r.wait })
      step = r.next
    }
    return setJob(env, row, { status: 'preparing', step, state: JSON.stringify(state), next_at: Date.now() })
  } catch (e) {
    const msg = String(e.message || e).slice(0, 900)
    console.log(`${row.id} ${row.platform} ${step}: ${msg}`)
    if (step === FINAL_STEP) {
      // Never retry the step that publishes: if the request got through, a retry posts twice.
      const unsure = !(e instanceof ApiError && e.status >= 400 && e.status < 500)
      const error = msg + (unsure ? ' (it may have posted anyway: check the account before retrying)' : '')
      await setJob(env, row, { status: 'failed', step, state: JSON.stringify(state), error })
      return alert(env, `Post failed: ${row.brand} ${row.platform}`, `${row.spec}\n\n${error}\n\nRetry: social queue retry ${row.id}`)
    }
    const attempts = row.attempts + 1
    if (attempts < 3 && Date.now() < row.at + MAX_LATE) {
      const restart = e.restart ? { step: 'start', state: '{}' } : { step, state: JSON.stringify(state) }
      return setJob(env, row, { status: 'preparing', ...restart, attempts, error: msg, next_at: Date.now() + attempts * 2 * 60_000 })
    }
    await setJob(env, row, { status: 'failed', step, state: JSON.stringify(state), attempts, error: msg })
    return alert(env, `Post failed: ${row.brand} ${row.platform}`, `${row.spec}\n\nWhile "${step}": ${msg}\n\nNothing was posted. Retry: social queue retry ${row.id}`)
  }
}

async function setJob(env, row, fields) {
  const keys = Object.keys(fields)
  await env.DB.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, lease_until = NULL WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), Date.now(), row.id)
    .run()
}

/** Deletes this job's media unless another unfinished job still uses it. Failed jobs keep theirs for a retry. */
async function cleanupMedia(env, row) {
  const job = JSON.parse(row.job)
  const keys = [...(job.media || []), job.cover].filter(Boolean).map((m) => m.key)
  for (const key of keys) {
    const other = await env.DB.prepare(
      // instr(), not LIKE: D1 rejects LIKE patterns over 50 bytes, and media keys are longer.
      `SELECT COUNT(*) AS n FROM jobs WHERE id != ? AND status IN ('scheduled','preparing','failed') AND instr(job, ?) > 0`,
    )
      .bind(row.id, `"key":"${key}"`)
      .first()
    if (!other?.n) await env.MEDIA.delete(key)
  }
}

// ---- job checks ----------------------------------------------------------------------
// A job arrives through the API. Its fields must never steer a stored sign-in to another
// host or let one platform's job read another platform's secret: hosts are fixed in this
// file, and tokenRef / appRef must belong to the job's own platform.

const REFS = {
  instagram: { token: (r) => r.startsWith('meta:page:'), app: (r) => r === undefined },
  pinterest: { token: (r) => r.startsWith('pinterest:'), app: (r) => r === undefined || r === 'app:pinterest' },
  linkedin: { token: (r) => r.startsWith('linkedin:'), app: (r) => r === undefined || r.startsWith('app:linkedin:') },
  blog: { token: (r, job) => r === `sanity:${job.projectId}`, app: (r) => r === undefined },
}

export function checkJob(platform, job) {
  if (!job || typeof job !== 'object') throw new Error('job must be an object')
  const rules = REFS[platform]
  if (!rules) throw new Error(`unknown platform ${platform}`)
  if (platform === 'blog') {
    if (typeof job.projectId !== 'string' || !/^[a-z0-9]+$/.test(job.projectId)) throw new Error('blog job: projectId must be lower-case letters and digits')
    if (typeof job.dataset !== 'string' || !/^[a-z0-9_-]+$/.test(job.dataset)) throw new Error('blog job: dataset must be lower-case letters, digits, _ or -')
    if (!Array.isArray(job.docs) || !job.docs.length) throw new Error('blog job: docs is empty')
  }
  if (typeof job.tokenRef !== 'string' || !rules.token(job.tokenRef, job))
    throw new Error(`${platform} job: tokenRef "${String(job.tokenRef).slice(0, 60)}" does not belong to ${platform}`)
  if (job.appRef !== undefined && typeof job.appRef !== 'string') throw new Error(`${platform} job: appRef must be a string`)
  if (!rules.app(job.appRef)) throw new Error(`${platform} job: appRef "${String(job.appRef).slice(0, 60)}" does not belong to ${platform}`)
  if (platform === 'instagram') {
    graphVersion(job.graphVersion)
    if (!/^\d+$/.test(String(job.igUserId ?? ''))) throw new Error('instagram job: igUserId must be digits')
  }
  if (platform === 'pinterest') pinterestBase(job.base, job.sandbox)
}

/** The brand ids the Mac pushes for the calendar: same host rules. */
function checkBrandCfg(b) {
  if (!b || typeof b !== 'object') throw new Error('must be an object')
  graphVersion(b.graphVersion)
  if (b.pinterest) pinterestBase(b.pinterest.base)
}

// ---- outside APIs ---------------------------------------------------------------

class ApiError extends Error {
  constructor(platform, status, data) {
    super(`${platform} API ${status}: ${describe(data)}`)
    this.status = status
  }
}

function describe(d) {
  if (d === null || d === undefined || d === '') return 'empty response'
  if (typeof d === 'string') return d.slice(0, 400)
  const e = d.error
  if (e && typeof e === 'object')
    return [e.message, e.error_user_msg, e.code && `code ${e.code}`, e.error_subcode && `subcode ${e.error_subcode}`].filter(Boolean).join(' · ')
  if (typeof e === 'string') return [e, d.error_description].filter(Boolean).join(' – ')
  return String(d.message || JSON.stringify(d)).slice(0, 400)
}

const enc = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

async function api(c, platform, url, { method = 'GET', headers = {}, query, form, json: body, raw = false } = {}) {
  const u = new URL(url)
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, enc(v))
  const h = { ...headers }
  let payload
  if (body !== undefined) {
    payload = JSON.stringify(body)
    h['Content-Type'] = 'application/json'
  } else if (form) {
    payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, enc(v)]))
  }
  const res = await c.fetch(u, { method, headers: h, body: payload })
  const text = await res.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new ApiError(platform, res.status, data)
  return raw ? { headers: res.headers, data } : data
}

async function r2Bytes(c, m, range) {
  const obj = await c.env.MEDIA.get(m.key, range ? { range } : {})
  if (!obj) throw new Error(`media ${m.key} is no longer in the bucket`)
  return obj.arrayBuffer()
}

// ---- Instagram --------------------------------------------------------------------

const graph = (job) => `https://graph.facebook.com/${graphVersion(job.graphVersion)}`
const metaToken = async (c) => (await getSecret(c.env, c.job.tokenRef)).token

const instagram = {
  async start(c) {
    const { job, state } = c
    if (job.kind === 'carousel') return { next: 'children' }
    const token = await metaToken(c)
    const form =
      job.kind === 'reel'
        ? {
            media_type: 'REELS',
            video_url: await mediaUrl(c, job.media[0]),
            cover_url: job.cover ? await mediaUrl(c, job.cover) : undefined,
            thumb_offset: job.cover ? undefined : job.thumbOffsetMs,
            share_to_feed: job.shareToFeed ?? true,
            caption: job.caption,
          }
        : { image_url: await mediaUrl(c, job.media[0]), caption: job.caption, alt_text: job.alt }
    const r = await api(c, 'instagram', `${graph(job)}/${job.igUserId}/media`, { method: 'POST', form: { ...form, access_token: token } })
    state.container = r.id
    return { next: 'wait' }
  },

  async children(c) {
    const { job, state } = c
    const token = await metaToken(c)
    state.children ??= []
    while (state.children.length < job.media.length) {
      if (c.low()) return { wait: 0 }
      const r = await api(c, 'instagram', `${graph(job)}/${job.igUserId}/media`, {
        method: 'POST',
        form: { image_url: await mediaUrl(c, job.media[state.children.length]), is_carousel_item: true, access_token: token },
      })
      state.children.push(r.id)
    }
    return { next: 'waitChildren' }
  },

  async waitChildren(c) {
    const { job, state } = c
    const token = await metaToken(c)
    state.ready ??= []
    for (const id of state.children) {
      if (state.ready.includes(id)) continue
      if (c.low()) return { wait: 0 }
      const s = await igStatus(c, id, token)
      if (!s) return { wait: 15_000 }
      state.ready.push(id)
    }
    const r = await api(c, 'instagram', `${graph(job)}/${job.igUserId}/media`, {
      method: 'POST',
      form: { media_type: 'CAROUSEL', children: state.children.join(','), caption: job.caption, access_token: token },
    })
    state.container = r.id
    return { next: 'wait' }
  },

  async wait(c) {
    const ok = await igStatus(c, c.state.container, await metaToken(c))
    return ok ? { next: 'publish' } : { wait: 20_000 }
  },

  async publish(c) {
    const { job, state } = c
    const token = await metaToken(c)
    const pub = await api(c, 'instagram', `${graph(job)}/${job.igUserId}/media_publish`, {
      method: 'POST',
      form: { creation_id: state.container, access_token: token },
    })
    state.published = pub.id
    const info = await api(c, 'instagram', `${graph(job)}/${pub.id}`, { query: { fields: 'permalink', access_token: token } }).catch(() => ({}))
    return { done: { id: pub.id, url: info.permalink } }
  },
}

async function igStatus(c, id, token) {
  const r = await api(c, 'instagram', `${graph(c.job)}/${id}`, { query: { fields: 'status_code,status', access_token: token } })
  if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
    const e = new Error(`Instagram could not process the media: ${r.status || r.status_code}`)
    e.restart = true
    throw e
  }
  return r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED'
}

// ---- Pinterest ---------------------------------------------------------------------

const pinBase = (job) => pinterestBase(job.base, job.sandbox)

async function pinterestToken(c) {
  const { env, job } = c
  let s = await getSecret(env, job.tokenRef)
  if (Date.parse(s.expiresAt) - Date.now() > 24 * 3600_000) return s.accessToken
  const app = await getSecret(env, job.appRef)
  const t = await api(c, 'pinterest', `${pinBase(job)}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${app.appId}:${app.appSecret}`) },
    form: { grant_type: 'refresh_token', refresh_token: s.refreshToken },
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
  await putSecret(env, job.tokenRef, s)
  return s.accessToken
}

const pinterest = {
  async start(c) {
    if (c.job.kind !== 'video') return { next: 'publish' }
    const token = await pinterestToken(c)
    const reg = await api(c, 'pinterest', `${pinBase(c.job)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { media_type: 'video' },
    })
    Object.assign(c.state, { mediaId: reg.media_id, uploadUrl: reg.upload_url, params: reg.upload_parameters || {} })
    return { next: 'upload' }
  },

  async upload(c) {
    const { env, job, state } = c
    const m = job.media[0]
    const obj = await env.MEDIA.get(m.key)
    if (!obj) throw new Error(`media ${m.key} is no longer in the bucket`)
    const b = `----social${randHex(8)}`
    const te = new TextEncoder()
    let head = ''
    for (const [k, v] of Object.entries(state.params)) head += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    head += `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${m.name || 'video.mp4'}"\r\nContent-Type: ${m.mime}\r\n\r\n`
    const h = te.encode(head)
    const t = te.encode(`\r\n--${b}--\r\n`)
    const { readable, writable } = new FixedLengthStream(h.length + obj.size + t.length)
    const pump = (async () => {
      const w1 = writable.getWriter()
      await w1.write(h)
      w1.releaseLock()
      await obj.body.pipeTo(writable, { preventClose: true })
      const w2 = writable.getWriter()
      await w2.write(t)
      await w2.close()
    })()
    const [res] = await Promise.all([
      c.fetch(state.uploadUrl, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}` }, body: readable }),
      pump,
    ])
    if (!res.ok) {
      const e = new Error(`Pinterest video upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
      e.restart = true
      throw e
    }
    return { next: 'wait' }
  },

  async wait(c) {
    const token = await pinterestToken(c)
    const s = await api(c, 'pinterest', `${pinBase(c.job)}/media/${encodeURIComponent(c.state.mediaId)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (s.status === 'failed') {
      const e = new Error('Pinterest could not process the video')
      e.restart = true
      throw e
    }
    return s.status === 'succeeded' ? { next: 'publish' } : { wait: 20_000 }
  },

  async publish(c) {
    const { job, state } = c
    const token = await pinterestToken(c)
    let media_source
    if (job.kind === 'video') {
      media_source = { source_type: 'video_id', media_id: state.mediaId }
      if (job.cover) media_source.cover_image_url = await mediaUrl(c, job.cover)
      else media_source.cover_image_key_frame_time = 1
    } else if (job.kind === 'image') {
      media_source = { source_type: 'image_url', url: await mediaUrl(c, job.media[0]) }
    } else {
      const items = []
      for (const m of job.media) items.push({ url: await mediaUrl(c, m) })
      media_source = { source_type: 'multiple_image_urls', items }
    }
    const pin = await api(c, 'pinterest', `${pinBase(job)}/pins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: {
        board_id: job.boardId,
        title: job.title || undefined,
        description: job.description || undefined,
        link: job.link || undefined,
        alt_text: job.alt || undefined,
        media_source,
      },
    })
    return { done: { id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}/`, note: job.sandbox ? 'Pinterest sandbox: not public' : undefined } }
  },
}

// ---- LinkedIn -------------------------------------------------------------------------

const LI = 'https://api.linkedin.com/rest'

async function linkedinHeaders(c) {
  const { env, job } = c
  let s = await getSecret(env, job.tokenRef)
  if (Date.parse(s.expiresAt) - Date.now() < 7 * 86400_000 && s.refreshToken) {
    const app = await getSecret(env, job.appRef)
    const t = await api(c, 'linkedin', 'https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: app.clientId, client_secret: app.clientSecret },
    })
    const now = Date.now()
    s = {
      ...s,
      accessToken: t.access_token,
      expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
      refreshToken: t.refresh_token || s.refreshToken,
      refreshExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : s.refreshExpiresAt,
      savedAt: new Date().toISOString(),
    }
    await putSecret(env, job.tokenRef, s)
  }
  if (Date.parse(s.expiresAt) < Date.now()) throw new Error(`LinkedIn sign-in expired on ${s.expiresAt.slice(0, 10)}: run social auth linkedin, then social cloud push`)
  return { Authorization: `Bearer ${s.accessToken}`, 'LinkedIn-Version': String(job.version || '202610'), 'X-Restli-Protocol-Version': '2.0.0' }
}

const linkedin = {
  async start(c) {
    const { job } = c
    if (job.kind === 'video') return { next: 'init' }
    if (job.kind === 'image' || job.kind === 'images') return { next: 'images' }
    if (job.link && job.cover) return { next: 'articleThumb' }
    return { next: 'publish' }
  },

  async init(c) {
    const { job, state } = c
    const h = await linkedinHeaders(c)
    const r = await api(c, 'linkedin', `${LI}/videos`, {
      method: 'POST',
      headers: h,
      query: { action: 'initializeUpload' },
      json: { initializeUploadRequest: { owner: job.author, fileSizeBytes: job.media[0].size, uploadCaptions: false, uploadThumbnail: !!job.cover } },
    })
    const v = r.value
    Object.assign(state, {
      video: v.video,
      uploadToken: v.uploadToken || '',
      parts: v.uploadInstructions.map((p) => ({ url: p.uploadUrl, first: p.firstByte, last: p.lastByte })),
      thumbUrl: v.thumbnailUploadUrl,
      etags: [],
    })
    return { next: 'parts' }
  },

  async parts(c) {
    const { job, state } = c
    while (state.etags.length < state.parts.length) {
      if (c.low()) return { wait: 0 }
      const p = state.parts[state.etags.length]
      const body = await r2Bytes(c, job.media[0], { offset: p.first, length: p.last - p.first + 1 })
      const res = await c.fetch(p.url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body })
      if (!res.ok) throw new Error(`LinkedIn video part ${state.etags.length + 1}/${state.parts.length} failed: ${res.status}`)
      state.etags.push(res.headers.get('etag'))
    }
    if (job.cover && state.thumbUrl) {
      const res = await c.fetch(state.thumbUrl, {
        method: 'PUT',
        headers: { 'media-type-family': 'STILLIMAGE', 'Content-Type': 'application/octet-stream' },
        body: await r2Bytes(c, job.cover),
      })
      if (!res.ok) console.log(`linkedin thumbnail upload: ${res.status} (posting without it)`)
    }
    const h = await linkedinHeaders(c)
    await api(c, 'linkedin', `${LI}/videos`, {
      method: 'POST',
      headers: h,
      query: { action: 'finalizeUpload' },
      json: { finalizeUploadRequest: { video: state.video, uploadToken: state.uploadToken, uploadedPartIds: state.etags } },
    })
    return { next: 'wait' }
  },

  async wait(c) {
    const h = await linkedinHeaders(c)
    const r = await api(c, 'linkedin', `${LI}/videos/${encodeURIComponent(c.state.video)}`, { headers: h })
    if (r.status === 'PROCESSING_FAILED') {
      const e = new Error(`LinkedIn could not process the video: ${r.processingFailureReason || ''}`)
      e.restart = true
      throw e
    }
    return r.status === 'AVAILABLE' ? { next: 'publish' } : { wait: 20_000 }
  },

  async images(c) {
    const { job, state } = c
    state.images ??= []
    while (state.images.length < job.media.length) {
      if (c.low(4)) return { wait: 0 }
      state.images.push(await linkedinImage(c, job.media[state.images.length]))
    }
    return { next: 'publish' }
  },

  async articleThumb(c) {
    c.state.thumb = await linkedinImage(c, c.job.cover)
    return { next: 'publish' }
  },

  async publish(c) {
    const { job, state } = c
    const h = await linkedinHeaders(c)
    let content
    if (job.kind === 'video') content = { media: { id: state.video, title: job.title } }
    else if (state.images?.length === 1) content = { media: { id: state.images[0], altText: job.alt } }
    else if (state.images?.length) content = { multiImage: { images: state.images.map((id) => ({ id, altText: job.alt })) } }
    else if (job.link) content = { article: { source: job.link, title: job.title || job.link, thumbnail: state.thumb } }
    const r = await api(c, 'linkedin', `${LI}/posts`, {
      method: 'POST',
      raw: true,
      headers: h,
      json: {
        author: job.author,
        commentary: job.commentary,
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content,
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    })
    const urn = r.headers.get('x-restli-id') || r.data?.id
    return { done: { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined } }
  },
}

async function linkedinImage(c, m) {
  const h = await linkedinHeaders(c)
  const init = await api(c, 'linkedin', `${LI}/images`, {
    method: 'POST',
    headers: h,
    query: { action: 'initializeUpload' },
    json: { initializeUploadRequest: { owner: c.job.author } },
  })
  const res = await c.fetch(init.value.uploadUrl, { method: 'PUT', headers: { Authorization: h.Authorization }, body: await r2Bytes(c, m) })
  if (!res.ok) throw new Error(`LinkedIn image upload failed: ${res.status}`)
  return init.value.image
}

// ---- blog: publish a scheduled Sanity draft ---------------------------------------------
// The post is written ahead and saved as a draft in Sanity (`social blog schedule`). At its
// time this publishes the draft(s), every language in one transaction. Rebuilding the site is
// left to the site's own Sanity webhook, if it has one.
// job: { kind: 'sanity', projectId, dataset, docs: [{ draftId, publishedId }], url, title, tokenRef }
const blog = {
  async start() {
    return { next: 'publish' }
  },
  async publish(c) {
    const { job } = c
    const { token } = await getSecret(c.env, job.tokenRef)
    await api(c, 'sanity', `https://${job.projectId}.api.sanity.io/v2024-10-01/data/actions/${job.dataset}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { actions: job.docs.map((d) => ({ actionType: 'sanity.action.document.publish', draftId: d.draftId, publishedId: d.publishedId })) },
    })
    return { done: { id: job.docs.map((d) => d.publishedId).join(', '), url: job.url } }
  },
}

const PLATFORMS = { instagram, pinterest, linkedin, blog }

// ---- alerts ----------------------------------------------------------------------------

const alertsOn = (env) => !!((env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) || (env.RESEND_API_KEY && env.ALERT_TO && env.ALERT_FROM))

/** Tells the owner: Telegram and/or email (Resend), whichever is set up. */
async function alert(env, subject, text) {
  const sends = []
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    sends.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Plain text: captions and errors can hold anything, so no HTML/Markdown parsing.
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `📣 ${subject}\n\n${text}`.slice(0, 4000), disable_web_page_preview: true }),
      }).then((r) => r.ok || console.log(`alert telegram failed: ${r.status}`), (e) => console.log(`alert telegram failed: ${e.message}`)),
    )
  if (env.RESEND_API_KEY && env.ALERT_TO && env.ALERT_FROM)
    sends.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO.split(',').map((s) => s.trim()), subject, text }),
      }).then((r) => r.ok || console.log(`alert email failed: ${r.status}`), (e) => console.log(`alert email failed: ${e.message}`)),
    )
  await Promise.all(sends)
}

/** Once a day: warn about sign-ins that stop working within 14 days. */
async function expiryWarnings(env) {
  const today = new Date().toISOString().slice(0, 10)
  const last = await env.DB.prepare("SELECT v FROM kv WHERE k = 'expiry_check'").first()
  if (last?.v === today) return
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('expiry_check', ?)").bind(today).run()
  const soon = new Date(Date.now() + 14 * 86400_000).toISOString()
  const r = await env.DB.prepare('SELECT ref, expires_at FROM secrets WHERE expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at').bind(soon).all()
  if (!r.results.length) return
  const lines = r.results.map((x) => `- ${x.ref}: ${x.expires_at.slice(0, 10)}`).join('\n')
  await alert(env, 'Social sign-ins expiring soon', `These stop working soon. Sign in again on the Mac (social auth …), then run: social cloud push\n\n${lines}`)
}

// ---- secrets (AES-GCM) -------------------------------------------------------------------

let aesKey
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

function key(env) {
  if (!env.TOKEN_KEY) throw new Error('TOKEN_KEY secret is not set')
  aesKey ??= crypto.subtle.importKey('raw', unb64(env.TOKEN_KEY), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return aesKey
}

export function expiryOf(v) {
  return v.refreshToken ? v.refreshExpiresAt || null : v.expiresAt || null
}

async function putSecret(env, ref, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(JSON.stringify(value)))
  await env.DB.prepare('INSERT OR REPLACE INTO secrets (ref, iv, data, saved_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ref, b64(iv), b64(data), value.savedAt || null, expiryOf(value), Date.now())
    .run()
}

async function getSecret(env, ref) {
  const row = await env.DB.prepare('SELECT iv, data FROM secrets WHERE ref = ?').bind(ref).first()
  if (!row) throw new Error(`no saved sign-in "${ref}" on the Worker: run social cloud push on the Mac`)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, await key(env), unb64(row.data))
  return JSON.parse(new TextDecoder().decode(plain))
}

// ---- small helpers --------------------------------------------------------------------------

function randHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

async function hmacHex(secret, msg) {
  if (!secret) throw new Error('MEDIA_KEY secret is not set')
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafe(a, b) {
  a = String(a ?? '')
  b = String(b ?? '')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
