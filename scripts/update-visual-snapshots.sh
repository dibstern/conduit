#!/usr/bin/env bash
# Update Storybook visual regression snapshots for both macOS and Linux.
#
# macOS snapshots are generated natively.
# Linux snapshots are generated via the official Playwright Docker image
# (matches what CI uses on ubuntu-latest).
#
# Usage:
#   ./scripts/update-visual-snapshots.sh          # both platforms
#   ./scripts/update-visual-snapshots.sh macos     # macOS only
#   ./scripts/update-visual-snapshots.sh linux     # Linux only (requires Docker)
#   ./scripts/update-visual-snapshots.sh clean      # remove stale snapshots

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SNAP_DIR="$ROOT_DIR/test/visual/components.spec.ts-snapshots"
VISUAL_CONFIG="test/visual/playwright.config.ts"
# Only run the screenshot spec — skip behavior-only specs (tool-item, input-area, etc.)
SCREENSHOT_SPEC="test/visual/components.spec.ts"

# Resolve Playwright version from the project lockfile
PW_VERSION=$(node -e "const p=require('$ROOT_DIR/node_modules/@playwright/test/package.json'); console.log(p.version)")
# Docker images are published per minor version (e.g. v1.58.0, not v1.58.2)
PW_MINOR=$(echo "$PW_VERSION" | sed 's/\.[0-9]*$/.0/')
DOCKER_IMAGE="mcr.microsoft.com/playwright:v${PW_MINOR}-noble"

echo "Playwright version: $PW_VERSION (Docker image: $DOCKER_IMAGE)"

# ─── Helpers ──────────────────────────────────────────────────────────────────

build_storybook() {
  echo ""
  echo "━━━ Building Storybook ━━━"
  pnpm storybook:build
}

update_macos() {
  echo ""
  echo "━━━ Updating macOS (darwin) snapshots ━━━"
  pnpm exec playwright test "$SCREENSHOT_SPEC" \
    --config "$VISUAL_CONFIG" \
    --update-snapshots
  echo "✓ macOS snapshots updated"
}

update_linux() {
  echo ""
  echo "━━━ Updating Linux snapshots via Docker ━━━"

  if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker daemon is not running."
    echo "Start Docker Desktop and try again."
    exit 1
  fi

  # Pull image if not cached
  docker pull --platform linux/amd64 "$DOCKER_IMAGE" 2>/dev/null || true

  docker run --rm \
    -v "$ROOT_DIR":/work \
    -w /work \
    --platform linux/amd64 \
    "$DOCKER_IMAGE" \
    bash -c "npx playwright test $SCREENSHOT_SPEC --config $VISUAL_CONFIG --update-snapshots"

  echo "✓ Linux snapshots updated"
}

clean_stale() {
  echo ""
  echo "━━━ Cleaning stale snapshots ━━━"

  # Build story ID list from current Storybook index
  if [ ! -f "$ROOT_DIR/dist/storybook/index.json" ]; then
    echo "Storybook not built — building now..."
    build_storybook
  fi

  local valid_ids
  valid_ids=$(node -e "
    const data = require('$ROOT_DIR/dist/storybook/index.json');
    const entries = data.entries ?? data.stories ?? {};
    for (const e of Object.values(entries)) {
      if (e.type === 'story') console.log(e.id);
    }
  ")

  local removed=0
  for snap in "$SNAP_DIR"/*.png; do
    local basename
    basename=$(basename "$snap" .png)
    # Strip the trailing -<project>-<platform> suffix to get the story ID
    local story_id
    story_id=$(echo "$basename" | sed -E 's/-(desktop|mobile)-(darwin|linux)$//')
    if ! echo "$valid_ids" | grep -qxF "$story_id"; then
      rm "$snap"
      removed=$((removed + 1))
    fi
  done

  echo "✓ Removed $removed stale snapshot(s)"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

mode="${1:-both}"

case "$mode" in
  macos)
    build_storybook
    update_macos
    ;;
  linux)
    build_storybook
    update_linux
    ;;
  both)
    build_storybook
    update_macos
    update_linux
    ;;
  clean)
    clean_stale
    ;;
  *)
    echo "Usage: $0 [macos|linux|both|clean]"
    exit 1
    ;;
esac

echo ""
echo "━━━ Summary ━━━"
echo "  darwin snapshots: $(ls "$SNAP_DIR"/*-darwin.png 2>/dev/null | wc -l | tr -d ' ')"
echo "  linux  snapshots: $(ls "$SNAP_DIR"/*-linux.png 2>/dev/null | wc -l | tr -d ' ')"
