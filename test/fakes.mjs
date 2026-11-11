// Fake Cloudflare D1 (node:sqlite) and R2 for running cloud/worker.mjs in Node.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let sqlite
try {
  sqlite = await import('node:sqlite')
} catch {}
export const hasSqlite = !!sqlite

globalThis.FixedLengthStream ??= class {
  constructor() {
    return new TransformStream()
  }
}

// ---- fake D1 -----------------------------------------------------------------
export function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(ROOT, 'cloud', 'schema.sql'), 'utf8'))
  const prep = (sql) => {
    const st = db.prepare(sql)
    let args = []
    const api = {
      bind: (...a) => {
        args = a.map((x) => (x === undefined ? null : x))
        // Real D1 caps LIKE/GLOB patterns at 50 bytes (SQLite's default is 50,000).
        if (/\b(LIKE|GLOB)\b/i.test(sql) && args.some((x) => typeof x === 'string' && Buffer.byteLength(x) > 50))
          throw new Error('D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR')
        return api
      },
      all: async () => ({ results: st.all(...args) }),
      first: async () => st.get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
    }
    return api
  }
  return { prepare: prep, batch: async (stmts) => Promise.all(stmts.map((s) => s.run())), raw: db }
}

// ---- fake R2 -----------------------------------------------------------------
export function fakeR2() {
  const objects = new Map()
  const uploads = new Map()
  const parseRange = (range, size) => {
    if (!range) return null
    if (range instanceof Headers) {
      const m = /bytes=(\d*)-(\d*)/.exec(range.get('range') || '')
      if (!m) return null
      const start = Number(m[1])
      const end = m[2] ? Number(m[2]) : size - 1
      return { offset: start, length: end - start + 1 }
    }
    return { offset: range.offset ?? 0, length: range.length ?? size - (range.offset ?? 0) }
  }
  const obj = (key, o, range) => {
    const bytes = range ? o.bytes.subarray(range.offset, range.offset + range.length) : o.bytes
    return {
      key,
      size: o.bytes.length,
      range: range || undefined,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      writeHttpMetadata: (h) => h.set('content-type', o.type),
    }
  }
  return {
    objects,
    put: (key, bytes, type) => objects.set(key, { bytes: new Uint8Array(bytes), type }),
    head: async (key) => (objects.has(key) ? obj(key, objects.get(key)) : null),
    get: async (key, opts = {}) => {
      const o = objects.get(key)
      return o ? obj(key, o, parseRange(opts.range, o.bytes.length)) : null
    },
    delete: async (key) => objects.delete(key),
    createMultipartUpload: async (key, { httpMetadata }) => {
      const id = `u${uploads.size + 1}`
      uploads.set(id, { key, type: httpMetadata.contentType, parts: new Map() })
      return { key, uploadId: id }
    },
    resumeMultipartUpload: (key, id) => ({
      uploadPart: async (n, ab) => {
        uploads.get(id).parts.set(n, new Uint8Array(ab))
        return { partNumber: n, etag: `e${n}` }
      },
      complete: async (parts) => {
        const u = uploads.get(id)
        const chunks = parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => u.parts.get(p.partNumber))
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let o = 0
        for (const c of chunks) all.set(c, (o += c.length) - c.length)
        objects.set(key, { bytes: all, type: u.type })
        return { key, size: all.length }
      },
      abort: async () => uploads.delete(id),
    }),
  }
}

