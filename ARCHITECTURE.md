# How the pieces connect

This repo delivers the VibeFoundry IDE into chat apps. One paste of this
repo's git URL is the entire distribution: the host app clones it, finds a
plugin inside, and runs the compiled server it ships. Everything else follows
from that server.

## The chain

```
this repo (a plugin marketplace)
  └─ plugins/vibefoundry            the plugin
       └─ bin/vf                    compiled MCP server (runtime baked in)
            ├─ setup_vibefoundry →  installs Miniconda, git, data libs,
            │                       and `pip install -U vibefoundry`
            ├─ open_vibefoundry  →  launches `vibefoundry --no-browser <folder>`
            │                       in a real terminal window
            └─ vf_request        →  relays the pane's HTTP to that backend
                                         │
                              the `vibefoundry` python package (PyPI)
                              — the actual IDE: server, file/dataframe
                                engine, and the pane UI it serves
```

Three artifacts, three jobs, three repos:

| Piece | Repo | Job |
|---|---|---|
| **This plugin** | `vibefoundry-app-plugins` | Get onto machines, install the runtime, launch it, relay to it. A launcher — never the IDE. |
| **The IDE** | `vibefoundry-python-lib` → PyPI `vibefoundry` | Everything the user sees and does. Host-agnostic: works from a plain terminal, a browser, or any pane. |
| **The website** | `vibefoundry-platform-real` | vibefoundry.ai. No install role — the hosted `/mcp` that used to hand out setup commands was deleted once this plugin could install things itself. |

## Why the server is scripts, run by Node

The server is plain JavaScript. `bin/vf` bootstraps a runtime: any Node 18+
already present (host-provided or the user's own), else a one-time download of
the official pinned Node build into `~/.vibefoundry`. The only executable that
ever runs is Node's signed binary; our code stays plaintext a security reviewer
can read — the shape corporate application-control and AV policies are built
to allow. Windows runs the same scripts: `bin/vf.exe` is the official
`node.exe` renamed (signature and hash intact — verify against nodejs.org),
pointed at `server/index.js` by the manifest args. Nothing is compiled by us
on any platform. The compiled era is preserved at the `binary-era` tag.

## The rules the whole system obeys

- **The folder the host names is the project.** `open_vibefoundry` asks the
  host for its workspace root (`roots/list`); the model's argument is only a
  fallback, and with neither the answer is the literal warning "Please Choose
  A Working Directory First" — never a guess, never whatever backend happens
  to be running. Same folder twice attaches to the same instance.
- **Opening a folder never modifies it.** Scaffolding (`input_folder/`,
  `app_folder/`…) happens in exactly one place: the IDE's Build button.
  Setup installs software and creates one empty `Documents/VibeFoundryProjects`
  as a suggested home — nothing else touches disk.
- **Setup is staged and check-first.** Each tool call performs one step and
  reports it into the chat ("Step 2/5 — Git: done ✓ … Now installing: Data
  libraries…"), so progress is visible in any host. Every step skips itself
  once satisfied: re-running is always safe, an interrupted run resumes, and
  `pip install -U vibefoundry` re-arming once per conversation makes
  "run setup again" the update channel.
- **The model relays; the plugin acts.** Install commands, shell-profile
  edits, and diagnosis are never the model's to perform — the instructions
  forbid it, and every failure message contains its own fix.

## Finding instances

By scanning ports 8765–8864 and identifying VibeFoundry by `/api/health` —
never by process name, and never via a registry file, so instances the user
started themselves in a terminal are found too. The backend runs in a real
terminal window the user can read and Ctrl+C; the plugin never owns the
process.

## Hosts

The server speaks MCP over stdio, which is host-neutral; it learns who it is
talking to from `clientInfo` at `initialize` and adapts the view layer only:

- **Codex / ChatGPT desktop** (`.agents/plugins/marketplace.json` +
  `.codex-plugin/plugin.json`): the pane is an Apps-SDK widget served from
  `vibefoundry --pane-path`, and its sandboxed iframe cannot reach localhost —
  hence `vf_request` relaying every call, uploads chunked across the bridge.
- **Claude Code** (`.claude-plugin/`): same binaries, no widget and no relay —
  Claude's preview loads `http://127.0.0.1:<port>/` directly and the IDE
  detects it is framed and adapts itself.

## Testing

`server/selftest.js` drives the server over real stdio JSON-RPC — acting as a
full client, roots and all. `VF_SERVER_CMD=bin/vf` points it at the compiled
artifact, so a pass certifies what ships, not just the source. `--launch` adds
a real end-to-end launch. `build.sh` runs it after every compile.
