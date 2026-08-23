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
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const folder = process.argv[2] || process.cwd();
const doLaunch = process.argv.includes("--launch");

const EXPECTED_TOOLS = [
  "open_vibefoundry",
  "setup_vibefoundry",
  "connect_organization",
  "data_catalog",
  "data_schema",
  "data_query",
  "data_pull",
  "vibefoundry_rules",
  "vf_request",
];

// --- a stand-in backend -------------------------------------------------------
// The data tools relay to /api/org/*, which the python package serves and which
// in turn talks to a real gateway. Neither can be a test dependency, so this
// answers /api/health and the org routes itself, on a folder nothing else is
// serving. It proves the whole path the plugin owns — folder resolution,
// adoption, the version gate, the relay and the shaping of the result — and
// stops exactly where the plugin's responsibility does.
const STUB = {
  version: "0.6.0",
  folder: fs.mkdtempSync(path.join(os.tmpdir(), "vf-stub-")),
  server: null,
  port: null,
  // Set when a query has been answered with reauth_started, so the retry that
  // follows the sign-in gets real rows — one expiry, one recovery.
  reauthPending: false,
  rulesServed: 0,
};

// Stands in for the Track 0 section of AGENTS.md. The marker is what the
// auto-attach checks look for, so it must not appear anywhere else.
const STUB_RULES = "# Track 0 — RULEBOOK-MARKER\n\nScripts go in app_folder/scripts/{script_name}/.";

function stubBody(url, body) {
  const sql = String((body && body.sql) || "");
  switch (true) {
    case url === "/api/health":
      return { status: "ok", version: STUB.version, project_folder: STUB.folder, pane_mode: false };
    case url === "/api/ui/pane":
      return { status: "ok", pane_mode: true };
    case url === "/api/rules":
      STUB.rulesServed++;
      return { source: "project", markdown: STUB_RULES, bytes: STUB_RULES.length };
    // Mirrors the backend: {"organizations": [...], "public": {...}}. The stub
    // used to answer {orgs: [...]}, a key the lib has never sent — which is how
    // connect_organization shipped seeing an empty list and telling users no
    // organization was bundled. A stub kinder than reality hides exactly this.
    case url === "/api/org/list":
      return {
        organizations: [
          { id: "acme", name: "Acme", hub_url: "https://hub.acme.test", connected: false, connection: null },
        ],
        public: { id: "public", name: "Public data", connected: true },
      };
    // Mirrors the backend exactly: {"organizations": [...]}, keyed org_id, with
    // no `connected` flag — presence is connectedness, because an expired
    // credential is pruned before the reply is built. A stub kinder than the
    // real shape is what let orgConnected() ship reading a key that has never
    // existed, so this one is copied from _org_public_view field for field.
    case url === "/api/org/status":
      return {
        organizations: [
          {
            org_id: "acme",
            org_name: "Acme",
            hub_url: "https://hub.acme.test",
            gateway: "https://gw.acme.test",
            email: "p@acme.com",
            expires: "2099-01-01T00:00:00Z",
            seconds_to_expiry: 3600,
            connected_at: "2026-01-01T00:00:00Z",
            tables: 2,
          },
        ],
      };
    case url === "/api/org/connect":
      return { status: "opened" };
    case url === "/api/org/catalog":
      return {
        tables: [
          { source: "org", org_id: "acme", org_name: "Acme", id: "outlet_universe", title: "Outlet Universe", rows: 12345, columns: ["state", "volume", "outlet"] },
          { source: "public", org_id: "public", id: "census_tracts", title: "Census Tracts", rows: 74000, columns: ["geoid", "pop"] },
        ],
      };
    case url.startsWith("/api/org/schema/"):
      return {
        description: "One row per outlet.",
        rows: 12345,
        refreshedAt: "2026-08-21T04:00:00Z",
        columns: [
          { name: "state", dtype: "str", nulls: 0, sample_values: ["GA", "TX"], note: "Two-letter US state." },
          { name: "volume", dtype: "f64", nulls: 3, min: 0, max: 99.5, median: 12 },
        ],
      };
    case url === "/api/org/query" && /EXPIRED/.test(sql):
      return { status: "reauth_required", org_id: "acme" };
    case url === "/api/org/query" && /REAUTH/.test(sql) && !STUB.reauthPending:
      STUB.reauthPending = true;
      return { status: "reauth_started", org_id: "acme", url: "http://127.0.0.1:1/connect" };
    case url === "/api/org/query" && /BADCOL/.test(sql):
      return { __status: 400, detail: "ColumnNotFound: nope" };
    case url === "/api/org/query": {
      const n = /BIG/.test(sql) ? 1200 : 2;
      const rows = [];
      for (let i = 0; i < n; i++) rows.push([`S${i}`, i * 1.5]);
      return { columns: ["state", "vol"], rows, row_count: n, truncated: false, tables_used: ["outlet_universe"], elapsed_ms: 41 };
    }
    case url === "/api/org/pull":
      return { status: "ok", path: path.join(STUB.folder, "input_folder", "cut.parquet"), row_count: 2 };
    default:
      return { __status: 404, detail: "no such stub route" };
  }
}

/** Bind anywhere in the band the plugin scans; null if it is entirely taken. */
function startStub() {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* GETs have none */ }
      const payload = stubBody(req.url.split("?")[0], body);
      const status = payload.__status || 200;
      delete payload.__status;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    let p = 8765;
    const attempt = () => {
      if (p > 8864) return resolve(null);
      srv.once("error", () => { p++; attempt(); });
      srv.listen(p, "127.0.0.1", () => { STUB.server = srv; STUB.port = p; resolve(p); });
    };
    attempt();
  });
}

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
    "exposes exactly the 9 tools",
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
    names.join(", ")
  );
  const open = (tools.result?.tools || []).find((t) => t.name === "open_vibefoundry");
  check("open_vibefoundry is linked to the widget", open?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");
  // connect_organization is the only data tool that puts anything on screen, so
  // it is the only one that may carry the widget — a query result rendering the
  // IDE pane over the answer is a regression, not a feature.
  const connect = (tools.result?.tools || []).find((t) => t.name === "connect_organization");
  check("connect_organization is linked to the widget", connect?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");
  check(
    "the querying tools carry no widget",
    ["data_catalog", "data_schema", "data_query", "data_pull", "vibefoundry_rules"].every(
      (n) => !(tools.result?.tools || []).find((t) => t.name === n)?._meta
    )
  );
  const q = (tools.result?.tools || []).find((t) => t.name === "data_query");
  check("data_query tells the model to profile first and never SELECT *",
    /data_schema/.test(q?.description || "") && /SELECT \*/.test(q?.description || ""));
  // The description is a prompt: a model that thinks it must fetch the rules
  // will call this every turn, which is the cost the auto-attach exists to
  // avoid.
  const rules = (tools.result?.tools || []).find((t) => t.name === "vibefoundry_rules");
  check("vibefoundry_rules says the rules normally arrive on their own",
    /do NOT need to call this/.test(rules?.description || "") && /automatic|on their own/i.test(rules?.description || ""));
  const pullTool = (tools.result?.tools || []).find((t) => t.name === "data_pull");
  check("data_pull can land a cut in a script's raw_pulls/",
    /raw_pulls/.test(pullTool?.inputSchema?.properties?.script_name?.description || ""));

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
  check("setup widget serves from the plugin itself", swHtml.includes("Setting Up Your Computer"), `${(swHtml.length/1024).toFixed(1)} KB`);
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

  // The data tools must exist and must answer on a machine with nothing
  // installed — a tool that only appears once VibeFoundry is present can never
  // be the thing that tells the user to install it. A folder nothing is serving,
  // so discovery cannot short-circuit the install check.
  const bareFolder = fs.mkdtempSync(path.join(os.tmpdir(), "vf-bare-"));
  const btools = await bcall("tools/list", {});
  const bnames = (btools.result?.tools || []).map((t) => t.name);
  check("bare machine still advertises all 9 tools", bnames.length === EXPECTED_TOOLS.length, bnames.join(", "));
  const bcat = await bcall("tools/call", { name: "data_catalog", arguments: { projectRoot: bareFolder } });
  check(
    "data_catalog on a bare machine points at setup rather than failing",
    bcat.result?.structuredContent?.status === "not_installed",
    bcat.result?.content?.[0]?.text
  );
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
  // Guards the bug that shipped three times: a guessed key on an /api/org/*
  // response. /api/org/list answers {"organizations": [...]}; reading `orgs`
  // made connect_organization see an empty list and tell the user there was no
  // organization to sign in to, so SSO never opened.
  const conn = await call("tools/call", { name: "connect_organization", arguments: { projectRoot: STUB.folder } });
  const connText = (conn.result?.content || []).map((c) => c.text || "").join("");
  const connOrgs = conn.result?.structuredContent?.orgs || [];
  // Assert the SHAPE, not the name: the backend this reaches may be the stub or
  // a real one on this machine, and either must yield a non-empty list with ids.
  check(
    "connect_organization surfaces the bundled organization — " + JSON.stringify(connOrgs.map((o) => o.id || o.org_id)),
    connOrgs.length >= 1 && !!(connOrgs[0].id || connOrgs[0].org_id)
  );
  check("connect_organization does not claim there are none", !/no organizations/i.test(connText));

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

  // --- the data tools, against the stand-in backend ---------------------------
  console.log("\ndata tools (stand-in backend, no gateway)");
  const stubPort = await startStub();
  if (!stubPort) {
    console.log("  (ports 8765-8864 are all taken — skipped)");
  } else {
    // Point the fake client at the stub's folder: roots win over the model's
    // argument, so this is how the server is made to adopt the stub and only
    // the stub.
    currentRoots = [STUB.folder];
    notify("notifications/roots/list_changed");
    await new Promise((r) => setTimeout(r, 400));
    const dcall = (name, args) => call("tools/call", { name, arguments: { projectRoot: STUB.folder, ...args } });

    const cat = await dcall("data_catalog", {});
    const ctext = cat.result?.content?.[0]?.text || "";
    // Nothing with a backend has been called in this process yet, so this is
    // the result the rules must ride on.
    check("the first backend-backed tool result carries the project rules",
      ctext.startsWith("# Track 0 — RULEBOOK-MARKER"), ctext.split("\n")[0]);
    check("data_catalog reads as a list, not as JSON", /outlet_universe/.test(ctext) && /12,345 rows/.test(ctext), ctext.split("\n")[1]);
    check("data_catalog groups by org_id so the model can pass it back", /org_id "acme"/.test(ctext) && /org_id "public"/.test(ctext));
    check("data_catalog carries the full list in structuredContent", (cat.result?.structuredContent?.tables || []).length === 2);

    const sch = await dcall("data_schema", { org_id: "acme", table_id: "outlet_universe" });
    const stext = sch.result?.content?.[0]?.text || "";
    // Once per conversation, not once per call: repeating a rulebook on every
    // result costs more context than the answers do.
    check("the rules do not ride along a second time", !/RULEBOOK-MARKER/.test(stext), stext.split("\n")[0]);
    check("data_schema names the real columns and their notes", /\| state \|/.test(stext) && /Two-letter US state/.test(stext));
    check("data_schema surfaces the refresh date to cite", /2026-08-21/.test(stext));

    const qr = await dcall("data_query", { org_id: "acme", sql: "SELECT state, vol FROM outlet_universe LIMIT 2" });
    const qtext = qr.result?.content?.[0]?.text || "";
    const qsc = qr.result?.structuredContent || {};
    // The relay puts the literal "ok" in text and everything in
    // structuredContent; for a model-facing tool that is backwards, and this is
    // the check that keeps it that way round.
    check("data_query answers in the text, not just in structuredContent",
      qtext.startsWith("| state | vol |") && qtext !== "ok", qtext.split("\n")[0]);
    check("data_query cites the table it used", /outlet_universe/.test(qtext));
    check("data_query returns rows as arrays", Array.isArray(qsc.rows?.[0]) && qsc.row_count === 2);

    const big = await dcall("data_query", { org_id: "acme", sql: "SELECT state, vol FROM outlet_universe WHERE tag = 'BIG'" });
    const btext = big.result?.content?.[0]?.text || "";
    const bodyRows = btext.split("\n").filter((l) => l.startsWith("| S")).length;
    check("a big result is capped at 50 rows of text and 500 structured",
      bodyRows === 50 && big.result?.structuredContent?.rows?.length === 500 && /50 of 1,200 rows shown/.test(btext),
      `${bodyRows} text rows, ${big.result?.structuredContent?.rows?.length} structured`);

    const bad = await dcall("data_query", { org_id: "acme", sql: "SELECT BADCOL FROM outlet_universe" });
    check("a rejected query tells the model to fix the SQL",
      bad.result?.isError === true && /data_schema/.test(bad.result?.content?.[0]?.text || ""),
      bad.result?.content?.[0]?.text);

    const gone = await dcall("data_query", { org_id: "acme", sql: "SELECT EXPIRED FROM outlet_universe" });
    check("an expired connection routes to connect_organization",
      gone.result?.structuredContent?.status === "reauth_required" && /connect_organization/.test(gone.result?.content?.[0]?.text || ""),
      gone.result?.content?.[0]?.text);

    // An expired credential the backend is already re-opening the browser for.
    // The plugin waits it out and runs the query again, so the model sees the
    // answer rather than an errand.
    const rauth = await dcall("data_query", { org_id: "acme", sql: "SELECT REAUTH FROM outlet_universe" });
    check("an expired credential re-authenticates and the query is retried once",
      rauth.result?.structuredContent?.status === "ok" && rauth.result?.structuredContent?.row_count === 2,
      rauth.result?.content?.[0]?.text?.split("\n").pop());

    const pull = await dcall("data_pull", { org_id: "acme", table_id: "outlet_universe", sql: "SELECT state FROM outlet_universe" });
    check("data_pull reports where the file landed",
      /cut\.parquet/.test(pull.result?.content?.[0]?.text || "") && !!pull.result?.structuredContent?.path,
      pull.result?.content?.[0]?.text);

    const spull = await dcall("data_pull", { org_id: "acme", table_id: "outlet_universe", script_name: "georgia_top_accounts" });
    check("data_pull passes script_name through and says where it landed",
      spull.result?.structuredContent?.script_name === "georgia_top_accounts" &&
        /raw_pulls\//.test(spull.result?.content?.[0]?.text || ""),
      spull.result?.content?.[0]?.text);

    const rl = await dcall("vibefoundry_rules", {});
    const rtext = rl.result?.content?.[0]?.text || "";
    check("vibefoundry_rules relays the rulebook and says whose it is",
      /RULEBOOK-MARKER/.test(rtext) && rl.result?.structuredContent?.source === "project",
      rtext.split("\n")[0]);
    // Seen from the backend: one fetch for the attach, one for the explicit
    // call. A tool result that quietly re-fetches is the failure this catches.
    check("the rules were fetched once for the attach, once on request",
      STUB.rulesServed === 2, `${STUB.rulesServed} fetch(es)`);

    const conn = await dcall("connect_organization", {});
    check("connect_organization lists the orgs and keeps the widget on the result",
      /org_id "acme"/.test(conn.result?.content?.[0]?.text || "") &&
        conn.result?._meta?.["openai/outputTemplate"] === "ui://widget/vibefoundry.html");
    const conn2 = await dcall("connect_organization", { org_id: "acme" });
    check("connect_organization never asks the chat for a key",
      conn2.result?.structuredContent?.status === "opened" &&
        !/api key|app_?id|secret|\.env/i.test(conn2.result?.content?.[0]?.text || ""),
      conn2.result?.content?.[0]?.text);

    // A backend that predates /api/rules must be told to update rather than be
    // asked a question it will answer with a 404 page. 0.5.0 served /api/org/*
    // but not the rules, so it is the version that proves the gate moved.
    STUB.version = "0.5.0";
    const old = await dcall("data_catalog", {});
    check("a backend older than 0.6.0 is sent to setup_vibefoundry, not queried",
      old.result?.structuredContent?.status === "needs_update" &&
        /setup_vibefoundry/.test(old.result?.content?.[0]?.text || ""),
      old.result?.content?.[0]?.text);
    STUB.version = "0.6.0";

    // Nothing the data tools did may reach the buffer the user can copy.
    const after = await call("tools/call", { name: "vf_request", arguments: { path: "/__plugin/log" } });
    const dump = JSON.stringify(after.result?.structuredContent?.json?.log || []);
    check("no query, result or credential reaches the diagnostics log",
      !/SELECT|outlet_universe|acme|p@acme/i.test(dump), `${(after.result?.structuredContent?.json?.log || []).length} events`);

    STUB.server.close();
    currentRoots = [folder];
    notify("notifications/roots/list_changed");
    await new Promise((r) => setTimeout(r, 400));
  }

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
