import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paths, readJson, writePrivate } from './config.mjs'
import { sendToCloud } from './cloud.mjs'
import { cloudEnabled } from './cloudcfg.mjs'
import { getHost } from './media.mjs'
import facebook from './platforms/facebook.mjs'
import instagram from './platforms/instagram.mjs'
import linkedin from './platforms/linkedin.mjs'
import pinterest from './platforms/pinterest.mjs'
import youtube from './platforms/youtube.mjs'
import { loadSpec, resultsPath } from './spec.mjs'
import { fmtWhen, preview } from './util.mjs'

export const PLATFORMS = { facebook, instagram, youtube, pinterest, linkedin }
const DONE = new Set(['published', 'scheduled', 'queued'])

export const readResults = (spec) => readJson(resultsPath(spec), {})
const writeResults = (spec, r) => fs.writeFileSync(resultsPath(spec), JSON.stringify(r, null, 2) + '\n')

function history(entry) {
  fs.mkdirSync(path.dirname(paths.history), { recursive: true })
  fs.appendFileSync(paths.history, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
}

/**
 * Publish one spec. Each platform is independent: one failing does not stop
 * the others, and finished platforms are recorded in <spec>.result.json so a
 * re-run never posts the same thing twice (use --force to override).
 */
export async function publishSpec(file, { only, skip, at: atOverride, dryRun = false, force = false, fromQueue = false, approvedOnly = false } = {}) {
  const spec = loadSpec(file, { approvedOnly })
  const tz = spec.brand.timezone
  const at = atOverride === undefined ? spec.at : atOverride
  const results = readResults(spec)
  let targets = Object.keys(spec.platforms)
  if (only) targets = targets.filter((p) => only.includes(p))
  if (skip) targets = targets.filter((p) => !skip.includes(p))
  if (!targets.length) throw new Error('No platforms left to post to')

  const late = at && at.getTime() < Date.now() - 60_000
  if (late && !fromQueue) throw new Error(`The time ${fmtWhen(at, tz)} has passed. Use --at now or a new time.`)
  const future = at && at.getTime() > Date.now() + 2 * 60_000 ? at : null

  console.log(`\n${spec.brand.name || spec.brand.key} · ${path.basename(spec.file)} · ${spec.kind} · ${fmtWhen(future, tz)}${dryRun ? ' · DRY RUN' : ''}`)
  const useCloud = cloudEnabled()
  const host = dryRun || useCloud ? null : getHost()
  const uploads = new Map() // each file goes to the cloud once per post
  let failed = 0

  try {
    for (const p of targets) {
      const mod = PLATFORMS[p]
      const prev = results[p]
      if (!force && prev && DONE.has(prev.status) && !(fromQueue && prev.status === 'queued')) {
        console.log(`  ${p.padEnd(10)} already ${prev.status}${prev.url ? ` ${prev.url}` : ''} (use --force to post again)`)
        continue
      }
      let plan
      try {
        plan = mod.plan(spec)
      } catch (e) {
        console.log(`  ${p.padEnd(10)} ✗ ${e.message}`)
        if (!dryRun) {
          results[p] = { status: 'failed', error: e.message, time: new Date().toISOString() }
          writeResults(spec, results)
        }
        failed++
        continue
      }
      const mode = useCloud && mod.cloud ? 'cloud' : !future ? 'now' : mod.canSchedule(future, plan) ? 'native' : 'queue'
      const how = {
        now: 'post now',
        native: `schedule on ${p}`,
        queue: 'queue on this Mac (posted by the runner; the Mac must be awake)',
        cloud: `cloud scheduler posts it ${future ? 'on time' : 'within a minute'}`,
      }[mode]

      if (dryRun) {
        console.log(`  ${p.padEnd(10)} ${plan.kind || spec.kind} → ${how}`)
        if (plan.title) console.log(`             title: ${plan.title}`)
        const text = plan.description ?? plan.caption
        console.log(`             text (${text.length}): ${preview(text)}`)
        if (plan.link) console.log(`             link: ${plan.link}`)
        for (const w of plan.warnings) console.log(`             ⚠ ${w}`)
        continue
      }
      for (const w of plan.warnings) console.log(`  ${p.padEnd(10)} ⚠ ${w}`)

      if (mode === 'cloud') {
        try {
          process.stdout.write(`  ${p.padEnd(10)} sending to the cloud scheduler… `)
          const r = await sendToCloud({ mod, spec, platform: p, plan, at: future, uploads })
          results[p] = { status: 'scheduled', via: 'cloud', jobId: r.id, at: (future || new Date()).toISOString(), time: new Date().toISOString() }
          console.log(`✓ ${r.id}, posts ${fmtWhen(future, tz)}`)
        } catch (e) {
          failed++
          results[p] = { status: 'failed', error: e.message, time: new Date().toISOString() }
          console.log(`✗ ${e.message}`)
        }
        writeResults(spec, results)
        history({ brand: spec.brand.key, spec: spec.file, platform: p, ...results[p] })
        continue
      }

      if (mode === 'queue') {
        enqueue({ spec: spec.file, platform: p, at: future.toISOString(), brand: spec.brand.key, ...(approvedOnly ? { approvedOnly: true } : {}) })
        results[p] = { status: 'queued', at: future.toISOString(), time: new Date().toISOString() }
        writeResults(spec, results)
        console.log(`  ${p.padEnd(10)} queued for ${fmtWhen(future, tz)}`)
        continue
      }
      try {
        process.stdout.write(`  ${p.padEnd(10)} posting… `)
        const r = await mod.publish({ spec, plan, at: mode === 'native' ? future : null, host })
        results[p] = { ...r, at: future?.toISOString(), time: new Date().toISOString() }
        console.log(`✓ ${r.status}${r.url ? ` ${r.url}` : ''}${r.note ? `\n             ⚠ ${r.note}` : ''}`)
      } catch (e) {
        failed++
        results[p] = { status: 'failed', error: e.message, time: new Date().toISOString() }
        console.log(`✗ ${e.message}`)
      }
      writeResults(spec, results)
      history({ brand: spec.brand.key, spec: spec.file, platform: p, ...results[p] })
    }
  } finally {
    await host?.cleanup()
  }
  return { failed, results }
}

// ---- queue (platforms without native scheduling) ------------------------------

export const loadQueue = () => readJson(paths.queue, [])
const saveQueue = (q) => writePrivate(paths.queue, q)

function enqueue(item) {
  const q = loadQueue().filter((x) => !(x.spec === item.spec && x.platform === item.platform))
  q.push({ id: crypto.randomBytes(3).toString('hex'), ...item, createdAt: new Date().toISOString() })
  q.sort((a, b) => a.at.localeCompare(b.at))
  saveQueue(q)
}

export function removeFromQueue(id) {
  const q = loadQueue()
  const item = q.find((x) => x.id === id)
  if (!item) throw new Error(`No queued item ${id}`)
  saveQueue(q.filter((x) => x.id !== id))
  const resFile = item.spec.replace(/\.json$/i, '') + '.result.json'
  const r = readJson(resFile, {})
  if (r[item.platform]?.status === 'queued') {
    delete r[item.platform]
    fs.writeFileSync(resFile, JSON.stringify(r, null, 2) + '\n')
  }
  return item
}

function lock() {
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true })
  try {
    fs.writeFileSync(paths.lock, String(process.pid), { flag: 'wx' })
  } catch {
    const pid = Number(fs.readFileSync(paths.lock, 'utf8'))
    try {
      process.kill(pid, 0)
      return false // another run is going
    } catch {
      fs.writeFileSync(paths.lock, String(process.pid))
    }
  }
  return true
}

/** Posts every queued item that is due. Items more than maxLateMin late are marked missed, not posted. */
export async function runQueue({ maxLateMin = 180, notify = () => {} } = {}) {
  if (!lock()) return console.log('Another run is in progress.')
  try {
    const due = loadQueue().filter((x) => Date.parse(x.at) <= Date.now())
    for (const item of due) {
      saveQueue(loadQueue().filter((x) => x.id !== item.id))
      const lateMin = (Date.now() - Date.parse(item.at)) / 60_000
      if (lateMin > maxLateMin) {
        const msg = `${item.brand} ${item.platform}: missed (${Math.round(lateMin)} min late, Mac was probably asleep). Not posted.`
        console.log(msg)
        markMissed(item)
        history({ brand: item.brand, spec: item.spec, platform: item.platform, status: 'missed' })
        notify('Post missed', msg)
        continue
      }
      try {
        const { failed } = await publishSpec(item.spec, { only: [item.platform], at: null, fromQueue: true, approvedOnly: item.approvedOnly === true })
        if (failed) notify('Post failed', `${item.brand} ${item.platform}: see ${paths.runnerLog}`)
      } catch (e) {
        console.log(`${item.brand} ${item.platform}: ${e.message}`)
        notify('Post failed', `${item.brand} ${item.platform}: ${e.message}`)
      }
    }
  } finally {
    fs.rmSync(paths.lock, { force: true })
  }
}

function markMissed(item) {
  const resFile = item.spec.replace(/\.json$/i, '') + '.result.json'
  const r = readJson(resFile, {})
  r[item.platform] = { status: 'missed', at: item.at, time: new Date().toISOString() }
  if (fs.existsSync(path.dirname(resFile))) fs.writeFileSync(resFile, JSON.stringify(r, null, 2) + '\n')
}
