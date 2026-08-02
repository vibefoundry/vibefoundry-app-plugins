#!/bin/sh
# The server ships as SOURCE now — macOS/Linux run it via the bin/vf bootstrap
# (any Node 18+, else a one-time pinned download). Only Windows still needs a
# compiled artifact, because neither host's manifest can name a per-OS command
# and Windows cannot execute the shell entry: bin/vf.exe, built here with bun.
# Everything else about a release is just `git push`.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"
bun build --compile --minify --target=bun-windows-x64 ./server/index.js --outfile bin/vf.exe
find bin -size +99M | grep . && { echo "ERROR: vf.exe crossed GitHub's 100MB limit"; exit 1; } || true
VF_SERVER_CMD="$PWD/bin/vf" node server/selftest.js "$HOME" | tail -1
