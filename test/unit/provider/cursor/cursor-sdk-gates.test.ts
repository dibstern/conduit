// Failure modes: an exemption admits production imports, an optional SDK goes
// missing unnoticed, or offline SDK contracts are relegated to the paid gate.
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const boundary = resolve("scripts/check-cursor-sdk-boundary.mjs");
const upgrade = resolve(
	".agents/skills/provider-sdk-upgrade/scripts/upgrade.mjs",
);
let root: string;
beforeEach(() => {
	mkdirSync("test-results", { recursive: true });
	root = mkdtempSync(resolve("test-results/c5-b-gates-"));
	for (const directory of ["src", "test", "scripts", "acceptance"])
		mkdirSync(join(root, directory));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Cursor SDK import boundary", () => {
	it.each([
		["test/helpers/cursor-credentials-sdk-reference.mjs", 0],
		["test/e2e/provider/cursor-errors-real-sdk.test.ts", 0],
		["src/lib/provider/cursor/sdk-real.ts", 0],
		["test/unlisted.test.ts", 1],
		["src/other.ts", 1],
		["scripts/other.mjs", 1],
		["acceptance/other.ts", 1],
	] as const)("checks %s", (file, expected) => {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, 'import { Cursor } from "@cursor/sdk";');
		const result = spawnSync(process.execPath, [boundary], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.status, result.stdout + result.stderr).toBe(expected);
	});
});

describe("Cursor upgrade gates", () => {
	it("runs skills, credential and error contracts without --live", () => {
		const result = spawnSync(
			process.execPath,
			[upgrade, "gates", "--only", "cursor", "--dry-run", "--scratch", root],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		for (const file of [
			"cursor-skills-real-sdk",
			"cursor-credentials-real-sdk",
			"cursor-errors-real-sdk",
		])
			expect(result.stdout).toContain(`test/e2e/provider/${file}.test.ts`);
		expect(result.stdout).toContain("cursor-sdk-contract");
		expect(result.stdout).toContain("RUN_CURSOR_SKILLS_SMOKE=0");
		expect(result.stdout).not.toContain("RUN_CURSOR_SKILLS_SMOKE=1");
		expect(result.stdout).not.toContain("cursor-live:");
	});
	it("fails when the optional SDK is missing even in check mode", () => {
		// Mask the ancestor node_modules without changing the shared installation.
		const sdk = join(root, "node_modules/@cursor/sdk");
		mkdirSync(sdk, { recursive: true });
		writeFileSync(
			join(sdk, "package.json"),
			JSON.stringify({ name: "@cursor/sdk", exports: "./missing.js" }),
		);
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(
			join(root, ".opencode-version"),
			readFileSync(".opencode-version"),
		);
		const result = spawnSync(
			process.execPath,
			[
				upgrade,
				"gates",
				"--only",
				"cursor",
				"--dry-run",
				"--root",
				root,
				"--scratch",
				join(root, "scratch"),
			],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Cursor upgrade gates require installed @cursor/sdk",
		);
	});
});
