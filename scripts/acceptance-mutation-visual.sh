#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

FEATURE_FILE="features/composer-send-button.feature"

strip_mutation_manifest() {
	feature_file="$1"
	tmp_file="$(mktemp "${TMPDIR:-/tmp}/composer-send-button-feature.XXXXXX")"
	awk '
		/^# mutation-stamp: / { next }
		/^# acceptance-mutation-manifest-begin$/ { in_manifest = 1; next }
		/^# acceptance-mutation-manifest-end$/ { in_manifest = 0; next }
		in_manifest { next }
		{ print }
	' "$feature_file" > "$tmp_file"
	mv "$tmp_file" "$feature_file"
}

strip_mutation_manifest "$FEATURE_FILE"

preview_pid=""
cleanup() {
	status=$?
	trap - EXIT HUP INT TERM
	if [ -n "$preview_pid" ]; then
		kill "$preview_pid" >/dev/null 2>&1 || true
		wait "$preview_pid" >/dev/null 2>&1 || true
	fi
	strip_mutation_manifest "$FEATURE_FILE"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

. "$ROOT_DIR/scripts/acceptance-env.sh"

pnpm build:frontend

rm -rf \
	build/acceptance-mutation \
	acceptance/visual/artifacts

mkdir -p \
	build/acceptance-mutation/base \
	build/acceptance-mutation/generated \
	acceptance/visual/artifacts

preview_log="$ROOT_DIR/acceptance/visual/artifacts/vite-preview.log"
pnpm exec vite preview --port 4173 --strictPort >"$preview_log" 2>&1 &
preview_pid=$!

attempt=0
until curl --fail --silent --output /dev/null "$CONDUIT_BASE_URL"; do
	if ! kill -0 "$preview_pid" >/dev/null 2>&1; then
		tail -c 4000 "$preview_log" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 100 ]; then
		echo "Timed out waiting for conduit preview at $CONDUIT_BASE_URL" >&2
		tail -c 4000 "$preview_log" >&2
		exit 1
	fi
	sleep 0.1
done

gherkin-parser \
	"$FEATURE_FILE" \
	build/acceptance-mutation/base/composer-send-button.json

pnpm exec tsx \
	acceptance/bin/acceptance-entrypoint-generator.ts \
	build/acceptance-mutation/base/composer-send-button.json \
	build/acceptance-mutation/generated

gherkin-mutator \
	--feature "$FEATURE_FILE" \
	--work-dir build/acceptance-mutation \
	--generated-dir build/acceptance-mutation/generated \
	--runner-worker "pnpm exec tsx acceptance/bin/acceptance-runner-worker.ts" \
	--workers "${ACCEPTANCE_MUTATION_WORKERS:-1}" \
	--timeout "${ACCEPTANCE_MUTATION_TIMEOUT:-45m}" \
	"$@"
