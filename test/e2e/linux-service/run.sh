#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../../.." && pwd)
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
image="conduit-m37913-linux-service:$run_id"
container="conduit-m37913-linux-service-$run_id"
artifacts="$script_dir/artifacts/$run_id"
mkdir -p "$artifacts"
context=$(mktemp -d "${TMPDIR:-/tmp}/conduit-m37913-context.XXXXXX")
created=0
step='checking Docker access'
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  if (( created )); then
    docker exec "$container" bash /repo/test/e2e/linux-service/collect-logs.sh \
      > "$artifacts/collection.log" 2>&1 || rc=1
    docker logs "$container" > "$artifacts/container.log" 2>&1 || rc=1
    docker inspect "$container" > "$artifacts/container-inspect.json" 2>&1 || rc=1
    docker cp "$container:/artifacts/." "$artifacts/" >> "$artifacts/collection.log" 2>&1 || rc=1
    docker rm --force "$container" > "$artifacts/cleanup.log" 2>&1
    cleanup_rc=$?
    if (( cleanup_rc != 0 )); then
      echo "FAIL: could not remove test container $container; see $artifacts/cleanup.log" >&2
      rc=1
    fi
  fi
  # BuildKit keeps the layer cache, so dropping this run's tag keeps reruns fast.
  docker image rm "$image" >> "$artifacts/cleanup.log" 2>&1
  rm -rf "$context"
  if (( rc == 0 )); then
    echo 'PASS: Linux service runtime survival (restart, crash, uninstall, negative control).'
  else
    printf 'FAIL: %s (exit %s); see %s\n' "$step" "$rc" "$artifacts" >&2
    [[ ! -f "$artifacts/driver.log" ]] || tail -c 6000 "$artifacts/driver.log" >&2
  fi
  printf 'Artifacts: %s\n' "$artifacts"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v docker >/dev/null || { echo 'FAIL: docker is not installed' >&2; exit 1; }
docker info > "$artifacts/docker-info.log" 2>&1

step='copying a clean Linux build context'
echo "Building $image; logs: $artifacts/build.log"
mkdir -p "$context/repo"
# In particular, never copy macOS native modules or host credential/config files.
COPYFILE_DISABLE=1 tar -C "$repo_root" --exclude=node_modules --exclude=dist --exclude=.git \
  --exclude=.beads --exclude=.claude --exclude=.claude.json --exclude=.codex \
  --exclude=.aws --exclude=.conduit --exclude=.opencode \
  --exclude=.env --exclude='.env.*' --exclude=.scratch --exclude=.worktrees \
  --exclude=test-results --exclude=./test/e2e/linux-service/artifacts \
  --exclude=./test/e2e/macos-service/artifacts \
  -cf - . | tar -C "$context/repo" -xf -
cp "$script_dir/Dockerfile" "$context/Dockerfile"
step='building Linux dependencies and the real CLI'
docker build --tag "$image" "$context" > "$artifacts/build.log" 2>&1

step='booting systemd in a privileged private cgroup v2 container'
echo "Starting $container"
# No host mounts, ports, credentials, config directories, or PID namespace.
docker create --name "$container" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$image" \
  > "$artifacts/container-id.log" 2>&1
created=1
docker start "$container" > "$artifacts/container-start.log" 2>&1
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" systemctl show --property=SystemState --value \
    > "$artifacts/boot-state.log" 2>&1; then
    if grep -Eq '^(running|degraded)$' "$artifacts/boot-state.log"; then
      ready=1
      break
    fi
  fi
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || break
  sleep 1
done
(( ready )) || { echo 'FAIL: systemd did not boot within 60s; see container.log' >&2; exit 1; }
step='running the Linux service E2E scenarios'
echo "Running scenarios; logs: $artifacts/container-run.log"
docker exec "$container" bash /repo/test/e2e/linux-service/container-run.sh \
  > "$artifacts/container-run.log" 2>&1
