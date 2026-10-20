import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { RunnerMessage } from "../../../src/lib/provider/runner/runner-protocol.js";
import { isRecord } from "../../../src/lib/utils.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Temporary upgrade proof, removed by 82tn.31.4. This pin must equal the main
// build this machine runs at merge time, not a branch build with another ID.
const MAIN_COMMIT = "b7ded5e225a567c4dfe300b8ab640c7771fbef54";
const branchDist = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const artifactDir = process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";
const execute = promisify(execFile);
const cases: Array<Record<string, unknown>> = [];
let mainDist: string;
let dependencyMode: string;

function buildId(dist: string): string {
	const id = readFileSync(join(dist, "src/lib/build-id.js"), "utf8").match(
		/BUILD_ID\s*=\s*["']([^"']+)["']/,
	)?.[1];
	if (!id) throw new Error(`Missing built server identity in ${dist}`);
	return id;
}

beforeAll(async () => {
	const cache = join(tmpdir(), `conduit-82tn31-2-main-${MAIN_COMMIT}`);
	const ready = join(cache, "two-build-ready.json");
	if (!existsSync(ready)) {
		const staging = mkdtempSync(`${cache}-`);
		const run = async (command: string, args: string[]) => {
			try {
				const { stdout, stderr } = await execute(command, args, {
					cwd: staging,
					timeout: 600_000,
					maxBuffer: 4 * 1024 * 1024,
					env: {
						...process.env,
						CI: "true",
						npm_config_verify_deps_before_run: "false",
						pnpm_config_verify_deps_before_run: "false",
					},
				});
				writeFileSync(join(staging, `${command}-build.log`), stdout + stderr);
			} catch (error) {
				throw new Error(`Pinned main build failed in ${staging}`, {
					cause: error,
				});
			}
		};
		// Archive reads git objects without touching the index or worktree.
		await execute("git", [
			"archive",
			"--format=tar",
			`--output=${join(staging, "main.tar")}`,
			MAIN_COMMIT,
		]);
		await run("tar", ["-xf", "main.tar"]);
		rmSync(join(staging, "main.tar"));
		const sameLock = readFileSync(join(staging, "pnpm-lock.yaml")).equals(
			readFileSync("pnpm-lock.yaml"),
		);
		if (sameLock)
			symlinkSync(resolve("node_modules"), join(staging, "node_modules"));
		else {
			// Use the already populated pnpm store, not a new empty store under
			// the archive. Install main's graph rather than borrowing our modules.
			const { storeDir } = JSON.parse(
				readFileSync("node_modules/.modules.yaml", "utf8"),
			) as { storeDir: string };
			await run("pnpm", [
				"install",
				"--offline",
				"--frozen-lockfile",
				"--frozen-store",
				"--ignore-scripts",
				`--store-dir=${dirname(storeDir)}`,
			]);
		}
		await run("pnpm", ["run", "build:server"]);
		writeFileSync(
			join(staging, "two-build-ready.json"),
			JSON.stringify({
				commit: MAIN_COMMIT,
				dependencyMode: sameLock ? "matching-lockfile" : "offline-install",
			}),
		);
		// Keep the archive's dependency graph and compiled runner together.
		renameSync(staging, cache);
	}
	const manifest = JSON.parse(readFileSync(ready, "utf8")) as {
		commit: string;
		dependencyMode: string;
	};
	expect(manifest.commit).toBe(MAIN_COMMIT);
	dependencyMode = manifest.dependencyMode;
	mainDist = join(cache, "dist");
	expect(buildId(mainDist)).not.toBe(buildId(branchDist));
}, 900_000);

function marks(harness: ProcessHarness): ProcessMark[] {
	const file = join(harness.root, "sdk-proof.ndjson");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
		: [];
}

function snapshot(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const upgraded = Boolean(
			db
				.prepare("SELECT 1 FROM sqlite_master WHERE name = 'provider_runs'")
				.get(),
		);
		return {
			runOwnershipAvailable: upgraded,
			migrationHead: db
				.prepare(
					"SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 6",
				)
				.all() as Array<{ migration_id: number; name: string }>,
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			pendingInputs: db
				.prepare(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string; state: string }>,
			turns: db
				.prepare(
					`SELECT id, state, started_at, completed_at, ${upgraded ? "run_id" : "NULL AS run_id"} FROM turns WHERE session_id = ? ORDER BY requested_at, rowid`,
				)
				.all(sessionId) as Array<{
				id: string;
				state: string;
				started_at: number | null;
				completed_at: number | null;
				run_id: string | null;
			}>,
			runs: upgraded
				? (db
						.prepare(
							"SELECT id, status, started_at, completed_at, joined_into FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(sessionId) as Array<{
						id: string;
						status: string;
						started_at: number | null;
						completed_at: number | null;
						joined_into: string | null;
					}>)
				: [],
			outbox: db
				.prepare(
					`SELECT command_id, status, attempt_count, ${upgraded ? "run_id" : "NULL AS run_id"} FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence`,
				)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				attempt_count: number;
				run_id: string | null;
			}>,
			receipts: db
				.prepare(
					"SELECT command_id, status, error_code FROM command_receipts WHERE session_id = ? ORDER BY created_at, rowid",
				)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				error_code: string | null;
			}>,
			events: (
				db
					.prepare(
						"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as Array<{
					type: string;
					data: string;
					metadata: string;
				}>
			).map((event) => ({
				type: event.type,
				data: JSON.parse(event.data) as Record<string, unknown>,
				metadata: JSON.parse(event.metadata) as Record<string, unknown>,
			})),
		};
	} finally {
		db.close();
	}
}

type Snapshot = ReturnType<typeof snapshot>;
type Wire = { pid: number; frame: RunnerMessage };

function wire(harness: ProcessHarness): Wire[] {
	const file = join(harness.root, "two-build-wire.ndjson");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Wire)
		: [];
}

function steerSink(
	harness: ProcessHarness,
	inputs: string[],
	prompt = "old-runner-steer-proof",
) {
	const old = harness.marks.find((mark) => mark.kind === "runner-started");
	const frames = wire(harness);
	const commands = frames.flatMap(({ frame }) =>
		frame.type === "command" && frame.command.type === "send-turn"
			? [{ sinkId: frame.command.sinkId, inputId: frame.command.input.inputId }]
			: [],
	);
	const original = commands.find(
		(command) => command.inputId === inputs[0],
	)?.sinkId;
	const steer = commands.find(
		(command) => command.inputId === inputs[1],
	)?.sinkId;
	const sinks = [
		...new Set(
			frames.flatMap(({ pid, frame }) =>
				old?.kind === "runner-started" &&
				pid === old.pid &&
				frame.type === "output" &&
				frame.output.type === "event" &&
				frame.output.event.type === "text.delta" &&
				isRecord(frame.output.event.data) &&
				typeof frame.output.event.data["text"] === "string" &&
				responseChunks(prompt).includes(frame.output.event.data["text"])
					? [frame.output.sinkId]
					: [],
			),
		),
	];
	return {
		originalCommand: original ? "original-sink" : null,
		steerCommand: steer ? "steer-sink" : null,
		output: sinks.map((sink) =>
			sink === original
				? "original-sink"
				: sink === steer
					? "steer-sink"
					: "other-sink",
		),
		emittedByMainRunner: sinks.length > 0,
	};
}

function normalized(state: Snapshot, inputs: string[]) {
	const input = (id: string) =>
		inputs.includes(id) ? `input-${inputs.indexOf(id) + 1}` : "other-input";
	const run = (id: string | null) =>
		id === null
			? null
			: `run-${state.runs.findIndex((row) => row.id === id) + 1}`;
	return {
		migrationHead: state.migrationHead,
		session: state.session,
		busy:
			state.runs.some((row) => ["pending", "running"].includes(row.status)) ||
			(!state.runOwnershipAvailable && state.session.status === "busy"),
		pendingInputs: state.pendingInputs.map((row) => ({
			input: input(row.input_id),
			state: row.state,
		})),
		turns: state.turns.map((row, i) => ({
			id: `turn-${i + 1}`,
			state: row.state,
			runId: run(row.run_id),
			accepted: row.started_at !== null,
			ended: row.completed_at !== null,
		})),
		runs: state.runs.map((row) => ({
			id: run(row.id),
			status: row.status,
			accepted: row.started_at !== null,
			ended: row.completed_at !== null,
			joinedInto: run(row.joined_into),
			eventTypes: state.events
				.filter((event) => event.metadata["runId"] === row.id)
				.map((event) => event.type),
		})),
		unownedEventTypes: state.events
			.filter((event) => !event.metadata["runId"])
			.map((event) => event.type),
		outbox: state.outbox.map((row) => ({
			input: input(row.command_id),
			status: row.status,
			attempts: row.attempt_count,
			runId: run(row.run_id),
		})),
		receipts: state.receipts.map((row) => ({
			input: input(row.command_id),
			status: row.status,
			errorCode: row.error_code,
		})),
	};
}

let active:
	| {
			harness: ProcessHarness;
			evidence: Record<string, unknown>;
			sessionId?: string;
			inputs: string[];
	  }
	| undefined;

afterEach(async ({ task }) => {
	if (!active) return;
	const { harness, evidence, sessionId, inputs } = active;
	try {
		evidence["runnerBuildIds"] = [
			...new Set(
				harness.marks.flatMap((mark) =>
					mark.kind === "runner-started" ? [mark.buildId] : [],
				),
			),
		];
		if (sessionId && existsSync(harness.daemonStorePath()))
			evidence["final"] = normalized(snapshot(harness, sessionId), inputs);
		evidence["outcome"] = task.result?.errors?.length ? "failed" : "passed";
		evidence["errors"] =
			task.result?.errors?.map((error) => error.message) ?? [];
		evidence["bootstrapTimeout"] = /startup timed? ?out|startup timeout/i.test(
			JSON.stringify(evidence["errors"]),
		);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "cleanup");
		writeFileSync(join(harness.root, "release-upgrade-recovered"), "cleanup");
		await harness.dispose();
		evidence["cleanup"] = {
			remainingRunners: harness.remainingRunnerPids().length,
		};
	} finally {
		cases.push(evidence);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, "82tn31-2-two-build-proof.json"),
			`${JSON.stringify({ mainCommit: MAIN_COMMIT, dependencyMode, builds: { main: buildId(mainDist), branch: buildId(branchDist) }, cases }, null, 2)}\n`,
		);
		active = undefined;
	}
}, 30_000);

// Failure modes: a substituted build masquerades as main; migration interrupts
// a live reply; unowned old output never ends its reservation; a steer uses a
// different sink, loses output, or prematurely settles the original command.
for (const delivery of [
	"queue",
	"steer",
	"idle",
	"recovered",
	"recovered-stop",
	"stop-run-now",
	"steer-on-main",
] as const) {
	const steer = delivery === "steer";
	const idle = delivery === "idle";
	const recovered = delivery === "recovered" || delivery === "recovered-stop";
	const stopped = delivery === "recovered-stop";
	const runNow = delivery === "stop-run-now";
	it(`temporary real-main upgrade: ${stopped ? "Stop fences an unreceived recovered attempt after the swap" : runNow ? "Run now retires a legacy reply that never ends at the Stop bound" : delivery === "steer-on-main" ? "records main steer routing before the daemon upgrade" : idle ? "swaps an idle legacy runner before its next input" : recovered ? "holds an unknown recovered send for the new runner" : steer ? "holds a steer for the new runner" : "holds a queued send for the new runner"}`, async () => {
		const harness = ProcessHarness.create({
			dist: mainDist,
			restartProof: true,
			upgradeSinkProof: true,
			rootPrefix: join(tmpdir(), "conduit-82tn31-2-case-"),
		});
		const evidence: Record<string, unknown> = {
			case: delivery,
			criteria: {},
			phase: "main-bootstrap",
		};
		const originalInput = randomUUID();
		const steerInput = randomUUID();
		const inputs = [originalInput];
		const pendingPrompt = recovered
			? "upgrade-recovered-turn"
			: "old-runner-steer-proof";
		active = { harness, evidence, inputs };
		// Observe wire writes in the test environment only. Neither build is
		// rewritten, and the runner's encode/dispatch/ack paths are unchanged.
		const observer = join(harness.root, "two-build-observer.mjs");
		writeFileSync(
			observer,
			`import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const write = Socket.prototype.write;
Socket.prototype.write = function(chunk, ...args) {
  if (typeof chunk === "string" && chunk.startsWith("{")) {
    for (const line of chunk.trim().split("\\n")) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (["hello", "command", "command-reply", "output"].includes(frame.type))
        appendFileSync(${JSON.stringify(join(harness.root, "two-build-wire.ndjson"))}, JSON.stringify({ pid: process.pid, frame }) + "\\n");
    }
  }
  return write.call(this, chunk, ...args);
};\n`,
		);
		const serviceEnvironment = {
			NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`,
		};
		await harness.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 120_000,
			serviceEnvironment,
			skipBrowserProbe: true,
		});
		// Main and branch have different detail schemas. Use the archived
		// client's browser until the code switch, without adapting either server.
		const { ProcessBrowser: MainBrowser } = (await import(
			pathToFileURL(join(mainDist, "test/helpers/process-harness.js")).href
		)) as { ProcessBrowser: typeof ProcessBrowser };
		const generation = harness.proof().generations.at(-1);
		if (!generation) throw new Error("Missing main daemon generation");
		const browser = await MainBrowser.connect(generation.port);
		harness.browsers.push(browser);
		await vi.waitFor(() =>
			expect(harness.proof().generations.at(-1)?.fakeSdkActive).toBe(true),
		);
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession(
			"Temporary two-build upgrade",
		);
		active.sessionId = sessionId;
		evidence["phase"] = "old-runner-startup";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: originalInput,
				text: "upgrade-long-turn",
				delivery: "queue",
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					marks(harness).some((mark) => mark.kind === "assistant-held"),
				).toBe(true),
			{ timeout: 150_000, interval: 100 },
		);
		const old = harness.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (old?.kind !== "runner-started")
			throw new Error("Missing old runner hello");
		expect(old.buildId).toBe(buildId(mainDist));
		expect(
			readFileSync(join(harness.root, `runner-argv-${old.pid}.json`), "utf8"),
		).toContain(mainDist);
		const recordLegacyRetirement = () => {
			const oldHello = wire(harness).find(
				({ frame }) => frame.type === "hello" && frame.pid === old.pid,
			)?.frame;
			if (oldHello?.type !== "hello" || !oldHello.runnerId)
				throw new Error("Missing legacy identity");
			const legacyLogs = readFileSync(
				join(harness.configDir, "daemon.log"),
				"utf8",
			)
				.split("\n")
				.filter((line) => /Legacy runner (adopted|retired)/.test(line))
				.map((line) => {
					const value: unknown = JSON.parse(line);
					return isRecord(value) ? value["msg"] : undefined;
				});
			expect(legacyLogs).toEqual([
				`Legacy runner adopted: session=${sessionId} runner=${oldHello.runnerId} build=${old.buildId}`,
				`Legacy runner retired: session=${sessionId} runner=${oldHello.runnerId} build=${old.buildId}`,
			]);
			evidence["legacyLogs"] = [
				"adopted session-1 runner-main build-main",
				"retired session-1 runner-main build-main",
			];
		};
		if (idle) {
			writeFileSync(
				join(harness.root, "release-upgrade-turn"),
				"finish before switch",
			);
			await vi.waitFor(
				() =>
					expect(snapshot(harness, sessionId).outbox[0]?.status).toBe(
						"completed",
					),
				{ timeout: 30_000 },
			);
		}
		const before = snapshot(harness, sessionId);
		expect(before.turns).toHaveLength(1);
		expect(before.outbox).toMatchObject([
			{ status: idle ? "completed" : "running" },
		]);
		evidence["beforeUpgrade"] = normalized(before, inputs);
		if (delivery === "steer-on-main") {
			inputs.push(steerInput);
			const submitted = await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: steerInput,
					text: "old-runner-steer-proof",
					delivery: "steer",
				}),
			);
			expect(submitted.ok).toBe(true);
			await vi.waitFor(
				() =>
					expect(
						wire(harness).some(
							({ frame }) =>
								frame.type === "command" &&
								frame.command.type === "send-turn" &&
								frame.command.input.inputId === steerInput,
						),
					).toBe(true),
				{ timeout: 30_000 },
			);
			// The routing question is independent of migration compatibility.
			// Observe it on main before the other case switches daemon code.
			writeFileSync(join(harness.root, "release-upgrade-turn"), "steer probe");
			await vi.waitFor(
				() =>
					expect(steerSink(harness, inputs)).toMatchObject({
						originalCommand: "original-sink",
						steerCommand: "steer-sink",
						emittedByMainRunner: true,
					}),
				{ timeout: 60_000 },
			);
			await vi.waitFor(
				() => {
					const finished = snapshot(harness, sessionId);
					expect(finished.turns.map((row) => row.state)).toEqual([
						"completed",
						"completed",
					]);
					expect(finished.outbox.map((row) => row.status)).toEqual([
						"completed",
						"completed",
					]);
					expect(finished.session.status).toBe("idle");
				},
				{ timeout: 30_000 },
			);
			evidence["steerSubmittedOn"] = "main-before-switch";
			evidence["phase"] = "steer-observed";
			evidence["steerSink"] = steerSink(harness, inputs);
			evidence["criteria"] = {
				realMainRunner: "passed",
				steerSink: "recorded",
				midTurnUpgrade: "covered-by-reply-case",
			};
			return;
		}
		evidence["criteria"] = {
			realMainRunner: "passed",
			midTurnUpgrade: "attempted",
			ownedCompletion: "not-reached",
			notBusy: "not-reached",
		};
		evidence["phase"] = "branch-bootstrap";
		await harness.kill();
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		if (recovered) {
			// Crash window: main committed and claimed B, but never wrote it to
			// the socket. A is still executing on that real main-build runner.
			inputs.push(steerInput);
			const db = new Database(harness.daemonStorePath());
			try {
				db.prepare(`INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
					SELECT ?, project_key, session_id, provider_id, effect_type,
					json_set(payload_json, '$.inputId', ?, '$.prompt', ?, '$.text', ?),
					'running', attempt_count, requested_at + 1, updated_at + 1 FROM provider_command_outbox WHERE command_id = ?`).run(
					steerInput,
					steerInput,
					pendingPrompt,
					pendingPrompt,
					originalInput,
				);
				db.prepare(`INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at)
					SELECT ?, session_id, 'accepted', command_type, project_key, created_at + 1, updated_at + 1 FROM command_receipts WHERE command_id = ?`).run(
					steerInput,
					originalInput,
				);
			} finally {
				db.close();
			}
		}
		await harness.restart({
			dist: branchDist,
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 120_000,
			serviceEnvironment,
		});
		await harness.connect(sessionId);
		evidence["phase"] = "runner-adoption";
		await vi.waitFor(
			() =>
				expect(
					harness.marks.filter(
						(mark) => mark.kind === "runner-started" && mark.pid === old.pid,
					),
				).toHaveLength(2),
			{ timeout: 150_000 },
		);
		const migrated = snapshot(harness, sessionId);
		evidence["afterUpgrade"] = normalized(migrated, inputs);
		const [originalTurn] = before.turns;
		const [migratedTurn] = migrated.turns;
		const [migratedCommand] = migrated.outbox;
		if (!originalTurn || !migratedTurn || !migratedCommand)
			throw new Error("Missing migrated turn or command");
		expect(migrated.turns[0]).toMatchObject({
			state: originalTurn.state,
			started_at: originalTurn.started_at,
			run_id: migratedCommand.run_id,
		});
		if (!idle) expect(migratedTurn.run_id).not.toBeNull();
		const branchBrowser = harness.browsers.at(-1);
		if (!branchBrowser) throw new Error("Missing branch browser");
		if (!recovered) {
			inputs.push(steerInput);
			const submitted = await Effect.runPromise(
				branchBrowser.rpc["input.submit"]({
					sessionId,
					originId: branchBrowser.originId,
					inputId: steerInput,
					text: pendingPrompt,
					delivery: steer ? "steer" : "queue",
				}),
			);
			expect(submitted.ok).toBe(true);
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			if (!idle)
				try {
					expect(
						db
							.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
							.get(steerInput),
					).toEqual({ state: "queued" });
				} finally {
					db.close();
				}
			else db.close();
			if (!idle) expect(snapshot(harness, sessionId).outbox).toHaveLength(1);
			if (!idle)
				expect(
					wire(harness).filter(
						({ frame }) =>
							frame.type === "command" &&
							frame.command.type === "send-turn" &&
							frame.command.input.inputId === steerInput,
					),
				).toHaveLength(0);
		} else {
			expect(snapshot(harness, sessionId).outbox).toMatchObject([
				{ status: "running" },
				{ status: "pending" },
			]);
		}

		evidence["heldBeforeReplyEnds"] = normalized(
			snapshot(harness, sessionId),
			inputs,
		);
		if (stopped || runNow) {
			evidence["phase"] = "explicit-stop";
			if (runNow)
				await Effect.runPromise(
					branchBrowser.rpc["input.sendNow"]({
						sessionId,
						inputId: steerInput,
						interrupt: true,
						originId: branchBrowser.originId,
					}),
				);
			else
				await Effect.runPromise(
					branchBrowser.rpc.CancelSession({
						sessionId,
						commandId: randomUUID(),
					}),
				);
			await vi.waitFor(
				() => {
					expect(snapshot(harness, sessionId).runs[0]?.status).toBe(
						"interrupted",
					);
					expect(
						readFileSync(join(harness.configDir, "daemon.log"), "utf8"),
					).toContain(`Legacy runner retired: session=${sessionId}`);
				},
				{ timeout: 60_000 },
			);
			if (stopped) {
				expect(snapshot(harness, sessionId).outbox[1]?.status).toBe("failed");
				expect(
					wire(harness).filter(
						({ frame }) =>
							frame.type === "command" &&
							frame.command.type === "send-turn" &&
							frame.command.input.inputId === steerInput,
					),
				).toHaveLength(0);
				recordLegacyRetirement();
				evidence["afterStoppedRetirement"] = normalized(
					snapshot(harness, sessionId),
					inputs,
				);
				evidence["phase"] = "completed";
				evidence["criteria"] = {
					unreceivedAttemptNeverDelivered: "passed",
					legacyRetiredAfterStop: "passed",
				};
				return;
			}
		}

		evidence["phase"] = "native-reply";
		writeFileSync(
			join(harness.root, "release-upgrade-turn"),
			"finish on main runner",
		);
		if (!runNow)
			await vi.waitFor(
				() =>
					expect(
						marks(harness).filter(
							(mark) =>
								mark.kind === "emit" &&
								mark.prompt === (steer ? pendingPrompt : "upgrade-long-turn"),
						),
					).toHaveLength(3),
				{ timeout: 60_000 },
			);
		if (recovered) {
			await vi.waitFor(
				() =>
					expect(
						marks(harness).some(
							(mark) =>
								mark.kind === "assistant-held" && mark.prompt === pendingPrompt,
						),
					).toBe(true),
				{ timeout: 30_000 },
			);
			const accepted = snapshot(harness, sessionId);
			expect(accepted.runs[1]?.status).toBe("running");
			expect(accepted.outbox[1]?.status).toBe("running");
			expect(accepted.receipts[1]?.status).toBe("accepted");
			evidence["recoveredIntake"] = normalized(accepted, inputs);
			writeFileSync(
				join(harness.root, "release-upgrade-recovered"),
				"finish on new runner",
			);
		}
		evidence["phase"] = "owned-completion";
		await vi.waitFor(
			() => {
				const final = snapshot(harness, sessionId);
				expect(final.turns.map((row) => row.state)).toEqual(
					inputs.map((_, index) =>
						runNow && index === 0 ? "interrupted" : "completed",
					),
				);
				expect(final.runs.map((row) => row.status)).toEqual(
					idle
						? ["completed"]
						: [runNow ? "interrupted" : "completed", "completed"],
				);
				if (!idle) expect(final.turns[0]?.run_id).toBe(final.runs[0]?.id);
				expect(final.outbox.map((row) => row.status)).toEqual(
					inputs.map((_, index) =>
						runNow && index === 0 ? "failed" : "completed",
					),
				);
				expect(final.receipts.map((row) => row.status)).toEqual(
					inputs.map((_, index) =>
						runNow && index === 0
							? "side_effect_failed"
							: "side_effect_completed",
					),
				);
				expect(final.session.status).toBe("idle");
				for (const row of final.turns.slice(idle || runNow ? 1 : 0)) {
					expect(row.run_id).not.toBeNull();
					expect(
						final.events.some(
							(event) =>
								event.type === "turn.completed" &&
								event.metadata["runId"] === row.run_id,
						),
					).toBe(true);
				}
			},
			{ timeout: 15_000 },
		);
		evidence["criteria"] = {
			realMainRunner: "passed",
			midTurnUpgrade: "passed",
			ownedCompletion: "passed",
			notBusy: "passed",
			heldUntilSwap: "passed",
			newRunnerExactlyOnce: "passed",
		};
		const deliveries = wire(harness).filter(
			({ frame }) =>
				frame.type === "command" &&
				frame.command.type === "send-turn" &&
				frame.command.input.inputId === steerInput,
		);
		expect(deliveries).toHaveLength(1);
		const delivered = deliveries[0]?.frame;
		if (delivered?.type !== "command" || delivered.command.type !== "send-turn")
			throw new Error("Missing replacement send");
		const deliveredSinkId = delivered.command.sinkId;
		const writer = wire(harness).find(
			({ frame }) =>
				frame.type === "output" &&
				frame.output.type === "event" &&
				frame.output.sinkId === deliveredSinkId &&
				frame.output.event.type === "text.delta",
		);
		const newHello = wire(harness).find(
			({ frame }) =>
				frame.type === "hello" &&
				typeof frame.pid === "number" &&
				frame.pid !== old.pid &&
				frame.pid === writer?.pid &&
				frame.buildId === buildId(branchDist),
		);
		expect(
			newHello?.frame.type === "hello"
				? newHello.frame.stampsRunIds
				: undefined,
		).toBe(true);
		expect(steerSink(harness, inputs, pendingPrompt).emittedByMainRunner).toBe(
			false,
		);
		const newPid =
			newHello?.frame.type === "hello" ? newHello.frame.pid : undefined;
		expect(
			wire(harness).some(
				({ pid, frame }) =>
					pid === newPid &&
					frame.type === "output" &&
					frame.output.type === "event" &&
					frame.output.sinkId === deliveredSinkId &&
					frame.output.event.type === "text.delta" &&
					isRecord(frame.output.event.data) &&
					typeof frame.output.event.data["text"] === "string" &&
					responseChunks(pendingPrompt).includes(
						frame.output.event.data["text"],
					),
			),
		).toBe(true);
		evidence["steerSink"] = {
			output: "new-runner-sink",
			emittedByMainRunner: false,
			stampsRunIds: true,
		};
		recordLegacyRetirement();
	}, 420_000);
}
