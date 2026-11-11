// Mac side of the cloud scheduler (cloud/worker.mjs): talks to the Worker,
// uploads media, pushes sign-ins, and sets the Worker up with wrangler.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { CONFIG_DIR, ROOT, loadApps, loadTokens, readJson, writePrivate, paths, listBrands, loadBrand, metaPageAllowed } from './config.mjs'
import { cloudCfg } from './cloudcfg.mjs'
import { mimeOf, sleep } from './util.mjs'

const PART = 32 * 1024 * 1024
const CLOUD_DIR = path.join(CONFIG_DIR, 'cloud')
const WRANGLER_CONFIG = path.join(CLOUD_DIR, 'wrangler.jsonc')

// ---- API --------------------------------------------------------------------------

export async function capi(method, p, body, { raw, retries = method === 'GET' ? 2 : 0 } = {}) {
  const c = cloudCfg(true)
  const headers = { Authorization: `Bearer ${c.apiToken}` }
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json'
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(c.url.replace(/\/$/, '') + p, {
        method,
        headers,
        body: raw ?? (body !== undefined && body !== null ? JSON.stringify(body) : undefined),
      })
    } catch (e) {
      if (attempt < retries) {
        await sleep(2000 * (attempt + 1))
        continue
      }
      throw new Error(`cloud scheduler unreachable (${c.url}): ${e.cause?.message || e.message}`)
    }
    const text = await res.text()
    let data = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    if (res.ok) return data
    if (res.status >= 500 && attempt < retries) {
      await sleep(2000 * (attempt + 1))
      continue
    }
    throw new Error(`cloud scheduler ${method} ${p.split('?')[0]}: ${res.status} ${data?.error || String(text).slice(0, 200)}`)
  }
}

/** Uploads one local file to the Worker's private bucket, in 32 MB parts. */
export async function uploadMedia(file) {
  const size = fs.statSync(file).size
  const mime = mimeOf(file)
  const name = path.basename(file)
  if (size > 50e6) process.stdout.write(`\n             uploading ${name} (${Math.round(size / 1e6)} MB)… `)
  const { key, uploadId } = await capi('POST', '/api/upload/start', { name, mime, size })
  try {
    const blob = await fs.openAsBlob(file)
    const parts = []
    for (let n = 1, off = 0; off < size || n === 1; n++, off += PART) {
      const q = `?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&n=${n}`
      parts.push(await capi('PUT', `/api/upload/part${q}`, null, { raw: blob.slice(off, off + PART), retries: 3 }))
    }
    await capi('POST', '/api/upload/complete', { key, uploadId, parts })
  } catch (e) {
    await capi('POST', '/api/upload/abort', { key, uploadId }).catch(() => {})
    throw e
  }
  return { key, mime, size, name }
}

/** Every sign-in and app key the Worker can use, keyed the way jobs refer to them. */
export function secretItems() {
  const t = loadTokens()
  const apps = loadApps()
  const items = {}
  for (const [id, p] of Object.entries(t.meta?.pages || {})) if (metaPageAllowed(id, p)) items[`meta:page:${id}`] = { token: p.token, name: p.name, savedAt: p.savedAt }
  for (const [user, s] of Object.entries(t.pinterest || {})) items[`pinterest:${user}`] = s
  for (const [app, s] of Object.entries(t.linkedin || {})) items[`linkedin:${app}`] = s
  if (apps.pinterest?.appId) items['app:pinterest'] = { appId: apps.pinterest.appId, appSecret: apps.pinterest.appSecret }
  // YouTube: read-only use on the Worker (the calendar lists each switched-on channel's uploads).
  const channels = new Set(brandsForCloud().flatMap(([, b]) => (defaultAccount(b, 'youtube')?.channelId ? [defaultAccount(b, 'youtube').channelId] : [])))
  for (const [id, y] of Object.entries(t.youtube || {}))
    if (channels.has(id) && y.refreshToken) items[`youtube:${id}`] = { refreshToken: y.refreshToken, title: y.title, savedAt: y.savedAt }
  if (channels.size && apps.google?.clientId) items['app:google'] = { clientId: apps.google.clientId, clientSecret: apps.google.clientSecret }
  for (const [name, a] of Object.entries(apps.linkedin || {}))
    if (a?.clientId) items[`app:linkedin:${name}`] = { clientId: a.clientId, clientSecret: a.clientSecret }
  // Sanity tokens for blog jobs (social blog schedule): apps.json → "sanity": { "<projectId>": { "token": "…" } }
  for (const [projectId, x] of Object.entries(apps.sanity || {})) if (x?.token) items[`sanity:${projectId}`] = { token: x.token }
  return items
}

/**
 * Brands the cloud knows about, as [key, brand file]: switched-on brands, plus switched-off brands
 * marked "calendar": true (view-only: the dashboard lists their posts; posting stays blocked).
 */
function brandsForCloud() {
  return listBrands()
    .map((k) => [k, loadBrand(k)])
    .filter(([, b]) => b.publishing !== false || b.calendar === true)
}
const defaultAccount = (b, p) => (b[p]?.accounts ? b[p].accounts[b[p].default || Object.keys(b[p].accounts)[0]] : b[p])

/** The ids the Worker needs to read each brand's accounts for the calendar (no secrets). */
export function brandsConfig() {
  const apps = loadApps()
  const out = {}
  for (const [key, b] of brandsForCloud()) {
    const one = (p) => (b[p]?.accounts ? b[p].accounts[b[p].default || Object.keys(b[p].accounts)[0]] : b[p])
    const fb = one('facebook')
    const ig = one('instagram')
    const yt = one('youtube')
    const pin = one('pinterest')
    out[key] = {
      name: b.name || key,
      timezone: b.timezone,
      platforms: ['facebook', 'instagram', 'youtube', 'pinterest', 'linkedin'].filter((p) => b[p]),
      graphVersion: apps.meta?.graphVersion,
      facebook: fb?.pageId ? { pageId: String(fb.pageId) } : undefined,
      instagram: ig?.userId && fb?.pageId ? { userId: String(ig.userId) } : undefined,
      youtube: yt?.channelId ? { channelId: yt.channelId } : undefined,
      pinterest: pin?.username ? { username: pin.username, base: apps.pinterest?.sandbox ? 'https://api-sandbox.pinterest.com/v5' : undefined } : undefined,
      ...(b.publishing === false ? { viewOnly: true } : {}),
    }
  }
  return out
}

export const pushBrands = () => capi('POST', '/api/brands', { brands: brandsConfig() })

/** Sends sign-ins to the Worker. The Worker keeps its own copy when it renewed it more recently. */
export async function pushSecrets(refs) {
  const all = secretItems()
  const items = refs ? Object.fromEntries(refs.filter((r) => all[r]).map((r) => [r, all[r]])) : all
  const missing = (refs || []).filter((r) => !all[r])
  if (missing.length) throw new Error(`no local sign-in for ${missing.join(', ')} (run social auth … first)`)
  return capi('POST', '/api/secrets', { items })
}

/**
 * Hands one platform of a post to the cloud scheduler. `uploads` is shared by
 * every platform of the same post so each file goes up once.
 */
export async function sendToCloud({ mod, spec, platform, plan, at, uploads }) {
  const c = await mod.cloud({ spec, plan })
  const up = (f) => {
    if (!uploads.has(f)) uploads.set(f, uploadMedia(f))
    return uploads.get(f)
  }
  const media = []
  for (const f of c.media) media.push(await up(f))
  const cover = c.cover ? await up(c.cover) : null
  await pushSecrets([c.job.tokenRef, c.job.appRef].filter(Boolean))
  const r = await capi('POST', '/api/jobs', {
    jobs: [{ brand: spec.brand.key, platform, spec: spec.file, specId: spec.id, at: (at || new Date()).getTime(), job: { ...c.job, media, cover } }],
  })
  return { id: r.ids[0] }
}

export const listJobs = (all = false, limit = 100) => capi('GET', `/api/jobs?${all ? 'all=1&' : ''}limit=${limit}`).then((r) => r.jobs)
export const cancelJob = (id) => capi('DELETE', `/api/jobs/${id}`)
export const retryJob = (id, at) => capi('POST', `/api/jobs/${id}/retry`, at ? { at: at.getTime() } : {})

/** Copies cloud outcomes back into each post's .result.json, so re-running a post never double-posts. */
export async function syncResults(jobs) {
  jobs ??= await listJobs(true, 300)
  const byFile = new Map()
  for (const j of jobs) {
    const file = j.spec.replace(/\.json$/i, '') + '.result.json'
    if (!fs.existsSync(file)) continue
    if (!byFile.has(file)) byFile.set(file, readJson(file, {}))
    const r = byFile.get(file)
    const cur = r[j.platform]
    if (cur?.jobId !== j.id) continue
    if (j.status === 'published') r[j.platform] = { ...cur, status: 'published', id: j.result?.id, url: j.result?.url, note: j.result?.note }
    else if (j.status === 'failed' || j.status === 'missed') r[j.platform] = { ...cur, status: j.status, error: j.error }
    else if (j.status === 'cancelled') delete r[j.platform]
  }
  for (const [file, r] of byFile) fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n')
}

/** After a cancel or retry, mirror it in the post's .result.json. */
export function markResult(job, value) {
  const file = job.spec.replace(/\.json$/i, '') + '.result.json'
  if (!fs.existsSync(file)) return
  const r = readJson(file, {})
  if (value === null) delete r[job.platform]
  else r[job.platform] = { ...r[job.platform], ...value }
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n')
}

// ---- setup / deploy -----------------------------------------------------------------

function nodeEnv() {
  const env = { ...process.env }
  if (Number(process.versions.node.split('.')[0]) >= 22) return env
  // wrangler 4 needs Node 22+; borrow one from nvm if this shell runs an older Node.
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  const v22 = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((v) => Number(v.slice(1).split('.')[0]) >= 22)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .pop()
    : null
  if (!v22) throw new Error('wrangler needs Node 22 or newer (install one with nvm: nvm install 22)')
  env.PATH = `${path.join(dir, v22, 'bin')}:${env.PATH}`
  return env
}

/**
 * The exact wrangler release `npx` runs. Pinned, so a new (or hijacked) release is never
 * pulled in silently with the Cloudflare login. Raise it on purpose after reading the changelog.
 */
export const WRANGLER_VERSION = '4.160.0'

export function wrangler(args, { input, quiet = false, allowFail = false } = {}) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true, mode: 0o700 })
  const r = spawnSync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args], {
    cwd: CLOUD_DIR,
    env: nodeEnv(),
    input,
    encoding: 'utf8',
    maxBuffer: 20e6,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${out.slice(-1500)}`)
  if (!quiet) process.stdout.write(out)
  return { ok: r.status === 0, out }
}

function saveCloud(mutator) {
  const apps = readJson(paths.apps, {})
  apps.cloud ??= {}
  mutator(apps.cloud)
  writePrivate(paths.apps, apps)
  return apps.cloud
}

function writeWranglerConfig(c) {
  const vars = {}
  if (c.alerts?.to) vars.ALERT_TO = c.alerts.to
  if (c.alerts?.from) vars.ALERT_FROM = c.alerts.from
  if (c.alerts?.onPublish) vars.ALERT_ON_PUBLISH = '1'
  if (c.dashboardTimezone) vars.DASH_TZ = c.dashboardTimezone
  const off = listBrands().filter((k) => loadBrand(k).publishing === false)
  if (off.length) vars.BLOCKED_BRANDS = off.join(',')
  const cfg = {
    name: c.name,
    main: path.join(ROOT, 'cloud', 'worker.mjs'),
    compatibility_date: '2025-09-01',
    ...(c.accountId ? { account_id: c.accountId } : {}),
    workers_dev: true,
    // Free plan: 5 cron triggers per account, already used by other projects, so a
    // Durable Object alarm (class Clock) runs the scheduler. cloud.cron: true uses a cron instead.
    triggers: { crons: c.cron ? ['* * * * *'] : [] },
    durable_objects: { bindings: [{ name: 'CLOCK', class_name: 'Clock' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Clock'] }],
    d1_databases: [{ binding: 'DB', database_name: c.database, database_id: c.databaseId }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: c.bucket }],
    vars,
    observability: { enabled: true },
  }
  fs.mkdirSync(CLOUD_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(WRANGLER_CONFIG, '// Generated by `social cloud deploy`. Edit apps.json → cloud, not this file.\n' + JSON.stringify(cfg, null, 2) + '\n')
}

const rand = (n) => crypto.randomBytes(n).toString('base64url')

/** Creates (or finds) the D1 database and R2 bucket, deploys the Worker and sets its secrets. Safe to run again. */
export async function cloudSetup() {
  let c = saveCloud((c) => {
    c.name ||= 'social-scheduler'
    c.database ||= 'social-scheduler'
    c.bucket ||= 'social-scheduler-media'
  })

  console.log('1/6 Cloudflare account')
  const who = wrangler(['whoami'], { quiet: true })
  const acct = who.out.match(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/g) || []
  console.log(acct.length ? acct.map((l) => `    ${l.replace(/│/g, ' ').trim()}`).join('\n') : who.out.slice(-400))
  if (acct.length > 1 && !c.accountId)
    throw new Error('wrangler can reach more than one Cloudflare account. Put the right one in apps.json → cloud.accountId and run again.')

  console.log(`2/6 D1 database "${c.database}"`)
  if (!c.databaseId) {
    const list = wrangler(['d1', 'list', '--json'], { quiet: true })
    const hit = JSON.parse(list.out.slice(list.out.indexOf('['))).find((d) => d.name === c.database)
    let id = hit?.uuid
    if (!id) {
      const made = wrangler(['d1', 'create', c.database], { quiet: true })
      id = made.out.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1]
      if (!id) throw new Error(`could not read the new database id:\n${made.out.slice(-600)}`)
    }
    c = saveCloud((c) => (c.databaseId = id))
  }
  console.log(`    ${c.databaseId}`)

  console.log(`3/6 R2 bucket "${c.bucket}" (private)`)
  const buckets = wrangler(['r2', 'bucket', 'list'], { quiet: true })
  if (!new RegExp(`name:\\s*${c.bucket}\\b`).test(buckets.out)) wrangler(['r2', 'bucket', 'create', c.bucket], { quiet: true })
  const rule = wrangler(['r2', 'bucket', 'lifecycle', 'add', c.bucket, 'expire-60d', 'media/', '--expire-days', '60', '--force'], {
    quiet: true,
    allowFail: true,
  })
  console.log(rule.ok || /already exists|must be unique/i.test(rule.out) ? '    safety rule: anything left over is deleted after 60 days' : `    ⚠ could not add the 60-day rule:\n${rule.out.slice(-400)}`)

  console.log('4/6 tables')
  writeWranglerConfig(c)
  wrangler(['d1', 'execute', c.database, '--remote', '--file', path.join(ROOT, 'cloud', 'schema.sql'), '--yes', '--config', WRANGLER_CONFIG], { quiet: true })

  console.log('5/6 deploy')
  const url = deployWorker(c)

  console.log('6/6 secrets')
  const fresh = !c.secretsSet
  const apiToken = c.apiToken || rand(32)
  const put = (name, value) => wrangler(['secret', 'put', name, '--config', WRANGLER_CONFIG], { input: value, quiet: true })
  if (fresh || !c.apiToken) put('API_TOKEN', apiToken)
  if (fresh) {
    // Generated here and never stored on the Mac: only the Worker can read the saved sign-ins.
    put('TOKEN_KEY', crypto.randomBytes(32).toString('base64'))
    put('MEDIA_KEY', rand(32))
  }
  c = saveCloud((c) => Object.assign(c, { url, apiToken, secretsSet: true }))

  await waitHealthy()
  const pushed = await pushSecrets().catch((e) => ({ error: e.message }))
  await pushBrands().catch(() => {})
  console.log(`\nCloud scheduler ready: ${url}`)
  console.log(pushed.error ? `Sign-ins not sent yet (${pushed.error}).` : `Sign-ins sent: ${pushed.saved.length ? pushed.saved.join(', ') : 'none yet (run social auth …, then social cloud push)'}`)
  console.log('Failure alerts: social cloud alerts --telegram')
}

function deployWorker(c) {
  writeWranglerConfig(c)
  const d = wrangler(['deploy', '--config', WRANGLER_CONFIG], { quiet: true })
  const url = d.out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0] || c.url
  if (!url) throw new Error(`deployed, but could not read the Worker URL:\n${d.out.slice(-600)}`)
  console.log(`    ${url}`)
  return url
}

export async function cloudDeploy() {
  const c = loadApps().cloud
  if (!c?.databaseId) throw new Error('Run social cloud setup first')
  wrangler(['d1', 'execute', c.database, '--remote', '--file', path.join(ROOT, 'cloud', 'schema.sql'), '--yes', '--config', WRANGLER_CONFIG], { quiet: true })
  const url = deployWorker(c)
  saveCloud((x) => (x.url = url))
  await waitHealthy()
  await pushBrands().catch((e) => console.log(`(brands not sent: ${e.message})`))
  console.log(`Deployed. Dashboard: ${url.replace(/\/$/, '')}/app`)
}

/** Sets the dashboard password (a Worker secret). Without --set, makes a random one and prints it once. */
export async function cloudPassword(flags) {
  const c = loadApps().cloud
  if (!c?.databaseId) throw new Error('Run social cloud setup first')
  const words = crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')
  const pw = typeof flags.set === 'string' ? flags.set : `${words.slice(0, 4)}-${words.slice(4, 8)}-${words.slice(8, 12)}-${words.slice(12, 16)}`
  if (pw.length < 12) throw new Error('use at least 12 characters')
  wrangler(['secret', 'put', 'DASH_PASSWORD', '--config', WRANGLER_CONFIG], { input: pw, quiet: true })
  saveCloud((x) => (x.dashboard = { setAt: new Date().toISOString() }))
  return { url: `${c.url.replace(/\/$/, '')}/app`, password: pw }
}

async function waitHealthy() {
  for (let i = 0; i < 10; i++) {
    try {
      return await capi('GET', '/api/health')
    } catch (e) {
      if (i === 9) throw e
      await sleep(3000)
    }
  }
}

export async function cloudAlerts(flags) {
  const c = loadApps().cloud
  if (!c?.databaseId) throw new Error('Run social cloud setup first')
  const ask = async (q) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const a = (await rl.question(q)).trim()
    rl.close()
    return a
  }
  if (flags.test) {
    await capi('POST', '/api/alerts/test')
    return console.log('Test alert sent.')
  }
  if (flags.telegram) {

    // Any Telegram bot and chat id work (make a bot with @BotFather).
    const token = process.env.TELEGRAM_BOT_TOKEN || (await ask('Telegram bot token: '))
    const chat = process.env.TELEGRAM_CHAT_ID || (await ask('Telegram chat id: '))
    if (!token || !chat) throw new Error('need a Telegram bot token and chat id')
    wrangler(['secret', 'put', 'TELEGRAM_BOT_TOKEN', '--config', WRANGLER_CONFIG], { input: token, quiet: true })
    wrangler(['secret', 'put', 'TELEGRAM_CHAT_ID', '--config', WRANGLER_CONFIG], { input: chat, quiet: true })
    saveCloud((x) => (x.alerts = { ...x.alerts, telegram: true, onPublish: !!flags['on-publish'] || !!x.alerts?.onPublish }))
    await cloudDeploy()
    await capi('POST', '/api/alerts/test')
    return console.log('Alerts go to Telegram. A test message was sent.')
  }
  if (!flags.to || !flags.from)
    throw new Error('Usage: social cloud alerts --telegram | --to you@example.com --from "Social <hello@your-domain>" [--on-publish] | --test')
  let key = process.env.RESEND_API_KEY
  if (!key) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    key = (await rl.question('Resend API key (sending access is enough; it goes straight to the Worker, not to disk): ')).trim()
    rl.close()
  }
  if (!key) throw new Error('no Resend key given')
  wrangler(['secret', 'put', 'RESEND_API_KEY', '--config', WRANGLER_CONFIG], { input: key, quiet: true })
  saveCloud((x) => (x.alerts = { ...x.alerts, to: flags.to, from: flags.from, onPublish: !!flags['on-publish'] }))
  await cloudDeploy()
  console.log(`Failure emails go to ${flags.to}.`)
}

export async function cloudStatus() {
  const c = cloudCfg(true)
  const h = await capi('GET', '/api/health')
  const s = await capi('GET', '/api/secrets')
  console.log(`Cloud scheduler ${c.url}`)
  console.log(`  jobs: ${Object.entries(h.jobs).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`)
  console.log(`  failure alerts: ${h.alerts ? `on (${(h.alertsVia || []).join(' + ')})` : 'off (social cloud alerts --telegram)'}`)
  console.log('  sign-ins on the Worker:')
  if (!s.secrets.length) console.log('    none (social cloud push)')
  for (const x of s.secrets) {
    const days = x.expires_at ? Math.floor((Date.parse(x.expires_at) - Date.now()) / 86400_000) : null
    console.log(`    ${x.ref.padEnd(34)} ${days === null ? 'no expiry' : days < 0 ? 'EXPIRED' : `${days} days left${days < 14 ? ' ⚠' : ''}`}`)
  }
}

// ---- calendar ---------------------------------------------------------------------

export const getCalendar = ({ from, to, brand } = {}) =>
  capi('GET', `/api/calendar?${new URLSearchParams(Object.entries({ from, to, brand }).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`)
export const addPlan = (items) => capi('POST', '/api/plan', { items })
export const setPlan = (id, state) => capi('POST', `/api/plan/${id}`, { state })
export const removePlan = (id) => capi('DELETE', `/api/plan/${id}`)
export const syncNow = (brand) => capi('POST', '/api/sync', brand ? { brand } : {})
