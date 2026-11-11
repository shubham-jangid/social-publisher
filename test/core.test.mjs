import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'))
process.env.SOCIAL_CONFIG_DIR = path.join(tmp, 'config')
process.env.SOCIAL_NO_CLEAN = '1' // fake media files
process.env.SOCIAL_BRANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brands')

const { insertBeforeHashtags, linkedinCommentary, splitTrailingHashtags, tagLink } = await import('../src/text.mjs')
const { parseWhen, parseArgs } = await import('../src/util.mjs')
const { loadSpec, baseFields } = await import('../src/spec.mjs')
const { PLATFORMS } = await import('../src/publish.mjs')

const brand = { key: 'acme', site: 'https://acme.example', utm: { medium: 'social' } }

test('hashtags stay last when a line is added', () => {
  const t = 'Line one.\nLine two.\n\n#gardening #acme'
  assert.deepEqual(splitTrailingHashtags(t), { body: 'Line one.\nLine two.', tags: '#gardening #acme' })
  assert.equal(insertBeforeHashtags(t, 'X'), 'Line one.\nLine two.\n\nX\n\n#gardening #acme')
  assert.equal(insertBeforeHashtags('No tags here.', 'X'), 'No tags here.\n\nX')
  assert.equal(insertBeforeHashtags('हिंदी कैप्शन\n\n#कहानी #किताब', 'X'), 'हिंदी कैप्शन\n\nX\n\n#कहानी #किताब')
})

test('utm tags only our own site, never overwrites', () => {
  const spec = { id: 'post-a', campaign: 'spring' }
  assert.equal(
    tagLink('https://acme.example/shop?x=1', { platform: 'pinterest', brand, spec }),
    'https://acme.example/shop?x=1&utm_source=pinterest&utm_medium=social&utm_campaign=spring&utm_content=post-a',
  )
  assert.equal(tagLink('https://youtu.be/abc', { platform: 'pinterest', brand, spec }), 'https://youtu.be/abc')
  assert.equal(
    tagLink('https://www.acme.example/?utm_source=x', { platform: 'linkedin', brand, spec }),
    'https://www.acme.example/?utm_source=x',
  )
  assert.equal(tagLink('https://acme.example/', { platform: 'linkedin', brand: { ...brand, utm: false }, spec }), 'https://acme.example/')
})

test('linkedin commentary escapes reserved characters and keeps hashtags', () => {
  assert.equal(linkedinCommentary('50% (bulk) @ $10 #Gardening'), '50% \\(bulk\\) \\@ $10 {hashtag|\\#|Gardening}')
  assert.equal(linkedinCommentary('a_b *c* ~d~ [e] <f> {g} |h| \\'), 'a\\_b \\*c\\* \\~d\\~ \\[e\\] \\<f\\> \\{g\\} \\|h\\| \\\\')
})

test('times are read in the brand time zone', () => {
  assert.equal(parseWhen('2026-11-05 18:30', 'Asia/Kolkata').toISOString(), '2026-11-05T13:00:00.000Z')
  assert.equal(parseWhen('2026-11-05T18:30:00+05:30').toISOString(), '2026-11-05T13:00:00.000Z')
  assert.equal(parseWhen('now'), null)
  assert.throws(() => parseWhen('tomorrow 6pm'))
})

test('boolean flags do not swallow the next argument', () => {
  assert.deepEqual(parseArgs(['post', '--dry-run', 'a.json', '--only', 'youtube']), {
    pos: ['post', 'a.json'],
    flags: { 'dry-run': true, only: 'youtube' },
  })
})

function writeSpec(obj, files = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'post-'))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  const file = path.join(dir, 'post.json')
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

test('reel spec: every platform plans, AI line only where there is no AI label', () => {
  const file = writeSpec(
    {
      brand: 'acme',
      media: 'reel.mp4',
      cover: 'cover.png',
      captionFile: 'caption.txt',
      title: 'गोबर बनाम वर्मीकम्पोस्ट',
      link: 'https://acme.example/',
      ai: true,
      platforms: { facebook: {}, instagram: {}, youtube: {} },
    },
    { 'reel.mp4': 'x', 'cover.png': 'x', 'caption.txt': 'Body text.\n\n#gardening' },
  )
  const spec = loadSpec(file)
  assert.equal(spec.kind, 'video')
  const fb = PLATFORMS.facebook.plan(spec)
  assert.equal(fb.kind, 'reel')
  assert.equal(fb.caption, 'Body text.\n\nVisuals created with AI.\n\n#gardening')
  const yt = PLATFORMS.youtube.plan(spec)
  assert.equal(yt.synthetic, true)
  assert.ok(!yt.description.includes('Some visuals'))
  assert.equal(yt.description, 'Body text.\n\n🌐 Website: https://acme.example/yt/{videoId}\n\n#gardening')
  assert.equal(yt.fillsVideoId, true)
  assert.equal(yt.madeForKids, false)
})

test('specs are validated before anything is posted', () => {
  const noTitle = loadSpec(writeSpec({ brand: 'acme', media: 'v.mp4', platforms: { youtube: {} } }, { 'v.mp4': 'x' }))
  assert.throws(() => PLATFORMS.youtube.plan(noTitle), /title/)
  const text = loadSpec(writeSpec({ brand: 'acme', caption: 'hi', platforms: { instagram: {} } }))
  assert.throws(() => PLATFORMS.instagram.plan(text), /video or images/)
  assert.throws(() => loadSpec(writeSpec({ brand: 'acme', media: 'missing.mp4' })), /file not found/)
  assert.throws(() => loadSpec(writeSpec({ brand: 'nope' })), /Unknown brand/)
})

test('pinterest: board alias resolves, long text is cut', () => {
  const spec = loadSpec(
    writeSpec(
      { brand: 'storytime', media: 'v.mp4', caption: 'Título\n' + 'ñ '.repeat(600), platforms: { pinterest: {} } },
      { 'v.mp4': 'x' },
    ),
  )
  const p = PLATFORMS.pinterest.plan(spec)
  assert.equal(p.board, 'Story Time | Bedtime Stories')
  assert.ok(p.description.length <= 800)
  assert.equal(p.title, 'Título')
  const yt = PLATFORMS.youtube.plan({ ...spec, platforms: { youtube: { title: 'T' } } })
  assert.equal(yt.madeForKids, true)
})

test('per-platform caption override and {link}', () => {
  const spec = loadSpec(
    writeSpec({
      brand: 'acme',
      caption: 'Read more: {link}',
      link: 'https://acme.example/blog/x',
      id: 'p1',
      platforms: { facebook: {}, linkedin: { caption: 'LI only' } },
    }),
  )
  const f = baseFields(spec, 'facebook')
  assert.equal(f.caption, 'Read more: https://acme.example/blog/x?utm_source=facebook&utm_medium=social&utm_campaign=post&utm_content=p1')
  assert.equal(baseFields(spec, 'linkedin').caption, 'LI only')
})

test('hashtag lines right under the text still count as the tag block', () => {
  assert.equal(
    insertBeforeHashtags('Body.\n\nVisuals created with AI.\n#a #b', 'X'),
    'Body.\n\nVisuals created with AI.\n\nX\n\n#a #b',
  )
})

test('wrangler is pinned to one exact 4.x release', async () => {
  const { WRANGLER_VERSION } = await import('../src/cloud.mjs')
  assert.match(WRANGLER_VERSION, /^4\.\d+\.\d+$/)
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cloud.mjs'), 'utf8')
  assert.ok(!/wrangler@4['"`]/.test(src), 'no floating wrangler@4 left')
})
