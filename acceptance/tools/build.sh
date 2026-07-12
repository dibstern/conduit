#!/bin/sh
# Build the vendored portable APS Gherkin tools into build/acceptance/bin/.
#
# The tool SOURCE is committed under acceptance/tools/go (zero-network, no
# upstream clone). The binaries are platform-specific and gitignored; this
# script rebuilds them for the current machine/CI. See acceptance/tools/UPSTREAM
# for the pinned upstream commit.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SRC_DIR="$ROOT_DIR/acceptance/tools/go"
BIN_DIR="$ROOT_DIR/build/acceptance/bin"

mkdir -p "$BIN_DIR"
cd "$SRC_DIR"
for cmd in gherkin-parser gherkin-ir-dry-checker gherkin-mutator; do
  go build -o "$BIN_DIR/$cmd" "./cmd/$cmd"
done

echo "$BIN_DIR"
