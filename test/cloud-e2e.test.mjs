// The Mac half for real: `publishSpec` → upload → job, against the Worker
// served on localhost with fake D1/R2. Needs Node 22+ (node:sqlite) and macOS sips.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fakeD1, fakeR2, hasSqlite } from './fakes.mjs'

const skip = (!hasSqlite && 'needs Node 22+ (node:sqlite)') || (process.platform !== 'darwin' && 'needs macOS sips')

test('social post hands Instagram to the cloud scheduler; results sync back', { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-'))
  const cfgDir = path.join(tmp, 'config')
  const brandsDir = path.join(tmp, 'brands')
  fs.mkdirSync(cfgDir)
  fs.mkdirSync(brandsDir)
  process.env.SOCIAL_CONFIG_DIR = cfgDir
  process.env.SOCIAL_NO_CLEAN = '1' // fake media files
  process.env.SOCIAL_BRANDS_DIR = brandsDir

  const { default: worker } = await import('../cloud/worker.mjs')
  const env = { DB: fakeD1(), MEDIA: fakeR2(), API_TOKEN: 'k', TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'), MEDIA_KEY: 'm' }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const r = await worker.fetch(
      new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }),
      env,
      { waitUntil: () => {} },
    )
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  try {
    fs.writeFileSync(path.join(cfgDir, 'apps.json'), JSON.stringify({ cloud: { url, apiToken: 'k' }, meta: { appId: 'a', appSecret: 's' } }))
    fs.writeFileSync(
      path.join(cfgDir, 'tokens.json'),
      JSON.stringify({ meta: { pages: { 55: { name: 'Test Page', token: 'PAGE', igUserId: '1784', igUsername: 'testbrand', savedAt: '2026-11-01T00:00:00Z' } } } }),
    )
    fs.writeFileSync(path.join(brandsDir, 'test.json'), JSON.stringify({ name: 'Test', aiDisclosure: 'Made with AI.', instagram: { username: 'testbrand' } }))

    const posts = path.join(tmp, 'posts')
    fs.mkdirSync(posts)
    fs.writeFileSync(path.join(posts, 'reel.mp4'), Buffer.alloc(40 * 1024 * 1024 + 5, 3)) // two upload parts
    // a real PNG so sips can turn it into the JPEG Instagram wants
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    fs.writeFileSync(path.join(posts, 'cover.png'), png)
    const at = new Date(Date.now() + 2 * 86400_000)
    const specFile = path.join(posts, 'ep.json')
    fs.writeFileSync(
      specFile,
      JSON.stringify({ brand: 'test', media: 'reel.mp4', cover: 'cover.png', caption: 'Hello\n\n#tag', ai: true, at: at.toISOString(), platforms: { instagram: {} } }),
    )

    const { publishSpec } = await import('../src/publish.mjs')
    const { failed, results } = await publishSpec(specFile)
    assert.equal(failed, 0, JSON.stringify(results))
    const r = results.instagram
    assert.equal(r.status, 'scheduled')
    assert.equal(r.via, 'cloud')
    assert.match(r.jobId, /^j_/)

    const row = env.DB.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(r.jobId)
    const job = JSON.parse(row.job)
    assert.equal(row.at, at.getTime())
    assert.equal(job.igUserId, '1784')
    assert.equal(job.tokenRef, 'meta:page:55')
    assert.equal(job.caption, 'Hello\n\nMade with AI.\n\n#tag', 'AI line goes above the hashtags')
    assert.equal(job.media[0].size, 40 * 1024 * 1024 + 5)
    assert.equal(job.cover.mime, 'image/jpeg', 'cover converted for Instagram')
    assert.equal(env.MEDIA.objects.get(job.media[0].key).bytes.length, 40 * 1024 * 1024 + 5, 'whole video arrived')
    assert.ok(env.DB.raw.prepare("SELECT ref FROM secrets WHERE ref = 'meta:page:55'").get(), 'sign-in pushed')

    // running the same post again does not schedule it twice
    const again = await publishSpec(specFile)
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
    assert.equal(again.failed, 0)

    // the Worker posts it; the Mac picks that up
    env.DB.raw.prepare(`UPDATE jobs SET status = 'published', result = ? WHERE id = ?`).run(JSON.stringify({ id: 'P', url: 'https://ig/p' }), r.jobId)
    const { syncResults } = await import('../src/cloud.mjs')
    await syncResults()
    const saved = JSON.parse(fs.readFileSync(path.join(posts, 'ep.result.json'), 'utf8'))
    assert.equal(saved.instagram.status, 'published')
    assert.equal(saved.instagram.url, 'https://ig/p')
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
