// Removes metadata (C2PA / Content Credentials, XMP, EXIF, IPTC, text chunks) from media
// before it is uploaded anywhere. The owner's original file is never touched: a cleaned copy
// is written to the temp folder and used instead, so every image and video goes out without
// provenance metadata (camera data, editing history, AI-tool records). This does not change the explicit
// disclosures a brand chooses (YouTube's synthetic-media flag, a brand's aiDisclosure line).
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = path.join(os.tmpdir(), 'social-publisher', 'clean')
const MARKERS = ['c2pa', 'jumb', 'trainedalgorithmicmedia', 'contentauth']

// PNG chunks that carry pixels or colour; everything else (caBX = C2PA, tEXt, iTXt, zTXt, eXIf…) goes.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT'])
// JPEG segments to drop: APP1 (EXIF, XMP), APP11 (JUMBF / C2PA), APP13 (IPTC), COM.
const JPEG_DROP = new Set([0xe1, 0xeb, 0xed, 0xfe])

export function cleanPng(buf) {
  const sig = buf.subarray(0, 8)
  const parts = [sig]
  let i = 8
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, end))
    i = end
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

export function cleanJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG')
  const parts = [buf.subarray(0, 2)]
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad JPEG segment')
    const marker = buf[i + 1]
    if (marker === 0xda) {
      parts.push(buf.subarray(i)) // start of scan: the rest is image data
      return Buffer.concat(parts)
    }
    const len = buf.readUInt16BE(i + 2)
    if (!JPEG_DROP.has(marker)) parts.push(buf.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return Buffer.concat(parts)
}

/** Lists provenance markers left in a file (empty = clean). Large videos: first and last 64 MB. */
export function markersIn(file) {
  const size = fs.statSync(file).size
  const LIMIT = 128 * 1024 * 1024
  let text
  if (size <= LIMIT) text = fs.readFileSync(file).toString('latin1')
  else {
    const fd = fs.openSync(file, 'r')
    const a = Buffer.alloc(LIMIT / 2)
    const b = Buffer.alloc(LIMIT / 2)
    fs.readSync(fd, a, 0, a.length, 0)
    fs.readSync(fd, b, 0, b.length, size - b.length)
    fs.closeSync(fd)
    text = a.toString('latin1') + b.toString('latin1')
  }
  const low = text.toLowerCase()
  return MARKERS.filter((m) => low.includes(m))
}

/**
 * Returns the path of a metadata-free copy of `file` (cached per file content).
 * Images: PNG/JPEG by removing chunks/segments (pixels untouched). Videos: ffmpeg re-pack
 * without metadata (no re-encode). Other types are returned as they are.
 */
export function cleanCopy(file) {
  if (process.env.SOCIAL_NO_CLEAN === '1') return file // tests with fake media only
  const ext = path.extname(file).toLowerCase()
  const kind = ['.png'].includes(ext) ? 'png' : ['.jpg', '.jpeg'].includes(ext) ? 'jpeg' : ['.mp4', '.mov', '.m4v'].includes(ext) ? 'video' : null
  if (!kind) return file
  const st = fs.statSync(file)
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  const dir = path.join(OUT, key)
  const out = path.join(dir, path.basename(file))
  if (fs.existsSync(out)) return out
  fs.mkdirSync(dir, { recursive: true })
  const tmp = out + '.part'
  if (kind === 'video') {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', '-fflags', '+bitexact', '-movflags', '+faststart', '-f', ext === '.mov' ? 'mov' : 'mp4', tmp])
  } else {
    const buf = fs.readFileSync(file)
    fs.writeFileSync(tmp, kind === 'png' ? cleanPng(buf) : cleanJpeg(buf))
  }
  const left = markersIn(tmp)
  if (left.length) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`${path.basename(file)}: metadata still present after cleaning (${left.join(', ')})`)
  }
  fs.renameSync(tmp, out)
  return out
}
