import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const readPackageJson = (path: string) =>
	JSON.parse(readFileSync(path, "utf8")) as {
		dependencies?: Record<string, string>;
		version?: string;
	};

describe("provider SDK version locks", () => {
	it("locks the installed Claude Agent SDK to the pinned dependency version", () => {
		const pinnedVersion = readPackageJson(resolve(repoRoot, "package.json"))
			.dependencies?.["@anthropic-ai/claude-agent-sdk"];
		const installedVersion = readPackageJson(
			resolve(
				repoRoot,
				"node_modules/@anthropic-ai/claude-agent-sdk/package.json",
			),
		).version;

		expect(installedVersion).toBe(pinnedVersion);
		expect(pinnedVersion).toBe("0.3.207");
	});

	it("locks the installed OpenCode SDK to the pinned dependency version", () => {
		const pinnedVersion = readPackageJson(resolve(repoRoot, "package.json"))
			.dependencies?.["@opencode-ai/sdk"];
		const installedVersion = readPackageJson(
			resolve(repoRoot, "node_modules/@opencode-ai/sdk/package.json"),
		).version;

		expect(installedVersion).toBe(pinnedVersion);
		expect(pinnedVersion).toBe("1.17.18");
	});
});
