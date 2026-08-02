#!/usr/bin/env node
"use strict";
/*
 * Drive the server the way a host would — real JSON-RPC over real stdio — so a
 * pass here means the protocol works, not just that the functions do.
 *
 *     node server/selftest.js <folder>          # everything except launching
 *     node server/selftest.js <folder> --launch # also opens a terminal window
 *
 * --launch is opt-in because it opens a window and starts a server on your
 * machine; the default run is read-only.
 */

const { spawn } = require("child_process");
const path = require("path");

const folder = process.argv[2] || process.cwd();
const doLaunch = process.argv.includes("--launch");

// By default this drives the source through node. Set VF_SERVER_CMD to drive a
// compiled binary instead — the same checks then certify the artifact that
// actually ships, not just the source it was built from.
const serverCmd = process.env.VF_SERVER_CMD
  ? [process.env.VF_SERVER_CMD]
  : ["node", path.join(__dirname, "index.js")];
console.log(`server under test: ${serverCmd.join(" ")}`);

const child = spawn(serverCmd[0], serverCmd.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, VF_SETUP_NO_WINDOW: "1" },
});

let buf = "";
const waiters = new Map();

// The server asks US things too (roots/list), so this harness has to behave like
// a real client and answer them. Without this the roots path is dead code that
// times out silently and falls back to the model's argument — which is the exact
// behaviour it exists to replace.
const rootsRequests = [];
let currentRoots = [folder]; // what this fake client answers roots/list with
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.method === "roots/list") {
      rootsRequests.push(msg);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { roots: currentRoots.map((p) => ({ uri: `file://${encodeURI(p)}`, name: "workspace" })) },
        }) + "\n"
      );
      continue;
    }

    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
}

let nextId = 1;
function call(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  console.log("\ninitialize");
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: "vibefoundry-selftest", version: "1.0.0" },
  });
  check("serverInfo.name is vibefoundry", init.result?.serverInfo?.name === "vibefoundry");
  check("instructions present", typeof init.result?.instructions === "string" && init.result.instructions.length > 50);

  notify("notifications/initialized");

  console.log("\nworkspace roots");
  // The server asks on initialized; give it a beat to make the round trip.
  await new Promise((r) => setTimeout(r, 500));
  check("asked the client for roots/list", rootsRequests.length >= 1, `${rootsRequests.length} request(s)`);

  const diag = await call("tools/call", { name: "vf_request", arguments: { path: "/__plugin/log" } });
  const d = diag.result?.structuredContent?.json || {};
  check("sees the client's roots capability", d.supportsRoots === true);
  check("resolved the root from the client, not the model", Array.isArray(d.roots) && d.roots.length === 1, (d.roots || []).join(", "));
  check("diagnostics record the spawn context", typeof d.cwd === "string" && Array.isArray(d.log), `cwd=${d.cwd}, ${(d.log || []).length} events`);

  console.log("\ntools/list");
  const tools = await call("tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  check(
    "exposes exactly open_vibefoundry + setup_vibefoundry + vf_request",
    names.length === 3 && ["open_vibefoundry", "setup_vibefoundry", "vf_request"].every((n) => names.includes(n)),
    names.join(", ")
  );
  const open = (tools.result?.tools || []).find((t) => t.name === "open_vibefoundry");
  check("open_vibefoundry is linked to the widget", open?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");

  // Dry-run + the announce call only: the real steps install software, which a
  // selftest must not. The announce call is safe by design — the first call
  // never installs, it states the plan.
  console.log("\nsetup_vibefoundry (dry run + announce)");
  const setup = await call("tools/call", { name: "setup_vibefoundry", arguments: { dryRun: true } }, 180000);
  const plan = setup.result?.structuredContent?.plan || [];
  check("dry run reports the full plan", setup.result?.structuredContent?.phase === "dryrun" && plan.length === 5,
    plan.map((s) => `${s.key}:${s.satisfied ? "ok" : "todo"}`).join(", "));

  const announce = await call("tools/call", { name: "setup_vibefoundry", arguments: {} }, 180000);
  const asc = announce.result?.structuredContent || {};
  const atext = announce.result?.content?.[0]?.text || "";
  if (asc.phase === "announce") {
    check("first call announces, installs nothing", atext.startsWith("⟦I'll set up your computer!"),
      atext.split("\n")[0]);
    check("announce tells the model to relay and call again", /call setup_vibefoundry again/i.test(atext));
  } else {
    // A machine with everything satisfied short-circuits to done — also valid.
    check("first call reports already set up", asc.phase === "done", `phase=${asc.phase}`);
  }

  console.log("\nresources/read (the setup widget — must need nothing installed)");
  const sw = await call("resources/read", { uri: "ui://widget/vibefoundry-setup.html" });
  const swHtml = sw.result?.contents?.[0]?.text || "";
  check("setup widget serves from the plugin itself", swHtml.includes("Setting up your computer"), `${(swHtml.length/1024).toFixed(1)} KB`);
  const setupTool = (tools.result?.tools || []).find((t) => t.name === "setup_vibefoundry");
  check("setup tool is linked to its own widget", setupTool?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry-setup.html");

  console.log("\nresources/read (pane on a bare machine — must fall back, never error)");
  // A fresh child with PATH pointing nowhere useful and HOME moved, so neither
  // the login shell nor the conda path can find vibefoundry.
  // Spawn via THIS harness's own interpreter — the stripped PATH is meant to
  // starve the server's probes, not the spawn itself.
  const bare = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, VF_SETUP_NO_WINDOW: "1", PATH: "/usr/bin:/bin", HOME: require("os").tmpdir(), SHELL: "/bin/sh" },
  });
  let bbuf = ""; const bwait = new Map();
  bare.stdout.setEncoding("utf8");
  bare.stdout.on("data", (ch) => { bbuf += ch; let nl;
    while ((nl = bbuf.indexOf("\n")) !== -1) { const line = bbuf.slice(0, nl).trim(); bbuf = bbuf.slice(nl + 1);
      if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === "roots/list") { bare.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { roots: [] } }) + "\n"); continue; }
      const w = bwait.get(m.id); if (w) { bwait.delete(m.id); w(m); } } });
  let bid = 5000;
  const bcall = (method, params) => new Promise((res, rej) => {
    const id = bid++; const t = setTimeout(() => rej(new Error(method + " timed out")), 30000);
    bwait.set(id, (m) => { clearTimeout(t); res(m); });
    bare.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await bcall("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
  const bres = await bcall("resources/read", { uri: "ui://widget/vibefoundry.html" });
  const bhtml = bres.result?.contents?.[0]?.text || "";
  check("bare machine gets the fallback card, not an error", !bres.error && bhtml.includes("set me up to vibe code"), bres.error ? bres.error.message : `${(bhtml.length/1024).toFixed(1)} KB`);
  bare.kill();

  console.log("\nresources/read (the pane bundle)");
  const res = await call("resources/read", { uri: "ui://widget/vibefoundry.html" });
  const html = res.result?.contents?.[0]?.text;
  check("returns HTML", typeof html === "string" && html.startsWith("<!doctype html"), html ? `${(html.length / 1024).toFixed(0)} KB` : String(res.error?.message));
  check("is self-contained (no external script src)", typeof html === "string" && !/<script[^>]+src=["']https?:/i.test(html));

  // Withdraw the roots so the model's argument is back in charge — the only
  // state in which a bad projectRoot can reach the launcher at all. Doing it
  // this way also proves list_changed really drops the cache: if it did not,
  // the server would still hold the old root and quietly LAUNCH here rather
  // than report the bad path, which is how this check turned a read-only run
  // into one that started a backend and scaffolded a folder.
  console.log("\nroots/list_changed invalidates the cached root");
  currentRoots = [];
  notify("notifications/roots/list_changed");
  await new Promise((r) => setTimeout(r, 400));
  const cleared = await call("tools/call", { name: "vf_request", arguments: { path: "/__plugin/log" } });
  check(
    "cache dropped when the workspace changed",
    (cleared.result?.structuredContent?.json?.roots || []).length === 0,
    JSON.stringify(cleared.result?.structuredContent?.json?.roots)
  );

  console.log("\nbad input is reported, not crashed");
  const bad = await call("tools/call", { name: "open_vibefoundry", arguments: { projectRoot: "/nope/does/not/exist" } });
  check("missing folder returns isError", bad.result?.isError === true, bad.result?.content?.[0]?.text);
  const none = await call("tools/call", { name: "open_vibefoundry", arguments: {} });
  check("no root and no argument is reported, not guessed", none.result?.isError === true, none.result?.content?.[0]?.text);
  const unknown = await call("tools/call", { name: "no_such_tool", arguments: {} });
  check("unknown tool returns an error", !!unknown.error);

  // Put the workspace back for the launch section below.
  currentRoots = [folder];
  notify("notifications/roots/list_changed");
  await new Promise((r) => setTimeout(r, 400));

  // The pane can be rendered in a process that never launched anything, and the
  // relay must NOT go looking for any backend it can find. Attaching to an
  // unrelated instance is the failure this asserts against: it made the IDE open
  // whatever folder happened to be running rather than the one asked for. With
  // no folder established in this process there is no right backend, so the only
  // correct answer is to refuse — whether or not something is running.
  console.log("\nvf_request with no launch in this process");
  const { discover } = require("./instances");
  const alreadyRunning = await discover();
  const early = await call("tools/call", { name: "vf_request", arguments: { path: "/api/health" } });
  check(
    "refuses rather than adopting an unrelated backend",
    early.result?.isError === true,
    alreadyRunning.length
      ? `${alreadyRunning.length} running (ports ${alreadyRunning.map((i) => i.port).join("/")}) and none adopted`
      : "nothing running"
  );

  if (doLaunch) {
    console.log(`\nopen_vibefoundry on ${folder}  (opens a terminal window)`);
    // Pass a WRONG projectRoot on purpose. The client reported a root, so the
    // root must win and this argument must be ignored — that is the difference
    // between the folder being known and merely believed, and it is the bug the
    // whole roots path exists to make impossible.
    const first = await call("tools/call", {
      name: "open_vibefoundry",
      arguments: { projectRoot: require("os").homedir() },
    });
    const fsc = first.result?.structuredContent || {};
    console.log(`  -> status=${fsc.status}`);
    console.log(`     ${(first.result?.content?.[0]?.text || "").split("\n").join("\n     ")}`);

    check(
      "opens without asking anything first",
      fsc.status === "ok",
      fsc.status === "ok" ? `port ${fsc.port}${fsc.adopted ? " (adopted)" : " (launched)"}` : fsc.error || fsc.status
    );

    if (fsc.status === "ok") {
      check("pane is linked on the result", first.result?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");
      check(
        "opened the client's root, ignoring the wrong projectRoot",
        String(fsc.projectFolder || "").replace(/^\/private/, "") === folder.replace(/^\/private/, ""),
        `${fsc.projectFolder} (argument said ${require("os").homedir()})`
      );

      // The determinism guarantee: asking for the same folder again must land on
      // the same backend, not start a second one beside it.
      console.log("\nopen_vibefoundry again on the same folder");
      const again = await call("tools/call", { name: "open_vibefoundry", arguments: { projectRoot: folder } });
      const asc = again.result?.structuredContent || {};
      check(
        "same folder twice returns the same instance",
        asc.status === "ok" && asc.port === fsc.port && asc.adopted === true,
        `port ${asc.port} (first was ${fsc.port}), adopted=${asc.adopted}`
      );

      console.log("\nvf_request against the live backend");
      const health = await call("tools/call", { name: "vf_request", arguments: { path: "/api/health" } });
      const hj = health.result?.structuredContent?.json;
      check("proxies /api/health", hj?.status === "ok", `version ${hj?.version}, folder ${hj?.project_folder}`);

      const tree = await call("tools/call", { name: "vf_request", arguments: { path: "/api/files/tree" } });
      check("proxies /api/files/tree", !!tree.result?.structuredContent?.json?.tree);

      const csp = await call("resources/read", { uri: "ui://widget/vibefoundry.html" });
      const domains = csp.result?.contents?.[0]?._meta?.ui?.csp?.connectDomains || [];
      check("pane CSP names the live backend", domains.some((d) => d.includes(String(fsc.port))), domains.join(", "));

      console.log(`\n  Leaving the backend running on port ${fsc.port}.`);
      console.log(`  Stop it with Ctrl+C in its terminal window.`);
    }
  } else {
    console.log("\n(skipping launch — pass --launch to open a terminal and test end to end)");
  }

  // --- second pass: the same server as CLAUDE sees it -------------------------
  // A fresh process (host is decided once, at initialize), introducing itself
  // as Claude Code. The only differences allowed are the view layer: Claude
  // instructions mention preview_start, and — with a backend adoptable — the
  // open result carries a previewConfigName and a written launch.json.
  console.log("\nclaude host pass (fresh server, claude clientInfo)");
  const c = spawn(serverCmd[0], serverCmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, VF_SETUP_NO_WINDOW: "1" } });
  let cbuf = "";
  const cwaiters = new Map();
  c.stdout.setEncoding("utf8");
  c.stdout.on("data", (chunk) => {
    cbuf += chunk;
    let nl;
    while ((nl = cbuf.indexOf("\n")) !== -1) {
      const line = cbuf.slice(0, nl).trim();
      cbuf = cbuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === "roots/list") {
        c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: currentRoots.map((p) => ({ uri: `file://${encodeURI(p)}`, name: "workspace" })) } }) + "\n");
        continue;
      }
      const w = cwaiters.get(msg.id);
      if (w) { cwaiters.delete(msg.id); w(msg); }
    }
  });
  let cid = 1000;
  const ccall = (method, params, timeoutMs = 90000) => {
    const id = cid++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      cwaiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  const cinit = await ccall("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: "claude-code", version: "2.0.0" },
  });
  check("claude gets the preview_start instructions", /preview_start/.test(cinit.result?.instructions || ""));
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 400));

  // Setup's progress pane must register even when the host answers NO roots —
  // real Claude doesn't — using the model-passed projectRoot as the fallback.
  currentRoots = [];
  const csetup1 = await ccall("tools/call", { name: "setup_vibefoundry", arguments: { projectRoot: folder } });
  const cs1 = csetup1.result?.structuredContent || {};
  if (cs1.phase === "announce") {
    check("claude setup registers the progress pane without roots", cs1.setupPreviewConfigName === "vibefoundry-setup", String(cs1.setupPreviewConfigName));
    let sEntry = null;
    try { sEntry = JSON.parse(require("fs").readFileSync(path.join(folder, ".claude", "launch.json"), "utf8")).configurations.find((x) => x.name === "vibefoundry-setup"); } catch { /* checked below */ }
    check("launch.json holds the setup pane, attach-only bare origin", !!sEntry && /^http:\/\/localhost:\d+$/.test(sEntry.url) && !sEntry.command, JSON.stringify(sEntry));
  } else {
    check("setup announce still reachable in claude pass", cs1.phase === "done", `phase=${cs1.phase}`);
  }
  currentRoots = [folder];

  const { discover: cdiscover } = require("./instances");
  const adoptable = (await cdiscover()).find((i) => i.folder && i.folder.replace(/^\/private/, "") === folder.replace(/^\/private/, ""));
  if (adoptable) {
    const copen = await ccall("tools/call", { name: "open_vibefoundry", arguments: {} });
    const csc = copen.result?.structuredContent || {};
    check("claude open returns a previewConfigName", csc.previewConfigName === `vibefoundry-${adoptable.port}`, String(csc.previewConfigName));
    // The deterministic pane signal: the plugin must have told the backend.
    const ph = await (await fetch(`http://127.0.0.1:${adoptable.port}/api/health`)).json();
    check("backend was marked pane-hosted, in code", ph.pane_mode === true, JSON.stringify({ pane_mode: ph.pane_mode }));
    const lc = path.join(folder, ".claude", "launch.json");
    let entry = null;
    try { entry = JSON.parse(require("fs").readFileSync(lc, "utf8")).configurations.find((x) => x.name === csc.previewConfigName); } catch { /* read below */ }
    check(
      "launch.json config is a bare origin (Claude forbids query strings)",
      !!entry && entry.url === `http://localhost:${adoptable.port}` && !entry.command && !entry.runtimeExecutable,
      JSON.stringify(entry)
    );
  } else {
    console.log("  (no backend running on this folder — claude open/launch.json checks need one; skipped)");
  }
  c.kill();

  console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}\n`);
  child.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nselftest error:", e.message);
  child.kill();
  process.exit(1);
});
