import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { request, ApiError } from '../src/http.mjs'
import { waitForCode } from '../src/oauth.mjs'
import { blobOf } from '../src/media.mjs'

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s))
  })
}

test('GET retries a 500, POST does not (no double posts)', async () => {
  let hits = 0
  const s = await server((req, res) => {
    hits++
    if (req.method === 'GET' && hits === 1) return res.writeHead(500).end('{"error":{"message":"boom"}}')
    if (req.method === 'POST') return res.writeHead(500).end('{"error":{"message":"boom","code":2}}')
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
  })
  const base = `http://127.0.0.1:${s.address().port}`
  assert.deepEqual(await request('t', `${base}/x?access_token=SECRET`), { ok: true })
  assert.equal(hits, 2)
  hits = 0
  await assert.rejects(request('t', `${base}/x?access_token=SECRET`, { method: 'POST', form: { a: 1 } }), (e) => {
    assert.ok(e instanceof ApiError)
    assert.match(e.message, /boom · code 2/)
    assert.ok(!e.url.includes('SECRET'))
    return true
  })
  assert.equal(hits, 1)
  s.close()
  s.closeAllConnections()
})

test('file uploads stream the bytes as sent', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blob-')), 'a.mp4')
  fs.writeFileSync(file, Buffer.alloc(300_000, 7))
  let got = 0
  const s = await server((req, res) => {
    req.on('data', (c) => (got += c.length))
    req.on('end', () => res.writeHead(200).end('{}'))
  })
  await request('t', `http://127.0.0.1:${s.address().port}/u`, { method: 'POST', body: await blobOf(file) })
  assert.equal(got, 300_000)
  s.close()
  s.closeAllConnections()
})

test('oauth callback returns the code and rejects a wrong state', async () => {
  const redirectUri = 'http://127.0.0.1:8599/callback'
  const log = console.log
  console.log = () => {}
  try {
    const p = waitForCode({ authUrl: 'https://example.com/auth', redirectUri, state: 'abc' })
    await new Promise((r) => setTimeout(r, 100))
    await fetch(`${redirectUri}?code=XYZ&state=abc`)
    assert.equal(await p, 'XYZ')
    const p2 = assert.rejects(waitForCode({ authUrl: 'https://example.com/auth', redirectUri, state: 'abc' }), /wrong state/)
    await new Promise((r) => setTimeout(r, 100))
    await fetch(`${redirectUri}?code=XYZ&state=evil`)
    await p2
  } finally {
    console.log = log
  }
})
