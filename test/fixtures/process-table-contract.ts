import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
	makeDarwinProcessAdapter,
	makeLinuxProcessAdapter,
	makeMemoryProcessAdapter,
	makeProcessTable,
	makeProductionProcessTable,
	makePsProcessAdapter,
	type Observed,
	ProcessStart,
	sameProcess,
} from "../../src/lib/provider/runner/process-table.js";

const warnings: string[] = [];
const psCalls: unknown[] = [];
let measuring = false;
const onSpawn = (message: unknown) => {
	if (!measuring || !message || typeof message !== "object") return;
	if (!("process" in message)) return;
	const child = message.process;
	if (child && typeof child === "object" && "spawnargs" in child)
		psCalls.push(child.spawnargs);
};
subscribe("tracing:child_process.spawn:start", onSpawn);
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = new Proxy(originalExecFileSync, {
	apply(target, receiver, args) {
		if (measuring) psCalls.push(args[0]);
		return Reflect.apply(target, receiver, args);
	},
});
syncBuiltinESMExports();
measuring = true;
const table = makeProductionProcessTable((message) => warnings.push(message));
measuring = false;
let worstIdentifyMs = 0;
let worstGroupMs = 0;
let worstObserveMs = 0;
const signalCases: unknown[] = [];
let identifyCalls = 0;
const identify = table.identify.bind(table);
table.identify = (pids) => {
	const begin = performance.now();
	const previous = measuring;
	measuring = true;
	try {
		return identify(pids);
	} finally {
		measuring = previous;
		worstIdentifyMs = Math.max(worstIdentifyMs, performance.now() - begin);
		identifyCalls++;
	}
};
const ps = makeProcessTable(makePsProcessAdapter());
const native =
	process.platform === "linux" ||
	(process.platform === "darwin" &&
		!process.execArgv.includes("--no-experimental-ffi"));
assert.equal(warnings.length, process.platform === "darwin" && !native ? 1 : 0);
if (warnings.length) assert.match(warnings[0] ?? "", /ffi.*disabled/i);

// Compare synthetic tick fractions to a real procps start in the same second.
const roundingSamples: unknown[] = [];
if (process.platform === "linux") {
	const root = mkdtempSync(join(tmpdir(), "conduit-procps-rounding-"));
	try {
		mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
		mkdirSync(join(root, String(process.pid)));
		writeFileSync(
			join(root, "sys/kernel/random/boot_id"),
			readFileSync("/proc/sys/kernel/random/boot_id"),
		);
		writeFileSync(join(root, "stat"), readFileSync("/proc/stat"));
		const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		const fields = stat
			.slice(end + 2)
			.trim()
			.split(/\s+/);
		const ticks = BigInt(fields[19] ?? "");
		const expected = execFileSync(
			"ps",
			["-o", "lstart=", "-p", String(process.pid)],
			{ encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
		).trim();
		const roundingTable = makeProcessTable(makeLinuxProcessAdapter(root));
		for (const fraction of [0n, 49n, 50n, 99n]) {
			fields[19] = String((ticks / 100n) * 100n + fraction);
			writeFileSync(
				join(root, String(process.pid), "stat"),
				`${stat.slice(0, end + 1)} ${fields.join(" ")}\n`,
			);
			const seen = roundingTable.identify([process.pid]).get(process.pid);
			assert.ok(seen && "startTime" in seen);
			assert.equal(seen.startTime, expected);
			roundingSamples.push({
				ticks: fields[19],
				expected,
				actual: seen.startTime,
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const start = Schema.decodeUnknownSync(ProcessStart)({
	startTime: "Mon Nov 17 14:03:22 2026",
	startKey: "d:123.456",
});
const facts = new Map<number, Observed>([
	[10, { state: "running", ...start }],
	[11, { state: "zombie", ...start }],
	[12, { state: "unknown" }], // EPERM cannot be produced reliably in CI.
]);
const memory = makeProcessTable(makeMemoryProcessAdapter({ processes: facts }));
assert.equal(
	sameProcess({ pid: 10, ...start }, memory.identify([10]).get(10)),
	"same",
);
facts.set(10, { state: "running", ...start, startKey: "d:999.1" });
assert.equal(
	sameProcess({ pid: 10, ...start }, memory.identify([10]).get(10)),
	"gone",
);
assert.equal(
	sameProcess({ pid: 11, ...start }, memory.identify([11]).get(11)),
	"gone",
);
assert.equal(
	sameProcess({ pid: 12, ...start }, memory.identify([12]).get(12)),
	"unknown",
);
assert.equal(
	sameProcess({ pid: 13, ...start }, memory.identify([13]).get(13)),
	"gone",
);
assert.equal(
	sameProcess(
		{ pid: 10, ...start, startKey: "l:future:1" },
		memory.identify([10]).get(10),
	),
	"same",
);
assert.equal(
	sameProcess(
		{ pid: 10, startTime: "different start" },
		memory.identify([10]).get(10),
	),
	"gone",
);
assert.equal(
	sameProcess(
		{ pid: 10, startTime: start.startTime },
		memory.identify([10]).get(10),
	),
	"same",
);
assert.equal(
	sameProcess({ pid: 10 }, memory.identify([10]).get(10)),
	"unknown",
);
assert.equal(sameProcess({ pid: 10, ...start }, undefined), "unknown");
const unreadable = makeProcessTable({
	read: () => {
		throw new Error("EPERM");
	},
	argv: () => {
		throw new Error("EPERM");
	},
	group: () => Effect.succeed(undefined),
	signal: () => {},
});
assert.deepEqual(
	[...unreadable.identify([1]).values()],
	[{ state: "unknown" }],
);
assert.equal(unreadable.argv(1), undefined);

const group = spawn(
	"python3",
	[
		fileURLToPath(new URL("./process-table-group.py", import.meta.url)),
		"argument with spaces",
	],
	{
		detached: true,
		stdio: ["pipe", "pipe", "inherit"],
	},
);
let pids: Record<string, number> = {};
const samples: unknown[] = [];
let failure: unknown;
const cleanup: { pid: number; signal: string }[] = [];
try {
	const [output] = await once(group.stdout, "data");
	pids = JSON.parse(String(output));
	const targets = Object.values(pids);
	const pgid = pids["leader"];
	const child = pids["ignoresTerm"];
	assert.ok(pgid && child);
	const begin = performance.now();
	measuring = true;
	const observed = await Effect.runPromise(
		table.observe({ pgid, pids: targets }),
	);
	measuring = false;
	worstObserveMs = performance.now() - begin;
	const groupAdapter =
		process.platform === "linux"
			? makeLinuxProcessAdapter()
			: native
				? makeDarwinProcessAdapter()
				: makePsProcessAdapter();
	// Warm Effect's execution boundary before timing the native group query.
	await Effect.runPromise(groupAdapter.group(pgid));
	for (let i = 0; i < 100; i++) {
		const started = performance.now();
		measuring = true;
		if (native && process.platform === "darwin")
			Effect.runSync(groupAdapter.group(pgid));
		else await Effect.runPromise(groupAdapter.group(pgid));
		measuring = false;
		worstGroupMs = Math.max(worstGroupMs, performance.now() - started);
	}
	if (native && process.platform === "darwin")
		assert.ok(worstGroupMs < 1, `group worst ${worstGroupMs}ms`);
	const wrongStart = Schema.decodeUnknownSync(ProcessStart)({
		startTime: "Mon Jan  1 00:00:00 1900",
	});
	for (const target of [
		{ process: { pid: child, ...wrongStart } },
		{ group: pgid, pins: [{ pid: pgid, ...wrongStart }] },
	]) {
		const outcome = table.signal(target, "SIGKILL");
		assert.equal(outcome, "stale");
		assert.equal(table.identify([child]).get(child)?.state, "running");
		signalCases.push({ target, outcome });
	}
	// Read ps independently of the adapter, including zombie state.
	const oracle = () =>
		execFileSync("ps", ["-axo", "pid=,pgid=,stat=,lstart="], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			timeout: 1000,
		})
			.split("\n")
			.flatMap((line) => {
				const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
				return match && targets.includes(Number(match[1]))
					? [
							{
								pid: Number(match[1]),
								pgid: Number(match[2]),
								state: match[3]?.startsWith("Z") ? "zombie" : "running",
								startTime: match[4],
							},
						]
					: [];
			});
	const expected = oracle();
	assert.deepEqual(
		observed.group?.map((member) => member.pid).sort((a, b) => a - b),
		expected
			.filter((row) => row.pgid === pgid)
			.map((row) => row.pid)
			.sort((a, b) => a - b),
	);
	assert.equal(observed.processes.get(pids["zombie"] ?? 0)?.state, "zombie");
	assert.equal(expected.length, 4);
	assert.equal(
		expected.find((row) => row.pid === pids["zombie"])?.state,
		"zombie",
	);
	assert.equal(
		expected.find((row) => row.pid === pids["ignoresTerm"])?.pgid,
		pids["leader"],
	);
	assert.equal(
		expected.find((row) => row.pid === pids["escapee"])?.pgid,
		pids["escapee"],
	);
	const initial = table.identify(targets);
	for (const row of expected) {
		const seen = initial.get(row.pid);
		assert.equal(seen?.state, row.state);
		assert.ok(seen && "startTime" in seen);
		assert.equal(seen.pgid, row.pgid);
		assert.equal(seen.startTime, row.startTime);
		if (native)
			assert.match(
				seen.startKey ?? "",
				process.platform === "linux" ? /^l:[\da-f-]+:\d+$/ : /^d:\d+\.\d+$/,
			);
		else assert.equal(seen.startKey, undefined);
	}
	const originalTZ = process.env["TZ"];
	try {
		for (const tz of [
			originalTZ,
			"UTC",
			"Australia/Sydney",
			"America/St_Johns",
		]) {
			if (tz === undefined) delete process.env["TZ"];
			else process.env["TZ"] = tz;
			for (const row of oracle()) {
				const seen = table.identify([row.pid]).get(row.pid);
				assert.ok(seen && "startTime" in seen);
				assert.equal(seen.startTime, row.startTime);
				const before = initial.get(row.pid);
				assert.ok(before && "startTime" in before);
				assert.equal(seen.startKey, before.startKey);
				samples.push({ tz: tz ?? "local", pid: row.pid, ...seen });
			}
		}
	} finally {
		if (originalTZ === undefined) delete process.env["TZ"];
		else process.env["TZ"] = originalTZ;
	}
	for (const pid of [pids["leader"], pids["ignoresTerm"], pids["escapee"]]) {
		assert.ok(pid);
		measuring = true;
		const args = table.argv(pid);
		measuring = false;
		assert.ok(args);
		const command = execFileSync(
			"ps",
			["-ww", "-o", "command=", "-p", String(pid)],
			{ encoding: "utf8" },
		).trim();
		assert.equal(args.join(" "), command);
		if (native)
			assert.deepEqual(args.slice(1), [
				fileURLToPath(new URL("./process-table-group.py", import.meta.url)),
				"argument with spaces",
			]);
		assert.equal(ps.argv(pid)?.join(" "), command);
	}
	const childStart = initial.get(child);
	assert.ok(childStart && "startTime" in childStart);
	assert.equal(
		table.signal({ process: { pid: child, ...childStart } }, "SIGTERM"),
		"delivered",
	);
	assert.equal(table.identify([child]).get(child)?.state, "running");
	const exited = once(group, "exit");
	group.stdin.end("exit\n");
	await exited;
	assert.equal(table.identify([child]).get(child)?.state, "running");
	assert.equal(
		table.identify([pids["leader"] ?? 0]).get(pids["leader"] ?? 0)?.state,
		"gone",
	);
	const orphan = table.identify([child]).get(child);
	assert.ok(orphan && "pgid" in orphan);
	assert.equal(orphan.pgid, pids["leader"]);
	for (let i = 0; i < 100; i++) {
		table.identify([child]);
	}
	const killOutcome = table.signal(
		{ process: { pid: child, ...childStart } },
		"SIGKILL",
	);
	assert.equal(killOutcome, "delivered");
	signalCases.push({ target: child, outcome: killOutcome });
	const escapee = pids["escapee"];
	const escapeStart = initial.get(escapee ?? 0);
	assert.ok(escapee && escapeStart && "startTime" in escapeStart);
	const closed = once(group.stdout, "end");
	assert.equal(
		table.signal({ process: { pid: escapee, ...escapeStart } }, "SIGKILL"),
		"delivered",
	);
	await closed;
	assert.equal(
		sameProcess(
			{ pid: child, ...childStart },
			table.identify([child]).get(child),
		),
		"gone",
	);
	assert.equal(table.argv(2147483647), undefined);
	assert.equal(table.identify([2147483647]).get(2147483647)?.state, "gone");
	assert.deepEqual(
		[...table.identify([-1, 0, NaN, 1.5]).values()],
		Array(4).fill({ state: "unknown" }),
	);
	assert.equal(table.argv(-1), undefined);
	if (native)
		assert.ok(worstIdentifyMs < 1, `identify worst ${worstIdentifyMs}ms`);
	if (process.platform === "linux")
		assert.deepEqual(psCalls, [], "Linux process reads must not spawn ps");
} catch (error) {
	failure = error;
} finally {
	for (const pid of Object.values(pids)) {
		try {
			process.kill(pid, "SIGKILL");
			cleanup.push({ pid, signal: "delivered" });
		} catch (error) {
			cleanup.push({
				pid,
				signal: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (group.exitCode === null && group.signalCode === null) {
		const exited = once(group, "exit");
		group.kill("SIGKILL");
		await exited;
	}
}
process.emitWarning("unrelated warning", "ExperimentalWarning");
unsubscribe("tracing:child_process.spawn:start", onSpawn);
childProcess.execFileSync = originalExecFileSync;
syncBuiltinESMExports();
process.emitWarning(
	"FFI is an experimental feature and might change at any time",
	"Warning",
);
await new Promise((resolve) => setImmediate(resolve));
console.log(
	JSON.stringify({
		native,
		node: process.version,
		warnings,
		worstIdentifyMs,
		worstGroupMs,
		worstObserveMs,
		signalCases,
		identifyCalls,
		psCalls,
		roundingSamples,
		pids,
		samples,
		identityCases: 10,
		cleanup,
		error: failure instanceof Error ? failure.message : failure,
	}),
);
if (failure) throw failure;
