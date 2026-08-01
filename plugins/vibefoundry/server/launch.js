"use strict";
/*
 * Launching VibeFoundry.
 *
 * The whole design goal: launching from the app must be indistinguishable from
 * launching it yourself. So this opens a REAL terminal window and types the
 * command a user would type:
 *
 *     vibefoundry --no-browser <folder>
 *
 * No --port, no environment tricks, no special mode. The library picks its own
 * port exactly as it always does, prints its own log to a window you can read,
 * and Ctrl+C stops it. This server does not own the process and cannot kill it
 * by handle — which is correct, because a terminal you opened does not die when
 * you close your editor either.
 *
 * --no-browser is the single deliberate difference: the pane is the view, so a
 * browser window would be a second, unwanted one.
 */

const { execFile, spawn } = require("child_process");
const { discover } = require("./instances");

/** Shell-quote for AppleScript's `do script`, which nests inside a "..." string. */
function q(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Run a command through a LOGIN shell so it sees the user's real PATH.
 * Critical: a desktop app inherits a minimal environment, so a conda-installed
 * `vibefoundry` is invisible to it — but is on PATH in any terminal the user
 * opens. Using a login shell is both the authentic path and the working one.
 */
function loginShell(command) {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/c", command] };
  }
  return { file: process.env.SHELL || "/bin/sh", args: ["-lc", command] };
}

/** Ask the installed package where its pane bundle lives. */
function paneHtmlPath() {
  return new Promise((resolve) => {
    const { file, args } = loginShell("vibefoundry --pane-path");
    execFile(file, args, { timeout: 20000 }, (err, out) => {
      const p = String(out || "").trim().split(/\r?\n/).pop();
      resolve(err || !p ? null : p);
    });
  });
}

/** Is `vibefoundry` installed and on the user's PATH at all? */
function isInstalled() {
  return new Promise((resolve) => {
    const { file, args } = loginShell("vibefoundry --version");
    execFile(file, args, { timeout: 20000 }, (err, out) => {
      resolve(err ? null : String(out || "").trim());
    });
  });
}

/** Open a new terminal window running `cmd`, in `cwd`. */
function openTerminal(cwd, cmd) {
  if (process.platform === "darwin") {
    // Build the full shell command FIRST — with cwd double-quoted for the
    // shell — then AppleScript-escape the whole thing once. Escaping the parts
    // separately left `cd` unquoted, so any folder with a space in it died in
    // the fresh terminal with "cd: too many arguments".
    const bash = `cd "${cwd}" && ${cmd}`;
    const script =
      `tell application "Terminal"\n` +
      `  activate\n` +
      `  do script "${q(bash)}"\n` +
      `end tell`;
    spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
    return true;
  }

  if (process.platform === "win32") {
    // `start "" /d "<cwd>"` sets the working directory without a `cd`, which
    // sidesteps nesting quotes inside quotes — same trick the library's own
    // /api/terminal/launch uses. The `""` is start's window title slot; without
    // it, start would eat the quoted path as the title.
    spawn(process.env.ComSpec || "cmd.exe", ["/c", `start "" /d "${cwd}" cmd /k ${cmd}`], {
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    }).unref();
    return true;
  }

  // Linux: try the common emulators in turn; the first that exists wins.
  const candidates = [
    ["gnome-terminal", ["--working-directory", cwd, "--", "bash", "-lc", `${cmd}; exec bash`]],
    ["konsole", ["--workdir", cwd, "-e", "bash", "-lc", `${cmd}; exec bash`]],
    ["xterm", ["-e", `cd ${cwd} && ${cmd}; bash`]],
  ];
  for (const [bin, args] of candidates) {
    try {
      spawn(bin, args, { stdio: "ignore", detached: true }).unref();
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

/**
 * Launch a backend for `folder` and wait for it to appear.
 *
 * Since we do not own the process, "did it work" is answered by discovery, not
 * by a process handle: poll until an instance shows up reporting this folder.
 * `before` is the set of ports already taken, so an instance that was already
 * serving this folder is never mistaken for the one we just launched.
 */
async function launch(folder, timeoutMs = 45000) {
  const before = new Set((await discover()).map((i) => i.port));

  if (!openTerminal(folder, `vibefoundry --no-browser "${folder}"`)) {
    return { ok: false, error: "could not open a terminal window on this platform" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await discover();
    const fresh = now.find((i) => !before.has(i.port) && sameFolder(i.folder, folder));
    if (fresh) return { ok: true, ...fresh };
  }

  // Distinguish "never started" from "started against the wrong folder", so the
  // message tells the user something they can act on.
  const now = await discover();
  const strayNew = now.find((i) => !before.has(i.port));
  if (strayNew) {
    return {
      ok: false,
      error: `a backend started but opened ${strayNew.folder || "an unknown folder"} instead of ${folder}`,
    };
  }
  return {
    ok: false,
    error:
      "no backend appeared within 45s. The terminal window that opened will show why — " +
      "most often `vibefoundry` is not installed in that shell.",
  };
}

/** Compare folders leniently: /tmp and /private/tmp are the same place on macOS. */
function sameFolder(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\/+$/, "").replace(/^\/private\//, "/");
  return norm(a) === norm(b);
}

module.exports = { launch, paneHtmlPath, isInstalled, sameFolder, openTerminal };
