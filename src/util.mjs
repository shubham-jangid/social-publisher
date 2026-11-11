import os from 'node:os'
import path from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BOOLEAN_FLAGS = new Set(['dry-run', 'force', 'manual', 'json', 'help', 'refresh', 'all', 'approved-only'])

export function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { pos, flags }
}

export const list = (v) =>
  v === undefined || v === true
    ? undefined
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

export function expandHome(p) {
  if (!p) return p
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

const MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function mimeOf(file) {
  const m = MIME[path.extname(file).toLowerCase()]
  if (!m) throw new Error(`Unsupported file type: ${file} (use mp4/mov/webm or jpg/png/webp)`)
  return m
}

export const kindOf = (file) => (mimeOf(file).startsWith('video/') ? 'video' : 'image')

// ---- time -------------------------------------------------------------------

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * "now" / empty → null. ISO with Z or an offset → that instant.
 * "2026-11-05 18:30" → that wall-clock time in `tz`.
 */
export function parseWhen(s, tz = process.env.SOCIAL_DEFAULT_TZ || 'UTC') {
  if (s === undefined || s === null || s === '' || s === 'now' || s === true) return null
  if (s instanceof Date) return s
  const str = String(s).trim()
  if (/(z|[+-]\d\d:?\d\d)$/i.test(str)) {
    const d = new Date(str)
    if (Number.isNaN(d.getTime())) throw new Error(`Can't read time "${str}"`)
    return d
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`Can't read time "${str}". Use "2026-11-05 18:30" (brand time zone) or ISO with an offset.`)
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  let t = guess - tzOffsetMs(guess, tz)
  t = guess - tzOffsetMs(t, tz)
  return new Date(t)
}

export function fmtWhen(d, tz = process.env.SOCIAL_DEFAULT_TZ || 'UTC') {
  if (!d) return 'now'
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d) + ` (${tz})`
  )
}

export function preview(text, n = 140) {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export function truncateWords(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…'
}
