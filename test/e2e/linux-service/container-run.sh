#!/usr/bin/env bash
set -Eeuo pipefail

[[ $(cat /proc/1/comm) == systemd ]] || { echo 'FAIL: systemd is not PID 1' >&2; exit 1; }
touch /run/conduit-m37913-e2e
step='starting the lingering user manager'
finish() {
  rc=$?
  trap - EXIT
  if (( rc != 0 )); then printf 'FAIL: %s (exit %s)\n' "$step" "$rc" >&2; fi
  if ! bash /repo/test/e2e/linux-service/collect-logs.sh; then
    echo 'FAIL: could not collect every required container log' >&2
    rc=1
  fi
  exit "$rc"
}
trap finish EXIT
loginctl enable-linger conduit
systemctl start user@1001.service
for ((attempt=0; attempt<60; attempt++)); do
  [[ -S /run/user/1001/bus ]] && break
  sleep 1
done
[[ -S /run/user/1001/bus ]] || { echo 'FAIL: user D-Bus did not start within 60s' >&2; exit 1; }

user_env=(runuser -u conduit -- env HOME=/home/conduit SHELL=/bin/bash
  XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus
  CONDUIT_CONFIG_DIR=/home/conduit/.config/conduit CONDUIT_LINUX_SERVICE_E2E=1
  CONDUIT_E2E_ARTIFACTS=/artifacts npm_config_verify_deps_before_run=false
  pnpm_config_verify_deps_before_run=false)
step='configuring the local model backend'
cat > /home/conduit/.claude/settings.json <<'JSON'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18080",
    "ANTHROPIC_API_KEY": "conduit-m37913-dummy-key",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
JSON
printf '{"hasCompletedOnboarding":true}\n' > /home/conduit/.claude.json
chown conduit:conduit /home/conduit/.claude/settings.json /home/conduit/.claude.json
"${user_env[@]}" node test/e2e/linux-service/mock-anthropic.mjs > /artifacts/mock-server.log 2>&1 &
mock_job=$!
trap 'kill "$mock_job" 2>/dev/null || true' TERM INT
for ((attempt=0; attempt<30; attempt++)); do
  [[ -f /artifacts/mock-ready.json ]] && break
  kill -0 "$mock_job" || { echo 'FAIL: mock API exited during startup' >&2; exit 1; }
  sleep 1
done
[[ -f /artifacts/mock-ready.json ]] || { echo 'FAIL: mock API did not start within 30s' >&2; exit 1; }

step='installing the real built CLI as a user service'
"${user_env[@]}" node dist/src/bin/cli.js service install --port 27331 \
  > /artifacts/service-install.log 2>&1
grep -qx 'KillMode=process' /home/conduit/.config/systemd/user/conduit.service || {
  echo 'FAIL: generated unit does not contain KillMode=process' >&2
  exit 1
}
cp /home/conduit/.config/systemd/user/conduit.service /artifacts/conduit-generated.service
step='running restart, crash, uninstall, and negative-control scenarios'
timeout --signal=TERM --kill-after=15s 600s \
  "${user_env[@]}" node node_modules/tsx/dist/cli.mjs test/e2e/linux-service/driver.ts \
  > /artifacts/driver.log 2>&1
cat /artifacts/driver.log
