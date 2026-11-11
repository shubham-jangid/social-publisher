const HASHTAG_LINE = /^(\s*#[\p{L}\p{M}\p{N}_]+[\s,]*)+$/u

/** Splits a caption into its body and the trailing lines made only of hashtags. */
export function splitTrailingHashtags(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n')
  let i = lines.length
  while (i > 0 && (HASHTAG_LINE.test(lines[i - 1]) || (lines[i - 1].trim() === '' && i < lines.length))) i--
  if (i === 0) return { body: lines.join('\n'), tags: '' }
  return {
    body: lines.slice(0, i).join('\n').replace(/\s+$/, ''),
    tags: lines.slice(i).join('\n').trim(),
  }
}

/** Adds a line as its own paragraph just above the hashtags (or at the end). */
export function insertBeforeHashtags(text, line) {
  const { body, tags } = splitTrailingHashtags(text)
  return [body, line, tags].filter(Boolean).join('\n\n')
}

export const UTM_SOURCE = {
  facebook: 'facebook',
  instagram: 'instagram',
  youtube: 'youtube',
  pinterest: 'pinterest',
  linkedin: 'linkedin',
}

/**
 * Adds utm_* to links that point at the brand's own site, unless the link
 * already carries utm_source. Off-site links are left alone.
 */
export function tagLink(url, { platform, brand, spec }) {
  if (!url) return url
  if (brand.utm === false || !brand.site) return url
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const site = new URL(brand.site).hostname.replace(/^www\./, '')
  if (u.hostname.replace(/^www\./, '') !== site) return url
  if (u.searchParams.has('utm_source')) return url
  const utm = brand.utm || {}
  u.searchParams.set('utm_source', UTM_SOURCE[platform] || platform)
  u.searchParams.set('utm_medium', utm.medium || 'social')
  u.searchParams.set('utm_campaign', spec.campaign || utm.campaign || 'post')
  u.searchParams.set('utm_content', spec.id)
  return u.toString()
}

/**
 * LinkedIn "little text" commentary: reserved characters must be escaped, and
 * hashtags written as {hashtag|\#|word} to stay clickable.
 */
export function linkedinCommentary(text) {
  return String(text || '').replace(/#([\p{L}\p{M}\p{N}_]+)|([\\|{}@[\]()<>#*_~])/gu, (m, tag, ch) =>
    tag ? `{hashtag|\\#|${tag}}` : `\\${ch}`,
  )
}

/** YouTube rejects < and > in titles and descriptions. */
export const stripAngles = (s) => String(s || '').replace(/[<>]/g, '')
