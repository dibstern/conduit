#!/bin/sh

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# The portable Gherkin tools are vendored as Go source; their binaries are
# platform-specific and gitignored. Build them on demand (fresh checkout / CI).
if [ ! -x "$ROOT_DIR/build/acceptance/bin/gherkin-parser" ]; then
	sh "$ROOT_DIR/acceptance/tools/build.sh" >/dev/null
fi

PATH="$ROOT_DIR/build/acceptance/bin:$PATH"
CONDUIT_BASE_URL="${CONDUIT_BASE_URL:-http://localhost:4173}"
VIEWPORT="${VIEWPORT:-desktop}"

export CONDUIT_BASE_URL PATH VIEWPORT
