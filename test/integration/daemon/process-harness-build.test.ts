import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("process harness supplied builds", () => {
	const roots: string[] = [];
	let harness: ProcessHarness | undefined;

	afterEach(async (context) => {
		try {
			await harness?.dispose();
			if (harness) {
				mkdirSync("test-results/process-harness", { recursive: true });
				writeFileSync(
					`test-results/process-harness/${context.task.name.replace(/\W+/g, "-")}.json`,
					JSON.stringify(harness.proof(), null, 2),
				);
			}
		} finally {
			harness = undefined;
			for (const root of roots.splice(0))
				rmSync(root, { recursive: true, force: true });
		}
	});

	function copyBuild(): { root: string; dist: string } {
		const root = mkdtempSync("/tmp/conduit-harness-build-");
		roots.push(root);
		const dist = join(root, "dist");
		mkdirSync(dist);
		cpSync(resolve("dist/src"), join(dist, "src"), { recursive: true });
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		symlinkSync(resolve("node_modules"), join(root, "node_modules"));
		return { root, dist };
	}

	it("rejects a build ignoring the fake selector before any SDK prompt", async () => {
		const { root, dist } = copyBuild();
		const relayPath = join(dist, "src/lib/relay/relay-stack.js");
		const relay = readFileSync(relayPath, "utf8");
		const selector =
			'const testQueryModule = process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"];';
		expect(relay).toContain(selector);
		writeFileSync(
			relayPath,
			relay.replace(selector, "const testQueryModule = undefined;"),
		);
		const runtimePath = join(
			dist,
			"src/lib/provider/claude/claude-provider-runtime.js",
		);
		const runtime = readFileSync(runtimePath, "utf8");
		const sdkImport =
			/import\s*\{\s*query as sdkQuery,?\s*\}\s*from\s*"@anthropic-ai\/claude-agent-sdk";/;
		expect(runtime).toMatch(sdkImport);
		const tripwire = join(root, "real-sdk-called");
		writeFileSync(
			runtimePath,
			runtime.replace(
				sdkImport,
				`import { writeFileSync as writeTripwire } from "node:fs";\nconst sdkQuery = () => { writeTripwire(${JSON.stringify(tripwire)}, "called"); throw new Error("Real SDK tripwire"); };`,
			),
		);
		const startup = ProcessHarness.start({ dist }).then((active) => {
			harness = active;
			return active;
		});
		await expect(startup).rejects.toThrow(
			"Fake Claude SDK activation was not acknowledged",
		);
		expect(existsSync(tripwire)).toBe(false);
		mkdirSync("test-results/process-harness", { recursive: true });
		writeFileSync(
			"test-results/process-harness/fake-sdk-rejection.json",
			JSON.stringify(
				{ dist, fakeSdkRejected: true, realSdkCalled: existsSync(tripwire) },
				null,
				2,
			),
		);
	});

	it("bounds disconnect cleanup inside the child even if shutdown hangs", async () => {
		const { dist } = copyBuild();
		const foregroundPath = join(
			dist,
			"src/lib/domain/daemon/Layers/daemon-foreground.js",
		);
		const originalPath = join(
			dist,
			"src/lib/domain/daemon/Layers/daemon-foreground-original.js",
		);
		cpSync(foregroundPath, originalPath);
		writeFileSync(
			foregroundPath,
			`
import { startForegroundDaemon as start } from "./daemon-foreground-original.js";
export async function startForegroundDaemon(options) {
  const daemon = await start(options);
  return { ...daemon, stop: () => new Promise(() => {}), stopped: new Promise(() => {}) };
}
`,
		);
		harness = await ProcessHarness.start({ dist });
		await harness.disconnectParent();
		expect(harness.generations[0]?.exitCode).toBe(1);
		expect(harness.generations[0]?.signal).toBeNull();
	});
});
