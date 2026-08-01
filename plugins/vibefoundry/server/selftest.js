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
  check("exposes exactly open_vibefoundry + vf_request", names.length === 2 && names.includes("open_vibefoundry") && names.includes("vf_request"), names.join(", "));
  const open = (tools.result?.tools || []).find((t) => t.name === "open_vibefoundry");
  check("open_vibefoundry is linked to the widget", open?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");

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

  console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}\n`);
  child.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nselftest error:", e.message);
  child.kill();
  process.exit(1);
});
