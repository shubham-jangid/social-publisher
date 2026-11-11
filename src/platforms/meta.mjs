// Shared Meta (Facebook + Instagram) plumbing: one Meta app, one sign-in,
// then a non-expiring Page token for every Page the person manages, across
// all business portfolios. Nothing here opens a browser.
import { getApp, loadTokens, platformCfg, saveTokens } from '../config.mjs'
import { request } from '../http.mjs'
import { newState, waitForCode } from '../oauth.mjs'

export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
  // analytics (social analytics): reel plays + reach, Instagram views/reach/saves, post reactions
  'read_insights',
  'instagram_manage_insights',
  'pages_read_user_content',
]

export function metaApp() {
  const app = getApp('meta')
  return { ...app, version: app.graphVersion || 'v24.0' }
}

export const graphBase = (app = metaApp()) => `https://graph.facebook.com/${app.version}`

export function graph(pathname, opts = {}) {
  return request('meta', `${graphBase()}/${pathname.replace(/^\//, '')}`, opts)
}

async function listPages(token) {
  const pages = []
  let next = `${graphBase()}/me/accounts`
  let query = { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: 100, access_token: token }
  while (next) {
    const r = await request('meta', next, { query })
    pages.push(...(r.data || []))
    next = r.paging?.next || null
    query = undefined
  }
  return pages
}

export async function authMeta(flags) {
  const app = metaApp()
  let token = typeof flags.token === 'string' ? flags.token : null
  if (!token) {
    const state = newState()
    const u = new URL(`https://www.facebook.com/${app.version}/dialog/oauth`)
    u.searchParams.set('client_id', app.appId)
    u.searchParams.set('redirect_uri', app.redirectUri)
    u.searchParams.set('state', state)
    u.searchParams.set('response_type', 'code')
    if (app.configId) u.searchParams.set('config_id', app.configId)
    else u.searchParams.set('scope', META_SCOPES.join(','))
    const code = await waitForCode({
      authUrl: u.toString(),
      redirectUri: app.redirectUri,
      state,
      manual: flags.manual,
      note:
        'Meta sign-in. Use the Facebook account that manages the Pages.\n' +
        'When asked, tick EVERY Page and Instagram account you want to post to (all brands).',
    })
    const t = await request('meta', `${graphBase(app)}/oauth/access_token`, {
      query: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: app.redirectUri, code },
    })
    token = t.access_token
  }
  try {
    const ll = await request('meta', `${graphBase(app)}/oauth/access_token`, {
      query: { grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: token },
    })
    token = ll.access_token
  } catch (e) {
    console.log(`(kept the token as given; long-lived exchange said: ${e.message})`)
  }
  const me = await graph('me', { query: { fields: 'id,name', access_token: token } })
  const pages = await listPages(token)
  if (!pages.length) throw new Error('Signed in, but no Pages came back. Re-run and tick the Pages in the dialog.')

  saveTokens((t) => {
    t.meta ??= { pages: {} }
    t.meta.user = { id: me.id, name: me.name, token, savedAt: new Date().toISOString() }
    for (const p of pages) {
      t.meta.pages[p.id] = {
        name: p.name,
        token: p.access_token,
        tasks: p.tasks,
        igUserId: p.instagram_business_account?.id || null,
        igUsername: p.instagram_business_account?.username || null,
        savedAt: new Date().toISOString(),
      }
    }
  })
  console.log(`\nSaved tokens for ${me.name}. Pages:\n`)
  printPages()
  console.log('\nPut the ids above into each brand file (facebook.pageId, instagram.userId).')
}

export function printPages() {
  const pages = loadTokens().meta?.pages || {}
  const rows = Object.entries(pages)
  if (!rows.length) return console.log('  (none yet: run `social auth meta`)')
  for (const [id, p] of rows) {
    const canPost = !p.tasks || p.tasks.includes('CREATE_CONTENT')
    console.log(
      `  ${p.name.padEnd(28)} page ${id.padEnd(18)} ` +
        (p.igUserId ? `instagram @${p.igUsername} ${p.igUserId}` : 'no Instagram linked') +
        (canPost ? '' : '  ⚠ no CREATE_CONTENT task'),
    )
  }
}

/** Page id + token for a brand. Matches facebook.pageId, else facebook.pageName. */
export function pageContext(brand, accountName) {
  const cfg = platformCfg(brand, 'facebook', accountName)
  const pages = loadTokens().meta?.pages || {}
  let id = cfg.pageId && pages[cfg.pageId] ? cfg.pageId : null
  if (!id && cfg.pageName) id = Object.keys(pages).find((k) => pages[k].name.toLowerCase() === cfg.pageName.toLowerCase())
  if (!id)
    throw new Error(
      `No Meta token for ${brand.key}'s Page (${cfg.pageId || cfg.pageName}). Run \`social auth meta\` and tick that Page, ` +
        'then check facebook.pageId in the brand file against `social accounts meta`.',
    )
  return { pageId: id, ...pages[id] }
}

export function igContext(brand, accountName) {
  const cfg = platformCfg(brand, 'instagram', accountName)
  const pages = loadTokens().meta?.pages || {}
  const hit = Object.entries(pages).find(
    ([, p]) =>
      (cfg.userId && p.igUserId === cfg.userId) ||
      (cfg.username && p.igUsername?.toLowerCase() === cfg.username.toLowerCase()),
  )
  if (!hit)
    throw new Error(
      `No Instagram account ${cfg.username ? '@' + cfg.username : cfg.userId} among the saved Pages. ` +
        'It must be a Business/Creator account linked to a Facebook Page you ticked in `social auth meta`.',
    )
  const [pageId, p] = hit
  return { igUserId: p.igUserId, igUsername: p.igUsername, token: p.token, pageId }
}

export async function debugToken(token) {
  const app = metaApp()
  const r = await graph('debug_token', { query: { input_token: token, access_token: `${app.appId}|${app.appSecret}` } })
  return r.data
}
