import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadBrand, assertPublishing } from './config.mjs'
import { insertBeforeHashtags, tagLink } from './text.mjs'
import { expandHome, kindOf, mimeOf, parseWhen } from './util.mjs'
import { cleanCopy } from './clean.mjs'

export const PLATFORM_NAMES = ['facebook', 'instagram', 'youtube', 'pinterest', 'linkedin']

// ---- approved folders --------------------------------------------------------------------
// A brand's approvedDirs hold finished, owner-approved files. Posts made through the MCP
// server (and `social post --approved-only`) may only use media, covers and caption files
// from there.

export function realPath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

export const approvedDirsOf = (brand) => (brand.approvedDirs || []).map((d) => realPath(expandHome(d)))

/** Whether a file (after following symlinks) sits inside one of the folders. */
export const insideAny = (file, dirs) => {
  const f = realPath(file)
  return dirs.some((d) => f === d || f.startsWith(d + path.sep))
}

/** Every caption file a spec names: the main one and each platform's. */
export const captionFilesOf = (raw) =>
  [raw.captionFile, ...Object.values(raw.platforms || {}).map((v) => (v && typeof v === 'object' ? v.captionFile : undefined))].filter(
    (x) => typeof x === 'string' && x,
  )

/** Reasons a spec may not go out through MCP (empty = fine). Takes a spec loaded with keepMetadata. */
export function approvalProblems(spec) {
  const dirs = approvedDirsOf(spec.brand)
  if (!dirs.length) return [`brand "${spec.brand.key}" has no approvedDirs in its brand file, so nothing can be scheduled through MCP`]
  const files = [...spec.media.map((m) => m.source || m.path), spec.cover?.source || spec.cover?.path, ...captionFilesOf(spec.raw).map((f) => path.resolve(spec.dir, expandHome(f)))].filter(Boolean)
  return files
    .filter((f) => !insideAny(f, dirs))
    .map((f) => `${f} is not in an approved folder (${dirs.join(', ')}). Move the approved file there first.`)
}

/** A private copy of a checked file, so what is uploaded is exactly what was checked. */
function snapshot(file) {
  const dir = path.join(os.tmpdir(), 'social-publisher', 'approved', crypto.randomBytes(8).toString('hex'))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const out = path.join(dir, path.basename(file))
  fs.copyFileSync(file, out, fs.constants.COPYFILE_FICLONE) // instant clone on APFS
  return out
}

/**
 * A post spec is a JSON file next to (or pointing at) the media:
 * {
 *   "brand": "example",
 *   "media": "reel.mp4"              // or ["1.jpg","2.jpg"]; none = text post
 *   "cover": "cover.png",
 *   "captionFile": "caption.txt",   // or "caption"
 *   "title": "…", "link": "https://example.com/…", "tags": [], "ai": true,
 *   "at": "2026-11-05 18:30",       // brand time zone, or ISO; omit = now
 *   "platforms": { "facebook": {}, "instagram": {}, "youtube": { "title": "…" } }
 * }
 * Paths are relative to the spec file.
 *
 * opts.approvedOnly: every media file, cover and caption file must be inside the brand's
 * approvedDirs. Each file is checked, then copied once, and only that copy is used, so a
 * file swapped after the check is never posted. Caption files are read once, here.
 */
export function loadSpec(file, opts = {}) {
  const abs = path.resolve(expandHome(file))
  if (!fs.existsSync(abs)) throw new Error(`No such post spec: ${abs}`)
  const dir = path.dirname(abs)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch (e) {
    throw new Error(`${abs} is not valid JSON: ${e.message}`)
  }
  if (!raw.brand) throw new Error(`${abs}: "brand" is required`)
  const brand = loadBrand(raw.brand)
  assertPublishing(brand)
  const approved = opts.approvedOnly ? approvedDirsOf(brand) : null
  if (approved && !approved.length) throw new Error(`brand "${brand.key}" has no approvedDirs, so nothing can be posted with --approved-only`)

  const resolveFile = (p) => {
    if (typeof p !== 'string' || !p) throw new Error(`${path.basename(abs)}: a file path must be a non-empty string`)
    const f = path.resolve(dir, expandHome(p))
    if (!fs.existsSync(f)) throw new Error(`${path.basename(abs)}: file not found: ${f}`)
    if (!approved) return f
    const real = realPath(f) // a symlink is judged (and read) by where it points
    if (!insideAny(real, approved)) throw new Error(`${f} is not in an approved folder (${approved.join(', ')}). Not posted.`)
    return real
  }
  // Every upload uses a metadata-free copy (src/clean.mjs); `source` keeps the owner's file.
  const info = (p) => {
    const f = resolveFile(p)
    const own = approved ? snapshot(f) : f
    const clean = opts.keepMetadata ? own : cleanCopy(own)
    return { path: clean, source: f, name: path.basename(f), mime: mimeOf(f), kind: kindOf(f), size: fs.statSync(clean).size }
  }
  const texts = new Map()
  const readText = (p) => {
    if (!texts.has(p)) texts.set(p, fs.readFileSync(resolveFile(p), 'utf8').trim())
    return texts.get(p)
  }
  if (approved) for (const p of captionFilesOf(raw)) readText(p) // checked and read now, before anything is posted

  const media = [].concat(raw.media || []).map(info)
  const videos = media.filter((m) => m.kind === 'video')
  if (videos.length > 1 || (videos.length && media.length > 1))
    throw new Error(`${path.basename(abs)}: use either one video or a set of images, not both`)
  if (media.length > 20) throw new Error(`${path.basename(abs)}: at most 20 images`)
  const cover = raw.cover ? info(raw.cover) : null
  if (cover && cover.kind !== 'image') throw new Error('"cover" must be an image')

  const entries = raw.platforms
    ? Object.entries(raw.platforms).filter(([, v]) => v !== false && v !== null)
    : (brand.defaults?.platforms || []).map((p) => [p, {}])
  for (const [p] of entries) if (!PLATFORM_NAMES.includes(p)) throw new Error(`Unknown platform "${p}"`)
  if (!entries.length) throw new Error(`${path.basename(abs)}: no platforms (set "platforms" or brand defaults.platforms)`)

  return {
    file: abs,
    dir,
    id: raw.id || path.basename(abs).replace(/\.json$/i, ''),
    brand,
    raw,
    media,
    cover,
    kind: !media.length ? 'text' : videos.length ? 'video' : media.length > 1 ? 'images' : 'image',
    title: raw.title,
    caption: raw.caption ?? (raw.captionFile ? readText(raw.captionFile) : ''),
    link: raw.link,
    tags: raw.tags || [],
    ai: !!raw.ai,
    alt: raw.alt,
    campaign: raw.campaign,
    at: parseWhen(raw.at, brand.timezone),
    platforms: Object.fromEntries(entries.map(([k, v]) => [k, v === true ? {} : v])),
    readText,
    info,
  }
}

export const resultsPath = (spec) => spec.file.replace(/\.json$/i, '') + '.result.json'

/** Caption, link and title for one platform, after overrides, UTM tagging and the AI line. */
export function baseFields(spec, platform, { aiLabel = false } = {}) {
  const opts = spec.platforms[platform] || {}
  let caption = opts.caption ?? (opts.captionFile ? spec.readText(opts.captionFile) : spec.caption) ?? ''
  const link = tagLink(opts.link ?? spec.link, { platform, brand: spec.brand, spec })
  caption = caption.replaceAll('{link}', link || '')
  const warnings = []
  const line = spec.brand.aiDisclosure
  if (spec.ai && !aiLabel) {
    if (line && !caption.toLowerCase().includes(line.replace(/[.\s]+$/, '').toLowerCase())) {
      caption = insertBeforeHashtags(caption, line)
      warnings.push(`${platform} has no AI label in its API, so "${line}" was added to the caption`)
    } else if (!line) warnings.push(`${platform} has no AI label in its API and the brand has no aiDisclosure line`)
  }
  return { opts, caption, link, title: opts.title ?? spec.title, warnings }
}
