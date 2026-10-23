import { channel } from "node:diagnostics_channel";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { makeSubprocessLive } from "../../../src/lib/domain/daemon/Layers/subprocess-layer.js";
import {
	Subprocess,
	type SubprocessDiagnostic,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";
import {
	type DaemonBudgetMeasurement,
	recordDaemonBudgetMetrics,
} from "../../helpers/daemon-budget-metrics.js";

it("reports each real spawn at its start and keeps metrics snapshots compatible", async () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-subprocess-budget-"));
	const runtime = ManagedRuntime.make(makeSubprocessLive({ concurrency: 1 }));
	const diagnostics: SubprocessDiagnostic[] = [];
	const metrics = channel("conduit:subprocess-metrics");
	const collect = (message: unknown) =>
		diagnostics.push(message as SubprocessDiagnostic);
	metrics.subscribe(collect);
	try {
		const owner = await runtime.runPromise(Subprocess);
		const options = { cwd: directory, timeoutMs: 3_000 };
		await runtime.runPromise(owner.run("git", ["init", "--quiet"], options));
		await Promise.all(
			Array.from({ length: 5 }, () =>
				runtime.runPromise(
					owner.run("git", ["status", "--porcelain"], {
						...options,
						key: "status",
					}),
				),
			),
		);
		const starts = diagnostics.filter(({ spawn }) => spawn !== undefined);
		expect(starts.map(({ spawn }) => spawn)).toEqual([
			{ command: "git", args: ["init", "--quiet"], cwd: directory },
			{ command: "git", args: ["status", "--porcelain"], cwd: directory },
		]);
		expect(
			starts.map(({ spawnCount, active }) => ({ spawnCount, active })),
		).toEqual([
			{ spawnCount: 1, active: 1 },
			{ spawnCount: 2, active: 1 },
		]);
		expect(diagnostics.at(-1)).toEqual(await runtime.runPromise(owner.metrics));
	} finally {
		metrics.unsubscribe(collect);
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("collects phase git reads once from owner diagnostics without fixture processes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-budget-collector-"));
	const runtime = ManagedRuntime.make(makeSubprocessLive());
	writeFileSync(
		join(directory, "request.json"),
		JSON.stringify({ id: 0, action: "begin" }),
	);
	const stop = recordDaemonBudgetMetrics(directory);
	const request = async (id: number, action: "begin" | "end") => {
		writeFileSync(
			join(directory, "request.json"),
			JSON.stringify({ id, action }),
		);
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			const measurement: DaemonBudgetMeasurement = JSON.parse(
				readFileSync(join(directory, "response.json"), "utf8"),
			);
			if (measurement.id === id) return measurement;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Missing budget phase ${id}`);
	};
	try {
		const owner = await runtime.runPromise(Subprocess);
		const options = { cwd: directory, timeoutMs: 3_000 };
		await runtime.runPromise(owner.run("git", ["init", "--quiet"], options));
		await request(1, "begin");
		await runtime.runPromise(
			owner.run("git", ["status", "--porcelain"], options),
		);
		const measurement = await request(2, "end");
		expect(measurement.spawns).toEqual([
			expect.objectContaining({
				command: "git",
				args: ["status", "--porcelain"],
				cwd: directory,
			}),
		]);
		expect(measurement.loopDelayMs.samples).toBeGreaterThan(0);
		await request(3, "begin");
		expect((await request(4, "end")).spawns).toEqual([]);
	} finally {
		stop();
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
