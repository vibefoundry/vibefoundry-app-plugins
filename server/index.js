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
const { launch, paneHtmlPath, isInstalled } = require("./launch");

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
  "confirmation, passing the current working directory as projectRoot. If the " +
  "result asks whether to shut down running instances, relay that question to " +
  "the user verbatim and call the tool again with shutdown_existing set to their " +
  "answer. Never call vf_request yourself: it exists only for the pane UI.";

// The backend the pane is currently pointed at. Set when we launch or adopt one.
let BACKEND = null;

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
          "Absolute path to the current working directory. Take this from " +
          "context; never ask the user for it.",
      },
      shutdown_existing: {
        type: "boolean",
        description:
          "Only set this after the user has answered the shutdown question this " +
          "tool asked. true stops the running instances first; false leaves them " +
          "alone and launches anyway.",
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

function describe(list) {
  return list.map((i) => `  • port ${i.port} — ${i.folder || "no folder"}`).join("\n");
}

async function openVibeFoundry(args) {
  const projectRoot = String((args && args.projectRoot) || "").trim();
  if (!projectRoot) throw new Error("projectRoot is required — pass the current working directory.");

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
      "VibeFoundry is not installed, or is not on the PATH of a login shell. " +
        "Install it with `pip install vibefoundry`, then try again.",
      { status: "not_installed" }
    );
  }

  const running = await discover();
  const decided = args && Object.prototype.hasOwnProperty.call(args, "shutdown_existing");

  // First call with instances already up: ask, do not act. The user gets to
  // decide whether their running work is disposable.
  if (running.length > 0 && !decided) {
    return textResult(
      `It looks like you've got ${plural(running.length, "VibeFoundry assistant")} running:\n` +
        describe(running) +
        `\n\nWant me to shut them down before launching this one?`,
      { status: "confirm_shutdown", instances: running }
    );
  }

  let stopped = [];
  if (running.length > 0 && args.shutdown_existing) {
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

  const result_ = await launch(projectRoot);
  if (!result_.ok) {
    return textResult(`Could not open VibeFoundry: ${result_.error}`, {
      status: "launch_failed",
      error: result_.error,
      stopped,
    });
  }

  BACKEND = `http://127.0.0.1:${result_.port}`;

  const opened = stopped.filter((s) => s.stopped).length;
  const note = opened ? ` Stopped ${plural(opened, "previous instance")} first.` : "";
  return {
    content: [{ type: "text", text: `VibeFoundry is open on ${projectRoot}.${note}` }],
    structuredContent: {
      status: "ok",
      backendUrl: BACKEND,
      port: result_.port,
      projectFolder: result_.folder,
      version,
      stopped,
    },
    _meta: TOOL_META,
  };
}

function textResult(text, structured) {
  return { content: [{ type: "text", text }], structuredContent: structured || {} };
}

// --- vf_request ---------------------------------------------------------------
async function proxy(args) {
  if (!BACKEND) throw new Error("No VibeFoundry backend is running — call open_vibefoundry first.");

  const path = String((args && args.path) || "");
  if (!path.startsWith("/")) throw new Error("path must start with /");
  const method = String((args && args.method) || "GET").toUpperCase();

  const init = { method, headers: {} };
  if (args && args.body !== undefined && args.body !== null && method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  const res = await fetch(BACKEND + path, init);
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
      return result(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "notifications/initialized":
      return; // notification: no response

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, { tools: [OPEN_TOOL, PROXY_TOOL] });

    case "tools/call": {
      const name = params.name;
      const args = params.arguments || {};
      try {
        if (name === "open_vibefoundry") return result(id, await openVibeFoundry(args));
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
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined) rpcError(msg.id, -32603, String((e && e.message) || e));
    });
  }
});

process.stdin.on("end", () => process.exit(0));

// Note: no cleanup handler. The backend runs in the user's own terminal window
// and outlives this process on purpose — closing the app does not close a
// terminal you opened. Use the shutdown prompt to stop instances.
