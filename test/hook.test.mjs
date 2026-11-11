// The Claude Code approval hooks: the MCP one always asks and shows what will go out;
// the Bash one asks for posting / deploying commands and stays silent otherwise.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks')
const runRaw = (hook, input) => execFileSync(process.execPath, [path.join(HOOKS, hook)], { input }).toString()
const run = (input) => JSON.parse(runRaw('confirm-social-post.mjs', input)).hookSpecificOutput

test('approval hook asks before schedule_post and cancel_post', () => {
  const a = run(JSON.stringify({ tool_name: 'mcp__social-publisher__schedule_post', tool_input: { spec_path: '/p/post.json' } }))
  assert.equal(a.permissionDecision, 'ask')
  assert.match(a.permissionDecisionReason, /Post \/ schedule .*\/p\/post\.json/)
  const b = run(JSON.stringify({ tool_name: 'mcp__social-publisher__cancel_post', tool_input: { id: 'j_1' } }))
  assert.match(b.permissionDecisionReason, /^Cancel .*j_1/)
  assert.equal(run('not json').permissionDecision, 'ask', 'still asks on bad input')
})

test('approval hook shows at / only / skip, the media and the first 200 characters of the caption', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hook-'))
  try {
    const caption = 'Hello there. ' + 'x'.repeat(400) + ' TAIL'
    fs.writeFileSync(path.join(tmp, 'caption.txt'), caption)
    const spec = path.join(tmp, 'p.json')
    fs.writeFileSync(spec, JSON.stringify({ brand: 'b1', captionFile: 'caption.txt', platforms: { linkedin: {} } }))
    const a = run(JSON.stringify({ tool_name: 'mcp__social-publisher__schedule_post', tool_input: { spec_path: spec, at: '--force', only: ['--force'], skip: ['youtube'] } }))
    const r = a.permissionDecisionReason
    assert.equal(a.permissionDecision, 'ask')
    assert.match(r, /at: --force/)
    assert.match(r, /only: --force/)
    assert.match(r, /skip: youtube/)
    assert.match(r, /media: none \(text-only post\)/)
    assert.match(r, /caption: "Hello there\. x+…"/)
    assert.ok(!r.includes('TAIL'), 'only the first 200 characters')
    assert.equal(r.match(/caption: "(.*)…"/)[1].length, 200)

    fs.writeFileSync(spec, JSON.stringify({ brand: 'b1', media: 'clip.mp4', caption: 'Short one' }))
    const b = run(JSON.stringify({ tool_name: 'mcp__social-publisher__schedule_post', tool_input: { spec_path: spec } }))
    assert.match(b.permissionDecisionReason, /media: clip\.mp4/)
    assert.match(b.permissionDecisionReason, /caption: "Short one"/)
    assert.match(b.permissionDecisionReason, /at: \(time in file\)/)

    const c = run(JSON.stringify({ tool_name: 'mcp__social-publisher__schedule_post', tool_input: { spec_path: path.join(tmp, 'missing.json') } }))
    assert.equal(c.permissionDecision, 'ask')
    assert.match(c.permissionDecisionReason, /could not read the post file/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('bash hook asks for posting, scheduling, retrying, cancelling, deploying and direct API calls', () => {
  const ask = [
    'social post posts/a.json',
    'social post posts/a.json --dry-run',
    'node bin/social.mjs post /x/a.json --at now',
    'node ~/tools/social-publisher/bin/social.mjs blog schedule --brand b1 --slug s --at "2026-11-21 09:00"',
    'cd /x && social queue retry j_abc',
    'social queue remove j_abc',
    'social cloud deploy',
    'social cloud push',
    'curl -X POST https://sched.someone.workers.dev/api/jobs -H "authorization: Bearer x"',
    'wget -qO- "https://a-b.c.workers.dev/api/secrets"',
    'node -e "fetch(\'https://x.workers.dev/api/run\',{method:\'POST\'})"',
  ]
  for (const command of ask) {
    const out = runRaw('confirm-social-bash.mjs', JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
    const h = JSON.parse(out).hookSpecificOutput
    assert.equal(h.permissionDecision, 'ask', command)
    assert.ok(h.permissionDecisionReason.includes(command.slice(0, 40)), command)
  }
  const quiet = [
    'social queue',
    'social history 20',
    'social calendar --brand b1',
    'social cloud status',
    'git commit -m "post about social"',
    'curl https://example.com/api/x',
    'curl https://x.workers.dev/app',
    'ls posts',
  ]
  for (const command of quiet) assert.equal(runRaw('confirm-social-bash.mjs', JSON.stringify({ tool_name: 'Bash', tool_input: { command } })), '', command)
})
