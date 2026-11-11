// Runs cloud/worker.mjs against a fake D1 (node:sqlite), a fake R2 and fake
// platform APIs, with a clock we move by hand. Needs Node 22+ (node:sqlite).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeD1, fakeR2, hasSqlite } from './fakes.mjs'

const skip = !hasSqlite && 'needs Node 22+ (node:sqlite)'

// ---- clock ------------------------------------------------------------------
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
const advance = (ms) => (offset += ms)


// ---- fake outside world -------------------------------------------------------
function fakeNet(handlers) {
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    const call = { method: init.method || 'GET', url: u, headers: new Headers(init.headers), body: init.body }
    calls.push(call)
    for (const [match, fn] of handlers) {
      if (match(call)) {
        const r = await fn(call)
        if (r instanceof Response) return r
        return new Response(JSON.stringify(r ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${call.method} ${u}` } }), { status: 599 })
  }
  return calls
}

const { default: worker, tick, Clock, checkJob, timingSafe } = await import('../cloud/worker.mjs')

function makeEnv(extra = {}) {
  return {
    DB: fakeD1(),
    MEDIA: fakeR2(),
    API_TOKEN: 'test-token',
    TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    MEDIA_KEY: 'media-key',
    RESEND_API_KEY: 'rk',
    ALERT_TO: 'owner@example.com',
    ALERT_FROM: 'Social <hello@example.com>',
    ...extra,
  }
}

const waits = []
const ctx = { waitUntil: (p) => waits.push(p.catch(() => {})) }
async function call(env, method, p, body, { token = 'test-token', raw } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body && !raw) headers['content-type'] = 'application/json'
  const res = await worker.fetch(
    new Request(`https://sched.example.workers.dev${p}`, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) }),
    env,
    ctx,
  )
  await Promise.all(waits.splice(0))
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function upload(env, bytes, name, mime) {
  const s = await call(env, 'POST', '/api/upload/start', { name, mime, size: bytes.length })
  const parts = []
  const PART = 7 // tiny parts so the multipart path is exercised
  for (let n = 1, off = 0; off < bytes.length; n++, off += PART) {
    const q = `?key=${encodeURIComponent(s.data.key)}&uploadId=${s.data.uploadId}&n=${n}`
    parts.push((await call(env, 'PUT', `/api/upload/part${q}`, null, { raw: bytes.subarray(off, off + PART) })).data)
  }
  const done = await call(env, 'POST', '/api/upload/complete', { key: s.data.key, uploadId: s.data.uploadId, parts })
  return { key: done.data.key, mime, size: done.data.size, name }
}

const job = (env, id) => env.DB.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id)

// ---- tests ---------------------------------------------------------------------

test('API refuses a missing or wrong key', { skip }, async () => {
  const env = makeEnv()
  assert.equal((await call(env, 'GET', '/api/health', null, { token: null })).status, 401)
  assert.equal((await call(env, 'GET', '/api/health', null, { token: 'nope' })).status, 401)
  assert.equal((await call(env, 'GET', '/api/health')).status, 200)
})

test('instagram reel: prepared early, posted at the time, media deleted, signed links work', { skip }, async () => {
  const env = makeEnv()
  let polls = 0
  let fetchedVideo = null
  const calls = fakeNet([
    [(c) => c.url.pathname.endsWith('/17841/media') && c.method === 'POST', async (c) => {
      const form = new URLSearchParams(String(c.body))
      assert.equal(form.get('media_type'), 'REELS')
      assert.equal(form.get('access_token'), 'PAGE-TOKEN')
      assert.equal(form.get('caption'), 'Hello')
      // Instagram downloads the video from the signed link: check it really serves the bytes, and ranges
      const v = await worker.fetch(new Request(form.get('video_url')), env, ctx)
      assert.equal(v.status, 200)
      fetchedVideo = Buffer.from(await v.arrayBuffer()).toString()
      const r = await worker.fetch(new Request(form.get('video_url'), { headers: { range: 'bytes=2-5' } }), env, ctx)
      assert.equal(r.status, 206)
      assert.equal(r.headers.get('content-range'), 'bytes 2-5/26')
      assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'cdef')
      const bad = await worker.fetch(new Request(form.get('video_url').replace(/s=[0-9a-f]/, 's=0')), env, ctx)
      assert.equal(bad.status, 403)
      assert.ok(form.get('cover_url').includes('/m/media/'))
      return { id: 'C1' }
    }],
    [(c) => c.url.pathname.endsWith('/C1') && c.method === 'GET', () => ({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' })],
    [(c) => c.url.pathname.endsWith('/media_publish'), (c) => {
      assert.equal(new URLSearchParams(String(c.body)).get('creation_id'), 'C1')
      return { id: 'P1' }
    }],
    [(c) => c.url.pathname.endsWith('/P1'), () => ({ permalink: 'https://instagram.com/reel/P1' })],
  ])

  assert.deepEqual((await call(env, 'POST', '/api/secrets', { items: { 'meta:page:55': { token: 'PAGE-TOKEN', savedAt: '2026-11-01T00:00:00Z' } } })).data.saved, ['meta:page:55'])
  const video = await upload(env, Buffer.from('abcdefghijklmnopqrstuvwxyz'), 'reel.mp4', 'video/mp4')
  const cover = await upload(env, Buffer.from('jpegbytes'), 'cover.jpg', 'image/jpeg')
  assert.equal(env.MEDIA.objects.size, 2)

  const at = Date.now() + 60 * 60_000 // an hour from now
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'acme', platform: 'instagram', spec: '/x/ep.json', at, job: { kind: 'reel', caption: 'Hello', igUserId: '17841', tokenRef: 'meta:page:55', media: [video], cover } }],
  })
  const id = data.ids[0]
  assert.equal(job(env, id).status, 'scheduled')
  assert.equal(calls.length, 0, 'nothing happens an hour early')

  advance(41 * 60_000) // 19 min before: preparation starts
  await tick(env)
  assert.equal(fetchedVideo, 'abcdefghijklmnopqrstuvwxyz')
  assert.equal(job(env, id).step, 'wait')
  advance(30_000)
  await tick(env)
  assert.equal(job(env, id).step, 'publish', 'processed, waiting for the post time')
  assert.equal(job(env, id).status, 'preparing')
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/media_publish')), 'not posted early')

  advance(19 * 60_000)
  await tick(env)
  const done = job(env, id)
  assert.equal(done.status, 'published')
  assert.equal(JSON.parse(done.result).url, 'https://instagram.com/reel/P1')
  assert.equal(env.MEDIA.objects.size, 0, 'media deleted after posting')
})

test('a failed publish is never retried and sends an email', { skip }, async () => {
  const env = makeEnv()
  const calls = fakeNet([
    [(c) => c.url.hostname === 'api.linkedin.com' && c.url.pathname === '/rest/posts', () => new Response('{"message":"boom"}', { status: 500 })],
    [(c) => c.url.hostname === 'api.resend.com', () => ({ id: 'mail' })],
  ])
  await call(env, 'POST', '/api/secrets', {
    items: { 'linkedin:default': { accessToken: 'LI', expiresAt: new Date(Date.now() + 50 * 86400_000).toISOString(), savedAt: '2026-11-01T00:00:00Z' } },
  })
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'blocked-brand', platform: 'linkedin', spec: '/x/t.json', job: { kind: 'text', commentary: 'Hi', author: 'urn:li:organization:1', tokenRef: 'linkedin:default', appRef: 'app:linkedin:default' } }],
  })
  await tick(env)
  const row = job(env, data.ids[0])
  assert.equal(row.status, 'failed')
  assert.match(row.error, /may have posted anyway/)
  advance(10 * 60_000)
  await tick(env)
  assert.equal(calls.filter((c) => c.url.pathname === '/rest/posts').length, 1, 'posted exactly once')
  const mail = calls.find((c) => c.url.hostname === 'api.resend.com')
  assert.match(JSON.parse(mail.body).subject, /Post failed: blocked-brand linkedin/)
})

test('a prep step that fails is retried, then gives up and emails', { skip }, async () => {
  const env = makeEnv()
  let tries = 0
  const calls = fakeNet([
    [(c) => c.url.pathname.endsWith('/media') && c.method === 'POST', () => (tries++, new Response('{"error":{"message":"down"}}', { status: 503 }))],
    [(c) => c.url.hostname === 'api.resend.com', () => ({ id: 'mail' })],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'meta:page:55': { token: 'T' } } })
  const img = await upload(env, Buffer.from('img'), 'a.jpg', 'image/jpeg')
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'b2', platform: 'instagram', spec: '/x/i.json', job: { kind: 'image', caption: 'c', igUserId: '1', tokenRef: 'meta:page:55', media: [img] } }],
  })
  await tick(env)
  for (let i = 0; i < 5; i++) {
    advance(10 * 60_000)
    await tick(env)
  }
  const row = job(env, data.ids[0])
  assert.equal(tries, 3)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /down/)
  assert.ok(calls.some((c) => c.url.hostname === 'api.resend.com'))
  assert.equal(env.MEDIA.objects.size, 1, 'failed jobs keep their media for a retry')
})

test('linkedin video: a long upload is spread over several runs within the request budget', { skip }, async () => {
  const env = makeEnv()
  const parts = Array.from({ length: 70 }, (_, i) => ({ uploadUrl: `https://up.linkedin.example/p${i}`, firstByte: i * 2, lastByte: i * 2 + 1 }))
  let perRun = 0
  const got = []
  const calls = fakeNet([
    [(c) => c.url.pathname === '/rest/videos' && c.url.searchParams.get('action') === 'initializeUpload', () => ({
      value: { video: 'urn:li:video:9', uploadToken: '', uploadInstructions: parts },
    })],
    [(c) => c.url.hostname === 'up.linkedin.example', async (c) => {
      perRun++
      got[Number(c.url.pathname.slice(2))] = Buffer.from(c.body).toString()
      return new Response(null, { status: 200, headers: { etag: `t${c.url.pathname}` } })
    }],
    [(c) => c.url.searchParams.get('action') === 'finalizeUpload', (c) => {
      assert.equal(JSON.parse(c.body).finalizeUploadRequest.uploadedPartIds.length, 70)
      return {}
    }],
    [(c) => c.url.pathname.startsWith('/rest/videos/'), () => ({ status: 'AVAILABLE' })],
    [(c) => c.url.pathname === '/rest/posts', () => new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } })],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'linkedin:default': { accessToken: 'LI', expiresAt: new Date(Date.now() + 50 * 86400_000).toISOString() } } })
  const bytes = Buffer.from('ab'.repeat(70) + 'tail')
  const video = await upload(env, bytes, 'v.mp4', 'video/mp4')
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'b3', platform: 'linkedin', spec: '/x/v.json', job: { kind: 'video', commentary: 'v', title: 'T', author: 'urn:li:organization:1', tokenRef: 'linkedin:default', media: [video] } }],
  })
  let runs = 0
  while (job(env, data.ids[0]).status !== 'published' && runs < 10) {
    perRun = 0
    advance(60_000)
    await tick(env)
    runs++
    assert.ok(perRun <= 40, `run ${runs} used ${perRun} outside requests`)
  }
  assert.equal(job(env, data.ids[0]).status, 'published')
  assert.ok(runs >= 2, `took ${runs} runs`)
  assert.equal(got.join(''), bytes.toString().slice(0, 140), 'every part carried the right bytes')
  assert.equal(JSON.parse(job(env, data.ids[0]).result).id, 'urn:li:share:7')
  assert.ok(calls.length > 70)
})

test('pinterest video: streamed multipart upload, then a pin with a signed cover link', { skip }, async () => {
  const env = makeEnv()
  let pinBody
  fakeNet([
    [(c) => c.url.pathname === '/v5/media' && c.method === 'POST', () => ({ media_id: 'M1', upload_url: 'https://s3.pinterest.example/up', upload_parameters: { key: 'abc', policy: 'p' } })],
    [(c) => c.url.hostname === 's3.pinterest.example', async (c) => {
      const text = await new Response(c.body).text()
      assert.match(c.headers.get('content-type'), /multipart\/form-data; boundary=/)
      assert.match(text, /name="key"\r\n\r\nabc\r\n/)
      assert.match(text, /name="file"; filename="v.mp4"\r\nContent-Type: video\/mp4\r\n\r\nVIDEO-BYTES\r\n--/)
      return new Response(null, { status: 204 })
    }],
    [(c) => c.url.pathname === '/v5/media/M1', () => ({ status: 'succeeded' })],
    [(c) => c.url.pathname === '/v5/pins', (c) => ((pinBody = JSON.parse(c.body)), { id: '999' })],
  ])
  await call(env, 'POST', '/api/secrets', {
    items: { 'pinterest:b1': { accessToken: 'PT', refreshToken: 'R', expiresAt: new Date(Date.now() + 20 * 86400_000).toISOString() } },
  })
  const video = await upload(env, Buffer.from('VIDEO-BYTES'), 'v.mp4', 'video/mp4')
  const cover = await upload(env, Buffer.from('C'), 'c.png', 'image/png')
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'b1', platform: 'pinterest', spec: '/x/p.json', job: { kind: 'video', title: 'T', description: 'D', boardId: 'B1', base: 'https://api.pinterest.com/v5', tokenRef: 'pinterest:b1', appRef: 'app:pinterest', media: [video], cover } }],
  })
  await tick(env)
  const row = job(env, data.ids[0])
  assert.equal(row.status, 'published', row.error)
  assert.equal(pinBody.board_id, 'B1')
  assert.equal(pinBody.media_source.media_id, 'M1')
  assert.match(pinBody.media_source.cover_image_url, /\/m\/media\/.*\?e=\d+&s=[0-9a-f]{64}$/)
})

test('pinterest token is renewed on the Worker and the Mac cannot overwrite the newer copy', { skip }, async () => {
  const env = makeEnv()
  fakeNet([
    [(c) => c.url.pathname === '/v5/oauth/token', (c) => {
      assert.equal(c.headers.get('authorization'), 'Basic ' + btoa('app:sec'))
      return { access_token: 'NEW', refresh_token: 'R2', expires_in: 30 * 86400, refresh_token_expires_in: 365 * 86400 }
    }],
    [(c) => c.url.pathname === '/v5/pins', (c) => {
      assert.equal(c.headers.get('authorization'), 'Bearer NEW')
      return { id: '1' }
    }],
  ])
  await call(env, 'POST', '/api/secrets', {
    items: {
      'pinterest:b1': { accessToken: 'OLD', refreshToken: 'R', expiresAt: new Date(Date.now() + 3600_000).toISOString(), savedAt: '2026-10-01T00:00:00.000Z' },
      'app:pinterest': { appId: 'app', appSecret: 'sec' },
    },
  })
  const img = await upload(env, Buffer.from('i'), 'i.jpg', 'image/jpeg')
  const { data } = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'b1', platform: 'pinterest', spec: '/x/p.json', job: { kind: 'image', boardId: 'B', base: 'https://api.pinterest.com/v5', tokenRef: 'pinterest:b1', appRef: 'app:pinterest', media: [img] } }],
  })
  await tick(env)
  assert.equal(job(env, data.ids[0]).status, 'published')
  const again = await call(env, 'POST', '/api/secrets', { items: { 'pinterest:b1': { accessToken: 'OLD', savedAt: '2026-10-01T00:00:00.000Z' } } })
  assert.deepEqual(again.data.kept, ['pinterest:b1'])
  const list = await call(env, 'GET', '/api/secrets')
  assert.ok(list.data.secrets.find((x) => x.ref === 'pinterest:b1').expires_at > new Date(Date.now() + 300 * 86400_000).toISOString(), 'tracks the refresh token expiry')
  assert.ok(!JSON.stringify(list.data).includes('NEW'), 'tokens are never sent back')
})

test('cancel removes a waiting job and its media; a stuck job is marked missed, not posted late', { skip }, async () => {
  const env = makeEnv()
  const calls = fakeNet([
    [(c) => c.url.pathname.endsWith('/media') && c.method === 'POST', () => ({ id: 'C9' })],
    [(c) => c.url.pathname.endsWith('/C9'), () => ({ status_code: 'IN_PROGRESS' })],
    [(c) => c.url.hostname === 'api.resend.com', () => ({ id: 'm' })],
  ])
  await call(env, 'POST', '/api/secrets', { items: { 'meta:page:1': { token: 'T' } } })
  const a = await upload(env, Buffer.from('a'), 'a.jpg', 'image/jpeg')
  const at = Date.now() + 2 * 86400_000
  const one = await call(env, 'POST', '/api/jobs', { jobs: [{ brand: 'b2', platform: 'instagram', spec: '/x/a.json', at, job: { kind: 'image', igUserId: '1', tokenRef: 'meta:page:1', media: [a] } }] })
  assert.equal((await call(env, 'DELETE', `/api/jobs/${one.data.ids[0]}`)).status, 200)
  assert.equal(job(env, one.data.ids[0]).status, 'cancelled')
  assert.equal(env.MEDIA.objects.size, 0)

  // Instagram never finishes processing: after 3 hours past the time it is given up, never posted
  const b = await upload(env, Buffer.from('b'), 'b.jpg', 'image/jpeg')
  const two = await call(env, 'POST', '/api/jobs', { jobs: [{ brand: 'b2', platform: 'instagram', spec: '/x/b.json', job: { kind: 'image', igUserId: '1', tokenRef: 'meta:page:1', media: [b] } }] })
  for (let i = 0; i < 40 && ['scheduled', 'preparing'].includes(job(env, two.data.ids[0]).status); i++) {
    advance(10 * 60_000)
    await tick(env)
  }
  const row = job(env, two.data.ids[0])
  assert.equal(row.status, 'missed')
  assert.match(row.error, /not posted/)
  assert.equal(env.MEDIA.objects.size, 0)
  assert.ok(calls.some((c) => c.url.hostname === 'api.resend.com'), 'owner is told')
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/media_publish')))
})

test('the Clock (Durable Object alarm) wakes for the earliest job and sleeps up to 6 h when idle', { skip }, async () => {
  const env = makeEnv()
  let alarm = null
  const storage = { getAlarm: async () => alarm, setAlarm: async (t) => (alarm = t) }
  const clock = new Clock({ storage }, env)
  env.CLOCK = { idFromName: () => 'main', get: () => ({ fetch: () => clock.fetch() }) }

  const h = await call(env, 'GET', '/api/health')
  assert.equal(h.data.clock, 'alarm')
  assert.ok(Math.abs(alarm - (Date.now() + 6 * 3600_000)) < 5000, 'idle: wakes in 6 h for the expiry check')

  const at = Date.now() + 2 * 3600_000
  await call(env, 'POST', '/api/jobs', { jobs: [{ brand: 'b', platform: 'instagram', spec: 's.json', at, job: { kind: 'reel', igUserId: '1', tokenRef: 'meta:page:1' } }] })
  assert.ok(Math.abs(alarm - (at - 20 * 60_000)) < 5000, 'a new job pulls the alarm in to 20 min before its time')

  await call(env, 'GET', '/api/health') // a later poke never pushes it back out
  assert.ok(Math.abs(alarm - (at - 20 * 60_000)) < 5000)

  advance(30 * 60_000)
  await clock.alarm() // nothing due yet
  assert.ok(Math.abs(alarm - (at - 20 * 60_000)) < 5000, 'after a run it sets the next wake from the queue')

  await call(env, 'POST', '/api/jobs', { jobs: [{ brand: 'b', platform: 'instagram', spec: 's2.json', at: Date.now(), job: { kind: 'reel', igUserId: '1', tokenRef: 'meta:page:1' } }] })
  assert.ok(alarm - Date.now() < 5000, 'a job for now wakes it at once')
  await clock.alarm()
  assert.ok(alarm - Date.now() >= 59_000, 'runs are at least a minute apart')
})

test('alerts go to Telegram when a bot is set, as plain text, with or without email', { skip }, async () => {
  const env = makeEnv({ RESEND_API_KEY: undefined, TELEGRAM_BOT_TOKEN: 'bot123', TELEGRAM_CHAT_ID: '42' })
  const calls = fakeNet([[(c) => c.url.hostname === 'api.telegram.org', () => ({ ok: true })]])
  const h = await call(env, 'GET', '/api/health')
  assert.deepEqual(h.data.alertsVia, ['telegram'])
  assert.equal((await call(env, 'POST', '/api/alerts/test')).status, 200)
  const tg = calls.find((c) => c.url.hostname === 'api.telegram.org')
  assert.equal(tg.url.pathname, '/botbot123/sendMessage')
  const body = JSON.parse(tg.body)
  assert.equal(body.chat_id, '42')
  assert.equal(body.parse_mode, undefined)
  assert.ok(!calls.some((c) => c.url.hostname === 'api.resend.com'))
  assert.equal((await call(makeEnv({ RESEND_API_KEY: undefined }), 'POST', '/api/alerts/test')).status, 409)
})

test('a switched-off brand: new jobs are refused, old ones are cancelled without posting', { skip }, async () => {
  const env = makeEnv({ BLOCKED_BRANDS: 'blocked-brand' })
  const calls = fakeNet([])
  const r = await call(env, 'POST', '/api/jobs', {
    jobs: [{ brand: 'blocked-brand', platform: 'instagram', spec: 'x', job: { kind: 'image' } }],
  })
  assert.equal(r.status, 403)
  // a job queued before the switch was turned off
  env.DB.raw
    .prepare(
      `INSERT INTO jobs (id, brand, platform, spec, at, next_at, status, step, job, state, created_at, updated_at)
       VALUES ('j_old', 'blocked-brand', 'instagram', 'x', ?, ?, 'scheduled', 'start', '{}', '{}', ?, ?)`,
    )
    .run(Date.now(), Date.now(), Date.now(), Date.now())
  await tick(env)
  assert.equal(job(env, 'j_old').status, 'cancelled')
  assert.equal(calls.length, 0)
})

test('jobs cannot steer a stored sign-in to another host or borrow another platform\'s secret', { skip }, async () => {
  const env = makeEnv()
  const bad = [
    ['pinterest', { kind: 'image', boardId: 'B', base: 'https://evil.example/v5', tokenRef: 'pinterest:x', appRef: 'app:pinterest' }],
    ['pinterest', { kind: 'image', boardId: 'B', base: 'https://api.pinterest.com.evil.example/v5', tokenRef: 'pinterest:x' }],
    ['pinterest', { kind: 'image', boardId: 'B', tokenRef: 'pinterest:x', appRef: 'app:google' }],
    ['instagram', { kind: 'image', igUserId: '1', tokenRef: 'meta:page:1', graphVersion: 'v24.0@evil.example' }],
    ['instagram', { kind: 'image', igUserId: '1', tokenRef: 'sanity:p1' }],
    ['instagram', { kind: 'image', igUserId: '1/../../x', tokenRef: 'meta:page:1' }],
    ['linkedin', { kind: 'text', tokenRef: 'linkedin:default', appRef: 'app:pinterest' }],
    ['linkedin', { kind: 'text', tokenRef: 'youtube:UC1' }],
    ['blog', { kind: 'sanity', projectId: 'evil.example/x', dataset: 'production', docs: [{}], tokenRef: 'sanity:p1' }],
    ['blog', { kind: 'sanity', projectId: 'p1', dataset: 'production?x=1', docs: [{}], tokenRef: 'sanity:p1' }],
    ['blog', { kind: 'sanity', projectId: 'attacker', dataset: 'production', docs: [{}], tokenRef: 'sanity:p1' }],
  ]
  for (const [platform, j] of bad) {
    const r = await call(env, 'POST', '/api/jobs', { jobs: [{ brand: 'b1', platform, spec: 'x', job: j }] })
    assert.equal(r.status, 400, `${platform} ${JSON.stringify(j)}`)
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0)
  // the ones the Mac really sends still pass
  checkJob('pinterest', { base: 'https://api-sandbox.pinterest.com/v5', sandbox: true, tokenRef: 'pinterest:x', appRef: 'app:pinterest' })
  checkJob('pinterest', { sandbox: true, tokenRef: 'pinterest:x' })
  checkJob('instagram', { igUserId: '17841', tokenRef: 'meta:page:55', graphVersion: 'v25.0' })
  checkJob('linkedin', { tokenRef: 'linkedin:default', appRef: 'app:linkedin:default' })
  checkJob('blog', { projectId: 'p1', dataset: 'my_data-set', docs: [{}], tokenRef: 'sanity:p1' })
})

test('a bad job already stored is refused at run time: nothing is fetched', { skip }, async () => {
  const env = makeEnv({ RESEND_API_KEY: undefined })
  const calls = fakeNet([])
  const evil = { kind: 'image', boardId: 'B', base: 'https://evil.example/v5', tokenRef: 'pinterest:x', media: [] }
  env.DB.raw
    .prepare(
      `INSERT INTO jobs (id, brand, platform, spec, at, next_at, status, step, job, state, created_at, updated_at)
       VALUES ('j_bad', 'b1', 'pinterest', 'x', ?, ?, 'scheduled', 'start', ?, '{}', ?, ?)`,
    )
    .run(Date.now(), Date.now(), JSON.stringify(evil), Date.now(), Date.now())
  await tick(env)
  assert.equal(job(env, 'j_bad').status, 'failed')
  assert.match(job(env, 'j_bad').error, /not allowed/)
  assert.equal(calls.filter((c) => c.url.hostname === 'evil.example').length, 0)
})

test('brands pushed for the calendar may not name their own API host or Graph version', { skip }, async () => {
  const env = makeEnv()
  const r1 = await call(env, 'POST', '/api/brands', { brands: { b1: { name: 'B', pinterest: { username: 'u', base: 'https://evil.example/v5' } } } })
  assert.equal(r1.status, 400)
  const r2 = await call(env, 'POST', '/api/brands', { brands: { b1: { name: 'B', graphVersion: 'v1.0/../../x@evil.example' } } })
  assert.equal(r2.status, 400)
  const ok = await call(env, 'POST', '/api/brands', { brands: { b1: { name: 'B', graphVersion: 'v24.0', pinterest: { username: 'u', base: 'https://api-sandbox.pinterest.com/v5' } } } })
  assert.equal(ok.status, 200)
})

test('timingSafe: different lengths never match', () => {
  assert.equal(timingSafe('abc', 'abc'), true)
  assert.equal(timingSafe('abc', 'abcd'), false)
  assert.equal(timingSafe('abcd', 'abc'), false)
  assert.equal(timingSafe('', 'a'), false)
  assert.equal(timingSafe('abc', 'abd'), false)
})
