"use strict";
/*
 * The Claude Code side of the view layer.
 *
 * Claude has no widget system: its Preview pane attaches to servers declared
 * in <projectRoot>/.claude/launch.json, by config name. So "show the IDE"
 * here means writing that file and handing the model a config name to pass to
 * preview_start. Everything else — discovery, launch, setup — is the shared
 * core; this file is only how the pane gets summoned.
 *
 * Ported from the legacy claude_plugin, which learned the two rules the hard
 * way:
 *   - one config PER PORT ("vibefoundry-<port>"), because launch.json is
 *     shared by every conversation in the project and a single shared name
 *     lets one conversation's launch clobber another's pane;
 *   - attach-only (url + port, no command), because a runtimeExecutable would
 *     make the pane spawn `vibefoundry` from the app's own PATH — which fails
 *     on machines where only our conda knows the command — and then refuse to
 *     attach to the "unrecognized" process holding the port.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { portOpen } = require("./instances");

// --- the setup progress page ---------------------------------------------------
// Claude has no widget system, but the plugin is a local process — so during
// setup it serves one small page itself and registers it as a preview. The page
// polls /state and renders the live step list; every word on it is written by
// the code doing the installing. One preview_start opens it; after that, zero
// model involvement. The server lives for the conversation and costs nothing.
let progressServer = null;

function progressHtml() {
  return `<!doctype html><meta charset="utf-8"><title>VibeFoundry Setup</title>
<style>
.vfdots span{opacity:.15;animation:vfb 1.2s infinite}
.vfdots span:nth-child(2){animation-delay:.2s}
.vfdots span:nth-child(3){animation-delay:.4s}
@keyframes vfb{0%,80%,100%{opacity:.15}30%{opacity:1}}
</style><body style="margin:0;font-family:ui-sans-serif,-apple-system,system-ui;background:#fff;color:#0d0d0d">
<div style="max-width:520px;margin:8vh auto;padding:0 24px">
<div style="font-size:44px;font-weight:800;color:#2070e8;letter-spacing:-2px">vf</div>
<h2 style="margin:8px 0 4px;font-size:20px">Setting Up Your Computer</h2>
<div style="font-size:12px;color:#5d5d5d;margin-bottom:4px">This can take 5 to 10 minutes — I'll update you when we're done!</div>
<div id="sub" style="color:#5d5d5d;font-size:13px;margin-bottom:20px">starting…</div>
<div id="steps"></div>
<div id="msg" style="color:#5d5d5d;font-size:13px;margin-top:14px;min-height:18px"></div>
</div>
<script>
async function tick(){
  try{
    const s = await (await fetch('/state')).json();
    const steps = document.getElementById('steps');
    steps.innerHTML = (s.plan||[]).map(function(p,i){
      const active = s.current && s.current.index === i+1;
      const mark = p.satisfied ? '✓' : active ? '→' : '·';
      const color = p.satisfied ? '#1a7f37' : active ? '#2070e8' : '#8f8f8f';
      const weight = active ? 600 : 400;
      return '<div style="padding:6px 0;font-size:15px;color:'+color+';font-weight:'+weight+'">'+mark+'  '+p.title+(active?'<span class=\"vfdots\"><span>.</span><span>.</span><span>.</span></span>':'')+'</div>';
    }).join('');
    document.getElementById('msg').textContent = s.message || (s.error ? '✗ ' + s.error : '');
    const sub = document.getElementById('sub');
    if (s.phase === 'done') sub.textContent = '✓ All set — ' + (s.version||'') + '. Say "open VibeFoundry" in the chat.';
    else if (s.phase === 'failed') sub.textContent = 'Setup stopped — the fix is below. Say "set me up" again to resume.';
    else if (s.current) sub.textContent = 'Step ' + s.current.index + ' of ' + s.current.total;
    else sub.textContent = 'preparing…';
  }catch(e){/* server briefly busy between steps */}
  setTimeout(tick, 700);
}
tick();
</script></body>`;
}

/**
 * Serve the progress page on an ephemeral port; idempotent per process.
 * Resolves the port, or null if the OS refused a socket.
 */
function startProgressServer(getState) {
  if (progressServer) return Promise.resolve(progressServer.address().port);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getState()));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(progressHtml());
    });
    srv.on("error", () => resolve(null));
    srv.listen(0, "127.0.0.1", () => {
      progressServer = srv;
      resolve(srv.address().port);
    });
  });
}

/**
 * Register `port` with the project's Preview pane. Returns the config name for
 * preview_start, or null if the file could not be written (the caller falls
 * back to telling the user the URL).
 */
async function writeLaunchConfig(projectRoot, port, nameOverride) {
  if (!projectRoot || !port) return null;
  const name = nameOverride || `vibefoundry-${port}`;
  const dir = path.join(projectRoot, ".claude");
  const file = path.join(dir, "launch.json");

  let doc = { version: "0.0.1", configurations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.configurations)) doc = parsed;
  } catch {
    /* missing or unparseable — start fresh */
  }
  if (!Array.isArray(doc.configurations)) doc.configurations = [];

  // Preserve non-vibefoundry configs untouched. Among our own family, drop
  // this port's old entry (re-added below) and any whose port no longer
  // answers; keep other conversations' LIVE panes so we never knock one
  // offline.
  const kept = [];
  for (const c of doc.configurations) {
    const isVf = c && typeof c.name === "string" && /^vibefoundry-(\d+|setup)$/.test(c.name);
    if (!isVf) {
      kept.push(c);
      continue;
    }
    if (c.name === name) continue;
    if (await portOpen(c.port)) kept.push(c);
  }

  // Bare origin ONLY: Claude rejects localhost preview URLs carrying a path or
  // query ("a localhost url must be just the server's origin"), which killed
  // the ?pane=1 marker riding in this url. The sanctioned pattern is the one
  // its own error message names: open the bare origin, then NAVIGATE the
  // preview to the page — so the ?pane=1 hop happens as a model instruction
  // after preview_start, and the app persists the marker in the webview's own
  // storage so every later bare-origin load stays in pane mode.
  kept.push({ name, url: `http://localhost:${port}`, port });
  doc.configurations = kept;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  } catch {
    return null;
  }
  return name;
}

module.exports = { writeLaunchConfig, startProgressServer };
