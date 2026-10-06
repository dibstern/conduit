#!/bin/sh

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# The portable Gherkin tools are vendored as Go source; their binaries are
# platform-specific and gitignored. Build them on demand (fresh checkout / CI).
if [ ! -x "$ROOT_DIR/build/acceptance/bin/gherkin-parser" ]; then
	sh "$ROOT_DIR/acceptance/tools/build.sh" >/dev/null
fi

PATH="$ROOT_DIR/build/acceptance/bin:$PATH"
# The runners start their own preview on this port, so worktrees running the
# suite at the same time each need a different ACCEPTANCE_PORT.
ACCEPTANCE_PORT="${ACCEPTANCE_PORT:-4173}"
CONDUIT_BASE_URL="http://localhost:$ACCEPTANCE_PORT"
VIEWPORT="${VIEWPORT:-desktop}"

export ACCEPTANCE_PORT CONDUIT_BASE_URL PATH VIEWPORT
