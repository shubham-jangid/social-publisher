import crypto from 'node:crypto'
import http from 'node:http'
import readline from 'node:readline/promises'

export const newState = () => crypto.randomBytes(16).toString('hex')

const PAGE = (ok, msg) =>
  `<!doctype html><meta charset="utf-8"><title>social-publisher</title>` +
  `<body style="font:16px system-ui;margin:3rem;max-width:36rem"><h2>${ok ? 'Done' : 'Not signed in'}</h2><p>${msg}</p></body>`

/**
 * Prints the sign-in link (never opens a browser itself: for Meta that would be
 * an agent opening facebook.com) and waits for the redirect on localhost.
 * With manual=true, asks for the address the browser landed on instead.
 */
export async function waitForCode({ authUrl, redirectUri, state, manual = false, note }) {
  if (note) console.log(`\n${note}`)
  console.log(`\nOpen this link in your own browser and approve:\n\n  ${authUrl}\n`)
  if (manual) return askPaste(state)

  const r = new URL(redirectUri)
  console.log(`Waiting for the browser to come back to ${r.origin}${r.pathname} … (Ctrl-C to stop)`)
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, r.origin)
      if (u.pathname !== r.pathname) {
        res.writeHead(404).end()
        return
      }
      const err = u.searchParams.get('error')
      const code = u.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
      if (err) {
        res.end(PAGE(false, `${err}: ${u.searchParams.get('error_description') || ''}`))
        finish(new Error(`Sign-in refused: ${err} ${u.searchParams.get('error_description') || ''}`.trim()))
      } else if (!code || u.searchParams.get('state') !== state) {
        res.end(PAGE(false, 'The link was missing its code or came from another sign-in. Start again.'))
        finish(new Error('Redirect had no code or a wrong state. Run the auth command again.'))
      } else {
        res.end(PAGE(true, 'Signed in. You can close this tab and go back to the terminal.'))
        finish(null, code)
      }
    })
    const timer = setTimeout(() => finish(new Error('Timed out after 10 minutes waiting for the sign-in.')), 600_000)
    function finish(e, code) {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections()
      e ? reject(e) : resolve(code)
    }
    server.on('error', (e) =>
      reject(new Error(`Could not listen on ${r.host} (${e.code}). Run the same command with --manual.`)),
    )
    server.listen(Number(r.port || 80), r.hostname)
  })
}

async function askPaste(state) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      'After approving, the browser goes to a page that may not load.\nCopy the whole address from the address bar and paste it here:\n> ',
    )
    const u = new URL(answer.trim())
    const code = u.searchParams.get('code')
    if (!code) throw new Error('That address has no ?code= in it.')
    if (u.searchParams.get('state') && u.searchParams.get('state') !== state) throw new Error('State mismatch; start again.')
    return code
  } finally {
    rl.close()
  }
}
