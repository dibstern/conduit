#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BEADS_MARKER = "# --- BEGIN BEADS INTEGRATION";
const HOOK_PATH = ".beads/hooks/pre-commit";

const LEFTHOOK_GATE = `# --- BEGIN CONDUIT LEFTHOOK GATE ---
# Lefthook must run before Beads so failures stop before Beads exports/stages state.
run_lefthook_pre_commit() {
  if [ "$LEFTHOOK" = "0" ] || [ "$LEFTHOOK" = "false" ]; then
    return 0
  fi

  if [ -n "$LEFTHOOK_BIN" ]; then
    "$LEFTHOOK_BIN" run pre-commit "$@"
  elif command -v lefthook >/dev/null 2>&1; then
    lefthook run pre-commit "$@"
  elif [ -x "node_modules/.bin/lefthook" ]; then
    node_modules/.bin/lefthook run pre-commit "$@"
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm exec lefthook run pre-commit "$@"
  else
    echo >&2 "lefthook: not found; run pnpm install"
    return 127
  fi
}

run_lefthook_pre_commit "$@"
_lefthook_exit=$?
if [ "$_lefthook_exit" -ne 0 ]; then
  exit "$_lefthook_exit"
fi
# --- END CONDUIT LEFTHOOK GATE ---`;

function commandExists(command) {
	return (
		spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
			stdio: "ignore",
		}).status === 0
	);
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.error) {
		console.warn(`hook install: ${command} failed: ${result.error.message}`);
		return false;
	}
	return result.status === 0;
}

function ensureLefthookGate(root) {
	const hookPath = join(root, HOOK_PATH);
	if (!existsSync(hookPath)) {
		throw new Error(`${HOOK_PATH} does not exist after Beads hook install`);
	}

	const hook = readFileSync(hookPath, "utf8");
	const beadsIndex = hook.indexOf(BEADS_MARKER);
	if (beadsIndex < 0) {
		throw new Error(`${HOOK_PATH} is missing the Beads integration marker`);
	}

	const beadsBlock = hook.slice(beadsIndex).trimStart();
	const nextHook = `#!/usr/bin/env sh
${LEFTHOOK_GATE}
${beadsBlock}`;

	if (hook !== nextHook) {
		writeFileSync(hookPath, nextHook);
		chmodSync(hookPath, 0o755);
	}
}

function main() {
	const root = process.cwd();

	if (commandExists("bd")) {
		const installed = run("bd", ["hooks", "install", "--beads", "--chain"]);
		if (!installed) {
			console.warn(
				"hook install: Beads hook install failed; leaving hooks unchanged",
			);
			return;
		}
		ensureLefthookGate(root);
		return;
	}

	if (commandExists("pnpm")) {
		run("pnpm", ["exec", "lefthook", "install"]);
	}
}

main();
