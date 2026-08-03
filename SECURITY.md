# Security disclosure

This plugin launches and manages a local application. That means it does
things on the user's machine on purpose. This page lists all of them, so a
reviewer or an IT team can approve it from one read.

## What runs

Nothing in this repository is compiled by us, on any platform.

- The server is plain JavaScript in `server/` — readable in full.
- On macOS/Linux, `bin/vf` (a 45-line shell script) runs it with any Node 18+
  on the machine, or a pinned official Node build downloaded once from
  nodejs.org into `~/.vibefoundry`.
- On Windows, `bin/vf.exe` **is the official `node.exe`, renamed** — content
  and Authenticode signature untouched. Verify:
  `shasum -a 256 plugins/vibefoundry/bin/vf.exe` matches the
  `win-x64/node.exe` line of nodejs.org's `SHASUMS256.txt` for the version
  pinned in `build.sh`.

## Network access

- `setup_vibefoundry` downloads from exactly three official sources over
  HTTPS: `repo.anaconda.com` (Miniconda), `pypi.org` /
  `files.pythonhosted.org` (via pip), and `nodejs.org` (the macOS/Linux
  runtime, first launch only, skipped when Node exists).
- At runtime the server talks only to `127.0.0.1` — the local backend it
  launched — plus the loopback port scan described below.
- **No telemetry, no analytics, no phoning home.** The diagnostics log is an
  in-memory ring buffer that leaves the machine only if a user presses Copy.

## What setup installs and writes (all user-space, never sudo/admin)

- Miniconda → `~/miniconda3` (skipped if present)
- git, and the Python data libraries (only whichever are missing)
- `pip install -U vibefoundry` (the IDE itself, from PyPI)
- One empty folder: `~/Documents/VibeFoundryProjects`
- Guarded PATH lines appended to `~/.zprofile`, `~/.zshrc`,
  `~/.bash_profile` (idempotent, marked `# added by vibefoundry setup`)
- Logs → `~/.vibefoundry/logs/`

Setup never scaffolds project folders and never touches files outside the
locations above. Opening a project folder never modifies it.

## Processes

- Launch opens a **visible terminal window** running
  `vibefoundry --no-browser <folder>` — the user sees the process and can
  Ctrl+C it. The plugin never owns or hides the backend.
- Instance discovery scans loopback ports 8765–8864 and identifies
  VibeFoundry **by its `/api/health` response**, never by process name — so
  it can only ever report or stop something that provably is one.
- Stopping an instance (only on explicit user request) sends SIGTERM to the
  PID holding the port, verified afterward. Never SIGKILL.

## macOS folder permission

The backend runs inside Terminal, and macOS gates Terminal's access to
Documents per app. The plugin cannot and does not grant this permission —
launch triggers the standard macOS consent dialog at the moment it is
needed, and a recorded denial is reported with the exact System Settings
path. In managed fleets, a PPPC/MDM profile pre-grants it with zero prompts.

## Claude Code specifics

- Writes an **attach-only** entry (`url` + `port`, no command) into the
  project's `.claude/launch.json` so the Preview pane can attach; entries for
  dead ports are pruned, non-VibeFoundry entries are never touched.
- During setup, serves a live progress page on an ephemeral loopback port —
  static HTML polling install state, same-machine only.

## Scope of the model's role

The model launches tools; it does not install, diagnose, or modify anything
itself — the server's instructions explicitly forbid it from running package
managers or editing shell profiles, and every failure message carries its own
fix so there is nothing for a model to improvise.

## Contact

security@vibefoundry.ai · https://vibefoundry.ai
