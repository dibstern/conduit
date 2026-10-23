// Failure modes: alternate import syntax bypasses the gate, Svelte scripts are
// missed, migrated callers regain direct spawning, or comments trigger warnings.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(
	import.meta.dirname,
	"../../../scripts/check-subprocess-boundary.mjs",
);
const directories: string[] = [];

function check(fixtures: Record<string, string>) {
	const directory = mkdtempSync(join(tmpdir(), "subprocess-boundary-"));
	directories.push(directory);
	for (const [path, source] of Object.entries(fixtures)) {
		const file = join(directory, "src", path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
	}
	return spawnSync(process.execPath, [script], {
		cwd: directory,
		encoding: "utf8",
	});
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("subprocess import boundary", () => {
	it("rejects static, dynamic, CommonJS, re-export, and type imports", () => {
		const fixtures = {
			"static.ts": 'import { spawn } from "node:child_process";',
			"dynamic.mts": 'await import("child_process");',
			"require.cjs": 'const { spawn } = require("node:child_process");',
			"re-export.ts": 'export { spawn } from "child_process";',
			"type.ts": 'type Child = import("node:child_process").ChildProcess;',
			"type-import.ts": 'import type { ChildProcess } from "child_process";',
			"import-equals.cts": 'import child = require("child_process");',
			"template.js": "import(`node:child_process`);",
			"component.svelte":
				'<script lang="ts">import { spawn } from "child_process";</script>',
			"module.svelte":
				'<script module lang="ts">type Child = import("node:child_process").ChildProcess;</script>',
		};
		const result = check(fixtures);
		expect(result.status, result.stderr || result.stdout).toBe(1);
		for (const path of Object.keys(fixtures)) {
			expect(result.stderr).toContain(`src/${path}:1:`);
		}
		expect(result.stdout).toContain("10 violation(s)");
	});

	it("allows the owner, declared process owners, migration debt, and process contract types", () => {
		const result = check({
			"lib/domain/daemon/Services/subprocess.ts":
				'import { spawn } from "node:child_process";',
			"lib/terminal/pty-host-client.ts":
				'import { spawn } from "node:child_process";',
			"lib/daemon/keep-awake.ts":
				'import { execFileSync } from "node:child_process";',
			"lib/daemon/daemon-types.ts":
				'type Options = import("node:child_process").SpawnOptions;',
			"comments.ts":
				'// import { spawn } from "node:child_process";\nconst text = "child_process";',
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain("0 violation(s)");
	});

	it("rejects runtime imports in process contracts and direct imports in migrated callers", () => {
		const result = check({
			"lib/daemon/daemon-types.ts":
				'import { spawn } from "node:child_process";',
			"lib/git/session-git.ts": 'import { spawn } from "child_process";',
		});
		expect(result.status, result.stderr || result.stdout).toBe(1);
		expect(result.stdout).toContain("2 violation(s)");
	});
});
