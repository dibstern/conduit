import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Context, Deferred, Effect, Logger, ManagedRuntime } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DrainReport,
	EventRetentionTag,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const emptyReport: DrainReport = {
	sessionsFreed: 0,
	eventsFreed: 0,
	bytesFreed: 0,
	held: [],
	orphans: [],
	pointerKept: 0,
};

describe("event retention scheduling", () => {
	let harness: RelayHarness | undefined;
	const cleanup: (() => Promise<void>)[] = [];
	const evidence: Record<string, unknown> = {};

	afterEach(async () => {
		await harness?.stop();
		harness = undefined;
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
		vi.restoreAllMocks();
		mkdirSync("test-results/event-retention", { recursive: true });
		writeFileSync(
			"test-results/event-retention/scheduling.json",
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
	});

	// Failure modes: lost kicks behind publication/callbacks, concurrent drains,
	// more than one queued rerun, or a startup backlog waiting for another delete.
	it("collapses committed deletions during a drain into one rerun", async () => {
		harness = await createRelayHarness();
		const runtime = harness.stack.effectRuntime.runtime;
		const retention = await runtime.runPromise(EventRetentionTag);
		const gate = Deferred.makeUnsafe<void>();
		const drains = vi
			.spyOn(retention, "drain")
			.mockImplementationOnce(() =>
				Deferred.await(gate).pipe(Effect.as(emptyReport)),
			)
			.mockReturnValue(Effect.succeed(emptyReport));
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const session = await client.createSession("Retention schedule", {
			providerId: "opencode",
		});
		await client.deleteSession(String(session["id"]));
		await vi.waitFor(() => expect(drains).toHaveBeenCalledTimes(1));
		// Markers for already absent sessions must kick too, including quiet commits.
		for (let index = 0; index < 5; index++) {
			const sessionId = `retention-quiet-death-${index}`;
			await runtime.runPromise(
				Effect.flatMap(makeCommitAndSignal, (commit) =>
					commit(
						[canonicalEvent("session.deleted", sessionId, { sessionId })],
						{ publish: false },
					),
				),
			);
		}
		expect(drains).toHaveBeenCalledTimes(1);
		await runtime.runPromise(Deferred.succeed(gate, undefined));
		await vi.waitFor(() => expect(drains).toHaveBeenCalledTimes(2));
		// A later commit starts a fresh run, rather than leaving the worker stuck.
		await runtime.runPromise(
			Effect.flatMap(makeCommitAndSignal, (commit) =>
				commit([
					canonicalEvent("session.deleted", "retention-later-death", {
						sessionId: "retention-later-death",
					}),
				]),
			),
		);
		await vi.waitFor(() => expect(drains).toHaveBeenCalledTimes(3));
		evidence["coalescing"] = {
			deletionCommits: 7,
			drains: drains.mock.calls.length,
		};
	});

	it("logs a failed drain and drains successfully on the next committed deletion", async () => {
		harness = await createRelayHarness();
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const session = await client.createSession("Retention retry", {
			providerId: "opencode",
		});
		const sessionId = String(session["id"]);
		// Let the startup drain finish before injecting a failure for this delete.
		const retention = await runtime.runPromise(EventRetentionTag);
		const drain = retention.drain;
		const failure = new SqlError({
			reason: new UnknownError({
				cause: "retention-first-drain-failure",
				message: "retention-first-drain-failure",
			}),
		});
		const reports: DrainReport[] = [];
		const logs = vi.spyOn(Logger.defaultLogger, "log");
		const drains = vi
			.spyOn(retention, "drain")
			.mockImplementationOnce(() => Effect.fail(failure))
			.mockImplementation(() =>
				drain().pipe(
					Effect.tap((report) => Effect.sync(() => reports.push(report))),
				),
			);
		const failures = () =>
			logs.mock.calls
				.map(([entry]) => entry)
				.filter(
					(entry) =>
						entry.logLevel === "Error" &&
						Array.isArray(entry.message) &&
						entry.message[0] === "Event retention drain failed",
				);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			await client.deleteSession(sessionId);
			await vi.waitFor(() => expect(failures()).toHaveLength(1));
			expect(drains).toHaveBeenCalledTimes(1);
			expect(failures()[0]?.message).toEqual([
				"Event retention drain failed",
				expect.objectContaining({
					projectId: "integration-test",
					cause: expect.anything(),
				}),
			]);
			expect(JSON.stringify(failures()[0]?.message)).toContain(
				"retention-first-drain-failure",
			);
			expect(
				db
					.prepare(
						"SELECT sequence FROM events WHERE session_id = ? AND type <> 'session.deleted'",
					)
					.all(sessionId),
			).not.toHaveLength(0);
			// Wait for the error log before committing again, so this is a fresh
			// kick after failure rather than the original run's queued rerun.
			const kickSessionId = "retention-after-failure-kick";
			await runtime.runPromise(
				Effect.flatMap(makeCommitAndSignal, (commit) =>
					commit(
						[
							canonicalEvent("session.deleted", kickSessionId, {
								sessionId: kickSessionId,
							}),
						],
						{ publish: false },
					),
				),
			);
			await vi.waitFor(() => {
				expect(drains).toHaveBeenCalledTimes(2);
				expect(reports).toHaveLength(1);
				expect(
					db
						.prepare("SELECT type FROM events WHERE session_id = ?")
						.all(sessionId),
				).toEqual([{ type: "session.deleted" }]);
			});
			expect(reports[0]?.sessionsFreed).toBe(1);
			expect(reports[0]?.eventsFreed).toBeGreaterThan(0);
			expect(reports[0]?.pointerKept).toBe(0);
			expect(failures()).toHaveLength(1);
			evidence["failure-recovery"] = {
				sessionId,
				kickSessionId,
				drains: drains.mock.calls.length,
				error: failures()[0]?.message,
				reports,
			};
		} finally {
			db.close();
		}
	});

	it("reclaims an existing backlog once at relay startup", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-retention-startup-"));
		const filename = join(directory, "events.db");
		cleanup.push(async () =>
			rmSync(directory, { recursive: true, force: true }),
		);
		const store = ManagedRuntime.make(makePersistenceStoreLayer(filename));
		cleanup.push(() => store.dispose());
		const context = await store.runPromise(
			Effect.context<PersistenceStoreContext>(),
		);
		await store.runPromise(
			Effect.gen(function* () {
				const events = yield* makeEventStoreEffect;
				yield* events.appendBatch([
					canonicalEvent("session.created", "retention-startup-dead", {
						sessionId: "retention-startup-dead",
						title: "Deleted before restart",
						provider: "opencode",
					}),
					canonicalEvent("session.deleted", "retention-startup-dead", {
						sessionId: "retention-startup-dead",
					}),
				]);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}).pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: "integration-test",
				}),
			),
		);
		harness = await createRelayHarness("chat-simple", {
			configDir: directory,
			daemonConfigContext: Context.make(PersistenceStore, context),
		});
		const db = new Database(filename, { readonly: true });
		try {
			await vi.waitFor(() => {
				expect(
					db
						.prepare("SELECT type FROM events WHERE session_id = ?")
						.all("retention-startup-dead"),
				).toEqual([{ type: "session.deleted" }]);
			});
			evidence["startup"] = {
				sessionId: "retention-startup-dead",
				remainingTypes: ["session.deleted"],
			};
		} finally {
			db.close();
		}
	});
});
