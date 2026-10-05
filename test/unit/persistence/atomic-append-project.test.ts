import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
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
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
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
	try {
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				fileURLToPath(
					new URL("./fixtures/atomic-append-crash.ts", import.meta.url),
				),
				filename,
			],
			{ encoding: "utf8", timeout: 8000 },
		);
		expect(child.stderr).toBe("");
		expect(child.signal).toBe("SIGKILL");
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
			}).pipe(Effect.provide(EffectSqliteClient.layer({ filename }))),
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
						defaultInstanceIdForDriver("opencode"),
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
