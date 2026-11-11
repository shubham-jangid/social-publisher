import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_DIR = process.env.SOCIAL_CONFIG_DIR || path.join(os.homedir(), '.config', 'social-publisher')
export const BRANDS_DIR = process.env.SOCIAL_BRANDS_DIR || path.join(ROOT, 'brands')
/** Time zone for brands whose file has no "timezone". */
export const DEFAULT_TZ = process.env.SOCIAL_DEFAULT_TZ || 'UTC'

export const paths = {
  apps: path.join(CONFIG_DIR, 'apps.json'),
  tokens: path.join(CONFIG_DIR, 'tokens.json'),
  queue: path.join(CONFIG_DIR, 'queue.json'),
  lock: path.join(CONFIG_DIR, 'queue.lock'),
  history: path.join(CONFIG_DIR, 'history.jsonl'),
  runnerLog: path.join(CONFIG_DIR, 'runner.log'),
}

export const APPS_TEMPLATE = {
  redirectUri: 'http://localhost:8585/callback',
  meta: { appId: '', appSecret: '', configId: '', graphVersion: 'v24.0' },
  google: { clientId: '', clientSecret: '' },
  pinterest: { appId: '', appSecret: '', sandbox: false },
  linkedin: {
    default: { clientId: '', clientSecret: '', version: '202610', scopes: ['w_organization_social', 'r_organization_social'] },
  },
  mediaHost: { type: 'r2', accountId: '', bucket: 'social-media-temp', accessKeyId: '', secretAccessKey: '', publicBaseUrl: '' },
  cloud: { url: '', apiToken: '' },
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(fallback)
    throw new Error(`Could not read ${file}: ${e.message}`)
  }
}

/** Atomic write, owner-only permissions (these files hold tokens). */
export function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function initConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const created = !fs.existsSync(paths.apps)
  if (created) writePrivate(paths.apps, APPS_TEMPLATE)
  return { created, file: paths.apps }
}

export const loadApps = () => readJson(paths.apps, {})

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== ''

/** getApp('meta') or getApp('linkedin', 'default'). Throws with the fields still empty. */
export function getApp(name, sub) {
  const apps = loadApps()
  let app = apps[name]
  if (sub) app = app?.[sub]
  const need = {
    meta: ['appId', 'appSecret'],
    google: ['clientId', 'clientSecret'],
    pinterest: ['appId', 'appSecret'],
    linkedin: ['clientId', 'clientSecret'],
  }[name] || []
  const missing = need.filter((k) => !filled(app?.[k]))
  if (!app || missing.length) {
    const where = sub ? `${name}.${sub}` : name
    throw new Error(
      `${where} app is not set up in ${paths.apps} (missing: ${missing.join(', ') || 'whole block'}). ` +
        `See docs/SETUP-${name === 'google' ? 'YOUTUBE' : name.toUpperCase()}.md`,
    )
  }
  return { redirectUri: apps.redirectUri || APPS_TEMPLATE.redirectUri, ...app }
}

export const loadTokens = () => readJson(paths.tokens, {})

export function saveTokens(mutator) {
  const t = loadTokens()
  mutator(t)
  writePrivate(paths.tokens, t)
  return t
}

// ---- brands -----------------------------------------------------------------

export function listBrands() {
  if (!fs.existsSync(BRANDS_DIR)) return []
  return fs
    .readdirSync(BRANDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
}

/** Brands with "publishing": false in their brand file are never posted to, by any path. */
export function assertPublishing(brand) {
  if (brand.publishing === false)
    throw new Error(
      `Publishing to ${brand.name || brand.key} is switched off (brands/${brand.key}.json → "publishing": false). ` +
        'Set it to true (or remove it) to post for this brand again.',
    )
}

/**
 * Whether a saved Meta Page belongs to a brand that is switched on (by Page id or name, or by
 * its linked Instagram). Pages of switched-off brands (unless view-only), or of no brand, are never sent to the cloud.
 */
export function metaPageAllowed(id, page = {}) {
  return listBrands().some((k) => {
    const b = loadBrand(k)
    // View-only brands ("calendar": true) send read access so the dashboard can list their posts.
    // The Worker still refuses every post for them (BLOCKED_BRANDS).
    if (b.publishing === false && b.calendar !== true) return false
    const fb = b.facebook || {}
    const ig = b.instagram || {}
    return (
      (fb.pageId && String(fb.pageId) === String(id)) ||
      (fb.pageName && fb.pageName === page.name) ||
      (ig.userId && String(ig.userId) === String(page.igUserId)) ||
      (ig.username && ig.username === page.igUsername)
    )
  })
}

export function loadBrand(key) {
  const file = path.join(BRANDS_DIR, `${key}.json`)
  if (!fs.existsSync(file)) throw new Error(`Unknown brand "${key}". Known: ${listBrands().join(', ')}`)
  const b = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { timezone: DEFAULT_TZ, ...b, key, file }
}

/**
 * A brand's block for one platform. Supports several accounts per platform:
 *   "youtube": { "default": "main", "accounts": { "main": {...}, "second": {...} } }
 */
export function platformCfg(brand, platform, accountName) {
  assertPublishing(brand)
  const c = brand[platform]
  if (!c) throw new Error(`${brand.key} has no "${platform}" block in brands/${brand.key}.json`)
  if (!c.accounts) return { ...c, accountName: accountName || 'main' }
  const name = accountName || c.default || Object.keys(c.accounts)[0]
  const a = c.accounts[name]
  if (!a) throw new Error(`${brand.key}.${platform} has no account "${name}" (have: ${Object.keys(c.accounts).join(', ')})`)
  const { accounts, default: _d, ...shared } = c
  return { ...shared, ...a, accountName: name }
}
