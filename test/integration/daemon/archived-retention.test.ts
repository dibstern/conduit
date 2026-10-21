// Use the real daemon's one-minute schedule and browser RPC with an isolated store.
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { SessionActivityTag } from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceProjectLayer,
	makePersistenceStoreLayer,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

it("reclaims a root-only archived tree with unarchived side threads and subagents on a live daemon cycle", async () => {
	const harness = await ProcessHarness.start();
	const evidence: Record<string, unknown> = {};
	try {
		let browser = await harness.connect();
		await Effect.runPromise(
			browser.rpc.SetAutoSettleSetting({ autoSettleAfterDays: null }),
		);
		await Effect.runPromise(
			browser.rpc.SetAutoDeleteArchivedSetting({
				autoDeleteArchivedAfterDays: null,
			}),
		);
		const root = await browser.createSession("Retention root");
		const child = await browser.createSession("Retention side thread");
		const grandchild = await browser.createSession("Retention subagent");
		const source = await browser.createSession("Surviving fork source");
		const fork = await browser.createSession("Surviving fork");
		await harness.terminate();
		let db = new Database(harness.daemonStorePath());
		const ids = [root, child, grandchild];
		const snapshot = () => ({
			sessions: db
				.prepare<[string], { id: string; archived_at: number | null }>(
					"SELECT id, archived_at FROM sessions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
				)
				.all(JSON.stringify(ids)),
			events: db
				.prepare<[string], { count: number }>(
					"SELECT COUNT(*) AS count FROM events WHERE session_id IN (SELECT value FROM json_each(?))",
				)
				.get(JSON.stringify(ids))?.count,
			source: db
				.prepare<[string], { id: string }>(
					"SELECT id FROM sessions WHERE id = ?",
				)
				.get(source),
			sourceEvents: db
				.prepare<[string], { count: number }>(
					"SELECT COUNT(*) AS count FROM events WHERE session_id = ?",
				)
				.get(source)?.count,
			fork: db
				.prepare<[string], { forked_from: string | null }>(
					"SELECT forked_from FROM sessions WHERE id = ?",
				)
				.get(fork),
		});
		try {
			// Keep root_id stale to prove retention follows every parent edge.
			db.prepare(
				"UPDATE sessions SET parent_id = ?, side_thread = 1 WHERE id = ?",
			).run(root, child);
			db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?").run(
				child,
				grandchild,
			);
			db.prepare("UPDATE sessions SET forked_from = ? WHERE id = ?").run(
				source,
				fork,
			);
			db.close();
			// Seed old archive times through the real canonical commit/projector
			// while the fixture daemon is stopped. Only the roots are archived.
			const archivedAt = Date.now() - 31 * 86_400_000;
			await Effect.runPromise(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					yield* commit(
						[root, source].map((sessionId) =>
							canonicalEvent(
								"session.archived",
								sessionId,
								{ sessionId, automatic: false },
								{ createdAt: archivedAt },
							),
						),
					);
				}).pipe(
					Effect.provide(
						makePersistenceProjectLayer("process-test").pipe(
							Layer.provideMerge(
								makePersistenceStoreLayer(harness.daemonStorePath()),
							),
						),
					),
				),
			);
			await harness.restart();
			browser = await harness.connect();
			db = new Database(harness.daemonStorePath(), { readonly: true });
			evidence["before"] = snapshot();
			expect(snapshot().sessions).toHaveLength(3);
			expect(snapshot().sessions).toEqual(
				expect.arrayContaining([
					{ id: root, archived_at: archivedAt },
					{ id: child, archived_at: null },
					{ id: grandchild, archived_at: null },
				]),
			);
			expect(snapshot().events).toBeGreaterThan(0);
			expect(
				await Effect.runPromise(browser.rpc.GetAutoDeleteArchivedSetting({})),
			).toEqual({ autoDeleteArchivedAfterDays: null });
			await Effect.runPromise(
				browser.rpc.SetAutoDeleteArchivedSetting({
					autoDeleteArchivedAfterDays: 30,
				}),
			);
			const started = Date.now();
			await vi.waitFor(
				() => {
					expect(snapshot().sessions).toEqual([]);
					expect(snapshot().events).toBe(ids.length);
					expect(snapshot().source).toBeUndefined();
					expect(snapshot().sourceEvents).toBe(1);
					expect(snapshot().fork?.forked_from).toBeNull();
				},
				{ timeout: 75_000, interval: 500 },
			);
			evidence["elapsedMs"] = Date.now() - started;
			evidence["after"] = snapshot();
			expect(
				db
					.prepare(
						"SELECT session_id FROM events WHERE type = 'session.deleted' ORDER BY session_id",
					)
					.all(),
			).toEqual([...ids, source].sort().map((session_id) => ({ session_id })));
		} finally {
			if (db.open) db.close();
		}
	} finally {
		try {
			await harness.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/iujk7-archived-retention.json",
				JSON.stringify({ ...evidence, process: harness.proof() }, null, 2),
			);
		}
	}
}, 100_000);

it.each([
	"new descendant",
	"busy",
	"background work",
	"deleted root",
	"restored root",
	"rearchived root",
])("keeps a changed snapshot after %s arrives during retention", async (change) => {
	const harness = await createRelayHarness();
	try {
		await harness.stack.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const service = yield* SessionManagerServiceTag;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const read = yield* ReadQueryEffectTag;
				const activity = yield* SessionActivityTag;
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent("session.created", "retention-race", {
							sessionId: "retention-race",
							provider: "opencode",
							title: "Retention race",
						}),
					),
				);
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent(
							"session.archived",
							"retention-race",
							{ sessionId: "retention-race", automatic: false },
							{ createdAt: 1 },
						),
					),
				);
				const canonicalDelete = service.deleteSession;
				const intercept = vi
					.spyOn(service, "deleteSession")
					.mockImplementationOnce((id, options) =>
						Effect.gen(function* () {
							if (change === "deleted root") {
								yield* canonicalDelete(id, { keepWorktrees: true });
							} else if (
								change === "restored root" ||
								change === "rearchived root"
							) {
								yield* runner.projectEvent(
									yield* store.append(
										canonicalEvent("session.unarchived", id, {
											sessionId: id,
											cause: "manual",
										}),
									),
								);
								if (change === "rearchived root")
									yield* runner.projectEvent(
										yield* store.append(
											canonicalEvent("session.archived", id, {
												sessionId: id,
												automatic: false,
											}),
										),
									);
							} else if (change === "background work") {
								activity.background.record({
									sessionId: id,
									kind: "snapshot",
									tasks: [
										{
											id: "late",
											type: "local_agent",
											description: "Late work",
										},
									],
								});
							} else {
								const event =
									change === "busy"
										? canonicalEvent("session.status", id, {
												sessionId: id,
												status: "busy",
											})
										: canonicalEvent("session.created", "late-session", {
												sessionId: "late-session",
												provider: "opencode",
												title: "Late session",
												parentId: id,
											});
								yield* runner.projectEvent(yield* store.append(event));
							}
							return yield* canonicalDelete(id, options);
						}).pipe(
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.mapError(
								(cause) =>
									new SessionManagerError({
										operation: "retention-test-ingress",
										cause,
									}),
							),
						),
					);
				try {
					expect(
						yield* service.deleteArchivedSessions(30 * 86_400_000, Date.now()),
					).toBe(0);
					if (change === "deleted root") {
						expect(yield* read.getSession("retention-race")).toBeUndefined();
					} else {
						expect(yield* read.getSession("retention-race")).toBeDefined();
					}
					expect(
						(yield* store.readAllBySession("retention-race")).some(
							(event) => event.type === "session.deleted",
						),
					).toBe(change === "deleted root");
					if (change === "new descendant") {
						expect(yield* read.getSession("late-session")).toBeDefined();
						expect(
							(yield* store.readAllBySession("late-session")).length,
						).toBeGreaterThan(0);
					}
				} finally {
					intercept.mockRestore();
				}
			}),
		);
	} finally {
		await harness.stop();
	}
});
