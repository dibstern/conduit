#!/usr/bin/env bash
# Run all test suites, continuing past failures so you see every broken suite.
# Exits non-zero if ANY step failed.

set -uo pipefail

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

# --- Prerequisites (build must succeed for later steps) ---
# check + lint + build are prerequisites — if they fail, tests can't run meaningfully,
# but we still continue so you see if the failure is just types/lint or also tests.
run "Type check"       pnpm check
run "Lint"             pnpm lint
run "Build"            pnpm build

# --- Test suites ---
run "Unit tests"               vitest run
run "Integration tests"        vitest run --config vitest.integration.config.ts
run "Contract tests"           vitest run --config vitest.contract.config.ts
run "E2E replay tests"         npx playwright test --config test/e2e/playwright-replay.config.ts
run "E2E daemon tests"         npx playwright test --config test/e2e/playwright-daemon.config.ts
run "E2E multi-instance tests" npx playwright test --config test/e2e/playwright-multi-instance.config.ts
run "E2E subagent tests"       npx playwright test --config test/e2e/playwright-subagent.config.ts
run "E2E visual tests"         npx playwright test --config test/e2e/playwright-visual.config.ts
run "Storybook build"          pnpm storybook:build
run "Storybook visual tests"   npx playwright test --config test/visual/playwright.config.ts

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
