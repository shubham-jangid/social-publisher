// Which posts work: reads the calendar (with each post's numbers, synced every 3 h by the
// Worker) and ranks published posts by views, per brand and platform.

const DAY = 86400_000
const PLATFORMS = ['youtube', 'instagram', 'facebook', 'pinterest', 'linkedin']
const LIMIT_HELP = {
  'watch time/retention': 'enable the YouTube Analytics API in the Google Cloud project, then social sync',
  'views/reach/saves/shares': 'Meta token lacks instagram_manage_insights: new Graph API Explorer token, then social auth meta --token',
  'reactions/comments': 'Meta token lacks pages_read_user_content (same fix)',
  'reel plays': 'Meta token lacks read_insights (same fix)',
}

/** Engagement actions on a post (whatever the platform reports). */
export const actions = (m = {}) => (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0)

/** The number we rank by: views if the platform gives them, else impressions. */
export const reachOf = (m = {}) => m.views ?? m.impressions

const median = (xs) => {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b)
  if (!s.length) return undefined
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}
/** Sum of a field, or undefined when no post has it (missing ≠ zero). */
const sumOf = (ps, k) => (ps.some((p) => p.m[k] !== undefined) ? ps.reduce((a, p) => a + (p.m[k] || 0), 0) : undefined)
const hasActions = (ps) => ps.some((p) => ['likes', 'comments', 'shares', 'saves'].some((k) => p.m[k] !== undefined))
const fmt = (x) => (x === undefined || x === null ? '–' : x >= 10000 ? `${Math.round(x / 100) / 10}k` : String(x))
const pct = (x) => (x === undefined ? '–' : `${Math.round(x * 1000) / 10}%`)
const pad = (s, w) => String(s).padEnd(w).slice(0, w)
const lpad = (s, w) => String(s).padStart(w)

/** Published posts with numbers, newest first, from a /api/calendar response. */
export function postsFrom(cal, { platform } = {}) {
  return cal.entries
    .filter((e) => e.status === 'published' && e.metrics && (!platform || e.platform === platform))
    .map((e) => {
      const m = e.metrics
      const v = reachOf(m)
      return {
        brand: e.brand,
        platform: e.platform,
        at: e.at,
        kind: e.kind || '',
        title: e.planTitle || e.title || `(no caption) ${e.url || ''}`,
        url: e.url,
        m,
        views: v,
        actions: actions(m),
        rate: v && ['likes', 'comments', 'shares', 'saves'].some((k) => m[k] !== undefined) ? actions(m) / v : undefined,
        ageDays: Math.max(0, (cal.now - e.at) / DAY),
      }
    })
}

/** Plain-text report. */
export function analyticsReport(cal, { platform, top = 10, tz = process.env.SOCIAL_DEFAULT_TZ || 'UTC' } = {}) {
  const posts = postsFrom(cal, { platform })
  const out = []
  const when = (ms) =>
    new Date(ms).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short' })

  if (cal.sync?.at) out.push(`Numbers from ${Math.round((cal.now - cal.sync.at) / 60000)} min ago.`)
  const limits = (cal.sync?.results || []).filter((r) => r.limited?.length || !r.ok)
  for (const r of limits)
    out.push(
      r.ok
        ? `  ${r.brand} ${r.platform}: no ${r.limited.join(', ')} (${r.limited.map((l) => LIMIT_HELP[l]).filter(Boolean)[0] || 'missing permission'})`
        : `  ${r.brand} ${r.platform}: sync failed: ${r.error}`,
    )

  const brands = [...new Set(posts.map((p) => p.brand))]
  if (!brands.length) {
    out.push('', 'No published posts with numbers in this period yet. (Numbers arrive with the next sync; social sync runs one now.)')
    return out.join('\n')
  }

  for (const b of brands) {
    const mine = posts.filter((p) => p.brand === b)
    out.push('', `=== ${cal.brands?.[b]?.name || b} ===`, '')
    out.push(`${pad('platform', 10)} ${lpad('posts', 5)} ${lpad('views', 8)} ${lpad('median', 7)} ${lpad('likes', 6)} ${lpad('cmts', 5)} ${lpad('eng.rate', 8)}  best`)
    for (const pl of PLATFORMS) {
      const ps = mine.filter((p) => p.platform === pl)
      if (!ps.length) continue
      const views = ps.map((p) => p.views).filter((v) => v !== undefined)
      const totalViews = views.length ? views.reduce((a, c) => a + c, 0) : undefined
      const totalAct = ps.reduce((a, p) => a + p.actions, 0)
      const best = [...ps].sort((a, c) => (c.views ?? c.actions) - (a.views ?? a.actions))[0]
      out.push(
        `${pad(pl, 10)} ${lpad(ps.length, 5)} ${lpad(fmt(totalViews), 8)} ${lpad(fmt(median(views)), 7)} ${lpad(fmt(sumOf(ps, 'likes')), 6)} ${lpad(fmt(sumOf(ps, 'comments')), 5)} ${lpad(totalViews && hasActions(ps) ? pct(totalAct / totalViews) : '–', 8)}  ${best.title.slice(0, 45)}`,
      )
      // Format comparison inside one platform (Short vs long video, Reel vs photo post).
      const kinds = [...new Set(ps.map((p) => p.kind).filter(Boolean))]
      if (kinds.length > 1)
        out.push(
          `${' '.repeat(11)}by format: ${kinds
            .map((k) => {
              const ks = ps.filter((p) => p.kind === k)
              return `${k} ×${ks.length} median ${fmt(median(ks.map((p) => p.views ?? p.actions)))}`
            })
            .join(' · ')}`,
        )
    }

    out.push('', `Top ${Math.min(top, mine.length)} by views (likes if a platform gives no views):`)
    const ranked = [...mine].sort((a, c) => (c.views ?? -1) - (a.views ?? -1) || c.actions - a.actions).slice(0, top)
    for (const p of ranked) {
      const extra = [
        p.m.avgPctWatched !== undefined && `${p.m.avgPctWatched}% watched`,
        p.m.avgWatchSec !== undefined && `${p.m.avgWatchSec}s avg`,
        p.m.saves && `${p.m.saves} saves`,
        p.m.shares && `${p.m.shares} shares`,
        p.m.subscribers && `+${p.m.subscribers} subs`,
        p.ageDays < 2 && 'still new',
      ]
        .filter(Boolean)
        .join(', ')
      out.push(
        `  ${pad(when(p.at), 6)} ${pad(p.platform, 9)} ${pad(p.kind, 5)} ${lpad(fmt(p.views), 6)} views ${lpad(fmt(p.m.likes), 4)} ♥ ${lpad(fmt(p.m.comments), 3)} 💬  ${p.title.slice(0, 50)}${extra ? `  (${extra})` : ''}`,
      )
      if (p.url) out.push(`${' '.repeat(10)}${p.url}`)
    }

    // The same video on several platforms (grouped by its plan title).
    const groups = new Map()
    for (const p of mine) {
      const e = cal.entries.find((x) => x.url === p.url)
      if (!e?.planTitle) continue
      if (!groups.has(e.planTitle)) groups.set(e.planTitle, {})
      groups.get(e.planTitle)[p.platform] = p.views !== undefined ? `${fmt(p.views)} views` : `${fmt(p.m.likes)} likes`
    }
    const multi = [...groups].filter(([, g]) => Object.keys(g).length > 1)
    if (multi.length) {
      out.push('', 'Same video, each platform:')
      for (const [t, g] of multi.slice(0, top))
        out.push(`  ${pad(t, 40)} ${Object.entries(g).map(([pl, v]) => `${pl} ${v}`).join(' · ')}`)
    }
  }
  out.push('', 'Older posts have had more time to collect views; "still new" = under 2 days old.')
  return out.join('\n')
}
