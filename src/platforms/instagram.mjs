import { request, poll } from '../http.mjs'
import { blobOf, getHost, toJpeg } from '../media.mjs'
import { baseFields } from '../spec.mjs'
import { cloudEnabled } from '../cloudcfg.mjs'
import { graph, graphBase, igContext } from './meta.mjs'

const CAPTION_MAX = 2200

export default {
  name: 'instagram',
  aiLabel: false,

  plan(spec) {
    const f = baseFields(spec, 'instagram', { aiLabel: false })
    if (spec.kind === 'text') throw new Error('instagram needs a video or images')
    const kind = spec.kind === 'video' ? 'reel' : spec.kind === 'image' ? 'image' : 'carousel'
    if (kind === 'carousel' && spec.media.length > 10) throw new Error('instagram carousels take at most 10 images')
    if (f.caption.length > CAPTION_MAX) throw new Error(`instagram caption is ${f.caption.length} characters (max ${CAPTION_MAX})`)
    const tags = (f.caption.match(/#[\p{L}\p{M}\p{N}_]+/gu) || []).length
    if (tags > 30) throw new Error(`instagram caption has ${tags} hashtags (max 30)`)
    const needsHost = kind !== 'reel' || !!spec.cover
    if (needsHost && !cloudEnabled() && !getHost()) {
      if (kind === 'reel') f.warnings.push('no media host set up, so the Reel cover is skipped (Instagram picks a frame)')
      else throw new Error(`instagram ${kind} posts need a media host (docs/SETUP-R2.md)`)
    }
    if (f.link) f.warnings.push('links in Instagram captions are not clickable')
    return {
      ...f,
      title: undefined,
      kind,
      account: f.opts.account,
      shareToFeed: f.opts.shareToFeed ?? true,
      thumbOffsetMs: f.opts.thumbOffsetMs,
    }
  },

  canSchedule: () => false, // the API has no scheduling; the cloud scheduler (or local queue) posts it on time

  /** What the cloud scheduler needs: final text, ids, and which local files to upload. */
  async cloud({ spec, plan }) {
    const ig = igContext(spec.brand, plan.account)
    const jpeg = (m) => toJpeg(m.path)
    return {
      job: {
        kind: plan.kind,
        caption: plan.caption,
        alt: spec.alt,
        igUserId: ig.igUserId,
        tokenRef: `meta:page:${ig.pageId}`,
        graphVersion: graphBase().split('/').pop(),
        shareToFeed: plan.shareToFeed,
        thumbOffsetMs: plan.thumbOffsetMs,
      },
      media: plan.kind === 'reel' ? [spec.media[0].path] : await Promise.all(spec.media.map(jpeg)),
      cover: spec.cover ? await toJpeg(spec.cover.path) : null,
    }
  },

  async publish({ spec, plan, host }) {
    const ig = igContext(spec.brand, plan.account)
    const token = ig.token
    let containerId

    if (plan.kind === 'reel') {
      const file = spec.media[0]
      const coverUrl = spec.cover && host ? await host.put(await toJpeg(spec.cover.path)) : undefined
      const c = await graph(`${ig.igUserId}/media`, {
        method: 'POST',
        form: {
          media_type: 'REELS',
          upload_type: 'resumable',
          caption: plan.caption,
          share_to_feed: plan.shareToFeed,
          cover_url: coverUrl,
          thumb_offset: coverUrl ? undefined : plan.thumbOffsetMs,
          access_token: token,
        },
      })
      containerId = c.id
      await request('instagram', c.uri || `https://rupload.facebook.com/ig-api-upload/${graphBase().split('/').pop()}/${c.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(file.size) },
        body: await blobOf(file.path),
        retries: 2,
      })
    } else if (plan.kind === 'image') {
      const url = await host.put(await toJpeg(spec.media[0].path))
      const c = await graph(`${ig.igUserId}/media`, {
        method: 'POST',
        form: { image_url: url, caption: plan.caption, alt_text: spec.alt, access_token: token },
      })
      containerId = c.id
    } else {
      const children = []
      for (const m of spec.media) {
        const url = await host.put(await toJpeg(m.path))
        const c = await graph(`${ig.igUserId}/media`, {
          method: 'POST',
          form: { image_url: url, is_carousel_item: true, access_token: token },
        })
        children.push(c.id)
      }
      for (const id of children) await waitReady(id, token)
      const c = await graph(`${ig.igUserId}/media`, {
        method: 'POST',
        form: { media_type: 'CAROUSEL', children: children.join(','), caption: plan.caption, access_token: token },
      })
      containerId = c.id
    }

    await waitReady(containerId, token)
    const pub = await graph(`${ig.igUserId}/media_publish`, {
      method: 'POST',
      form: { creation_id: containerId, access_token: token },
    })
    const info = await graph(pub.id, { query: { fields: 'permalink', access_token: token } }).catch(() => ({}))
    return { status: 'published', id: pub.id, url: info.permalink }
  },

  async check(brand, account) {
    const ig = igContext(brand, account)
    const r = await graph(ig.igUserId, { query: { fields: 'username', access_token: ig.token } })
    const lim = await graph(`${ig.igUserId}/content_publishing_limit`, {
      query: { fields: 'quota_usage,config', access_token: ig.token },
    }).catch(() => null)
    const used = lim?.data?.[0] ? `, ${lim.data[0].quota_usage}/${lim.data[0].config?.quota_total} posts used in 24 h` : ''
    return `@${r.username} (${ig.igUserId})${used}`
  },
}

async function waitReady(id, token) {
  return poll(
    'instagram media processing',
    async () => {
      const r = await graph(id, { query: { fields: 'status_code,status', access_token: token } })
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED')
        throw new Error(`instagram could not process the media: ${r.status || r.status_code}`)
      return r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED'
    },
    { interval: 5000, timeout: 15 * 60_000 },
  )
}
