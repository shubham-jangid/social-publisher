#!/usr/bin/env node
// Claude Code PreToolUse hook: always ask the human before the social-publisher MCP server
// schedules, posts or cancels anything. It asks even when the session runs in a mode that
// skips permission prompts, because a public post can't be taken back.
//
// The question shows what will really go out: the post file, its brand, media and the first
// 200 characters of its caption, plus the at / only / skip the agent passed.
//
// Register it in ~/.claude/settings.json (see README → "Approval hooks"):
//   "PreToolUse": [{ "matcher": "mcp__social-publisher__(schedule_post|cancel_post)",
//                    "hooks": [{ "type": "command", "command": "node /path/to/hooks/confirm-social-post.mjs" }] }]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CAPTION_CHARS = 200
const MAX_FILE = 1e6

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v))
const home = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

function readSmall(file) {
  const st = fs.statSync(file)
  if (!st.isFile() || st.size > MAX_FILE) throw new Error('not a small file')
  return fs.readFileSync(file, 'utf8')
}

/** What the post file says, best effort: never throws. */
function describeSpec(specPath) {
  const lines = []
  try {
    const file = path.resolve(home(String(specPath)))
    const spec = JSON.parse(readSmall(file))
    const dir = path.dirname(file)
    lines.push(`brand: ${spec.brand ?? '?'}`)
    const media = [].concat(spec.media || [])
    lines.push(`media: ${media.length ? media.join(', ') : 'none (text-only post)'}`)
    if (spec.cover) lines.push(`cover: ${spec.cover}`)
    if (spec.at) lines.push(`time in file: ${spec.at}`)
    if (spec.platforms && typeof spec.platforms === 'object') lines.push(`platforms in file: ${Object.keys(spec.platforms).join(', ')}`)
    let caption = typeof spec.caption === 'string' ? spec.caption : null
    if (caption === null && typeof spec.captionFile === 'string') {
      try {
        caption = readSmall(path.resolve(dir, home(spec.captionFile)))
      } catch {
        caption = `(could not read caption file ${spec.captionFile})`
      }
    }
    lines.push(`caption: ${caption === null ? '(none)' : `"${oneLine(caption, CAPTION_CHARS)}"`}`)
  } catch (e) {
    lines.push(`(could not read the post file: ${e.message})`)
  }
  return lines
}

function decide(data) {
  const tool = String(data?.tool_name || '')
  const args = (data && typeof data.tool_input === 'object' && data.tool_input) || {}
  let reason
  if (tool.endsWith('cancel_post')) {
    reason = `Cancel on social media: ${args.id ?? ''}.`
  } else {
    const parts = [`Post / schedule on social media: ${args.spec_path ?? ''}`]
    if (args.spec_path) parts.push(...describeSpec(args.spec_path))
    parts.push(`at: ${args.at !== undefined ? show(args.at) : '(time in file)'}`)
    if (args.only !== undefined) parts.push(`only: ${show(args.only)}`)
    if (args.skip !== undefined) parts.push(`skip: ${show(args.skip)}`)
    parts.push('Check the preview first.')
    reason = parts.join('\n')
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let data = {}
  try {
    data = JSON.parse(raw)
  } catch {}
  let out
  try {
    out = decide(data)
  } catch {
    out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Social media action (details unreadable). Check the preview first.' } }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
})
