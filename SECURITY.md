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
  launched — plus the loopback port scan described below. This includes the
  data tools: they relay to `127.0.0.1:<port>/api/org/*` and nowhere else.
- **No telemetry, no analytics, no phoning home.** The diagnostics log is an
  in-memory ring buffer that leaves the machine only if a user presses Copy.

## Organization data access

Five tools — `connect_organization`, `data_catalog`, `data_schema`,
`data_query`, `data_pull` — let the model answer questions about the user's
own data. **The plugin holds no credential and contacts no gateway.** Each
one resolves the workspace folder, makes sure a VibeFoundry backend is
serving it, then makes a single HTTP call to
`http://127.0.0.1:<port>/api/org/*`. That is their entire network footprint.

- Connecting is a browser sign-in against the **organization's own** hub,
  opened and completed on a loopback callback by the `vibefoundry` python
  package. No identity, token or row passes through vibefoundry.ai.
- The credential that sign-in produces is written by that package to
  `~/.vibefoundry/orgs.json`, mode `0600`. The plugin never reads the file,
  and the credential appears in no tool result, no health response, no error
  message and no log line.
- `data_query` sends one read-only SQL SELECT and receives rows; the
  organization's gateway executes it against only the tables that credential
  was granted.
- `data_pull` is the only one of the five that writes anything: one file
  into the open project's `input_folder/`, on request.
- None of what these tools send or receive enters the diagnostics ring
  buffer — no SQL, no rows, no org identity. It still holds only folder
  paths, ports and outcomes.

## What is written to disk (all user-space, never sudo/admin)

Setup accounts for all but the last two lines; the list is exhaustive.

- Miniconda → `~/miniconda3` (skipped if present)
- git, and the Python data libraries (only whichever are missing)
- `pip install -U vibefoundry` (the IDE itself, from PyPI)
- One empty folder: `~/Documents/VibeFoundryProjects`
- Guarded PATH lines appended to `~/.zprofile`, `~/.zshrc`,
  `~/.bash_profile` (idempotent, marked `# added by vibefoundry setup`)
- Logs → `~/.vibefoundry/logs/`
- Organization credentials → `~/.vibefoundry/orgs.json`, mode `0600` —
  written by the `vibefoundry` python package when the user connects an
  organization, never by this plugin. See *Organization data access* above.
- One file in the open project's `input_folder/`, and only when the user
  asks for it through `data_pull`.

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
fix so there is nothing for a model to improvise. Data access is the same
shape: the model calls `connect_organization` and reads results, and the
tool descriptions forbid it from asking the user for an API key, an app id or
a `.env` file, because there is never one for it to hold.

## Contact

angelo@vibefoundry.ai · https://vibefoundry.ai
