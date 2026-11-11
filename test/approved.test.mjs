// `social post --approved-only` (what the MCP server's schedule_post runs): every file must be
// in the brand's approved folders, is checked once, and only the checked copy is used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-approved-')))
const approved = path.join(tmp, 'approved')
const drafts = path.join(tmp, 'drafts')
for (const d of ['approved', 'drafts', 'brands', 'config', 'posts']) fs.mkdirSync(path.join(tmp, d))
fs.writeFileSync(path.join(tmp, 'brands', 'b1.json'), JSON.stringify({ name: 'B1', approvedDirs: [approved], youtube: { channelId: 'UC1', madeForKids: false } }))
fs.writeFileSync(path.join(tmp, 'brands', 'b2.json'), JSON.stringify({ name: 'B2', youtube: { channelId: 'UC2', madeForKids: false } }))
process.env.SOCIAL_CONFIG_DIR = path.join(tmp, 'config')
process.env.SOCIAL_BRANDS_DIR = path.join(tmp, 'brands')
process.env.SOCIAL_NO_CLEAN = '1'
const { loadSpec, baseFields } = await import('../src/spec.mjs')

const write = (name, spec) => {
  const f = path.join(tmp, 'posts', name)
  fs.writeFileSync(f, JSON.stringify(spec))
  return f
}

test('approved-only: media, cover and caption files must be inside approvedDirs', () => {
  fs.writeFileSync(path.join(approved, 'v.mp4'), 'approved video')
  fs.writeFileSync(path.join(drafts, 'v.mp4'), 'draft video')
  fs.writeFileSync(path.join(drafts, 'cap.txt'), 'draft caption')
  fs.writeFileSync(path.join(approved, 'cap.txt'), 'approved caption')
  const ok = write('ok.json', { brand: 'b1', media: path.join(approved, 'v.mp4'), captionFile: path.join(approved, 'cap.txt'), platforms: { youtube: { title: 'T' } } })
  assert.equal(loadSpec(ok, { approvedOnly: true }).caption, 'approved caption')

  const draft = write('d.json', { brand: 'b1', media: path.join(drafts, 'v.mp4'), platforms: { youtube: {} } })
  assert.throws(() => loadSpec(draft, { approvedOnly: true }), /not in an approved folder/)
  assert.ok(loadSpec(draft), 'without the flag the CLI is unchanged')

  const cap = write('c.json', { brand: 'b1', media: path.join(approved, 'v.mp4'), captionFile: path.join(drafts, 'cap.txt'), platforms: { youtube: {} } })
  assert.throws(() => loadSpec(cap, { approvedOnly: true }), /cap\.txt is not in an approved folder/)
  const capPer = write('c2.json', { brand: 'b1', caption: 'x', media: path.join(approved, 'v.mp4'), platforms: { youtube: { captionFile: path.join(drafts, 'cap.txt') } } })
  assert.throws(() => loadSpec(capPer, { approvedOnly: true }), /not in an approved folder/)

  // a symlink inside the approved folder that points at a draft is judged by its target
  fs.symlinkSync(path.join(drafts, 'v.mp4'), path.join(approved, 'link.mp4'))
  const link = write('l.json', { brand: 'b1', media: path.join(approved, 'link.mp4'), platforms: { youtube: {} } })
  assert.throws(() => loadSpec(link, { approvedOnly: true }), /not in an approved folder/)

  const noDirs = write('n.json', { brand: 'b2', caption: 'x', platforms: { youtube: {} } })
  assert.throws(() => loadSpec(noDirs, { approvedOnly: true }), /no approvedDirs/)
})

test('approved-only: files are read once; swapping them after the check changes nothing', () => {
  fs.writeFileSync(path.join(approved, 'a.mp4'), 'checked bytes')
  fs.writeFileSync(path.join(approved, 'a.txt'), 'checked caption')
  fs.writeFileSync(path.join(approved, 'yt.txt'), 'checked youtube caption')
  const f = write('swap.json', { brand: 'b1', media: path.join(approved, 'a.mp4'), captionFile: path.join(approved, 'a.txt'), platforms: { youtube: { title: 'T', captionFile: path.join(approved, 'yt.txt') } } })
  const spec = loadSpec(f, { approvedOnly: true })
  // swap everything after the check
  fs.writeFileSync(path.join(approved, 'a.mp4'), 'SWAPPED')
  fs.rmSync(path.join(approved, 'a.txt'))
  fs.symlinkSync(path.join(drafts, 'cap.txt'), path.join(approved, 'a.txt'))
  fs.writeFileSync(path.join(approved, 'yt.txt'), 'SWAPPED')
  assert.notEqual(spec.media[0].path, path.join(approved, 'a.mp4'), 'uploads use a private copy')
  assert.equal(fs.readFileSync(spec.media[0].path, 'utf8'), 'checked bytes')
  assert.equal(spec.caption, 'checked caption')
  assert.equal(baseFields(spec, 'youtube').caption, 'checked youtube caption')
})

test('approved-only: the CLI flag refuses a draft before anything is posted', () => {
  const draft = write('cli.json', { brand: 'b1', media: path.join(drafts, 'v.mp4'), title: 'T', platforms: { youtube: {} } })
  let out = ''
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'social.mjs'), 'post', draft, '--approved-only', '--dry-run'], { env: process.env, stdio: 'pipe' })
  } catch (e) {
    out = `${e.stdout}${e.stderr}`
  }
  assert.match(out, /not in an approved folder/)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
