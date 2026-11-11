#!/usr/bin/env node
import fs from 'node:fs'
import { DEFAULT_TZ, initConfig, listBrands, loadBrand, loadTokens, paths, platformCfg } from '../src/config.mjs'
import { authMeta, printPages } from '../src/platforms/meta.mjs'
import { authYouTube } from '../src/platforms/youtube.mjs'
import { authPinterest, listBoards } from '../src/platforms/pinterest.mjs'
import { authLinkedIn } from '../src/platforms/linkedin.mjs'
import { PLATFORMS, loadQueue, publishSpec, removeFromQueue, runQueue } from '../src/publish.mjs'
import { installRunner, notify, runnerStatus, uninstallRunner } from '../src/runner.mjs'
import {
  addPlan,
  cancelJob,
  capi,
  cloudAlerts,
  cloudDeploy,
  cloudPassword,
  cloudSetup,
  cloudStatus,
  getCalendar,
  listJobs,
  markResult,
  pushBrands,
  pushSecrets,
  removePlan,
  retryJob,
  setPlan,
  syncNow,
  syncResults,
} from '../src/cloud.mjs'
import { cloudCfg } from '../src/cloudcfg.mjs'
import { fmtWhen, list, parseArgs, parseWhen } from '../src/util.mjs'
import { analyticsReport, postsFrom } from '../src/analytics.mjs'

const HELP = `social: post to Facebook, Instagram, YouTube, Pinterest and LinkedIn through their official APIs

  social init                         create ${paths.apps} (app keys go there)
  social auth meta [--token T]        one sign-in for every Facebook Page + Instagram account
  social auth youtube --brand B [--account A]
  social auth pinterest --brand B
  social auth linkedin [--app NAME | --brand B]
        (add --manual if the localhost redirect does not work)
  social accounts [meta|youtube|pinterest|linkedin]   what the saved sign-ins can reach
  social check [BRAND…]               test every platform set up for a brand
  social post SPEC.json [--dry-run] [--at "2026-11-05 18:30"|now] [--only a,b] [--skip a,b] [--force] [--approved-only]
  social queue [remove ID | retry ID [--at T]]   posts waiting (cloud scheduler + this Mac)
  social history [N]
  social blog schedule --brand B --slug S --at "2026-11-21 09:00" [--title T]   publish a Sanity draft (every language) at that time
  social strip FILE…                  remove C2PA/AI, XMP and EXIF metadata from images/videos, in place
  social calendar [--brand B] [--past 7] [--days 14] [--problems]   planned / scheduled / published / not published
  social analytics [--brand B] [--days 30] [--platform P] [--top 10] [--json]   which posts get views, likes, watch time
  social plan add --brand B --platforms instagram,facebook --at "2026-11-06 19:00" --title T [--match "words"] [--note N]
  social plan import FILE.json        a list of { brand, platform(s), at, title, match?, note? }
  social plan skip|done|open|delete ID
  social sync [BRAND]                 read every platform now (the Worker also does it every 3 h)
  social cloud setup|deploy|status|push
  social cloud password [--set PW]    sign-in for the dashboard at <worker>/app
  social cloud alerts --telegram | --to EMAIL --from "Name <addr>" [--on-publish] | --test
  social run                          post this Mac's queued items that are due (the runner calls this)
  social runner install|uninstall|status   only needed without the cloud scheduler

Brands: ${listBrands().join(', ') || '(none)'}   ·   README.md has the full guide.`

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2))
  const [cmd, sub, ...rest] = pos
  if (!cmd || flags.help || cmd === 'help') return console.log(HELP)

  switch (cmd) {
    case 'init': {
      const r = initConfig()
      console.log(r.created ? `Created ${r.file}. Fill in the app keys (see docs/).` : `${r.file} already exists.`)
      return
    }
    case 'auth': {
      const fn = { meta: authMeta, facebook: authMeta, instagram: authMeta, youtube: authYouTube, pinterest: authPinterest, linkedin: authLinkedIn }[sub]
      if (!fn) throw new Error('Usage: social auth meta|youtube|pinterest|linkedin')
      if (sub === 'youtube' && !flags.brand) throw new Error('Usage: social auth youtube --brand <brand> [--account <name>]')
      return fn(flags)
    }
    case 'accounts': {
      const t = loadTokens()
      if (!sub || sub === 'meta') {
        console.log(`Meta${t.meta?.user ? ` (signed in as ${t.meta.user.name})` : ''}:`)
        printPages()
      }
      if (!sub || sub === 'youtube') {
        console.log('YouTube:')
        for (const [id, c] of Object.entries(t.youtube || {})) console.log(`  ${c.title.padEnd(28)} ${c.handle || ''} ${id}`)
      }
      if (!sub || sub === 'pinterest') {
        console.log('Pinterest (boards):')
        await listBoards().catch((e) => console.log(`  (${e.message})`))
      }
      if (!sub || sub === 'linkedin') {
        console.log('LinkedIn:')
        for (const [app, s] of Object.entries(t.linkedin || {}))
          console.log(`  app "${app}": valid until ${s.expiresAt.slice(0, 10)}${s.memberUrn ? `, member ${s.memberUrn}` : ''}`)
      }
      return
    }
    case 'check': {
      const brands = sub ? [sub, ...rest] : listBrands()
      let bad = 0
      for (const key of brands) {
        const brand = loadBrand(key)
        console.log(`\n${brand.name || key}`)
        for (const [p, mod] of Object.entries(PLATFORMS)) {
          if (!brand[p]) continue
          const accounts = brand[p].accounts ? Object.keys(brand[p].accounts) : [undefined]
          for (const acc of accounts) {
            const label = `${p}${acc ? `:${acc}` : ''}`.padEnd(18)
            try {
              platformCfg(brand, p, acc)
              console.log(`  ✓ ${label} ${await mod.check(brand, acc)}`)
            } catch (e) {
              bad++
              console.log(`  ✗ ${label} ${e.message}`)
            }
          }
        }
      }
      if (cloudCfg()) {
        try {
          const h = await capi('GET', '/api/health')
          console.log(`\nCloud scheduler\n  ✓ ${cloudCfg().url} (${Object.entries(h.jobs).map(([k, v]) => `${v} ${k}`).join(', ') || 'no jobs'})`)
        } catch (e) {
          bad++
          console.log(`\nCloud scheduler\n  ✗ ${e.message}`)
        }
      } else console.log('\nCloud scheduler: not set up (Instagram, Pinterest, LinkedIn use the Mac queue). docs/SETUP-CLOUD.md')
      process.exitCode = bad ? 1 : 0
      return
    }
    case 'post': {
      if (!sub) throw new Error('Usage: social post <spec.json> [--dry-run]')
      let at
      if (flags.at !== undefined) {
        const tz = loadBrand(JSON.parse(fs.readFileSync(sub, 'utf8')).brand).timezone
        at = parseWhen(flags.at, tz)
      }
      const { failed } = await publishSpec(sub, {
        only: list(flags.only),
        skip: list(flags.skip),
        at,
        dryRun: !!flags['dry-run'],
        force: !!flags.force,
        approvedOnly: !!flags['approved-only'],
      })
      process.exitCode = failed ? 1 : 0
      return
    }
    case 'queue': {
      const cloud = cloudCfg()
      if (sub === 'remove') {
        if (rest[0]?.startsWith('j_')) {
          if (!cloud) throw new Error('cloud scheduler is not set up')
          const [j] = (await listJobs(true, 500)).filter((x) => x.id === rest[0])
          await cancelJob(rest[0])
          if (j) markResult(j, null)
          return console.log(`Cancelled ${rest[0]}${j ? ` (${j.platform} of ${j.spec})` : ''}`)
        }
        const item = removeFromQueue(rest[0])
        return console.log(`Removed ${item.platform} of ${item.spec}`)
      }
      if (sub === 'retry') {
        if (!cloud) throw new Error('cloud scheduler is not set up')
        const [j] = (await listJobs(true, 500)).filter((x) => x.id === rest[0])
        if (!j) throw new Error(`No cloud job ${rest[0]}`)
        const at = flags.at !== undefined ? parseWhen(flags.at, loadBrand(j.brand).timezone) : null
        await retryJob(rest[0], at)
        markResult(j, { status: 'scheduled', via: 'cloud', jobId: j.id, error: undefined })
        return console.log(`Retrying ${j.id} (${j.platform}) ${fmtWhen(at, loadBrand(j.brand).timezone)}`)
      }
      let shown = 0
      if (cloud) {
        const all = await listJobs(true, 300)
        await syncResults(all)
        const open = all.filter((j) => ['scheduled', 'preparing'].includes(j.status)).sort((a, b) => a.at - b.at)
        const recentBad = all.filter((j) => ['failed', 'missed'].includes(j.status) && Date.now() - j.updatedAt < 7 * 86400_000)
        console.log('Cloud scheduler:')
        for (const j of open) console.log(`  ${j.id}  ${fmtWhen(new Date(j.at))}  ${j.brand.padEnd(16)} ${j.platform.padEnd(10)} ${j.status === 'preparing' ? `preparing (${j.step})` : 'scheduled'}  ${j.spec}`)
        for (const j of recentBad) console.log(`  ${j.id}  ✗ ${j.status.toUpperCase()} ${j.brand} ${j.platform}: ${j.error}`)
        if (!open.length && !recentBad.length) console.log('  nothing waiting')
        shown++
      }
      const q = loadQueue()
      if (q.length || !shown) console.log(cloud ? 'This Mac:' : '')
      if (!q.length && !shown) return console.log('Queue is empty.')
      for (const x of q) console.log(`  ${x.id}  ${fmtWhen(new Date(x.at))}  ${x.brand.padEnd(16)} ${x.platform.padEnd(10)} ${x.spec}`)
      return
    }
    case 'cloud': {
      if (sub === 'setup') return cloudSetup()
      if (sub === 'deploy') return cloudDeploy()
      if (sub === 'alerts') return cloudAlerts(flags)
      if (sub === 'password') {
        const r = await cloudPassword(flags)
        return console.log(`Dashboard: ${r.url}\nPassword:  ${r.password}\n(Not saved anywhere on this Mac. Run this again to change it; that signs every browser out.)`)
      }
      if (sub === 'push') {
        await pushBrands()
        const r = await pushSecrets()
        return console.log(`Sent: ${r.saved.join(', ') || 'nothing'}${r.kept.length ? `\nKept the Worker's newer copy of: ${r.kept.join(', ')}` : ''}`)
      }
      if (!sub || sub === 'status') return cloudStatus()
      throw new Error('Usage: social cloud setup|deploy|status|push|alerts|password')
    }
    case 'blog': {
      if (sub !== 'schedule') throw new Error('Usage: social blog schedule --brand B --slug S --at "YYYY-MM-DD HH:MM"')
      const brand = loadBrand(flags.brand)
      const b = brand.blog
      if (!b?.projectId) throw new Error(`brands/${brand.key}.json has no "blog" block`)
      if (!flags.slug || !flags.at) throw new Error('--slug and --at are required')
      const at = parseWhen(flags.at, brand.timezone)?.getTime()
      if (!at || at <= Date.now()) throw new Error('--at must be a future time')
      // Document ids follow "<docType>.<lang>.<slug>"; languages after the first add "-<lang>" to the slug.
      const langs = b.languages || ['en']
      const docType = b.docType || 'blogPost'
      const docs = langs.map((lang, i) => {
        const slug = i === 0 ? flags.slug : `${flags.slug}-${lang}`
        return { draftId: `drafts.${docType}.${lang}.${slug}`, publishedId: `${docType}.${lang}.${slug}` }
      })
      const url = `${b.site}${b.path ?? '/blog/'}${flags.slug}`
      const r = await capi('POST', '/api/jobs', {
        jobs: [{ brand: brand.key, platform: 'blog', spec: `blog:${flags.slug}`, specId: flags.slug, at, job: { kind: 'sanity', projectId: b.projectId, dataset: b.dataset || 'production', docs, url, title: flags.title || flags.slug, tokenRef: b.tokenRef || `sanity:${b.projectId}` } }],
      })
      return console.log(`Scheduled ${r.ids[0]}: ${flags.slug} (${docs.length} language${docs.length > 1 ? 's' : ''}) goes live ${fmtWhen(at, brand.timezone)} → ${url}`)
    }
    case 'strip': {
      const { cleanCopy, markersIn } = await import('../src/clean.mjs')
      const files = [sub, ...rest].filter(Boolean)
      if (!files.length) throw new Error('Usage: social strip FILE…')
      for (const f of files) {
        const before = markersIn(f)
        const out = cleanCopy(f)
        if (out === f) {
          console.log(`${f}: not a PNG, JPEG or MP4/MOV, left as it is`)
          continue
        }
        fs.copyFileSync(out, f)
        console.log(`${f}: ${before.length ? `removed ${before.join(', ')}` : 'no AI markers found'}; all metadata stripped`)
      }
      return
    }
    case 'analytics': {
      const now = Date.now()
      const days = Number(flags.days || 30)
      const d = await getCalendar({ from: now - days * 86400_000, to: now, brand: flags.brand })
      if (flags.json) return console.log(JSON.stringify(postsFrom(d, { platform: flags.platform }), null, 2))
      console.log(`Last ${days} days${flags.brand ? `, ${flags.brand}` : ''}${flags.platform ? `, ${flags.platform}` : ''}.`)
      return console.log(analyticsReport(d, { platform: flags.platform, top: Number(flags.top || 10) }))
    }
    case 'calendar': {
      const days = Number(flags.days || 14)
      const past = Number(flags.past || 7)
      const now = Date.now()
      const d = await getCalendar({ from: now - past * 86400_000, to: now + days * 86400_000, brand: flags.brand })
      const LABEL = { overdue: 'NOT PUBLISHED', stuck: 'STUCK', failed: 'FAILED', missed: 'MISSED', private: 'private', published: 'published', scheduled: 'scheduled', preparing: 'preparing', planned: 'planned', skipped: 'skipped' }
      const bad = ['overdue', 'stuck', 'failed', 'missed']
      const rows = d.entries.filter((e) => !flags.problems || bad.includes(e.status))
      if (d.sync?.at) {
        const errs = (d.sync.results || []).filter((r) => !r.ok)
        console.log(`Platforms checked ${Math.round((now - d.sync.at) / 60000)} min ago${errs.length ? `; could not read: ${errs.map((r) => `${r.brand} ${r.platform} (${r.error})`).join('; ')}` : ''}`)
      } else console.log('Platforms not checked yet (social sync)')
      let day = ''
      for (const e of rows) {
        const tz = d.brands[e.brand]?.timezone || DEFAULT_TZ
        const [wd, date, time] = fmtWhen(new Date(e.at), tz).replace(/ \(.*\)$/, '').split(', ')
        const k = `${wd}, ${date}`
        if (k !== day) console.log(`\n${(day = k)}`)
        const t = (e.planTitle || e.title || '').replace(/\s+/g, ' ').slice(0, 70)
        console.log(`  ${time.padEnd(6)} ${e.brand.padEnd(16)} ${e.platform.padEnd(10)} ${(LABEL[e.status] || e.status).padEnd(14)} ${t}${e.url ? `  ${e.url}` : ''}${e.planId && e.source === 'plan' ? `  [${e.planId}]` : ''}`)
      }
      if (!rows.length) console.log('\nNothing in this range.')
      return
    }
    case 'plan': {
      if (sub === 'add') {
        const brand = loadBrand(flags.brand)
        const plats = list(flags.platforms || flags.platform)
        if (!plats.length || !flags.at || !flags.title) throw new Error('Usage: social plan add --brand B --platforms a,b --at "2026-11-06 19:00" --title T')
        const at = parseWhen(flags.at, brand.timezone).getTime()
        const items = plats.map((platform) => ({ brand: brand.key, platform, at, title: flags.title, match: flags.match ? String(flags.match).split('|').map((x) => x.trim()).filter(Boolean) : undefined, note: flags.note }))
        const r = await addPlan(items)
        return console.log(`Planned ${r.ids.length}: ${r.ids.join(', ')}`)
      }
      if (sub === 'import') {
        const raw = JSON.parse(fs.readFileSync(rest[0], 'utf8'))
        const items = []
        for (const x of Array.isArray(raw) ? raw : raw.items) {
          const brand = loadBrand(x.brand)
          const at = parseWhen(x.at, brand.timezone).getTime()
          for (const platform of [].concat(x.platforms || x.platform)) items.push({ brand: brand.key, platform, at, title: x.title, match: x.match, note: x.note, spec: x.spec })
        }
        let n = 0
        for (let i = 0; i < items.length; i += 50) n += (await addPlan(items.slice(i, i + 50))).ids.length
        return console.log(`Plan: ${n} items added or updated.`)
      }
      const state = { skip: 'skipped', done: 'done', open: 'open' }[sub]
      if (state && rest[0]) {
        await setPlan(rest[0], state)
        return console.log(`${rest[0]}: ${state}`)
      }
      if (sub === 'delete' && rest[0]) {
        await removePlan(rest[0])
        return console.log(`Deleted ${rest[0]}`)
      }
      throw new Error('Usage: social plan add|import|skip|done|open|delete …')
    }
    case 'sync': {
      await pushBrands()
      const r = await syncNow(sub)
      for (const x of r.results) console.log(`  ${x.ok ? '✓' : '✗'} ${x.brand.padEnd(16)} ${x.platform.padEnd(10)} ${x.ok ? `${x.count} posts` : x.error}`)
      return
    }
    case 'run': {
      console.log(`[${new Date().toISOString()}] run`)
      return runQueue({ maxLateMin: Number(flags['max-late'] || 180), notify })
    }
    case 'runner': {
      if (sub === 'install') return installRunner()
      if (sub === 'uninstall') return uninstallRunner()
      return runnerStatus()
    }
    case 'history': {
      if (cloudCfg()) await syncResults().catch((e) => console.log(`(could not reach the cloud scheduler: ${e.message})`))
      if (!fs.existsSync(paths.history)) return console.log('Nothing posted yet.')
      const lines = fs.readFileSync(paths.history, 'utf8').trim().split('\n').slice(-Number(sub || 20))
      for (const l of lines) {
        const h = JSON.parse(l)
        console.log(`  ${h.time.slice(0, 16)}  ${h.brand.padEnd(16)} ${h.platform.padEnd(10)} ${(h.via === 'cloud' ? 'cloud ' + h.status : h.status).padEnd(16)} ${h.url || h.jobId || h.error || ''}`)
      }
      if (cloudCfg()) {
        const done = (await listJobs(true, Number(sub || 20)).catch(() => [])).filter((j) => j.status === 'published')
        if (done.length) console.log('Posted by the cloud scheduler:')
        for (const j of done) console.log(`  ${new Date(j.updatedAt).toISOString().slice(0, 16)}  ${j.brand.padEnd(16)} ${j.platform.padEnd(10)} ${j.result?.url || j.result?.id || ''}`)
      }
      return
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run: social help`)
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`)
  process.exitCode = 1
})
