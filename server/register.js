#!/usr/bin/env node
"use strict";
/*
 * Register this server with Codex, by adding one block to ~/.codex/config.toml.
 *
 *     node server/register.js            # add or update
 *     node server/register.js --remove   # take it out again
 *
 * Idempotent: re-running rewrites the existing block rather than appending a
 * second one, so an upgrade that moves this file on disk is a re-run away.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CFG_DIR = path.join(os.homedir(), ".codex");
const CFG = path.join(CFG_DIR, "config.toml");

// Forward slashes are accepted by Node on every OS and need no TOML escaping.
const entry = path.join(__dirname, "index.js").replace(/\\/g, "/");
const block = `[mcp_servers.vibefoundry]\ncommand = "node"\nargs = ["${entry}"]\n`;

// Matches the whole block: the header plus every following line until the next
// [section] or end of file.
const pattern = /(?:\r?\n)?^\[mcp_servers\.vibefoundry\]\r?\n(?:^(?!\[).*\r?\n?)*/m;

function read() {
  try {
    return fs.readFileSync(CFG, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const remove = process.argv.includes("--remove");
  const existing = read();

  if (remove) {
    if (!pattern.test(existing)) {
      console.log("VibeFoundry was not registered; nothing to do.");
      return 0;
    }
    fs.writeFileSync(CFG, existing.replace(pattern, "\n"), "utf8");
    console.log(`Removed VibeFoundry from ${CFG}.`);
    return 0;
  }

  if (!fs.existsSync(path.join(__dirname, "index.js"))) {
    console.error("Error: server/index.js is missing next to this script.");
    return 1;
  }

  fs.mkdirSync(CFG_DIR, { recursive: true });

  if (pattern.test(existing)) {
    fs.writeFileSync(CFG, existing.replace(pattern, "\n" + block), "utf8");
    console.log(`Updated VibeFoundry in ${CFG}.`);
  } else {
    const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(CFG, existing + sep + "\n" + block, "utf8");
    console.log(`Registered VibeFoundry in ${CFG}.`);
  }

  console.log(`  command = node ${entry}`);
  console.log("Restart the Codex / ChatGPT desktop app, then say \"open VibeFoundry\".");
  return 0;
}

process.exit(main());
