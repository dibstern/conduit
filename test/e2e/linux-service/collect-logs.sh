#!/usr/bin/env bash
set -uo pipefail
[[ -f /run/conduit-m37913-e2e ]] || exit 1
mkdir -p /artifacts/runtime-logs
rc=0
runuser -u conduit -- env XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  journalctl --user -u conduit --no-pager -o short-precise \
  > /artifacts/journal-user-conduit.log 2>&1 || rc=1
journalctl --no-pager -o short-precise > /artifacts/journal-system.log 2>&1 || rc=1
systemctl status user@1001.service --no-pager > /artifacts/user-manager-status.log 2>&1 || rc=1
ps -ww -eo pid,ppid,pgid,sid,lstart,args > /artifacts/processes.log 2>&1 || rc=1
if [[ -d /home/conduit/.config/conduit ]]; then
  while IFS= read -r -d '' file; do
    relative=${file#/home/conduit/.config/conduit/}
    mkdir -p "/artifacts/runtime-logs/$(dirname "$relative")" || rc=1
    cp "$file" "/artifacts/runtime-logs/$relative" || rc=1
  done < <(find /home/conduit/.config/conduit -type f -name '*.log*' -print0)
fi
if [[ -f /home/conduit/.config/systemd/user/conduit.service ]]; then
  cp /home/conduit/.config/systemd/user/conduit.service /artifacts/conduit-at-collection.service || rc=1
fi
exit "$rc"
