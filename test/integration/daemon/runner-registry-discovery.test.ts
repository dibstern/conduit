import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeMemoryProcessAdapter,
	makeProcessTable,
	makeProductionProcessTable,
	type Observed,
	ProcessStart,
} from "../../../src/lib/provider/runner/process-table.js";
import {
	discoverAllRunners,
	prepareRunnerDirectory,
	type RunnerRegistration,
	registerRunner,
	runnerPidMatchesRegistration,
} from "../../../src/lib/provider/runner/runner-registry.js";

// Failure modes: a retained long-path directory loses its temporary alias, or
// that alias points outside its owner and discovery reads or removes other files.
describe("daemon runner discovery", () => {
	let root: string;
	let configDir: string;
	let socketDirectory: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-runner-discovery-"));
		configDir = join(root, "private", "c".repeat(120));
		socketDirectory = prepareRunnerDirectory(
			join(root, "retained-project"),
			configDir,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(socketDirectory, { force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("restores a missing alias and discovers retained registrations without a project", () => {
		const target = readlinkSync(socketDirectory);
		const registration = {
			driverKind: "claude",
			runnerId: "0123456789ab",
			sessionId: "retained-session",
			socketPath: join(socketDirectory, "0123456789ab"),
			buildId: "retained-build",
			pid: process.pid,
		} satisfies RunnerRegistration;
		const registeredAt = 1_792_699_200_000;
		const startTime = "Fri Oct 23 12:00:00 2026";
		const table = makeProcessTable(
			makeMemoryProcessAdapter({
				processes: new Map([
					[
						process.pid,
						{
							state: "running",
							...Schema.decodeUnknownSync(ProcessStart)({ startTime }),
						},
					],
				]),
			}),
		);
		vi.spyOn(Date, "now").mockReturnValue(registeredAt);
		registerRunner(registration, table);
		writeFileSync(`${registration.socketPath}.spool`, "retained output");
		rmSync(socketDirectory);
		expect(existsSync(socketDirectory)).toBe(false);

		expect(discoverAllRunners(configDir, table)).toEqual([
			{ ...registration, registeredAt, startTime },
		]);
		expect(readlinkSync(socketDirectory)).toBe(target);
		expect(readFileSync(`${registration.socketPath}.spool`, "utf8")).toBe(
			"retained output",
		);
	});

	it("refuses a substituted alias without reading or removing its files", () => {
		const otherDirectory = join(root, "other-owner");
		mkdirSync(otherDirectory);
		const otherFile = join(otherDirectory, "abcdef012345.json");
		writeFileSync(otherFile, "other owner's data");
		rmSync(socketDirectory);
		symlinkSync(otherDirectory, socketDirectory);

		expect(() => discoverAllRunners(configDir)).toThrow(
			"Unsafe runner socket alias",
		);
		expect(readFileSync(otherFile, "utf8")).toBe("other owner's data");
	});

	it("discovers host registration without taking authority from a legacy sidecar", () => {
		const registration = {
			driverKind: "claude",
			runnerId: "0123456789ab",
			sessionId: "live-session",
			socketPath: join(socketDirectory, "0123456789ab"),
			buildId: "live-build",
			pid: process.pid,
			registeredAt: 1_792_699_200_000,
			startTime: "Fri Oct 23 12:00:00 2026",
		} satisfies RunnerRegistration;
		registerRunner(registration);
		// SQL owns retirement. Old files cannot replace a host's registration.
		writeFileSync(
			`${registration.socketPath}.retired`,
			JSON.stringify({ ...registration, role: "retired", sessionId: "stale" }),
		);

		const table = makeProcessTable(
			makeMemoryProcessAdapter({
				processes: new Map([
					[
						process.pid,
						{
							state: "running",
							...Schema.decodeUnknownSync(ProcessStart)({
								startTime: registration.startTime,
							}),
						},
					],
				]),
			}),
		);
		expect(discoverAllRunners(configDir, table)).toEqual([registration]);
	});

	// PID reuse and unreadable kernel rows cannot be arranged reliably with real processes.
	it("identifies all directories in one read and keeps unknown registrations without pruning", () => {
		const start = Schema.decodeUnknownSync(ProcessStart)({
			startTime: "Fri Oct 23 12:00:00 2026",
			startKey: "d:123.1",
		});
		const processes = new Map<number, Observed>([
			[10, { state: "running", ...start }],
			[11, { state: "running", ...start, startKey: "d:124.1" }],
			[12, { state: "zombie", ...start }],
			[13, { state: "unknown" }],
			[14, { state: "gone" }],
		]);
		const adapter = makeMemoryProcessAdapter({ processes });
		const read = vi.spyOn(adapter, "read");
		const table = makeProcessTable(adapter);
		const other = prepareRunnerDirectory(
			join(root, "second-project"),
			configDir,
		);
		try {
			const entries = [...processes.keys()].map((pid, i) => ({
				runnerId: `00000000000${i}`,
				sessionId: `session-${i}`,
				buildId: "test",
				pid,
				socketPath: join(i % 2 ? other : socketDirectory, `00000000000${i}`),
				...start,
			}));
			for (const entry of entries) registerRunner(entry, table);
			read.mockClear();
			expect(
				discoverAllRunners(configDir, table)
					.map((entry) => entry.pid)
					.sort(),
			).toEqual([10, 13]);
			expect(read).toHaveBeenCalledTimes(1);
			expect(new Set(read.mock.calls[0]?.[0])).toEqual(
				new Set(processes.keys()),
			);
			for (const entry of entries)
				expect(existsSync(`${entry.socketPath}.json`)).toBe(true);
		} finally {
			rmSync(other, { force: true });
		}
	});

	it("matches spaced argv tokens, flattened or not, and rejects prefix and suffix paths", () => {
		const registration = {
			runnerId: "0123456789ab",
			sessionId: "session",
			socketPath: "/tmp/runner with spaces/0123456789ab",
			buildId: "test",
			pid: 10,
		};
		const argv = new Map<number, readonly string[]>([
			[
				10,
				[
					"node",
					"runner host.js",
					registration.socketPath,
					registration.sessionId,
					registration.runnerId,
				],
			],
		]);
		const table = makeProcessTable(
			makeMemoryProcessAdapter({ processes: new Map(), argv }),
		);
		expect(runnerPidMatchesRegistration(registration, table)).toBe(true);
		// The ps fallback flattens argv and splits it on whitespace.
		argv.set(10, [
			"node",
			"runner",
			"host.js",
			...registration.socketPath.split(" "),
			registration.sessionId,
			registration.runnerId,
		]);
		expect(runnerPidMatchesRegistration(registration, table)).toBe(true);
		for (const path of [
			`${registration.socketPath}.spool`,
			`prefix${registration.socketPath}`,
		]) {
			argv.set(10, ["node", "runner host.js", path, registration.runnerId]);
			expect(runnerPidMatchesRegistration(registration, table)).toBe(false);
		}
		argv.delete(10);
		expect(runnerPidMatchesRegistration(registration, table)).toBe(false);
	});

	it("takes a complete start identity from one source when registering again", () => {
		const old = Schema.decodeUnknownSync(ProcessStart)({
			startTime: "Fri Oct 23 12:00:00 2026",
			startKey: "d:123.1",
		});
		const fresh = Schema.decodeUnknownSync(ProcessStart)({
			startTime: "Tue Nov 17 12:00:00 2026",
			startKey: "d:456.1",
		});
		const table = makeProcessTable(
			makeMemoryProcessAdapter({
				processes: new Map([[10, { state: "running", ...fresh }]]),
			}),
		);
		const entry = {
			runnerId: "0123456789ab",
			sessionId: "session",
			socketPath: join(socketDirectory, "0123456789ab"),
			buildId: "test",
			pid: 10,
		};
		registerRunner(entry, table);
		expect(
			JSON.parse(readFileSync(`${entry.socketPath}.json`, "utf8")),
		).toMatchObject(fresh);
		registerRunner({ ...entry, ...old }, table);
		registerRunner(entry, table);
		expect(
			JSON.parse(readFileSync(`${entry.socketPath}.json`, "utf8")),
		).toMatchObject(old);
		registerRunner({ ...entry, startTime: fresh.startTime }, table);
		const legacy = JSON.parse(readFileSync(`${entry.socketPath}.json`, "utf8"));
		expect(legacy.startTime).toBe(fresh.startTime);
		expect(legacy.startKey).toBeUndefined();
		expect(readFileSync(`${entry.socketPath}.evidence.json`, "utf8")).toBe(
			readFileSync(`${entry.socketPath}.json`, "utf8"),
		);
	});

	it("discovers real live and legacy processes, drops zombies and matches spaced argv", async () => {
		const runnerId = "0123456789ab";
		const socketPath = join(root, "runner with spaces", runnerId);
		const child = spawn(
			"python3",
			[
				fileURLToPath(
					new URL("../../fixtures/process-table-group.py", import.meta.url),
				),
				socketPath,
				runnerId,
			],
			{ detached: true, stdio: ["pipe", "pipe", "inherit"] },
		);
		let pids: Record<string, number> = {};
		const report: Record<string, unknown> = {};
		try {
			const [data] = await once(child.stdout, "data");
			pids = JSON.parse(String(data));
			const table = makeProductionProcessTable();
			const entries = ["leader", "zombie", "escapee"].map((role, i) => {
				const pid = pids[role];
				assert.ok(pid);
				const seen = table.identify([pid]).get(pid);
				assert.ok(seen && "startTime" in seen, `unreadable fixture ${role}`);
				return {
					runnerId: `00000000000${i}`,
					sessionId: role,
					buildId: "test",
					pid,
					startTime: seen.startTime,
					...(i === 0 ? {} : { startKey: seen.startKey }),
					socketPath: join(socketDirectory, `00000000000${i}`),
				};
			});
			for (const entry of entries) registerRunner(entry, table);
			const found = discoverAllRunners(configDir, table);
			report["discovered"] = found;
			expect(found.map((entry) => entry.sessionId).sort()).toEqual([
				"escapee",
				"leader",
			]);
			assert.ok(child.pid);
			const registration = {
				runnerId,
				socketPath,
				sessionId: "leader",
				buildId: "test",
				pid: child.pid,
			};
			expect(runnerPidMatchesRegistration(registration, table)).toBe(true);
			for (const path of [
				socketPath.slice(0, -1),
				socketPath.slice(1),
				`${socketPath}.spool`,
			]) {
				expect(
					runnerPidMatchesRegistration(
						{ ...registration, socketPath: path },
						table,
					),
				).toBe(false);
			}
			report["argv"] = table.argv(child.pid);
		} finally {
			for (const pid of Object.values(pids)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/runner-discovery.json",
				JSON.stringify({ ...report, pids }, null, 2),
			);
		}
	});
});
