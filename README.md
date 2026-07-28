# vibefoundry-app-plugins

Opens the VibeFoundry IDE as a pane inside Codex / ChatGPT.

This is a launcher, not an IDE. Everything you see in the pane belongs to the
[`vibefoundry`](https://pypi.org/project/vibefoundry/) python package, which this
server never modifies and never reaches inside. If a feature seems to be missing
here, it lives in the library.

## What it does

Three things:

1. Finds VibeFoundry instances that are already running, and stops them if you say so
2. Opens a **real terminal window** running `vibefoundry --no-browser <cwd>`
3. Serves the pane, and relays its HTTP calls to that backend

## The one design rule

Launching from the app must be indistinguishable from launching it yourself.

So it opens a terminal and types the command you would have typed. No `--port`,
no environment tricks, no special mode. The library picks its own port exactly as
it always does, prints its log to a window you can read, and `Ctrl+C` stops it.
This server does not own the process and cannot kill it by handle — which is
correct, because a terminal you opened does not close when you quit your editor.

`--no-browser` is the single deliberate difference: the pane is the view, so a
browser window would be a second, unwanted one.

Two consequences worth knowing:

- **Every launch creates a new instance.** It never adopts or reuses a running
  one, even for the same folder — the same as typing the command twice.
- **Quitting the app leaves the backend running**, in its terminal. Use the
  shutdown prompt, or `Ctrl+C` in the window.

## Requirements

- `vibefoundry` **0.3.1 or newer** installed and on the PATH of a login shell
  (`pip install -U vibefoundry`). 0.3.1 is the first version that ships the pane
  bundle and `--pane-path`.
- Node 18+ (for built-in `fetch`). No npm install — zero dependencies.

## Install

This repo **is** a Codex marketplace. Add it as a git source and Codex clones and
wires it up itself — no path on your disk to point at, and updates come from
`git pull`:

```
https://github.com/vibefoundry/vibefoundry-app-plugins.git
```

Restart the desktop app, then say **"open VibeFoundry"**.

### Why it can't be a hosted HTTPS server

MCP tools run where the server runs. This one opens a terminal window on your
machine, scans your loopback for running instances, and proxies to
`127.0.0.1` — a hosted server would do all three against its own box, not
yours. A remote server can serve the pane HTML, but every call the pane makes
routes back through `vf_request`, which would have no route to your backend: the
pane would render and stay empty.

A hosted server *could* launch the IDE by handing Codex a command to run — but
then it opens in a browser window, not a pane. Pane and hosted are mutually
exclusive.

### Local install, for development

```bash
node plugins/vibefoundry/server/register.js            # add to ~/.codex/config.toml
node plugins/vibefoundry/server/register.js --remove   # take it out
```

## Testing without the app

```bash
node plugins/vibefoundry/server/selftest.js <folder>            # protocol only
node plugins/vibefoundry/server/selftest.js <folder> --launch   # end to end
```

It drives the server over real stdio JSON-RPC, so a pass means the protocol
works — not just that the functions do.

## Layout

| File | Role |
|---|---|
| `.agents/plugins/marketplace.json` | makes this repo a marketplace Codex can add by URL |
| `plugins/vibefoundry/.codex-plugin/plugin.json` | the plugin manifest |
| `plugins/vibefoundry/.mcp.json` | declares the local stdio server |
| `plugins/vibefoundry/server/index.js` | the MCP server: JSON-RPC, tools, the pane resource |
| `plugins/vibefoundry/server/launch.js` | opening a terminal and waiting for the backend |
| `plugins/vibefoundry/server/instances.js` | finding and stopping running instances |
| `plugins/vibefoundry/server/register.js` | local install, for development |
| `plugins/vibefoundry/server/selftest.js` | end-to-end harness |

## Tools

**`open_vibefoundry(projectRoot, shutdown_existing?)`** — the only tool the model
should call. On the first call, if instances are already running, it returns a
question rather than acting; answer it and call again with `shutdown_existing`.

**`vf_request({path, method, body})`** — internal plumbing. The pane is a
sandboxed iframe and cannot reach `127.0.0.1`, so its `fetch` is shimmed to route
through this. Not for model use.

## How instances are found

By scanning ports 8765–8799 and identifying VibeFoundry by `/api/health` — never
by process name, so it can only ever report, and later stop, something that
really is one of ours.

There is no registry file. That is deliberate: a registry would only know about
instances *this server* launched, while the scan also finds the ones you started
yourself in a terminal — which is exactly what the shutdown prompt should catch.

## Claude Code

Not wired up yet. The shared core is the same (find instances → open terminal →
wait for health); only the last step differs. Claude Code's preview reaches
localhost directly, so it needs no `vf_request` relay and no pane bundle — it
loads `http://127.0.0.1:PORT/` and the UI detects the iframe and adapts itself.
The extra piece it needs is writing `.claude/launch.json` with a config named
per port, so two conversations cannot clobber each other's pane.
