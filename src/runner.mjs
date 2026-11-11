// macOS launchd job that runs `social run` every 5 minutes so queued posts
// (Instagram, Pinterest, LinkedIn) go out on time. The Mac must be awake.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_DIR, ROOT, paths } from './config.mjs'

const LABEL = 'com.social-publisher.runner'
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function installRunner() {
  const bin = path.join(ROOT, 'bin', 'social.mjs')
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(bin)}</string><string>run</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(paths.runnerLog)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.runnerLog)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(`${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
</dict>
</plist>
`
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
  } catch {}
  fs.writeFileSync(PLIST, plist)
  execFileSync('launchctl', ['load', PLIST])
  console.log(`Runner installed: every 5 minutes. Log: ${paths.runnerLog}`)
}

export function uninstallRunner() {
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
  } catch {}
  fs.rmSync(PLIST, { force: true })
  console.log('Runner removed.')
}

export function runnerStatus() {
  if (!fs.existsSync(PLIST)) return console.log('Runner: not installed (social runner install)')
  let loaded = false
  try {
    loaded = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(LABEL)
  } catch {}
  console.log(`Runner: installed${loaded ? ' and loaded' : ' but NOT loaded'}. Log: ${paths.runnerLog}`)
}

export function notify(title, msg) {
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&')
  execFile('osascript', ['-e', `display notification "${esc(msg)}" with title "social-publisher" subtitle "${esc(title)}"`], () => {})
}
