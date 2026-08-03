#!/bin/sh
# There is nothing to compile: the server is plain JavaScript everywhere.
# bin/vf.exe is the OFFICIAL node.exe, renamed — Windows resolves the
# extensionless manifest command to it, and the manifest's args point it at
# server/index.js. Renaming changes neither the content nor the Authenticode
# signature, so the only executable we ship is signed by the OpenJS Foundation
# and byte-identical to the nodejs.org release: verify with the hash below.
# This script re-vendors it (rare — only on Node version bumps).
set -e
cd "$(dirname "$0")"
NODE_V="22.14.0"
curl -fsSL "https://nodejs.org/dist/v$NODE_V/win-x64/node.exe" -o bin/vf.exe
GOT=$(shasum -a 256 bin/vf.exe | awk '{print $1}')
WANT=$(curl -fsSL "https://nodejs.org/dist/v$NODE_V/SHASUMS256.txt" | grep " win-x64/node.exe" | awk '{print $1}')
[ "$GOT" = "$WANT" ] || { echo "HASH MISMATCH — do not commit"; exit 1; }
echo "bin/vf.exe = official node v$NODE_V win-x64, sha256 $GOT"
VF_SERVER_CMD="$PWD/bin/vf" node server/selftest.js "$HOME" | tail -1
