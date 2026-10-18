#!/usr/bin/env bash
set -euo pipefail
printf 'counter-pid %s %s\n' "$$" "${1:?scenario required}"
i=0
while true; do
  printf 'tick %s %s\n' "$i" "$1"
  i=$((i + 1))
  sleep 1
done
