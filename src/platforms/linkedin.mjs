import fs from 'node:fs'
import { getApp, loadBrand, loadTokens, platformCfg, saveTokens } from '../config.mjs'
import { request, poll } from '../http.mjs'
import { blobOf } from '../media.mjs'
import { newState, waitForCode } from '../oauth.mjs'
import { baseFields } from '../spec.mjs'
import { linkedinCommentary } from '../text.mjs'

const API = 'https://api.linkedin.com/rest'
const COMMENTARY_MAX = 3000

export default {
  name: 'linkedin',
  aiLabel: false,

  plan(spec) {
    const f = baseFields(spec, 'linkedin', { aiLabel: false })
    const cfg = platformCfg(spec.brand, 'linkedin', f.opts.account)
    if (!cfg.author) throw new Error(`set linkedin.author in brands/${spec.brand.key}.json ("urn:li:organization:<id>" or "me")`)
    if (spec.kind === 'text' && !f.caption && !f.link) throw new Error('linkedin: a text post needs a caption or a link')
    if (f.caption.length > COMMENTARY_MAX) throw new Error(`linkedin text is ${f.caption.length} characters (max ${COMMENTARY_MAX})`)
    return { ...f, account: f.opts.account, app: cfg.app || 'default', author: cfg.author }
  },

  canSchedule: () => false,

  async cloud({ spec, plan }) {
    const s = await session(plan.app)
    const author = plan.author === 'me' ? s.memberUrn : plan.author
    if (!author) throw new Error('linkedin author "me" needs the openid + profile scopes on this app')
    return {
      job: {
        kind: spec.kind === 'text' ? 'text' : spec.kind,
        commentary: linkedinCommentary(plan.caption),
        title: plan.title,
        link: plan.link,
        alt: spec.alt,
        author,
        version: s.headers['LinkedIn-Version'],
        tokenRef: `linkedin:${plan.app}`,
        appRef: `app:linkedin:${plan.app}`,
      },
      media: spec.media.map((m) => m.path),
      cover: spec.cover?.path || null,
    }
  },

  async publish({ spec, plan }) {
    const s = await session(plan.app)
    const author = plan.author === 'me' ? s.memberUrn : plan.author
    if (!author) throw new Error('linkedin author "me" needs the openid + profile scopes on this app')
    const h = s.headers
    let content

    if (spec.kind === 'video') {
      const file = spec.media[0]
      const init = await request('linkedin', `${API}/videos`, {
        method: 'POST',
        headers: h,
        query: { action: 'initializeUpload' },
        json: {
          initializeUploadRequest: { owner: author, fileSizeBytes: file.size, uploadCaptions: false, uploadThumbnail: !!spec.cover },
        },
      })
      const v = init.value
      const buf = fs.readFileSync(file.path)
      const etags = []
      for (const part of v.uploadInstructions) {
        const res = await fetch(part.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf.subarray(part.firstByte, part.lastByte + 1),
        })
        if (!res.ok) throw new Error(`linkedin video part upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
        etags.push(res.headers.get('etag'))
      }
      if (spec.cover && v.thumbnailUploadUrl) {
        await fetch(v.thumbnailUploadUrl, {
          method: 'PUT',
          headers: { 'media-type-family': 'STILLIMAGE', 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(spec.cover.path),
        })
      }
      await request('linkedin', `${API}/videos`, {
        method: 'POST',
        headers: h,
        query: { action: 'finalizeUpload' },
        json: { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken || '', uploadedPartIds: etags } },
      })
      await poll(
        'linkedin video processing',
        async () => {
          const r = await request('linkedin', `${API}/videos/${encodeURIComponent(v.video)}`, { headers: h })
          if (r.status === 'PROCESSING_FAILED') throw new Error(`linkedin could not process the video: ${r.processingFailureReason}`)
          return r.status === 'AVAILABLE'
        },
        { interval: 6000, timeout: 15 * 60_000 },
      )
      content = { media: { id: v.video, title: plan.title } }
    } else if (spec.kind === 'image' || spec.kind === 'images') {
      const ids = []
      for (const m of spec.media) ids.push(await uploadImage(m.path, author, h))
      content =
        ids.length === 1
          ? { media: { id: ids[0], altText: spec.alt } }
          : { multiImage: { images: ids.map((id) => ({ id, altText: spec.alt })) } }
    } else if (plan.link) {
      content = { article: { source: plan.link, title: plan.title || plan.link } }
      if (spec.cover) content.article.thumbnail = await uploadImage(spec.cover.path, author, h)
    }

    const r = await request('linkedin', `${API}/posts`, {
      method: 'POST',
      raw: true,
      headers: h,
      json: {
        author,
        commentary: linkedinCommentary(plan.caption),
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content,
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    })
    const urn = r.headers.get('x-restli-id') || r.data?.id
    return { status: 'published', id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined }
  },

  async check(brand, account) {
    const cfg = platformCfg(brand, 'linkedin', account)
    const s = await session(cfg.app || 'default')
    const days = Math.floor((Date.parse(s.saved.expiresAt) - Date.now()) / 86400_000)
    if (days < 0) throw new Error('LinkedIn sign-in expired')
    return `author ${cfg.author}, sign-in valid ${days} more days${days < 14 && !s.saved.refreshToken ? ' ⚠ renew soon' : ''}`
  },
}

async function uploadImage(file, owner, h) {
  const init = await request('linkedin', `${API}/images`, {
    method: 'POST',
    headers: h,
    query: { action: 'initializeUpload' },
    json: { initializeUploadRequest: { owner } },
  })
  const res = await fetch(init.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: h.Authorization },
    body: await blobOf(file),
  })
  if (!res.ok) throw new Error(`linkedin image upload failed: ${res.status}`)
  return init.value.image
}

async function session(appName) {
  const app = getApp('linkedin', appName)
  let saved = loadTokens().linkedin?.[appName]
  if (!saved) throw new Error(`No LinkedIn sign-in for app "${appName}". Run: social auth linkedin --app ${appName}`)
  if (Date.parse(saved.expiresAt) - Date.now() < 7 * 86400_000 && saved.refreshToken) {
    const t = await request('linkedin', 'https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: app.clientId, client_secret: app.clientSecret },
    })
    saved = store(appName, t, saved)
  }
  if (Date.parse(saved.expiresAt) < Date.now())
    throw new Error(`LinkedIn sign-in for "${appName}" expired on ${saved.expiresAt.slice(0, 10)}. Run: social auth linkedin --app ${appName}`)
  return {
    saved,
    memberUrn: saved.memberUrn,
    headers: {
      Authorization: `Bearer ${saved.accessToken}`,
      'LinkedIn-Version': String(app.version || '202610'),
      'X-Restli-Protocol-Version': '2.0.0',
    },
  }
}

function store(appName, t, prev = {}) {
  const now = Date.now()
  const entry = {
    ...prev,
    accessToken: t.access_token,
    expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    refreshToken: t.refresh_token || prev.refreshToken,
    refreshExpiresAt: t.refresh_token_expires_in
      ? new Date(now + t.refresh_token_expires_in * 1000).toISOString()
      : prev.refreshExpiresAt,
    scope: t.scope || prev.scope,
    savedAt: new Date().toISOString(),
  }
  saveTokens((x) => {
    x.linkedin ??= {}
    x.linkedin[appName] = entry
  })
  return entry
}

export async function authLinkedIn(flags) {
  const brand = flags.brand ? loadBrand(flags.brand) : null
  const appName = flags.app || (brand ? platformCfg(brand, 'linkedin', flags.account).app : null) || 'default'
  const app = getApp('linkedin', appName)
  const scopes = app.scopes || ['w_organization_social', 'r_organization_social']
  const state = newState()
  const u = new URL('https://www.linkedin.com/oauth/v2/authorization')
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', app.clientId)
  u.searchParams.set('redirect_uri', app.redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('scope', scopes.join(' '))
  const code = await waitForCode({
    authUrl: u.toString(),
    redirectUri: app.redirectUri,
    state,
    manual: flags.manual,
    note: 'LinkedIn sign-in. Use the LinkedIn member who is an admin of the company Page(s).',
  })
  const t = await request('linkedin', 'https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret },
  })
  let memberUrn
  if (scopes.includes('openid')) {
    const me = await request('linkedin', 'https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    }).catch(() => null)
    if (me?.sub) memberUrn = `urn:li:person:${me.sub}`
  }
  const e = store(appName, t, { memberUrn })
  console.log(`\nSaved LinkedIn sign-in for app "${appName}", valid until ${e.expiresAt.slice(0, 10)}${e.refreshToken ? ' (renews itself)' : ''}.`)
  if (!e.refreshToken) console.log('LinkedIn gave no refresh token: run this again before that date. `social check` warns 2 weeks ahead.')
}
