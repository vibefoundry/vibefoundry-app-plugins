#!/usr/bin/env node
"use strict";
/*
 * VibeFoundry app plugin — a minimal MCP server that opens the VibeFoundry IDE
 * as a pane inside Codex / ChatGPT.
 *
 * It does three things and nothing else:
 *   1. find running VibeFoundry instances, and stop them if asked
 *   2. open a terminal running `vibefoundry --no-browser <cwd>`
 *   3. serve the pane, and relay its HTTP calls to the backend
 *
 * Everything the IDE *does* belongs to the `vibefoundry` python package, which
 * this server never modifies and never reaches inside. If it feels like this
 * file is missing features, that is the point — they live in the library.
 *
 * Zero dependencies: speaks newline-delimited JSON-RPC 2.0 over stdio by hand,
 * so it runs on a bare Node with no install step.
 */

const fs = require("fs");
const { discover, stop } = require("./instances");
const { launch, paneHtmlPath, isInstalled, sameFolder } = require("./launch");
const { setupCall, getProgressState } = require("./setup");
const { writeLaunchConfig, startProgressServer } = require("./claude");

/** Which host is on the other end. Decided once, at initialize, from the name
 * the client gives for itself — the ONLY place the two hosts differ is how the
 * pane gets on screen, so this is the only switch in the file. */
function isClaude() {
  return !!(CLIENT_INFO && /claude/i.test(String(CLIENT_INFO.name || "")));
}

// --- Apps SDK wiring ----------------------------------------------------------
// If the pane does not render, these are the two values most likely to need
// swapping for a given desktop-app build:
//   WIDGET_MIME: "text/html+skybridge" <-> "text/html;profile=mcp-app"
const WIDGET_URI = "ui://widget/vibefoundry.html";
const WIDGET_MIME = "text/html+skybridge";

// Both known conventions for linking a tool to its widget. Extra keys are
// ignored by hosts that do not know them, so setting both is free.
const TOOL_META = {
  "openai/outputTemplate": WIDGET_URI,
  ui: { resourceUri: WIDGET_URI },
};

const SERVER_INFO = { name: "vibefoundry", version: "0.1.0" };

const INSTRUCTIONS =
  "VibeFoundry opens a local data-science IDE as a pane. Call open_vibefoundry " +
  "whenever the user asks to open, launch, start or show VibeFoundry, the IDE, " +
  "their data workspace or their data pane — immediately, without asking for " +
  "confirmation, passing the ABSOLUTE PATH OF THE CURRENT WORKSPACE as " +
  "projectRoot. Take that path from context and never guess it, never reuse a " +
  "path from an earlier conversation, and never substitute the folder some " +
  "other VibeFoundry instance happens to be running on: the IDE opens exactly " +
  "the folder you pass. Call setup_vibefoundry whenever the user asks to be " +
  "set up to vibe code, to install VibeFoundry, or when open_vibefoundry " +
  "reports vibefoundry is not installed — it performs the whole install " +
  "itself; do NOT run pip, conda or installers yourself, and install nothing " +
  "beyond what it does. It can take a few minutes; that is normal. If setup " +
  "reports a failed step, relay its message to the user verbatim and stop — " +
  "never edit shell profiles, never modify PATH, never diagnose with your own " +
  "commands: re-running setup_vibefoundry is the only remedy you may offer. " +
  "Never call vf_request yourself: it exists only for the pane UI.";

// Appended for Claude Code, where the pane is the Preview attaching by config
// name rather than a widget.
const CLAUDE_INSTRUCTIONS =
  " After open_vibefoundry succeeds it returns previewConfigName — immediately " +
  "call preview_start with that configName to put the IDE pane on screen; that " +
  "is the only step after the tool call. The user works in the pane, so do not " +
  "read or edit the project's files yourself unless they ask you to.";

// The backend the pane is currently pointed at, and the folder last asked for.
// Both are per-process, and a process is per-conversation — so a second
// conversation starts blank even though a backend is very much running.
let BACKEND = null;
let LAST_PROJECT_ROOT = null;

// What the client told us about itself at initialize, and the workspace roots it
// reported. See workspaceRoots() for why these matter.
let CLIENT_INFO = null;
let CLIENT_CAPS = {};
let CLIENT_ROOTS = null;

// --- the event log behind the pane's Logs button ------------------------------
// A ring buffer of what this server actually did — every folder resolution,
// discovery, launch and relay failure. It exists because the interesting
// decisions happen in a background process with no console anyone ever sees: the
// only symptom you get is an IDE showing the wrong project, with nothing to
// point at. `vf_request /__plugin/log` hands this to the pane.
const LOG = [];
const LOG_LIMIT = 300;
const STARTED_AT = Date.now();

function note(event, detail) {
  LOG.push({ at: Date.now() - STARTED_AT, event, ...(detail || {}) });
  if (LOG.length > LOG_LIMIT) LOG.splice(0, LOG.length - LOG_LIMIT);
}

/**
 * Point BACKEND at the instance serving the folder we were asked for.
 *
 * Needed because the pane can be rendered without a launch having happened in
 * THIS process: the widget is attached to the tool definition, so the host
 * renders it on every result — and a new conversation gets a fresh process with
 * no memory of the backend it should be talking to.
 *
 * It only ever adopts an instance whose folder MATCHES the one requested.
 * Adopting "whatever is running" is what made the pane non-deterministic: with
 * a backend still up on an older project, the pane silently attached to that
 * one and the IDE opened its folder instead of the folder you asked for. Better
 * to have no backend and say so than to have the wrong one and look fine.
 */
async function adoptBackend(folder) {
  const want = folder || LAST_PROJECT_ROOT;
  if (!want) return null;
  const running = await discover();
  const pick = running.find((i) => sameFolder(i.folder, want));
  if (!pick) return null;
  BACKEND = `http://127.0.0.1:${pick.port}`;
  return pick;
}

// --- asking the client where we are -------------------------------------------
//
// The folder to open used to come from the model, which meant it came from
// whatever the model believed about the conversation. MCP has a mechanism for
// this that does not involve the model at all: the client declares a `roots`
// capability and answers `roots/list` with the workspace directories. When the
// host supports it, the answer is authoritative and the model's argument is
// downgraded to a hint we only fall back on.
//
// Requests must not be sent before `notifications/initialized`, so the first
// fetch is kicked off there.

const pendingRequests = new Map();
let nextRequestId = 1;

function requestClient(method, params, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = `vf-${nextRequestId++}`; // string ids: cannot collide with the client's
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      note("client_request_timeout", { method });
      resolve(null);
    }, timeoutMs);
    pendingRequests.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg && msg.error ? null : (msg && msg.result) || null);
    });
    send({ jsonrpc: "2.0", id, method, params: params || {} });
  });
}

/** True if the message is a reply to something WE asked, not a request to us. */
function routeClientResponse(msg) {
  if (!msg || msg.method !== undefined || msg.id === undefined) return false;
  const waiter = pendingRequests.get(msg.id);
  if (!waiter) return false;
  pendingRequests.delete(msg.id);
  waiter(msg);
  return true;
}

/** file:///Users/me/proj -> /Users/me/proj. Non-file roots are not folders. */
function rootUriToPath(uri) {
  const s = String(uri || "");
  if (!s.startsWith("file://")) return null;
  try {
    return decodeURIComponent(s.replace(/^file:\/\/(localhost)?/, "")) || null;
  } catch {
    return null;
  }
}

/**
 * The workspace folders the client is willing to tell us about.
 *
 * Cached, and invalidated by notifications/roots/list_changed — the client is
 * required to send that when they move, so a stale cache cannot outlive a
 * workspace switch.
 */
async function workspaceRoots({ refresh = false } = {}) {
  if (!refresh && CLIENT_ROOTS) return CLIENT_ROOTS;
  if (!CLIENT_CAPS || !CLIENT_CAPS.roots) {
    note("roots_unsupported", { clientCapabilities: Object.keys(CLIENT_CAPS || {}) });
    CLIENT_ROOTS = [];
    return CLIENT_ROOTS;
  }
  const res = await requestClient("roots/list");
  const list = (res && Array.isArray(res.roots) ? res.roots : [])
    .map((r) => rootUriToPath(r && r.uri))
    .filter(Boolean)
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  CLIENT_ROOTS = list;
  note("roots_listed", { roots: list });
  return list;
}

/**
 * Decide which folder to open, and say why.
 *
 * Preference order, strongest evidence first:
 *   1. a workspace root reported by the client   — no model involved
 *   2. the projectRoot the model passed          — a hint, and the only tier
 *                                                  that can be wrong about
 *                                                  which project you are in
 * With several roots, the one matching the hint wins; otherwise the first,
 * which is the workspace the client lists first.
 */
async function resolveProjectRoot(hint) {
  const roots = await workspaceRoots();

  if (roots.length) {
    const matched = hint && roots.find((r) => sameFolder(r, hint));
    const chosen = matched || roots[0];
    note("root_resolved", {
      source: "client_roots",
      chosen,
      hint: hint || null,
      hintAgrees: !!matched,
      rootCount: roots.length,
    });
    return { path: chosen, source: "client_roots" };
  }

  if (hint) {
    note("root_resolved", { source: "model_argument", chosen: hint });
    return { path: hint, source: "model_argument" };
  }

  note("root_unresolved", {});
  return { path: null, source: "none" };
}

// --- tool definitions ---------------------------------------------------------
const OPEN_TOOL = {
  name: "open_vibefoundry",
  title: "Open VibeFoundry",
  description:
    "Open the VibeFoundry IDE as a pane. Call this IMMEDIATELY and DIRECTLY " +
    "(do not deliberate, do not ask for confirmation) whenever the user asks to " +
    "open, launch, start, show or bring up: VibeFoundry, the VibeFoundry IDE, " +
    "the data-science IDE, their data workspace, or their data pane. Match " +
    "generously through misspellings and abbreviations — \"open vfoundry\", " +
    "\"open vibe foundry\", \"open VF\" all mean this tool. It opens a real " +
    "terminal window running the IDE in the user's current folder, exactly as if " +
    "they had typed the command themselves, and renders the UI as a pane.",
  inputSchema: {
    type: "object",
    properties: {
      projectRoot: {
        type: "string",
        description:
          "Absolute path of the CURRENT workspace — the folder this conversation " +
          "is working in. Take it from context; never ask the user for it, never " +
          "reuse one from an earlier conversation, and never pass the folder " +
          "another VibeFoundry instance is running on. Used only when the host " +
          "does not report a workspace root of its own; when it does, that root " +
          "wins and this is ignored.",
      },
      shutdown_existing: {
        type: "boolean",
        description:
          "Leave this unset. Only pass true when the user has explicitly asked to " +
          "stop VibeFoundry instances running on other folders; it stops them all " +
          "before launching.",
      },
    },
    required: ["projectRoot"],
  },
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  _meta: TOOL_META,
};

const SETUP_TOOL = {
  name: "setup_vibefoundry",
  title: "Set Up VibeFoundry",
  description:
    "Installs everything VibeFoundry needs, running the whole install itself: " +
    "Python (Miniconda, user-space, no admin), git, the core data libraries " +
    "(matplotlib, plotly, pandas, numpy), the vibefoundry package (always " +
    "upgraded to latest), and the ~/Documents/VibeFoundryProjects home folder. " +
    "Call it when the user asks to be set up to vibe code, to install " +
    "VibeFoundry, or when open_vibefoundry reports it is not installed. It is " +
    "STAGED: each call announces the plan or performs ONE step, and its result " +
    "tells you to relay the message and call again — keep calling until it " +
    "reports done, relaying each message to the user word for word so they see " +
    "live progress. Every step skips itself once satisfied, so it is always " +
    "safe to call and is also how users receive updates. Do not run any " +
    "install commands of your own alongside it.",
  inputSchema: {
    type: "object",
    properties: {
      dryRun: {
        type: "boolean",
        description:
          "Report what would be installed without installing anything. Only " +
          "set this if the user asks what setup would do.",
      },
    },
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
  // The widget doubles as the setup progress card on Codex: the host renders
  // it automatically off every staged result — deterministic, in-app, no model.
  _meta: TOOL_META,
};

const PROXY_TOOL = {
  name: "vf_request",
  title: "VibeFoundry Backend Request",
  description:
    "Internal plumbing for the pane UI: relays one HTTP request to the local " +
    "VibeFoundry backend, which a sandboxed pane cannot reach directly. Not for " +
    "model use — never call it to inspect files or data.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Backend path, e.g. /api/files/tree." },
      method: { type: "string", description: "HTTP method. Defaults to GET." },
      body: { description: "Optional JSON body." },
    },
    required: ["path"],
  },
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
};

// --- open_vibefoundry ---------------------------------------------------------
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function openVibeFoundry(args) {
  const hint = String((args && args.projectRoot) || "").trim() || null;
  const resolved = await resolveProjectRoot(hint);
  const projectRoot = resolved.path;
  if (!projectRoot) {
    throw new Error(
      "Please Choose A Working Directory First. " +
        "No workspace folder is selected — relay this warning to the user verbatim, " +
        "and once they name a folder, call this tool again with it as projectRoot."
    );
  }

  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch {
    throw new Error(`That folder does not exist: ${projectRoot}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${projectRoot}`);

  const version = await isInstalled();
  if (!version) {
    return textResult(
      "VibeFoundry is not installed on this machine. Call setup_vibefoundry to " +
        "install it (it handles everything itself), then try again.",
      { status: "not_installed" }
    );
  }

  LAST_PROJECT_ROOT = projectRoot;
  const running = await discover();
  const wantsShutdown = !!(args && args.shutdown_existing);
  note("discovered", { instances: running.map((i) => ({ port: i.port, folder: i.folder })) });

  // Already serving this exact folder: attach to it and stop here. Opening the
  // same project twice should land you in the same place rather than start a
  // rival backend beside it — which is what makes "open VibeFoundry" idempotent
  // and what stops a second call from drifting onto a different port.
  const existing = running.find((i) => sameFolder(i.folder, projectRoot));
  if (existing && !wantsShutdown) {
    BACKEND = `http://127.0.0.1:${existing.port}`;
    note("adopted", { port: existing.port, folder: existing.folder, rootSource: resolved.source });
    const pane = await paneHandoff(projectRoot, existing.port);
    return {
      content: [{ type: "text", text: `VibeFoundry is open on ${projectRoot}.${pane.text}` }],
      structuredContent: {
        status: "ok",
        backendUrl: BACKEND,
        port: existing.port,
        projectFolder: existing.folder,
        version,
        stopped: [],
        adopted: true,
        ...pane.fields,
      },
      _meta: TOOL_META,
    };
  }

  // Instances on OTHER folders are left alone unless explicitly asked about.
  // This used to return a question instead of launching, which put the pane on
  // screen with nothing behind it — and the pane, having no backend of its own
  // yet, attached to one of those unrelated instances and opened its project.
  let stopped = [];
  if (running.length > 0 && wantsShutdown) {
    stopped = await Promise.all(running.map((i) => stop(i.port)));
    const failed = stopped.filter((s) => !s.stopped);
    if (failed.length) {
      return textResult(
        `Could not stop ${plural(failed.length, "instance")}:\n` +
          failed.map((f) => `  • port ${f.port} — ${f.reason}`).join("\n") +
          `\n\nClose those terminal windows manually, then ask me again.`,
        { status: "shutdown_failed", stopped }
      );
    }
  }

  note("launching", { folder: projectRoot, rootSource: resolved.source });
  const result_ = await launch(projectRoot);
  if (!result_.ok) {
    note("launch_failed", { folder: projectRoot, error: result_.error });
    return textResult(`Could not open VibeFoundry: ${result_.error}`, {
      status: "launch_failed",
      error: result_.error,
      stopped,
    });
  }

  BACKEND = `http://127.0.0.1:${result_.port}`;
  note("launched", { port: result_.port, folder: result_.folder });

  const opened = stopped.filter((s) => s.stopped).length;
  const others = wantsShutdown ? 0 : running.length;
  const suffix = opened
    ? ` Stopped ${plural(opened, "previous instance")} first.`
    : others
      ? ` ${plural(others, "other instance")} still running on ${others === 1 ? "another folder" : "other folders"}` +
        ` — ask me to shut them down if you want them stopped.`
      : "";
  const pane = await paneHandoff(projectRoot, result_.port);
  return {
    content: [{ type: "text", text: `VibeFoundry is open on ${projectRoot}.${suffix}${pane.text}` }],
    structuredContent: {
      status: "ok",
      backendUrl: BACKEND,
      port: result_.port,
      projectFolder: result_.folder,
      version,
      stopped,
      ...pane.fields,
    },
    _meta: TOOL_META,
  };
}

/**
 * How the pane reaches the screen, per host. On Codex the widget attached to
 * this tool's definition does it — nothing to add. On Claude the Preview pane
 * attaches by config name from <project>/.claude/launch.json, so register the
 * backend there and tell the model exactly what to do next. If the file can't
 * be written, fall back to naming the URL — a pane the user opens by hand
 * beats an instruction that silently failed.
 */
async function paneHandoff(projectRoot, port) {
  if (!isClaude()) return { text: "", fields: {} };
  const name = await writeLaunchConfig(projectRoot, port);
  // Tell the BACKEND it is pane-hosted, in code, right now — before the pane
  // can possibly load. The IDE reads this off /api/health at boot and trims
  // its chrome. Deterministic by construction: no URL marker (Claude forbids
  // query strings in config URLs), no navigation instruction for a model to
  // skip, no webview storage. Best-effort on old backends that lack the
  // endpoint — everything still works, the chrome is just untrimmed.
  try {
    await fetch(`http://127.0.0.1:${port}/api/ui/pane`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  } catch { /* backend may predate the endpoint */ }
  note("claude_pane", { config: name, port });
  if (name) {
    return {
      text:
        ` Now open the pane: call preview_start with configName "${name}" so the ` +
        `user sees the IDE. Do not browse the project's files yourself — the pane is the view.`,
      fields: { previewConfigName: name },
    };
  }
  return {
    text:
      ` Could not register the Preview config (is the project folder writable?). ` +
      `Tell the user to open http://127.0.0.1:${port}/ in the preview or a browser.`,
    fields: { previewConfigName: null },
  };
}

function textResult(text, structured) {
  return { content: [{ type: "text", text }], structuredContent: structured || {} };
}

// --- vf_request ---------------------------------------------------------------
// Uploads arrive in pieces. A file sent as one base64 string crosses the host
// bridge as a single enormous JSON value, and a large enough one aborts V8 and
// takes the whole desktop app down with it — which is exactly what happened the
// first time "Add data" worked. Buffering chunks here keeps every message small.
const UPLOADS = new Map();
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function uploadChunk(spec) {
  const id = String(spec.id || "");
  if (!id) throw new Error("upload chunk is missing an id");

  if (spec.abort) {
    UPLOADS.delete(id);
    return { content: [{ type: "text", text: "upload discarded" }], structuredContent: { status: 200 } };
  }

  let entry = UPLOADS.get(id);
  if (!entry) {
    entry = { chunks: [], bytes: 0 };
    UPLOADS.set(id, entry);
  }

  if (spec.base64) {
    const buf = Buffer.from(spec.base64, "base64");
    entry.bytes += buf.length;
    if (entry.bytes > MAX_UPLOAD_BYTES) {
      UPLOADS.delete(id);
      throw new Error(
        `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB. ` +
          "Copy it into the folder directly instead — the pane relays uploads through " +
          "the host bridge, which is not built for files this size."
      );
    }
    entry.chunks.push(buf);
  }

  return {
    content: [{ type: "text", text: `received ${entry.bytes} bytes` }],
    structuredContent: { status: 200, json: { received: entry.bytes } },
  };
}

function takeUpload(id) {
  const entry = UPLOADS.get(id);
  if (!entry) return null;
  UPLOADS.delete(id);
  return Buffer.concat(entry.chunks);
}

/**
 * Everything the pane's Logs button needs from this side of the bridge.
 *
 * Answered here rather than proxied: it is about the relay itself, and asking
 * the backend would only ever describe the backend we already picked — which is
 * useless precisely when picking the wrong one is the bug being chased.
 */
function pluginDiagnostics() {
  return {
    server: SERVER_INFO,
    client: CLIENT_INFO,
    clientCapabilities: Object.keys(CLIENT_CAPS || {}),
    supportsRoots: !!(CLIENT_CAPS && CLIENT_CAPS.roots),
    roots: CLIENT_ROOTS,
    backend: BACKEND,
    lastProjectRoot: LAST_PROJECT_ROOT,
    // The spawn context, recorded because it is the fallback we would use if the
    // host turns out not to support roots — and there is no other way to see it.
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => /^(CODEX|MCP|WORKSPACE|PROJECT|PWD|PATH$|CLAUDE)/i.test(k))
    ),
    node: process.version,
    platform: process.platform,
    uptimeMs: Date.now() - STARTED_AT,
    log: LOG,
  };
}

async function proxy(args) {
  // Upload chunks never reach the backend; they accumulate until the request
  // that references them arrives.
  if (args && args.upload) return uploadChunk(args.upload);

  // Answered by the relay, never forwarded. /__plugin/* is this server's own
  // namespace; the backend has no such routes and never sees these.
  if (args && String(args.path || "").startsWith("/__plugin/setup-state")) {
    return {
      content: [{ type: "text", text: "setup state" }],
      structuredContent: { status: 200, json: getProgressState() },
    };
  }

  if (args && String(args.path || "").startsWith("/__plugin/log")) {
    const diag = pluginDiagnostics();
    return {
      content: [{ type: "text", text: `plugin log — ${LOG.length} events` }],
      structuredContent: { status: 200, json: diag },
    };
  }

  // Self-heal rather than fail: the pane can be alive in a process that never
  // launched anything. See adoptBackend.
  if (!BACKEND) await adoptBackend();
  if (!BACKEND) throw new Error("No VibeFoundry backend is running — call open_vibefoundry first.");

  const path = String((args && args.path) || "");
  if (!path.startsWith("/")) throw new Error("path must start with /");
  const method = String((args && args.method) || "GET").toUpperCase();

  const init = { method, headers: {} };

  if (args && Array.isArray(args.multipart)) {
    // A file upload. The pane cannot post FormData through a JSON-RPC call, so
    // it sends the parts with file content base64'd and we rebuild the real
    // multipart body here — the backend sees an ordinary browser upload.
    const boundary = "----vfBoundary" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const chunks = [];
    for (const part of args.multipart) {
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
      if (part.filename) head += `; filename="${part.filename}"`;
      head += "\r\n";
      if (part.filename) head += `Content-Type: ${part.contentType || "application/octet-stream"}\r\n`;
      head += "\r\n";
      chunks.push(Buffer.from(head, "utf8"));

      let body;
      if (part.uploadId !== undefined) {
        // Assembled from the chunks streamed in ahead of this request.
        body = takeUpload(String(part.uploadId));
        if (body === null) throw new Error("the upload expired before it was sent; try again");
      } else if (part.base64 !== undefined) {
        body = Buffer.from(part.base64, "base64");
      } else {
        body = Buffer.from(String(part.value ?? ""), "utf8");
      }
      chunks.push(body);
      chunks.push(Buffer.from("\r\n", "utf8"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    init.headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    init.body = Buffer.concat(chunks);
  } else if (args && args.body !== undefined && args.body !== null && method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  let res;
  try {
    res = await fetch(BACKEND + path, init);
  } catch (e) {
    // The backend we were pointed at is gone (its terminal was closed). Look for
    // another SERVING THE SAME FOLDER before giving up, so one stale pointer
    // doesn't kill the pane — and so a healthy instance on some other project
    // never quietly becomes the one answering.
    note("relay_failed", { path, method, error: String((e && e.message) || e) });
    const adopted = await adoptBackend();
    if (!adopted) throw new Error("The VibeFoundry backend is no longer running.");
    note("relay_readopted", { port: adopted.port, folder: adopted.folder });
    res = await fetch(BACKEND + path, init);
  }
  if (res.status >= 400) note("relay_http_error", { path, method, status: res.status });
  const ctype = res.headers.get("content-type") || "";

  // Binary (images, PDFs) cannot survive being read as text, and the sandbox
  // will not let the pane load <img src="/api/image"> directly anyway. Send it
  // base64 so the pane can build a data: URL.
  if (!/^(text\/|application\/json|application\/xml)/i.test(ctype) && ctype !== "") {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [{ type: "text", text: `${ctype}, ${buf.length} bytes` }],
      structuredContent: {
        status: res.status,
        contentType: ctype,
        base64: buf.toString("base64"),
      },
    };
  }

  const text = await res.text();

  // Hand back parsed JSON when it is JSON, raw text otherwise. The pane's fetch
  // shim reads `json` first and falls back to `text`.
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return {
    content: [{ type: "text", text: json === undefined ? text.slice(0, 2000) : "ok" }],
    structuredContent: json === undefined ? { status: res.status, text } : { status: res.status, json },
  };
}

// --- JSON-RPC plumbing --------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let cachedPane = null;
async function loadPane() {
  if (cachedPane) return cachedPane;
  const p = await paneHtmlPath();
  if (!p) return null;
  try {
    cachedPane = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  return cachedPane;
}

async function handle(msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "initialize":
      // Remember what the client can do. `capabilities.roots` is the one that
      // decides whether the folder we open is known or merely believed.
      CLIENT_INFO = params.clientInfo || null;
      CLIENT_CAPS = params.capabilities || {};
      note("initialize", {
        client: CLIENT_INFO,
        protocolVersion: params.protocolVersion,
        capabilities: Object.keys(CLIENT_CAPS),
        supportsRoots: !!CLIENT_CAPS.roots,
      });
      return result(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS + (isClaude() ? CLAUDE_INSTRUCTIONS : ""),
      });

    case "notifications/initialized":
      // The first moment the spec allows a server to make requests. Ask now
      // rather than at open time so the answer is already in hand.
      workspaceRoots({ refresh: true }).catch(() => {});
      return; // notification: no response

    case "notifications/roots/list_changed":
      // The workspace moved. Drop the cache so the next open cannot use the old
      // one — this is the whole reason a cache is safe to keep at all.
      note("roots_changed", {});
      CLIENT_ROOTS = null;
      workspaceRoots({ refresh: true }).catch(() => {});
      return;

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, { tools: [OPEN_TOOL, SETUP_TOOL, PROXY_TOOL] });

    case "tools/call": {
      const name = params.name;
      const args = params.arguments || {};
      try {
        if (name === "open_vibefoundry") return result(id, await openVibeFoundry(args));
        if (name === "setup_vibefoundry") {
          // Staged: each call performs ONE step and returns, so the model puts
          // a visible status line in the chat between steps — progress the user
          // actually sees, in any host. Notifications too, when there's a
          // token, for in-flight detail within a step.
          const token = params._meta && params._meta.progressToken;
          let n = 0;
          const progress = (message) => {
            note("setup", { message });
            if (token !== undefined) {
              send({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token, progress: ++n, message },
              });
            }
          };
          const r = await setupCall({ dryRun: !!(args && args.dryRun), progress });
          note("setup_phase", { phase: r.phase, step: r.title || r.step });

          // Claude has no widget, but the plugin can SERVE the progress display
          // itself and register it as a preview — in-app, live, model-free
          // after the one preview_start. Codex needs none of this: the widget
          // on this tool renders the same card automatically.
          let setupPane = null;
          if (isClaude() && r.phase === "announce") {
            const pport = await startProgressServer(getProgressState);
            const roots = await workspaceRoots();
            if (pport && roots.length) {
              setupPane = await writeLaunchConfig(roots[0], pport, "vibefoundry-setup");
            }
            note("claude_setup_pane", { port: pport, config: setupPane });
          }

          // The user-facing text is fenced between ⟦ ⟧ and the contract framed
          // as "your next message must be exactly this" — models obey a
          // required-output far more reliably than a courtesy "relay this"
          // before an action they're eager to take, which is how the first
          // Claude run installed everything in total silence.
          const speak = (msg, last) =>
            `⟦${msg}⟧\n\nYour next message to the user must be EXACTLY the text between ⟦ and ⟧ — ` +
            (last
              ? "then stop."
              : "send it BEFORE anything else, then call setup_vibefoundry again to continue. " +
                "Do not run any commands of your own.");
          const verb = (title) => (title === "Folder access" ? "Setting up" : "Installing");

          let text;
          if (r.phase === "dryrun") {
            text = r.plan
              .map((s) => `  • ${s.title}: ${s.satisfied ? "already set up" : "would install"} — ${s.describe}`)
              .join("\n");
          } else if (r.phase === "announce") {
            // Ends by naming what's ABOUT to run: this message is what sits on
            // screen while the next call installs, so the user always sees
            // "Installing X…" during the work, not just "X: done" after it.
            const pending = r.plan.filter((s) => !s.satisfied);
            const first = pending[0];
            text = speak(
              `I'll set up your computer! This is a ${r.plan.length} step process:\n` +
                r.plan
                  .map((s, i) => `  ${i + 1}. ${s.title} — ${s.describe}${s.satisfied ? " (already done ✓)" : ""}`)
                  .join("\n") +
                `\n${pending.length} step${pending.length === 1 ? "" : "s"} to go.` +
                `\n\n${verb(first.title)} ${first.title} now…` +
                (first.key === "python" ? " (this one takes a couple of minutes)" : "")
            );
            if (setupPane) {
              text += ` Also call preview_start with configName "${setupPane}" so the user can watch the install live.`;
            }
          } else if (r.phase === "step") {
            const next = r.remaining[0];
            text = speak(
              `Step ${r.index}/${r.total} — ${r.title}: done ✓${r.detail ? ` (${r.detail})` : ""}` +
                (next ? `\n\n${verb(next)} ${next} now…` : "")
            );
          } else if (r.phase === "done") {
            text = speak(`✓ All set — ${r.version || "vibefoundry"} is ready. Say "open VibeFoundry" to start.`, true);
          } else {
            text = speak(`Setup stopped at ${r.step}: ${r.detail}\nThe fix is above — after it, say "set me up" again and I'll pick up where we left off.`, true);
          }

          return result(id, {
            content: [{ type: "text", text }],
            structuredContent: r,
            isError: r.phase === "failed",
          });
        }
        if (name === "vf_request") return result(id, await proxy(args));
        return rpcError(id, -32602, "Unknown tool: " + name);
      } catch (e) {
        // Report tool failures as results, not protocol errors, so the model can
        // read the message and tell the user what went wrong.
        return result(id, {
          content: [{ type: "text", text: String((e && e.message) || e) }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return result(id, {
        resources: [
          { uri: WIDGET_URI, name: "VibeFoundry Pane", description: "The VibeFoundry IDE.", mimeType: WIDGET_MIME },
        ],
      });

    case "resources/templates/list":
      return result(id, { resourceTemplates: [] });

    case "resources/read": {
      if (params.uri !== WIDGET_URI) return rpcError(id, -32602, "Unknown resource: " + params.uri);
      // The CSP below has to name a real backend, and this can be read before
      // any launch happened in this process.
      if (!BACKEND) await adoptBackend();
      const html = await loadPane();
      if (!html) {
        return rpcError(id, -32603, "Could not read the pane bundle. Is `vibefoundry` 0.3.1 or newer installed?");
      }
      return result(id, {
        contents: [
          {
            uri: WIDGET_URI,
            mimeType: WIDGET_MIME,
            text: html,
            _meta: {
              "openai/widgetPrefersBorder": false,
              // Computed at read time: BACKEND is only known once a backend is
              // running, so a value captured at load would name the wrong port.
              ui: {
                csp: {
                  connectDomains: BACKEND ? [BACKEND, BACKEND.replace("http://", "ws://")] : [],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      });
    }

    default:
      // Unknown notifications carry no id and must not be answered.
      if (id === undefined) return;
      return rpcError(id, -32601, "Method not found: " + method);
  }
}

// --- stdio loop ---------------------------------------------------------------
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not our framing; ignore rather than crash the session
    }
    // Replies to roots/list arrive here too — an id and no method. They must be
    // routed to their waiter, not fed to handle(), which would answer a reply
    // with "Method not found" and leave the request hanging until it times out.
    if (routeClientResponse(msg)) continue;

    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined) rpcError(msg.id, -32603, String((e && e.message) || e));
    });
  }
});

process.stdin.on("end", () => process.exit(0));

// Note: no cleanup handler. The backend runs in the user's own terminal window
// and outlives this process on purpose — closing the app does not close a
// terminal you opened. Use the shutdown prompt to stop instances.
