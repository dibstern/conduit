import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Queue,
	Ref,
	TestClock,
} from "effect";
import { expect, vi } from "vitest";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	type DaemonConfig,
	resolveInstanceDriver,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	loadForkMetadata,
	saveForkMetadata,
} from "../../../src/lib/daemon/fork-metadata.js";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	type OpenCodeInstanceClients,
	OpenCodeInstanceClientsTag,
} from "../../../src/lib/domain/relay/Services/opencode-instance-clients.js";
import {
	RelayStatusSnapshotLive,
	RelayStatusSnapshotTag,
} from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	StatusPollerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	addToParentMap,
	clearPaginationCursor,
	decrementPendingQuestionCount,
	getSessionParentMap,
	incrementPendingQuestionCount,
	listSessions,
	loadHistory,
	loadPreRenderedHistory,
	recordMessageActivity,
	renameSession,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
	seedPaginationCursor,
	sendDualSessionLists,
	setForkEntry,
	setPendingQuestionCounts,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	makeOverridesStateLive,
	setDefaultModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	createAllEffectProjectors,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../src/lib/provider/provider-session-binding-read-model.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockStatusPoller,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		last_message_at: null,
		permission_mode: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

function makeReadQueryEffect(rows: readonly SessionRow[]): ReadQueryEffect {
	return {
		getToolContent: vi.fn(() => Effect.succeed(undefined)),
		getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
		getSession: vi.fn((sessionId: string) =>
			Effect.succeed(rows.find((row) => row.id === sessionId)),
		),
		getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
		listSessions: vi.fn(() => Effect.succeed(rows)),
		getSessionDetailSnapshot: vi.fn(() =>
			Effect.succeed({ messages: [], sequence: 0 }),
		),
		getSessionListSnapshot: vi.fn(() =>
			Effect.succeed({ rows: [], sequence: 0 }),
		),
		getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
	};
}

function makeNamedOpenCodeDaemonConfig(): DaemonConfig {
	return {
		pid: process.pid,
		port: 2633,
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		dangerouslySkipPermissions: false,
		projects: [],
		instances: [
			{
				id: "work-oc",
				name: "Work OpenCode",
				port: 4096,
				managed: false,
				driver: "opencode",
			},
		],
	};
}

function makeRelayConfig(configDir: string): ProjectRelayConfig {
	return {
		httpServer: createServer(),
		opencodeUrl: "http://localhost:4096",
		projectDir: "/tmp/project",
		slug: "project",
		configDir,
	};
}

function seedProjectedSessionBinding(
	dbFile: string,
	sessionId: string,
	providerId: string,
): void {
	const db = SqliteClient.open(dbFile);
	try {
		runMigrations(db, schemaMigrations);
		const now = 1_735_689_600_000;
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[sessionId, providerId, "Persisted session", "idle", now, now],
		);
		db.execute(
			"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
			[`${sessionId}:initial`, sessionId, providerId, now],
		);
	} finally {
		db.close();
	}
}

function readProjectedDeleteState(dbFile: string, sessionId: string) {
	const db = SqliteClient.open(dbFile);
	try {
		return {
			sessionPresent:
				db.queryOne<{ readonly id: string }>(
					"SELECT id FROM sessions WHERE id = ?",
					[sessionId],
				) !== undefined,
			bindingPresent:
				db.queryOne<{ readonly id: string }>(
					"SELECT id FROM session_providers WHERE session_id = ?",
					[sessionId],
				) !== undefined,
		};
	} finally {
		db.close();
	}
}

function readTombstoneFirstState(dbFile: string, sessionId: string) {
	const projected = readProjectedDeleteState(dbFile, sessionId);
	const db = SqliteClient.open(dbFile);
	try {
		return {
			...projected,
			tombstonePresent:
				db.queryOne<{ readonly type: string }>(
					"SELECT type FROM events WHERE session_id = ? AND type = 'session.deleted'",
					[sessionId],
				) !== undefined,
		};
	} finally {
		db.close();
	}
}

function makeHistoryMessage(
	id: string,
	role: "user" | "assistant" = "assistant",
	text?: string,
): HistoryMessage {
	return {
		id,
		role,
		...(text
			? {
					parts: [
						{
							id: `part-${id}`,
							type: "text",
							text,
						},
					],
				}
			: {}),
	};
}

describe("SessionManagerService", () => {
	it.effect("updates pending question counts in service state", () =>
		Effect.gen(function* () {
			const stateRef = yield* SessionManagerStateTag;

			yield* incrementPendingQuestionCount("session-1");
			yield* incrementPendingQuestionCount("session-1");
			yield* incrementPendingQuestionCount("session-2");

			let state = yield* Ref.get(stateRef);
			expect(HashMap.get(state.pendingQuestionCounts, "session-1")).toEqual(
				Option.some(2),
			);
			expect(HashMap.get(state.pendingQuestionCounts, "session-2")).toEqual(
				Option.some(1),
			);

			yield* decrementPendingQuestionCount("session-1");
			state = yield* Ref.get(stateRef);
			expect(HashMap.get(state.pendingQuestionCounts, "session-1")).toEqual(
				Option.some(1),
			);

			yield* decrementPendingQuestionCount("session-1");
			yield* decrementPendingQuestionCount("missing-session");
			state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-1")).toBe(false);
			expect(HashMap.has(state.pendingQuestionCounts, "missing-session")).toBe(
				false,
			);

			yield* setPendingQuestionCounts(
				new Map([
					["session-3", 3],
					["session-4", 1],
				]),
			);
			state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-2")).toBe(false);
			expect(HashMap.get(state.pendingQuestionCounts, "session-3")).toEqual(
				Option.some(3),
			);
			expect(HashMap.get(state.pendingQuestionCounts, "session-4")).toEqual(
				Option.some(1),
			);
		}).pipe(Effect.provide(makeSessionManagerStateLive())),
	);

	it.effect("live service exposes pending question count operations", () => {
		const api = makeMockOpenCodeAPI();
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			const stateRef = yield* SessionManagerStateTag;

			yield* service.incrementPendingQuestionCount("session-1");
			yield* service.decrementPendingQuestionCount("session-1");

			const state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-1")).toBe(false);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"live service projects pending question counts into session lists",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 10, updated: 20 },
				},
			]);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				yield* service.incrementPendingQuestionCount("session-1");
				yield* service.incrementPendingQuestionCount("session-1");
				let sessions = yield* service.listSessions();
				expect(sessions).toEqual([
					expect.objectContaining({
						id: "session-1",
						pendingQuestionCount: 2,
					}),
				]);

				yield* service.decrementPendingQuestionCount("session-1");
				yield* service.decrementPendingQuestionCount("session-1");
				sessions = yield* service.listSessions();
				expect(sessions).toEqual([
					expect.not.objectContaining({
						pendingQuestionCount: expect.any(Number),
					}),
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.scoped(
		"live service publishes one SessionCreated after create succeeds",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-daemon-event-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "created-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Created",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const sub = yield* subscribeToDaemonEvents;
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("Created", {
					providerId: "opencode",
				});

				expect(session.id).toBe("created-session");
				expect(api.session.create).toHaveBeenCalledWith({ title: "Created" });
				const event = yield* Queue.poll(sub);
				expect(Option.getOrNull(event)).toMatchObject({
					_tag: "SessionCreated",
					sessionId: "created-session",
				});
				const extra = yield* Queue.poll(sub);
				expect(Option.isNone(extra)).toBe(true);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"live service creates a SQLite-backed session without OpenCode when default provider is Claude",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-local-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("Local Claude");
				const sessions = yield* service.listSessions();

				expect(session.id).toMatch(/^ses_/);
				expect(session.title).toBe("Local Claude");
				expect(session.providerID).toBe("claude");
				expect(api.session.create).not.toHaveBeenCalled();
				expect(sessions).toEqual([
					expect.objectContaining({
						id: session.id,
						title: "Local Claude",
					}),
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"live service creates through OpenCode when an OpenCode provider is requested",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-opencode-request-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "opencode-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "OpenCode Session",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry(),
			});
			const bindSession = vi.spyOn(engine, "bindSession");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("OpenCode Session", {
					providerId: "opencode",
				});
				const sessions = yield* service.listSessions();
				const persisted = yield* Effect.sync(() => {
					const db = SqliteClient.open(dbFile);
					try {
						return {
							session: db.queryOne<{
								readonly provider: string;
								readonly provider_sid: string | null;
							}>("SELECT provider, provider_sid FROM sessions WHERE id = ?", [
								session.id,
							]),
							creationCount: db.queryOne<{ readonly count: number }>(
								"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'session.created'",
								[session.id],
							)?.count,
							binding: db.queryOne<{
								readonly id: string;
								readonly provider: string;
								readonly status: string;
							}>(
								"SELECT id, provider, status FROM session_providers WHERE session_id = ? AND status = 'active'",
								[session.id],
							),
						};
					} finally {
						db.close();
					}
				});

				expect(session.id).toBe("opencode-session");
				expect(persisted).toEqual({
					session: {
						provider: "opencode",
						provider_sid: "opencode-session",
					},
					creationCount: 1,
					binding: {
						id: "opencode-session:initial",
						provider: "opencode",
						status: "active",
					},
				});
				expect(api.session.create).toHaveBeenCalledWith({
					title: "OpenCode Session",
				});
				expect(bindSession).toHaveBeenCalledWith(
					"opencode-session",
					"opencode",
				);
				expect(sessions).toEqual([
					expect.objectContaining({
						id: "opencode-session",
						title: "OpenCode Session",
					}),
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"creates an OpenCode session when durable persistence is not configured",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "no-persistence-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "No persistence",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const result = yield* Effect.either(
					service.createSession("No persistence", {
						providerId: "opencode",
					}),
				);

				expect(result).toMatchObject({
					_tag: "Right",
					right: expect.objectContaining({ id: "no-persistence-session" }),
				});
				expect(api.session.create).toHaveBeenCalledOnce();
			}).pipe(Effect.provide(Layer.fresh(layer)));
		},
	);

	it.scoped(
		"establishes a fork-shaped OpenCode child before Claude message persistence",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-fork-establish-${Date.now()}.sqlite`,
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				const child = {
					id: "forked-opencode-child",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Forked Session",
					version: "1.0.0",
					time: { created: 10, updated: 10 },
				};
				yield* service.establishOpenCodeSession(
					child,
					ProviderInstanceIdSchema.make("opencode"),
				);
				yield* persist.persistUserMessage(child.id, "Claude turn on fork");

				const state = yield* Effect.sync(() => {
					const db = SqliteClient.open(dbFile);
					try {
						return {
							session: db.queryOne<{
								provider: string;
								provider_sid: string | null;
							}>("SELECT provider, provider_sid FROM sessions WHERE id = ?", [
								child.id,
							]),
							creations: db.queryOne<{ count: number }>(
								"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'session.created'",
								[child.id],
							)?.count,
							binding: db.queryOne<{ provider: string }>(
								"SELECT provider FROM session_providers WHERE session_id = ? AND status = 'active'",
								[child.id],
							)?.provider,
						};
					} finally {
						db.close();
					}
				});

				expect(state).toEqual({
					session: {
						provider: "opencode",
						provider_sid: child.id,
					},
					creations: 1,
					binding: "opencode",
				});
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"fails establishment when projection does not create an active provider binding",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-project-failure-${Date.now()}.sqlite`,
			);
			const projectors = createAllEffectProjectors().map((projector) =>
				projector.name === "provider"
					? {
							...projector,
							project: () =>
								Effect.fail(
									new ProjectionError({
										projector: "provider",
										operation: "project",
										cause: new Error("provider binding unavailable"),
									}),
								),
						}
					: projector,
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile, projectors),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const result = yield* Effect.either(
					service.establishOpenCodeSession(
						{
							id: "missing-provider-binding",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Missing binding",
							version: "1.0.0",
							time: { created: 10, updated: 10 },
						},
						ProviderInstanceIdSchema.make("opencode"),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				const sessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions WHERE id = 'missing-provider-binding'`;
				const bindings = yield* sql<{ readonly id: string }>`
					SELECT id FROM session_providers WHERE session_id = 'missing-provider-binding'`;
				const creations = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
					WHERE session_id = 'missing-provider-binding' AND type = 'session.created'`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						operation: "establishOpenCodeSession.project",
					}),
				});
				expect(sessions).toEqual([]);
				expect(bindings).toEqual([]);
				expect(creations[0]?.count).toBe(1);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"removes a newly seeded row when canonical establishment append fails",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-append-failure-${Date.now()}.sqlite`,
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql.unsafe(`
					CREATE TRIGGER reject_session_creation_event
					BEFORE INSERT ON events
					WHEN NEW.type = 'session.created'
					BEGIN
						SELECT RAISE(ABORT, 'simulated append failure');
					END
				`);
				const service = yield* SessionManagerServiceTag;
				const result = yield* Effect.either(
					service.establishOpenCodeSession(
						{
							id: "append-failed-session",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Append failed",
							version: "1.0.0",
							time: { created: 10, updated: 10 },
						},
						ProviderInstanceIdSchema.make("opencode"),
					),
				);
				const sessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions WHERE id = 'append-failed-session'`;
				const events = yield* sql<{ readonly id: string }>`
					SELECT event_id AS id FROM events WHERE session_id = 'append-failed-session'`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						operation: "establishOpenCodeSession.append",
					}),
				});
				expect(sessions).toEqual([]);
				expect(events).toEqual([]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"keeps native Claude creation singular after first user-message persistence",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-claude-single-create-${Date.now()}.sqlite`,
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				const session = yield* service.createSession("Native Claude", {
					providerId: "claude",
				});
				yield* persist.persistUserMessage(session.id, "First message");
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(session.id);

				expect(
					events.filter((event) => event.type === "session.created"),
				).toHaveLength(1);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"binds explicitly selected default instances through their config-resolved drivers and persists active bindings",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-manager-instance-binding-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const daemonConfig: DaemonConfig = {
				pid: process.pid,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
			};
			const relayConfig: ProjectRelayConfig = {
				httpServer: createServer(),
				opencodeUrl: "http://localhost:4096",
				projectDir: "/tmp/project",
				slug: "project",
				configDir: tmpDir,
			};
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "opencode-instance-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "OpenCode Instance Session",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry(),
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, relayConfig),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);
			const claudeInstanceId = ProviderInstanceIdSchema.make("claude");
			const openCodeInstanceId = ProviderInstanceIdSchema.make("opencode");

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() => saveDaemonConfig(daemonConfig, tmpDir));
				yield* setDefaultModel({
					providerID: "opencode",
					modelID: "openai/gpt-5",
				});
				const service = yield* SessionManagerServiceTag;

				const claudeSession = yield* service.createSession(
					"Claude Instance Session",
					{ instanceId: claudeInstanceId },
				);
				const openCodeSession = yield* service.createSession(
					"OpenCode Instance Session",
					{ instanceId: openCodeInstanceId },
				);

				const bindings = yield* Effect.sync(() => {
					const db = SqliteClient.open(dbFile);
					try {
						return db.query<{
							readonly session_id: string;
							readonly provider: string;
							readonly status: string;
						}>(
							`SELECT session_id, provider, status
							 FROM session_providers
							 WHERE session_id IN (?, ?) AND status = 'active'
							 ORDER BY session_id`,
							[claudeSession.id, openCodeSession.id],
						);
					} finally {
						db.close();
					}
				});

				expect(bindings).toHaveLength(2);
				const resolvedBindings = Object.fromEntries(
					bindings.map((binding) => [
						binding.session_id,
						{
							instanceId: binding.provider,
							driver: resolveInstanceDriver(
								daemonConfig,
								ProviderInstanceIdSchema.make(binding.provider),
							),
							status: binding.status,
						},
					]),
				);
				expect(resolvedBindings).toEqual({
					[claudeSession.id]: {
						instanceId: "claude",
						driver: "claude",
						status: "active",
					},
					[openCodeSession.id]: {
						instanceId: "opencode",
						driver: "opencode",
						status: "active",
					},
				});
				expect(api.session.create).toHaveBeenCalledOnce();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"persists named OpenCode creation in both the session row and initial provider binding",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-manager-named-create-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const api = makeMockOpenCodeAPI();
			const namedApi = makeMockOpenCodeAPI();
			vi.spyOn(namedApi.session, "create").mockResolvedValue({
				id: "named-opencode-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Named",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const clientFor = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				clientFor,
				registerStreamWirer: () => Effect.void,
			} satisfies OpenCodeInstanceClients;
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry(),
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
				);
				const service = yield* SessionManagerServiceTag;
				const session = yield* service.createSession("Named", {
					instanceId: ProviderInstanceIdSchema.make("work-oc"),
				});
				const bindings = yield* Effect.sync(() => {
					const db = SqliteClient.open(dbFile);
					try {
						return db.query<{
							readonly session_provider: string;
							readonly binding_id: string;
							readonly binding_provider: string;
							readonly binding_status: string;
						}>(
							`SELECT
								sessions.provider AS session_provider,
								session_providers.id AS binding_id,
								session_providers.provider AS binding_provider,
								session_providers.status AS binding_status
							 FROM sessions
							 JOIN session_providers
							   ON session_providers.session_id = sessions.id
							 WHERE sessions.id = ?
							   AND session_providers.status = 'active'`,
							[session.id],
						);
					} finally {
						db.close();
					}
				});

				expect(clientFor).toHaveBeenCalledWith("work-oc");
				expect(api.session.create).not.toHaveBeenCalled();
				expect(namedApi.session.create).toHaveBeenCalledWith({
					title: "Named",
				});
				expect(bindings).toEqual([
					{
						session_provider: "work-oc",
						binding_id: `${session.id}:initial`,
						binding_provider: "work-oc",
						binding_status: "active",
					},
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"live service does not fabricate a local session when requested OpenCode creation fails",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-opencode-fail-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockRejectedValue(
				new Error("OpenCode unavailable"),
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				const result = yield* Effect.either(
					service.createSession("OpenCode Session", {
						providerId: "opencode",
					}),
				);
				const sessions = yield* service.listSessions();

				expect(result._tag).toBe("Left");
				expect(api.session.create).toHaveBeenCalledWith({
					title: "OpenCode Session",
				});
				expect(sessions).toEqual([]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"live service creates a local Claude session before model discovery sets a default provider",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-local-default-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create");
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry(),
			});
			const bindSession = vi.spyOn(engine, "bindSession");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("Local before models");

				expect(session.id).toMatch(/^ses_/);
				expect(session.providerID).toBe("claude");
				expect(api.session.create).not.toHaveBeenCalled();
				expect(bindSession).toHaveBeenCalledWith(session.id, "claude");
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.scoped(
		"deletes locally and records cleanup failure when end_session and provider delete both fail",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-all-fail-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "work-oc");
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const namedApi = makeMockOpenCodeAPI();
			const providerDeleteObservations: ReturnType<
				typeof readTombstoneFirstState
			>[] = [];
			vi.spyOn(namedApi.session, "delete").mockImplementation(async () => {
				providerDeleteObservations.push(
					readTombstoneFirstState(dbFile, sessionId),
				);
				throw new Error("upstream delete unavailable");
			});
			const clientFor = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				clientFor,
				registerStreamWirer: () => Effect.void,
			} satisfies OpenCodeInstanceClients;
			const dispatchObservations: ReturnType<typeof readTombstoneFirstState>[] =
				[];
			const dispatch = vi.fn(() =>
				Effect.sync(() => {
					dispatchObservations.push(readTombstoneFirstState(dbFile, sessionId));
				}).pipe(
					Effect.zipRight(Effect.fail(new Error("orchestration unavailable"))),
				),
			);
			const engine = withDispatchEffect({ dispatchEffect: dispatch });
			engine.bindSession(sessionId, "work-oc");
			const logger = makeMockLogger();
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, logger),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
				);
				const service = yield* SessionManagerServiceTag;
				const stateRef = yield* SessionManagerStateTag;
				yield* Ref.update(stateRef, (state) => ({
					cachedParentMap: HashMap.set(
						HashMap.set(state.cachedParentMap, sessionId, "parent"),
						"child",
						sessionId,
					),
					lastMessageAt: HashMap.set(state.lastMessageAt, sessionId, 123),
					forkMeta: HashMap.set(state.forkMeta, sessionId, {
						forkMessageId: "message-1",
						parentID: "parent",
					}),
					pendingQuestionCounts: HashMap.set(
						state.pendingQuestionCounts,
						sessionId,
						1,
					),
					paginationCursors: HashMap.set(
						state.paginationCursors,
						sessionId,
						"message-1",
					),
					lastKnownSessionCount: 2,
				}));
				const sub = yield* subscribeToDaemonEvents;

				const deleteExit = yield* Effect.exit(service.deleteSession(sessionId));
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);
				const projected = readProjectedDeleteState(dbFile, sessionId);
				const state = yield* Ref.get(stateRef);
				const daemonEvent = Option.getOrNull(yield* Queue.poll(sub));

				expect({
					deleteSucceeded: Exit.isSuccess(deleteExit),
					projected,
					eventTypes: events.map((event) => event.type),
					dispatchCalls: dispatch.mock.calls.length,
					providerDeleteCalls: vi.mocked(namedApi.session.delete).mock.calls
						.length,
					localStateCleared:
						!HashMap.has(state.cachedParentMap, sessionId) &&
						!HashMap.has(state.cachedParentMap, "child") &&
						!HashMap.has(state.lastMessageAt, sessionId) &&
						!HashMap.has(state.forkMeta, sessionId) &&
						!HashMap.has(state.pendingQuestionCounts, sessionId) &&
						!HashMap.has(state.paginationCursors, sessionId),
					sessionCount: state.lastKnownSessionCount,
					daemonEvent: daemonEvent?._tag,
					warnings: vi.mocked(logger.warn).mock.calls.length,
				}).toEqual({
					deleteSucceeded: true,
					projected: {
						sessionPresent: false,
						bindingPresent: false,
					},
					eventTypes: ["session.deleted", "session.provider_cleanup_failed"],
					dispatchCalls: 1,
					providerDeleteCalls: 1,
					localStateCleared: true,
					sessionCount: 1,
					daemonEvent: "SessionDeleted",
					warnings: 1,
				});
				expect(events.at(-1)?.data).toMatchObject({
					reason:
						"end_session: orchestration unavailable; provider_delete: upstream delete unavailable",
				});
				expect(dispatchObservations).toEqual([
					{
						sessionPresent: false,
						bindingPresent: false,
						tombstonePresent: true,
					},
				]);
				expect(providerDeleteObservations).toEqual(dispatchObservations);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"cleans up OpenCode driver state and upstream state without writing a failure receipt",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-opencode-success-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "opencode");
			const api = makeMockOpenCodeAPI();
			const providerDeleteObservations: ReturnType<
				typeof readTombstoneFirstState
			>[] = [];
			vi.spyOn(api.session, "delete").mockImplementation(async () => {
				providerDeleteObservations.push(
					readTombstoneFirstState(dbFile, sessionId),
				);
			});
			const dispatchObservations: ReturnType<typeof readTombstoneFirstState>[] =
				[];
			const dispatch = vi.fn(async () => {
				dispatchObservations.push(readTombstoneFirstState(dbFile, sessionId));
			});
			const engine = withDispatchEffect({ dispatch });
			engine.bindSession(sessionId, "opencode");
			const logger = makeMockLogger();
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, logger),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* service.deleteSession(sessionId);
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);

				expect(dispatch).toHaveBeenCalledOnce();
				expect(dispatch).toHaveBeenCalledWith({
					type: "end_session",
					commandId: expect.any(String),
					sessionId,
					targetProviderId: "opencode",
					unbind: true,
				});
				expect(api.session.delete).toHaveBeenCalledOnce();
				expect(api.session.delete).toHaveBeenCalledWith(sessionId);
				expect(dispatchObservations).toEqual([
					{
						sessionPresent: false,
						bindingPresent: false,
						tombstonePresent: true,
					},
				]);
				expect(providerDeleteObservations).toEqual(dispatchObservations);
				expect(events.map((event) => event.type)).toEqual(["session.deleted"]);
				expect(logger.warn).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped("coalesces concurrent deletes of the same session", () => {
		const tmpDir = mkdtempSync(
			join(tmpdir(), "conduit-session-delete-single-flight-"),
		);
		const dbFile = join(tmpDir, "events.sqlite");
		const sessionId = "concurrently-deleted-session";
		seedProjectedSessionBinding(dbFile, sessionId, "opencode");

		return Effect.gen(function* () {
			const cleanupStarted = yield* Deferred.make<void>();
			const releaseCleanup = yield* Deferred.make<void>();
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockImplementation(() =>
				Effect.runPromise(
					Deferred.succeed(cleanupStarted, undefined).pipe(
						Effect.zipRight(Deferred.await(releaseCleanup)),
					),
				),
			);
			const dispatch = vi.fn(() => Effect.void);
			const engine = withDispatchEffect({ dispatchEffect: dispatch });
			engine.bindSession(sessionId, "opencode");
			dispatch.mockImplementation(() =>
				Effect.sync(() => engine.unbindSession(sessionId)),
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					RelayStatusSnapshotLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			yield* Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const stateRef = yield* SessionManagerStateTag;
				const relayStatus = yield* RelayStatusSnapshotTag;
				const daemonEvents = yield* subscribeToDaemonEvents;
				yield* Ref.update(stateRef, (state) => ({
					...state,
					lastKnownSessionCount: 2,
				}));

				const winner = yield* Effect.fork(service.deleteSession(sessionId));
				yield* Deferred.await(cleanupStarted);
				const follower = yield* Effect.fork(service.deleteSession(sessionId));
				yield* Effect.yieldNow();
				yield* Deferred.succeed(releaseCleanup, undefined);

				const outcomes = [
					yield* Fiber.join(winner),
					yield* Fiber.join(follower),
				];
				const eventStore = yield* EventStoreEffectTag;
				const persistedEvents = yield* eventStore.readAllBySession(sessionId);
				const state = yield* Ref.get(stateRef);
				const publishedEvents = yield* Queue.takeAll(daemonEvents);

				expect(outcomes).toEqual([true, false]);
				expect(
					persistedEvents.filter((event) => event.type === "session.deleted"),
				).toHaveLength(1);
				expect(
					persistedEvents.filter(
						(event) => event.type === "session.provider_cleanup_failed",
					),
				).toHaveLength(0);
				expect(dispatch).toHaveBeenCalledOnce();
				expect(api.session.delete).toHaveBeenCalledOnce();
				expect(state.lastKnownSessionCount).toBe(1);
				expect(relayStatus.getSnapshot().sessionCount).toBe(1);
				expect(
					Array.from(publishedEvents).filter(
						(event) => event._tag === "SessionDeleted",
					),
				).toHaveLength(1);
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
			),
		);
	});

	it.scoped(
		"persists a queryable named-instance cleanup failure receipt with log-safe detail",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-receipt-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "work-oc");
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const namedApi = makeMockOpenCodeAPI();
			const deleteError = new Error("named instance unavailable");
			deleteError.stack =
				"Error: named instance unavailable\nUNIQUE_DELETE_STACK_SENTINEL";
			vi.spyOn(namedApi.session, "delete").mockRejectedValue(deleteError);
			const clientFor = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				clientFor,
				registerStreamWirer: () => Effect.void,
			} satisfies OpenCodeInstanceClients;
			const dispatch = vi.fn(async () => undefined);
			const engine = withDispatchEffect({ dispatch });
			engine.bindSession(sessionId, "work-oc");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
				);
				const service = yield* SessionManagerServiceTag;
				const deleteExit = yield* Effect.exit(service.deleteSession(sessionId));
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);
				const receipt = events.find(
					(event) => event.type === "session.provider_cleanup_failed",
				);

				expect(receipt).toMatchObject({
					type: "session.provider_cleanup_failed",
					sessionId,
					provider: "opencode",
					data: {
						sessionId,
						provider: "opencode",
						instanceId: "work-oc",
						reason: "provider_delete: named instance unavailable",
					},
				});
				expect(Exit.isSuccess(deleteExit)).toBe(true);
				expect(receipt?.data.reason).not.toContain(
					"UNIQUE_DELETE_STACK_SENTINEL",
				);
				expect(events.map((event) => event.type)).toEqual([
					"session.deleted",
					"session.provider_cleanup_failed",
				]);
				expect(readProjectedDeleteState(dbFile, sessionId).sessionPresent).toBe(
					false,
				);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"still deletes locally and records a receipt when cleanup detail rendering throws",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-render-defect-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "work-oc");
			const api = makeMockOpenCodeAPI();
			const namedApi = makeMockOpenCodeAPI();
			const nestedFormattingError = new OpenCodeApiError({
				message: "nested formatting failed",
				endpoint: `/session/${sessionId}`,
				responseStatus: 500,
				responseBody: { invalidJsonNumber: 1n },
			});
			const responseBody = {};
			Object.defineProperty(responseBody, "detail", {
				enumerable: true,
				get: () => {
					throw nestedFormattingError;
				},
			});
			vi.spyOn(namedApi.session, "delete").mockRejectedValue(
				new OpenCodeApiError({
					message: "provider rejected cleanup",
					endpoint: `/session/${sessionId}`,
					responseStatus: 500,
					responseBody,
				}),
			);
			const instanceClients = {
				clientFor: vi.fn(() => Effect.succeed(namedApi)),
				registerStreamWirer: () => Effect.void,
			} satisfies OpenCodeInstanceClients;
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => undefined),
			});
			engine.bindSession(sessionId, "work-oc");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
				);
				const service = yield* SessionManagerServiceTag;
				const deleteExit = yield* Effect.exit(service.deleteSession(sessionId));
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);
				const receipt = events.find(
					(event) => event.type === "session.provider_cleanup_failed",
				);

				expect(Exit.isSuccess(deleteExit)).toBe(true);
				expect(receipt?.data.reason).toBe(
					"provider_delete: cleanup error detail unavailable",
				);
				expect(events.map((event) => event.type)).toEqual([
					"session.deleted",
					"session.provider_cleanup_failed",
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped("bounds the durable provider cleanup failure reason", () => {
		const tmpDir = mkdtempSync(
			join(tmpdir(), "conduit-session-delete-bounded-reason-"),
		);
		const dbFile = join(tmpDir, "events.sqlite");
		const sessionId = "deleted-session";
		seedProjectedSessionBinding(dbFile, sessionId, "work-oc");
		const api = makeMockOpenCodeAPI();
		const namedApi = makeMockOpenCodeAPI();
		vi.spyOn(namedApi.session, "delete").mockRejectedValue(
			new OpenCodeApiError({
				message: "oversized provider rejection",
				endpoint: `/session/${sessionId}`,
				responseStatus: 500,
				responseBody: { detail: "x".repeat(100_000) },
			}),
		);
		const instanceClients = {
			clientFor: vi.fn(() => Effect.succeed(namedApi)),
			registerStreamWirer: () => Effect.void,
		} satisfies OpenCodeInstanceClients;
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => undefined),
		});
		engine.bindSession(sessionId, "work-oc");
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				makePersistenceEffectLayer(dbFile),
				Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
				Layer.succeed(OrchestrationEngineTag, engine),
			),
		);

		return Effect.gen(function* () {
			yield* Effect.tryPromise(() =>
				saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
			);
			const service = yield* SessionManagerServiceTag;
			yield* service.deleteSession(sessionId);
			const eventStore = yield* EventStoreEffectTag;
			const events = yield* eventStore.readAllBySession(sessionId);
			const receipt = events.find(
				(event) => event.type === "session.provider_cleanup_failed",
			);

			expect(receipt?.data.reason.length).toBeLessThanOrEqual(4_000);
			expect(receipt?.data.reason).toContain("... [truncated]");
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.ensuring(
				Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
			),
		);
	});

	it.scoped(
		"dispatches Claude end_session after the tombstone is projected",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-claude-order-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "claude");
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const dispatchObservations: Array<{
				readonly sessionPresent: boolean;
				readonly bindingPresent: boolean;
				readonly tombstonePresent: boolean;
			}> = [];
			const dispatch = vi.fn(async () => {
				dispatchObservations.push(readTombstoneFirstState(dbFile, sessionId));
			});
			const engine = withDispatchEffect({ dispatch });
			engine.bindSession(sessionId, "claude");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* service.deleteSession(sessionId);
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);

				expect(dispatchObservations).toEqual([
					{
						sessionPresent: false,
						bindingPresent: false,
						tombstonePresent: true,
					},
				]);
				expect(dispatch).toHaveBeenCalledWith({
					type: "end_session",
					commandId: expect.any(String),
					sessionId,
					targetProviderId: "claude",
					unbind: true,
				});
				expect(api.session.delete).not.toHaveBeenCalled();
				expect(events.map((event) => event.type)).toEqual(["session.deleted"]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"captures a durable-only provider binding before tombstone projection and targets it for cleanup",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-durable-binding-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			const db = SqliteClient.open(dbFile);
			runMigrations(db, schemaMigrations);
			const now = 1_735_689_600_000;
			db.execute(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[sessionId, "work-oc", "Persisted session", "idle", now, now],
			);
			db.execute(
				"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
				[`${sessionId}:initial`, sessionId, "work-oc", now],
			);
			const bindingReadModel = new SqliteProviderSessionBindingReadModel(db);
			const cleanupObservations: Array<{
				readonly sessionPresent: boolean;
				readonly bindingPresent: boolean;
			}> = [];
			const providerInstance: ProviderInstance = {
				providerId: "opencode",
				discoverEffect: () =>
					Effect.succeed({
						models: [],
						supportsTools: false,
						supportsThinking: false,
						supportsPermissions: false,
						supportsQuestions: false,
						supportsAttachments: false,
						supportsFork: false,
						supportsRevert: false,
						commands: [],
					}),
				sendTurnEffect: () =>
					Effect.succeed({
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					}),
				interruptTurnEffect: () => Effect.void,
				resolvePermissionEffect: () => Effect.void,
				resolveQuestionEffect: () => Effect.void,
				shutdownEffect: () => Effect.void,
				endSessionEffect: vi.fn(() =>
					Effect.sync(() => {
						cleanupObservations.push(
							readProjectedDeleteState(dbFile, sessionId),
						);
					}),
				),
			};
			const registry = new ProviderRegistry([providerInstance]);
			const daemonConfig = makeNamedOpenCodeDaemonConfig();
			const engine = new OrchestrationEngine({
				registry,
				sessionBindingReadModel: bindingReadModel,
				resolveProviderDriver: (providerId) =>
					resolveInstanceDriver(daemonConfig, providerId),
			});
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const namedApi = makeMockOpenCodeAPI();
			vi.spyOn(namedApi.session, "delete").mockResolvedValue(undefined);
			const clientFor = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				clientFor,
				registerStreamWirer: () => Effect.void,
			} satisfies OpenCodeInstanceClients;
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
					Layer.succeed(OrchestrationEngineTag, engine),
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() => saveDaemonConfig(daemonConfig, tmpDir));
				expect(engine.getProviderForSession(sessionId)).toBe("work-oc");
				const service = yield* SessionManagerServiceTag;
				yield* service.deleteSession(sessionId);
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);

				expect(providerInstance.endSessionEffect).toHaveBeenCalledOnce();
				expect(cleanupObservations).toEqual([
					{ sessionPresent: false, bindingPresent: false },
				]);
				expect(engine.getProviderForSession(sessionId)).toBeUndefined();
				expect(clientFor).toHaveBeenCalledWith("work-oc");
				expect(namedApi.session.delete).toHaveBeenCalledWith(sessionId);
				expect(events.map((event) => event.type)).toEqual(["session.deleted"]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						db.close();
						rmSync(tmpDir, { recursive: true, force: true });
					}),
				),
			);
		},
	);

	it.scoped(
		"records a cleanup failure receipt when provider cleanup exceeds its timeout",
		() => {
			const tmpDir = mkdtempSync(
				join(tmpdir(), "conduit-session-delete-timeout-"),
			);
			const dbFile = join(tmpDir, "events.sqlite");
			const sessionId = "deleted-session";
			seedProjectedSessionBinding(dbFile, sessionId, "work-oc");

			return Effect.gen(function* () {
				const cleanupStarted = yield* Deferred.make<void>();
				const neverSettles = Deferred.succeed(cleanupStarted, undefined).pipe(
					Effect.zipRight(Effect.never),
				);
				const dispatchEffect = vi.fn(() => neverSettles);
				const engine = withDispatchEffect({ dispatchEffect });
				engine.bindSession(sessionId, "work-oc");
				const bindSession = vi.spyOn(engine, "bindSession");
				const api = makeMockOpenCodeAPI();
				const clientFor = vi.fn(() => neverSettles);
				const instanceClients = {
					clientFor,
					registerStreamWirer: () => Effect.void,
				} satisfies OpenCodeInstanceClients;
				const layer = Layer.provideMerge(
					SessionManagerServiceLive,
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
						makeSessionManagerStateLive(),
						DaemonEventBusLive,
						makePersistenceEffectLayer(dbFile),
						Layer.succeed(OpenCodeInstanceClientsTag, instanceClients),
						Layer.succeed(OrchestrationEngineTag, engine),
					),
				);

				yield* Effect.gen(function* () {
					yield* Effect.tryPromise(() =>
						saveDaemonConfig(makeNamedOpenCodeDaemonConfig(), tmpDir),
					);
					const service = yield* SessionManagerServiceTag;
					const fiber = yield* Effect.fork(service.deleteSession(sessionId));
					yield* Deferred.await(cleanupStarted);
					engine.bindSession(sessionId, "claude");
					yield* TestClock.adjust("1999 millis");
					expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
					yield* TestClock.adjust("1 millis");
					const completed = yield* Fiber.poll(fiber);
					if (Option.isNone(completed)) {
						yield* Fiber.interrupt(fiber);
					}
					expect(Option.isSome(completed)).toBe(true);
					if (Option.isSome(completed)) {
						expect(Exit.isSuccess(completed.value)).toBe(true);
					}

					const eventStore = yield* EventStoreEffectTag;
					const events = yield* eventStore.readAllBySession(sessionId);
					const receipt = events.find(
						(event) => event.type === "session.provider_cleanup_failed",
					);
					expect(
						readProjectedDeleteState(dbFile, sessionId).sessionPresent,
					).toBe(false);
					expect(events.some((event) => event.type === "session.deleted")).toBe(
						true,
					);
					expect(receipt?.data.reason).toBe("cleanup: timed out after 2s");
					expect(engine.getProviderForSession(sessionId)).toBe("claude");
					expect(bindSession).toHaveBeenCalledOnce();
					expect(bindSession).toHaveBeenCalledWith(sessionId, "claude");
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.scoped(
		"live service updates the relay status session-count snapshot",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-manager-status-snapshot-${Date.now()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 1, updated: 1 },
				},
				{
					id: "session-2",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 2",
					version: "1.0.0",
					time: { created: 2, updated: 2 },
				},
			]);
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "session-3",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 3",
				version: "1.0.0",
				time: { created: 3, updated: 3 },
			});
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					RelayStatusSnapshotLive,
					makePersistenceEffectLayer(dbFile),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const snapshot = yield* RelayStatusSnapshotTag;

				expect(snapshot.getSnapshot().sessionCount).toBe(0);
				yield* service.establishOpenCodeSession(
					{
						id: "session-1",
						projectID: "project-1",
						directory: "/tmp/project",
						title: "Session 1",
						version: "1.0.0",
						time: { created: 1, updated: 1 },
					},
					ProviderInstanceIdSchema.make("opencode"),
				);
				yield* service.establishOpenCodeSession(
					{
						id: "session-2",
						projectID: "project-1",
						directory: "/tmp/project",
						title: "Session 2",
						version: "1.0.0",
						time: { created: 2, updated: 2 },
					},
					ProviderInstanceIdSchema.make("opencode"),
				);
				yield* service.listSessions();
				expect(snapshot.getSnapshot().sessionCount).toBe(2);

				yield* service.createSession("Session 3", {
					providerId: "opencode",
				});
				expect(snapshot.getSnapshot().sessionCount).toBe(3);

				yield* service.deleteSession("session-1");
				expect(snapshot.getSnapshot().sessionCount).toBe(2);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.effect(
		"loads pre-rendered history and stores the oldest message cursor",
		() => {
			const api = makeMockOpenCodeAPI();
			const messages = [
				makeHistoryMessage("msg-oldest", "user", "hello"),
				makeHistoryMessage("msg-newest", "assistant", "**bold**"),
			];
			vi.spyOn(api.session, "messagesPage").mockResolvedValue(
				messages as unknown as Awaited<
					ReturnType<typeof api.session.messagesPage>
				>,
			);
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				const page = yield* loadPreRenderedHistory("session-1");
				const stateRef = yield* SessionManagerStateTag;
				const state = yield* Ref.get(stateRef);

				expect(api.session.messagesPage).toHaveBeenCalledWith("session-1", {
					limit: 50,
				});
				expect(page.messages).toHaveLength(2);
				expect(page.messages[1]?.parts?.[0]?.renderedHtml).toContain(
					"<strong>bold</strong>",
				);
				const cursor = HashMap.get(state.paginationCursors, "session-1");
				expect(cursor._tag).toBe("Some");
				if (cursor._tag === "Some") {
					expect(cursor.value).toBe("msg-oldest");
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("returns an empty older page when no cursor is known", () => {
		const api = makeMockOpenCodeAPI();
		const messagesPage = vi.spyOn(api.session, "messagesPage");
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(LoggerTag, makeMockLogger()),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			const page = yield* loadHistory("session-1", 50);

			expect(page).toEqual({ messages: [], hasMore: false });
			expect(messagesPage).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"keeps seed/clear pagination cursor ownership in service state",
		() => {
			const layer = makeSessionManagerStateLive();

			return Effect.gen(function* () {
				yield* seedPaginationCursor("session-1", "msg-oldest");
				yield* seedPaginationCursor("session-1", "msg-newer");

				const stateRef = yield* SessionManagerStateTag;
				const seeded = yield* Ref.get(stateRef);
				const seededCursor = HashMap.get(seeded.paginationCursors, "session-1");
				expect(seededCursor._tag).toBe("Some");
				if (seededCursor._tag === "Some") {
					expect(seededCursor.value).toBe("msg-oldest");
				}

				yield* clearPaginationCursor("session-1");
				const cleared = yield* Ref.get(stateRef);
				expect(HashMap.get(cleared.paginationCursors, "session-1")._tag).toBe(
					"None",
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"falls back to cursor scan when an older page cursor is stale",
		() => {
			const api = makeMockOpenCodeAPI();
			const staleCursor = new OpenCodeApiError({
				message: "Invalid cursor",
				endpoint: "/session/session-1/message",
				responseStatus: 400,
				responseBody: { error: "Invalid cursor" },
			});
			const messagesPage = vi
				.spyOn(api.session, "messagesPage")
				.mockRejectedValueOnce(staleCursor)
				.mockResolvedValueOnce([
					makeHistoryMessage("msg-older"),
					makeHistoryMessage("msg-cursor"),
					makeHistoryMessage("msg-newer"),
				] as unknown as Awaited<ReturnType<typeof api.session.messagesPage>>);
			const logger = makeMockLogger();
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive({
					paginationCursors: HashMap.fromIterable([
						["session-1", "msg-cursor"],
					]),
				}),
			);

			return Effect.gen(function* () {
				const page = yield* loadHistory("session-1", 50);
				const stateRef = yield* SessionManagerStateTag;
				const state = yield* Ref.get(stateRef);

				expect(messagesPage).toHaveBeenNthCalledWith(1, "session-1", {
					limit: 50,
					before: "msg-cursor",
				});
				expect(messagesPage).toHaveBeenNthCalledWith(2, "session-1", {
					limit: 10000,
				});
				expect(page.messages.map((message) => message.id)).toEqual([
					"msg-older",
				]);
				expect(page.hasMore).toBe(false);
				expect(HashMap.get(state.paginationCursors, "session-1")._tag).toBe(
					"None",
				);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining("Pagination cursor failed for session-1"),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("renames a session through the provider API", () => {
		const api = makeMockOpenCodeAPI();
		const update = vi.spyOn(api.session, "update").mockResolvedValue(undefined);
		const layer = Layer.succeed(OpenCodeAPITag, api);

		return Effect.gen(function* () {
			yield* renameSession("session-1", "New Title");

			expect(update).toHaveBeenCalledWith("session-1", {
				title: "New Title",
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect("projects provider sessions into frontend session info", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "child-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: undefined as unknown as string,
				version: "1.0.0",
				parentID: "root-1",
				time: { created: 10, updated: 20 },
			},
			{
				id: "root-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Root",
				version: "1.0.0",
				time: { created: 30, updated: 40 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive({
				lastMessageAt: HashMap.fromIterable([["child-1", 100]]),
				forkMeta: HashMap.fromIterable([
					[
						"child-1",
						{
							parentID: "fallback-parent",
							forkMessageId: "msg-1",
							forkPointTimestamp: 90,
						},
					],
				]),
				pendingQuestionCounts: HashMap.fromIterable([["child-1", 2]]),
			}),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions({
				statuses: {
					"child-1": { type: "busy" } as SessionStatus,
				},
			});
			const stateRef = yield* SessionManagerStateTag;
			const state = yield* Ref.get(stateRef);

			expect(sessions).toEqual([
				{
					id: "child-1",
					title: "Untitled",
					updatedAt: 100,
					messageCount: 0,
					parentID: "root-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 90,
					processing: true,
					pendingQuestionCount: 2,
				},
				{
					id: "root-1",
					title: "Root",
					updatedAt: 30,
					messageCount: 0,
				},
			]);
			expect(Array.from(HashMap.toEntries(state.cachedParentMap))).toEqual([
				["child-1", "root-1"],
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("stores fork metadata for subsequent service session lists", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-"));
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "forked-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Forked",
				version: "1.0.0",
				time: { created: 50, updated: 60 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			yield* setForkEntry(
				"forked-1",
				{
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 40,
				},
				tmpDir,
			);

			const sessions = yield* listSessions();

			expect(sessions).toEqual([
				{
					id: "forked-1",
					title: "Forked",
					updatedAt: 50,
					messageCount: 0,
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 40,
				},
			]);
			expect(loadForkMetadata(tmpDir).get("forked-1")).toEqual({
				parentID: "parent-1",
				forkMessageId: "msg-1",
				forkPointTimestamp: 40,
			});
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
		);
	});

	it.effect("prefers the Effect SQLite read path when available", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockRejectedValue(
			new Error("provider API should not be called"),
		);
		const readQuery = makeReadQueryEffect([
			makeRow("forked-1", {
				title: "Forked",
				parent_id: null,
				fork_point_event: null,
				updated_at: 300,
			}),
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(ReadQueryEffectTag, readQuery),
			makeSessionManagerStateLive({
				forkMeta: HashMap.fromIterable([
					[
						"forked-1",
						{
							parentID: "parent-1",
							forkMessageId: "msg-1",
							forkPointTimestamp: 250,
						},
					],
				]),
			}),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions();

			expect(readQuery.listSessions).toHaveBeenCalledWith(undefined);
			expect(api.session.list).not.toHaveBeenCalled();
			expect(sessions).toEqual([
				{
					id: "forked-1",
					title: "Forked",
					updatedAt: 300,
					messageCount: 0,
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 250,
				},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("keeps the parent map when fetching roots only", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "root-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Root",
				version: "1.0.0",
				time: { created: 1, updated: 1 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive({
				cachedParentMap: HashMap.fromIterable([["child-1", "root-1"]]),
			}),
		);

		return Effect.gen(function* () {
			yield* listSessions({ roots: true });
			const stateRef = yield* SessionManagerStateTag;
			const state = yield* Ref.get(stateRef);

			expect(Array.from(HashMap.toEntries(state.cachedParentMap))).toEqual([
				["child-1", "root-1"],
			]);
			expect(api.session.list).toHaveBeenCalledWith({ roots: true });
		}).pipe(Effect.provide(layer));
	});

	it.effect("exposes parent map reads and writes through service state", () => {
		const layer = Layer.mergeAll(
			makeSessionManagerStateLive(),
			Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Layer.succeed(LoggerTag, makeMockLogger()),
			DaemonEventBusLive,
		);

		return Effect.gen(function* () {
			yield* addToParentMap("child-1", "root-1");
			let parentMap = yield* getSessionParentMap();
			expect(Array.from(parentMap.entries())).toEqual([["child-1", "root-1"]]);

			const service = yield* SessionManagerServiceTag;
			yield* service.addToParentMap("child-2", "root-2");
			parentMap = yield* service.getSessionParentMap();

			expect(Array.from(parentMap.entries()).sort()).toEqual([
				["child-1", "root-1"],
				["child-2", "root-2"],
			]);
		}).pipe(Effect.provide(SessionManagerServiceLive), Effect.provide(layer));
	});

	it.effect("keeps message activity timestamps monotonic", () => {
		const layer = makeSessionManagerStateLive();

		return Effect.gen(function* () {
			const stateRef = yield* SessionManagerStateTag;
			yield* recordMessageActivity("s1", 200);
			yield* recordMessageActivity("s1", 100);
			yield* recordMessageActivity("s1", 300);
			const state = yield* Ref.get(stateRef);

			expect(HashMap.get(state.lastMessageAt, "s1")).toEqual(Option.some(300));
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"sends roots immediately and all sessions in the background",
		() => {
			const api = makeMockOpenCodeAPI();
			let resolveAllSessions!: (
				value: Awaited<ReturnType<typeof api.session.list>>,
			) => void;
			const allSessions = new Promise<
				Awaited<ReturnType<typeof api.session.list>>
			>((resolve) => {
				resolveAllSessions = resolve;
			});
			vi.spyOn(api.session, "list").mockImplementation(async (options) => {
				if (options?.roots) {
					return [
						{
							id: "root-1",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Root",
							version: "1.0.0",
							time: { created: 1, updated: 1 },
						},
					];
				}
				return allSessions;
			});
			const logger = makeMockLogger();
			const messages: unknown[] = [];
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				yield* sendDualSessionLists((msg) => messages.push(msg));
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
				]);

				resolveAllSessions([
					{
						id: "child-1",
						projectID: "project-1",
						directory: "/tmp/project",
						title: "Child",
						version: "1.0.0",
						parentID: "root-1",
						time: { created: 2, updated: 2 },
					},
				]);
				yield* Effect.promise(
					() => new Promise((resolve) => setTimeout(resolve, 0)),
				);
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
					{
						type: "session_list",
						sessions: [
							{
								id: "child-1",
								title: "Child",
								updatedAt: 2,
								messageCount: 0,
								parentID: "root-1",
							},
						],
						roots: false,
					},
				]);
				expect(logger.warn).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"logs background all-session failures without failing roots",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockImplementation(async (options) => {
				if (options?.roots) {
					return [
						{
							id: "root-1",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Root",
							version: "1.0.0",
							time: { created: 1, updated: 1 },
						},
					];
				}
				throw new Error("all sessions unavailable");
			});
			const logger = makeMockLogger();
			const messages: unknown[] = [];
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				yield* sendDualSessionLists((msg) => messages.push(msg));
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
				]);

				yield* Effect.yieldNow();
				yield* TestClock.adjust("4 seconds");
				yield* Effect.yieldNow();

				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining("Background all-sessions fetch failed:"),
				);
				expect(messages).toHaveLength(1);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("live service falls back to current status poller statuses", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 1, updated: 1 },
			},
		]);
		const layer = SessionManagerServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(
						StatusPollerTag,
						makeMockStatusPoller({
							isProcessing: vi.fn(() => Effect.succeed(true)),
							clearMessageActivity: vi.fn(() => Effect.void),
							getCurrentStatuses: vi.fn(() =>
								Effect.succeed({
									"session-1": { type: "busy" } as SessionStatus,
								}),
							),
						}),
					),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			const sessions = yield* service.listSessions();

			expect(sessions).toEqual([
				{
					id: "session-1",
					title: "Session 1",
					updatedAt: 1,
					messageCount: 0,
					processing: true,
				},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"live service loads persisted fork metadata into service state",
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-live-"));
			saveForkMetadata(
				new Map([
					[
						"forked-1",
						{
							parentID: "parent-1",
							forkMessageId: "msg-1",
							forkPointTimestamp: 250,
						},
					],
				]),
				tmpDir,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "forked-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Forked",
					version: "1.0.0",
					time: { created: 50, updated: 60 },
				},
			]);
			const config: ProjectRelayConfig = {
				httpServer: createServer(),
				opencodeUrl: "http://localhost:4096",
				projectDir: "/tmp/project",
				slug: "project",
				configDir: tmpDir,
			};
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, config),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const sessions = yield* service.listSessions();

				expect(sessions).toEqual([
					{
						id: "forked-1",
						title: "Forked",
						updatedAt: 50,
						messageCount: 0,
						parentID: "parent-1",
						forkMessageId: "msg-1",
						forkPointTimestamp: 250,
					},
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
			);
		},
	);

	it.effect(
		"live service stores fork metadata in Effect state and disk",
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-live-"));
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "forked-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Forked",
					version: "1.0.0",
					time: { created: 50, updated: 60 },
				},
			]);
			const config: ProjectRelayConfig = {
				httpServer: createServer(),
				opencodeUrl: "http://localhost:4096",
				projectDir: "/tmp/project",
				slug: "project",
				configDir: tmpDir,
			};
			const layer = SessionManagerServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(ConfigTag, config),
						makeSessionManagerStateLive(),
						DaemonEventBusLive,
					),
				),
			);
			const entry = {
				parentID: "parent-1",
				forkMessageId: "msg-1",
				forkPointTimestamp: 250,
			};

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* service.setForkEntry("forked-1", entry);
				const sessions = yield* service.listSessions();
				const parentMap = yield* service.getSessionParentMap();

				expect(sessions).toEqual([
					{
						id: "forked-1",
						title: "Forked",
						updatedAt: 50,
						messageCount: 0,
						parentID: "parent-1",
						forkMessageId: "msg-1",
						forkPointTimestamp: 250,
					},
				]);
				expect(Array.from(parentMap.entries())).toEqual([
					["forked-1", "parent-1"],
				]);
				expect(loadForkMetadata(tmpDir).get("forked-1")).toEqual(entry);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
			);
		},
	);
});
