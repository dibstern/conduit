#!/usr/bin/env bash
# Run all test suites, or selected groups, continuing past failures.
# Exits non-zero if ANY step failed.
# Usage: bash scripts/test-all.sh [static|vitest|build|e2e|storybook|visual ...]
#
# Every selected group keeps its tests and stage order. The timed create test
# runs separately from other harness cases at one worker.
# Multiple groups overlap static checks with builds, then integration/contract
# with strict visuals. All dist/ writers finish before readers; E2E runs alone.
# Lane logs and ordered stage timings survive in the printed temporary run dir.
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
group_count=0
for group in $groups; do
  [[ "$selected" == *" $group "* ]] && group_count=$((group_count + 1))
done

# Increase Node heap to prevent OOM/segfault in large suites.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

failed=()
stage_results=()
total_started=$SECONDS
log_dir=""

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
  if [[ -n "$log_dir" ]]; then
    printf '%s\n' "$result (${elapsed}s)" >"$log_dir/$label.result"
  fi
}

# Wait for child processes to exit and ports to settle between suites.
wait_for_cleanup() {
  sleep 1
}

run_group() {
  case "$1" in
    static)
      run "Type check"       pnpm check
      run "Lint"             pnpm lint
      ;;
    vitest)
      run_group unit
      wait_for_cleanup
      run_group integration
      ;;
    unit)
      run "Unit tests"               pnpm test:unit
      ;;
    integration)
      run "Integration tests"        pnpm test:integration
      wait_for_cleanup
      run "Contract tests"           pnpm test:contract
      ;;
    build)
      run "Build"            pnpm build
      ;;
    e2e)
      # Requires dist/ from the build group or CI's downloaded build artifact.
      if [[ "${CONDUIT_SKIP_DIST_CHECK:-}" != "1" ]]; then
        local failed_before=${#failed[@]}
        run "E2E dist freshness" node scripts/source-hash.mjs check
        [[ ${#failed[@]} -eq "$failed_before" ]] || return 0
      fi
      run_playwright "E2E replay tests" replay test/e2e/playwright-replay.config.ts
      run_playwright "E2E harness tests" harness test/e2e/playwright-harness.config.ts
      run_playwright "E2E daemon tests" daemon test/e2e/playwright-daemon.config.ts
      run_playwright "E2E preview tests" preview test/e2e/playwright-preview.config.ts
      ;;
    storybook)
      run_group storybook-build
      run_group storybook-tests
      ;;
    storybook-build)
      run "Storybook build"          pnpm storybook:build
      ;;
    storybook-tests)
      run "Storybook interaction and a11y tests" pnpm test:storybook
      ;;
    visual)
      # Requires dist/storybook/ from the storybook group or a CI setup step.
      # Strict only: reuses that build and compares Darwin baselines on macOS.
      run_playwright "Strict Darwin Storybook visual tests" visual test/visual/playwright.config.ts
      ;;
  esac
}

# Tests tagged @timed assert wall-clock budgets, which other workers' load
# breaks on small runners, so they run afterwards on one worker. Both phases
# are mandatory, even when the regular phase fails.
run_timed_split_playwright() {
  local suite="$1" config="$2"
  shift 2
  local output_dir="${log_dir:-test-results}/artifacts/$suite"
  local report_dir="${PLAYWRIGHT_HTML_OUTPUT_DIR:-playwright-report}"
  local regular_rc=0 timed_rc=0
  env "$@" PLAYWRIGHT_HTML_OUTPUT_DIR="$report_dir/regular" \
    pnpm exec playwright test --config "$config" --grep-invert @timed \
      --output "$output_dir/regular" || regular_rc=$?
  echo "E2E $suite regular phase exit: $regular_rc"
  env "$@" PLAYWRIGHT_HTML_OUTPUT_DIR="$report_dir/timed" \
    pnpm exec playwright test --config "$config" --grep @timed --workers=1 \
      --output "$output_dir/timed" || timed_rc=$?
  echo "E2E $suite timed phase exit: $timed_rc"
  [[ "$regular_rc" -eq 0 && "$timed_rc" -eq 0 ]]
}

run_playwright() {
  local label="$1" suite="$2" config="$3"
  local args=()
  if [[ -n "$log_dir" ]]; then
    args=(--output "$log_dir/artifacts/$suite")
    export PLAYWRIGHT_HTML_OUTPUT_DIR="$log_dir/reports/$suite"
  fi
  # Keep the original env commands visible for single-group invocations.
  case "$suite" in
    harness) run "$label" run_timed_split_playwright harness "$config" CONDUIT_TEST_DIST=dist ;;
    daemon) run "$label" run_timed_split_playwright daemon "$config" ;;
    visual) run "$label" env VISUAL_STRICT=1 pnpm exec playwright test --config "$config" ${args[@]+"${args[@]}"} ;;
    *) run "$label" pnpm exec playwright test --config "$config" ${args[@]+"${args[@]}"} ;;
  esac
}

lane_pids=()
lane_names=()
cleanup() {
  trap '' INT TERM
  local pid
  # Capture descendants before signalling: Chromium and provider children can
  # create their own process groups. Only descendants of our lanes are owned.
  local roots="${lane_pids[*]-} $(jobs -p)"
  ps -axo pid=,ppid= | awk -v roots="$roots" '
    BEGIN { n = split(roots, ids, " "); for (i = 1; i <= n; i++) owned[ids[i]] = 1 }
    { parent[$1] = $2 }
    END {
      do {
        changed = 0
        for (pid in parent) if (!owned[pid] && owned[parent[pid]]) {
          owned[pid] = 1; changed = 1
        }
      } while (changed)
      for (pid in parent) if (owned[pid]) print pid
    }' >"$log_dir/owned-pids"
  for pid in $roots; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  while read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done <"$log_dir/owned-pids"
  sleep 2
  for pid in $roots; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  while read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <"$log_dir/owned-pids"
  wait 2>/dev/null || true
}

start_lane() {
  local lane="$1"
  shift
  echo "▶ Starting $lane lane: $log_dir/$lane.log"
  (
    trap - INT TERM
    set +m
    for group in "$@"; do run_group "$group"; done
  ) >"$log_dir/$lane.log" 2>&1 &
  lane_pids+=("$!")
  lane_names+=("$lane")
}

wait_for_lanes() {
  local i rc
  for ((i = 0; i < ${#lane_pids[@]}; i++)); do
    if wait "${lane_pids[$i]}"; then rc=0; else rc=$?; fi
    lane_pids[i]=""
    cat "$log_dir/${lane_names[$i]}.log"
    if [[ "$rc" -ne 0 ]]; then failed+=("${lane_names[$i]} lane (exit $rc)"); fi
  done
  lane_pids=()
  lane_names=()
}

if [[ "$group_count" -eq 1 ]]; then
  for group in $groups; do
    [[ "$selected" == *" $group "* ]] && run_group "$group"
  done
else
  log_dir=$(mktemp -d "${TMPDIR:-/tmp}/conduit-test-all.XXXXXX") || exit 1
  echo "Run logs and artifacts: $log_dir"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Separate process groups let cancellation reach every lane's children.
  set -m
  [[ "$selected" == *" static "* ]] && start_lane static static
  artifacts=()
  [[ "$selected" == *" build "* ]] && artifacts+=(build)
  [[ "$selected" == *" storybook "* ]] && artifacts+=(storybook-build)
  if [[ ${#artifacts[@]} -gt 0 ]]; then start_lane builds "${artifacts[@]}"; fi
  wait_for_lanes

  # Unit and interaction tests can use many cores. Finish them before pairing
  # integration forks with the eight browser-only visual workers.
  if [[ "$selected" == *" vitest "* ]]; then
    start_lane unit unit
    wait_for_lanes
    wait_for_cleanup
  fi
  if [[ "$selected" == *" storybook "* ]]; then
    start_lane storybook storybook-tests
    wait_for_lanes
  fi
  [[ "$selected" == *" vitest "* ]] && start_lane integration integration
  [[ "$selected" == *" visual "* ]] && start_lane visual visual
  wait_for_lanes
  if [[ "$selected" == *" e2e "* ]]; then
    start_lane e2e e2e
    wait_for_lanes
  fi
  trap - EXIT INT TERM
  set +m

  # Display every selected stage in the original order, independent of finish
  # order. Missing results also fail the run if a lane exits unexpectedly.
  for group in $groups; do
    [[ "$selected" == *" $group "* ]] || continue
    case "$group" in
      static) labels=("Type check" "Lint") ;;
      vitest) labels=("Unit tests" "Integration tests" "Contract tests") ;;
      build) labels=("Build") ;;
      e2e)
        labels=("E2E replay tests" "E2E harness tests" "E2E daemon tests" "E2E preview tests")
        if [[ "${CONDUIT_SKIP_DIST_CHECK:-}" != "1" ]]; then
          if [[ -f "$log_dir/E2E dist freshness.result" ]] &&
            [[ "$(<"$log_dir/E2E dist freshness.result")" == "✗"* ]]; then
            labels=("E2E dist freshness")
          else
            labels=("E2E dist freshness" "${labels[@]}")
          fi
        fi
        ;;
      storybook) labels=("Storybook build" "Storybook interaction and a11y tests") ;;
      visual) labels=("Strict Darwin Storybook visual tests") ;;
    esac
    for label in "${labels[@]}"; do
      if [[ -f "$log_dir/$label.result" ]]; then
        result=$(<"$log_dir/$label.result")
      else
        result="✗ $label FAILED (did not complete)"
      fi
      stage_results+=("$result")
      [[ "$result" == "✗"* ]] && failed+=("$label")
    done
  done
fi

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for result in "${stage_results[@]}"; do
  echo "  $result"
done
echo "  Total wall time: $((SECONDS - total_started))s"
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
