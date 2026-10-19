import { subscribe } from "node:diagnostics_channel";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Fiber } from "effect";

// Event-loop stalls and read-model reads for load tests, flushed to a file the
// spec reads after each phase. Stalls are wall-clock end times and durations.
// With `profile`, also SQLite statement times, what each session-family read
// ran, and a CPU profile (below).
function recordServerMetrics(
	file: string,
	profile: boolean,
	familyWindowSql: string,
): void {
	const startedAt = Date.now();
	const stalls: { at: number; ms: number }[] = [];
	const reads: Record<string, number> = {};
	const windows = new Set<number>();
	// Per source name: reads by kind, the distinct changes its windows read, and
	// the distinct windows (`after-through`) it read.
	const sources: Record<
		string,
		{ reads: Record<string, number>; windows: Set<number>; ranges: Set<string> }
	> = {};
	const sidebarReads: { at: number; ms: number; rows: number }[] = [];
	const readModelReads: { at: number; source: string; kind: string }[] = [];
	subscribe("conduit:sidebar-read", (message) => {
		const read =
			message as import("../../src/lib/domain/relay/Services/shell-subscription.js").SidebarRead;
		sidebarReads.push({ at: Date.now(), ms: read.ms, rows: read.rows });
	});
	const gitRefreshes: { at: number; read: number; changed: number }[] = [];
	subscribe("conduit:session-git-refresh", (message) => {
		const refresh =
			message as import("../../src/lib/domain/relay/Layers/session-git-layer.js").SessionGitRefresh;
		gitRefreshes.push({ at: Date.now(), ...refresh });
	});
	subscribe("conduit:read-model-read", (message) => {
		const read =
			message as import("../../src/lib/domain/relay/Services/read-model-subscription.js").ReadModelRead;
		readModelReads.push({
			at: performance.timeOrigin + performance.now(),
			source: read.source,
			kind: read.kind,
		});
		const source = (sources[read.source] ??= {
			reads: {},
			windows: new Set(),
			ranges: new Set(),
		});
		reads[read.kind] = (reads[read.kind] ?? 0) + 1;
		source.reads[read.kind] = (source.reads[read.kind] ?? 0) + 1;
		if (
			(read.kind === "window" || read.kind === "overflow") &&
			read.range?.through !== undefined
		) {
			windows.add(read.range.through);
			source.windows.add(read.range.through);
			source.ranges.add(`${read.range.after}-${read.range.through}`);
		}
	});
	const timed = profile ? timeStatements(familyWindowSql) : undefined;
	const statements = timed?.statements;
	const profiler = profile ? cpuProfiler(file) : undefined;
	const tickMs = 10;
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const ms = Math.round(now - last - tickMs);
		if (ms >= 20) stalls.push({ at: Date.now(), ms });
		last = now;
	}, tickMs).unref();
	// Written beside the file and renamed over it: past one 8 KB write, a spec
	// polling the file would otherwise read it half written.
	setInterval(() => {
		profiler?.();
		// Appended before the flush the spec waits on, so a flush covers every
		// statement before it, and only new ones are written each time.
		if (statements?.length)
			appendFileSync(
				`${file}.statements.jsonl`,
				statements
					.splice(0)
					.map((statement) => `${JSON.stringify(statement)}\n`)
					.join(""),
			);
		writeFileSync(
			`${file}.tmp`,
			JSON.stringify({
				pid: process.pid,
				startedAt,
				flushedAt: Date.now(),
				stalls,
				reads,
				changesRead: windows.size,
				sources: Object.fromEntries(
					Object.entries(sources).map(([name, source]) => [
						name,
						{
							reads: source.reads,
							changesRead: source.windows.size,
							windowsRead: source.ranges.size,
						},
					]),
				),
				sidebarReads,
				readModelReads,
				gitRefreshes,
				...(timed && { familyReads: timed.familyReads }),
				...(timed && { streamingWrites: timed.streamingWrites }),
			}),
		);
		renameSync(`${file}.tmp`, file);
	}, 250).unref();
}

// Every SQLite statement that holds the loop 1ms or more, timed around
// node:sqlite's synchronous calls, the ones the store client makes. The
// caller drains `statements`.
//
// `familyReads` is every session-family read, whatever its statements took:
// whether its window held a changed member, and how many of its statements
// read every session row. A read is its transaction, BEGIN to COMMIT, on one
// connection; the client runs one statement at a time per connection, so no
// other caller's statement lands inside it (conduit-test-y7eo.15).
function timeStatements(familyWindowSql: string): {
	statements: { at: number; ms: number; method: string; sql: string }[];
	familyReads: { at: number; changed: boolean; fullSessionScans: number }[];
	streamingWrites: {
		messageId: string;
		chunkChars: number;
		textChars: number;
		walBytes: number;
	}[];
} {
	const streamingWrites: {
		messageId: string;
		chunkChars: number;
		textChars: number;
		walBytes: number;
	}[] = [];
	const textLengths = new Map<string, number>();
	const measured = new WeakSet<object>();
	const walSize = (database: DatabaseSync) => {
		const filename = database.location();
		if (filename === null) return 0;
		const file = `${filename}-wal`;
		return existsSync(file) ? statSync(file).size : 0;
	};
	const statements: { at: number; ms: number; method: string; sql: string }[] =
		[];
	const familyReads: {
		at: number;
		changed: boolean;
		fullSessionScans: number;
	}[] = [];
	const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
	const familyWindow = normalize(familyWindowSql);
	const transactions = new WeakMap<
		object,
		{
			changed?: boolean;
			fullSessionScans: number;
			walBefore: number;
			deltas: { messageId: string; chars: number }[];
		}
	>();
	const databases = new WeakMap<StatementSync, DatabaseSync>();
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (sql, options) {
		const statement = prepare.call(this, sql, options);
		databases.set(statement, this);
		return statement;
	};
	const prototype = StatementSync.prototype;
	for (const method of ["all", "get", "run"] as const) {
		const original = prototype[method];
		Object.defineProperty(prototype, method, {
			value: function (this: StatementSync, ...params: unknown[]) {
				const database = databases.get(this);
				if (!database) return Reflect.apply(original, this, params);
				if (!measured.has(database)) {
					measured.add(database);
					// This hook only runs in an isolated profiling harness. File growth
					// measures committed WAL frames only when automatic checkpoints are off.
					database.exec("PRAGMA wal_autocheckpoint = 0");
				}
				const started = performance.now();
				let result: unknown;
				try {
					result = Reflect.apply(original, this, params);
					return result;
				} finally {
					const ms = performance.now() - started;
					const sql = normalize(this.sourceSQL);
					if (ms >= 1)
						statements.push({
							at: Date.now(),
							ms: Math.round(ms * 100) / 100,
							method,
							sql: sql.slice(0, 160),
						});
					if (
						/^BEGIN(?: (?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?: TRANSACTION)?$/i.test(
							sql,
						)
					)
						transactions.set(database, {
							fullSessionScans: 0,
							walBefore: walSize(database),
							deltas: [],
						});
					const open = transactions.get(database);
					if (
						open &&
						/INSERT(?: OR IGNORE)? INTO events/i.test(sql) &&
						Array.isArray(result)
					) {
						for (const row of result) {
							if (
								row === null ||
								typeof row !== "object" ||
								!("type" in row) ||
								row.type !== "text.delta" ||
								!("data" in row) ||
								typeof row.data !== "string"
							)
								continue;
							const data: unknown = JSON.parse(row.data);
							if (
								data !== null &&
								typeof data === "object" &&
								"messageId" in data &&
								typeof data.messageId === "string" &&
								"text" in data &&
								typeof data.text === "string"
							)
								open.deltas.push({
									messageId: data.messageId,
									chars: data.text.length,
								});
						}
					}
					if (open && sql === familyWindow)
						open.changed = Array.isArray(result) && result.length > 0;
					else if (open && /^SELECT [^;]* FROM sessions$/i.test(sql))
						open.fullSessionScans += 1;
					else if (open && (sql === "COMMIT" || sql === "ROLLBACK")) {
						transactions.delete(database);
						const firstDelta = open.deltas[0];
						if (sql === "COMMIT" && firstDelta) {
							const chunkChars = open.deltas.reduce(
								(sum, delta) => sum + delta.chars,
								0,
							);
							let textChars = 0;
							for (const delta of open.deltas) {
								textChars =
									(textLengths.get(delta.messageId) ?? 0) + delta.chars;
								textLengths.set(delta.messageId, textChars);
							}
							streamingWrites.push({
								messageId: firstDelta.messageId,
								chunkChars,
								textChars,
								walBytes: walSize(database) - open.walBefore,
							});
						}
						if (open.changed !== undefined)
							familyReads.push({
								at: Date.now(),
								changed: open.changed,
								fullSessionScans: open.fullSessionScans,
							});
					}
				}
			},
		});
	}
	return { statements, familyReads, streamingWrites };
}

// A CPU profile from `<file>.start` to `<file>.stop`, both written by the spec
// and checked on each call. `<file>.started` says sampling has begun, and
// `stoppedAt` lets the spec place samples on the wall clock.
function cpuProfiler(file: string): () => void {
	const session = new Session();
	session.connect();
	let state: "waiting" | "profiling" | "stopped" = "waiting";
	const fail = (error: unknown) => console.error("CPU profile failed", error);
	return () => {
		if (state === "waiting" && existsSync(`${file}.start`)) {
			state = "profiling";
			session
				.post("Profiler.enable")
				.then(() => session.post("Profiler.start"))
				.then(() => writeFileSync(`${file}.started`, ""))
				.catch(fail);
		} else if (state === "profiling" && existsSync(`${file}.stop`)) {
			state = "stopped";
			const stoppedAt = Date.now();
			session
				.post("Profiler.stop")
				.then(({ profile }) => {
					writeFileSync(
						`${file}.cpuprofile.tmp`,
						JSON.stringify({ stoppedAt, profile }),
					);
					renameSync(`${file}.cpuprofile.tmp`, `${file}.cpuprofile`);
				})
				.catch(fail);
		}
	};
}

async function main(): Promise<void> {
	const root = process.argv[2];
	const dist = process.argv[3];
	if (!root || !process.send || process.env["HOME"] !== join(root, "home")) {
		throw new Error(
			"Process harness requires an isolated HOME and IPC channel",
		);
	}
	let daemon:
		| import("../../src/lib/domain/daemon/Layers/daemon-foreground.js").ForegroundDaemonHandle
		| undefined;
	let disconnected = false;
	// The parent cannot enforce its kill deadline after it disappears. Keep a
	// local deadline, including disconnects during daemon startup.
	process.once("disconnect", () => {
		disconnected = true;
		// Allow the runner's 1s reply window and 3s force-kill budget to finish.
		setTimeout(() => process.exit(1), 6000);
		void daemon?.stop().catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
	});
	if (!process.connected) process.exit(1);
	const codeRoot = dist
		? join(dist, "src")
		: fileURLToPath(new URL("../../src", import.meta.url));
	const extension = dist ? "js" : "ts";
	if (existsSync(join(root, "claude-end-session-failure-fixture"))) {
		const { OrchestrationEngine } = (await import(
			pathToFileURL(
				join(codeRoot, "lib/provider", `orchestration-engine.${extension}`),
			).href
		)) as typeof import("../../src/lib/provider/orchestration-engine.js");
		const dispatch = OrchestrationEngine.prototype.dispatchEffect;
		Object.assign(OrchestrationEngine.prototype, {
			dispatchEffect(
				this: InstanceType<typeof OrchestrationEngine>,
				command: import("../../src/lib/provider/orchestration-engine.js").OrchestrationCommand,
			) {
				return Effect.suspend(() => {
					if (command.type === "end_session")
						appendFileSync(
							join(root, "end-session-commands.ndjson"),
							`${JSON.stringify({
								sessionId: command.sessionId,
								unbind: command.unbind ?? false,
							})}\n`,
						);
					return dispatch.call(this, command);
				});
			},
		});
		const { ClaudeDriver } = (await import(
			pathToFileURL(
				join(
					codeRoot,
					"lib/provider/claude",
					`claude-provider-instance.${extension}`,
				),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-provider-instance.js");
		const { ProviderInstanceFailure } = (await import(
			pathToFileURL(join(codeRoot, "lib/provider", `errors.${extension}`)).href
		)) as typeof import("../../src/lib/provider/errors.js");
		const create = ClaudeDriver.create;
		Object.assign(ClaudeDriver, {
			create: (
				deps: import("../../src/lib/provider/claude/claude-provider-instance.js").ClaudeProviderInstanceDeps,
			) =>
				create(deps).pipe(
					Effect.tap((instance) =>
						Effect.sync(() => {
							const endSession = instance.endSessionEffect.bind(instance);
							instance.endSessionEffect = (sessionId) =>
								Effect.suspend(() => {
									if (!existsSync(join(root, `fail-end-session-${sessionId}`)))
										return endSession(sessionId);
									appendFileSync(
										join(root, "end-session-failures.ndjson"),
										`${JSON.stringify({ sessionId })}\n`,
									);
									return Effect.fail(
										new ProviderInstanceFailure({
											providerId: "claude",
											operation: "endSession",
											cause: new Error(
												"Fixture end_session failure leaves the runner alive",
											),
										}),
									);
								});
						}),
					),
				),
		});
	}
	const metricsFile = process.env["CONDUIT_TEST_SERVER_METRICS"];
	if (metricsFile)
		recordServerMetrics(
			metricsFile,
			process.env["CONDUIT_TEST_SERVER_PROFILE"] === "1",
			(
				(await import(
					pathToFileURL(
						join(
							codeRoot,
							"lib/persistence",
							`session-family-query.${extension}`,
						),
					).href
				)) as typeof import("../../src/lib/persistence/session-family-query.js")
			).sessionFamilyWindowQuery,
		);
	const readCapabilitiesFixture =
		(): import("../../src/lib/provider/claude/claude-capabilities-probe.js").ProbeResult => {
			const resultPath = join(root, "capabilities-probe-result.json");
			return existsSync(resultPath)
				? (JSON.parse(
						readFileSync(resultPath, "utf8"),
					) as import("../../src/lib/provider/claude/claude-capabilities-probe.js").ProbeResult)
				: { models: [], agents: [], commands: [] };
		};
	if (existsSync(join(root, "capabilities-probe-gated"))) {
		const { ClaudeDriver } = (await import(
			pathToFileURL(
				join(
					codeRoot,
					"lib/provider/claude",
					`claude-provider-instance.${extension}`,
				),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-provider-instance.js");
		const { makeClaudeCapabilitiesService } = (await import(
			pathToFileURL(
				join(
					codeRoot,
					"lib/provider/claude",
					`claude-capabilities-service.${extension}`,
				),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-capabilities-service.js");
		const { configuredClaudeConfigDir } = (await import(
			pathToFileURL(
				join(codeRoot, "lib/provider/claude", `claude-sdk-env.${extension}`),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-sdk-env.js");
		const create = ClaudeDriver.create;
		Object.assign(ClaudeDriver, {
			create: (
				deps: import("../../src/lib/provider/claude/claude-provider-instance.js").ClaudeProviderInstanceDeps,
			) =>
				Effect.gen(function* () {
					const service = yield* makeClaudeCapabilitiesService({
						launchConfig: () => ({
							folderSource: "account",
							configDir: configuredClaudeConfigDir(
								process.env["CLAUDE_CONFIG_DIR"] ?? join(root, "claude"),
							),
						}),
					});
					let consumerId = 0;
					return yield* create({
						...deps,
						capabilitiesService: {
							get: (workspaceRoot) =>
								Effect.gen(function* () {
									// Session creation validates the pick before the test arms discovery.
									if (!existsSync(join(root, "capabilities-probe-armed")))
										return readCapabilitiesFixture();
									const id = ++consumerId;
									const request = yield* Effect.forkChild(
										service.get(workspaceRoot),
									);
									yield* Effect.yieldNow;
									// The parent is running after a yield, so a pending child is suspended.
									const status =
										request.pollUnsafe() === undefined ? "Suspended" : "Done";
									writeFileSync(
										join(root, `capabilities-consumer-${id}.json`),
										JSON.stringify({ workspaceRoot, status }),
									);
									return yield* Fiber.join(request);
								}),
						},
					});
				}),
		});
	}
	const { __setProbeOverrideForTesting } = (await import(
		pathToFileURL(
			join(
				codeRoot,
				"lib/provider/claude",
				`claude-capabilities-probe.${extension}`,
			),
		).href
	)) as typeof import("../../src/lib/provider/claude/claude-capabilities-probe.js");
	let probeAttempts = 0;
	__setProbeOverrideForTesting(async (workspaceRoot) => {
		if (existsSync(join(root, "capabilities-probe-gated"))) {
			writeFileSync(join(root, "capabilities-probe-started"), workspaceRoot);
			writeFileSync(
				join(root, "capabilities-probe-attempts.json"),
				JSON.stringify({ count: ++probeAttempts, workspaceRoot }),
			);
			while (!existsSync(join(root, "capabilities-probe-release")))
				await new Promise<void>((done) => setTimeout(done, 10));
		}
		return readCapabilitiesFixture();
	});
	const { startForegroundDaemon } = (await import(
		pathToFileURL(
			join(
				codeRoot,
				"lib/domain/daemon/Layers",
				`daemon-foreground.${extension}`,
			),
		).href
	)) as typeof import("../../src/lib/domain/daemon/Layers/daemon-foreground.js");
	const activeDaemon = await startForegroundDaemon({
		port: Number(process.env["CONDUIT_TEST_PORT"] ?? 0),
		host: "127.0.0.1",
		configDir:
			process.env["CONDUIT_TEST_DAEMON_CONFIG_DIR"] ?? join(root, "config"),
		claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"] ?? join(root, "claude"),
		staticDir: dist ? join(dist, "frontend") : join(root, "static"),
		smartDefault: false,
		// An unreachable unmanaged placeholder also keeps the relay's legacy
		// OpenCode pollers away from a developer's localhost:4096 instance.
		opencodeUrl:
			process.env["CONDUIT_TEST_OPENCODE_URL"] ?? "http://127.0.0.1:0",
		keepAwake: false,
		logLevel: process.env["LOG_LEVEL"] === "warn" ? "warn" : "error",
	});
	daemon = activeDaemon;
	if (disconnected) {
		await activeDaemon.stop();
		process.exit(0);
	}
	await activeDaemon.addProject(join(root, "process-test"));
	process.send({
		channel: "conduit-process-test",
		kind: "ready",
		port: activeDaemon.port,
		pid: process.pid,
		projects: activeDaemon.getProjects().map((project) => project.folders[0]),
		instances: activeDaemon
			.getInstances()
			.map((instance) => ({ managed: instance.managed, url: instance.url })),
	});
	await activeDaemon.stopped;
	// Runtime disposal leaves timers alive; match the real daemon child entry.
	process.exit(0);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
