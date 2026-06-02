import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const preCommitHook = join(repoRoot, ".beads/hooks/pre-commit");
const hookInstaller = join(repoRoot, "scripts/install-git-hooks.mjs");

function writeExecutable(path: string, content: string) {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

function readLog(path: string) {
	return readFileSync(path, "utf8");
}

describe("Beads pre-commit hook", () => {
	it("exits before running Beads when Lefthook fails", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "conduit-pre-commit-"));
		const bin = join(sandbox, "bin");
		const log = join(sandbox, "hook.log");

		try {
			mkdirSync(bin);
			writeFileSync(log, "");
			writeExecutable(
				join(bin, "lefthook"),
				`#!/usr/bin/env sh
echo "lefthook $*" >> "$HOOK_LOG"
exit 42
`,
			);
			writeExecutable(
				join(bin, "bd"),
				`#!/usr/bin/env sh
echo "bd $*" >> "$HOOK_LOG"
exit 0
`,
			);

			const result = spawnSync("sh", [preCommitHook], {
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					HOOK_LOG: log,
					PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
				},
			});

			expect(result.status).toBe(42);
			expect(readLog(log)).toBe("lefthook run pre-commit\n");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("runs Beads after Lefthook succeeds", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "conduit-pre-commit-"));
		const bin = join(sandbox, "bin");
		const log = join(sandbox, "hook.log");

		try {
			mkdirSync(bin);
			writeFileSync(log, "");
			writeExecutable(
				join(bin, "lefthook"),
				`#!/usr/bin/env sh
echo "lefthook $*" >> "$HOOK_LOG"
exit 0
`,
			);
			writeExecutable(
				join(bin, "bd"),
				`#!/usr/bin/env sh
echo "bd $*" >> "$HOOK_LOG"
exit 0
`,
			);

			const result = spawnSync("sh", [preCommitHook], {
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					HOOK_LOG: log,
					PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
				},
			});

			expect(result.status).toBe(0);
			expect(readLog(log)).toBe(
				"lefthook run pre-commit\nbd hooks run pre-commit\n",
			);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("skips only Lefthook when LEFTHOOK is disabled", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "conduit-pre-commit-"));
		const bin = join(sandbox, "bin");
		const log = join(sandbox, "hook.log");

		try {
			mkdirSync(bin);
			writeFileSync(log, "");
			writeExecutable(
				join(bin, "lefthook"),
				`#!/usr/bin/env sh
echo "lefthook $*" >> "$HOOK_LOG"
exit 42
`,
			);
			writeExecutable(
				join(bin, "bd"),
				`#!/usr/bin/env sh
echo "bd $*" >> "$HOOK_LOG"
exit 0
`,
			);

			const result = spawnSync("sh", [preCommitHook], {
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					HOOK_LOG: log,
					LEFTHOOK: "0",
					PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
				},
			});

			expect(result.status).toBe(0);
			expect(readLog(log)).toBe("bd hooks run pre-commit\n");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("repairs the Lefthook gate after Beads installs a Beads-only hook", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "conduit-hook-install-"));
		const bin = join(sandbox, "bin");
		const log = join(sandbox, "hook.log");

		try {
			mkdirSync(bin);
			mkdirSync(join(sandbox, ".beads/hooks"), { recursive: true });
			writeFileSync(log, "");
			writeExecutable(
				join(bin, "bd"),
				`#!/usr/bin/env sh
cat > .beads/hooks/pre-commit <<'HOOK'
#!/usr/bin/env sh
# --- BEGIN BEADS INTEGRATION v1.0.4 ---
if command -v bd >/dev/null 2>&1; then
  bd hooks run pre-commit "$@"
fi
# --- END BEADS INTEGRATION v1.0.4 ---
HOOK
chmod +x .beads/hooks/pre-commit
`,
			);
			writeExecutable(
				join(bin, "lefthook"),
				`#!/usr/bin/env sh
echo "lefthook $*" >> "$HOOK_LOG"
exit 42
`,
			);

			const install = spawnSync("node", [hookInstaller], {
				cwd: sandbox,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
				},
			});

			expect(install.status).toBe(0);

			const hook = join(sandbox, ".beads/hooks/pre-commit");
			const hookContent = readFileSync(hook, "utf8");
			expect(hookContent.indexOf("BEGIN CONDUIT LEFTHOOK GATE")).toBeLessThan(
				hookContent.indexOf("BEGIN BEADS INTEGRATION"),
			);

			writeExecutable(
				join(bin, "bd"),
				`#!/usr/bin/env sh
echo "bd $*" >> "$HOOK_LOG"
exit 0
`,
			);

			const result = spawnSync("sh", [hook], {
				cwd: sandbox,
				encoding: "utf8",
				env: {
					...process.env,
					HOOK_LOG: log,
					PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
				},
			});

			expect(result.status).toBe(42);
			expect(readLog(log)).toBe("lefthook run pre-commit\n");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
