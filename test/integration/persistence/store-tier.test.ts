// Failure modes and test seams: docs/plans/2026-10-16-store-tier-failure-modes.md.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceServiceTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	makePersistenceProjectLayer,
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import * as migrations from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProjectorCursorEffectTag } from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	EventId,
} from "../../../src/lib/persistence/events.js";
import {
	daemonStoreManifest,
	projectManifest,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";

afterEach(() => vi.restoreAllMocks());

// Match the relay's daemonConfigContext path: these layers borrow the built
// Context. They must not acquire the store layer inside either project scope.
function projectLayer(
	projectId: string,
	store: Context.Context<PersistenceStoreContext>,
) {
	const config = { daemonConfigContext: Context.make(PersistenceStore, store) };
	const shared = Context.get(config.daemonConfigContext, PersistenceStore);
	return makePersistenceProjectLayer(projectId).pipe(
		Layer.provideMerge(Layer.succeedContext(shared)),
	);
}

function events(project: string, suffix: string) {
	const sessionId = `${project}-${suffix}`;
	const messageId = `${sessionId}-message`;
	const options = (kind: string) => ({
		provider: "claude",
		createdAt: 1000,
		eventId: Schema.decodeSync(EventId)(`evt_${sessionId}-${kind}`),
	});
	return [
		canonicalEvent(
			"session.created",
			sessionId,
			{
				sessionId,
				title: sessionId,
				provider: "claude",
			},
			options("session"),
		),
		canonicalEvent(
			"message.created",
			sessionId,
			{
				sessionId,
				messageId,
				role: "assistant",
			},
			options("message"),
		),
		canonicalEvent(
			"text.delta",
			sessionId,
			{
				messageId,
				partId: `${messageId}-text`,
				text: `Hello ${sessionId}`,
			},
			options("text"),
		),
	];
}

function readProject(projectId: string) {
	return Effect.gen(function* () {
		const query = yield* ReadQueryEffectTag;
		const sessions = yield* query.listSessions({ projectIds: [projectId] });
		return yield* Effect.forEach(
			[...sessions].sort((a, b) => a.id.localeCompare(b.id)),
			(session) =>
				Effect.gen(function* () {
					const messages = yield* query.getSessionMessagesWithParts(session.id);
					return {
						id: session.id,
						projectId: session.project_id,
						messages: messages.map((message) => ({
							id: message.id,
							text: message.parts.map((part) => part.text).join(""),
						})),
					};
				}),
		);
	});
}

const expectedSession = (projectId: string, suffix: string) => ({
	id: `${projectId}-${suffix}`,
	projectId,
	messages: [
		{
			id: `${projectId}-${suffix}-message`,
			text: `Hello ${projectId}-${suffix}`,
		},
	],
});

// The helper hash already normalizes identities and time. Normalize those
// fields in the full manifest as well so the evidence includes stable rows.
function normalized(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((item) => normalized(item, key));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([field, item]) => [
				field,
				key === "store_identity" && field === "value"
					? "store-identity"
					: normalized(item, field),
			]),
		);
	if (/(?:_at|At|Timestamp|last_activity)$/.test(key) && value !== null)
		return "time";
	return value;
}

describe("store and project persistence tiers", () => {
	it("isolates projects, serializes store-wide recovery and borrows store lifetime", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-store-tier-"));
		const filename = join(root, "events.db");
		const projected = new Map<string, number>();
		const counter: EffectProjector = {
			name: "store-tier-count",
			handles: ["session.created", "message.created", "text.delta"],
			project: (event) =>
				Effect.gen(function* () {
					yield* Effect.yieldNow();
					projected.set(event.eventId, (projected.get(event.eventId) ?? 0) + 1);
					return { stamped: [], removed: [], collections: [] };
				}),
		};
		const store = ManagedRuntime.make(
			makePersistenceStoreLayer(filename, [
				...createAllEffectProjectors(),
				counter,
			]),
		);
		try {
			const context = await store.runPromise(
				Effect.context<PersistenceStoreContext>(),
			);
			const storeRunner = Context.get(context, ProjectionRunnerEffectTag);
			const a = ManagedRuntime.make(projectLayer("alpha", context));
			const b = ManagedRuntime.make(projectLayer("beta", context));
			try {
				for (const runtime of [a, b]) {
					const runner = await runtime.runPromise(ProjectionRunnerEffectTag);
					expect(runner).toBe(storeRunner);
					await runtime.runPromise(runner.recover());
				}
				for (const [runtime, project] of [
					[a, "alpha"],
					[b, "beta"],
				] as const)
					await runtime.runPromise(
						Effect.gen(function* () {
							const eventStore = yield* EventStoreEffectTag;
							const runner = yield* ProjectionRunnerEffectTag;
							yield* runner.projectBatch(
								yield* eventStore.appendBatch(events(project, "live")),
							);
						}),
					);
				expect(await a.runPromise(readProject("alpha"))).toEqual([
					expectedSession("alpha", "live"),
				]);
				expect(await b.runPromise(readProject("beta"))).toEqual([
					expectedSession("beta", "live"),
				]);
				for (const [runtime, project] of [
					[a, "alpha"],
					[b, "beta"],
				] as const)
					await runtime.runPromise(
						Effect.flatMap(EventStoreEffectTag, (eventStore) =>
							eventStore.appendBatch(events(project, "tail")),
						),
					);
				const cursors = Context.get(context, ProjectorCursorEffectTag);
				const listAll = cursors.listAll;
				// Yield after releasing the SELECT's connection lock. Without the
				// recovery semaphore both callers now replay from stale cursors.
				const cursorReads = vi
					.spyOn(cursors, "listAll")
					.mockImplementation(() =>
						listAll().pipe(Effect.tap(() => Effect.sleep("25 millis"))),
					);
				const results = await Promise.all(
					[a, b].map((runtime) =>
						runtime.runPromise(
							Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
								runner.recover(),
							),
						),
					),
				);
				cursorReads.mockRestore();
				expect(projected.size).toBe(12);
				expect([...projected.values()]).toEqual(Array(12).fill(1));
				expect(
					results.filter((result) => result.totalReplayed === 0),
				).toHaveLength(1);
				const readsA = await a.runPromise(readProject("alpha"));
				expect(readsA).toEqual([
					expectedSession("alpha", "live"),
					expectedSession("alpha", "tail"),
				]);
				await a.dispose();
				await b.runPromise(
					Effect.gen(function* () {
						const eventStore = yield* EventStoreEffectTag;
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.projectBatch(
							yield* eventStore.appendBatch(events("beta", "after-close")),
						);
					}),
				);
				const readsB = await b.runPromise(readProject("beta"));
				expect(readsB).toEqual([
					expectedSession("beta", "after-close"),
					expectedSession("beta", "live"),
					expectedSession("beta", "tail"),
				]);
				const manifest = daemonStoreManifest(filename);
				writeImportArtifact("test-results/82tn6-store-tier.json", {
					manifest: {
						hash: manifest.hash,
						tables: normalized(manifest.tables),
					},
					projects: [
						{
							projectId: "alpha",
							hash: projectManifest(filename, "alpha").hash,
							reads: readsA,
						},
						{
							projectId: "beta",
							hash: projectManifest(filename, "beta").hash,
							reads: readsB,
						},
					],
				});
			} finally {
				await a.dispose();
				await b.dispose();
			}
		} finally {
			await store.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens a project without migrating or stamping existing commands and provider metadata", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-store-tier-stamp-"));
		const filename = join(root, "events.db");
		const store = ManagedRuntime.make(makePersistenceStoreLayer(filename));
		try {
			const context = await store.runPromise(
				Effect.context<PersistenceStoreContext>(),
			);
			await store.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key)
					VALUES ('alpha-command', 'alpha-session', 'accepted', 1000, 'alpha')`;
					yield* sql`INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at)
					VALUES ('alpha', 10, 1, 1000), ('beta', 5, 1, 1000)`;
				}),
			);
			const before = daemonStoreManifest(filename);
			const migrator = migrations.makeEffectSqlMigrator;
			const migrationRuns = vi.fn();
			vi.spyOn(migrations, "makeEffectSqlMigrator").mockImplementation(
				(...args) =>
					Effect.sync(migrationRuns).pipe(Effect.zipRight(migrator(...args))),
			);
			const b = ManagedRuntime.make(projectLayer("beta", context));
			try {
				await b.runPromise(EventStoreEffectTag);
				expect(migrationRuns).not.toHaveBeenCalled();
				expect(daemonStoreManifest(filename)).toEqual(before);
			} finally {
				await b.dispose();
			}
		} finally {
			await store.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("memoizes each per-file composition while keeping separate compositions independent", async () => {
		const first =
			Context.GenericTag<PersistenceServiceTag["Type"]>("FirstStore");
		const second =
			Context.GenericTag<PersistenceServiceTag["Type"]>("SecondStore");
		const alpha = makePersistenceEffectLayer(":memory:", "alpha");
		const beta = makePersistenceEffectLayer(":memory:", "beta");
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				alpha,
				Layer.effect(first, PersistenceServiceTag).pipe(Layer.provide(alpha)),
				Layer.effect(second, PersistenceServiceTag).pipe(Layer.provide(beta)),
			),
		);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const a = yield* first;
					const b = yield* second;
					expect(a.sql).toBe(yield* SqlClient.SqlClient);
					expect(a.projectId).toBe("alpha");
					expect(b.projectId).toBe("beta");
					expect(a.sql).not.toBe(b.sql);
					yield* a.sql`CREATE TABLE composition_probe (value TEXT)`;
					expect(
						yield* b.sql`SELECT name FROM sqlite_master WHERE name = 'composition_probe'`,
					).toEqual([]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
