"use strict";
/*
 * setup_vibefoundry — install everything the IDE needs, from inside the plugin.
 *
 * This used to live on a hosted server that could only RETURN a script and
 * hope the model ran it faithfully, with a guardrail sermon to keep it from
 * improvising. This runs on the user's machine, so it just does the work:
 * deterministic, narrated, and check-first — every step skips itself when its
 * outcome already exists, which is what makes re-running always safe and what
 * lets a failed run resume instead of starting over.
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
// installers end in "restart your terminal and try again".
const PIP = WIN ? path.join(CONDA_DIR, "Scripts", "pip.exe") : path.join(CONDA_DIR, "bin", "pip");
const CONDA = WIN ? path.join(CONDA_DIR, "Scripts", "conda.exe") : path.join(CONDA_DIR, "bin", "conda");
const PYTHON = WIN ? path.join(CONDA_DIR, "python.exe") : path.join(CONDA_DIR, "bin", "python");

/** Run a command, capturing output; resolves {ok, out} rather than throwing. */
function run(file, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: `${stdout || ""}${stderr || ""}`.trim(),
      });
    });
  });
}

/** Run through a login shell — for probing what the USER's terminals can see. */
function shell(cmd, timeoutMs = 60 * 1000) {
  if (WIN) return run(process.env.ComSpec || "cmd.exe", ["/c", cmd], timeoutMs);
  return run(process.env.SHELL || "/bin/sh", ["-lc", cmd], timeoutMs);
}

/** First of `candidates` that exists and answers `--version`-style args. */
async function firstWorking(candidates, args) {
  for (const c of candidates) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    const res = await run(c, args, 30 * 1000);
    if (res.ok) return { cmd: c, out: res.out };
  }
  return null;
}

/** The pip serving this machine: our conda's if present, else any on PATH. */
async function findPip() {
  const found = await firstWorking([PIP], ["--version"]);
  if (found) return found.cmd;
  const probe = await shell("pip3 --version || pip --version");
  if (probe.ok) return probe.out.startsWith("pip") ? (WIN ? "pip" : "pip3") : null;
  return null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function minicondaUrl() {
  if (WIN) return "https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-${arch}.sh`;
}

/**
 * Make sure the shells the user opens can see conda. `conda init` wires the
 * INTERACTIVE shell (.zshrc); the plugin's own probes use a LOGIN shell
 * (`zsh -lc`), which reads .zprofile instead — so a fresh install can be
 * perfectly healthy yet invisible to `vibefoundry --version`. Guarded one-line
 * additions to both, idempotent by the guard comment.
 */
function wireShell(transcript) {
  if (WIN) return; // the installer's AddToPath registry entry covers Windows
  const line = `\n# added by vibefoundry setup\nexport PATH="$HOME/miniconda3/bin:$PATH"\n`;
  for (const rc of [".zprofile", ".zshrc", ".bash_profile"]) {
    const p = path.join(HOME, rc);
    try {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      if (!cur.includes("added by vibefoundry setup")) {
        fs.appendFileSync(p, line);
        transcript.push(`wired conda into ~/${rc}`);
      }
    } catch {
      /* an unreadable rc file is not worth failing the install over */
    }
  }
}

/**
 * The whole install, as a list of check-first steps. Returns a report rather
 * than throwing: a failed step stops the run and says exactly what and why,
 * because "step 2 failed: <stderr>" is actionable and a stack trace is not.
 */
async function runSetup({ dryRun = false, progress = () => {} } = {}) {
  const steps = [];
  const transcript = [];
  const step = (name, action, detail) => {
    steps.push({ name, action, detail: detail || "" });
    progress(`${name}: ${action}${detail ? ` — ${detail}` : ""}`);
  };

  // -- 1. Python ---------------------------------------------------------------
  progress("checking for Python…");
  let pip = await findPip();
  if (pip) {
    step("python", "skipped", `already present (${pip})`);
  } else if (dryRun) {
    step("python", "would install", "Miniconda → ~/miniconda3");
  } else {
    progress("installing Miniconda (~2 min)…");
    const installer = path.join(os.tmpdir(), WIN ? "vf-miniconda.exe" : "vf-miniconda.sh");
    try {
      await download(minicondaUrl(), installer);
    } catch (e) {
      step("python", "failed", `could not download Miniconda: ${e.message}. ` +
        "If this network blocks repo.anaconda.com, install Python yourself and re-run setup.");
      return { ok: false, steps, transcript };
    }
    const res = WIN
      ? await run(installer, ["/InstallationType=JustMe", "/AddToPath=1", "/S", `/D=${CONDA_DIR}`])
      : await run("/bin/bash", [installer, "-b", "-p", CONDA_DIR]);
    try { fs.unlinkSync(installer); } catch { /* temp file; best effort */ }
    if (!res.ok || !fs.existsSync(PIP)) {
      step("python", "failed", `Miniconda installer did not complete: ${res.out.slice(-400)}`);
      return { ok: false, steps, transcript };
    }
    wireShell(transcript);
    pip = PIP;
    step("python", "installed", CONDA_DIR);
  }

  // -- 2. Git ------------------------------------------------------------------
  const git = await shell("git --version");
  if (git.ok) {
    step("git", "skipped", git.out.split("\n")[0]);
  } else if (dryRun) {
    step("git", "would install", "via conda");
  } else if (fs.existsSync(CONDA)) {
    progress("installing git…");
    const res = await run(CONDA, ["install", "-y", "git"]);
    step("git", res.ok ? "installed" : "failed", res.ok ? "" : res.out.slice(-400));
    if (!res.ok) return { ok: false, steps, transcript };
  } else {
    // Python pre-existed without conda, so there is no conda to install git
    // with. Not fatal: git is only used by the IDE's optional `git init`.
    step("git", "skipped", "no conda to install it with; the IDE works without it");
  }

  // -- 3. Data libraries -------------------------------------------------------
  // Install only what's MISSING, never -U: a student with an existing stack
  // keeps their versions.
  const py = fs.existsSync(PYTHON) ? PYTHON : WIN ? "python" : "python3";
  const missing = [];
  for (const lib of ["matplotlib", "plotly", "pandas", "numpy"]) {
    const probe = await run(py, ["-c", `import ${lib}`], 60 * 1000);
    if (!probe.ok) missing.push(lib);
  }
  if (!missing.length) {
    step("data libraries", "skipped", "matplotlib, plotly, pandas, numpy all present");
  } else if (dryRun) {
    step("data libraries", "would install", missing.join(", "));
  } else {
    progress(`installing ${missing.join(", ")}…`);
    const res = await run(pip, ["install", ...missing]);
    step("data libraries", res.ok ? "installed" : "failed", res.ok ? missing.join(", ") : res.out.slice(-400));
    if (!res.ok) return { ok: false, steps, transcript };
  }

  // -- 4. VibeFoundry ----------------------------------------------------------
  // Always -U: re-running setup is how a student receives fixes.
  if (dryRun) {
    step("vibefoundry", "would install", "pip install -U vibefoundry");
  } else {
    progress("installing/upgrading vibefoundry…");
    const res = await run(pip, ["install", "-U", "vibefoundry"]);
    if (!res.ok) {
      step("vibefoundry", "failed", res.out.slice(-400));
      return { ok: false, steps, transcript };
    }
    step("vibefoundry", "installed", (res.out.match(/vibefoundry-[\d.]+/) || ["latest"])[0]);
  }

  // -- 5. Projects home --------------------------------------------------------
  // One empty folder as the suggested place to make projects. Created, never
  // filled: scaffolding belongs to the Build button and nothing else.
  const projects = path.join(HOME, "Documents", "VibeFoundryProjects");
  if (fs.existsSync(projects)) {
    step("projects home", "skipped", projects);
  } else if (dryRun) {
    step("projects home", "would create", projects);
  } else {
    fs.mkdirSync(projects, { recursive: true });
    step("projects home", "created", projects);
  }

  // -- 6. Verify ---------------------------------------------------------------
  // The same probes the launcher uses, so setup passing means launch will work.
  if (!dryRun) {
    const direct = await firstWorking(
      [WIN ? path.join(CONDA_DIR, "Scripts", "vibefoundry.exe") : path.join(CONDA_DIR, "bin", "vibefoundry")],
      ["--version"]
    );
    const viaShell = await shell("vibefoundry --version");
    const version = (direct && direct.out) || (viaShell.ok && viaShell.out) || null;
    if (!version) {
      step("verify", "failed", "vibefoundry installed but not runnable — open a new terminal and run `vibefoundry --version`, then re-run setup");
      return { ok: false, steps, transcript };
    }
    step("verify", "ok", version.split("\n").pop());
  }

  return { ok: true, steps, transcript };
}

module.exports = { runSetup };
