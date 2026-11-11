#!/usr/bin/env node
// MCP server for social-publisher (stdio, no dependencies).
//
// Lets any MCP client (Claude Code, the Claude desktop app, …) preview and
// schedule posts. It runs the `social` command line for every action, so the
// rules are the same as on the terminal, plus one more: schedule_post only
// accepts media from the brand's approved folders (brand file → approvedDirs),
// so a draft can never be posted by mistake.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'social.mjs')
const run = promisify(execFile)

const { BRANDS_DIR, CONFIG_DIR, listBrands, loadBrand } = await import('../src/config.mjs')
const { PLATFORM_NAMES, approvalProblems: problemsOf, loadSpec, realPath } = await import('../src/spec.mjs')
const { expandHome, parseWhen } = await import('../src/util.mjs')

// ---- the CLI, as a child process ----------------------------------------------------

async function social(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { maxBuffer: 10e6, timeout: 30 * 60_000, env: process.env })
    return { ok: true, text: (stdout + stderr).trim() }
  } catch (e) {
    return { ok: false, text: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message }
  }
}

// ---- arguments ---------------------------------------------------------------------------
// Every value reaches the CLI as --name=value (never as a separate word), after a check, so a
// value such as "--force" can never turn into a flag of its own.

const flag = (name, v) => `--${name}=${v}`

/** "now", "2026-11-06 18:30" (brand time zone) or ISO with an offset; anything else is refused. */
function atArg(v) {
  if (v === undefined || v === null || v === '') return []
  const s = String(v).trim()
  const ok =
    s === 'now' ||
    /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}$/.test(s) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)
  if (!ok) throw new Error(`"at" must be "now", "2026-11-06 18:30" or ISO with an offset, not ${JSON.stringify(s).slice(0, 60)}`)
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/)
  if (m && (+m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31 || +m[3] > 23 || +m[4] > 59)) throw new Error(`"at" is not a real time: ${s}`)
  parseWhen(s) // a real date
  return [flag('at', s)]
}

/** only / skip: names from the platform list. */
function platformsArg(name, v) {
  if (v === undefined || v === null) return []
  const list = [].concat(v)
  if (!list.length) return []
  const bad = list.filter((p) => !PLATFORM_NAMES.includes(p))
  if (bad.length) throw new Error(`"${name}" takes ${PLATFORM_NAMES.join(', ')}; not ${bad.map((b) => JSON.stringify(b)).join(', ')}`)
  return [flag(name, list.join(','))]
}

function brandArg(v) {
  if (typeof v !== 'string' || !listBrands().includes(v)) throw new Error(`unknown brand ${JSON.stringify(v)} (see list_brands)`)
  return v
}

const intArg = (v, def) => {
  const n = v === undefined || v === null ? def : Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`not a usable number: ${JSON.stringify(v)}`)
  return String(n)
}

const textArg = (name, v) => {
  if (typeof v !== 'string') throw new Error(`"${name}" must be text`)
  return flag(name, v)
}

/** A spec path: absolute after resolving, so it can never look like a flag. */
const specPathArg = (v) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error('spec_path is required')
  return path.resolve(expandHome(v))
}

// ---- approved-folder rule -------------------------------------------------------------

/** Every media file, the cover and every caption file must sit inside one of the brand's approvedDirs. */
function approvalProblems(specPath) {
  return problemsOf(loadSpec(specPath, { keepMetadata: true })) // the owner's files, not the cleaned copies
}

// ---- where create_post may write ---------------------------------------------------------

/** Folders a post file must never be written into: the tool's settings and sign-ins, its brands and its own code. */
function forbiddenDirs() {
  return [CONFIG_DIR, BRANDS_DIR, ROOT, path.join(os.homedir(), '.claude')].map((d) => realPath(expandHome(d)))
}

/** Resolves symlinks in the part of the path that exists, so a link cannot lead into a forbidden folder. */
function realTarget(file) {
  let dir = path.dirname(file)
  const rest = [path.basename(file)]
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir))
    dir = path.dirname(dir)
  }
  const target = path.join(realPath(dir), ...rest)
  return fs.existsSync(target) ? realPath(target) : target
}

function checkPostPath(file) {
  if (!file.endsWith('.json')) throw new Error('path must end in .json')
  if (file.endsWith('.result.json')) throw new Error('path must not end in .result.json (that is where results are kept)')
  const target = realTarget(file)
  const inside = (d) => target === d || target.startsWith(d + path.sep)
  const hit = forbiddenDirs().find(inside)
  if (hit) throw new Error(`refusing to write ${file}: it is inside ${hit} (settings, sign-ins, brand files or the tool itself)`)
  if (target.split(path.sep).includes('.claude')) throw new Error(`refusing to write ${file}: it is inside a .claude folder`)
}

// ---- tools ------------------------------------------------------------------------------

const specProp = { type: 'string', description: 'Absolute path to the post file (JSON). See create_post.' }
const atProp = { type: 'string', description: 'Post time, "2026-11-06 18:30" in the brand time zone, ISO with offset, or "now". Default: the post file\'s "at".' }
const platformsList = { type: 'array', items: { type: 'string', enum: ['facebook', 'instagram', 'youtube', 'pinterest', 'linkedin'] } }

const TOOLS = [
  {
    name: 'list_brands',
    description: 'Brands this tool can post for, with their platforms and approved media folders.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      return listBrands()
        .map((k) => {
          const b = loadBrand(k)
          const plats = ['facebook', 'instagram', 'youtube', 'pinterest', 'linkedin'].filter((p) => b[p])
          return `${k} (${b.name}): ${plats.join(', ')}\n  default platforms: ${(b.defaults?.platforms || []).join(', ')}\n  approved folders: ${(b.approvedDirs || []).join(', ') || 'none'}`
        })
        .join('\n')
    },
  },
  {
    name: 'check_accounts',
    description: 'Tests every platform sign-in for the given brands (all if none). Read-only.',
    inputSchema: { type: 'object', properties: { brands: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
    async run({ brands = [] }) {
      const r = await social(['check', ...[].concat(brands).map(brandArg)])
      return r.text
    },
  },
  {
    name: 'create_post',
    description:
      'Writes a post file (JSON) that preview_post and schedule_post use. Media paths should point at the approved copies. ' +
      'Does not post anything.',
    inputSchema: {
      type: 'object',
      required: ['path', 'brand', 'media'],
      properties: {
        path: { type: 'string', description: 'Where to write it, e.g. <project>/posts/spring-reel.json' },
        brand: { type: 'string' },
        media: { description: 'One video, or a list of images (carousel)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        cover: { type: 'string' },
        caption: { type: 'string' },
        caption_file: { type: 'string' },
        title: { type: 'string', description: 'YouTube / Facebook / Pinterest title' },
        link: { type: 'string' },
        at: atProp,
        ai: { type: 'boolean', description: 'true when visuals are AI-made (adds the label / disclosure line)' },
        campaign: { type: 'string' },
        platforms: { type: 'object', description: 'Per-platform overrides, e.g. {"youtube":{"tags":["x"]},"pinterest":{"board":"songs"}}. Omit for the brand defaults.' },
        overwrite: { type: 'boolean' },
      },
    },
    async run(a) {
      if (typeof a.path !== 'string' || !a.path.trim()) throw new Error('path is required')
      const file = path.resolve(expandHome(a.path))
      checkPostPath(file)
      if (fs.existsSync(file) && !a.overwrite) throw new Error(`${file} already exists (set overwrite: true to replace it)`)
      loadBrand(brandArg(a.brand))
      if (a.at !== undefined) atArg(a.at)
      const spec = {
        brand: a.brand,
        id: path.basename(file, '.json'),
        campaign: a.campaign,
        media: a.media,
        cover: a.cover,
        caption: a.caption,
        captionFile: a.caption_file,
        title: a.title,
        link: a.link,
        ai: a.ai,
        at: a.at,
        platforms: a.platforms,
      }
      for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k]
      // Validate first (paths are relative to the post file, so check a copy next to it), then write.
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = path.join(path.dirname(file), `.${path.basename(file, '.json')}.${process.pid}.${Date.now()}.check.json`)
      let problems
      try {
        fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' })
        loadSpec(tmp, { keepMetadata: true }) // validates paths and fields
        problems = approvalProblems(tmp)
        checkPostPath(file) // once more, right before the write
        fs.renameSync(tmp, file)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return `Wrote ${file}.${problems.length ? `\n\n⚠ schedule_post will refuse it until this is fixed:\n- ${problems.join('\n- ')}` : ''}\nNext: preview_post.`
    },
  },
  {
    name: 'preview_post',
    description: 'Dry run: shows, for each platform, the final caption, title, link, how it will be posted and any warning. Posts nothing.',
    inputSchema: { type: 'object', required: ['spec_path'], properties: { spec_path: specProp, at: atProp, only: platformsList, skip: platformsList } },
    annotations: { readOnlyHint: true },
    async run(a) {
      const file = specPathArg(a.spec_path)
      const args = [...atArg(a.at), ...platformsArg('only', a.only), ...platformsArg('skip', a.skip)]
      const problems = approvalProblems(file)
      const r = await social(['post', file, '--dry-run', ...args])
      const gate = problems.length ? `\n\n✗ Not schedulable yet:\n- ${problems.join('\n- ')}` : '\n\n✓ Media is in the approved folder. Show this to the owner and get a yes before schedule_post.'
      if (!r.ok) throw new Error(r.text + gate)
      return r.text + gate
    },
  },
  {
    name: 'schedule_post',
    description:
      'Schedules (or posts, for "now") a post on every platform in its file. Facebook and YouTube are scheduled on the platform itself; ' +
      'Instagram, Pinterest and LinkedIn go to the cloud scheduler. Only use after preview_post and the owner\'s explicit yes. ' +
      'Refuses media outside the brand\'s approved folders. A platform already scheduled or posted is skipped, never posted twice.',
    inputSchema: { type: 'object', required: ['spec_path'], properties: { spec_path: specProp, at: atProp, only: platformsList, skip: platformsList } },
    annotations: { destructiveHint: true, openWorldHint: true },
    async run(a) {
      const file = specPathArg(a.spec_path)
      const args = [...atArg(a.at), ...platformsArg('only', a.only), ...platformsArg('skip', a.skip)]
      const problems = approvalProblems(file)
      if (problems.length) throw new Error(`Not scheduled:\n- ${problems.join('\n- ')}`)
      // --approved-only: the CLI checks every file again as it loads the post, and uploads only its own copies.
      const r = await social(['post', file, '--approved-only', ...args])
      if (!r.ok) throw new Error(r.text)
      return r.text
    },
  },
  {
    name: 'list_queue',
    description: 'Posts waiting to go out (cloud scheduler and this Mac), plus recent failures.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      return (await social(['queue'])).text
    },
  },
  {
    name: 'cancel_post',
    description: 'Cancels one waiting item by the id list_queue shows (j_… for the cloud scheduler). Cannot undo a post already published.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    annotations: { destructiveHint: true },
    async run({ id }) {
      if (typeof id !== 'string' || !/^(j_[0-9a-f]+|[0-9a-f]{6})$/.test(id)) throw new Error('id must be an id from list_queue (j_… or 6 hex characters)')
      const r = await social(['queue', 'remove', id])
      if (!r.ok) throw new Error(r.text)
      return r.text
    },
  },
  {
    name: 'post_history',
    description: 'What was posted, scheduled or failed recently, with links.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    annotations: { readOnlyHint: true },
    async run({ limit = 20 }) {
      return (await social(['history', intArg(limit, 20)])).text
    },
  },
  {
    name: 'calendar',
    description:
      'The content calendar: for each brand and platform, what is published, scheduled, planned, and NOT published ' +
      '(a planned post whose time passed with no matching post on that platform), plus stuck/failed/missed posts. ' +
      'Reads what the platforms really show (synced every 3 h; set sync: true to check now). The owner sees the same at <worker>/app.',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string' },
        past_days: { type: 'number', description: 'Default 7' },
        days: { type: 'number', description: 'Days ahead, default 14' },
        problems_only: { type: 'boolean' },
        sync: { type: 'boolean', description: 'Read every platform first (about 10 requests per brand)' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      let pre = ''
      const brand = a.brand ? brandArg(a.brand) : null
      const args = [...(brand ? [flag('brand', brand)] : []), flag('past', intArg(a.past_days, 7)), flag('days', intArg(a.days, 14)), ...(a.problems_only ? ['--problems'] : [])]
      if (a.sync) pre = (await social(['sync', ...(brand ? [brand] : [])])).text + '\n\n'
      const r = await social(['calendar', ...args])
      if (!r.ok) throw new Error(r.text)
      return pre + r.text
    },
  },
  {
    name: 'analytics',
    description:
      'How published posts perform, per brand and platform: views, likes, comments, shares, saves, and on YouTube watch time and ' +
      '% watched. Ranks the top posts, compares formats (Short vs video, Reel vs post) and the same video across platforms. ' +
      'Numbers are synced every 3 h with the calendar (sync: true reads now). Use it to decide what to make more of.',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string' },
        days: { type: 'number', description: 'Look back this many days, default 30' },
        platform: { type: 'string', enum: ['facebook', 'instagram', 'youtube', 'pinterest'] },
        top: { type: 'number', description: 'How many top posts to list, default 10' },
        sync: { type: 'boolean', description: 'Read every platform first' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      let pre = ''
      const brand = a.brand ? brandArg(a.brand) : null
      if (a.platform && !PLATFORM_NAMES.includes(a.platform)) throw new Error(`unknown platform ${JSON.stringify(a.platform)}`)
      const args = [...(brand ? [flag('brand', brand)] : []), ...(a.platform ? [flag('platform', a.platform)] : []), flag('days', intArg(a.days, 30)), flag('top', intArg(a.top, 10))]
      if (a.sync) pre = (await social(['sync', ...(brand ? [brand] : [])])).text + '\n\n'
      const r = await social(['analytics', ...args])
      if (!r.ok) throw new Error(r.text)
      return pre + r.text
    },
  },
  {
    name: 'add_to_plan',
    description:
      'Adds planned posts to the calendar (one per platform) so the owner can see what is still to go out, and what was missed. ' +
      'Posts nothing. A plan item counts as done when a post on that platform within 36 h contains its match text (default: the title).',
    inputSchema: {
      type: 'object',
      required: ['brand', 'platforms', 'at', 'title'],
      properties: {
        brand: { type: 'string' },
        platforms: platformsList,
        at: { type: 'string', description: '"2026-11-06 19:00" in the brand time zone' },
        title: { type: 'string', description: 'Short label, e.g. "Spring reel, part 2"' },
        match: { type: 'array', items: { type: 'string' }, description: 'Words from the caption or YouTube title that identify the post' },
        note: { type: 'string' },
      },
    },
    async run(a) {
      if (!a.at || a.at === 'now') throw new Error('"at" must be a time such as "2026-11-06 19:00"')
      const plats = platformsArg('platforms', a.platforms)
      if (!plats.length) throw new Error('"platforms" is required')
      const args = ['plan', 'add', flag('brand', brandArg(a.brand)), ...plats, ...atArg(a.at), textArg('title', a.title)]
      if (a.match?.length) args.push(textArg('match', [].concat(a.match).map(String).join('|')))
      if (a.note) args.push(textArg('note', a.note))
      const r = await social(args)
      if (!r.ok) throw new Error(r.text)
      return r.text
    },
  },
]

// ---- JSON-RPC over stdio ---------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const SERVER = { name: 'social-publisher', version: '0.3.0' }

async function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // notification
  try {
    if (method === 'initialize')
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions:
            'Posts to Facebook, Instagram, YouTube, Pinterest and LinkedIn through official APIs. ' +
            'Flow: create_post → preview_post → show the owner the preview and wait for an explicit yes → schedule_post. ' +
            'Never schedule a draft; schedule_post only accepts media from the brand\'s approved folders. ' +
            'calendar shows what is published / scheduled / not published per brand and platform; add_to_plan records what should go out; ' +
            'analytics shows which posts get views and engagement.',
        },
      })
    if (method === 'ping') return send({ id, result: {} })
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } })
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } })
      try {
        const text = await tool.run(params.arguments || {})
        return send({ id, result: { content: [{ type: 'text', text: String(text || 'Done.') }] } })
      } catch (e) {
        return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } })
      }
    }
    if (method === 'resources/list') return send({ id, result: { resources: [] } })
    if (method === 'prompts/list') return send({ id, result: { prompts: [] } })
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (e) {
    return send({ id, error: { code: -32603, message: e.message } })
  }
}

// One request at a time, in order.
let chain = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  chain = chain.then(() => handle(msg))
})
