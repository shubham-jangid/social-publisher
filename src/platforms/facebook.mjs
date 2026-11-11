import path from 'node:path'
import { request, poll } from '../http.mjs'
import { blobOf } from '../media.mjs'
import { baseFields } from '../spec.mjs'
import { debugToken, graph, graphBase, pageContext } from './meta.mjs'

const MIN_LEAD = 10 * 60_000
const MAX_LEAD = 29 * 24 * 3600_000

export default {
  name: 'facebook',
  aiLabel: false,

  plan(spec) {
    const f = baseFields(spec, 'facebook', { aiLabel: false })
    let kind
    if (spec.kind === 'video') kind = f.opts.as || spec.brand.facebook?.videoAs || 'reel'
    else if (spec.kind === 'image') kind = 'photo'
    else if (spec.kind === 'images') kind = 'album'
    else kind = 'feed'
    if (!['reel', 'video', 'photo', 'album', 'feed'].includes(kind)) throw new Error(`facebook.as must be reel or video`)
    if (kind === 'feed' && !f.caption && !f.link) throw new Error('facebook: a text post needs a caption or a link')
    if (kind === 'reel' && spec.media[0].size > 1e9) f.warnings.push('Reels over 1 GB are rejected')
    return { ...f, title: f.opts.title, kind, account: f.opts.account }
  },

  canSchedule(at) {
    const lead = at - Date.now()
    return lead >= MIN_LEAD && lead <= MAX_LEAD
  },

  async publish({ spec, plan, at }) {
    const page = pageContext(spec.brand, plan.account)
    const token = page.token
    const sched = at ? { published: false, scheduled_publish_time: Math.floor(at / 1000) } : {}

    if (plan.kind === 'reel') {
      const file = spec.media[0]
      const start = await graph(`${page.pageId}/video_reels`, {
        method: 'POST',
        form: { upload_phase: 'start', access_token: token },
      })
      await request('meta', start.upload_url || `https://rupload.facebook.com/video-upload/${graphBase().split('/').pop()}/${start.video_id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(file.size) },
        body: await blobOf(file.path),
        retries: 2,
      })
      await graph(`${page.pageId}/video_reels`, {
        method: 'POST',
        form: {
          upload_phase: 'finish',
          video_id: start.video_id,
          video_state: at ? 'SCHEDULED' : 'PUBLISHED',
          scheduled_publish_time: sched.scheduled_publish_time,
          description: plan.caption,
          title: plan.title,
          access_token: token,
        },
      })
      const note = []
      if (spec.cover) await setThumb(start.video_id, spec.cover.path, token).catch((e) => note.push(`cover not set: ${e.message}`))
      const st = await poll(
        'facebook reel processing',
        async () => {
          const r = await graph(start.video_id, { query: { fields: 'status', access_token: token } })
          const s = r.status || {}
          if (s.video_status === 'error' || s.processing_phase?.status === 'error')
            throw new Error(`facebook rejected the video: ${JSON.stringify(s.processing_phase?.errors || s)}`)
          return s.processing_phase?.status === 'complete' || s.video_status === 'ready' ? s : null
        },
        { interval: 6000, timeout: 10 * 60_000 },
      ).catch((e) => (note.push(e.message), null))
      return {
        status: at ? 'scheduled' : 'published',
        id: start.video_id,
        url: `https://www.facebook.com/reel/${start.video_id}`,
        note: [st ? '' : 'still processing on Facebook', ...note].filter(Boolean).join('; ') || undefined,
      }
    }

    if (plan.kind === 'video') {
      const file = spec.media[0]
      const fd = new FormData()
      fd.append('source', await blobOf(file.path), file.name)
      fd.append('description', plan.caption)
      if (plan.title) fd.append('title', plan.title)
      if (spec.cover) fd.append('thumb', await blobOf(spec.cover.path), spec.cover.name)
      for (const [k, v] of Object.entries(sched)) fd.append(k, String(v))
      fd.append('access_token', token)
      const r = await request('meta', `${graphBase().replace('graph.', 'graph-video.')}/${page.pageId}/videos`, {
        method: 'POST',
        body: fd,
      })
      return { status: at ? 'scheduled' : 'published', id: r.id, url: `https://www.facebook.com/${page.pageId}/videos/${r.id}` }
    }

    if (plan.kind === 'photo') {
      const file = spec.media[0]
      const fd = new FormData()
      fd.append('source', await blobOf(file.path), file.name)
      if (plan.caption) fd.append('message', plan.caption)
      for (const [k, v] of Object.entries(sched)) fd.append(k, String(v))
      fd.append('access_token', token)
      const r = await graph(`${page.pageId}/photos`, { method: 'POST', body: fd })
      return { status: at ? 'scheduled' : 'published', id: r.post_id || r.id, url: postUrl(r.post_id || r.id) }
    }

    // album (several photos in one post) or plain text/link post
    const attached = []
    if (plan.kind === 'album') {
      for (const file of spec.media) {
        const fd = new FormData()
        fd.append('source', await blobOf(file.path), file.name)
        fd.append('published', 'false')
        if (at) fd.append('temporary', 'true')
        fd.append('access_token', token)
        const r = await graph(`${page.pageId}/photos`, { method: 'POST', body: fd })
        attached.push({ media_fbid: r.id })
      }
    }
    const r = await graph(`${page.pageId}/feed`, {
      method: 'POST',
      form: {
        message: plan.caption || undefined,
        link: plan.kind === 'feed' ? plan.link : undefined,
        attached_media: attached.length ? attached : undefined,
        ...sched,
        access_token: token,
      },
    })
    return { status: at ? 'scheduled' : 'published', id: r.id, url: postUrl(r.id) }
  },

  async check(brand, account) {
    const page = pageContext(brand, account)
    const r = await graph(page.pageId, { query: { fields: 'name', access_token: page.token } })
    const d = await debugToken(page.token).catch(() => null)
    const exp = d?.expires_at ? new Date(d.expires_at * 1000).toISOString().slice(0, 10) : 'never'
    return `Page "${r.name}" (${page.pageId}), token expires: ${exp}`
  },
}

const postUrl = (id) => (id ? `https://www.facebook.com/${id}` : undefined)

async function setThumb(videoId, file, token) {
  const fd = new FormData()
  fd.append('source', await blobOf(file), path.basename(file))
  fd.append('is_preferred', 'true')
  fd.append('access_token', token)
  await graph(`${videoId}/thumbnails`, { method: 'POST', body: fd })
}
