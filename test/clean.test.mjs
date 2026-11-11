// Metadata stripping: C2PA / XMP / EXIF leave, pixels stay.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'
import { cleanCopy, cleanJpeg, cleanPng, markersIn } from '../src/clean.mjs'

function crc32(buf) {
  let c, crc = 0xffffffff
  for (const b of buf) {
    c = (crc ^ b) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(extra) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

test('PNG: C2PA (caBX) and text chunks go, image chunks stay byte for byte', () => {
  const c2pa = chunk('caBX', Buffer.from('jumb c2pa OpenAI ChatGPT trainedAlgorithmicMedia'))
  const text = chunk('tEXt', Buffer.from('Software\0ChatGPT'))
  const srgb = chunk('sRGB', Buffer.from([0]))
  const out = cleanPng(png([c2pa, text, srgb]))
  assert.deepEqual(out, png([srgb]))
})

test('JPEG: APP1 (EXIF/XMP), APP11 (C2PA), COM go; APP0, APP2 and the scan stay', () => {
  const seg = (m, s) => Buffer.concat([Buffer.from([0xff, m]), Buffer.from([0, s.length + 2]), Buffer.from(s)])
  const scan = Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])
  const keep = [seg(0xe0, 'JFIF\0'), seg(0xe2, 'ICC_PROFILE\0')]
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), keep[0], seg(0xe1, 'Exif xmp trainedAlgorithmicMedia'), seg(0xeb, 'JP jumb c2pa'), seg(0xfe, 'made by AI'), keep[1], scan])
  assert.deepEqual(cleanJpeg(jpg), Buffer.concat([Buffer.from([0xff, 0xd8]), ...keep, scan]))
})

test('cleanCopy leaves the original untouched and returns a clean copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'))
  const f = path.join(dir, 'x.png')
  const orig = png([chunk('caBX', Buffer.from('c2pa jumb'))])
  fs.writeFileSync(f, orig)
  const out = cleanCopy(f)
  assert.notEqual(out, f)
  assert.deepEqual(fs.readFileSync(f), orig, 'original unchanged')
  assert.deepEqual(markersIn(out), [])
  const t = path.join(dir, 'notes.txt'); fs.writeFileSync(t, 'hi'); assert.equal(cleanCopy(t), t, 'other types pass through')
})
