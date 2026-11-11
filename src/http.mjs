import { sleep } from './util.mjs'

const SECRET_PARAMS = ['access_token', 'client_secret', 'fb_exchange_token', 'input_token', 'refresh_token', 'code']

export function redact(u) {
  const url = new URL(String(u))
  for (const k of SECRET_PARAMS) if (url.searchParams.has(k)) url.searchParams.set(k, '***')
  return url.toString()
}

function describe(d) {
  if (d === null || d === undefined || d === '') return 'empty response'
  if (typeof d === 'string') return d.slice(0, 500)
  const e = d.error
  if (e && typeof e === 'object') {
    return (
      [
        e.message,
        e.error_user_title,
        e.error_user_msg,
        e.code && `code ${e.code}`,
        e.error_subcode && `subcode ${e.error_subcode}`,
        e.errors?.[0]?.reason,
        e.status,
      ]
        .filter(Boolean)
        .join(' · ') || JSON.stringify(e).slice(0, 500)
    )
  }
  if (typeof e === 'string') return [e, d.error_description].filter(Boolean).join(' – ')
  return String(d.message || d.error_description || JSON.stringify(d)).slice(0, 500)
}

export class ApiError extends Error {
  constructor(platform, status, data, url) {
    super(`${platform} API ${status}: ${describe(data)}`)
    Object.assign(this, { platform, status, data, url })
  }
}

const backoff = (attempt) => Math.min(30_000, 1500 * 2 ** attempt)

function encode(v) {
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/**
 * fetch wrapper.
 * - `query` / `form` objects skip undefined/null values; objects are JSON-encoded.
 * - Only GETs are retried by default: a retried POST could publish twice.
 * - `raw: true` returns { status, headers, data }.
 */
export async function request(platform, url, opts = {}) {
  const { method = 'GET', headers = {}, query, json, form, body, raw = false } = opts
  const retries = opts.retries ?? (method === 'GET' ? 3 : 0)
  const u = new URL(url)
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, encode(v))

  let reqBody = body
  const h = { ...headers }
  if (json !== undefined) {
    reqBody = JSON.stringify(json)
    h['Content-Type'] ??= 'application/json'
  } else if (form) {
    reqBody = new URLSearchParams(
      Object.entries(form)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, encode(v)]),
    )
  }

  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(u, { method, headers: h, body: reqBody })
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoff(attempt))
        continue
      }
      throw new Error(`${platform}: network error calling ${redact(u)}: ${err.cause?.message || err.message}`)
    }
    const text = await res.text()
    let data = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    if (res.ok) return raw ? { status: res.status, headers: res.headers, data } : data
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'))
      await sleep(ra > 0 ? ra * 1000 : backoff(attempt))
      continue
    }
    throw new ApiError(platform, res.status, data, redact(u))
  }
}

export async function poll(label, fn, { interval = 5000, timeout = 15 * 60_000 } = {}) {
  const start = Date.now()
  for (;;) {
    const r = await fn()
    if (r) return r
    if (Date.now() - start > timeout) throw new Error(`${label}: still not ready after ${Math.round(timeout / 60000)} min`)
    await sleep(interval)
  }
}
