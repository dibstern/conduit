#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export TZ=UTC
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../../.." && pwd)
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
artifacts="$script_dir/artifacts/$run_id"
mkdir -p "$artifacts"
step='checking prerequisites'
isolation=''
install_attempted=0
same_process() {
  local current
  current=$(/bin/ps -p "$1" -o lstart= 2>/dev/null) || return 1
  current="${current#"${current%%[![:space:]]*}"}"
  current="${current%"${current##*[![:space:]]}"}"
  [[ $current == "$2" ]]
}
stop_installers() {
  local pid ppid started index known added failed=0
  local -a pids=() starts=()
  while IFS=$'\t' read -r pid started; do
    [[ $pid == "${install_job:-}" || $pid == "${driver_job:-}" ]] || continue
    same_process "$pid" "$started" || continue
    pids+=("$pid")
    starts+=("$started")
  done < "$isolation/processes.tsv"
  # Freeze each parent before walking its children, so installers cannot fork
  # another bootstrap after we have collected their descendants.
  for ((index=0; index<${#pids[@]}; index++)); do
    same_process "${pids[index]}" "${starts[index]}" || continue
    kill -STOP "${pids[index]}" 2>> "$artifacts/cleanup.log" || failed=1
  done
  while :; do
    added=0
    /bin/ps -ax -o pid=,ppid=,lstart= > "$isolation/installer-processes.txt" 2>> "$artifacts/cleanup.log" || { failed=1; break; }
    while read -r pid ppid started; do
      [[ $pid =~ ^[0-9]+$ && $ppid =~ ^[0-9]+$ && -n $started ]] || continue
      known=0
      for ((index=0; index<${#pids[@]}; index++)); do
        [[ $pid != "${pids[index]}" ]] || known=1
      done
      (( known == 0 )) || continue
      for ((index=0; index<${#pids[@]}; index++)); do
        [[ $ppid == "${pids[index]}" ]] || continue
        same_process "$ppid" "${starts[index]}" || continue
        same_process "$pid" "$started" || continue
        pids+=("$pid")
        starts+=("$started")
        printf '%s\t%s\n' "$pid" "$started" >> "$isolation/processes.tsv"
        kill -STOP "$pid" 2>> "$artifacts/cleanup.log" || failed=1
        added=1
        break
      done
    done < "$isolation/installer-processes.txt"
    (( added )) || break
  done
  # Kill the frozen trees without resuming installers, then reap our two jobs.
  for ((index=${#pids[@]}-1; index>=0; index--)); do
    same_process "${pids[index]}" "${starts[index]}" || continue
    kill -KILL "${pids[index]}" 2>> "$artifacts/cleanup.log" || failed=1
  done
  [[ -z ${install_job:-} ]] || wait "$install_job" 2>/dev/null || true
  [[ -z ${driver_job:-} ]] || wait "$driver_job" 2>/dev/null || true
  return "$failed"
}
finish() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n $isolation && -f $isolation/processes.tsv ]]; then
    stop_installers || rc=1
  fi
  if (( install_attempted )); then
    # These assertions also guard cleanup. Never boot out a whole GUI domain.
    if [[ $label == dev.conduit.test.* && $label != dev.conduit.server &&
          $config != "$real_home/.config/conduit" && $config == "$isolation/home/.config/conduit" ]]; then
      [[ ! -f $plist ]] || cp "$plist" "$artifacts/conduit-generated.plist" || rc=1
      "${isolated[@]}" "$node_bin" --import "$repo_root/node_modules/tsx/dist/loader.mjs" \
        "$script_dir/processes.ts" --collect "$project" "$test_home" "$isolation/processes.tsv" "$artifacts/evidence.jsonl" \
        >> "$artifacts/cleanup.log" 2>&1 || rc=1
      /bin/launchctl bootout "$target" > "$artifacts/cleanup-launchctl.log" 2>&1
      if /bin/launchctl print "$target" >> "$artifacts/cleanup-launchctl.log" 2>&1; then
        echo 'FAIL: isolated launchd job remains loaded' >&2
        rc=1
      fi
      "${isolated[@]}" "$node_bin" --import "$repo_root/node_modules/tsx/dist/loader.mjs" \
        "$script_dir/processes.ts" --collect "$project" "$test_home" "$isolation/processes.tsv" "$artifacts/evidence.jsonl" \
        >> "$artifacts/cleanup.log" 2>&1 || rc=1
    else
      echo 'FAIL: refusing cleanup of a non-isolated launchd target' >&2
      rc=1
    fi
  fi
  if [[ -n $isolation && -f $isolation/processes.tsv ]]; then
    # Signal individual recorded identities only, including the mock, driver,
    # service owners and observed descendants. PID reuse must never kill a bystander.
    for signal in TERM KILL; do
      while IFS=$'\t' read -r pid started; do
        [[ $pid =~ ^[0-9]+$ && -n $started ]] || continue
        current=$(/bin/ps -p "$pid" -o lstart= 2>/dev/null) || continue
        current="${current#"${current%%[![:space:]]*}"}"
        current="${current%"${current##*[![:space:]]}"}"
        [[ $current == "$started" ]] || continue
        kill -"$signal" "$pid" 2>> "$artifacts/cleanup.log"
      done < "$isolation/processes.tsv"
      [[ $signal == KILL ]] || sleep 1
    done
    while IFS=$'\t' read -r pid started; do
      state=$(/bin/ps -p "$pid" -o state= 2>/dev/null) || continue
      [[ $state != *Z* ]] || continue
      current=$(/bin/ps -p "$pid" -o lstart= 2>/dev/null) || continue
      current="${current#"${current%%[![:space:]]*}"}"
      current="${current%"${current##*[![:space:]]}"}"
      if [[ $current == "$started" ]]; then
        echo "FAIL: recorded PID $pid remains after cleanup" >> "$artifacts/cleanup.log"
        rc=1
      fi
    done < "$isolation/processes.tsv"
  fi
  if [[ -n $isolation ]]; then
    cp "$isolation/processes.tsv" "$artifacts/processes.tsv" 2>/dev/null
    cp "$isolation/controls.tsv" "$artifacts/controls.tsv" 2>/dev/null
    cp "$isolation/servers.tsv" "$artifacts/servers.tsv" 2>/dev/null
    if [[ -d $isolation/home/.config/conduit ]]; then
      while IFS= read -r file; do
        relative=${file#"$isolation/home/.config/conduit/"}
        mkdir -p "$artifacts/service-logs/$(dirname -- "$relative")"
        cp "$file" "$artifacts/service-logs/$relative" || rc=1
      done < <(rg --files --hidden --no-ignore "$isolation/home/.config/conduit" -g '*.log')
    fi
  fi
  if (( install_attempted )); then
    if [[ $label == dev.conduit.test.* && $label != dev.conduit.server &&
          $config != "$real_home/.config/conduit" && $config == "$isolation/home/.config/conduit" ]]; then
      /bin/launchctl bootout "$target" >> "$artifacts/cleanup-launchctl.log" 2>&1
      if /bin/launchctl print "$target" >> "$artifacts/cleanup-launchctl.log" 2>&1; then
        echo 'FAIL: isolated launchd job remains loaded at end of cleanup' >&2
        rc=1
      fi
    else
      echo 'FAIL: refusing final cleanup of a non-isolated launchd target' >&2
      rc=1
    fi
  fi
  if (( rc != 0 )) || [[ ! -f $artifacts/result.json ]]; then
    (( rc != 0 )) || rc=1
    node - "$artifacts/result.json" "$step" "$rc" <<'JS'
const fs = require('node:fs');
const [file, step, code] = process.argv.slice(2);
const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.writeFileSync(file, JSON.stringify({ ...prior, passed: false, scriptStep: step, exitCode: Number(code) }, null, 2));
JS
    rc=1
  fi
  # Retain the private directory when cleanup fails, for manual diagnosis.
  if (( rc == 0 )); then
    [[ -z $isolation ]] || rm -rf "$isolation"
    echo 'PASS: macOS service runtime survival (restart, crash, reinstall, uninstall, negative control).'
  else
    printf 'FAIL: %s (exit %s); isolated files: %s\n' "$step" "$rc" "$isolation" >&2
    [[ ! -f $artifacts/driver.log ]] || tail -c 6000 "$artifacts/driver.log" >&2
  fi
  printf 'Artifacts: %s\n' "$artifacts"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $(uname -s) == Darwin ]] || { echo 'FAIL: macOS required' >&2; exit 1; }
[[ -f $repo_root/dist/src/bin/cli.js && -f $repo_root/dist/build-ready.json &&
   -f $repo_root/dist/src/bin/claude-session-runner.js && -f $repo_root/dist/src/bin/pty-host.js &&
   -f $repo_root/dist/src/lib/instance/managed-opencode-supervisor.js ]] || {
  echo 'FAIL: built dist/ is missing; run pnpm build first' >&2; exit 1;
}
command -v mise >/dev/null
eval "$(mise env -s bash)"
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
node_bin=$(command -v node)
[[ -x /opt/homebrew/bin/opencode && -x /usr/bin/python3 && -f $repo_root/node_modules/tsx/dist/loader.mjs ]] || {
  echo 'FAIL: OpenCode, Python or local tsx is missing' >&2; exit 1;
}
command -v rg >/dev/null
# A denied process inspection must fail before installing a job we cannot clean up.
/bin/ps -p $$ -o lstart= > "$artifacts/process-preflight.log" 2>&1

step='enforcing isolation'
real_home=$(node -e 'process.stdout.write(require("node:os").homedir())')
isolation=$(mktemp -d /private/tmp/conduit-m37914-XXXXXX)
test_home="$isolation/home"
config="$test_home/.config/conduit"
project="$isolation/project"
label="dev.conduit.test.$run_id"
target="gui/$(id -u)/$label"
plist="$test_home/Library/LaunchAgents/$label.plist"
[[ $label =~ ^dev\.conduit\.test\.[a-zA-Z0-9-]+$ && $label != dev.conduit.server &&
   $config != "$real_home/.config/conduit" && $test_home != "$real_home" &&
   $config == "$isolation/home/.config/conduit" ]] || {
  echo 'FAIL: unsafe service label or config directory' >&2; exit 1;
}
mkdir -p "$test_home/.claude" "$config" "$project" "$isolation/bin"
touch "$isolation/processes.tsv" "$isolation/controls.tsv" "$isolation/servers.tsv"
record_pid() {
  local pid=$1 started
  started=$(/bin/ps -p "$pid" -o lstart=)
  started="${started#"${started%%[![:space:]]*}"}"
  started="${started%"${started##*[![:space:]]}"}"
  [[ -n $started ]]
  printf '%s\t%s\n' "$pid" "$started" >> "$isolation/processes.tsv"
}
start_tracked_job() {
  local job_name=$1 output=$2 interrupted=0
  shift 2
  # Defer interruption until the job's PID and start time are both recorded.
  trap 'interrupted=130' INT
  trap 'interrupted=143' TERM
  "$@" > "$output" 2>&1 &
  printf -v "$job_name" '%s' "$!"
  record_pid "${!job_name}"
  trap 'exit 130' INT
  trap 'exit 143' TERM
  (( interrupted == 0 )) || exit "$interrupted"
}

# The service uses a login shell. Its entire profile is ours, and resolves
# conduit and node to this worktree and the node selected by mise.
{
  printf 'export HOME=%q\n' "$test_home"
  printf 'export PATH=%q\n' "$isolation/bin:$(dirname -- "$node_bin"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  printf 'export CONDUIT_CONFIG_DIR=%q\n' "$config"
  printf 'export CONDUIT_SERVICE_LABEL=%q\n' "$label"
  printf 'export CONDUIT_E2E_REGISTRY=%q\n' "$isolation/processes.tsv"
  printf 'export CONDUIT_E2E_CONTROLS=%q\n' "$isolation/controls.tsv"
  printf 'export CONDUIT_E2E_SERVERS=%q\n' "$isolation/servers.tsv"
  printf 'export OPENCODE_DISABLE_MODELS_FETCH=1\n'
  printf 'export TZ=UTC\n'
} > "$test_home/.bash_profile"
{
  printf '#!/bin/bash\nset -euo pipefail\n'
  cat <<'SH'
# Record the launcher before exec, so even a failed driver start is cleanable.
started=$(/bin/ps -p "$$" -o lstart=)
started="${started#"${started%%[![:space:]]*}"}"
  started="${started%"${started##*[![:space:]]}"}"
printf '%s\t%s\n' "$$" "$started" >> "$CONDUIT_E2E_REGISTRY"
# This child deliberately stays in the launchd job's process group.
if [[ ${1:-} == serve ]]; then
  printf '%s\t%s\n' "$$" "$started" >> "$CONDUIT_E2E_SERVERS"
  /bin/sleep 600 </dev/null &
  pid=$!
  started=$(/bin/ps -p "$pid" -o lstart=)
  started="${started#"${started%%[![:space:]]*}"}"
  started="${started%"${started##*[![:space:]]}"}"
  printf '%s\t%s\n' "$pid" "$started" >> "$CONDUIT_E2E_CONTROLS"
  printf '%s\t%s\n' "$pid" "$started" >> "$CONDUIT_E2E_REGISTRY"
fi
SH
  printf 'exec %q %q "$@"\n' "$node_bin" "$repo_root/dist/src/bin/cli.js"
} > "$isolation/bin/conduit"
chmod 700 "$isolation/bin/conduit"

isolated=(env -i HOME="$test_home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash
  PATH="$isolation/bin:$(dirname -- "$node_bin"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  TMPDIR="$isolation/" LC_ALL=C TZ=UTC CONDUIT_CONFIG_DIR="$config" CONDUIT_SERVICE_LABEL="$label"
  CONDUIT_MACOS_SERVICE_E2E=1 CONDUIT_E2E_ARTIFACTS="$artifacts"
  npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false)
step='checking built CLI service-label support'
# Status only reads files and runs launchctl print. A private HOME alone cannot
# protect the live GUI job from an old CLI that ignores CONDUIT_SERVICE_LABEL.
if ! "${isolated[@]}" "$node_bin" "$repo_root/dist/src/bin/cli.js" service status > "$artifacts/service-preflight.log" 2>&1 ||
   [[ $(sed -n 's/^  Unit: //p' "$artifacts/service-preflight.log") != "$plist" ]]; then
  echo 'FAIL: built CLI could not verify the isolated service label; run pnpm build before retrying (see service-preflight.log)' >&2
  exit 1
fi
step='starting the shared streaming mock'
"${isolated[@]}" CONDUIT_E2E_MOCK_PORT=0 "$node_bin" "$repo_root/test/e2e/linux-service/mock-anthropic.mjs" > "$artifacts/mock-server.log" 2>&1 &
mock_job=$!
record_pid "$mock_job"
for ((attempt=0; attempt<100; attempt++)); do
  [[ -f $artifacts/mock-ready.json ]] && break
  kill -0 "$mock_job" || { echo 'FAIL: mock exited during startup' >&2; exit 1; }
  sleep 0.1
done
[[ -f $artifacts/mock-ready.json ]] || { echo 'FAIL: mock did not start' >&2; exit 1; }
mock_port=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).port))' "$artifacts/mock-ready.json")
node - "$test_home/.claude/settings.json" "$mock_port" <<'JS'
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${process.argv[3]}`,
  ANTHROPIC_API_KEY: 'conduit-m37914-dummy-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
} }, null, 2));
JS
printf '{"hasCompletedOnboarding":true}\n' > "$test_home/.claude.json"
port=$(node - <<'JS'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  server.close(() => process.stdout.write(String(port)));
});
JS
)
[[ $port =~ ^[0-9]+$ && $port != 2633 ]] || { echo 'FAIL: unsafe port' >&2; exit 1; }
node - "$artifacts/isolation.json" "$test_home" "$config" "$label" "$port" "$project" <<'JS'
const [file, home, config, label, port, project] = process.argv.slice(2);
require('node:fs').writeFileSync(file, JSON.stringify({ home, config, label, port: Number(port), project }, null, 2));
JS

step='installing the isolated launchd service'
cd "$project"
install_attempted=1
start_tracked_job install_job "$artifacts/service-install.log" \
  "${isolated[@]}" "$node_bin" "$repo_root/dist/src/bin/cli.js" service install --port "$port" --host 127.0.0.1 --no-https --claude-config-dir "$test_home/.claude"
wait "$install_job"
cp "$plist" "$artifacts/conduit-generated.plist"
step='running restart, crash, reinstall, uninstall and negative-control scenarios'
echo "Running isolated macOS scenarios; logs: $artifacts/driver.log"
start_tracked_job driver_job "$artifacts/driver.log" \
  "${isolated[@]}" "$node_bin" --import "$repo_root/node_modules/tsx/dist/loader.mjs" "$script_dir/driver.ts"
wait "$driver_job"
