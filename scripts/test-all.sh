#!/usr/bin/env bash
# Run all test suites, continuing past failures so you see every broken suite.
# Exits non-zero if ANY step failed.
#
# Ordering is optimized: vitest suites run before the build since they don't
# need build output. The build runs just before E2E tests that need dist/.
# Heavy parallelism is left to the GitHub Actions workflow (npm-release.yml).

set -uo pipefail

# Increase Node heap to prevent OOM/segfault when running all suites sequentially.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

failed=()

run() {
  local label="$1"
  shift
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $label"
  echo "  $*"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if "$@"; then
    echo "✓ $label passed"
  else
    echo "✗ $label FAILED (exit $?)"
    failed+=("$label")
  fi
}

# --- Static analysis ---
run "Type check"       pnpm check
run "Lint"             pnpm lint

# --- Vitest suites (no build needed) ---
# Use vitest run test/unit instead of bare vitest run.
# Bare vitest run includes both components (jsdom) and unit (threads) projects
# in the same process, which causes @effect/vitest's dynamic test registration
# to fail with "No test suite found" in ~58 files.
run "Unit tests"               pnpm test:unit
run "Integration tests"        vitest run --config vitest.integration.config.ts
run "Contract tests"           vitest run --config vitest.contract.config.ts

# --- Build (needed by E2E and storybook visual tests below) ---
run "Build"            pnpm build

# --- E2E tests ---
run "E2E replay tests"         pnpm exec playwright test --config test/e2e/playwright-replay.config.ts
run "E2E daemon tests"         pnpm exec playwright test --config test/e2e/playwright-daemon.config.ts
run "E2E multi-instance tests" pnpm exec playwright test --config test/e2e/playwright-multi-instance.config.ts
run "E2E subagent tests"       pnpm exec playwright test --config test/e2e/playwright-subagent.config.ts
run "E2E visual tests"         pnpm exec playwright test --config test/e2e/playwright-visual.config.ts

# --- Storybook ---
run "Storybook build"          pnpm storybook:build
run "Storybook visual tests"   pnpm exec playwright test --config test/visual/playwright.config.ts

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ ${#failed[@]} -eq 0 ]; then
  echo "✓ All steps passed"
  exit 0
else
  echo "✗ ${#failed[@]} step(s) failed:"
  for f in "${failed[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
