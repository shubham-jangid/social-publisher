import fs from 'node:fs'
import { getApp, loadBrand, loadTokens, platformCfg, saveTokens } from '../config.mjs'
import { request, poll } from '../http.mjs'
import { blobOf } from '../media.mjs'
import { newState, waitForCode } from '../oauth.mjs'
import { baseFields } from '../spec.mjs'
import { truncateWords } from '../util.mjs'

const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read']
const apiBase = (app) => (app.sandbox ? 'https://api-sandbox.pinterest.com/v5' : 'https://api.pinterest.com/v5')

export default {
  name: 'pinterest',
  aiLabel: false,

  plan(spec) {
    const f = baseFields(spec, 'pinterest', { aiLabel: false })
    if (spec.kind === 'text') throw new Error('pinterest needs a video or images')
    if (spec.kind === 'video' && !spec.cover) f.warnings.push('no cover image: Pinterest uses a frame from the video')
    const cfg = platformCfg(spec.brand, 'pinterest', f.opts.account)
    const boardRef = f.opts.board ?? cfg.defaultBoard
    if (!boardRef) throw new Error(`pinterest needs a board (platforms.pinterest.board or pinterest.defaultBoard in the brand)`)
    const board = cfg.boards?.[boardRef] ?? boardRef
    let title = (f.title || f.caption.split('\n')[0] || '').trim()
    if (title.length > 100) title = truncateWords(title, 100)
    let description = f.opts.description ?? f.caption
    if (description.length > 800) {
      description = truncateWords(description, 800)
      f.warnings.push('pinterest description cut to 800 characters')
    }
    const link = f.link ?? cfg.defaultLink
    return { ...f, account: f.opts.account, username: cfg.username, board, title, description, link }
  },

  canSchedule: () => false,

  async cloud({ spec, plan }) {
    const cfg = platformCfg(spec.brand, 'pinterest', plan.account)
    const { token, base } = await session(spec.brand, plan.account)
    const boardId = await resolveBoard(plan.board, base, { Authorization: `Bearer ${token}` })
    return {
      job: {
        kind: spec.kind,
        title: plan.title,
        description: plan.description,
        link: plan.link,
        alt: spec.alt,
        boardId,
        base,
        sandbox: !!loadApp().sandbox,
        tokenRef: `pinterest:${cfg.username}`,
        appRef: 'app:pinterest',
      },
      media: spec.media.map((m) => m.path),
      cover: spec.cover?.path || null,
    }
  },

  async publish({ spec, plan }) {
    const { token, base } = await session(spec.brand, plan.account)
    const auth = { Authorization: `Bearer ${token}` }
    const boardId = await resolveBoard(plan.board, base, auth)
    let media_source

    if (spec.kind === 'video') {
      const reg = await request('pinterest', `${base}/media`, { method: 'POST', headers: auth, json: { media_type: 'video' } })
      const fd = new FormData()
      for (const [k, v] of Object.entries(reg.upload_parameters || {})) fd.append(k, v)
      fd.append('file', await blobOf(spec.media[0].path), spec.media[0].name)
      const up = await fetch(reg.upload_url, { method: 'POST', body: fd })
      if (!up.ok) throw new Error(`pinterest video upload failed: ${up.status} ${(await up.text()).slice(0, 300)}`)
      await poll(
        'pinterest video processing',
        async () => {
          const s = await request('pinterest', `${base}/media/${reg.media_id}`, { headers: auth })
          if (s.status === 'failed') throw new Error('pinterest could not process the video')
          return s.status === 'succeeded'
        },
        { interval: 5000, timeout: 15 * 60_000 },
      )
      media_source = { source_type: 'video_id', media_id: reg.media_id }
      if (spec.cover) {
        media_source.cover_image_content_type = spec.cover.mime
        media_source.cover_image_data = b64(spec.cover.path)
      } else media_source.cover_image_key_frame_time = 1
    } else if (spec.kind === 'image') {
      media_source = { source_type: 'image_base64', content_type: spec.media[0].mime, data: b64(spec.media[0].path) }
    } else {
      media_source = {
        source_type: 'multiple_image_base64',
        items: spec.media.map((m) => ({ content_type: m.mime, data: b64(m.path) })),
      }
    }

    const pin = await request('pinterest', `${base}/pins`, {
      method: 'POST',
      headers: auth,
      json: {
        board_id: boardId,
        title: plan.title || undefined,
        description: plan.description || undefined,
        link: plan.link || undefined,
        alt_text: spec.alt || undefined,
        media_source,
      },
    })
    const note = loadApp().sandbox ? 'posted to the Pinterest SANDBOX (trial access): not public' : undefined
    return { status: 'published', id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}/`, note }
  },

  async check(brand, account) {
    const cfg = platformCfg(brand, 'pinterest', account)
    const { token, base } = await session(brand, account)
    const me = await request('pinterest', `${base}/user_account`, { headers: { Authorization: `Bearer ${token}` } })
    if (cfg.username && me.username?.toLowerCase() !== cfg.username.toLowerCase())
      throw new Error(`token is for ${me.username}, brand expects ${cfg.username}`)
    const exp = loadTokens().pinterest?.[cfg.username]?.refreshExpiresAt
    return `${me.username}${exp ? `, sign-in valid until ${exp.slice(0, 10)}` : ''}${loadApp().sandbox ? ' (SANDBOX)' : ''}`
  },
}

const loadApp = () => getApp('pinterest')
const b64 = (file) => fs.readFileSync(file).toString('base64')
const basic = (app) => 'Basic ' + Buffer.from(`${app.appId}:${app.appSecret}`).toString('base64')

async function resolveBoard(ref, base, auth) {
  if (/^\d{6,}$/.test(String(ref))) return String(ref)
  let bookmark
  do {
    const r = await request('pinterest', `${base}/boards`, { headers: auth, query: { page_size: 100, bookmark } })
    const hit = r.items?.find((b) => b.name.toLowerCase() === String(ref).toLowerCase())
    if (hit) return hit.id
    bookmark = r.bookmark
  } while (bookmark)
  throw new Error(`pinterest board "${ref}" not found. See: social accounts pinterest`)
}

function store(username, t) {
  const now = Date.now()
  saveTokens((x) => {
    x.pinterest ??= {}
    const prev = x.pinterest[username] || {}
    x.pinterest[username] = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || prev.refreshToken,
      expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
      refreshExpiresAt: t.refresh_token_expires_in
        ? new Date(now + t.refresh_token_expires_in * 1000).toISOString()
        : prev.refreshExpiresAt,
      savedAt: new Date().toISOString(),
    }
  })
}

async function session(brand, account) {
  const cfg = platformCfg(brand, 'pinterest', account)
  const app = loadApp()
  const base = apiBase(app)
  if (!cfg.username) throw new Error(`pinterest.username is empty in brands/${brand.key}.json. \`social auth pinterest\` prints it.`)
  const saved = loadTokens().pinterest?.[cfg.username]
  if (!saved) throw new Error(`No Pinterest sign-in for ${cfg.username}. Run: social auth pinterest --brand ${brand.key}`)
  if (Date.parse(saved.expiresAt) - Date.now() > 24 * 3600_000) return { token: saved.accessToken, base }
  const t = await request('pinterest', `${base}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(app) },
    form: { grant_type: 'refresh_token', refresh_token: saved.refreshToken },
  }).catch((e) => {
    throw new Error(`Pinterest sign-in for ${cfg.username} could not be renewed (${e.message}). Run: social auth pinterest --brand ${brand.key}`)
  })
  store(cfg.username, t)
  return { token: t.access_token, base }
}

export async function authPinterest(flags) {
  const app = loadApp()
  const brand = flags.brand ? loadBrand(flags.brand) : null
  const state = newState()
  const u = new URL('https://www.pinterest.com/oauth/')
  u.searchParams.set('client_id', app.appId)
  u.searchParams.set('redirect_uri', app.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(','))
  u.searchParams.set('state', state)
  const cfg = brand ? platformCfg(brand, 'pinterest', flags.account) : {}
  const code = await waitForCode({
    authUrl: u.toString(),
    redirectUri: app.redirectUri,
    state,
    manual: flags.manual,
    note: `Pinterest sign-in. Be signed in to Pinterest as ${cfg.username || 'the business account'}${cfg.loginHint ? ` (${cfg.loginHint})` : ''} first.`,
  })
  const base = apiBase(app)
  const t = await request('pinterest', `${base}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(app) },
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, continuous_refresh: true },
  })
  const me = await request('pinterest', `${base}/user_account`, { headers: { Authorization: `Bearer ${t.access_token}` } })
  store(me.username, t)
  console.log(`\nSaved Pinterest account: ${me.username}`)
  if (cfg.username && cfg.username.toLowerCase() !== me.username.toLowerCase())
    console.log(`⚠ ${brand.key} expects ${cfg.username}. Sign in to that account on pinterest.com and run again.`)
}

export async function listBoards() {
  const app = loadApp()
  const base = apiBase(app)
  for (const [username, saved] of Object.entries(loadTokens().pinterest || {})) {
    console.log(`  ${username}`)
    const r = await request('pinterest', `${base}/boards`, {
      headers: { Authorization: `Bearer ${saved.accessToken}` },
      query: { page_size: 100 },
    }).catch((e) => ({ items: [], error: e.message }))
    if (r.error) console.log(`    (could not list boards: ${r.error})`)
    for (const b of r.items || []) console.log(`    ${b.id.padEnd(20)} ${b.name}`)
  }
}
