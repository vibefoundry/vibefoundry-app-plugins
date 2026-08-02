"use strict";
/*
 * setup_vibefoundry — install everything the IDE needs, from inside the plugin.
 *
 * This used to live on a hosted server that could only RETURN a script and
 * hope the model ran it faithfully. This runs on the user's machine, so it
 * just does the work: deterministic, narrated, and check-first — every step
 * skips itself when its outcome already exists, which is what makes re-running
 * always safe and what lets an interrupted run resume where it stopped.
 *
 * The install is STAGED: each tools/call performs ONE unsatisfied step and
 * returns, so the model can put a visible status line in the chat between
 * steps ("Step 2/5 — git: installed") and then call again. Progress inside a
 * chat message beats progress notifications, which hosts are free to ignore.
 * The first call installs nothing — it announces the plan, so the user sees
 * what is about to happen before minutes of downloading start.
 *
 * Two rules the whole file obeys:
 *   - user-space only, never sudo: Miniconda goes to ~/miniconda3, and nothing
 *     touches the system.
 *   - installing is the only side effect: no project folders, no scaffolding.
 *     VibeFoundryProjects (one empty dir) is the single exception — a home for
 *     projects, created empty, never filled here.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const HOME = os.homedir();
const WIN = process.platform === "win32";
const CONDA_DIR = path.join(HOME, "miniconda3");

// Explicit paths into the conda we install, used instead of PATH: a shell
// started before the install finished has stale PATH, and chasing that is how
// installers end in "restart your terminal and try again". ALWAYS Miniconda,
// never an adopted system Python — the first fresh-Mac test proved why: "any
// pip on PATH" grabbed Apple's system Python 3.9, whose --user installs land
// in ~/Library/Python/3.9/bin, on nobody's PATH. One known environment on
// every machine is the whole point of a managed setup.
const PIP = WIN ? path.join(CONDA_DIR, "Scripts", "pip.exe") : path.join(CONDA_DIR, "bin", "pip");
const CONDA = WIN ? path.join(CONDA_DIR, "Scripts", "conda.exe") : path.join(CONDA_DIR, "bin", "conda");
const PYTHON = WIN ? path.join(CONDA_DIR, "python.exe") : path.join(CONDA_DIR, "bin", "python");
const VF = WIN ? path.join(CONDA_DIR, "Scripts", "vibefoundry.exe") : path.join(CONDA_DIR, "bin", "vibefoundry");

const DATA_LIBS = ["matplotlib", "plotly", "pandas", "numpy"];
const PROJECTS_DIR = path.join(HOME, "Documents", "VibeFoundryProjects");

// Per-conversation memory (the server process is per-conversation). `announced`
// makes the first call a plan, not an install; `vfUpgraded` makes the
// vibefoundry step "unsatisfied" exactly once per conversation, so every fresh
// setup run delivers the latest release — re-running setup IS the update
// channel — without looping forever.
const state = { announced: false, vfUpgraded: false };

// Live progress snapshot for the IN-APP displays: the Codex widget and the
// Claude progress page both read this — one via /__plugin/setup-state through
// the vf_request bridge, one via the plugin's own progress page server. Updated
// by the same code that performs the steps, so what the user sees is what is
// happening, with no model or terminal window anywhere in the chain.
const progressState = { phase: "idle", plan: [], current: null, message: "", version: null, error: null };
function getProgressState() { return progressState; }

/** Run a command, capturing output; resolves {ok, out} rather than throwing. */
function run(file, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}`.trim() });
    });
  });
}

/** Run through a login shell — for probing what the USER's terminals can see. */
function shell(cmd, timeoutMs = 60 * 1000) {
  if (WIN) return run(process.env.ComSpec || "cmd.exe", ["/c", cmd], timeoutMs);
  return run(process.env.SHELL || "/bin/sh", ["-lc", cmd], timeoutMs);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function minicondaUrl() {
  if (WIN) return "https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-${arch}.sh`;
}

/**
 * Make sure the shells the user opens can see conda. `conda init` wires the
 * INTERACTIVE shell (.zshrc); the launcher's probes use a LOGIN shell
 * (`zsh -lc`), which reads .zprofile instead — so a fresh install can be
 * perfectly healthy yet invisible to `vibefoundry --version`. Guarded one-line
 * additions, idempotent by the guard comment. Runs on every completed setup,
 * not only fresh installs: the wiring can be missing even when conda isn't.
 */
function wireShell() {
  if (WIN) return; // the installer's AddToPath registry entry covers Windows
  const line = `\n# added by vibefoundry setup\nexport PATH="$HOME/miniconda3/bin:$PATH"\n`;
  for (const rc of [".zprofile", ".zshrc", ".bash_profile"]) {
    const p = path.join(HOME, rc);
    try {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      if (!cur.includes("added by vibefoundry setup")) fs.appendFileSync(p, line);
    } catch {
      /* an unreadable rc file is not worth failing the install over */
    }
  }
}

// --- the five steps -------------------------------------------------------------
// Each: a fast `check` (is the outcome already there?) and an `install` that
// returns {ok, detail}. The staged runner performs the FIRST unsatisfied one.

async function missingLibs() {
  if (!fs.existsSync(PYTHON)) return DATA_LIBS.slice();
  const missing = [];
  for (const lib of DATA_LIBS) {
    const probe = await run(PYTHON, ["-c", `import ${lib}`], 60 * 1000);
    if (!probe.ok) missing.push(lib);
  }
  return missing;
}

const STEPS = [
  {
    key: "python",
    title: "Python (Miniconda)",
    check: async () => fs.existsSync(PIP),
    describe: "installs a private Python at ~/miniconda3 — no admin password, nothing system-wide",
    install: async (progress) => {
      progress("downloading Miniconda…");
      const installer = path.join(os.tmpdir(), WIN ? "vf-miniconda.exe" : "vf-miniconda.sh");
      try {
        await download(minicondaUrl(), installer);
      } catch (e) {
        return {
          ok: false,
          detail: `could not download Miniconda: ${e.message}. If this network blocks repo.anaconda.com, install Miniconda yourself and run setup again.`,
        };
      }
      progress("running the Miniconda installer (~2 min)…");
      const res = WIN
        ? await run(installer, ["/InstallationType=JustMe", "/AddToPath=1", "/S", `/D=${CONDA_DIR}`])
        : await run("/bin/bash", [installer, "-b", "-p", CONDA_DIR]);
      try { fs.unlinkSync(installer); } catch { /* temp file; best effort */ }
      if (!res.ok || !fs.existsSync(PIP)) {
        return { ok: false, detail: `Miniconda installer did not complete: ${res.out.slice(-400)}` };
      }
      wireShell();
      return { ok: true, detail: CONDA_DIR };
    },
  },
  {
    key: "git",
    title: "Git",
    check: async () => (await shell("git --version")).ok,
    describe: "version control, used when projects are built",
    install: async (progress) => {
      progress("installing git…");
      const res = await run(CONDA, ["install", "-y", "git"]);
      return res.ok ? { ok: true, detail: "" } : { ok: false, detail: res.out.slice(-400) };
    },
  },
  {
    key: "libs",
    title: "Data libraries",
    check: async () => (await missingLibs()).length === 0,
    describe: "matplotlib, plotly, pandas, numpy — only whichever are missing",
    install: async (progress) => {
      const missing = await missingLibs();
      progress(`installing ${missing.join(", ")}…`);
      const res = await run(PIP, ["install", ...missing]);
      return res.ok ? { ok: true, detail: missing.join(", ") } : { ok: false, detail: res.out.slice(-400) };
    },
  },
  {
    key: "vibefoundry",
    title: "VibeFoundry",
    check: async () => state.vfUpgraded,
    describe: "the IDE itself, always updated to the latest release",
    install: async (progress) => {
      progress("installing/updating vibefoundry…");
      const res = await run(PIP, ["install", "-U", "vibefoundry"]);
      if (!res.ok) return { ok: false, detail: res.out.slice(-400) };
      state.vfUpgraded = true;
      return { ok: true, detail: (res.out.match(/vibefoundry-[\d.]+/) || ["latest"])[0] };
    },
  },
  {
    key: "home",
    title: "Projects home",
    check: async () => fs.existsSync(PROJECTS_DIR),
    describe: "an empty Documents/VibeFoundryProjects folder to keep projects in",
    install: async () => {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      return { ok: true, detail: PROJECTS_DIR };
    },
  },
];

async function audit() {
  const out = [];
  for (const s of STEPS) out.push({ key: s.key, title: s.title, describe: s.describe, satisfied: await s.check() });
  return out;
}

/**
 * Everything installed — prove it with the same probes the launcher uses, so
 * setup finishing means launch will work.
 *
 * Patient by design: the FIRST execution of a freshly installed Python on
 * macOS can take tens of seconds while Gatekeeper/XProtect scan it — which
 * once made this declare a perfectly good install "not runnable" at a 30s
 * timeout, self-healing on the warm re-run. So: generous timeouts, one retry,
 * and when it still fails, the actual error comes back with it — a diagnostic
 * that hides its evidence turns every failure into telepathy.
 */
async function verify() {
  wireShell();
  const attempt = async (timeoutMs) => {
    const direct = fs.existsSync(VF) ? await run(VF, ["--version"], timeoutMs) : { ok: false, out: "no file at " + VF };
    if (direct.ok && direct.out) return { ok: true, version: direct.out.split("\n").pop() };
    const viaShell = await shell("vibefoundry --version", timeoutMs);
    if (viaShell.ok && viaShell.out) return { ok: true, version: viaShell.out.split("\n").pop() };
    return { ok: false, evidence: (direct.out || viaShell.out || "no output").slice(-300) };
  };
  const first = await attempt(90 * 1000);
  if (first.ok) return first;
  // Cold start may have eaten the whole first window; one warm retry.
  const second = await attempt(90 * 1000);
  return second.ok ? second : { ok: false, evidence: second.evidence };
}

/**
 * One tools/call. Returns a phase the caller turns into chat text:
 *   announce — first call: the plan, nothing installed yet
 *   step     — one step just ran (ok or not); more remain
 *   done     — everything satisfied and verified
 *   failed   — a step or the final verify failed; message says what and why
 */
async function setupCall({ dryRun = false, progress = () => {} } = {}) {
  if (dryRun) {
    const plan = await audit();
    return { phase: "dryrun", plan };
  }

  const p = (msg) => { progressState.message = msg; progress(msg); };

  if (!state.announced) {
    state.announced = true;
    const plan = await audit();
    if (plan.every((s) => s.satisfied)) {
      const v = await verify();
      if (v.ok) { progressState.phase = "done"; progressState.version = v.version; }
      return v.ok
        ? { phase: "done", version: v.version, installed: [] }
        : { phase: "failed", step: "verify", detail: `everything is installed but \`vibefoundry --version\` did not answer (${v.evidence}) — run setup again; the first run of a fresh Python can be slow while macOS scans it` };
    }
    progressState.phase = "announce";
    progressState.plan = plan.map((x) => ({ title: x.title, satisfied: x.satisfied }));
    progressState.current = null;
    progressState.message = "";
    return { phase: "announce", plan };
  }

  const plan = await audit();
  progressState.plan = plan.map((x) => ({ title: x.title, satisfied: x.satisfied }));
  const next = STEPS.find((s, i) => !plan[i].satisfied);
  if (next) {
    const index = STEPS.indexOf(next) + 1;
    progressState.phase = "step";
    progressState.current = { index, total: STEPS.length, title: next.title };
    const res = await next.install(p);
    if (!res.ok) {
      progressState.phase = "failed";
      progressState.error = `${next.title}: ${res.detail}`;
      return { phase: "failed", step: next.title, detail: res.detail };
    }
    const after = await audit();
    progressState.plan = after.map((x) => ({ title: x.title, satisfied: x.satisfied }));
    progressState.message = "";
    return {
      phase: "step",
      index,
      total: STEPS.length,
      title: next.title,
      detail: res.detail,
      remaining: STEPS.filter((s, i) => !after[i].satisfied).map((s) => s.title),
    };
  }

  progressState.current = null;
  progressState.message = "verifying…";
  const v = await verify();
  if (v.ok) {
    progressState.phase = "done";
    progressState.version = v.version;
    progressState.message = "";
    return { phase: "done", version: v.version };
  }
  progressState.phase = "failed";
  progressState.error = `verify: ${v.evidence}`;
  return { phase: "failed", step: "verify", detail: `install finished but \`vibefoundry --version\` did not answer (${v.evidence}) — run setup again; the first run of a fresh Python can be slow while macOS scans it` };
}

module.exports = { setupCall, getProgressState };
