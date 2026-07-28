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

const child = spawn("node", [path.join(__dirname, "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const waiters = new Map();
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
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

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
  const init = await call("initialize", { protocolVersion: "2025-06-18" });
  check("serverInfo.name is vibefoundry", init.result?.serverInfo?.name === "vibefoundry");
  check("instructions present", typeof init.result?.instructions === "string" && init.result.instructions.length > 50);

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

  console.log("\nbad input is reported, not crashed");
  const bad = await call("tools/call", { name: "open_vibefoundry", arguments: { projectRoot: "/nope/does/not/exist" } });
  check("missing folder returns isError", bad.result?.isError === true, bad.result?.content?.[0]?.text);
  const unknown = await call("tools/call", { name: "no_such_tool", arguments: {} });
  check("unknown tool returns an error", !!unknown.error);

  // A pane can be rendered in a process that never launched anything — a second
  // conversation, or the shutdown-question result. So with an instance running,
  // vf_request must adopt it rather than refuse; with none, it must say so
  // clearly. Which case we're in depends on the machine, so assert accordingly.
  console.log("\nvf_request with no launch in this process");
  const { discover } = require("./instances");
  const alreadyRunning = await discover();
  const early = await call("tools/call", { name: "vf_request", arguments: { path: "/api/health" } });
  if (alreadyRunning.length) {
    check(
      "adopts an already-running backend instead of refusing",
      early.result?.isError !== true && early.result?.structuredContent?.json?.status === "ok",
      `${alreadyRunning.length} running, adopted port ${alreadyRunning.map((i) => i.port).join("/")}`
    );
  } else {
    check("refuses with a clear message", early.result?.isError === true, early.result?.content?.[0]?.text);
  }

  if (doLaunch) {
    console.log(`\nopen_vibefoundry on ${folder}  (opens a terminal window)`);
    const first = await call("tools/call", { name: "open_vibefoundry", arguments: { projectRoot: folder } });
    const sc = first.result?.structuredContent || {};
    console.log(`  -> status=${sc.status}`);
    console.log(`     ${(first.result?.content?.[0]?.text || "").split("\n").join("\n     ")}`);

    let final = first;
    if (sc.status === "confirm_shutdown") {
      check("asks before touching running instances", true, `${sc.instances?.length} running`);
      console.log("\n  answering: shutdown_existing = false (launch anyway)");
      final = await call("tools/call", { name: "open_vibefoundry", arguments: { projectRoot: folder, shutdown_existing: false } });
    }

    const fsc = final.result?.structuredContent || {};
    check("launched", fsc.status === "ok", fsc.status === "ok" ? `port ${fsc.port}` : fsc.error || fsc.status);

    if (fsc.status === "ok") {
      check("pane is linked on the result", final.result?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");
      check("opened the requested folder", String(fsc.projectFolder || "").replace(/^\/private/, "") === folder.replace(/^\/private/, ""), fsc.projectFolder);

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
