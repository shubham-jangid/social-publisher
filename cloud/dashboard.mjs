// The owner's dashboard: a password sign-in, then every brand's posts on every platform
// (published, scheduled, planned, not published). Served by the Worker.
// No build step: the page script is the function below, sent as text.
//
// Four views:
//   Today        what goes out on a day, what needs a look, the next two weeks at a glance
//   Schedule     every post in a range, with filters (status, platform, type), sort, group, CSV
//   Calendar     a month grid with the same filters
//   Performance  published posts with their numbers, sortable, plus a per-platform summary

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const head = (title, extra = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/app/app.css">
${extra}</head>`

export function loginHtml(error = '') {
  return `${head('Brand Publisher · Sign in')}
<body class="login">
<main class="login-card">
  <div class="logo-row"><span class="logo" aria-hidden="true">▤</span><h1>Brand Publisher</h1></div>
  <p class="muted">What is posted, scheduled and still to post, for every brand.</p>
  <form method="post" action="/login">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <button type="submit" class="primary">Sign in</button>
  </form>
</main>
</body>
</html>`
}

/** tz: the time zone the dashboard shows times in (Worker var DASH_TZ); the browser's own when empty. */
export function dashboardHtml(tz = '') {
  return `${head('Brand Publisher', `<meta name="dash-tz" content="${esc(tz)}">\n`)}
<body>
<header class="top">
  <div class="top-left">
    <div class="brandmark"><span class="logo" aria-hidden="true" id="logo"></span><span>Brand Publisher</span></div>
    <nav class="tabs" id="tabs" aria-label="Views">
      <button data-view="today"><span data-icon="home"></span>Today</button>
      <button data-view="schedule"><span data-icon="list"></span>Schedule</button>
      <button data-view="calendar"><span data-icon="calendar"></span>Calendar</button>
      <button data-view="performance"><span data-icon="chart"></span>Performance</button>
    </nav>
  </div>
  <div class="top-right">
    <div class="seg" id="brandseg" role="group" aria-label="Brand"></div>
    <label class="search"><span data-icon="search"></span><input id="q" type="search" placeholder="Search posts" aria-label="Search posts" autocomplete="off"><kbd>/</kbd></label>
    <button class="icon-btn" id="syncbtn" title="Check the platforms now" aria-label="Check the platforms now"><span data-icon="refresh"></span></button>
    <button class="primary" id="addbtn" title="Add to plan (N)"><span data-icon="plus"></span>Plan</button>
    <form method="post" action="/logout"><button class="icon-btn" type="submit" title="Sign out" aria-label="Sign out"><span data-icon="logout"></span></button></form>
  </div>
</header>

<main id="view" aria-live="polite"></main>

<div id="scrim" class="scrim" hidden></div>
<aside id="drawer" class="drawer" hidden aria-label="Details">
  <button class="icon-btn close" id="drawerclose" aria-label="Close"><span data-icon="x"></span></button>
  <div id="drawerbody"></div>
</aside>

<dialog id="plandlg">
  <form id="planform" method="dialog">
    <h3>Add to plan</h3>
    <p class="muted small">A plan item turns into "Not published" once its time passes and no matching post is found on that platform.</p>
    <label>Brand <select name="brand" id="pbrand" required></select></label>
    <fieldset id="pplats"><legend>Platforms</legend></fieldset>
    <div class="row">
      <label>Date <input type="date" name="date" required></label>
      <label>Time <input type="time" name="time" value="19:00" required></label>
    </div>
    <label>Title <input name="title" required maxlength="200" placeholder="Spring reel, part 2"></label>
    <label>Words in the caption or title <input name="match" placeholder="Optional. Default: the title"></label>
    <label>Note <input name="note" maxlength="300"></label>
    <p id="planerr" class="error" hidden></p>
    <div class="row end">
      <button value="cancel" class="ghost" formnovalidate>Cancel</button>
      <button id="plansave" value="save" class="primary">Save</button>
    </div>
  </form>
</dialog>

<div id="toast" class="toast" role="status" hidden></div>
<script src="/app/app.js"></script>
</body>
</html>`
}

export const APP_CSS = `
:root {
  --bg: #000; --panel: #0d0d0d; --panel2: #151515; --raise: #1c1c1c; --line: #242424; --line2: #333;
  --ink: #f4f4f5; --muted: #a1a1aa; --dim: #71717a; --white: #fff;
  --ok: #4ade80; --info: #60a5fa; --warn: #fbbf24; --bad: #f87171; --idle: #a1a1aa;
  --r: 14px; --sans: "Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--white); outline-offset: 2px; }
.muted { color: var(--muted); } .dim { color: var(--dim); } .small { font-size: 13px; }
.mono { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; }
.error { color: var(--bad); }
svg.i { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
[data-icon] { display: inline-flex; }

/* buttons */
.primary, .ghost, .icon-btn, .chipbtn { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; border: 1px solid var(--line2); background: transparent; padding: 7px 14px; white-space: nowrap; }
.primary { background: var(--white); color: #000; border-color: var(--white); font-weight: 600; }
.primary:hover { background: #e4e4e7; }
.ghost:hover, .icon-btn:hover { background: var(--raise); }
.icon-btn { width: 38px; height: 38px; padding: 0; justify-content: center; }
.icon-btn.spin svg { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.linkbtn { all: unset; cursor: pointer; color: var(--muted); font-size: 14px; }
.linkbtn:hover { color: var(--ink); }

/* login */
.login { display: grid; place-items: center; min-height: 100vh; padding: 16px; }
.login-card { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 28px; width: min(400px, 100%); }
.login-card h1 { margin: 0; font-size: 20px; }
.login-card form { display: grid; gap: 10px; margin-top: 18px; }
.login-card input { padding: 11px 12px; border: 1px solid var(--line2); border-radius: 10px; background: var(--bg); }
.login-card .primary { justify-content: center; padding: 10px; }
.logo-row { display: flex; gap: 10px; align-items: center; margin-bottom: 4px; }
.logo { width: 34px; height: 34px; border-radius: 50%; background: var(--white); color: #000; display: inline-grid; place-items: center; flex: none; }
.logo svg.i { width: 17px; height: 17px; }

/* header */
.top { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 24px; background: rgba(0,0,0,.86); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.top-left, .top-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
.top-right form { margin: 0; }
.brandmark { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; }
.tabs { display: flex; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); overflow-x: auto; max-width: 100%; }
.tabs button { display: inline-flex; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--muted); padding: 7px 14px; border-radius: 999px; font-weight: 500; white-space: nowrap; }
.tabs button:hover { color: var(--ink); }
.tabs button[aria-current="page"] { background: var(--raise); color: var(--ink); }
.seg { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); overflow-x: auto; max-width: 100%; }
.seg button { border: 0; background: transparent; color: var(--muted); padding: 6px 13px; border-radius: 999px; white-space: nowrap; font-weight: 500; }
.seg button:hover { color: var(--ink); }
.seg button[aria-pressed="true"] { background: var(--white); color: #000; }
.search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 0 12px; height: 38px; background: var(--panel); color: var(--dim); min-width: 200px; }
.search input { border: 0; outline: 0; background: transparent; color: var(--ink); width: 100%; min-width: 0; }
.search:focus-within { border-color: var(--line2); }
kbd { font-family: var(--mono); font-size: 11px; color: var(--dim); border: 1px solid var(--line2); border-radius: 5px; padding: 0 5px; }

/* page */
main { padding: 22px 24px 60px; max-width: 1500px; margin: 0 auto; display: grid; gap: 16px; }
main > *, .fbar > *, .cols > *, .side > * { min-width: 0; }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.hero .date { color: var(--muted); font-size: 15px; }
.hero h1 { margin: 2px 0 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -.01em; }
.hero .sub { color: var(--muted); margin-top: 4px; }
.hero-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button.syncpill { background: transparent; cursor: pointer; font: inherit; font-size: 13px; }
button.syncpill:hover { color: var(--ink); }
.syncpill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line2); border-radius: 999px; padding: 5px 13px; color: var(--muted); font-size: 13px; }
.syncpill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.syncpill.bad::before { background: var(--bad); }
.syncpill.old::before { background: var(--warn); }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 18px 20px; min-width: 0; }
.panel-h { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.panel-h h2 { margin: 0; font-size: 17px; font-weight: 600; }
.lbl { font-family: var(--mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); display: inline-flex; align-items: center; gap: 8px; }
.sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; display: inline-block; }
.g-published .sdot, .sdot.g-published { background: var(--ok); }
.g-scheduled .sdot, .sdot.g-scheduled { background: var(--info); }
.g-problem .sdot, .sdot.g-problem { background: var(--bad); }
.g-planned .sdot, .sdot.g-planned { background: transparent; border: 1.5px dashed var(--idle); }
.g-skipped .sdot, .sdot.g-skipped { background: var(--line2); }

/* today: strip of today's posts */
.strip { display: flex; align-items: center; gap: 10px; overflow-x: auto; padding: 12px 14px; scrollbar-width: thin; }
.strip .lbl { flex: none; margin-right: 4px; }
.tchip { all: unset; cursor: pointer; flex: none; display: inline-flex; align-items: center; gap: 8px; background: var(--white); color: #000; border-radius: 999px; padding: 4px 12px 4px 4px; max-width: 340px; }
.tchip .av { width: 26px; height: 26px; font-size: 10px; }
.tchip b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tchip .tm { color: #52525b; font-size: 13px; white-space: nowrap; }
.tchip.g-problem { box-shadow: inset 0 0 0 2px var(--bad); }
.tchip:focus-visible { outline: 2px solid var(--info); }

/* day strip */
.days { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(84px, 1fr); gap: 10px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
.dayc { all: unset; cursor: pointer; box-sizing: border-box; text-align: center; border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 10px 6px 9px; position: relative; }
.dayc:hover { border-color: var(--line2); }
.dayc.empty { border-style: dashed; background: transparent; }
.dayc .dw { color: var(--muted); font-size: 13px; }
.dayc .dn { font-size: 21px; font-weight: 700; line-height: 1.3; }
.dayc .dc { font-family: var(--mono); font-size: 11.5px; color: var(--muted); min-height: 16px; }
.dayc .pd { position: absolute; top: 8px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--bad); }
.dayc[aria-pressed="true"] { background: var(--white); color: #000; border-color: var(--white); }
.dayc[aria-pressed="true"] .dw, .dayc[aria-pressed="true"] .dc { color: #3f3f46; }
.dayc.istoday:not([aria-pressed="true"]) .dn { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }

/* progress panel */
.prog { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.prog h3 { margin: 4px 0 0; font-size: 22px; }
.ring { --p: 0; width: 64px; height: 64px; border-radius: 50%; background: conic-gradient(var(--white) calc(var(--p) * 1%), var(--line) 0); display: grid; place-items: center; flex: none; }
.ring span { width: 52px; height: 52px; border-radius: 50%; background: var(--panel); display: grid; place-items: center; font-weight: 700; font-size: 15px; }

/* stat cards */
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.stat { all: unset; cursor: pointer; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 15px 17px; display: grid; gap: 2px; min-width: 0; }
.stat:hover { border-color: var(--line2); background: var(--panel2); }
.stat .top-row { display: flex; justify-content: space-between; color: var(--ink); font-weight: 500; }
.stat .top-row svg { color: var(--muted); }
.stat .big { font-size: 28px; font-weight: 700; line-height: 1.15; }
.stat .big small { font-size: 14px; font-weight: 400; color: var(--muted); margin-left: 4px; }
.stat .who { color: var(--muted); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat.bad .big { color: var(--bad); }

/* two-column body */
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
.side { display: grid; gap: 16px; }

/* rows */
.group + .group { margin-top: 14px; }
.group > .lbl { margin: 4px 0 4px; }
.rowi { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 40px minmax(0, 1.6fr) minmax(0, 1fr) auto auto; gap: 14px; align-items: center; width: 100%; padding: 10px 6px; border-radius: 10px; }
.rowi:hover { background: var(--panel2); }
.rowi + .rowi { border-top: 1px solid var(--line); }
.rowi:hover + .rowi, .rowi:hover { border-color: transparent; }
.rowi .tt { min-width: 0; }
.rowi .tt b { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.rowi .tt span { display: block; color: var(--muted); font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowi .when { color: var(--ink); font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rowi .ext { color: var(--muted); display: inline-flex; padding: 4px; border-radius: 6px; }
.rowi .ext:hover { color: var(--ink); background: var(--raise); }
.rowi .noext { width: 24px; }
.av { width: 36px; height: 36px; border-radius: 50%; display: inline-grid; place-items: center; font-family: var(--mono); font-size: 12px; font-weight: 500; border: 1px solid var(--line2); background: var(--panel2); color: var(--ink); flex: none; position: relative; }
.av i { position: absolute; right: -2px; bottom: -2px; width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--panel); }

.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 2px 11px; border-radius: 999px; border: 1px solid var(--line2); color: var(--muted); white-space: nowrap; }
.pill.g-published { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.pill.g-scheduled { color: var(--info); border-color: color-mix(in srgb, var(--info) 35%, transparent); }
.pill.g-problem { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.pill.g-planned { border-style: dashed; }
.pill.g-skipped { text-decoration: line-through; }
.pill.soft { background: var(--raise); border-color: transparent; color: var(--ink); }

.pf { display: inline-flex; align-items: center; justify-content: center; flex: none; font-family: var(--mono); font-size: 10.5px; font-weight: 500; border-radius: 5px; padding: 1px 5px; line-height: 16px; color: var(--pc); background: color-mix(in srgb, var(--pc) 16%, transparent); }
.pf-facebook { --pc: #6aa5ff; } .pf-instagram { --pc: #f472b6; } .pf-youtube { --pc: #ff6b6b; } .pf-pinterest { --pc: #fb7185; } .pf-linkedin { --pc: #7cb7f5; } .pf-blog { --pc: #bef264; }

/* side cards */
.fu { all: unset; cursor: pointer; box-sizing: border-box; display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; padding: 10px 4px; width: 100%; border-radius: 10px; }
.fu + .fu { border-top: 1px solid var(--line); }
.fu:hover { background: var(--panel2); }
.fu > span { min-width: 0; }
.fu b { font-weight: 500; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fu q { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--muted); font-size: 14px; quotes: none; margin: 2px 0 6px; }
.fu .ext { color: var(--muted); }
.mini { display: grid; gap: 2px; }
.mini .md { font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; color: var(--dim); text-transform: uppercase; margin: 10px 0 2px; }
.mini .md:first-child { margin-top: 0; }
.mrow { all: unset; cursor: pointer; display: flex; gap: 8px; align-items: center; padding: 5px 4px; border-radius: 8px; min-width: 0; font-size: 14px; }
.mrow:hover { background: var(--panel2); }
.mrow .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.mrow .tm { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 13px; }
.bd { flex: none; width: 8px; height: 8px; border-radius: 50%; }

/* filter bar */
.fbar { display: grid; gap: 12px; }
.frow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.frow .lbl { min-width: 74px; }
.chipbtn { padding: 5px 12px; color: var(--muted); font-size: 14px; }
.chipbtn:hover { color: var(--ink); border-color: #444; }
.chipbtn[aria-pressed="true"] { background: var(--raise); color: var(--ink); border-color: #52525b; }
.chipbtn .n { font-family: var(--mono); font-size: 11.5px; color: var(--dim); }
.chipbtn[aria-pressed="true"] .n { color: var(--muted); }
.sel { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; }
.sel select { background: var(--panel2); border: 1px solid var(--line2); border-radius: 999px; padding: 5px 12px; color: var(--ink); }
.spacer { flex: 1; }

/* schedule table */
.tbl .th, .tbl .tr { display: grid; grid-template-columns: 118px 36px minmax(0, 1fr) 150px 140px 76px 28px; gap: 12px; align-items: center; }
.tbl .th { font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding: 0 8px 8px; border-bottom: 1px solid var(--line); }
.tbl .th button { all: unset; cursor: pointer; }
.tbl .th button:hover { color: var(--ink); }
.tbl .tr { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 118px 36px minmax(0, 1fr) 150px 140px 76px 28px; gap: 12px; align-items: center; padding: 9px 8px; border-bottom: 1px solid var(--line); width: 100%; }
.tbl .tr:hover { background: var(--panel2); }
.tbl .gh { display: flex; gap: 10px; align-items: center; padding: 16px 8px 6px; }
.tbl .gh:first-of-type { padding-top: 10px; }
.tbl .c-time { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 14px; white-space: nowrap; }
.tbl .c-time b { color: var(--ink); font-weight: 500; display: block; }
.tbl .c-title { min-width: 0; }
.tbl .c-title b { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl .c-title span { display: block; color: var(--dim); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl .c-plat { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13.5px; }
.tbl .th .c-num { font-size: inherit; color: inherit; }
.tbl .c-plat { white-space: nowrap; overflow: hidden; min-width: 0; }
.tbl .c-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 14px; }
.count { color: var(--muted); font-size: 14px; }
.more-btn { margin: 14px auto 0; display: flex; }

/* calendar */
.cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.dow { background: var(--panel); padding: 8px 10px; font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.cell { background: var(--panel); min-height: 128px; padding: 7px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cell.other { background: #070707; }
.cell.other .d { color: var(--dim); }
.cell .d { font-size: 13px; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; }
.cell.today .d span:first-child { background: var(--white); color: #000; border-radius: 999px; padding: 0 7px; }
.chip { all: unset; cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 12.5px; padding: 3px 6px; border-radius: 6px; background: var(--panel2); border-left: 2px solid var(--idle); min-width: 0; }
.chip:hover { background: var(--raise); }
.chip .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.g-published { border-left-color: var(--ok); }
.chip.g-scheduled { border-left-color: var(--info); }
.chip.g-problem { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, var(--panel2)); }
.chip.g-planned { border-left-style: dashed; }
.chip.g-skipped { opacity: .55; text-decoration: line-through; }
.more { all: unset; cursor: pointer; font-size: 12.5px; color: var(--muted); padding: 2px 6px; }
.more:hover { color: var(--ink); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 13px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }

/* performance */
.perf { width: 100%; border-collapse: collapse; font-size: 14px; }
.perf th, .perf td { padding: 10px 10px; border-bottom: 1px solid var(--line); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.perf th { font-family: var(--mono); font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); font-weight: 400; }
.perf th button { all: unset; cursor: pointer; }
.perf th button:hover, .perf th[aria-sort] button { color: var(--ink); }
.perf td.l, .perf th.l { text-align: left; }
.perf td.t { white-space: normal; min-width: 16em; max-width: 34em; }
.perf tbody tr { cursor: pointer; }
.perf tbody tr:hover td { background: var(--panel2); }
.perf .bar { display: inline-block; height: 6px; border-radius: 3px; background: var(--white); vertical-align: middle; margin-right: 8px; opacity: .8; }
.perfwrap { overflow-x: auto; }

/* drawer */
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 19; }
.drawer { position: fixed; right: 0; top: 0; bottom: 0; width: min(480px, 100%); background: var(--panel); border-left: 1px solid var(--line); padding: 22px; overflow: auto; z-index: 20; }
.drawer .close { position: absolute; right: 14px; top: 14px; }
.drawer h3 { margin: 0 44px 12px 0; font-size: 19px; }
.drawer dl { display: grid; grid-template-columns: 104px 1fr; gap: 8px 12px; font-size: 14px; margin: 0 0 14px; }
.drawer dt { color: var(--dim); }
.drawer dd { margin: 0; word-break: break-word; }
.drawer pre { white-space: pre-wrap; font: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font-size: 14px; margin: 0; max-height: 40vh; overflow: auto; }
.explain { border: 1px solid color-mix(in srgb, var(--bad) 40%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-bottom: 14px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.actions a { text-decoration: none; }

/* dialog */
dialog { border: 1px solid var(--line2); border-radius: 16px; background: var(--panel); color: var(--ink); width: min(480px, calc(100% - 32px)); padding: 20px; }
dialog::backdrop { background: rgba(0,0,0,.6); }
dialog form { display: grid; gap: 12px; }
dialog h3 { margin: 0; }
dialog label { display: grid; gap: 5px; font-size: 14px; color: var(--muted); }
dialog input, dialog select { padding: 9px 11px; border: 1px solid var(--line2); border-radius: 10px; background: var(--bg); color: var(--ink); }
dialog fieldset { border: 1px solid var(--line2); border-radius: 10px; display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); }
dialog fieldset label { display: inline-flex; gap: 6px; align-items: center; color: var(--ink); }
.row { display: flex; gap: 10px; flex-wrap: wrap; } .row > label { flex: 1; } .row.end { justify-content: flex-end; }

.empty { padding: 26px; text-align: center; color: var(--muted); border: 1px dashed var(--line2); border-radius: 12px; }
.loading { opacity: .5; pointer-events: none; transition: opacity .15s; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--white); color: #000; padding: 9px 16px; border-radius: 999px; font-weight: 500; z-index: 30; }

@media (max-width: 1180px) {
  .cols { grid-template-columns: 1fr; }
  .tbl .th, .tbl .tr { grid-template-columns: 104px 36px minmax(0, 1fr) 130px 120px 28px; }
  .tbl .c-num { display: none; }
}
@media (max-width: 860px) {
  .top { padding: 12px 16px; position: static; }
  .top-right { width: 100%; }
  .search { flex: 1; min-width: 0; }
  .search kbd { display: none; }
  main { padding: 16px 16px 50px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rowi { grid-template-columns: 36px minmax(0, 1fr) auto; }
  .rowi .when { grid-column: 2; grid-row: 2; font-size: 13.5px; color: var(--muted); }
  .rowi .ext, .rowi .noext { display: none; }
  .tbl .th { display: none; }
  .tbl .tr { grid-template-columns: 36px minmax(0, 1fr) auto; row-gap: 2px; }
  .tbl .c-time { grid-column: 2; grid-row: 2; font-size: 13px; }
  .tbl .c-time b { display: inline; margin-right: 6px; }
  .tbl .c-av { grid-row: 1 / span 2; }
  .tbl .c-plat { grid-column: 3; grid-row: 2; justify-content: flex-end; }
  .tbl .c-st { grid-column: 3; grid-row: 1; justify-self: end; }
  .tbl .c-link { display: none; }
  .cell { min-height: 76px; padding: 4px; }
  .chip .t { display: none; }
  .chip { padding: 2px 3px; }
  .dow { padding: 5px; font-size: 10px; }
  .hero h1 { font-size: 23px; }
  .frow .lbl { min-width: 0; width: 100%; }
}
`

function appMain() {
  const TZ = document.querySelector('meta[name="dash-tz"]')?.content || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const DAY = 86400000
  const $ = (s) => document.querySelector(s)
  const PF = { facebook: 'FB', instagram: 'IG', youtube: 'YT', pinterest: 'PIN', linkedin: 'IN', blog: 'WEB' }
  const PF_NAME = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest', linkedin: 'LinkedIn', blog: 'Website blog' }
  const STATUS = {
    published: 'Published',
    scheduled: 'Scheduled',
    preparing: 'Getting ready',
    private: 'Private on YouTube',
    stuck: 'Stuck',
    failed: 'Failed',
    missed: 'Missed',
    planned: 'Planned',
    overdue: 'Not published',
    skipped: 'Skipped',
  }
  // Every status falls in one of five groups; filters, colours and counts use the group.
  const GROUP_OF = { published: 'published', scheduled: 'scheduled', preparing: 'scheduled', planned: 'planned', skipped: 'skipped', private: 'problem', stuck: 'problem', failed: 'problem', missed: 'problem', overdue: 'problem' }
  const GROUPS = [
    ['problem', 'Needs a look'],
    ['scheduled', 'Scheduled'],
    ['planned', 'Planned, no post yet'],
    ['published', 'Published'],
    ['skipped', 'Skipped'],
  ]
  const GROUP_NAME = Object.fromEntries(GROUPS)
  const grp = (e) => GROUP_OF[e.status] || 'planned'
  const EXPLAIN = {
    stuck: 'Facebook still lists this as scheduled, but its time has passed. Open it on Facebook and publish or re-schedule it.',
    private: 'Uploaded to YouTube but not public. API uploads stay private until Google approves the app.',
    overdue: 'Its time has passed and no matching post was found on this platform. Post it, or mark it as skipped / posted by hand.',
    failed: 'The scheduler tried to post this and the platform refused it.',
    missed: 'The scheduler could not post this within 3 hours of its time, so it stopped rather than post it late.',
  }
  const SHORT = {
    stuck: 'Facebook still shows it as scheduled. Publish or re-schedule it there.',
    private: 'On YouTube but not public yet.',
    overdue: 'No matching post was found after its time.',
    failed: 'The platform refused it.',
    missed: 'Not posted within 3 hours, so it was dropped.',
  }
  const SOURCE = { platform: 'Found on the platform', tool: 'Posted by the scheduler', plan: 'From the plan' }
  const KIND = { reel: 'Reel', short: 'Short', video: 'Video', post: 'Post', image: 'Image', pin: 'Pin', sanity: 'Blog post' }
  // Brand colours stay clear of the status colours (green, blue, red).
  // Fixed colours for some brands, by brand key, e.g. { 'my-brand': '#c084fc' }. Others get one from their name.
  const COLORS = {}
  const color = (b) => COLORS[b] || '#' + ((([...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) & 0xffffff) | 0x404040).toString(16)).slice(-6)

  const ICONS = {
    home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
    plus: 'M12 5v14M5 12h14',
    ext: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    check: 'M20 6 9 17l-5-5',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    x: 'M18 6 6 18M6 6l12 12',
    left: 'm15 18-6-6 6-6',
    right: 'm9 18 6-6-6-6',
    copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    board: 'M3 3h18v18H3zM3 9h18M9 21V9',
  }
  const icon = (name) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('class', 'i')
    s.setAttribute('aria-hidden', 'true')
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', ICONS[name] || '')
    s.append(p)
    return s
  }
  for (const n of document.querySelectorAll('[data-icon]')) n.replaceWith(icon(n.dataset.icon))
  $('#logo').append(icon('board'))

  // ---- state (remembered per browser) ----
  const DEF_F = { range: 'next7', groups: [], platforms: [], kind: 'all', sort: 'time-asc', group: 'day' }
  const DEF_P = { days: 30, platforms: [], kind: 'all', sort: 'views', dir: -1 }
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('bp_ui') || '{}')
    } catch {
      return {}
    }
  })()
  const hashView = location.hash.slice(1)
  const VIEWS = ['today', 'schedule', 'calendar', 'performance']
  const state = {
    view: VIEWS.includes(hashView) ? hashView : VIEWS.includes(saved.view) ? saved.view : 'today',
    brand: saved.brand || 'all',
    q: '',
    day: null,
    f: { ...DEF_F, ...(saved.f || {}) },
    p: { ...DEF_P, ...(saved.p || {}) },
    month: null,
    data: null,
    loadedKey: '',
    brands: {},
    limit: 150,
  }
  const remember = () => {
    try {
      localStorage.setItem('bp_ui', JSON.stringify({ view: state.view, brand: state.brand, f: state.f, p: state.p }))
    } catch {}
  }

  // ---- time helpers (everything shown in TZ: DASH_TZ, else the browser's zone) ----
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const dayKey = (ms) => {
    const p = parts(ms)
    return `${p.year}-${p.month}-${p.day}`
  }
  const tzOffset = (ms) => {
    const p = parts(ms)
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000
  }
  const zoned = (y, m, d, hh = 0, mm = 0) => {
    const guess = Date.UTC(y, m, d, hh, mm)
    return guess - tzOffset(guess)
  }
  const startOf = (key) => {
    const [y, m, d] = key.split('-').map(Number)
    return zoned(y, m - 1, d)
  }
  const addDays = (key, n) => {
    const [y, m, d] = key.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d + n))
    return t.toISOString().slice(0, 10)
  }
  const fmt = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o })
  const fmtTime = (ms) => fmt({ hour: 'numeric', minute: '2-digit' }).format(ms)
  const fmtDay = (ms) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms)
  const fmtLong = (ms) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(ms)
  const fmtFull = (ms) => fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms)
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000)
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
  }
  const inDays = (ms) => {
    const d = Math.round((startOf(dayKey(ms)) - startOf(dayKey(Date.now()))) / DAY)
    return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d} days ago` : `in ${d} days`
  }
  const today = () => dayKey(Date.now())

  // ---- DOM helpers ----
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') n.className = v
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
      else n.setAttribute(k, v === true ? '' : v)
    }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)))
    return n
  }
  const brandName = (b) => state.brands[b]?.name || b
  const initials = (b) => {
    const w = brandName(b).trim().split(/\s+/)
    return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase()
  }
  const avatar = (b) => {
    const dot = el('i')
    dot.style.background = color(b)
    return el('span', { class: 'av', title: brandName(b) }, initials(b), dot)
  }
  const bdot = (b) => {
    const d = el('span', { class: 'bd', title: brandName(b) })
    d.style.background = color(b)
    return d
  }
  const badge = (p) => el('span', { class: `pf pf-${p}`, title: PF_NAME[p] || p }, PF[p] || p)
  const pill = (e) => el('span', { class: `pill g-${grp(e)}` }, STATUS[e.status] || e.status)
  const title = (e) => e.planTitle || e.title || '(no text)'
  const kindName = (e) => KIND[e.kind] || ''
  const extLink = (e) =>
    e.url ? el('a', { class: 'ext', href: e.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the post', onclick: (ev) => ev.stopPropagation() }, icon('ext')) : el('span', { class: 'noext' })
  const toast = (msg) => {
    const t = $('#toast')
    t.textContent = msg
    t.hidden = false
    clearTimeout(toast.t)
    toast.t = setTimeout(() => (t.hidden = true), 2200)
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/app/api/${path}`, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
    if (res.status === 401) {
      location.href = '/login'
      throw new Error('signed out')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  // ---- what to load for the current view ----
  const RANGES = [
    ['today', 'Today'],
    ['next7', 'Next 7 days'],
    ['next30', 'Next 30 days'],
    ['last7', 'Last 7 days'],
    ['last30', 'Last 30 days'],
    ['around', 'Last 30 + next 30'],
  ]
  function scheduleRange() {
    const t = today()
    const s = startOf(t)
    switch (state.f.range) {
      case 'today': return { from: s, to: startOf(addDays(t, 1)) - 1 }
      case 'next30': return { from: s, to: startOf(addDays(t, 30)) - 1 }
      case 'last7': return { from: startOf(addDays(t, -6)), to: startOf(addDays(t, 1)) - 1 }
      case 'last30': return { from: startOf(addDays(t, -29)), to: startOf(addDays(t, 1)) - 1 }
      case 'around': return { from: startOf(addDays(t, -30)), to: startOf(addDays(t, 31)) - 1 }
      default: return { from: s, to: startOf(addDays(t, 7)) - 1 }
    }
  }
  function monthGrid() {
    const [y, m] = state.month
    const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7
    const startKey = new Date(Date.UTC(y, m, 1 - firstDow)).toISOString().slice(0, 10)
    const days = Math.ceil((firstDow + new Date(Date.UTC(y, m + 1, 0)).getUTCDate()) / 7) * 7
    return { startKey, days, from: startOf(startKey), to: startOf(addDays(startKey, days)) - 1 }
  }
  function range() {
    const t = today()
    if (state.view === 'today') return { from: startOf(addDays(t, -21)), to: startOf(addDays(t, 15)) - 1 }
    if (state.view === 'schedule') return scheduleRange()
    if (state.view === 'performance') return { from: Date.now() - state.p.days * DAY, to: Date.now() }
    return monthGrid()
  }

  async function load(force = false) {
    const r = range()
    // Round to the minute so a re-render a moment later reuses the data.
    const key = `${Math.floor(r.from / 60000)}-${Math.floor(r.to / 60000)}`
    if (!force && key === state.loadedKey && state.data) return render()
    $('#view').classList.add('loading')
    try {
      const d = await api(`calendar?from=${Math.floor(r.from)}&to=${Math.floor(r.to)}`)
      state.data = d
      state.loadedKey = key
      state.brands = d.brands || {}
      renderBrands()
      render()
    } catch (e) {
      $('#view').replaceChildren(el('div', { class: 'empty' }, `Could not load: ${e.message}`))
    } finally {
      $('#view').classList.remove('loading')
    }
  }

  // Brand + search apply everywhere; the rest is per view.
  const matchesQ = (e) => {
    if (!state.q) return true
    const hay = `${title(e)} ${e.title || ''} ${e.text || ''} ${e.note || ''} ${brandName(e.brand)} ${PF_NAME[e.platform] || ''} ${kindName(e)}`.toLowerCase()
    return state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))
  }
  const base = () => (state.data?.entries || []).filter((e) => (state.brand === 'all' || e.brand === state.brand) && matchesQ(e))
  const allPlatforms = () => [...new Set(Object.values(state.brands).flatMap((b) => b.platforms || []).concat((state.data?.entries || []).map((e) => e.platform)))]

  // ---- header ----
  function renderBrands() {
    const brands = Object.keys(state.brands)
    if (state.brand !== 'all' && !brands.includes(state.brand)) state.brand = 'all'
    const box = $('#brandseg')
    box.replaceChildren(
      ...[['all', 'All'], ...brands.map((b) => [b, brandName(b)])].map(([v, label]) =>
        el('button', { 'aria-pressed': String(v === state.brand), title: state.brands[v]?.viewOnly ? 'View only: posted by hand, the scheduler never posts for this brand' : null, onclick: () => {
          state.brand = v
          remember()
          renderBrands()
          render()
        } }, label),
      ),
    )
    for (const b of document.querySelectorAll('#tabs button')) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
    }
  }

  function syncPill() {
    const s = state.data?.sync
    const bad = (s?.results || []).filter((r) => !r.ok)
    const old = !s?.at || Date.now() - s.at > 6 * 3600000
    const p = el('button', { class: `syncpill${bad.length ? ' bad' : old ? ' old' : ''}`, title: bad.length ? bad.map((r) => `${brandName(r.brand)} ${PF_NAME[r.platform]}: ${r.error}`).join('\n') : 'Click to check the platforms now', onclick: syncNow }, s?.at ? `Synced ${ago(s.at)}${bad.length ? ` · ${bad.length} account${bad.length > 1 ? 's' : ''} could not be read` : ''}` : 'Not synced yet')
    return p
  }

  function hero(date, h1, sub, ...actions) {
    return el('section', { class: 'hero' }, el('div', {}, date ? el('div', { class: 'date' }, date) : null, el('h1', {}, h1), sub ? el('div', { class: 'sub' }, sub) : null), el('div', { class: 'hero-actions' }, actions, syncPill()))
  }

  function render() {
    renderBrands()
    if (!state.data) return
    if (state.view === 'today') return renderToday()
    if (state.view === 'schedule') return renderSchedule()
    if (state.view === 'performance') return renderPerformance()
    return renderCalendar()
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const countBy = (list) => {
    const c = {}
    for (const e of list) c[grp(e)] = (c[grp(e)] || 0) + 1
    return c
  }

  // ---- shared row ----
  function row(e, { withDay = false } = {}) {
    const g = grp(e)
    const isPast = e.at <= Date.now()
    const when = g === 'published' ? `${withDay ? fmtDay(e.at) + ' · ' : ''}Posted ${fmtTime(e.at)}` : `${withDay ? fmtDay(e.at) + ' · ' : ''}${isPast && g !== 'skipped' ? 'Was due' : 'Goes out'} ${fmtTime(e.at)}`
    return el(
      'button',
      { class: 'rowi', onclick: () => showEntry(e) },
      avatar(e.brand),
      el('span', { class: 'tt' }, el('b', {}, title(e)), el('span', {}, [brandName(e.brand), PF_NAME[e.platform] || e.platform, kindName(e)].filter(Boolean).join(' · '))),
      el('span', { class: 'when' }, when),
      pill(e),
      extLink(e),
    )
  }

  function goSchedule(patch) {
    state.f = { ...state.f, groups: [], platforms: [], kind: 'all', ...patch }
    setView('schedule')
  }

  // ---- Today ----
  function renderToday() {
    const t = today()
    if (!state.day) state.day = t
    const list = base()
    const now = Date.now()
    const sel = state.day
    const items = list.filter((e) => dayKey(e.at) === sel)
    const c = countBy(items)
    const isToday = sel === t
    const due = items.filter((e) => grp(e) !== 'skipped')
    const done = due.filter((e) => grp(e) === 'published').length
    const head = isToday
      ? due.length ? `${plural(due.length, 'post')} going out today` : 'Nothing going out today'
      : `${plural(due.length, 'post')} on ${fmtDay(startOf(sel) + 43200000)}`
    const parts2 = GROUPS.filter(([g]) => c[g]).map(([g, n]) => `${c[g]} ${n.toLowerCase()}`)

    // strip of the day's posts
    const strip = el('section', { class: 'panel strip' }, el('span', { class: 'lbl' }, el('span', { class: 'sdot g-scheduled' }), isToday ? 'Going out today' : 'On this day'),
      items.length ? items.map((e) => el('button', { class: `tchip g-${grp(e)}`, onclick: () => showEntry(e), title: `${STATUS[e.status]} · ${brandName(e.brand)} · ${PF_NAME[e.platform]}` }, avatar(e.brand), badge(e.platform), el('b', {}, title(e)), el('span', { class: 'tm' }, grp(e) === 'published' ? `posted ${fmtTime(e.at)}` : fmtTime(e.at)))) : el('span', { class: 'muted' }, 'Nothing. Add a plan item with the Plan button.'))

    // two weeks of day cards
    const days = []
    for (let i = 0; i < 14; i++) {
      const k = addDays(t, i)
      const its = list.filter((e) => dayKey(e.at) === k && grp(e) !== 'skipped')
      const prob = its.some((e) => grp(e) === 'problem')
      const ms = startOf(k) + 43200000
      days.push(el('button', { class: `dayc${its.length ? '' : ' empty'}${k === t ? ' istoday' : ''}`, 'aria-pressed': String(k === sel), title: `${fmtLong(ms)}: ${plural(its.length, 'post')}`, onclick: () => {
        state.day = k
        renderToday()
      } }, prob ? el('span', { class: 'pd', title: 'Something needs a look' }) : null, el('div', { class: 'dw' }, fmt({ weekday: 'short' }).format(ms)), el('div', { class: 'dn' }, Number(k.slice(8))), el('div', { class: 'dc' }, its.length ? `${its.length} post${its.length > 1 ? 's' : ''}` : '')))
    }

    // progress for the day
    const pct = due.length ? Math.round((done / due.length) * 100) : 0
    const ring = el('div', { class: 'ring', title: `${pct}% published` }, el('span', {}, `${pct}%`))
    ring.style.setProperty('--p', pct)
    const prog = el('section', { class: 'panel prog' }, el('div', {}, el('span', { class: 'lbl' }, isToday ? 'Published today' : 'Published on this day'), el('h3', {}, `${done} of ${due.length} out`), el('div', { class: 'muted' }, due.length - done ? `${due.length - done} still to go${c.problem ? `, ${c.problem} need${c.problem > 1 ? '' : 's'} a look` : ''}` : due.length ? 'All done' : 'Nothing planned')), ring)

    // stat cards (each opens the Schedule view with that filter)
    const last7 = list.filter((e) => grp(e) === 'published' && e.at >= startOf(addDays(t, -6)) && e.at <= now)
    const next7 = list.filter((e) => grp(e) === 'scheduled' && e.at >= now - 3600000 && e.at < startOf(addDays(t, 7))).sort((a, b) => a.at - b.at)
    const problems = list.filter((e) => grp(e) === 'problem').sort((a, b) => b.at - a.at)
    const planned = list.filter((e) => grp(e) === 'planned').sort((a, b) => a.at - b.at)
    const perBrand = (l) => {
      const m = {}
      for (const e of l) m[e.brand] = (m[e.brand] || 0) + 1
      return Object.entries(m).map(([b, n]) => `${brandName(b)} ${n}`).join(' · ') || 'Nobody'
    }
    const stat = (cls, ico, label, n, sub, who, onclick) => el('button', { class: `stat ${cls}`, onclick }, el('div', { class: 'top-row' }, label, icon(ico)), el('div', { class: 'big' }, n, el('small', {}, sub)), el('div', { class: 'who' }, who))
    const stats = el('section', { class: 'stats' },
      stat('', 'check', 'Published', last7.length, 'last 7 days', perBrand(last7), () => goSchedule({ range: 'last7', groups: ['published'], sort: 'time-desc' })),
      stat('', 'clock', 'Scheduled', next7.length, 'next 7 days', next7[0] ? `Next: ${fmtDay(next7[0].at)}, ${fmtTime(next7[0].at)}` : 'Nothing scheduled', () => goSchedule({ range: 'next7', groups: ['scheduled'] })),
      stat(problems.length ? 'bad' : '', 'alert', 'Needs a look', problems.length, 'last 3 weeks', problems.length ? Object.entries(countByStatus(problems)).map(([s, n]) => `${n} ${STATUS[s].toLowerCase()}`).join(' · ') : 'All good', () => goSchedule({ range: 'last30', groups: ['problem'], sort: 'time-desc' })),
      stat('', 'calendar', 'Planned', planned.length, 'no post yet', planned[0] ? `First: ${title(planned[0])}` : 'Nothing waiting', () => goSchedule({ range: 'next30', groups: ['planned'] })),
    )

    // main list: the selected day, grouped
    const groups = GROUPS.map(([g, name]) => [g, name, items.filter((e) => grp(e) === g).sort((a, b) => a.at - b.at)]).filter(([, , l]) => l.length)
    const main = el('section', { class: 'panel' },
      el('div', { class: 'panel-h' }, el('h2', {}, isToday ? 'Today’s posts' : `Posts on ${fmtDay(startOf(sel) + 43200000)}`), el('span', { class: 'mono dim' }, `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`)),
      groups.length ? groups.map(([g, name, l]) => el('div', { class: `group g-${g}` }, el('div', { class: 'lbl' }, el('span', { class: 'sdot' }), name, ` ${l.length}`), l.map((e) => row(e)))) : el('div', { class: 'empty' }, state.q ? 'No posts match the search on this day.' : 'Nothing on this day.'),
    )

    // side: needs a look + rest of the week
    const fu = el('section', { class: 'panel' },
      el('div', { class: 'panel-h' }, el('h2', {}, 'Needs a look'), el('span', { class: 'mono dim' }, `${problems.length} open`)),
      problems.length ? problems.slice(0, 6).map((e) => el('button', { class: 'fu', onclick: () => showEntry(e) }, avatar(e.brand), el('span', {}, el('b', {}, title(e)), el('q', {}, `${STATUS[e.status]} on ${PF_NAME[e.platform]}. ${SHORT[e.status] || ''}`), el('span', { class: 'pill soft' }, `${fmtDay(e.at)} · ${inDays(e.at)}`)), extLink(e))) : el('div', { class: 'muted' }, 'Nothing. Every post went out.'),
      problems.length > 6 ? el('button', { class: 'linkbtn', onclick: () => goSchedule({ range: 'last30', groups: ['problem'], sort: 'time-desc' }) }, `See all ${problems.length} →`) : null,
    )
    const after = list.filter((e) => e.at >= startOf(addDays(sel, 1)) && e.at < startOf(addDays(sel, 8)) && ['scheduled', 'planned'].includes(grp(e))).sort((a, b) => a.at - b.at)
    const byDay = new Map()
    for (const e of after) {
      const k = dayKey(e.at)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k).push(e)
    }
    const week = el('section', { class: 'panel' },
      el('div', { class: 'panel-h' }, el('h2', {}, 'Next 7 days'), el('button', { class: 'linkbtn', onclick: () => goSchedule({ range: 'next7' }) }, 'Schedule →')),
      byDay.size ? el('div', { class: 'mini' }, [...byDay].map(([k, l]) => [el('div', { class: 'md' }, fmtDay(startOf(k) + 43200000)), l.map((e) => el('button', { class: 'mrow', onclick: () => showEntry(e) }, el('span', { class: `sdot g-${grp(e)}` }), bdot(e.brand), badge(e.platform), el('span', { class: 't' }, title(e)), el('span', { class: 'tm' }, fmtTime(e.at))))])) : el('div', { class: 'muted' }, 'Nothing else scheduled or planned.'),
    )

    $('#view').replaceChildren(
      hero(fmtLong(Date.now()), head, parts2.join(' · ') || null, isToday ? null : el('button', { class: 'ghost', onclick: () => {
        state.day = t
        renderToday()
      } }, 'Back to today')),
      strip,
      el('section', { class: 'days', 'aria-label': 'Next two weeks' }, days),
      prog,
      stats,
      el('div', { class: 'cols' }, main, el('div', { class: 'side' }, fu, week)),
    )
  }
  const countByStatus = (l) => {
    const m = {}
    for (const e of l) m[e.status] = (m[e.status] || 0) + 1
    return m
  }

  // ---- filters shared by Schedule and Calendar ----
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  function applyFilters(list) {
    const f = state.f
    return list.filter((e) => (!f.groups.length || f.groups.includes(grp(e))) && (!f.platforms.length || f.platforms.includes(e.platform)) && (f.kind === 'all' || (e.kind || 'other') === f.kind))
  }
  function filterBar({ withRange = true, withSort = true }) {
    const f = state.f
    const list = base()
    const rerender = () => {
      state.limit = 150
      remember()
      render()
    }
    const chip = (label, n, on, onclick, dot) => el('button', { class: 'chipbtn', 'aria-pressed': String(on), onclick }, dot, label, el('span', { class: 'n' }, n))
    const kinds = [...new Set(list.map((e) => e.kind || 'other'))]
    const select = (label, value, opts, onchange) => el('label', { class: 'sel' }, label, el('select', { onchange: (ev) => onchange(ev.target.value) }, opts.map(([v, t]) => el('option', { value: v, selected: v === value }, t))))
    const active = f.groups.length || f.platforms.length || f.kind !== 'all' || state.q
    return el('section', { class: 'panel fbar' },
      withRange ? el('div', { class: 'frow' }, el('span', { class: 'lbl' }, 'When'), el('div', { class: 'seg' }, RANGES.map(([v, t]) => el('button', { 'aria-pressed': String(v === f.range), onclick: () => {
        f.range = v
        remember()
        load()
      } }, t)))) : null,
      el('div', { class: 'frow' }, el('span', { class: 'lbl' }, 'Status'), GROUPS.map(([g, name]) => chip(name, list.filter((e) => grp(e) === g).length, f.groups.includes(g), () => {
        f.groups = toggle(f.groups, g)
        rerender()
      }, el('span', { class: `sdot g-${g}` })))),
      el('div', { class: 'frow' }, el('span', { class: 'lbl' }, 'Platform'), allPlatforms().map((p) => chip(PF_NAME[p] || p, list.filter((e) => e.platform === p).length, f.platforms.includes(p), () => {
        f.platforms = toggle(f.platforms, p)
        rerender()
      }, badge(p))),
      el('span', { class: 'spacer' }),
      select('Type', f.kind, [['all', 'All types'], ...kinds.map((k) => [k, KIND[k] || (k === 'other' ? 'Other' : k)])], (v) => {
        f.kind = v
        rerender()
      }),
      withSort ? select('Sort', f.sort, [['time-asc', 'Soonest first'], ['time-desc', 'Newest first'], ['status', 'Needs a look first'], ['brand', 'Brand'], ['platform', 'Platform'], ['views', 'Most viewed']], (v) => {
        f.sort = v
        rerender()
      }) : null,
      withSort ? select('Group', f.group, [['day', 'By day'], ['status', 'By status'], ['brand', 'By brand'], ['platform', 'By platform'], ['none', 'No groups']], (v) => {
        f.group = v
        rerender()
      }) : null,
      active ? el('button', { class: 'linkbtn', onclick: () => {
        Object.assign(f, { groups: [], platforms: [], kind: 'all' })
        state.q = ''
        $('#q').value = ''
        rerender()
      } }, 'Clear filters') : null),
    )
  }

  // ---- Schedule ----
  const views = (e) => e.metrics?.views ?? e.metrics?.impressions
  const acts = (m = {}) => (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0)
  const fmtN = (x) => (x === undefined || x === null ? '–' : x >= 1e6 ? `${Math.round(x / 1e5) / 10}M` : x >= 10000 ? `${Math.round(x / 100) / 10}k` : x.toLocaleString())
  const GORDER = Object.fromEntries(GROUPS.map(([g], i) => [g, i]))
  function sorted(list) {
    const s = state.f.sort
    const byTime = (a, b) => (s === 'time-desc' ? b.at - a.at : a.at - b.at)
    const cmp = {
      'time-asc': byTime,
      'time-desc': byTime,
      status: (a, b) => GORDER[grp(a)] - GORDER[grp(b)] || a.at - b.at,
      brand: (a, b) => brandName(a.brand).localeCompare(brandName(b.brand)) || a.at - b.at,
      platform: (a, b) => a.platform.localeCompare(b.platform) || a.at - b.at,
      views: (a, b) => (views(b) ?? -1) - (views(a) ?? -1) || b.at - a.at,
    }[s] || byTime
    return [...list].sort(cmp)
  }
  function groupKey(e) {
    switch (state.f.group) {
      case 'status': return [grp(e), GROUP_NAME[grp(e)]]
      case 'brand': return [e.brand, brandName(e.brand)]
      case 'platform': return [e.platform, PF_NAME[e.platform] || e.platform]
      case 'none': return ['all', '']
      default: {
        const k = dayKey(e.at)
        return [k, `${fmtDay(e.at)}${k === today() ? ' · today' : k === addDays(today(), 1) ? ' · tomorrow' : ''}`]
      }
    }
  }
  function trow(e) {
    const v = views(e)
    return el('button', { class: 'tr', onclick: () => showEntry(e) },
      el('span', { class: 'c-time' }, state.f.group === 'day' ? null : el('b', {}, fmtDay(e.at).replace(/^\w+, /, '')), fmtTime(e.at)),
      el('span', { class: 'c-av' }, avatar(e.brand)),
      el('span', { class: 'c-title' }, el('b', {}, title(e)), el('span', {}, e.note || (e.text && e.text !== title(e) ? e.text.replace(/\s+/g, ' ').slice(0, 140) : brandName(e.brand)))),
      el('span', { class: 'c-plat' }, badge(e.platform), PF_NAME[e.platform] || e.platform, kindName(e) ? el('span', { class: 'dim' }, `· ${kindName(e)}`) : null),
      el('span', { class: 'c-st' }, pill(e)),
      el('span', { class: 'c-num', title: 'Views' }, v !== undefined ? fmtN(v) : ''),
      el('span', { class: 'c-link' }, extLink(e)),
    )
  }
  function renderSchedule() {
    const list = sorted(applyFilters(base()))
    const shown = list.slice(0, state.limit)
    const groups = new Map()
    for (const e of shown) {
      const [k, name] = groupKey(e)
      if (!groups.has(k)) groups.set(k, { name, items: [] })
      groups.get(k).items.push(e)
    }
    const c = countBy(list)
    const rangeName = Object.fromEntries(RANGES)[state.f.range]
    const sortHead = (label, key) => el('button', { onclick: () => {
      state.f.sort = state.f.sort === key && key === 'time-asc' ? 'time-desc' : key
      remember()
      render()
    } }, label, state.f.sort.startsWith(key.split('-')[0]) ? (state.f.sort === 'time-desc' ? ' ↓' : ' ↑') : '')
    const table = el('section', { class: 'panel tbl' },
      el('div', { class: 'th' }, sortHead('When', 'time-asc'), el('span'), el('span', {}, 'Post'), sortHead('Platform', 'platform'), sortHead('Status', 'status'), el('span', { class: 'c-num' }, sortHead('Views', 'views')), el('span')),
      list.length ? [...groups.values()].map((g) => [g.name ? el('div', { class: 'gh' }, el('span', { class: 'lbl' }, state.f.group === 'status' ? el('span', { class: `sdot g-${grp(g.items[0])}` }) : null, g.name), el('span', { class: 'mono dim' }, g.items.length)) : null, g.items.map(trow)]) : el('div', { class: 'empty' }, 'No posts match these filters.'),
      list.length > shown.length ? el('button', { class: 'ghost more-btn', onclick: () => {
        state.limit += 150
        render()
      } }, `Show ${Math.min(150, list.length - shown.length)} more (${list.length - shown.length} left)`) : null,
    )
    $('#view').replaceChildren(
      hero(rangeName, plural(list.length, 'post'), GROUPS.filter(([g]) => c[g]).map(([g, n]) => `${c[g]} ${n.toLowerCase()}`).join(' · ') || null,
        el('button', { class: 'ghost', onclick: () => exportCsv(list), title: 'Download these posts as a spreadsheet' }, icon('download'), 'CSV')),
      filterBar({}),
      table,
    )
  }
  function exportCsv(list) {
    const q = csvCell
    const head = ['Date', `Time (${TZ})`, 'Brand', 'Platform', 'Type', 'Status', 'Title', 'Views', 'Likes', 'Comments', 'Link', 'Note']
    const rows = list.map((e) => [dayKey(e.at), fmtTime(e.at), brandName(e.brand), PF_NAME[e.platform] || e.platform, kindName(e), STATUS[e.status] || e.status, title(e), views(e) ?? '', e.metrics?.likes ?? '', e.metrics?.comments ?? '', e.url || '', e.note || ''])
    const blob = new Blob(['﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = el('a', { href: URL.createObjectURL(blob), download: `posts-${today()}.csv` })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  // ---- Calendar ----
  function renderCalendar() {
    const g = monthGrid()
    const list = applyFilters(base())
    const byDay = new Map()
    for (const e of list) {
      const k = dayKey(e.at)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k).push(e)
    }
    const t = today()
    const monthK = `${state.month[0]}-${String(state.month[1] + 1).padStart(2, '0')}`
    const inMonth = list.filter((e) => dayKey(e.at).slice(0, 7) === monthK)
    const c = countBy(inMonth)
    const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => el('div', { class: 'dow' }, d))
    for (let i = 0; i < g.days; i++) {
      const k = addDays(g.startKey, i)
      const items = (byDay.get(k) || []).sort((a, b) => a.at - b.at)
      const cell = el('div', { class: `cell${k.slice(0, 7) !== monthK ? ' other' : ''}${k === t ? ' today' : ''}` }, el('div', { class: 'd' }, el('span', {}, Number(k.slice(8))), items.length ? el('span', { class: 'mono dim' }, items.length) : null))
      const MAX = 4
      for (const e of items.slice(0, MAX)) cell.append(el('button', { class: `chip g-${grp(e)}`, title: `${STATUS[e.status]} · ${brandName(e.brand)} · ${PF_NAME[e.platform]} · ${fmtTime(e.at)}\n${title(e)}`, onclick: () => showEntry(e) }, bdot(e.brand), badge(e.platform), el('span', { class: 't' }, title(e))))
      if (items.length > MAX) cell.append(el('button', { class: 'more', onclick: () => openDrawer(el('div', {}, el('h3', {}, fmtLong(startOf(k) + 43200000)), items.map((e) => row(e)))) }, `+${items.length - MAX} more`))
      cells.push(cell)
    }
    const shift = (n) => {
      const d = new Date(Date.UTC(state.month[0], state.month[1] + n, 1))
      state.month = [d.getUTCFullYear(), d.getUTCMonth()]
      load()
    }
    const legend = el('div', { class: 'legend' }, el('span', { class: 'lbl' }, 'Left edge'), GROUPS.map(([gk, n]) => el('span', {}, el('span', { class: `sdot g-${gk}` }), n)), el('span', { class: 'lbl' }, ' · Dot'), Object.keys(state.brands).map((b) => el('span', {}, bdot(b), brandName(b))))
    $('#view').replaceChildren(
      hero(null, fmt({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(state.month[0], state.month[1], 1)), GROUPS.filter(([gk]) => c[gk]).map(([gk, n]) => `${c[gk]} ${n.toLowerCase()}`).join(' · ') || 'Nothing this month',
        el('button', { class: 'icon-btn', onclick: () => shift(-1), 'aria-label': 'Previous month', title: 'Previous month ([)' }, icon('left')),
        el('button', { class: 'ghost', onclick: () => {
          const p = parts(Date.now())
          state.month = [+p.year, +p.month - 1]
          load()
        } }, 'This month'),
        el('button', { class: 'icon-btn', onclick: () => shift(1), 'aria-label': 'Next month', title: 'Next month (])' }, icon('right'))),
      filterBar({ withRange: false, withSort: false }),
      legend,
      el('div', { class: 'cal' }, cells),
    )
    renderCalendar.shift = shift
  }

  // ---- Performance ----
  function renderPerformance() {
    const P = state.p
    const pub = base().filter((e) => grp(e) === 'published' && e.at <= Date.now() && (!P.platforms.length || P.platforms.includes(e.platform)) && (P.kind === 'all' || (e.kind || 'other') === P.kind))
    const withNums = pub.filter((e) => e.metrics)
    const eng = (e) => (views(e) ? acts(e.metrics) / views(e) : undefined)
    const COLS = [
      ['date', 'Date', (e) => e.at],
      ['where', 'Where', (e) => `${e.platform}${e.brand}`],
      ['post', 'Post', (e) => title(e).toLowerCase()],
      ['views', 'Views', views],
      ['likes', 'Likes', (e) => e.metrics.likes],
      ['comments', 'Comments', (e) => e.metrics.comments],
      ['shares', 'Shares', (e) => e.metrics.shares],
      ['saves', 'Saves', (e) => e.metrics.saves],
      ['eng', 'Eng.', eng],
      ['watched', '% watched', (e) => e.metrics.avgPctWatched],
    ]
    const col = COLS.find((c) => c[0] === P.sort) || COLS[3]
    const rows = [...withNums].sort((a, b) => {
      const x = col[2](a)
      const y = col[2](b)
      if (x === y) return b.at - a.at
      if (x === undefined || x === null) return 1
      if (y === undefined || y === null) return -1
      return (x < y ? -1 : 1) * P.dir
    })
    const totalViews = withNums.reduce((s, e) => s + (views(e) || 0), 0)
    const engs = withNums.map(eng).filter((x) => x !== undefined)
    const best = [...withNums].sort((a, b) => (views(b) ?? -1) - (views(a) ?? -1))[0]
    const maxV = Math.max(1, ...withNums.map((e) => views(e) || 0))
    const stat = (label, ico, big, sub, onclick) => el(onclick ? 'button' : 'div', { class: 'stat', onclick }, el('div', { class: 'top-row' }, label, icon(ico)), el('div', { class: 'big' }, big), el('div', { class: 'who' }, sub))

    // per platform summary
    const byPlat = new Map()
    for (const e of withNums) {
      const k = `${e.brand}|${e.platform}`
      if (!byPlat.has(k)) byPlat.set(k, { brand: e.brand, platform: e.platform, n: 0, v: 0, a: 0 })
      const s = byPlat.get(k)
      s.n++
      s.v += views(e) || 0
      s.a += acts(e.metrics)
    }
    const plats = [...byPlat.values()].sort((a, b) => b.v / b.n - a.v / a.n)
    const maxAvg = Math.max(1, ...plats.map((s) => s.v / s.n))
    const bar = (x, max) => {
      const b = el('span', { class: 'bar' })
      b.style.width = `${Math.max(2, Math.round((x / max) * 90))}px`
      return b
    }

    const kinds = [...new Set(base().filter((e) => grp(e) === 'published').map((e) => e.kind || 'other'))]
    const lim = (state.data.sync?.results || []).filter((r) => r.limited?.length)
    const controls = el('section', { class: 'panel fbar' },
      el('div', { class: 'frow' }, el('span', { class: 'lbl' }, 'Period'), el('div', { class: 'seg' }, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([d, t]) => el('button', { 'aria-pressed': String(P.days === d), onclick: () => {
        P.days = d
        remember()
        load()
      } }, t)))),
      el('div', { class: 'frow' }, el('span', { class: 'lbl' }, 'Platform'), allPlatforms().filter((p) => p !== 'blog').map((p) => el('button', { class: 'chipbtn', 'aria-pressed': String(P.platforms.includes(p)), onclick: () => {
        P.platforms = toggle(P.platforms, p)
        remember()
        render()
      } }, badge(p), PF_NAME[p] || p)), el('span', { class: 'spacer' }),
      el('label', { class: 'sel' }, 'Type', el('select', { onchange: (ev) => {
        P.kind = ev.target.value
        remember()
        render()
      } }, [['all', 'All types'], ...kinds.map((k) => [k, KIND[k] || 'Other'])].map(([v, t]) => el('option', { value: v, selected: v === P.kind }, t))))),
    )
    const th = (c, i) => el('th', { class: i < 3 ? 'l' : '', 'aria-sort': P.sort === c[0] ? (P.dir < 0 ? 'descending' : 'ascending') : null }, el('button', { onclick: () => {
      if (P.sort === c[0]) P.dir = -P.dir
      else {
        P.sort = c[0]
        P.dir = ['post', 'where'].includes(c[0]) ? 1 : -1
      }
      remember()
      render()
    } }, c[1], P.sort === c[0] ? (P.dir < 0 ? ' ↓' : ' ↑') : ''))
    const table = rows.length
      ? el('div', { class: 'perfwrap' }, el('table', { class: 'perf' }, el('thead', {}, el('tr', {}, COLS.map(th))), el('tbody', {}, rows.slice(0, state.limit === 150 ? 40 : state.limit).map((e) => {
        const m = e.metrics
        const v = views(e)
        const en = eng(e)
        return el('tr', { onclick: () => showEntry(e) },
          el('td', { class: 'l' }, fmtDay(e.at).replace(/^\w+, /, '')),
          el('td', { class: 'l' }, el('span', { class: 'who' }, bdot(e.brand), ' ', badge(e.platform), kindName(e) ? ` ${kindName(e)}` : '')),
          el('td', { class: 'l t' }, title(e)),
          el('td', {}, v ? bar(v, maxV) : null, fmtN(v)),
          el('td', {}, fmtN(m.likes)),
          el('td', {}, fmtN(m.comments)),
          el('td', {}, fmtN(m.shares)),
          el('td', {}, fmtN(m.saves)),
          el('td', {}, en !== undefined ? `${Math.round(en * 1000) / 10}%` : '–'),
          el('td', {}, m.avgPctWatched !== undefined ? `${m.avgPctWatched}%` : '–'),
        )
      }))))
      : el('div', { class: 'empty' }, 'No numbers yet for these filters. They arrive with the next platform check.')

    $('#view').replaceChildren(
      hero(`Last ${P.days} days`, 'Performance', 'Published posts and their numbers. Older posts have had more time to collect views.'),
      controls,
      el('section', { class: 'stats' },
        stat('Posts with numbers', 'send', withNums.length, `${pub.length} published in all`),
        stat('Views', 'chart', fmtN(totalViews), withNums.length ? `${fmtN(Math.round(totalViews / withNums.length))} per post on average` : '–'),
        stat('Engagement', 'check', engs.length ? `${Math.round((engs.reduce((s, x) => s + x, 0) / engs.length) * 1000) / 10}%` : '–', 'likes + comments + shares + saves, ÷ views'),
        stat('Top post', 'alert', best ? fmtN(views(best)) : '–', best ? `${title(best)} · ${PF_NAME[best.platform]}` : 'Nothing yet', best ? () => showEntry(best) : null),
      ),
      plats.length ? el('section', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', {}, 'Average views per post'), el('span', { class: 'mono dim' }, 'by brand and platform')),
        el('table', { class: 'perf' }, el('thead', {}, el('tr', {}, ['Account', 'Posts', 'Avg views', 'Total views', 'Eng.'].map((h, i) => el('th', { class: i === 0 ? 'l' : '' }, h)))), el('tbody', {}, plats.map((s) => el('tr', { onclick: () => {
          P.platforms = [s.platform]
          state.brand = s.brand
          remember()
          render()
        } }, el('td', { class: 'l' }, el('span', { class: 'who' }, bdot(s.brand), ' ', brandName(s.brand), ' ', badge(s.platform))), el('td', {}, s.n), el('td', {}, bar(s.v / s.n, maxAvg), fmtN(Math.round(s.v / s.n))), el('td', {}, fmtN(s.v)), el('td', {}, s.v ? `${Math.round((s.a / s.v) * 1000) / 10}%` : '–')))))) : null,
      el('section', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', {}, 'Every post'), el('span', { class: 'mono dim' }, 'click a column to sort')), table,
        rows.length > (state.limit === 150 ? 40 : state.limit) ? el('button', { class: 'ghost more-btn', onclick: () => {
          state.limit = (state.limit === 150 ? 40 : state.limit) + 60
          render()
        } }, `Show more (${rows.length - (state.limit === 150 ? 40 : state.limit)} left)`) : null,
        lim.length ? el('p', { class: 'muted small' }, `Not available yet: ${lim.map((r) => `${brandName(r.brand)} ${PF_NAME[r.platform] || r.platform} (${r.limited.join(', ')})`).join('; ')}.`) : null),
    )
  }

  // ---- detail drawer ----
  function openDrawer(content) {
    $('#drawerbody').replaceChildren(content)
    $('#drawer').hidden = false
    $('#scrim').hidden = false
    $('#drawerclose').focus()
  }
  const closeDrawer = () => {
    $('#drawer').hidden = true
    $('#scrim').hidden = true
  }
  $('#drawerclose').onclick = closeDrawer
  $('#scrim').onclick = closeDrawer

  function showEntry(e) {
    const dl = el('dl', {})
    const r = (k, v) => v && dl.append(el('dt', {}, k), el('dd', {}, v))
    r('Status', pill(e))
    r('Brand', el('span', { class: 'who' }, bdot(e.brand), ' ', brandName(e.brand)))
    r('Platform', el('span', { class: 'who' }, badge(e.platform), ' ', PF_NAME[e.platform] || e.platform, kindName(e) ? ` · ${kindName(e)}` : ''))
    r('Time', `${fmtFull(e.at)} (${inDays(e.at)})`)
    if (e.planAt && Math.abs(e.planAt - e.at) > 60000) r('Planned for', fmtFull(e.planAt))
    r('Source', SOURCE[e.source] + (e.planId && e.source !== 'plan' ? ' · matches a plan item' : ''))
    if (e.metrics) {
      const m = e.metrics
      const L = { views: 'views', impressions: 'impressions', reach: 'reached', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', clicks: 'clicks', outbound: 'link clicks', watchMinutes: 'minutes watched', avgWatchSec: 's average watch', avgPctWatched: '% watched on average', subscribers: 'new subscribers', replays: 'replays', interactions: 'interactions', followers: 'new followers' }
      r('Numbers', Object.entries(m).filter(([k]) => L[k]).map(([k, v]) => `${fmtN(v)} ${L[k]}`).join(' · ') + (e.metricsAt ? ` (as of ${fmtFull(e.metricsAt)})` : ''))
    }
    r('Note', e.note)
    r('Error', e.error && el('span', { class: 'error' }, e.error))
    r('Post file', e.spec)
    const actions = el('div', { class: 'actions' })
    if (e.url) actions.append(el('a', { class: 'primary', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open post', icon('ext')))
    if (e.text) actions.append(el('button', { class: 'ghost', onclick: async () => {
      try {
        await navigator.clipboard.writeText(e.text)
        toast('Caption copied')
      } catch {
        toast('Could not copy')
      }
    } }, icon('copy'), 'Copy caption'))
    if (e.source === 'plan') {
      const act = (label, fn) => el('button', { class: 'ghost', onclick: async () => {
        try {
          await fn()
          closeDrawer()
          toast('Saved')
          load(true)
        } catch (err) {
          if (err.message !== 'Not deleted') alert(err.message)
        }
      } }, label)
      if (e.status !== 'skipped') actions.append(act('Mark as skipped', () => api(`plan/${e.planId}`, { method: 'POST', body: JSON.stringify({ state: 'skipped' }) })))
      if (!e.manual && e.status !== 'published') actions.append(act('Mark as posted by hand', () => api(`plan/${e.planId}`, { method: 'POST', body: JSON.stringify({ state: 'done' }) })))
      if (e.status === 'skipped' || e.manual) actions.append(act('Reopen', () => api(`plan/${e.planId}`, { method: 'POST', body: JSON.stringify({ state: 'open' }) })))
      actions.append(act('Delete from plan', () => (confirm('Delete this plan item?') ? api(`plan/${e.planId}`, { method: 'DELETE' }) : Promise.reject(new Error('Not deleted')))))
    }
    openDrawer(el('div', {}, el('h3', {}, title(e)), EXPLAIN[e.status] ? el('div', { class: 'explain' }, EXPLAIN[e.status]) : null, dl, e.text ? el('pre', {}, e.text) : null, actions))
  }

  // ---- add to plan ----
  function openPlan() {
    const dlg = $('#plandlg')
    const f = $('#planform')
    f.reset()
    $('#planerr').hidden = true
    const brands = Object.keys(state.brands)
    $('#pbrand').replaceChildren(...brands.map((b) => el('option', { value: b, selected: b === state.brand }, brandName(b))))
    const fillPlats = () => {
      const ps = state.brands[$('#pbrand').value]?.platforms || []
      $('#pplats').replaceChildren(el('legend', {}, 'Platforms'), ...ps.map((p) => el('label', {}, el('input', { type: 'checkbox', name: 'platform', value: p, checked: p !== 'pinterest' }), PF_NAME[p] || p)))
    }
    $('#pbrand').onchange = fillPlats
    fillPlats()
    // On Today with a future day picked, default to that day.
    f.date.value = state.view === 'today' && state.day && state.day > today() ? state.day : addDays(today(), 1)
    dlg.showModal()
  }
  $('#planform').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'save') return
    ev.preventDefault()
    const f = ev.target
    const plats = [...f.querySelectorAll('input[name=platform]:checked')].map((i) => i.value)
    const err = (m) => {
      $('#planerr').textContent = m
      $('#planerr').hidden = false
    }
    if (!plats.length) return err('Pick at least one platform.')
    const [y, m, d] = f.date.value.split('-').map(Number)
    const [hh, mm] = f.time.value.split(':').map(Number)
    const at = zoned(y, m - 1, d, hh, mm)
    const match = f.match.value.trim()
    try {
      await api('plan', { method: 'POST', body: JSON.stringify({ items: plats.map((platform) => ({ brand: f.brand.value, platform, at, title: f.title.value.trim(), match: match || undefined, note: f.note.value.trim() || undefined })) }) })
      $('#plandlg').close()
      toast('Added to the plan')
      load(true)
    } catch (e) {
      err(e.message)
    }
  })

  // ---- wiring ----
  function setView(v) {
    state.view = v
    state.limit = 150
    remember()
    if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`)
    renderBrands()
    window.scrollTo({ top: 0 })
    load()
  }
  const nowP = parts(Date.now())
  state.month = [+nowP.year, +nowP.month - 1]
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => setView(b.dataset.view)
  window.addEventListener('hashchange', () => VIEWS.includes(location.hash.slice(1)) && location.hash.slice(1) !== state.view && setView(location.hash.slice(1)))
  $('#addbtn').onclick = openPlan
  let qTimer
  $('#q').addEventListener('input', (ev) => {
    clearTimeout(qTimer)
    qTimer = setTimeout(() => {
      state.q = ev.target.value.trim()
      state.limit = 150
      render()
    }, 120)
  })
  async function syncNow() {
    const btn = $('#syncbtn')
    btn.disabled = true
    btn.classList.add('spin')
    try {
      await api('sync', { method: 'POST', body: '{}' })
      await load(true)
      toast('Platforms checked')
    } catch (e) {
      alert(`Could not check the platforms: ${e.message}`)
    } finally {
      btn.disabled = false
      btn.classList.remove('spin')
    }
  }
  $('#syncbtn').onclick = syncNow
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeDrawer()
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || $('#plandlg').open
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') {
      e.preventDefault()
      $('#q').focus()
    } else if (e.key === 'n') {
      e.preventDefault()
      openPlan()
    } else if (['1', '2', '3', '4'].includes(e.key)) setView(VIEWS[+e.key - 1])
    else if (state.view === 'calendar' && (e.key === '[' || e.key === ']')) renderCalendar.shift?.(e.key === '[' ? -1 : 1)
  })
  // Keep the page fresh when it stays open (data only; the platforms sync on their own every 3 h).
  setInterval(() => document.visibilityState === 'visible' && $('#drawer').hidden && !$('#plandlg').open && load(true), 5 * 60000)
  if (location.hash.slice(1) !== state.view) history.replaceState(null, '', `#${state.view}`)
  load()
}

/**
 * One CSV cell, quoted. A cell that starts with = + - @ (or a tab / carriage return) gets a
 * leading ' so a spreadsheet shows it as text instead of running it as a formula: titles,
 * notes and captions come from the platforms and can hold anything.
 */
export function csvCell(v) {
  let s = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return `"${s.replace(/"/g, '""')}"`
}

// wrangler's bundler wraps named functions in __name(fn, "name") (keepNames). The page has no
// such helper, so the script defines a no-op one before the function text.
export const APP_JS = `var __name = (f) => f;\nvar csvCell = ${csvCell.toString()};\n(${appMain.toString()})()\n`
