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
const path = require("path");
const { portOpen } = require("./instances");

/**
 * Register `port` with the project's Preview pane. Returns the config name for
 * preview_start, or null if the file could not be written (the caller falls
 * back to telling the user the URL).
 */
async function writeLaunchConfig(projectRoot, port) {
  if (!projectRoot || !port) return null;
  const name = `vibefoundry-${port}`;
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
    const isVf = c && typeof c.name === "string" && /^vibefoundry-\d+$/.test(c.name);
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

module.exports = { writeLaunchConfig };
