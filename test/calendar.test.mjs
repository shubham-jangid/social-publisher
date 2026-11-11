// Calendar sync, plan matching and the dashboard sign-in, against fake D1 and fake platform APIs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeD1, fakeR2, hasSqlite } from './fakes.mjs'

const skip = !hasSqlite && 'needs Node 22+ (node:sqlite)'
const { default: worker, tick } = await import('../cloud/worker.mjs')
const { norm, matchesText } = await import('../cloud/calendar.mjs')

const H = 3600_000
const env0 = (extra = {}) => ({
  DB: fakeD1(),
  MEDIA: fakeR2(),
  API_TOKEN: 'tok',
  TOKEN_KEY: Buffer.alloc(32, 3).toString('base64'),
  MEDIA_KEY: 'mk',
  DASH_PASSWORD: 'correct-horse-battery',
  ...extra,
})
const ctx = { waitUntil: () => {} }
async function call(env, method, p, body, { token = 'tok', headers = {}, form } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (body) h['content-type'] = 'application/json'
  const res = await worker.fetch(
    new Request(`https://sched.example.workers.dev${p}`, { method, headers: h, body: form ?? (body ? JSON.stringify(body) : undefined), redirect: 'manual' }),
    env,
    ctx,
  )
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data, text, headers: res.headers }
}
function fakeNet(handlers) {
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    calls.push({ url: u, method: init.method || 'GET' })
    for (const [match, fn] of handlers) if (match(u, init)) return new Response(JSON.stringify(await fn(u, init)), { status: 200 })
    return new Response(JSON.stringify({ error: { message: `unmocked ${u}` } }), { status: 599 })
  }
  return calls
}

test('matching ignores emoji, punctuation and case, and keeps Devanagari', () => {
  assert.equal(norm('🎵 नया-नया गाना! Hello WORLD'), 'नया नया गाना hello world')
  assert.ok(matchesText(['नया-नया गाना'], 'x', '🎵 नया-नया गाना! Hello world'))
  assert.ok(matchesText(['nope', 'Jump Song'], '💃 Jump Song Dance!'))
  assert.ok(!matchesText([], 'anything'))
})

test('a published reel stays published even with a long media file name (D1 LIKE limit)', { skip }, async () => {
  const env = env0()
  fakeNet([
    [(u, i) => u.pathname.endsWith('/1784/media') && i.method === 'POST', () => ({ id: 'C1' })],
    [(u) => u.pathname.endsWith('/C1'), () => ({ status_code: 'FINISHED' })],
    [(u) => u.pathname.endsWith('/media_publish'), () => ({ id: 'P1' })],
    [(u) => u.pathname.endsWith('/P1'), () => ({ permalink: 'https://instagram.com/reel/P1' })],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'meta:page:9': { token: 'T', savedAt: '2026-11-01T00:00:00Z' } } })
  const name = 'Part-09-Clip-2-A-Very-Long-Example-Title-with-a-long-name.mp4'
  const key = `media/${Date.now()}-abcd1234/${name}`
  await env.MEDIA.put(key, Buffer.from('video'))
  const j = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'storytime', platform: 'instagram', spec: '/x.json', at: Date.now(), job: { kind: 'reel', caption: 'c', igUserId: '1784', tokenRef: 'meta:page:9', media: [{ key, mime: 'video/mp4', name }] } }],
  })
  await tick(env)
  await tick(env)
  const row = env.DB.raw.prepare('SELECT status, error FROM jobs WHERE id = ?').get(j.data.ids[0])
  assert.equal(row.status, 'published')
  assert.equal(row.error, null)
  assert.equal(await env.MEDIA.head(key), null, 'media removed')
})

test('calendar: sync reads each platform, plans match posts, gaps show as not published', { skip }, async () => {
  const env = env0({ BLOCKED_BRANDS: 'blocked-brand' })
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', '+0000')
  fakeNet([
    [(u) => u.pathname.endsWith('/55/published_posts'), () => ({ data: [{ id: '55_1', created_time: iso(now - 30 * H), message: '🌸 Spring flower… purple?!', permalink_url: 'https://fb.com/1' }] })],
    [(u) => u.pathname.endsWith('/55/scheduled_posts'), () => ({ data: [
      { id: '55_2', scheduled_publish_time: Math.floor((now + 20 * H) / 1000), message: '🎵 नया-नया गाना!' },
      { id: '55_3', scheduled_publish_time: Math.floor((now - 5 * 24 * H) / 1000), message: '🌾 Golden Field Dance' },
    ] })],
    [(u) => u.pathname.endsWith('/55/video_reels'), () => ({ data: [] })],
    [(u) => u.pathname.endsWith('/1784/media'), () => ({ data: [{ id: 'IG1', timestamp: iso(now - 29 * H), caption: '🌸 Spring flower… purple?!', permalink: 'https://ig/1', media_product_type: 'REELS' }] })],
    [(u) => u.hostname === 'oauth2.googleapis.com', () => ({ access_token: 'GT', expires_in: 3600 })],
    [(u) => u.pathname.endsWith('/playlistItems'), (u) => {
      assert.equal(u.searchParams.get('playlistId'), 'UUabc')
      return { items: [{ contentDetails: { videoId: 'V1' } }, { contentDetails: { videoId: 'V2' } }] }
    }],
    [(u) => u.pathname.endsWith('/videos'), () => ({ items: [
      { id: 'V1', snippet: { title: 'सुबह का बैंगनी फूल? #Shorts', description: '', publishedAt: iso(now - 31 * H) }, status: { privacyStatus: 'public' } },
      { id: 'V2', snippet: { title: 'Test upload', description: '', publishedAt: iso(now - 2 * H) }, status: { privacyStatus: 'private' } },
    ] })],
  ])
  await call(env, 'POST', '/api/secrets', {
    items: { 'meta:page:55': { token: 'PT' }, 'youtube:UCabc': { refreshToken: 'R' }, 'app:google': { clientId: 'a', clientSecret: 'b' } },
  })
  await call(env, 'POST', '/api/brands', {
    brands: {
      'storytime': { name: 'Story Time', platforms: ['facebook', 'instagram', 'youtube'], facebook: { pageId: '55' }, instagram: { userId: '1784' }, youtube: { channelId: 'UCabc' } },
      'blocked-brand': { name: 'Blocked', facebook: { pageId: '1' } },
    },
  })
  const s = await call(env, 'POST', '/api/sync', {})
  assert.deepEqual(s.data.results.map((r) => [r.platform, r.ok, r.count]), [['facebook', true, 3], ['instagram', true, 1], ['youtube', true, 2]])

  const plan = (platform, at, title, match) => ({ brand: 'storytime', platform, at, title, match })
  const p = await call(env, 'POST', '/api/plan', {
    items: [
      plan('instagram', now - 28 * H, 'Ep8 s1', ['spring flower']), // posted → published
      plan('youtube', now - 30 * H, 'Ep8 s1', ['सुबह का बैंगनी फूल']), // posted → published
      plan('instagram', now - 4 * H, 'Ep8 s2', ['नया-नया गाना']), // nothing on IG → not published
      plan('facebook', now + 20 * H, 'Ep8 s2', ['नया-नया गाना']), // scheduled on FB
      plan('instagram', now + 44 * H, 'Ep8 s3', ['Jump Song']), // future, nothing yet
    ],
  })
  assert.equal(p.data.ids.length, 5)
  const again = await call(env, 'POST', '/api/plan', { items: [plan('instagram', now + 44 * H, 'Ep8 s3', ['Jump Song'])] })
  assert.equal(again.data.ids[0], p.data.ids[4], 'importing twice updates, not duplicates')

  const cal = await call(env, 'GET', `/api/calendar?from=${now - 7 * 24 * H}&to=${now + 7 * 24 * H}`)
  const by = (f) => cal.data.entries.filter(f)
  const plat = (pl, t) => by((e) => e.platform === pl && (e.planTitle || e.title) === t)
  assert.equal(plat('instagram', 'Ep8 s1')[0].status, 'published')
  assert.equal(plat('instagram', 'Ep8 s1')[0].url, 'https://ig/1')
  assert.equal(plat('youtube', 'Ep8 s1')[0].status, 'published')
  assert.equal(plat('instagram', 'Ep8 s2')[0].status, 'overdue')
  assert.equal(plat('facebook', 'Ep8 s2')[0].status, 'scheduled')
  assert.equal(plat('instagram', 'Ep8 s3')[0].status, 'planned')
  assert.equal(by((e) => e.title?.includes('Golden Field'))[0].status, 'stuck', 'a FB post still "scheduled" days after its time')
  assert.equal(by((e) => e.title === 'Test upload')[0].status, 'private')
  assert.deepEqual(Object.keys(cal.data.brands), ['storytime'])

  // skip a plan item; it then reads as skipped, not "not published"
  const overdue = plat('instagram', 'Ep8 s2')[0]
  await call(env, 'POST', `/api/plan/${overdue.planId}`, { state: 'skipped' })
  const cal2 = await call(env, 'GET', `/api/calendar?from=${now - 7 * 24 * H}&to=${now + 7 * 24 * H}`)
  assert.equal(cal2.data.entries.find((e) => e.planId === overdue.planId).status, 'skipped')

  // a post deleted on the platform disappears on the next sync
  fakeNet([
    [(u) => u.pathname.endsWith('/55/published_posts'), () => ({ data: [] })],
    [(u) => u.pathname.endsWith('/55/scheduled_posts'), () => ({ data: [] })],
    [(u) => u.pathname.endsWith('/55/video_reels'), () => ({ data: [] })],
    [(u) => u.pathname.endsWith('/1784/media'), () => ({ data: [] })],
    [(u) => u.hostname === 'oauth2.googleapis.com', () => ({ access_token: 'GT', expires_in: 3600 })],
    [(u) => u.pathname.endsWith('/playlistItems'), () => ({ items: [] })],
  ])
  await call(env, 'POST', '/api/sync', {})
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM seen').get().n, 0)
})

test('the Worker syncs on its own every 3 h, only when brands were pushed', { skip }, async () => {
  const env = env0()
  const calls = fakeNet([[() => true, () => ({ data: [] })]])
  await tick(env)
  assert.equal(calls.length, 0, 'no brands: no sync')
  await call(env, 'POST', '/api/secrets', { items: { 'meta:page:55': { token: 'PT' } } })
  await call(env, 'POST', '/api/brands', { brands: { b: { name: 'B', facebook: { pageId: '55' } } } })
  const r = await tick(env)
  assert.equal(r.synced, 1)
  const n = calls.length
  await tick(env)
  assert.equal(calls.length, n, 'not again within 3 h')
})

test('dashboard: password sign-in, session cookie, throttle, and no access to secrets', { skip }, async () => {
  const env = env0()
  const noTok = { token: null }
  assert.equal((await call(env, 'GET', '/app', null, noTok)).status, 303)
  assert.equal((await call(env, 'GET', '/app/api/calendar', null, noTok)).status, 401)
  const login = await call(env, 'GET', '/login', null, noTok)
  assert.equal(login.status, 200)
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'none'/)

  const bad = await call(env, 'POST', '/login', null, { ...noTok, form: new URLSearchParams({ password: 'nope' }) })
  assert.equal(bad.status, 401)
  const ok = await call(env, 'POST', '/login', null, { ...noTok, form: new URLSearchParams({ password: 'correct-horse-battery' }) })
  assert.equal(ok.status, 303)
  const set = ok.headers.get('set-cookie')
  assert.match(set, /HttpOnly; Secure; SameSite=Strict/)
  const cookie = set.split(';')[0]

  const app = await call(env, 'GET', '/app', null, { ...noTok, headers: { cookie } })
  assert.equal(app.status, 200)
  assert.match(app.text, /Brand Publisher/)
  assert.equal((await call(env, 'GET', '/app/api/calendar', null, { ...noTok, headers: { cookie } })).status, 200)
  assert.equal((await call(env, 'GET', '/app/api/secrets', null, { ...noTok, headers: { cookie } })).status, 404)
  assert.equal((await call(env, 'GET', '/api/calendar', null, { ...noTok, headers: { cookie } })).status, 401, 'the Mac API still needs the token')
  const forged = cookie.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
  assert.equal((await call(env, 'GET', '/app/api/calendar', null, { ...noTok, headers: { cookie: forged } })).status, 401)

  // a new password signs everyone out
  const env2 = { ...env, DASH_PASSWORD: 'another-password-123' }
  assert.equal((await call(env2, 'GET', '/app/api/calendar', null, { ...noTok, headers: { cookie } })).status, 401)

  for (let i = 0; i < 8; i++) await call(env, 'POST', '/login', null, { ...noTok, form: new URLSearchParams({ password: 'x' }), headers: { 'cf-connecting-ip': '1.2.3.4' } })
  const locked = await call(env, 'POST', '/login', null, { ...noTok, form: new URLSearchParams({ password: 'correct-horse-battery' }), headers: { 'cf-connecting-ip': '1.2.3.4' } })
  assert.equal(locked.status, 429)
})

test('analytics: sync stores the numbers of each post, falls back when a permission is missing', { skip }, async () => {
  const env = env0()
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', '+0000')
  const calls = fakeNet([
    // Facebook: rich published_posts refused (no pages_read_user_content), plain one works; reels give plays.
    [(u) => u.pathname.endsWith('/55/published_posts') && u.searchParams.get('fields').includes('reactions'), () => { throw new Error('no') }],
    [(u) => u.pathname.endsWith('/55/published_posts'), () => ({ data: [{ id: '55_1', created_time: iso(now - 30 * H), message: 'Bubble Dance', permalink_url: 'https://www.facebook.com/reel/777/' }] })],
    [(u) => u.pathname.endsWith('/55/scheduled_posts'), () => ({ data: [] })],
    [(u) => u.pathname.endsWith('/55/video_reels'), () => ({ data: [{ id: '777', description: 'Bubble Dance', video_insights: { data: [{ name: 'fb_reels_total_plays', values: [{ value: 420 }] }, { name: 'post_impressions_unique', values: [{ value: 300 }] }] } }] })],
    // Instagram: insights refused, likes/comments still come through.
    [(u) => u.pathname.endsWith('/1784/media') && u.searchParams.get('fields').includes('insights'), () => { throw new Error('no') }],
    [(u) => u.pathname.endsWith('/1784/media'), () => ({ data: [{ id: 'IG1', timestamp: iso(now - 29 * H), caption: 'Bubble Dance', permalink: 'https://ig/1', media_product_type: 'REELS', like_count: 12, comments_count: 3 }] })],
    [(u) => u.hostname === 'oauth2.googleapis.com', () => ({ access_token: 'GT', expires_in: 3600 })],
    [(u) => u.pathname.endsWith('/playlistItems'), () => ({ items: [{ contentDetails: { videoId: 'V1' } }, { contentDetails: { videoId: 'V2' } }] })],
    [(u) => u.pathname.endsWith('/videos'), (u) => {
      assert.match(u.searchParams.get('part'), /statistics/)
      return { items: [
        { id: 'V1', snippet: { title: 'Bubble Dance #Shorts', description: '', publishedAt: iso(now - 31 * H) }, status: { privacyStatus: 'public' }, statistics: { viewCount: '7225', likeCount: '96', commentCount: '2' } },
        { id: 'V2', snippet: { title: 'Gendu Aur Karela', description: '', publishedAt: iso(now - 50 * H) }, status: { privacyStatus: 'public' }, statistics: { viewCount: '3311', likeCount: '3', commentCount: '0' } },
      ] }
    }],
    [(u) => u.hostname === 'youtubeanalytics.googleapis.com', () => ({
      columnHeaders: ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'likes', 'shares', 'subscribersGained'].map((name) => ({ name })),
      rows: [['V1', 7225, 900, 21, 87.44, 96, 5, 4]],
    })],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'meta:page:55': { token: 'PT' }, 'youtube:UCabc': { refreshToken: 'R' }, 'app:google': { clientId: 'a', clientSecret: 'b' } } })
  await call(env, 'POST', '/api/brands', { brands: { b1: { name: 'B1', platforms: ['facebook', 'instagram', 'youtube'], facebook: { pageId: '55' }, instagram: { userId: '1784' }, youtube: { channelId: 'UCabc' } } } })
  const s = await call(env, 'POST', '/api/sync', {})
  assert.deepEqual(s.data.results.map((r) => [r.platform, r.ok, r.limited]), [['facebook', true, ['reactions/comments']], ['instagram', true, ['views/reach/saves/shares']], ['youtube', true, undefined]])
  assert.ok(calls.some((c) => c.url.hostname === 'youtubeanalytics.googleapis.com'))

  const cal = await call(env, 'GET', `/api/calendar?from=${now - 7 * 24 * H}&to=${now}`)
  const m = (pl, t) => cal.data.entries.find((e) => e.platform === pl && e.title.startsWith(t)).metrics
  assert.deepEqual(m('youtube', 'Bubble'), { views: 7225, likes: 96, comments: 2, shares: 5, watchMinutes: 900, avgWatchSec: 21, avgPctWatched: 87.4, subscribers: 4 })
  assert.deepEqual(m('youtube', 'Gendu'), { views: 3311, likes: 3, comments: 0 }, 'no analytics row: counts only')
  assert.deepEqual(m('facebook', 'Bubble'), { views: 420, reach: 300 })
  assert.deepEqual(m('instagram', 'Bubble'), { likes: 12, comments: 3 })

  const { analyticsReport } = await import('../src/analytics.mjs')
  const text = analyticsReport(cal.data)
  assert.match(text, /=== B1 ===/)
  assert.match(text, /youtube\s+2\s+10\.5k/)
  assert.match(text, /87\.4% watched/)
  assert.match(text, /instagram: no views\/reach\/saves\/shares/)
  const topList = text.slice(text.indexOf('Top '))
  assert.ok(topList.indexOf('7225 views') < topList.indexOf('3311 views'), 'most viewed first')
  assert.match(text, /facebook\s+1\s+420\s+420\s+–\s+–\s+–/, 'missing likes are not shown as 0')

  // A post that disappears takes its numbers with it.
  fakeNet([
    [(u) => u.pathname.endsWith('/published_posts') || u.pathname.endsWith('/scheduled_posts') || u.pathname.endsWith('/video_reels') || u.pathname.endsWith('/media'), () => ({ data: [] })],
    [(u) => u.hostname === 'oauth2.googleapis.com', () => ({ access_token: 'GT', expires_in: 3600 })],
    [(u) => u.pathname.endsWith('/playlistItems'), () => ({ items: [] })],
  ])
  await call(env, 'POST', '/api/sync', {})
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 0)
})

test('blog job: publishes the Sanity drafts (two languages) in one call at its time', { skip }, async () => {
  const env = env0()
  let body
  const calls = fakeNet([
    [(u, i) => u.hostname === 'p1.api.sanity.io' && u.pathname === '/v2024-10-01/data/actions/production' && i.method === 'POST', (u, i) => {
      body = JSON.parse(i.body)
      return { transactionId: 't1' }
    }],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'sanity:p1': { token: 'ST' } } })
  const docs = [
    { draftId: 'drafts.blogPost.en.x', publishedId: 'blogPost.en.x' },
    { draftId: 'drafts.blogPost.es.x-es', publishedId: 'blogPost.es.x-es' },
  ]
  const j = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'acme', platform: 'blog', spec: 'blog:x', at: Date.now(), job: { kind: 'sanity', projectId: 'p1', dataset: 'production', docs, url: 'https://acme.example/blog/x', title: 'x', tokenRef: 'sanity:p1' } }],
  })
  await tick(env)
  const row = env.DB.raw.prepare('SELECT status, result FROM jobs WHERE id = ?').get(j.data.ids[0])
  assert.equal(row.status, 'published')
  assert.equal(JSON.parse(row.result).url, 'https://acme.example/blog/x')
  assert.deepEqual(body.actions.map((a) => [a.actionType, a.draftId, a.publishedId]), docs.map((d) => ['sanity.action.document.publish', d.draftId, d.publishedId]))
  assert.equal(calls.filter((c) => c.url.hostname === 'p1.api.sanity.io').length, 1, 'published once')
})

test('CSV export: cells that look like formulas are kept as text', async () => {
  const { csvCell, APP_JS } = await import('../cloud/dashboard.mjs')
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`)
  for (const v of ['+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) assert.ok(csvCell(v).startsWith(`"'`), v)
  assert.equal(csvCell('Spring reel'), '"Spring reel"')
  assert.equal(csvCell(12), '"12"')
  assert.equal(csvCell(undefined), '""')
  assert.match(APP_JS, /var csvCell = /)
  new Function(APP_JS.replace(/\(function appMain[\s\S]*$/, '')) // the injected helper parses
})

test('calendar sync uses fixed hosts only', async () => {
  const { pinterestBase, graphVersion } = await import('../cloud/calendar.mjs')
  assert.equal(pinterestBase(undefined), 'https://api.pinterest.com/v5')
  assert.equal(pinterestBase(undefined, true), 'https://api-sandbox.pinterest.com/v5')
  assert.equal(pinterestBase('https://api-sandbox.pinterest.com/v5'), 'https://api-sandbox.pinterest.com/v5')
  assert.throws(() => pinterestBase('https://evil.example/v5'), /not allowed/)
  assert.equal(graphVersion(undefined), 'v24.0')
  assert.equal(graphVersion('v25.0'), 'v25.0')
  for (const v of ['v24.0@evil.example', 'v24.0/../x', '24.0', 'v24']) assert.throws(() => graphVersion(v), /not allowed/)
})
