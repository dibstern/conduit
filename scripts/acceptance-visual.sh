#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

. "$ROOT_DIR/scripts/acceptance-env.sh"

pnpm build:frontend

rm -rf \
  build/acceptance/ir \
  build/acceptance/dry \
  acceptance/generated \
  acceptance/visual/artifacts

mkdir -p \
  build/acceptance/ir \
  build/acceptance/dry \
  acceptance/generated \
  acceptance/visual/artifacts

# Anything already listening on the preview port would answer the readiness
# probe below, and the suite would test another worktree's build (or hang on a
# non-HTTP listener). curl exits 7 only when nothing accepted the connection.
probe=0
curl --silent --output /dev/null --max-time 2 "$CONDUIT_BASE_URL" || probe=$?
if [ "$probe" -ne 7 ]; then
  echo "Something is already listening at $CONDUIT_BASE_URL; stop it and re-run." >&2
  exit 1
fi

preview_log="$ROOT_DIR/acceptance/visual/artifacts/vite-preview.log"
pnpm exec vite preview --port "$ACCEPTANCE_PORT" --strictPort >"$preview_log" 2>&1 &
preview_pid=$!

stop_preview() {
  kill "$preview_pid" >/dev/null 2>&1 || true
  wait "$preview_pid" >/dev/null 2>&1 || true
}
trap stop_preview EXIT HUP INT TERM

attempt=0
until curl --fail --silent --output /dev/null --max-time 2 "$CONDUIT_BASE_URL"; do
  if ! kill -0 "$preview_pid" >/dev/null 2>&1; then
    tail -c 4000 "$preview_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "Timed out waiting for conduit preview at $CONDUIT_BASE_URL" >&2
    tail -c 4000 "$preview_log" >&2
    exit 1
  fi
  sleep 0.1
done

for feature in composer-send-button composer-approvals-dropdown session-visibility harness-selection agent-harness-filter composer-skill-highlight transcript-skill-highlight provider-instances-settings claude-settings model-drift phone-transcript-scrolling phone-session-bar desktop-session-bar transcript-feed-states composer-effort-meter session-goal composer-set-goal composer-field-width composer-live-status composer-picker session-goal-states session-goal-details composer-controls-words composer-context-warning composer-builtin-commands session-skills-chip session-background-tasks composer-final-design opencode-connection-banner side-threads usage-limit-strip; do
  gherkin-parser \
    "features/$feature.feature" \
    "build/acceptance/ir/$feature.json"

  gherkin-ir-dry-checker \
    "build/acceptance/ir/$feature.json" \
    "build/acceptance/dry/$feature.json"

  pnpm exec tsx \
    acceptance/bin/acceptance-entrypoint-generator.ts \
    "build/acceptance/ir/$feature.json" \
    acceptance/generated

  pnpm exec tsx \
    "acceptance/generated/$feature.acceptance.ts" \
    "build/acceptance/ir/$feature.json"
done

echo "PASS acceptance visual pipeline"
