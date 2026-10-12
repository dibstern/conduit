import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";
// Failure modes:
// - A crash leaves a durable event ahead of its projection or cursor.
// - A merged crash simulation omits the store's required project owner.
// - Producers publish before another connection can read their projection.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

it("a kill after append leaves no durable event ahead of its projection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-atomic-crash-"));
	const filename = join(dir, "events.db");
	const killed = join(dir, "killed.db");
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('crash-session', 'opencode', 'Before', 1, 1)`;
				const store = yield* makeEventStoreEffect;
				const cursors = yield* makeProjectorCursorEffect;
				const runner = yield* makeProjectionRunnerEffect([
					{
						name: "kill-before-projection",
						handles: ["session.renamed"],
						// A kill here leaves the files exactly as they are now: SQLite's
						// unwritten pages are lost and no rollback runs. Copying them is
						// that kill, without a child process whose startup races a timer.
						project: () =>
							Effect.sync(() => {
								copyFileSync(filename, killed);
								if (existsSync(`${filename}-wal`))
									copyFileSync(`${filename}-wal`, `${killed}-wal`);
							}).pipe(Effect.andThen(Effect.die("killed"))),
					},
					...createAllEffectProjectors(),
				]).pipe(Effect.provideService(ProjectorCursorEffectTag, cursors));
				yield* runner.markRecovered();
				const commit = yield* makeCommitAndSignal.pipe(
					Effect.provideService(EventStoreEffectTag, store),
					Effect.provideService(ProjectionRunnerEffectTag, runner),
				);
				yield* Effect.exit(
					commit([
						canonicalEvent("session.renamed", "crash-session", {
							sessionId: "crash-session",
							title: "After",
						}),
					]),
				);
			}).pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: "test-project",
				}),
				Effect.provide(EffectSqliteClient.layer({ filename })),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT title FROM sessions WHERE id = 'crash-session'`,
				).toEqual([{ title: "Before" }]);
				expect(
					yield* sql`SELECT type FROM events WHERE session_id = 'crash-session'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT last_applied_seq FROM projector_cursors`,
				).toEqual([]);
			}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: killed }))),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	"batch",
	"claude",
	"command",
])("%s publishes only after another connection can read the committed projection", async (producer) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-atomic-publish-"));
	const filename = join(dir, "events.db");
	const observed: unknown[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () =>
			Effect.gen(function* () {
				const rows = yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						sessions:
							yield* sql`SELECT title FROM sessions WHERE id = 'published'`,
						events:
							yield* sql`SELECT type FROM events WHERE session_id = 'published'`,
					};
				}).pipe(
					Effect.provide(EffectSqliteClient.layer({ filename })),
					Effect.orDie,
				);
				observed.push(rows);
			}),
		publishAdvance: () => Effect.void,
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	});
	const persistence = makePersistenceEffectLayer(
		filename,
		"test-project",
		createAllEffectProjectors(),
		bus,
	);
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('published', 'claude', 'Before', 1, 1)`;
				const commit = yield* makeCommitAndSignal;
				yield* commit(
					[
						canonicalEvent(
							"session.created",
							"published",
							{ sessionId: "published", title: "Before", provider: "claude" },
							{ provider: "claude" },
						),
					],
					{ publish: false },
				);
				const event = canonicalEvent(
					"session.renamed",
					"published",
					{ sessionId: "published", title: "After" },
					{ provider: "claude" },
				);
				if (producer === "batch") {
					yield* commit([event]);
				} else if (producer === "claude") {
					const claude = yield* ClaudeEventPersistEffectTag;
					yield* claude.persistEvent(event);
				} else {
					yield* applySessionCommand({
						type: "session.renamed",
						data: { sessionId: "published", title: "After" },
					});
				}
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						persistence,
						bus,
						Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
						Layer.succeed(ConfigTag, makeMockConfig()),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					),
				),
			),
		);
		expect(observed).toEqual([
			{
				sessions: [{ title: "After" }],
				events: [{ type: "session.created" }, { type: "session.renamed" }],
			},
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("failed establishment validation rolls back the seed, event and projections", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-atomic-establish-"));
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		"test-project",
		createAllEffectProjectors().filter(
			(projector) => projector.name !== "provider",
		),
	);
	const layer = makeTestHandlerLayer({ persistenceLayer: persistence });
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const manager = yield* SessionManagerServiceTag;
				const store = yield* EventStoreEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const result = yield* Effect.either(
					manager.establishOpenCodeSession(
						{
							id: "failed-establishment",
							projectID: "project",
							directory: "/tmp/project",
							title: "Failed",
							version: "1",
							time: { created: 1, updated: 1 },
						},
						MANAGED_OPENCODE_ACCOUNT_ID,
					),
				);
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.operation).toBe(
						"establishOpenCodeSession.project",
					);
				expect(
					yield* readQuery.getSession("failed-establishment"),
				).toBeUndefined();
				expect(yield* store.readBySession("failed-establishment")).toEqual([]);
			}).pipe(Effect.provide(layer)),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
