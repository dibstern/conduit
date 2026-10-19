#!/usr/bin/env bash
# Run all test suites, continuing past failures so you see every broken suite.
# Exits non-zero if ANY step failed.
#
# Ordering is optimized: vitest suites run before the build since they don't
# need build output. The build runs just before E2E tests that need dist/.
# Suites run in order here; integration files run in parallel within their suite.
# GitHub Actions (npm-release.yml) also runs suites in parallel jobs.

set -uo pipefail

# Increase Node heap to prevent OOM/segfault when running all suites sequentially.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

failed=()
stage_results=()

run() {
  local label="$1"
  shift
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $label"
  echo "  $*"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local started=$SECONDS
  local result
  if "$@"; then
    result="✓ $label passed"
  else
    local rc=$?
    result="✗ $label FAILED (exit $rc)"
    failed+=("$label")
  fi
  local elapsed=$((SECONDS - started))
  echo "$result (${elapsed}s)"
  stage_results+=("$result (${elapsed}s)")
}

# --- Static analysis ---
run "Type check"       pnpm check
run "Lint"             pnpm lint

# Wait for child processes to exit and ports to settle between suites.
wait_for_cleanup() {
  sleep 1
}

# --- Vitest suites (no build needed) ---
run "Unit tests"               pnpm test:unit
wait_for_cleanup
run "Integration tests"        pnpm test:integration
wait_for_cleanup
run "Contract tests"           pnpm test:contract

# --- Build (needed by E2E and storybook visual tests below) ---
run "Build"            pnpm build

# --- E2E tests ---
run "E2E replay tests"         pnpm exec playwright test --config test/e2e/playwright-replay.config.ts
run "E2E harness tests"        env CONDUIT_TEST_DIST=dist pnpm exec playwright test --config test/e2e/playwright-harness.config.ts
run "E2E daemon tests"         pnpm exec playwright test --config test/e2e/playwright-daemon.config.ts
run "E2E preview tests"        pnpm exec playwright test --config test/e2e/playwright-preview.config.ts

# --- Storybook ---
run "Storybook build"          pnpm storybook:build
run "Storybook interaction and a11y tests" pnpm test:storybook
# Strict only: the tolerant pass found almost nothing strict missed. Reuses the build above.
run "Strict Darwin Storybook visual tests" env VISUAL_STRICT=1 pnpm exec playwright test --config test/visual/playwright.config.ts

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for result in "${stage_results[@]}"; do
  echo "  $result"
done
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
