import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const readPackageJson = (path: string) =>
	JSON.parse(readFileSync(path, "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
		version?: string;
	};

// Minimal ">=X.Y.Z" floor check — enough for the Claude Agent SDK's declared
// @anthropic-ai/sdk peer range, without pulling in a semver dependency. Fails
// loudly (returns false) if the range is not a plain ">=" floor, which is the
// right signal to revisit this guard.
const satisfiesMinFloor = (version: string, range: string): boolean => {
	const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);
	if (!match) return false;
	const floor = match.slice(1, 4).map(Number);
	const actual = version.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const actualPart = actual[i] ?? 0;
		const floorPart = floor[i] ?? 0;
		if (actualPart > floorPart) return true;
		if (actualPart < floorPart) return false;
	}
	return true;
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

	// conduit-test-o6r: @anthropic-ai/sdk is a transitive dep (via the Claude
	// Agent SDK's peer requirement), not a direct conduit dep. An earlier
	// lockfile pinned it to 0.81.0 — below the peer floor. Guard the resolution
	// so any future drift below the declared floor fails loudly here rather than
	// as silent API drift at runtime.
	it("keeps the transitive @anthropic-ai/sdk at or above the Claude Agent SDK peer floor", () => {
		const casPackagePath = resolve(
			repoRoot,
			"node_modules/@anthropic-ai/claude-agent-sdk/package.json",
		);
		const peerRange =
			readPackageJson(casPackagePath).peerDependencies?.["@anthropic-ai/sdk"];

		// The transitive SDK is not hoisted (pnpm); resolve it as a sibling of
		// the Claude Agent SDK inside the shared .pnpm store.
		const casRealDir = realpathSync(dirname(casPackagePath));
		const installedSdkVersion = readPackageJson(
			resolve(casRealDir, "..", "sdk", "package.json"),
		).version;

		expect(peerRange).toBe(">=0.93.0");
		expect(installedSdkVersion).toBe("0.111.0");
		expect(satisfiesMinFloor(installedSdkVersion ?? "", peerRange ?? "")).toBe(
			true,
		);
	});
});
