import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { loadApps, paths } from './config.mjs'
import { signV4 } from './sigv4.mjs'
import { mimeOf } from './util.mjs'

const run = promisify(execFile)
const TMP = path.join(os.tmpdir(), 'social-publisher')

export const blobOf = (file) => fs.openAsBlob(file, { type: mimeOf(file) })

/** Instagram only takes JPEG images; YouTube thumbnails must be under 2 MB. Uses macOS sips. */
export async function toJpeg(file, { maxBytes } = {}) {
  if (mimeOf(file) === 'image/jpeg' && (!maxBytes || fs.statSync(file).size <= maxBytes)) return file
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, crypto.createHash('sha1').update(file).digest('hex').slice(0, 12) + '.jpg')
  for (const q of [92, 85, 75, 65]) {
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), file, '--out', out])
    if (!maxBytes || fs.statSync(out).size <= maxBytes) return out
  }
  throw new Error(`${path.basename(file)} is still over ${Math.round(maxBytes / 1e6)} MB as a JPEG`)
}

/**
 * Some APIs (Instagram images, carousels and Reel covers) fetch media from a
 * public URL instead of taking an upload. The host puts a file there for a few
 * minutes and removes it after the post.
 */
export function getHost() {
  const cfg = loadApps().mediaHost
  if (!cfg?.type || !cfg.bucket) return null
  if (cfg.type === 'r2') return r2Host(cfg)
  throw new Error(`Unknown mediaHost.type "${cfg.type}" in ${paths.apps}`)
}

export function requireHost(why) {
  const h = getHost()
  if (!h) throw new Error(`${why} needs a public media host. Set "mediaHost" in ${paths.apps} (docs/SETUP-R2.md).`)
  return h
}

function r2Host(cfg) {
  const need = ['accountId', 'accessKeyId', 'secretAccessKey', 'publicBaseUrl'].filter((k) => !cfg[k])
  if (need.length) throw new Error(`mediaHost is missing ${need.join(', ')} in ${paths.apps} (docs/SETUP-R2.md)`)
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`
  const creds = { region: 'auto', service: 's3', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
  const keys = []
  const call = async (method, key, body, type) => {
    const url = `${endpoint}/${key}`
    const headers = signV4({ method, url, headers: type ? { 'content-type': type } : {}, ...creds })
    const res = await fetch(url, { method, headers, body })
    if (!res.ok) throw new Error(`R2 ${method} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return {
    async put(file) {
      const key = `social/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path
        .basename(file)
        .replace(/[^\w.-]+/g, '-')}`
      await call('PUT', key, await blobOf(file), mimeOf(file))
      keys.push(key)
      return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`
    },
    async cleanup() {
      for (const key of keys.splice(0))
        await call('DELETE', key).catch((e) => console.warn(`  (could not delete ${key} from R2: ${e.message})`))
    },
  }
}
