#!/usr/bin/env bash
set -euo pipefail

[[ $$ == 1 ]] || { echo 'FAIL: container-init.sh must be container PID 1' >&2; exit 1; }
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || {
  echo 'FAIL: this test requires Docker cgroup v2' >&2
  exit 1
}
# --privileged --cgroupns=private gives systemd its own hierarchy. Some Docker
# Desktop versions mount it read-only; remount that private mount, never bind
# the Docker VM's host hierarchy into this container.
if ! mkdir /sys/fs/cgroup/conduit-m37913-probe 2>/dev/null; then
  mount -o remount,rw /sys/fs/cgroup || {
    echo 'FAIL: Docker did not provide a writable private cgroup v2 hierarchy' >&2
    exit 1
  }
  mkdir /sys/fs/cgroup/conduit-m37913-probe
fi
rmdir /sys/fs/cgroup/conduit-m37913-probe
exec /sbin/init
