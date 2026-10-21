#!/usr/bin/env bash
# Run all test suites, or selected groups, continuing past failures.
# Exits non-zero if ANY step failed.
# Usage: bash scripts/test-all.sh [static|vitest|build|e2e|storybook|visual ...]
#
# Ordering is optimized: vitest suites run before the build since they don't
# need build output. The build runs just before E2E tests that need dist/.
# Suites run in order here; integration files run in parallel within their suite.
# Release CI (npm-release.yml) runs these same groups in parallel jobs.

set -uo pipefail

groups="static vitest build e2e storybook visual"
for group in "$@"; do
  case " $groups " in
    *" $group "*) ;;
    *) echo "Unknown group: $group. Available groups: $groups" >&2; exit 2 ;;
  esac
done
# Padded with spaces so a group matches only as a whole word.
selected=" ${*:-$groups} "

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
  if "$@" </dev/null; then
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

# Wait for child processes to exit and ports to settle between suites.
wait_for_cleanup() {
  sleep 1
}

# Stages always run in this order, however the arguments are ordered.
for group in $groups; do
  [[ "$selected" == *" $group "* ]] || continue

  case "$group" in
    static)
      run "Type check"       pnpm check
      run "Lint"             pnpm lint
      ;;
    vitest)
      run "Unit tests"               pnpm test:unit
      wait_for_cleanup
      run "Integration tests"        pnpm test:integration
      wait_for_cleanup
      run "Contract tests"           pnpm test:contract
      ;;
    build)
      run "Build"            pnpm build
      ;;
    e2e)
      # Requires dist/ from the build group or CI's downloaded build artifact.
      run "E2E replay tests"         pnpm exec playwright test --config test/e2e/playwright-replay.config.ts
      run "E2E harness tests"        env CONDUIT_TEST_DIST=dist pnpm exec playwright test --config test/e2e/playwright-harness.config.ts
      run "E2E daemon tests"         pnpm exec playwright test --config test/e2e/playwright-daemon.config.ts
      run "E2E preview tests"        pnpm exec playwright test --config test/e2e/playwright-preview.config.ts
      ;;
    storybook)
      run "Storybook build"          pnpm storybook:build
      run "Storybook interaction and a11y tests" pnpm test:storybook
      ;;
    visual)
      # Requires dist/storybook/ from the storybook group or a CI setup step.
      # Strict only: reuses that build and compares Darwin baselines on macOS.
      run "Strict Darwin Storybook visual tests" env VISUAL_STRICT=1 pnpm exec playwright test --config test/visual/playwright.config.ts
      ;;
  esac
done

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
