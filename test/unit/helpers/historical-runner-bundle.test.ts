import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";

// Each child is its own process, as vitest forks and other worktrees' hooks are.
// Its fake build announces itself, then finishes only once the test says go.
const child = `
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { historicalRunnerBundle } = await import(process.env.HELPER);
const { commit, cacheRoot, fail } = JSON.parse(process.env.BUNDLE);
console.log("ready");
const bundle = await historicalRunnerBundle(commit, {
  cacheRoot,
  buildSource: async (_commit, source) => {
    console.log("building");
    mkdirSync(join(source, "dist/src/bin"), { recursive: true });
    writeFileSync(join(source, "dist/src/bin/claude-session-runner.js"), "");
    if (fail) throw new Error("forced build failure");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    writeFileSync(join(source, "dist/build-ready.json"), JSON.stringify({ buildId: String(process.pid) }));
  },
});
console.log(JSON.stringify(bundle));
process.exit(0);
`;

const cacheRoot = mkdtempSync(join(tmpdir(), "historical-bundle-cache-"));
afterEach(() => rmSync(cacheRoot, { recursive: true, force: true }));

function start(commit: string, fail = false) {
	const runner = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", child],
		{
			env: {
				...process.env,
				HELPER: new URL(
					"../../helpers/historical-runner-bundle.ts",
					import.meta.url,
				).href,
				BUNDLE: JSON.stringify({ commit, cacheRoot, fail }),
			},
			stdio: ["pipe", "pipe", "inherit"],
		},
	);
	const lines = createInterface({ input: runner.stdout });
	const seen: string[] = [];
	const line = (wanted: string) =>
		seen.includes(wanted)
			? Promise.resolve()
			: new Promise<void>((resolve) =>
					lines.on("line", (text) => text === wanted && resolve()),
				);
	lines.on("line", (text) => seen.push(text));
	// Listen from the spawn: under load the failing child exits before the test awaits it.
	// "close" waits for its stdout too, so its last line is already seen.
	return { exited: once(runner, "close"), process: runner, seen, line };
}

const result = async (built: { exited: Promise<unknown>; seen: string[] }) => {
	await built.exited;
	return JSON.parse(built.seen.at(-1) ?? "null") as {
		available: boolean;
		cacheDir?: string;
		buildId?: string;
	};
};

it("builds a commit once across processes, reclaims a dead builder, replaces an incomplete bundle, and never leaks staging", async () => {
	const suffix = `-${process.platform}-${process.arch}-${process.versions.modules}`;
	const commit = "a".repeat(40);
	const cacheName = `${commit}${suffix}`;
	const failing = "b".repeat(40);
	// A bundle whose files were removed after it was published, as the 0 KB one was.
	mkdirSync(join(cacheRoot, cacheName, "source/dist"), { recursive: true });
	// A builder killed part way: its lock and its staging outlive it.
	const killed = spawn(process.execPath, ["-e", ""]);
	await once(killed, "exit");
	symlinkSync(String(killed.pid), join(cacheRoot, `${cacheName}.lock`));
	mkdirSync(join(cacheRoot, `${cacheName}.staging-${killed.pid}/source`), {
		recursive: true,
	});

	const first = start(commit);
	const second = start(commit);
	const broken = start(failing, true);
	await Promise.all([first.line("ready"), second.line("ready")]);
	await Promise.race([first.line("building"), second.line("building")]);
	for (const built of [first, second]) built.process.stdin?.end("go\n");

	const [one, two, failed] = await Promise.all([
		result(first),
		result(second),
		result(broken),
	]);
	expect({
		cache: readdirSync(cacheRoot).sort(),
		builds: [...first.seen, ...second.seen].filter(
			(text) => text === "building",
		).length,
	}).toEqual({
		cache: [cacheName, `${cacheName}.log`, `${failing}${suffix}.log`],
		builds: 1,
	});
	expect(failed.available).toBe(false);
	expect(one).toMatchObject({
		available: true,
		cacheDir: join(cacheRoot, cacheName),
	});
	expect(two).toEqual(one);
});
