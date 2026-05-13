import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_LIB = join(REPO_ROOT, "src/lib");

interface AllowedRuntimeBoundary {
	readonly path: string;
	readonly linePattern: RegExp;
	readonly reason: string;
}

const allowedRuntimeBoundaries: readonly AllowedRuntimeBoundary[] = [
	{
		path: "src/lib/daemon/daemon-lifecycle.ts",
		linePattern: /Effect\.runPromise\($/,
		reason:
			"Unix socket callback dispatches decoded tagged IPC into Effect RPC",
	},
	{
		path: "src/lib/effect/daemon-main.ts",
		linePattern: /Effect\.runSync\($/,
		reason: "transitional Node HTTP callback from NodeHttpServer.makeHandler",
	},
	{
		path: "src/lib/instance/sdk-factory.ts",
		linePattern: /Effect\.runPromise\(fetchWithRetry\(/,
		reason: "OpenCode SDK and GapEndpoints require a Promise-shaped fetch",
	},
	{
		path: "src/lib/relay/relay-stack.ts",
		linePattern: /Effect\.runSync\($/,
		reason:
			"transitional standalone Node HTTP callback from NodeHttpServer.makeHandler",
	},
];

function tsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("Effect runtime boundary grep", () => {
	it("keeps app-internal Effect runtime bridges on an explicit allowlist", () => {
		const hits = tsFiles(SRC_LIB).flatMap((file) => {
			const relPath = relative(REPO_ROOT, file);
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					/Effect\.run(?:Promise|Sync)/.test(line)
						? [{ path: relPath, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		const unexpected = hits.filter(
			(hit) =>
				!allowedRuntimeBoundaries.some(
					(boundary) =>
						boundary.path === hit.path && boundary.linePattern.test(hit.source),
				),
		);

		expect(unexpected).toEqual([]);
		expect(hits).toHaveLength(allowedRuntimeBoundaries.length);
	});

	it("does not reintroduce the retired SessionRegistry Effect bridge", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /Layer\.succeed\(SessionRegistryTag,/,
			},
			{
				path: "src/lib/effect/services.ts",
				pattern: /class SessionRegistryTag\b/,
			},
			{
				path: "src/lib/handlers/types.ts",
				pattern: /registry:\s*SessionRegistry\b/,
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});
});
