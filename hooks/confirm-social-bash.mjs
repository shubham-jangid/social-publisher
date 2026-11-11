#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool: asks the human before a shell command that
// posts, schedules, retries or cancels through social-publisher, publishes a blog post,
// deploys or pushes sign-ins to the cloud scheduler, or calls the scheduler's /api/ directly.
// Every other command gets no answer from this hook, so the normal permission rules apply.
//
// This catches mistakes, not a hostile agent: anything with a shell can write a script,
// rename the binary or read the API token and get around a text match.
//
// Register it in ~/.claude/settings.json (see README → "Approval hooks"):
//   "PreToolUse": [{ "matcher": "Bash",
//                    "hooks": [{ "type": "command", "command": "node /path/to/hooks/confirm-social-bash.mjs" }] }]

// `social post …`, `node bin/social.mjs blog schedule …`, `social queue retry …`, `social cloud deploy` …
const SOCIAL = /\bsocial(?:\.mjs)?["']?\s+(?:post\b|blog\s+schedule\b|queue\s+(?:retry|remove)\b|cloud\s+(?:deploy|push)\b)/i
// curl / wget / fetch to <anything>.workers.dev/…/api/…
const FETCHER = /\b(?:curl|wget|fetch)\b/i
const WORKER_API = /[\w.-]+\.workers\.dev(?::\d+)?\/(?:[^\s'"]*\/)?api\//i

function reasonFor(command) {
  const cmd = String(command || '')
  if (SOCIAL.test(cmd)) return 'This shell command posts, schedules, cancels or deploys through social-publisher.'
  if (FETCHER.test(cmd) && WORKER_API.test(cmd)) return 'This shell command calls the cloud scheduler API (*.workers.dev/api/).'
  return null
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let data = {}
  try {
    data = JSON.parse(raw)
  } catch {
    data = { tool_input: { command: raw } } // unreadable input: still look at the text
  }
  const command = data?.tool_input?.command ?? ''
  const why = reasonFor(command)
  if (!why) return // no opinion: normal permissions apply
  const shown = String(command).length > 300 ? `${String(command).slice(0, 300)}…` : String(command)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `${why}\n${shown}\nA public post can't be taken back.`,
      },
    }) + '\n',
  )
})
