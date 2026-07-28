"use strict";
/*
 * Finding and stopping running VibeFoundry instances.
 *
 * Deliberately reads nothing but what the shipped `vibefoundry` package already
 * exposes: an HTTP port and /api/health. No registry file, no cooperation from
 * the library, nothing added to the IDE. The trade is a small port scan instead
 * of a lookup — worth it, because it also finds instances the user launched
 * themselves from a terminal, which a registry written only by this server
 * never would.
 */

const net = require("net");
const { execFile } = require("child_process");

// The library's find_available_port() walks up from 8765, so instances land in a
// narrow band regardless of who launched them.
const PORT_START = 8765;
const PORT_END = 8799;

function portOpen(port, timeoutMs = 120) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

async function health(port, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.status === "ok" ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Every live VibeFoundry backend, identified by /api/health rather than by
 * process name — so we can only ever report, and later stop, something that
 * really is one of ours.
 */
async function discover() {
  const ports = [];
  for (let p = PORT_START; p <= PORT_END; p++) ports.push(p);

  // Probe the whole band at once: a closed port fails instantly, so the scan
  // costs about as long as the slowest single open port.
  const open = (await Promise.all(
    ports.map(async (p) => ((await portOpen(p)) ? p : null))
  )).filter((p) => p !== null);

  const found = await Promise.all(
    open.map(async (port) => {
      const h = await health(port);
      return h ? { port, folder: h.project_folder || null, version: h.version || null } : null;
    })
  );
  return found.filter(Boolean);
}

/** The pid listening on a port. Needed to stop an instance we did not spawn. */
function pidOnPort(port) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("cmd.exe", ["/c", `netstat -ano | findstr LISTENING | findstr :${port}`], (err, out) => {
        if (err || !out) return resolve(null);
        const line = String(out).trim().split(/\r?\n/)[0] || "";
        const pid = Number(line.trim().split(/\s+/).pop());
        resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
      });
      return;
    }
    execFile("/usr/sbin/lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (err, out) => {
      if (err || !out) return resolve(null);
      const pid = Number(String(out).trim().split(/\s+/)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/**
 * Stop an instance by port. SIGTERM only — the library handles it, closes down
 * cleanly and releases the port. Never SIGKILL: that would strand whatever the
 * backend was running.
 */
async function stop(port) {
  const pid = await pidOnPort(port);
  if (!pid) return { port, stopped: false, reason: "could not identify the process holding the port" };

  try {
    if (process.platform === "win32") {
      await new Promise((res) => execFile("taskkill", ["/PID", String(pid), "/T"], () => res()));
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    return { port, pid, stopped: false, reason: "the process refused the signal" };
  }

  // Confirm rather than assume — report only what actually happened.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await portOpen(port))) return { port, pid, stopped: true };
  }
  return { port, pid, stopped: false, reason: "still listening after 6s" };
}

module.exports = { discover, stop, health, portOpen, PORT_START, PORT_END };
