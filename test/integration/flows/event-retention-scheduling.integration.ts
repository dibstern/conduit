import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DrainReport,
	EventRetentionTag,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { _getOutputStream } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceStoreLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

const emptyReport: DrainReport = {
	sessionsFreed: 0,
	eventsFreed: 0,
	bytesFreed: 0,
	held: [],
	orphans: [],
	pointerKept: 0,
};

describe("event retention scheduling", () => {
	let harness: DaemonProject | undefined;
	const cleanup: (() => Promise<void>)[] = [];
	const evidence: Record<string, unknown> = {};

	beforeEach(() => {
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async () => {
		try {
			await harness?.stop();
			harness = undefined;
			for (const dispose of cleanup.splice(0).reverse()) await dispose();
			vi.restoreAllMocks();
			mkdirSync("test-results/event-retention", { recursive: true });
			writeFileSync(
				"test-results/event-retention/scheduling.json",
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
		} finally {
			__setProbeOverrideForTesting(undefined);
		}
	});

	// Failure modes: lost kicks behind publication/callbacks, concurrent drains,
	// more than one queued rerun, or a startup backlog waiting for another delete.
	it("collapses committed deletions during a drain into one rerun", async () => {
		harness = await createDaemonProject();
		const run = harness.run;
		const retention = await run(EventRetentionTag);
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
			await run(
				Effect.flatMap(makeCommitAndSignal, (commit) =>
					commit(
						[canonicalEvent("session.deleted", sessionId, { sessionId })],
						{ publish: false },
					),
				),
			);
		}
		expect(drains).toHaveBeenCalledTimes(1);
		await run(Deferred.succeed(gate, undefined));
		await vi.waitFor(() => expect(drains).toHaveBeenCalledTimes(2));
		// A later commit starts a fresh run, rather than leaving the worker stuck.
		await run(
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
		harness = await createDaemonProject();
		const run = harness.run;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const session = await client.createSession("Retention retry", {
			providerId: "opencode",
		});
		const sessionId = String(session["id"]);
		// Let the startup drain finish before injecting a failure for this delete.
		const retention = await run(EventRetentionTag);
		const drain = retention.drain;
		const failure = new SqlError({
			reason: new UnknownError({
				cause: "retention-first-drain-failure",
				message: "retention-first-drain-failure",
			}),
		});
		const reports: DrainReport[] = [];
		// The daemon logs Effect errors through Pino as JSON lines.
		const logs = vi.spyOn(_getOutputStream(), "write");
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
				.map(([chunk]): { level: number; msg: string } =>
					JSON.parse(String(chunk)),
				)
				.filter(
					(line) =>
						line.level === 50 &&
						line.msg.startsWith("Event retention drain failed "),
				);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			await client.deleteSession(sessionId);
			await vi.waitFor(() => expect(failures()).toHaveLength(1));
			expect(drains).toHaveBeenCalledTimes(1);
			const logged = JSON.parse(
				failures()[0]?.msg.slice("Event retention drain failed ".length) ??
					"{}",
			);
			expect(logged).toEqual({
				projectId: "integration-test",
				cause: expect.anything(),
			});
			expect(JSON.stringify(logged.cause)).toContain(
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
			await run(
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
				error: failures()[0]?.msg,
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
		// The daemon opens <configDir>/events.db itself, so the seeding store closes first.
		await store.dispose();
		harness = await createDaemonProject("chat-simple", {
			configDir: directory,
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
