# vibefoundry-app-plugins

Opens the VibeFoundry IDE as a pane inside Codex / ChatGPT.

This is a launcher, not an IDE. Everything you see in the pane belongs to the
[`vibefoundry`](https://pypi.org/project/vibefoundry/) python package, which this
server never modifies and never reaches inside. If a feature seems to be missing
here, it lives in the library.

## What it does

Three things:

1. Finds VibeFoundry instances that are already running
2. Opens a **real terminal window** running `vibefoundry --no-browser <cwd>`
3. Serves the pane, and relays its HTTP calls to that backend

## Where the folder comes from

Two sources, strongest first:

1. **The host's workspace root.** If the client declares a `roots` capability,
   the server asks it `roots/list` and uses the answer. No model involved, so
   there is nothing to be wrong about. `notifications/roots/list_changed`
   invalidates the cache, so a workspace switch cannot be served a stale root.
2. **The `projectRoot` argument**, used only when the host reports no roots.

That order is the whole point. The argument is the model's recollection of which
folder the conversation is in; the root is the host stating it. Only the second
one can be wrong about which project you are in, and it is now the fallback
rather than the default.

Check which tier is in play with the **Logs** button — it prints
`supportsRoots` and the roots themselves.

## One folder in, one folder out

Opening VibeFoundry does the same thing every time. Given a folder:

- **already running on that folder** → attach to it
- **not running on that folder** → open a terminal and launch it there

That is the whole decision. No question to answer, no button to press, no folder
picker: the folder is settled before the pane appears, so the IDE opens in it.

Instances running on *other* folders are irrelevant to that decision — they are
mentioned in the reply and otherwise left alone. Pass `shutdown_existing: true`
to stop them, which only happens when the user asks for it in words.

This is the fix for a real failure: the server used to answer the first call with
a question instead of launching, and — because the host renders the pane off the
tool *definition*, question or not — the pane appeared with no backend of its
own and attached to whichever instance was running. You asked for this folder and
got whatever project you opened last.

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

- **A launch only happens when nothing is serving that folder yet.** Reusing the
  running one is what makes opening the same project twice land in the same
  place; a second backend on the same folder would just be a coin toss over
  which one the pane got.
- **Quitting the app leaves the backend running**, in its terminal. Ask to shut
  it down, or `Ctrl+C` in the window.

## Requirements

- `vibefoundry` **0.3.1 or newer** installed and on the PATH of a login shell
  (`pip install -U vibefoundry`). 0.3.1 is the first version that ships the pane
  bundle and `--pane-path`.

Nothing else. The server ships as compiled binaries in `bin/` with the JS
runtime baked in — the same pattern OpenAI uses for its own local plugins,
because Codex does not lend plugins a Node runtime and students' machines do
not have one. `bin/vf` is a three-line selector: macOS picks its architecture
slice; Windows never runs it, because the extensionless command makes
CreateProcess resolve `vf.exe` beside it. There is deliberately no universal
(lipo) mac binary — fused, it crosses GitHub's 100MB file limit.

To rebuild after changing the server: `./build.sh` (needs [bun](https://bun.sh);
cross-compiles all targets from any machine and runs the selftest against the
selector). The source in `server/` stays the readable truth of what the
binaries do.

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

## The Logs button

Top right of the IDE, in the pane and in the browser both. It shows the two
things that matter side by side — the workspace root the host reported, and the
folder the backend is actually serving — and says so plainly when they disagree.
Below that is a copyable dump: environment, backend health, every decision this
relay made, and any UI errors.

The relay half comes from `vf_request /__plugin/log`, which this server answers
itself instead of forwarding. Asking the backend would only describe the backend
already chosen, which is no help when choosing the wrong one is the bug. In a
browser there is no relay, so that half is simply absent.

It also reports `cwd` and any `CODEX_*`/`MCP_*` environment the server was
spawned with — the raw material for adding a fallback tier if a host ever turns
up that supports neither roots nor a reliable argument.

Nothing is uploaded or written to disk. It is an in-memory ring buffer that
leaves the machine only when someone presses Copy.

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
should call. Always acts, never asks. `projectRoot` is the one input that decides
the outcome, so the tool description is blunt about it: the current workspace,
never a path from an earlier conversation, never the folder some other instance
is on. `shutdown_existing` is opt-in and stops instances on other folders.

**`vf_request({path, method, body})`** — internal plumbing. The pane is a
sandboxed iframe and cannot reach `127.0.0.1`, so its `fetch` is shimmed to route
through this. Not for model use.

It relays to the backend for the folder that was asked for, and to no other. If
there isn't one it refuses, rather than reaching for whatever else is listening —
a wrong backend answers every call perfectly while showing the wrong project,
which is far worse than an error.

## How instances are found

By scanning ports 8765–8799 and identifying VibeFoundry by `/api/health` — never
by process name, so it can only ever report, and later stop, something that
really is one of ours.

There is no registry file. That is deliberate: a registry would only know about
instances *this server* launched, while the scan also finds the ones you started
yourself in a terminal — so opening a folder you already have running in a
terminal attaches to it instead of starting a duplicate.

## Claude Code

Wired up — same repo, same binaries. `.claude-plugin/` makes this repo a
Claude Code marketplace too; the plugin manifest points Claude at the same
`bin/vf` the Codex side runs. The server tells the hosts apart at the
`initialize` handshake, and the ONLY difference is how the pane reaches the
screen: Claude's Preview attaches by config name, so on open the server
registers an attach-only `vibefoundry-<port>` entry in the project's
`.claude/launch.json` (per port, so two conversations cannot clobber each
other's pane; attach-only, so the pane never tries to spawn the backend
itself) and returns `previewConfigName` for the model to hand to
`preview_start`. No widget, no `vf_request` relay, no pane bundle — Claude's
preview reaches localhost directly, and the IDE detects it is framed and
adapts itself.

Install: `/plugin marketplace add vibefoundry/vibefoundry-app-plugins`, then
install `vibefoundry` from it. Setup and launch are word-for-word the same as
Codex. See ARCHITECTURE.md for the whole picture.
