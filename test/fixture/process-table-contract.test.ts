import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Effect, Exit, Layer, Scheduler, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import {
	makeMemoryProcessAdapter,
	makeProcessTable,
	type Observed,
	ProcessStart,
} from "../../src/lib/provider/runner/process-table.js";

const exec = promisify(execFile);
const reports: Record<string, unknown> = {};
afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		`test-results/process-table-contract.${process.platform}-${process.arch}.json`,
		JSON.stringify(reports, null, 2),
	);
});

it("observe skips unpinned groups and rejects a pin reused during the listing", async () => {
	const start = Schema.decodeUnknownSync(ProcessStart)({
		startTime: "recorded",
	});
	const processes = new Map<number, Observed>([
		[10, { state: "running", pgid: 20, ...start }],
	]);
	const adapter = makeMemoryProcessAdapter({
		processes,
		group: () =>
			Effect.sync(() => {
				processes.set(10, {
					state: "running",
					pgid: 10,
					...start,
					startTime: Schema.decodeUnknownSync(ProcessStart)({
						startTime: "reused",
					}).startTime,
				});
				return new Map([
					[10, { state: "running" as const, pgid: 10, ...start }],
				]);
			}),
	});
	const table = makeProcessTable(adapter);
	expect(
		(await Effect.runPromise(table.observe({ pgid: 10, pids: [10] }))).group,
	).toBeUndefined();
	expect(adapter.calls.groups).toEqual([]);
	processes.set(10, { state: "running", pgid: 10, ...start });
	expect(
		(await Effect.runPromise(table.observe({ pgid: 10, pids: [10] }))).group,
	).toBeUndefined();
	expect(adapter.calls.groups).toEqual([10]);
});

it("observe keeps unreadable membership unknown and signal rechecks before delivery", async () => {
	const start = Schema.decodeUnknownSync(ProcessStart)({
		startTime: "recorded",
	});
	const processes = new Map<number, Observed>([
		[10, { state: "running", pgid: 10, ...start }],
		[11, { state: "unknown" }],
	]);
	const adapter = makeMemoryProcessAdapter({
		processes,
		signal: () => {
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		},
	});
	const table = makeProcessTable(adapter);
	const observation = await Effect.runPromise(
		table.observe({ pgid: 10, pids: [10, 11] }),
	);
	expect(observation.group).toBeUndefined();
	expect(observation.processes.get(11)).toEqual({ state: "unknown" });
	expect(table.signal({ process: { pid: 10, ...start } }, "SIGTERM")).toBe(
		"refused",
	);
	processes.set(10, { state: "unknown" });
	expect(
		table.signal({ group: 10, pins: [{ pid: 10, ...start }] }, "SIGKILL"),
	).toBe("stale");
	expect(adapter.calls.signals).toEqual([{ target: 10, signal: "SIGTERM" }]);
});

it("observe inside a tick-atomic SQL write dies before reading the table", async () => {
	const adapter = makeMemoryProcessAdapter({ processes: new Map() });
	const table = makeProcessTable(adapter);
	const exit = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* Effect.exit(
				sql
					.withTransaction(table.observe({ pgid: 10, pids: [10] }))
					.pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
			);
		}).pipe(
			Effect.provide(
				SqliteNode.layer({ filename: ":memory:" }).pipe(
					Layer.provide(Reactivity.layer),
				),
			),
		),
	);
	expect(Exit.isFailure(exit)).toBe(true);
	if (Exit.isFailure(exit))
		expect(Cause.pretty(exit.cause)).toContain(
			"Process-table observation inside a SQL write",
		);
	expect(adapter.calls.reads).toEqual([]);
});

for (const disabled of [false, true]) {
	it(`process-table contract on real processes${disabled ? " with FFI disabled" : ""}`, async () => {
		const mode = disabled ? "fallback" : "production";
		try {
			const { stdout, stderr } = await exec(
				process.execPath,
				[
					...(disabled ? ["--no-experimental-ffi"] : []),
					"--import",
					"tsx",
					"test/fixtures/process-table-contract.ts",
				],
				{ timeout: 30_000 },
			);
			expect(stderr).toContain("ExperimentalWarning: unrelated warning");
			expect(stderr).toContain("Warning: FFI is an experimental feature");
			expect(stderr).not.toContain("ExperimentalWarning: FFI");
			reports[mode] = { outcome: "passed", report: JSON.parse(stdout) };
		} catch (error) {
			reports[mode] = {
				outcome: "failed",
				error:
					error instanceof Error ? error.message.slice(-3000) : String(error),
				stdout:
					error instanceof Error && "stdout" in error
						? error.stdout
						: undefined,
				stderr:
					error instanceof Error && "stderr" in error
						? String(error.stderr).slice(-4000)
						: undefined,
				exitCode:
					error instanceof Error && "code" in error ? error.code : undefined,
			};
			throw error;
		}
	});
}

it("importing the process table does not load FFI or warn", async () => {
	const { stderr } = await exec(process.execPath, [
		"--import",
		"tsx",
		"--input-type=module",
		"-e",
		`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => {
			if (id === 'node:ffi') throw new Error('FFI loaded at import');
			return original(id);
		};
		await import('./src/lib/provider/runner/process-table.ts');
	`,
	]);
	expect(stderr).not.toMatch(/FFI|ExperimentalWarning/);
});

it.skipIf(process.platform !== "darwin")(
	"a failed native self-check falls back once and keeps unrelated warnings",
	async () => {
		const { stdout, stderr } = await exec(process.execPath, [
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => id === 'node:ffi' ? {
			dlopen: () => {
				process.emitWarning('unrelated during load', 'ExperimentalWarning');
				throw new Error('self-check: incompatible API');
			},
		} : original(id);
		const { makeProductionProcessTable } = await import('./src/lib/provider/runner/process-table.ts');
		const warnings = [];
		const table = makeProductionProcessTable((message) => warnings.push(message));
		for (let i = 0; i < 3; i++) {
			if (table.identify([process.pid]).get(process.pid)?.state !== 'running') throw new Error('fallback failed');
		}
		console.log(JSON.stringify(warnings));
	`,
		]);
		const warnings: string[] = JSON.parse(stdout);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("incompatible API");
		expect(stderr).toContain("ExperimentalWarning: unrelated during load");
	},
);

it("CLI help never loads FFI or emits its warning", async () => {
	const { stdout, stderr } = await exec(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => {
			if (id === 'node:ffi') throw new Error('CLI loaded FFI');
			return original(id);
		};
		process.argv = [process.execPath, 'conduit', '--help'];
		await import('./src/bin/cli.ts');
	`,
		],
		{ timeout: 20_000 },
	);
	expect(stdout).toContain("conduit");
	expect(stderr).not.toMatch(/FFI|ExperimentalWarning/);
});
