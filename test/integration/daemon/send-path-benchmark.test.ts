import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("send-path benchmark CLI aggregation", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function compare(
		candidate: { enqueue: number[]; forward: number[] },
		baseline = { enqueue: [10, 10, 10, 10, 10], forward: [1, 1, 1, 1, 1] },
		failCandidate = false,
	) {
		const root = mkdtempSync("/tmp/conduit-benchmark-cli-");
		roots.push(root);
		for (const dir of ["bench", "helpers", "baseline", "candidate"])
			mkdirSync(join(root, dir));
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		cpSync(
			resolve("test/bench/send-path.ts"),
			join(root, "bench/send-path.ts"),
		);
		cpSync(
			resolve("test/fixtures/send-path/process-harness.ts"),
			join(root, "helpers/process-harness.ts"),
		);
		const trace = join(root, "order.txt");
		for (const [label, latencies] of [
			["baseline", baseline],
			["candidate", candidate],
		] as const) {
			const build = join(root, label);
			for (const file of [
				"src/lib/domain/daemon/Layers/daemon-foreground.js",
				"src/lib/server/ws-rpc-handler.js",
			]) {
				const path = join(build, file);
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, "");
			}
			writeFileSync(
				join(build, "latencies.json"),
				JSON.stringify({
					...latencies,
					trace,
					promptTrace: `${trace}.prompts`,
					failActivation: label === "candidate" && failCandidate,
					...(label === "baseline" ? { runnerMode: "in-process" } : {}),
				}),
			);
		}
		const output = join(root, "results.json");
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				join(root, "bench/send-path.ts"),
				"--dist",
				join(root, "baseline"),
				"--candidate",
				join(root, "candidate"),
				"--output",
				output,
			],
			{ encoding: "utf8", timeout: 15_000 },
		);
		expect(child.error).toBeUndefined();
		return { child, root, output, trace };
	}

	it("alternates five 200-send batches and ignores an isolated candidate tail spike", () => {
		const { child, output, trace } = compare({
			enqueue: [30, 10, 10, 10, 10],
			forward: [20, 1, 1, 1, 1],
		});
		expect(child.status, child.stderr).toBe(0);
		expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(
			Array.from({ length: 5 }, () => ["baseline", "candidate"]).flat(),
		);
		const results = JSON.parse(readFileSync(output, "utf8")) as Record<
			"baseline" | "candidate",
			{
				batches: Array<{ sends: number; forward: { count: number } }>;
				enqueue: { p99: number };
				forward: { p99: number };
			}
		>;
		for (const result of [results.baseline, results.candidate]) {
			expect(result.batches).toHaveLength(5);
			expect(
				result.batches.map((batch) => [batch.sends, batch.forward.count]),
			).toEqual(Array.from({ length: 5 }, () => [200, 600]));
			expect(result.enqueue.p99).toBe(10);
			expect(result.forward.p99).toBe(1);
		}
	});

	it("measures each build's default runner path and records its activation", () => {
		const { child, output, trace } = compare({
			enqueue: [10, 10, 10, 10, 10],
			forward: [1, 1, 1, 1, 1],
		});
		expect(child.status, child.stderr).toBe(0);
		expect(readFileSync(`${trace}.modes`, "utf8")).toBe(
			"baseline:in-process\ncandidate:process\n",
		);
		const result = JSON.parse(readFileSync(output, "utf8")) as {
			baseline: { runnerMode: string; runners: unknown[] };
			candidate: { runnerMode: string; runners: unknown[] };
		};
		expect(result.baseline.runnerMode).toBe("in-process");
		expect(result.baseline.runners).toHaveLength(0);
		expect(result.candidate.runnerMode).toBe("process");
		expect(result.candidate.runners).toHaveLength(1);
	});

	it.each([
		"enqueue",
		"forward",
	] as const)("fails when median batch p99 regresses by more than 2ms for %s", (metric) => {
		const candidate = {
			enqueue: [10, 10, 10, 10, 10],
			forward: [1, 1, 1, 1, 1],
		};
		candidate[metric] =
			metric === "enqueue" ? [13, 13, 13, 13, 13] : [4, 4, 4, 4, 4];
		const { child } = compare(candidate);
		expect(child.status, child.stderr).toBe(1);
		expect(child.stdout).toContain(
			`FAIL ${metric === "enqueue" ? "send-to-provider-enqueue" : "projection-forward"}`,
		);
		expect(child.stdout).toContain("p99 delta=3.000ms");
	});

	it("allows a median batch p99 regression of exactly 2ms", () => {
		const { child } = compare({
			enqueue: [12, 12, 12, 12, 12],
			forward: [3, 3, 3, 3, 3],
		});
		expect(child.status, child.stderr).toBe(0);
	});

	it("rejects a repeated regression despite an isolated inflated baseline batch", () => {
		const { child } = compare(
			{ enqueue: [13, 13, 13, 13, 13], forward: [1, 1, 1, 1, 1] },
			{ enqueue: [30, 10, 10, 10, 10], forward: [1, 1, 1, 1, 1] },
		);
		expect(child.status, child.stderr).toBe(1);
		expect(child.stdout).toContain("p99 delta=3.000ms");
	});

	it("sends no warmup prompt when the candidate fails fake activation", () => {
		const { child, trace } = compare(
			{ enqueue: [10, 10, 10, 10, 10], forward: [1, 1, 1, 1, 1] },
			undefined,
			true,
		);
		expect(child.status, child.stderr).toBe(1);
		expect(child.stderr).toContain(
			"Fake Claude SDK activation was not acknowledged",
		);
		expect(existsSync(`${trace}.prompts`)).toBe(false);
	});
});
