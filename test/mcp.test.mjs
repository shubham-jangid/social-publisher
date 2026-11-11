// Talks to mcp/server.mjs over stdio like an MCP client would.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('mcp: lists tools, previews, and refuses to schedule media outside the approved folder', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-'))
  const approved = path.join(tmp, 'approved')
  const drafts = path.join(tmp, 'drafts')
  fs.mkdirSync(approved)
  fs.mkdirSync(drafts)
  fs.mkdirSync(path.join(tmp, 'brands'))
  fs.mkdirSync(path.join(tmp, 'config'))
  fs.writeFileSync(path.join(tmp, 'brands', 't.json'), JSON.stringify({ name: 'T', approvedDirs: [approved], youtube: { channelId: 'UC1', madeForKids: false } }))
  fs.writeFileSync(path.join(drafts, 'v.mp4'), 'x')
  fs.writeFileSync(path.join(approved, 'v.mp4'), 'x')

  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, SOCIAL_CONFIG_DIR: path.join(tmp, 'config'), SOCIAL_BRANDS_DIR: path.join(tmp, 'brands'), SOCIAL_NO_CLEAN: '1' },
  })
  const replies = new Map()
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l)
    replies.get(m.id)?.(m)
  })
  let n = 0
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n
      replies.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const callTool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.result.serverInfo.name, 'social-publisher')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const tools = (await rpc('tools/list')).result.tools.map((t) => t.name)
    assert.deepEqual(tools.sort(), ['add_to_plan', 'analytics', 'calendar', 'cancel_post', 'check_accounts', 'create_post', 'list_brands', 'list_queue', 'post_history', 'preview_post', 'schedule_post'])

    const draftSpec = path.join(tmp, 'posts', 'draft.json')
    const made = await callTool('create_post', { path: draftSpec, brand: 't', media: path.join(drafts, 'v.mp4'), caption: 'Hi', title: 'Hi', platforms: { youtube: {} } })
    assert.ok(!made.isError, made.content[0].text)
    assert.match(made.content[0].text, /will refuse it/)

    const refused = await callTool('schedule_post', { spec_path: draftSpec })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /not in an approved folder/)

    const okSpec = path.join(tmp, 'posts', 'ok.json')
    await callTool('create_post', { path: okSpec, brand: 't', media: path.join(approved, 'v.mp4'), caption: 'Hi', title: 'Hello', platforms: { youtube: {} } })
    const prev = await callTool('preview_post', { spec_path: okSpec })
    assert.ok(!prev.isError, prev.content[0].text)
    assert.match(prev.content[0].text, /DRY RUN/)
    assert.match(prev.content[0].text, /title: Hello/)
    assert.match(prev.content[0].text, /✓ Media is in the approved folder/)

    const dup = await callTool('create_post', { path: okSpec, brand: 't', media: path.join(approved, 'v.mp4') })
    assert.equal(dup.isError, true, 'never overwrites by accident')

    // flag smuggling: values that start with -- never become CLI flags
    for (const bad of [{ at: '--force' }, { at: 'now --force' }, { at: '2026-13-45 99:99' }, { only: ['--force'] }, { skip: ['youtube', '--force'] }, { only: '--dry-run' }]) {
      const r = await callTool('schedule_post', { spec_path: okSpec, ...bad })
      assert.equal(r.isError, true, JSON.stringify(bad))
      assert.match(r.content[0].text, /"at" must be|"at" is not|takes facebook|Can.t read time/, JSON.stringify(bad))
    }
    assert.equal((await callTool('cancel_post', { id: '--force' })).isError, true)
    assert.match((await callTool('calendar', { brand: '--problems' })).content[0].text, /unknown brand/)
    assert.match((await callTool('add_to_plan', { brand: 't', platforms: ['youtube'], at: '--x', title: 't' })).content[0].text, /"at" must be/)
    assert.match((await callTool('check_accounts', { brands: ['--json'] })).content[0].text, /unknown brand/)

    // create_post never writes into settings, brand files, the tool itself or a .claude folder
    const before = fs.readFileSync(path.join(tmp, 'brands', 't.json'), 'utf8')
    for (const target of [
      path.join(tmp, 'config', 'tokens.json'),
      path.join(tmp, 'config', 'new', 'apps.json'),
      path.join(tmp, 'brands', 't.json'),
      path.join(ROOT, 'package.json'),
      path.join(tmp, 'proj', '.claude', 'settings.json'),
      path.join(tmp, 'posts', 'ok.result.json'),
    ]) {
      const r = await callTool('create_post', { path: target, brand: 't', media: path.join(approved, 'v.mp4'), overwrite: true })
      assert.equal(r.isError, true, target)
      assert.match(r.content[0].text, /refusing to write|must not end/, target)
    }
    fs.symlinkSync(path.join(tmp, 'brands'), path.join(tmp, 'link-to-brands'))
    const viaLink = await callTool('create_post', { path: path.join(tmp, 'link-to-brands', 't.json'), brand: 't', media: path.join(approved, 'v.mp4'), overwrite: true })
    assert.match(viaLink.content[0].text, /refusing to write/, 'a symlink cannot lead into a forbidden folder')
    assert.equal(fs.readFileSync(path.join(tmp, 'brands', 't.json'), 'utf8'), before)
    assert.ok(!fs.existsSync(path.join(tmp, 'config', 'tokens.json')))

    // a post that fails validation is not written at all
    const invalid = path.join(tmp, 'posts', 'invalid.json')
    const inv = await callTool('create_post', { path: invalid, brand: 't', media: path.join(approved, 'missing.mp4') })
    assert.equal(inv.isError, true)
    assert.ok(!fs.existsSync(invalid), 'validated before writing')
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'posts')).filter((f) => f.includes('.check.')), [], 'no leftovers')

    // caption files must be approved too; text-only posts are fine when their caption file is
    fs.writeFileSync(path.join(drafts, 'cap.txt'), 'draft caption')
    fs.writeFileSync(path.join(approved, 'cap.txt'), 'approved caption')
    const capSpec = path.join(tmp, 'posts', 'cap.json')
    await callTool('create_post', { path: capSpec, brand: 't', media: path.join(approved, 'v.mp4'), caption_file: path.join(drafts, 'cap.txt'), title: 'T', platforms: { youtube: {} } })
    const capRefused = await callTool('schedule_post', { spec_path: capSpec })
    assert.equal(capRefused.isError, true)
    assert.match(capRefused.content[0].text, /cap\.txt is not in an approved folder/)
    const perPlatform = path.join(tmp, 'posts', 'cap2.json')
    await callTool('create_post', { path: perPlatform, brand: 't', media: path.join(approved, 'v.mp4'), caption: 'ok', title: 'T', platforms: { youtube: { captionFile: path.join(drafts, 'cap.txt') } } })
    assert.match((await callTool('schedule_post', { spec_path: perPlatform })).content[0].text, /not in an approved folder/)
  } finally {
    child.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
