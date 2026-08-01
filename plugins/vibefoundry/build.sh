#!/bin/sh
# Compile the plugin server to the binaries Codex actually runs.
# Requires bun (https://bun.sh). Cross-compiles everything from any machine.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"
bun build --compile --minify --target=bun-darwin-arm64 ./server/index.js --outfile bin/vf-darwin-arm64
bun build --compile --minify --target=bun-darwin-x64  ./server/index.js --outfile bin/vf-darwin-x64
bun build --compile --minify --target=bun-windows-x64 ./server/index.js --outfile bin/vf.exe
# GitHub rejects files over 100MB, which is why there is no universal (lipo)
# mac binary: fused, it crosses the limit. The bin/vf selector picks the slice.
find bin -size +99M | grep . && { echo "ERROR: a binary crossed GitHub's 100MB limit"; exit 1; } || true
VF_SERVER_CMD="$PWD/bin/vf" node server/selftest.js "$HOME" | tail -1
