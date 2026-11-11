import { getApp, loadTokens, platformCfg, saveTokens, loadBrand } from '../config.mjs'
import { request } from '../http.mjs'
import { blobOf, toJpeg } from '../media.mjs'
import { newState, waitForCode } from '../oauth.mjs'
import { baseFields } from '../spec.mjs'
import { insertBeforeHashtags, stripAngles } from '../text.mjs'

// The `youtube` scope also covers the YouTube Analytics API (watch time, % watched) of our own
// channels, so `social analytics` needs no extra permission.
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube']
const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3'

export default {
  name: 'youtube',
  aiLabel: true, // status.containsSyntheticMedia

  plan(spec) {
    const f = baseFields(spec, 'youtube', { aiLabel: true })
    if (spec.kind !== 'video') throw new Error('youtube needs a video')
    const cfg = platformCfg(spec.brand, 'youtube', f.opts.account)
    const title = stripAngles(f.title || '').trim()
    if (!title) throw new Error('youtube needs a "title" (in the spec or platforms.youtube.title)')
    if (title.length > 100) throw new Error(`youtube title is ${title.length} characters (max 100)`)
    let description = stripAngles(f.opts.description ?? f.caption)
    const footer = f.opts.descriptionFooter ?? cfg.descriptionFooter
    if (footer && !description.includes('{videoId}') && !description.includes(footer.split('{videoId}')[0].trim()))
      description = insertBeforeHashtags(description, footer)
    if (Buffer.byteLength(description) > 5000) throw new Error('youtube description is over 5000 bytes')
    const madeForKids = f.opts.madeForKids ?? cfg.madeForKids
    if (typeof madeForKids !== 'boolean')
      throw new Error(`set youtube.madeForKids (true/false) in brands/${spec.brand.key}.json or the spec`)
    const tags = f.opts.tags ?? spec.tags
    if (tags.join(',').length > 480) throw new Error('youtube tags are over 500 characters in total')
    return {
      ...f,
      account: f.opts.account,
      channelId: cfg.channelId,
      title,
      description,
      fillsVideoId: description.includes('{videoId}'),
      tags,
      categoryId: String(f.opts.categoryId ?? cfg.categoryId ?? '22'),
      language: f.opts.language ?? cfg.language,
      privacy: f.opts.privacy ?? cfg.privacy ?? 'public',
      madeForKids,
      synthetic: f.opts.ai ?? spec.ai,
      playlistId: f.opts.playlistId ?? cfg.playlistId,
      notifySubscribers: f.opts.notifySubscribers ?? true,
    }
  },

  canSchedule: (at) => at - Date.now() > 2 * 60_000,

  async publish({ spec, plan, at }) {
    const access = await accessToken(spec.brand, plan.account)
    const auth = { Authorization: `Bearer ${access}` }
    const file = spec.media[0]
    const finalStatus = {
      privacyStatus: at ? 'private' : plan.privacy,
      publishAt: at ? at.toISOString() : undefined,
      selfDeclaredMadeForKids: plan.madeForKids,
      containsSyntheticMedia: !!plan.synthetic,
      embeddable: true,
      license: 'youtube',
    }
    const snippet = (description) => ({
      title: plan.title,
      description,
      tags: plan.tags.length ? plan.tags : undefined,
      categoryId: plan.categoryId,
      defaultLanguage: plan.language,
      defaultAudioLanguage: plan.language,
    })
    // When the description needs the video's own id, upload private first, then fill it in.
    const firstStatus = plan.fillsVideoId ? { ...finalStatus, privacyStatus: 'private', publishAt: undefined } : finalStatus

    const init = await request('youtube', `${UPLOAD}/videos`, {
      method: 'POST',
      raw: true,
      query: { uploadType: 'resumable', part: 'snippet,status', notifySubscribers: plan.notifySubscribers },
      headers: { ...auth, 'X-Upload-Content-Length': String(file.size), 'X-Upload-Content-Type': file.mime },
      json: { snippet: snippet(plan.description.replaceAll('{videoId}', '')), status: firstStatus },
    })
    const location = init.headers.get('location')
    if (!location) throw new Error('youtube did not return an upload address')
    const video = await request('youtube', location, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': file.mime },
      body: await blobOf(file.path),
      retries: 0,
    })
    const id = video.id
    const notes = []

    if (plan.fillsVideoId) {
      await request('youtube', `${API}/videos`, {
        method: 'PUT',
        query: { part: 'snippet,status' },
        headers: auth,
        json: { id, snippet: snippet(plan.description.replaceAll('{videoId}', id)), status: finalStatus },
        retries: 2,
      })
    }
    if (spec.cover) {
      try {
        const thumb = await toJpeg(spec.cover.path, { maxBytes: 2e6 })
        await request('youtube', `${UPLOAD}/thumbnails/set`, {
          method: 'POST',
          query: { videoId: id, uploadType: 'media' },
          headers: { ...auth, 'Content-Type': 'image/jpeg' },
          body: await blobOf(thumb),
          retries: 2,
        })
      } catch (e) {
        notes.push(`thumbnail not set (${e.message}); the channel must be phone-verified`)
      }
    }
    if (plan.playlistId) {
      await request('youtube', `${API}/playlistItems`, {
        method: 'POST',
        query: { part: 'snippet' },
        headers: auth,
        json: { snippet: { playlistId: plan.playlistId, resourceId: { kind: 'youtube#video', videoId: id } } },
        retries: 2,
      }).catch((e) => notes.push(`not added to playlist: ${e.message}`))
    }
    const now = await request('youtube', `${API}/videos`, { query: { part: 'status', id }, headers: auth }).catch(() => null)
    const got = now?.items?.[0]?.status
    if (got && !at && plan.privacy === 'public' && got.privacyStatus !== 'public')
      notes.push(
        `YouTube kept it ${got.privacyStatus}. New API projects can only upload private videos until Google's audit passes; ` +
          'make it public in Studio for now (docs/SETUP-YOUTUBE.md)',
      )
    return {
      status: at ? 'scheduled' : 'published',
      id,
      url: `https://youtu.be/${id}`,
      note: notes.join('; ') || undefined,
    }
  },

  async check(brand, account) {
    const cfg = platformCfg(brand, 'youtube', account)
    const access = await accessToken(brand, account)
    const r = await request('youtube', `${API}/channels`, {
      query: { part: 'snippet', mine: true },
      headers: { Authorization: `Bearer ${access}` },
    })
    const ch = r.items?.[0]
    if (cfg.channelId && ch?.id !== cfg.channelId)
      throw new Error(`token is for ${ch?.snippet?.title} (${ch?.id}), brand expects ${cfg.channelId}`)
    return `${ch.snippet.title} ${ch.snippet.customUrl || ''} (${ch.id})`
  },
}

export async function authYouTube(flags) {
  const app = getApp('google')
  const brand = flags.brand ? loadBrand(flags.brand) : null
  const cfg = brand ? platformCfg(brand, 'youtube', flags.account) : {}
  const state = newState()
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  for (const [k, v] of Object.entries({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    login_hint: cfg.loginHint,
  }))
    if (v) u.searchParams.set(k, v)
  const code = await waitForCode({
    authUrl: u.toString(),
    redirectUri: app.redirectUri,
    state,
    manual: flags.manual,
    note:
      `YouTube sign-in${brand ? ` for ${brand.name || brand.key}` : ''}. ` +
      `Sign in as ${cfg.loginHint || 'the Google account that owns the channel'}` +
      ' and, if asked, pick the channel itself (Brand Accounts are listed separately).',
  })
  const t = await request('google', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' },
  })
  if (!t.refresh_token) throw new Error('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and retry.')
  const r = await request('youtube', `${API}/channels`, {
    query: { part: 'snippet', mine: true },
    headers: { Authorization: `Bearer ${t.access_token}` },
  })
  const ch = r.items?.[0]
  if (!ch) throw new Error('That Google account has no YouTube channel. Sign in again and pick the channel.')
  saveTokens((x) => {
    x.youtube ??= {}
    x.youtube[ch.id] = {
      title: ch.snippet.title,
      handle: ch.snippet.customUrl,
      refreshToken: t.refresh_token,
      scope: t.scope,
      savedAt: new Date().toISOString(),
    }
  })
  console.log(`\nSaved YouTube channel: ${ch.snippet.title} ${ch.snippet.customUrl || ''} (${ch.id})`)
  if (cfg.channelId && cfg.channelId !== ch.id)
    console.log(`⚠ ${brand.key} expects channel ${cfg.channelId}. Run again and choose that channel.`)
  else if (brand && !cfg.channelId) console.log(`Now set youtube channelId "${ch.id}" in brands/${brand.key}.json.`)
}

const cache = new Map()
async function accessToken(brand, account) {
  const cfg = platformCfg(brand, 'youtube', account)
  if (!cfg.channelId)
    throw new Error(`youtube.channelId is empty in brands/${brand.key}.json. \`social auth youtube --brand ${brand.key}\` prints it.`)
  const saved = loadTokens().youtube?.[cfg.channelId]
  if (!saved) throw new Error(`No YouTube sign-in for ${brand.key} (${cfg.channelId}). Run: social auth youtube --brand ${brand.key}`)
  const hit = cache.get(cfg.channelId)
  if (hit && hit.exp > Date.now() + 60_000) return hit.token
  const app = getApp('google')
  try {
    const t = await request('google', 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      retries: 2,
      form: { client_id: app.clientId, client_secret: app.clientSecret, refresh_token: saved.refreshToken, grant_type: 'refresh_token' },
    })
    cache.set(cfg.channelId, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 })
    return t.access_token
  } catch (e) {
    if (String(e.message).includes('invalid_grant'))
      throw new Error(
        `YouTube sign-in for ${brand.key} has expired or was revoked. Run: social auth youtube --brand ${brand.key}. ` +
          '(If this happens every 7 days, the OAuth app is still in "Testing": publish it.)',
      )
    throw e
  }
}

