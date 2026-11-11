// Minimal AWS Signature V4 (header auth) for S3-compatible storage such as Cloudflare R2.
import crypto from 'node:crypto'

const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest()
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export const EMPTY_SHA256 = sha256hex('')

/**
 * Returns the headers to send (including Authorization).
 * `headers` are extra headers to sign (lowercase names); host and x-amz-* are added.
 */
export function signV4({ method, url, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD', region, service, accessKeyId, secretAccessKey, date = new Date() }) {
  const u = new URL(url)
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const all = { ...headers, host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))
  const canonicalHeaders = names.map((k) => `${k}:${lower[k]}\n`).join('')
  const signedHeaders = names.join(';')
  const path = u.pathname.split('/').map((p) => rfc3986(decodeURIComponent(p))).join('/')
  const query = [...u.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  const out = { ...all }
  delete out.host
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return out
}
