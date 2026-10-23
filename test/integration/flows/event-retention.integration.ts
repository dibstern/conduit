import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import Database from "better-sqlite3";
import { Effect, Fiber, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { CurrentTransformer } from "effect/sql/Statement";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DrainReport,
	EVENT_RETENTION_HOLD_SQL,
	EventRetentionTag,
	makeEventRetention,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { replayProjectionTables } from "../../../src/lib/persistence/replay-parity.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const projectId = "integration-test";
const emptyReport: DrainReport = {
	sessionsFreed: 0,
	eventsFreed: 0,
	bytesFreed: 0,
	held: [],
	orphans: [],
	pointerKept: 0,
};

interface EventRow {
	sequence: number;
	session_id: string;
	type: string;
	data: string;
	project_id: string;
}

const sqliteLayer = (filename: string) =>
	SqliteNode.layer({ filename }).pipe(Layer.provide(Reactivity.layer));

const events = (db: Database.Database) =>
	db
		.prepare<[], EventRow>(
			"SELECT sequence, session_id, type, data, project_id FROM events ORDER BY sequence",
		)
		.all();

const ownMarker = (row: EventRow) =>
	row.type === "session.deleted" &&
	JSON.parse(row.data).sessionId === row.session_id;

const lineage = (rows: EventRow[], source: string) =>
	rows.filter((row) => {
		if (row.project_id !== projectId || row.session_id === source) return false;
		const data: Record<string, unknown> = JSON.parse(row.data);
		return (
			(row.type === "session.created" &&
				(data["parentId"] === source || data["forkedFrom"] === source)) ||
			(row.type === "session.forked" && data["parentId"] === source)
		);
	});

function resetProjections(db: Database.Database) {
	db.exec("PRAGMA foreign_keys = OFF; BEGIN");
	for (const table of replayProjectionTables) db.exec(`DELETE FROM ${table}`);
	db.exec(
		"DELETE FROM projector_cursors; DELETE FROM projection_failures; COMMIT",
	);
}

const drainCopy = (filename: string, owner = projectId) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* (yield* makeEventRetention).drain();
		}).pipe(
			Effect.provideService(PersistenceProjectTag, { projectId: owner }),
			Effect.provide(sqliteLayer(filename)),
			Effect.scoped,
		),
	);

describe("EventRetention through the relay", () => {
	let harness: RelayHarness;
	let db: Database.Database;
	let directory: string;
	let drain: () => ReturnType<RelayHarness["drainEventRetention"]>;
	const evidence: Record<string, unknown> = {};

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "conduit-retention-flow-"));
		mkdirSync(join(directory, "home"));
		mkdirSync(join(directory, "login"));
		vi.stubEnv("HOME", join(directory, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "login"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", directory);
		vi.spyOn(ProjectShellEnvResolver.prototype, "register").mockImplementation(
			() => {},
		);
		vi.spyOn(
			ProjectShellEnvResolver.prototype,
			"waitUntilReady",
		).mockResolvedValue(true);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async () => {
		db?.close();
		await harness?.stop();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		__setProbeOverrideForTesting(undefined);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/hiuf-8-event-retention.json",
			`${JSON.stringify({ ticket: "conduit-test-hiuf.8", scenarios: evidence }, null, 2)}\n`,
		);
		rmSync(directory, { recursive: true, force: true });
	});

	async function setup() {
		harness = await createRelayHarness("chat-simple", {
			configDir: directory,
			defaultModel: null,
			claudeSdk,
		});
		db = new Database(harness.eventsDbPath, { readonly: true });
		const runtime = harness.stack.effectRuntime.runtime;
		const retention = await runtime.runPromise(EventRetentionTag);
		const originalDrain = retention.drain;
		// Explicit drains let each command's report be asserted deterministically.
		// The separate scheduler flow exercises automatic background execution.
		vi.spyOn(retention, "drain").mockImplementation(() =>
			Effect.succeed(emptyReport),
		);
		drain = () => runtime.runPromise(originalDrain());
		const commit = await runtime.runPromise(makeCommitAndSignal);
		const ingestion = await runtime.runPromise(ProviderRuntimeIngestionTag);
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const parent = await client.createSession("Retention Source", {
			instanceId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "",
			},
		});
		const root = String(parent["id"]);
		return {
			runtime,
			commit,
			ingestion,
			client,
			root,
			retentionDrain: originalDrain,
		};
	}

	async function transcript(sessionId: string) {
		const messageId = `answer_${sessionId}_${randomUUID()}`;
		const userMessageId = `user_${messageId}`;
		const runId = `run_${messageId}`;
		const commit =
			await harness.stack.effectRuntime.runtime.runPromise(makeCommitAndSignal);
		await harness.stack.effectRuntime.runtime.runPromise(
			commit(
				[
					canonicalEvent("run.requested", sessionId, {
						runId,
						inputId: userMessageId,
					}),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId: userMessageId,
						role: "user",
					}),
					canonicalEvent("run.started", sessionId, {
						inputId: userMessageId,
						requestedRunId: runId,
					}),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId,
						parentID: userMessageId,
						role: "assistant",
					}),
					canonicalEvent("tool.started", sessionId, {
						messageId,
						partId: `tool_${messageId}`,
						callId: `call_${messageId}`,
						toolName: "Read",
						input: { tool: "Read", filePath: "/fixture" },
					}),
					canonicalEvent("tool.completed", sessionId, {
						messageId,
						partId: `tool_${messageId}`,
						result: "result ".repeat(4000),
						duration: 1,
					}),
					canonicalEvent("turn.completed", sessionId, { messageId }),
				].map((event) => ({
					...event,
					provider: "claude",
					metadata: { runId },
				})),
			),
		);
	}

	async function step(name: string, before: EventRow[], removedIds: string[]) {
		const report = await drain();
		const after = events(db);
		const kept = new Set(after.map((row) => row.sequence));
		const deleted = before.filter((row) => !kept.has(row.sequence));
		const sessions = removedIds.map((sessionId) => {
			const holders = lineage(after, sessionId);
			const bound = Math.max(0, ...holders.map((row) => row.sequence));
			const expected = before.filter(
				(row) =>
					row.session_id === sessionId &&
					(row.sequence <= bound || ownMarker(row)),
			);
			// The marker was committed after the before snapshot.
			const markers = after.filter(
				(row) => row.session_id === sessionId && ownMarker(row),
			);
			expect(after.filter((row) => row.session_id === sessionId)).toEqual(
				[
					...new Map(
						[...expected, ...markers].map((row) => [row.sequence, row]),
					).values(),
				].sort((a, b) => a.sequence - b.sequence),
			);
			const holderSessionIds = [
				...new Set(holders.map((row) => row.session_id)),
			].sort();
			if (bound > 0)
				expect(report.held).toContainEqual({
					sessionId,
					holderSessionIds,
					bound,
				});
			else
				expect(report.held.some((held) => held.sessionId === sessionId)).toBe(
					false,
				);
			return {
				sessionId,
				bound,
				holderSessionIds,
				deletedSequences: deleted
					.filter((row) => row.session_id === sessionId)
					.map((row) => row.sequence),
				keptSequences: after
					.filter((row) => row.session_id === sessionId)
					.map((row) => row.sequence),
			};
		});
		const parity = await harness.checkReplayParity();
		evidence[name] = { report, sessions, parity };
		expect(report.eventsFreed).toBe(deleted.length);
		expect(report.bytesFreed).toBeGreaterThanOrEqual(deleted.length);
		expect(report.sessionsFreed).toBe(
			sessions.filter(
				({ sessionId, bound }) =>
					bound === 0 && deleted.some((row) => row.session_id === sessionId),
			).length,
		);
		expect(report.pointerKept).toBe(0);
		expect(report.orphans).toEqual([]);
		expect(parity.diffs).toEqual([]);
		expect(parity.danglingPartPointers).toEqual([]);
		return report;
	}

	for (const scenario of ["R1", "R2", "R3", "R4"] as const) {
		it.each([
			"parent-first",
			"fork-first",
		] as const)(`${scenario} keeps exact lineage bounds in %s order`, async (order) => {
			const { client, root, runtime, ingestion } = await setup();
			await transcript(root);
			const removedWithRoot = [root];
			let source = root;
			if (scenario === "R3") {
				source = `subagent_${randomUUID()}`;
				const written = await runtime.runPromise(
					ingestion.ingestBatch(
						[
							{
								eventId: randomUUID(),
								type: "session.created",
								providerId: "claude",
								sessionId: source,
								providerRefs: { providerSessionId: source },
								rawSource: { kind: "claude.subagent" },
								createdAt: Date.now(),
								data: {
									sessionId: source,
									parentId: root,
									provider: "claude",
									title: "Subagent",
								},
							},
						],
						{
							sessionPicks: new Map([
								[
									source,
									{
										harness: "claude",
										model: { providerId: "claude", modelId: "sonnet" },
										effort: "",
										contextWindow: "",
									},
								],
							]),
						},
					),
				);
				expect(written).toBeGreaterThan(0);
				await transcript(source);
				removedWithRoot.push(source);
			}
			if (scenario === "R2") {
				const inputId = randomUUID();
				const side = await client.rpcCall((rpc) =>
					rpc.StartSideThread({
						sessionId: root,
						title: "Side question",
						inputId,
						text: "Side question",
					}),
				);
				await vi.waitFor(
					() => {
						expect(
							db
								.prepare<[string, string], { complete: number }>(`
						SELECT COUNT(*) AS complete FROM events e WHERE e.session_id = ? AND e.type = 'turn.completed'
						AND e.sequence > (SELECT sequence FROM events WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ?)`)
								.get(side.sessionId, inputId)?.complete,
						).toBeGreaterThan(0);
					},
					{ timeout: 15_000 },
				);
				removedWithRoot.push(side.sessionId);
			}
			let firstFork: string | undefined;
			if (scenario === "R4") {
				firstFork = String(
					(await client.forkSession({ sessionId: source }))["id"],
				);
				source = firstFork;
			}
			const forkId = String(
				(await client.forkSession({ sessionId: source }))["id"],
			);
			// Give dead sources a tail beyond every hold, so partial reclaim is proven.
			await transcript(root);
			if (source !== root) await transcript(source);
			// Read annotations are deliberately outside the log under ADR-0004.
			// Start this fixture from replay's unseen state before exercising deletes.
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql.withTransaction(
						Effect.gen(function* () {
							const rows = yield* sql<{
								id: string;
								version: number;
							}>`UPDATE sessions SET seen_version = NULL RETURNING id, version`;
							yield* refreshSidebar(
								rows.map((row) => row.id),
								Math.max(0, ...rows.map((row) => row.version)),
							);
						}),
					);
				}),
			);
			// A visible canonical update gives live and replay the same activity
			// baseline after the fixture's per-viewer annotation reset.
			const branches = db
				.prepare<[], { id: string }>(
					"SELECT id FROM sessions WHERE forked_from IS NOT NULL OR side_thread = 1 ORDER BY id",
				)
				.all();
			for (const [index, branch] of branches.entries())
				await client.renameSession(branch.id, `${scenario} branch ${index}`);
			const baseline = await harness.checkReplayParity();
			evidence[`${scenario}/${order}/before-delete`] = { parity: baseline };
			expect(baseline.diffs).toEqual([]);
			expect(baseline.danglingPartPointers).toEqual([]);
			let removed: string[] = [];
			for (const target of order === "parent-first"
				? [root, forkId]
				: [forkId, root]) {
				await client.deleteSession(target);
				// The drain also reclaims the control event committed by deletion.
				const before = events(db);
				removed = [
					...new Set([
						...removed,
						...(target === root ? removedWithRoot : [forkId]),
					]),
				];
				await step(
					`${scenario}/${order}/${target === root ? "parent" : "fork"}`,
					before,
					removed,
				);
			}
			if (firstFork) {
				await client.deleteSession(firstFork);
				const before = events(db);
				await step(`${scenario}/${order}/middle-fork`, before, [
					...removed,
					firstFork,
				]);
			}
		}, 30_000);
	}

	it("one call releases a parent's hold when it reclaims the child", async () => {
		const { client, root, runtime, ingestion } = await setup();
		await transcript(root);
		// Candidates sort by id. Process the held parent before the dead child,
		// so reclaiming both requires another pass through the parent's events.
		const child = `zz_retention_child_${randomUUID()}`;
		expect(root < child).toBe(true);
		await runtime.runPromise(
			ingestion.ingest({
				eventId: randomUUID(),
				type: "session.created",
				providerId: "claude",
				sessionId: child,
				providerRefs: { providerSessionId: child },
				rawSource: { kind: "claude.subagent" },
				createdAt: Date.now(),
				data: {
					sessionId: child,
					parentId: root,
					provider: "claude",
					title: "Subagent",
				},
			}),
		);
		await client.deleteSession(root);
		const before = events(db);
		const report = await step("single-call-chain", before, [root, child]);
		expect(report.sessionsFreed).toBe(2);
		expect(report.held).toEqual([]);
	});

	it("resumes after the first committed 500-event batch", async () => {
		const { client, root, runtime, commit } = await setup();
		await runtime.runPromise(
			commit(
				Array.from({ length: 1300 }, (_, index) =>
					canonicalEvent("session.renamed", root, {
						sessionId: root,
						title: `Rename ${index}`,
					}),
				),
			),
		);
		await client.deleteSession(root);
		const interruptedPath = join(directory, "interrupted.db");
		const uninterruptedPath = join(directory, "uninterrupted.db");
		await db.backup(interruptedPath);
		await db.backup(uninterruptedPath);
		const original = events(db);
		let committed: () => void = () => {};
		const firstBatch = new Promise<void>((resolve) => {
			committed = resolve;
		});
		let batches = 0;
		const fiber = Effect.runFork(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const transaction = sql.withTransaction;
				vi.spyOn(sql, "withTransaction").mockImplementation((effect) =>
					transaction(effect).pipe(
						Effect.tap(() => {
							batches++;
							if (batches !== 1) return Effect.void;
							committed();
							return Effect.never;
						}),
					),
				);
				return yield* (yield* makeEventRetention).drain();
			}).pipe(
				Effect.provideService(PersistenceProjectTag, { projectId }),
				Effect.provide(sqliteLayer(interruptedPath)),
				Effect.scoped,
			),
		);
		await firstBatch;
		await Effect.runPromise(Fiber.interrupt(fiber));
		const interrupted = new Database(interruptedPath);
		const partial = events(interrupted);
		expect(original.length - partial.length).toBe(500);
		expect(
			partial.filter((row) => row.session_id === root && ownMarker(row)),
		).toHaveLength(1);
		interrupted.close();
		const resumed = await drainCopy(interruptedPath);
		const uninterrupted = await drainCopy(uninterruptedPath);
		const first = new Database(interruptedPath);
		const second = new Database(uninterruptedPath);
		try {
			const finalEvents = first
				.prepare("SELECT * FROM events ORDER BY sequence")
				.all();
			expect(finalEvents).toEqual(
				second.prepare("SELECT * FROM events ORDER BY sequence").all(),
			);
			evidence["crash-safety"] = {
				firstBatchDeleted: 500,
				resumed,
				uninterrupted,
				finalEvents,
			};
		} finally {
			first.close();
			second.close();
		}
	}, 30_000);

	it("makes the same deletion decisions after a lineage projector fails during replay", async () => {
		const { client, root } = await setup();
		await transcript(root);
		const forkId = String(
			(await client.forkSession({ sessionId: root }))["id"],
		);
		await transcript(root);
		await client.deleteSession(root);
		const healthyPath = join(directory, "healthy.db");
		const failedPath = join(directory, "failed-replay.db");
		await db.backup(healthyPath);
		await db.backup(failedPath);
		const failed = new Database(failedPath);
		resetProjections(failed);
		failed.close();
		const replayFailures = await Effect.runPromise(
			Effect.gen(function* () {
				const cursor = yield* makeProjectorCursorEffect;
				const projectors = createAllEffectProjectors().map((projector) => ({
					...projector,
					project: (
						event: Parameters<typeof projector.project>[0],
						context: Parameters<typeof projector.project>[1],
					) =>
						projector.name === "session" &&
						event.type === "session.created" &&
						event.sessionId === forkId
							? Effect.fail(
									new ProjectionError({
										projector: projector.name,
										operation: "test-lineage-failure",
										cause: "forced replay failure",
									}),
								)
							: projector.project(event, context),
				}));
				const runner = yield* makeProjectionRunnerEffect(projectors).pipe(
					Effect.provideService(ProjectorCursorEffectTag, cursor),
				);
				yield* runner.recover();
				return yield* runner.getFailures();
			}).pipe(
				Effect.provideService(PersistenceProjectTag, { projectId }),
				Effect.provide(sqliteLayer(failedPath)),
				Effect.scoped,
			),
		);
		expect(
			replayFailures.some(
				(failure) =>
					failure.eventType === "session.created" &&
					failure.sessionId === forkId,
			),
		).toBe(true);
		const original = events(db).map((row) => row.sequence);
		const healthyReport = await drainCopy(healthyPath);
		const failedReport = await drainCopy(failedPath);
		const healthy = new Database(healthyPath);
		const replayed = new Database(failedPath);
		try {
			const deleted = (database: Database.Database) => {
				const kept = new Set(events(database).map((row) => row.sequence));
				return original.filter((sequence) => !kept.has(sequence));
			};
			expect(deleted(healthy)).toEqual(deleted(replayed));
			evidence["failed-replay"] = {
				replayFailures,
				healthyReport,
				failedReport,
				deletedSequences: deleted(healthy),
			};
		} finally {
			healthy.close();
			replayed.close();
		}
	}, 30_000);

	it("refuses late provider events after reclaim and a full projection reset", async () => {
		const { client, root, runtime, ingestion } = await setup();
		await transcript(root);
		await client.deleteSession(root);
		await drain();
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						for (const table of replayProjectionTables)
							yield* sql.unsafe(`DELETE FROM ${table}`);
						yield* sql.unsafe("DELETE FROM projector_cursors");
						yield* sql.unsafe("DELETE FROM projection_failures");
					}),
				);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}),
		);
		expect(
			db.prepare("SELECT id FROM sessions WHERE id = ?").get(root),
		).toBeUndefined();
		const before = events(db);
		const written = await runtime.runPromise(
			ingestion.ingest({
				eventId: randomUUID(),
				type: "session.created",
				providerId: "claude",
				sessionId: root,
				providerRefs: { providerSessionId: root },
				rawSource: { kind: "claude.late-event" },
				createdAt: Date.now(),
				data: {
					sessionId: root,
					title: "Late resurrection",
					provider: "claude",
				},
			}),
		);
		expect(written).toBe(0);
		expect(events(db)).toEqual(before);
		expect(
			db.prepare("SELECT id FROM sessions WHERE id = ?").get(root),
		).toBeUndefined();
		const parity = await harness.checkReplayParity();
		expect(parity.diffs).toEqual([]);
		expect(parity.danglingPartPointers).toEqual([]);
		evidence["death-survives-reclaim"] = {
			sessionId: root,
			written,
			kept: before.filter((row) => row.session_id === root),
			parity,
		};
	});

	it("drains only its project's rows in the daemon-wide store", async () => {
		const { client, root, runtime } = await setup();
		await transcript(root);
		await client.deleteSession(root);
		const otherProject = "another-project";
		const otherSession = `other_${randomUUID()}`;
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* makeEventStoreEffect;
				const stored = yield* store.appendBatch([
					canonicalEvent("session.created", otherSession, {
						sessionId: otherSession,
						title: "Other project",
						provider: "claude",
					}),
					canonicalEvent("session.deleted", otherSession, {
						sessionId: otherSession,
					}),
				]);
				yield* (yield* ProjectionRunnerEffectTag).projectBatch(stored);
			}).pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: otherProject,
				}),
			),
		);
		const before = events(db);
		const ours = await drain();
		expect(events(db).filter((row) => row.project_id === otherProject)).toEqual(
			before.filter((row) => row.project_id === otherProject),
		);
		const keptOurs = events(db).filter((row) => row.project_id === projectId);
		const theirs = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* makeEventRetention).drain();
			}).pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: otherProject,
				}),
			),
		);
		expect(events(db).filter((row) => row.project_id === projectId)).toEqual(
			keptOurs,
		);
		expect(
			events(db).filter((row) => row.session_id === otherSession),
		).toHaveLength(1);
		expect(ours.sessionsFreed).toBe(1);
		expect(theirs.sessionsFreed).toBe(1);
		evidence["project-scope"] = { ours, theirs, retainedByProject: events(db) };
	});

	it("reports an orphan despite a sidebar tombstone and another session's deletion payload", async () => {
		const { root } = await setup();
		await transcript(root);
		const filename = join(directory, "orphan.db");
		await db.backup(filename);
		const copy = new Database(filename);
		try {
			copy.prepare("DELETE FROM sessions WHERE id = ?").run(root);
			copy
				.prepare("UPDATE session_sidebar SET row = NULL WHERE session_id = ?")
				.run(root);
			copy
				.prepare(
					`INSERT INTO events (project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
					SELECT ?, ?, ?, MAX(stream_version) + 1, 'session.deleted', ?, '{}', 'claude', ?
					FROM events WHERE session_id = ?`,
				)
				.run(
					projectId,
					randomUUID(),
					root,
					JSON.stringify({
						sessionId: "another-session",
						childSessionIds: [root],
					}),
					Date.now(),
					root,
				);
			const before = events(copy);
			const report = await drainCopy(filename);
			expect(report).toEqual({ ...emptyReport, orphans: [root] });
			expect(events(copy)).toEqual(before);
			evidence["marker-only-orphan"] = {
				sessionId: root,
				report,
				retainedSequences: before.map((row) => row.sequence),
			};
		} finally {
			copy.close();
		}
	});

	it("keeps a live part's referenced event until the pointer is removed", async () => {
		const { root, client } = await setup();
		await transcript(root);
		const live = await client.createSession("Live pointer owner", {
			providerId: "opencode",
		});
		const liveId = String(live["id"]);
		await transcript(liveId);
		await client.deleteSession(root);
		const filename = join(directory, "pointer.db");
		await db.backup(filename);
		let copy = new Database(filename);
		try {
			const referenced = events(copy).find(
				(row) => row.session_id === root && row.type === "tool.completed",
			);
			if (!referenced) throw new Error("Fixture has no result event");
			copy
				.prepare(
					`UPDATE message_parts SET result_event_seq = ? WHERE id IN (
						SELECT p.id FROM message_parts p JOIN messages m ON m.id = p.message_id
						WHERE m.session_id = ? AND p.type = 'tool')`,
				)
				.run(referenced.sequence, liveId);
			copy.close();
			const blocked = await drainCopy(filename);
			copy = new Database(filename);
			expect(blocked.pointerKept).toBe(1);
			expect(blocked.sessionsFreed).toBe(0);
			expect(events(copy).filter((row) => row.session_id === root)).toEqual(
				events(db).filter(
					(row) =>
						row.sequence === referenced.sequence ||
						(row.session_id === root && ownMarker(row)),
				),
			);
			copy
				.prepare(
					"UPDATE message_parts SET result_event_seq = NULL WHERE result_event_seq = ?",
				)
				.run(referenced.sequence);
			copy.close();
			const released = await drainCopy(filename);
			copy = new Database(filename);
			expect(released.pointerKept).toBe(0);
			expect(released.sessionsFreed).toBe(1);
			expect(released.eventsFreed).toBe(1);
			expect(
				events(copy)
					.filter((row) => row.session_id === root)
					.every(ownMarker),
			).toBe(true);
			evidence["pointer-fallback"] = {
				sessionId: root,
				liveId,
				referencedSequence: referenced.sequence,
				blocked,
				released,
			};
		} finally {
			copy.close();
		}
	});

	it("reports fully held sessions without opening a write transaction", async () => {
		const { root, client, runtime } = await setup();
		await transcript(root);
		const forkId = String(
			(await client.forkSession({ sessionId: root }))["id"],
		);
		await client.deleteSession(root);
		const first = await drain();
		expect(first.held).toHaveLength(1);
		const sql = await runtime.runPromise(SqlClient.SqlClient);
		const transactions = vi.spyOn(sql, "withTransaction");
		const report = await drain();
		expect(transactions).not.toHaveBeenCalled();
		expect(report.eventsFreed).toBe(0);
		expect(report.held).toEqual(first.held);
		expect(report.held[0]?.holderSessionIds).toEqual([forkId]);
		evidence["held-without-writes"] = { report, writeTransactions: 0 };
	});

	it("seeks indexes for every production retention query and live pointer check", async () => {
		const { root, client, runtime, retentionDrain } = await setup();
		await transcript(root);
		await client.forkSession({ sessionId: root });
		await transcript(root);
		await client.deleteSession(root);
		const queries = new Map<string, readonly unknown[]>();
		await runtime.runPromise(
			retentionDrain().pipe(
				Effect.provideService(CurrentTransformer, (statement) => {
					const [query, parameters] = statement.compile();
					queries.set(query, parameters);
					return Effect.succeed(statement);
				}),
			),
		);
		const plans = [...queries].map(([query, parameters]) => {
			const details = db
				.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
				.all(...parameters)
				.map(({ detail }) => detail);
			// CTEs and json_each may scan their small derived session sets. The
			// event/part tables and their aliases must always use a bounded seek.
			expect(
				details.filter((detail) =>
					/\bSCAN\s+(?:events|message_parts|e|marker|other|part)\b/i.test(
						detail,
					),
				),
				query,
			).toEqual([]);
			return { query, details };
		});
		for (const [name, queryText, indexes] of [
			["candidate", "SELECT DISTINCT marker.session_id", ["idx_events_type"]],
			["orphan", "WITH created AS MATERIALIZED", ["idx_events_type"]],
			[
				"batch",
				"DELETE FROM events",
				["idx_events_session_seq", "idx_message_parts_result_event_seq"],
			],
			[
				"pointer count",
				"SELECT COUNT(*) AS count FROM events e",
				["idx_events_session_seq", "idx_message_parts_result_event_seq"],
			],
			["preflight", "SELECT 1 FROM events e", ["idx_events_session_seq"]],
			[
				"hold",
				EVENT_RETENTION_HOLD_SQL.trim(),
				["idx_events_lineage_parent", "idx_events_lineage_forked_from"],
			],
		] as const) {
			const plan = plans.find(({ query }) =>
				name === "preflight"
					? query.trimStart().startsWith(queryText)
					: query.includes(queryText),
			);
			expect(plan, name).toBeDefined();
			for (const index of indexes)
				expect(
					plan?.details.some((detail) => detail.includes(index)),
					name,
				).toBe(true);
		}
		evidence["index-usage"] = plans;
	});
});
