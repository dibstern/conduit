import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
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
	Stream,
	TestClock,
} from "effect";
import { assert, expect, vi } from "vitest";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	type DaemonConfig,
	resolveInstanceDriver,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	PendingSendOwnershipLive,
	PendingSendOwnershipTag,
} from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	RelayStatusSnapshotLive,
	RelayStatusSnapshotTag,
} from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { loadPreRenderedHistory } from "../../../src/lib/domain/relay/Services/session-manager-history.js";
import { listSessions } from "../../../src/lib/domain/relay/Services/session-manager-list.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	addToParentMap,
	getSessionParentMap,
	recordMessageActivity,
} from "../../../src/lib/domain/relay/Services/session-manager-state-operations.js";
import { renameSession } from "../../../src/lib/domain/relay/Services/session-manager-triage.js";
import {
	makeOverridesStateLive,
	setDefaultModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import { sendMessageToSession } from "../../../src/lib/handlers/prompt.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	createAllEffectProjectors,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	pendingApprovalCountsByType,
	ReadQueryEffectTag,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type {
	PendingApprovalCountRow,
	SessionRow,
} from "../../../src/lib/persistence/read-model-types.js";
import {
	CURRENT_EVENT_STORE_MIGRATION,
	readMigrationSql,
} from "../../../src/lib/persistence/schema.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../src/lib/provider/provider-session-binding-read-model.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { translateMessageCreated } from "../../../src/lib/relay/event-translator.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import {
	makeMockAgentService,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockStatusPoller,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
	NoopProviderRuntimeIngestionLive,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { tempEventsDbPath } from "../../helpers/temp-events-db.js";

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		version: 0,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		last_message_at: null,
		last_turn_error_at: null,
		permission_mode: null,
		settled_at: null,
		pinned_at: null,
		snoozed_at: null,
		snoozed_until: null,
		woken_at: null,
		woken_reason: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

function makeReadQueryEffect(
	rows: readonly SessionRow[],
	pendingApprovalCounts: readonly PendingApprovalCountRow[] = [],
): ReadQueryEffect {
	return {
		getToolContent: vi.fn(() => Effect.succeed(undefined)),
		getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
		getSession: vi.fn((sessionId: string) =>
			Effect.succeed(rows.find((row) => row.id === sessionId)),
		),
		getGoalDetails: () =>
			Effect.succeed({ checks: [], tokensSinceStart: null }),
		getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
		getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
		getSessionsForReconciliation: () => Effect.succeed([]),
		listSessions: vi.fn(() => Effect.succeed(rows)),
		listSessionInfos: vi.fn((options) => {
			const pending = pendingApprovalCountsByType(pendingApprovalCounts);
			const selected = options?.roots
				? rows.filter((row) => row.parent_id === null)
				: rows;
			return Effect.succeed(
				sessionRowsToSessionInfoList(selected, {
					parentMap: new Map(
						rows.flatMap((row) =>
							row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
						),
					),
					pendingQuestionCounts: pending.questions,
					pendingPermissionCounts: pending.permissions,
					statuses: options?.statuses,
				}),
			);
		}),
		readSessionList: vi.fn(() =>
			Effect.succeed({
				rows: rows.map((row) => {
					const item = sessionRowsToSessionInfoList([row])[0];
					assert.exists(item, "expected session info");
					return { item, version: row.version };
				}),
				version: 0,
			}),
		),
		readSessionTranscript: vi.fn(() =>
			Effect.succeed({ messages: [], version: 0 }),
		),
		readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
		getSessionLineage: vi.fn(() =>
			Effect.succeed({
				rows: rows.map(({ id, parent_id, unread, side_thread }) => ({
					id,
					parent_id,
					unread: unread ?? 0,
					side_thread: side_thread ?? 0,
				})),
				count: rows.length,
			}),
		),
		countPendingApprovalsBySession: vi.fn(() =>
			Effect.succeed(pendingApprovalCounts),
		),
		readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
		getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
		getSessionHistoryMetadata: vi.fn(() =>
			Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
		),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
		readSessionTranscriptPage: vi.fn(() =>
			Effect.succeed({ messages: [], hasMore: false, version: 0 }),
		),
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
		persistenceDbPath: tempEventsDbPath(),
		publishGlobalSetting: () => Effect.void,
		configDir,
	};
}

function openFixtureDb(filename: string) {
	const db = new Database(filename);
	return {
		exec: (sql: string) => db.exec(sql),
		execute: (sql: string, values: readonly (string | number | null)[]) => {
			db.prepare(sql).run([...values]);
		},
		queryOne: <T>(sql: string, values: readonly (string | number | null)[]) =>
			db.prepare(sql).get([...values]) as T | undefined,
		query: <T>(sql: string, values: readonly (string | number | null)[]) =>
			db.prepare(sql).all([...values]) as T[],
		close: () => db.close(),
	};
}

function seedProjectedSessionBinding(
	dbFile: string,
	sessionId: string,
	providerId: string,
	parentId?: string,
): void {
	const db = openFixtureDb(dbFile);
	try {
		if (
			db.queryOne<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE name = 'sessions'",
				[],
			) === undefined
		) {
			db.exec(readMigrationSql(CURRENT_EVENT_STORE_MIGRATION));
		}
		// Keep this fixture newer than the one-time legacy-skeleton purge cutoff.
		// These tests exercise deletion, not cleanup of pre-event-store rows.
		const now = 1_800_000_000_000;
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				sessionId,
				providerId,
				"Persisted session",
				"idle",
				now,
				now,
				parentId ?? null,
			],
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
	const db = openFixtureDb(dbFile);
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
	const db = openFixtureDb(dbFile);
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

const sessionConfigLayer = Layer.succeed(
	ConfigTag,
	makeMockConfig({ configDir: "/tmp/conduit-session-manager-tests" }),
);
const sessionLoggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
const openCodeApi = makeMockOpenCodeAPI();
const requiredSessionServices = Layer.mergeAll(
	makePersistenceEffectLayer(":memory:"),
	PendingSendOwnershipLive,
	Layer.succeed(AgentServiceTag, makeMockAgentService()),
	sessionConfigLayer,
	sessionLoggerLayer,
	Layer.succeed(OpenCodeAPITag, openCodeApi),
	Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
	Layer.succeed(BackgroundLivenessTag, () => undefined),
	RelayStatusSnapshotLive,
	makeOverridesStateLive(),
	Layer.succeed(
		OpenCodeInstancesTag,
		makeOpenCodeInstancesStub({ opencode: openCodeApi }),
	),
	Layer.succeed(
		OrchestrationEngineTag,
		new OrchestrationEngine({ registry: new ProviderRegistry() }),
	),
);

describe("SessionManagerService", () => {
	it.effect("checks session existence in the store", () => {
		const api = makeMockOpenCodeAPI();
		const readQuery = makeReadQueryEffect([makeRow("existing")]);
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				requiredSessionServices,
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			expect(yield* service.sessionExists("existing")).toBe(true);
			expect(yield* service.sessionExists("missing")).toBe(false);
			expect(readQuery.getSession).toHaveBeenCalledTimes(2);
			expect(api.session.get).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.scoped("cascade delete forgets every descendant it removed", () => {
		const tmpDir = mkdtempSync(
			join(tmpdir(), "conduit-session-delete-lineage-"),
		);
		const dbFile = join(tmpDir, "events.sqlite");
		seedProjectedSessionBinding(dbFile, "parent-1", "opencode");
		seedProjectedSessionBinding(dbFile, "child-1", "opencode", "parent-1");
		seedProjectedSessionBinding(dbFile, "grandchild-1", "opencode", "child-1");
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
		vi.spyOn(api.session, "list").mockResolvedValue([]);
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				requiredSessionServices,
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive({
					cachedParentMap: HashMap.fromIterable([
						["child-1", "parent-1"],
						["grandchild-1", "child-1"],
					]),
				}),
				DaemonEventBusLive,
				makePersistenceEffectLayer(dbFile),
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			// Deleting the root takes the whole lineage with it, so nothing about
			// a descendant may outlive it.
			yield* service.deleteSession("parent-1");
			expect([...(yield* service.getSessionParentMap())]).toEqual([]);
			expect([...(yield* service.getSessionParentMap())]).toEqual([]);
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.ensuring(
				Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
			),
		);
	});

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
					requiredSessionServices,
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
					requiredSessionServices,
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
				Effect.provide(requiredSessionServices),
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
					requiredSessionServices,
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
					const db = openFixtureDb(dbFile);
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
				Effect.provide(requiredSessionServices),
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
					requiredSessionServices,
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
					requiredSessionServices,
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
					const db = openFixtureDb(dbFile);
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
				Effect.provide(requiredSessionServices),
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
					requiredSessionServices,
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
				expect(creations[0]?.count).toBe(0);
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
					requiredSessionServices,
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
					requiredSessionServices,
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
				persistenceDbPath: tempEventsDbPath(),
				publishGlobalSetting: () => Effect.void,
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
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({ opencode: api }),
					),
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

				const sql = yield* SqlClient.SqlClient;
				const bindings = yield* sql<{
					readonly session_id: string;
					readonly provider: string;
					readonly status: string;
				}>`SELECT session_id, provider, status
					FROM session_providers
					WHERE session_id IN ${sql.in([claudeSession.id, openCodeSession.id])}
						AND status = 'active'
					ORDER BY session_id`;

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
			const use = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				events: () => Stream.empty,
				use,
				ifRunning: () => Effect.succeedNone,
				stop: () => Effect.void,
			} satisfies OpenCodeInstances;
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry(),
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					makeOverridesStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
					const db = openFixtureDb(dbFile);
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

				expect(use).toHaveBeenCalledWith("work-oc");
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
					requiredSessionServices,
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
					requiredSessionServices,
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
			const use = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				events: () => Stream.empty,
				use,
				ifRunning: () => Effect.succeedNone,
				stop: () => Effect.void,
			} satisfies OpenCodeInstances;
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
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, logger),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
					...state,
					cachedParentMap: HashMap.set(
						HashMap.set(state.cachedParentMap, sessionId, "parent"),
						"child",
						sessionId,
					),
					lastMessageAt: HashMap.set(state.lastMessageAt, sessionId, 123),
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
						!HashMap.has(state.lastMessageAt, sessionId),
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
					requiredSessionServices,
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
				const ownership = yield* PendingSendOwnershipTag;
				ownership.register(sessionId, {
					commandId: "confirmed-before-delete",
					originId: "browser",
					text: "ok",
				});
				expect(ownership.resolve(sessionId, "confirmed-message", "ok")).toBe(
					"browser",
				);
				yield* sendMessageToSession({
					clientId: "browser",
					originId: "browser",
					sessionId,
					commandId: "pending-at-delete",
					text: "ok",
				}).pipe(
					Effect.provideService(ProviderTurnServiceTag, {
						holdUserTurnsForAccountSwitch: () => Effect.void,
						prepareTurnSession: (input) => Effect.succeed(input.sessionId),
						sendTurn: () => Effect.void,
						interruptTurn: () => Effect.void,
					}),
					Effect.provideService(
						WebSocketHandlerTag,
						makeMockWebSocketHandler(),
					),
					Effect.provideService(ConfigTag, makeMockConfig()),
					Effect.provide(PendingInteractionServiceLive),
					Effect.provide(makeOverridesStateLive()),
					Effect.provide(NoopProviderRuntimeIngestionLive),
				);
				yield* service.deleteSession(sessionId);
				expect(
					ownership.resolve(sessionId, "confirmed-message", "ok"),
				).toBeUndefined();
				expect(
					translateMessageCreated(
						{
							type: "message.created",
							properties: {
								sessionID: sessionId,
								messageID: "after-delete",
								info: { role: "user", parts: [{ type: "text", text: "ok" }] },
							},
						},
						ownership.resolve,
					),
				).not.toHaveProperty("originId");
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
					requiredSessionServices,
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
			const use = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				events: () => Stream.empty,
				use,
				ifRunning: () => Effect.succeedNone,
				stop: () => Effect.void,
			} satisfies OpenCodeInstances;
			const dispatch = vi.fn(async () => undefined);
			const engine = withDispatchEffect({ dispatch });
			engine.bindSession(sessionId, "work-oc");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
				events: () => Stream.empty,
				use: vi.fn(() => Effect.succeed(namedApi)),
				ifRunning: () => Effect.succeedNone,
				stop: () => Effect.void,
			} satisfies OpenCodeInstances;
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => undefined),
			});
			engine.bindSession(sessionId, "work-oc");
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
					Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
			events: () => Stream.empty,
			use: vi.fn(() => Effect.succeed(namedApi)),
			ifRunning: () => Effect.succeedNone,
			stop: () => Effect.void,
		} satisfies OpenCodeInstances;
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => undefined),
		});
		engine.bindSession(sessionId, "work-oc");
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				requiredSessionServices,
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				makePersistenceEffectLayer(dbFile),
				Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
					requiredSessionServices,
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
			const db = openFixtureDb(dbFile);
			db.exec(readMigrationSql(CURRENT_EVENT_STORE_MIGRATION));
			const now = 1_735_689_600_000;
			db.execute(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[sessionId, "work-oc", "Persisted session", "idle", now, now],
			);
			db.execute(
				"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
				[`${sessionId}:initial`, sessionId, "work-oc", now],
			);
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
			const persistenceLayer = makePersistenceEffectLayer(dbFile);
			const engineLayer = Layer.effect(
				OrchestrationEngineTag,
				Effect.map(
					SqlClient.SqlClient,
					(sql) =>
						new OrchestrationEngine({
							registry,
							sessionBindingReadModel:
								new SqliteProviderSessionBindingReadModel(sql),
							resolveProviderDriver: (providerId) =>
								resolveInstanceDriver(daemonConfig, providerId),
						}),
				),
			).pipe(Layer.provide(persistenceLayer));
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const namedApi = makeMockOpenCodeAPI();
			vi.spyOn(namedApi.session, "delete").mockResolvedValue(undefined);
			const use = vi.fn(() => Effect.succeed(namedApi));
			const instanceClients = {
				events: () => Stream.empty,
				use,
				ifRunning: () => Effect.succeedNone,
				stop: () => Effect.void,
			} satisfies OpenCodeInstances;
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					persistenceLayer,
					Layer.succeed(OpenCodeInstancesTag, instanceClients),
					engineLayer,
				),
			);

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() => saveDaemonConfig(daemonConfig, tmpDir));
				const engine = yield* OrchestrationEngineTag;
				expect(yield* engine.getProviderForSessionEffect(sessionId)).toBe(
					"work-oc",
				);
				const service = yield* SessionManagerServiceTag;
				yield* service.deleteSession(sessionId);
				const eventStore = yield* EventStoreEffectTag;
				const events = yield* eventStore.readAllBySession(sessionId);

				expect(providerInstance.endSessionEffect).toHaveBeenCalledOnce();
				expect(cleanupObservations).toEqual([
					{ sessionPresent: false, bindingPresent: false },
				]);
				expect(
					yield* engine.getProviderForSessionEffect(sessionId),
				).toBeUndefined();
				expect(use).toHaveBeenCalledWith("work-oc");
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
				const use = vi.fn(() => neverSettles);
				const instanceClients = {
					events: () => Stream.empty,
					use,
					ifRunning: () => Effect.succeedNone,
					stop: () => Effect.void,
				} satisfies OpenCodeInstances;
				const layer = Layer.provideMerge(
					SessionManagerServiceLive,
					Layer.mergeAll(
						requiredSessionServices,
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(ConfigTag, makeRelayConfig(tmpDir)),
						makeSessionManagerStateLive(),
						DaemonEventBusLive,
						makePersistenceEffectLayer(dbFile),
						Layer.succeed(OpenCodeInstancesTag, instanceClients),
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
					expect(yield* engine.getProviderForSessionEffect(sessionId)).toBe(
						"claude",
					);
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
					requiredSessionServices,
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
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Session 1', 'idle', 1, 1),
						('session-2', 'opencode', 'Session 2', 'idle', 2, 2)`;

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

	it.effect("loads and pre-renders the newest REST history page", () => {
		const api = makeMockOpenCodeAPI();
		const messages = [
			makeHistoryMessage("msg-oldest", "user", "hello"),
			makeHistoryMessage("msg-newest", "assistant", "**bold**"),
		];
		vi.spyOn(api.session, "messagesPage").mockResolvedValue(
			messages.map((message) => ({ ...message, sessionID: "session-1" })),
		);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(LoggerTag, makeMockLogger()),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			const page = yield* loadPreRenderedHistory("session-1");

			expect(api.session.messagesPage).toHaveBeenCalledWith("session-1", {
				limit: 50,
			});
			expect(page.messages).toHaveLength(2);
			expect(page.messages[1]?.parts?.[0]?.renderedHtml).toContain(
				"<strong>bold</strong>",
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect("renames a session through the provider API", () => {
		const api = makeMockOpenCodeAPI();
		const update = vi.spyOn(api.session, "update").mockResolvedValue(undefined);
		const layer = Layer.succeed(OpenCodeAPITag, api);

		return Effect.gen(function* () {
			yield* renameSession("session-1", "New Title");

			expect(update).toHaveBeenCalledWith("session-1", {
				title: "New Title",
			});
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.effect("projects persisted sessions into frontend session info", () => {
		const readQuery = makeReadQueryEffect(
			[
				makeRow("child-1", {
					title: "Untitled",
					parent_id: "root-1",
					updated_at: 100,
				}),
				makeRow("root-1", { title: "Root", updated_at: 30 }),
			],
			[{ session_id: "child-1", type: "question", pending_count: 2 }],
		);
		const layer = Layer.mergeAll(
			Layer.succeed(ReadQueryEffectTag, readQuery),
			makeSessionManagerStateLive({
				lastMessageAt: HashMap.fromIterable([["child-1", 100]]),
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

			expect(sessions).toMatchObject([
				{
					id: "child-1",
					attention: "needs-reply",
					title: "Untitled",
					updatedAt: 100,
					status: "busy",
					parentID: "root-1",
				},
				{
					id: "root-1",
					attention: "needs-reply",
					title: "Root",
					updatedAt: 30,
					status: "idle",
				},
			]);
			expect(Array.from(HashMap.toEntries(state.cachedParentMap))).toEqual([
				["child-1", "root-1"],
			]);
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.effect("prefers the Effect SQLite read path when available", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockRejectedValue(
			new Error("provider API should not be called"),
		);
		const readQuery = makeReadQueryEffect([
			makeRow("forked-1", {
				title: "Forked",
				status: "idle",
				created_at: 100,
				updated_at: 300,
				parent_id: "parent-1",
				fork_point_event: "msg-1",
				fork_point_timestamp: 250,
			}),
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(ReadQueryEffectTag, readQuery),
			makeSessionManagerStateLive({}),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions();

			expect(readQuery.listSessionInfos).toHaveBeenCalled();
			expect(api.session.list).not.toHaveBeenCalled();
			// The read hands back the projected session type as-is.
			expect(sessions).toEqual([
				{
					id: "forked-1",
					title: "Forked",
					status: "idle",
					createdAt: 100,
					updatedAt: 300,
					messageCount: 0,
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 250,
					attention: "idle",
					limitRecovery: null,
					resumes: [],
				},
			]);
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.effect("reads durable pending question and permission counts", () => {
		const dbFile = join(
			tmpdir(),
			`conduit-session-manager-pending-${Date.now()}.sqlite`,
		);
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				requiredSessionServices,
				Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				makePersistenceEffectLayer(dbFile),
			),
		);

		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* EventStoreEffectTag;
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			const service = yield* SessionManagerServiceTag;
			yield* projectionRunner.markRecovered();
			yield* sql`
					INSERT INTO sessions
					(id, provider, title, status, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Warm session', 'idle', 1, 1)`;

			const questionAsked = yield* store.append(
				canonicalEvent(
					"question.asked",
					"session-1",
					{
						id: "question-1",
						sessionId: "session-1",
						questions: [{ text: "Continue?" }],
					},
					{ provider: "opencode", createdAt: 2 },
				),
			);
			yield* projectionRunner.projectEvent(questionAsked);
			const permissionAsked = yield* store.append(
				canonicalEvent(
					"permission.asked",
					"session-1",
					{
						id: "permission-1",
						sessionId: "session-1",
						toolName: "bash",
						input: { command: "pwd" },
					},
					{ provider: "opencode", createdAt: 3 },
				),
			);
			yield* projectionRunner.projectEvent(permissionAsked);

			const sessions = yield* service.listSessions();
			expect(sessions).toEqual([
				expect.objectContaining({
					id: "session-1",
					pendingQuestionCount: 1,
					pendingPermissionCount: 1,
				}),
			]);
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
		);
	});

	it.effect(
		"recovers pending events before triage guards and idempotency checks",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-triage-recovery-${crypto.randomUUID()}.sqlite`,
			);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);
			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const service = yield* SessionManagerServiceTag;
				for (const id of ["settled", "pinned"]) {
					yield* store.append(
						canonicalEvent(
							"session.created",
							id,
							{ sessionId: id, title: id, provider: "opencode" },
							{ provider: "opencode", createdAt: 10 },
						),
					);
					yield* store.append(
						canonicalEvent(
							id === "settled" ? "session.settled" : "session.pinned",
							id,
							{ sessionId: id },
							{ provider: "opencode", createdAt: 20 },
						),
					);
				}
				expect(
					yield* service.setSessionSettled("settled", { settled: true }),
				).toBe(false);
				expect(yield* store.readAllBySession("settled")).toHaveLength(2);
				expect(
					yield* service.setSessionSettled("settled", { settled: false }),
				).toBe(true);
				const blocked = yield* Effect.either(
					service.setSessionSettled("pinned", { settled: true }),
				);
				expect(blocked._tag).toBe("Left");
				expect(yield* store.readAllBySession("pinned")).toHaveLength(2);
				expect(yield* service.setSessionPinned("pinned", false)).toBe(true);
				expect(
					yield* service.setSessionSettled("pinned", { settled: true }),
				).toBe(true);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.provide(requiredSessionServices),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.effect(
		"persists idempotent triage commands without changing list order",
		() => {
			const dbFile = join(
				tmpdir(),
				`conduit-session-triage-${crypto.randomUUID()}.sqlite`,
			);
			const api = makeMockOpenCodeAPI();
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			);
			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const service = yield* SessionManagerServiceTag;
				yield* runner.markRecovered();
				for (const [id, createdAt] of [
					["older", 10],
					["newer", 20],
				] as const) {
					yield* runner.projectEvent(
						yield* store.append(
							canonicalEvent(
								"session.created",
								id,
								{ sessionId: id, title: id, provider: "opencode" },
								{ provider: "opencode", createdAt },
							),
						),
					);
				}
				expect(
					yield* service.setSessionSettled("older", { settled: false }),
				).toBe(false);
				expect(yield* service.setSessionPinned("older", false)).toBe(false);
				expect(
					yield* Effect.all(
						[
							service.setSessionSettled("older", { settled: true }),
							service.setSessionSettled("older", { settled: true }),
						],
						{ concurrency: "unbounded" },
					),
				).toEqual([true, false]);
				const settled = (yield* service.listSessions()).find(
					(s) => s.id === "older",
				);
				expect(settled?.settledAt).toEqual(expect.any(Number));
				expect(
					yield* service.setSessionSettled("older", { settled: false }),
				).toBe(true);
				expect(yield* service.setSessionPinned("older", true)).toBe(true);
				expect(yield* service.setSessionPinned("older", true)).toBe(false);
				const blocked = yield* Effect.either(
					service.setSessionSettled("older", { settled: true }),
				);
				expect(blocked._tag).toBe("Left");
				if (blocked._tag === "Left")
					expect(String(blocked.left.cause)).toMatch(/pinned.*unpinned first/);
				const pinned = (yield* service.listSessions()).find(
					(s) => s.id === "older",
				);
				expect(pinned?.pinnedAt).toEqual(expect.any(Number));
				expect(pinned).not.toHaveProperty("settledAt");
				expect(yield* service.setSessionPinned("older", false)).toBe(true);
				expect(yield* service.setSessionPinned("older", false)).toBe(false);
				expect(
					yield* service.setSessionSettled("older", { settled: true }),
				).toBe(true);
				// Pinning a settled session un-settles it: a session is never both.
				expect(yield* service.setSessionPinned("older", true)).toBe(true);
				const repinned = (yield* service.listSessions()).find(
					(s) => s.id === "older",
				);
				expect(repinned?.pinnedAt).toEqual(expect.any(Number));
				expect(repinned).not.toHaveProperty("settledAt");
				expect(yield* service.setSessionPinned("older", false)).toBe(true);
				const sessions = yield* service.listSessions();
				expect(sessions.map((s) => [s.id, s.updatedAt])).toEqual([
					["newer", 20],
					["older", 10],
				]);
				expect(sessions[1]).not.toHaveProperty("settledAt");
				expect(sessions[1]).not.toHaveProperty("pinnedAt");
				expect(
					(yield* store.readAllBySession("older")).map((e) => e.type),
				).toEqual([
					"session.created",
					"session.settled",
					"session.unsettled",
					"session.pinned",
					"session.unpinned",
					"session.settled",
					"session.unsettled",
					"session.pinned",
					"session.unpinned",
				]);
				expect(api.session.update).not.toHaveBeenCalled();
				expect(api.session.delete).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.provide(requiredSessionServices),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		},
	);

	it.effect("lists durable unread state from real projected events", () => {
		const dbFile = join(
			tmpdir(),
			`conduit-session-manager-unread-${Date.now()}.sqlite`,
		);
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				requiredSessionServices,
				Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				makePersistenceEffectLayer(dbFile),
			),
		);

		return Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			const service = yield* SessionManagerServiceTag;
			yield* projectionRunner.markRecovered();

			for (const event of [
				canonicalEvent(
					"session.created",
					"session-1",
					{
						sessionId: "session-1",
						title: "Durable unread",
						provider: "opencode",
					},
					{ provider: "opencode", createdAt: 10 },
				),
				canonicalEvent(
					"turn.completed",
					"session-1",
					{ messageId: "message-1" },
					{ provider: "opencode", createdAt: 20 },
				),
			]) {
				const stored = yield* store.append(event);
				yield* projectionRunner.projectEvent(stored);
			}
			expect((yield* service.listSessions())[0]?.unread).toBe(true);

			yield* service.markSessionRead("session-1");
			expect((yield* service.listSessions())[0]).not.toHaveProperty("unread");

			yield* service.markSessionUnread("session-1");
			expect((yield* service.listSessions())[0]?.unread).toBe(true);
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.provide(requiredSessionServices),
			Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
		);
	});

	it.effect("reads projected pending counts", () => {
		const readQuery = makeReadQueryEffect(
			[makeRow("session-1")],
			[
				{
					session_id: "session-1",
					type: "question",
					pending_count: 1,
				},
			],
		);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Layer.succeed(ReadQueryEffectTag, readQuery),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions();

			expect(sessions[0]?.pendingQuestionCount).toBe(1);
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.effect("keeps the parent map when fetching roots only", () => {
		const api = makeMockOpenCodeAPI();
		const readQuery = makeReadQueryEffect([
			makeRow("root-1", { title: "Root", updated_at: 1 }),
			makeRow("child-1", { parent_id: "root-1" }),
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(ReadQueryEffectTag, readQuery),
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
			expect(readQuery.listSessionInfos).toHaveBeenCalledWith({ roots: true });
			expect(api.session.list).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
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
		}).pipe(
			Effect.provide(SessionManagerServiceLive),
			Effect.provide(layer),
			Effect.provide(requiredSessionServices),
		);
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
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});

	it.effect("refreshes the lineage caches", () => {
		const rows = [
			makeRow("root"),
			makeRow("child", { parent_id: "root" }),
			makeRow("side", { parent_id: "root", side_thread: 1 }),
		];
		const readQuery = makeReadQueryEffect(rows);
		const ws = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "root"),
		});
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Layer.succeed(ReadQueryEffectTag, readQuery),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(StatusPollerTag, makeMockStatusPoller()),
			Layer.succeed(LoggerTag, makeMockLogger()),
			makeSessionManagerStateLive(),
			DaemonEventBusLive,
			RelayStatusSnapshotLive,
		);
		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			yield* service.refreshSessionLineage();
			expect(readQuery.listSessionInfos).not.toHaveBeenCalled();
			expect(readQuery.getSessionLineage).toHaveBeenCalledTimes(1);
			const state = yield* Ref.get(yield* SessionManagerStateTag);
			expect(state.lastKnownSessionCount).toBe(3);
			expect(HashMap.get(state.cachedParentMap, "child")).toEqual(
				Option.some("root"),
			);
			expect([...state.cachedSideThreadIds]).toEqual(["side"]);
			expect((yield* RelayStatusSnapshotTag).getSnapshot().sessionCount).toBe(
				3,
			);
		}).pipe(
			Effect.provide(SessionManagerServiceLive),
			Effect.provide(layer),
			Effect.provide(requiredSessionServices),
		);
	});

	it.effect("live service falls back to current status poller statuses", () => {
		const api = makeMockOpenCodeAPI();
		const readQuery = makeReadQueryEffect([
			makeRow("session-1", { title: "Session 1", updated_at: 1 }),
		]);
		const layer = SessionManagerServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(ReadQueryEffectTag, readQuery),
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

			expect(sessions).toMatchObject([
				{
					id: "session-1",
					attention: "working",
					title: "Session 1",
					updatedAt: 1,
					status: "busy",
				},
			]);
		}).pipe(Effect.provide(layer), Effect.provide(requiredSessionServices));
	});
});

describe("snooze session commands", () => {
	function makeLayer() {
		const dbFile = join(
			tmpdir(),
			`conduit-snooze-${crypto.randomUUID()}.sqlite`,
		);
		return {
			dbFile,
			layer: Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					requiredSessionServices,
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
					makePersistenceEffectLayer(dbFile),
				),
			),
		};
	}

	for (const [reason, expected] of [
		["pinned", /unpin.*first/i],
		["settled", /un-settle.*first/i],
		["permission", /waiting on you/i],
		["question", /waiting on you/i],
		["past", /future/i],
	] as const) {
		it.effect(`refuses ${reason} without emitting an event`, () => {
			const { dbFile, layer } = makeLayer();
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const service = yield* SessionManagerServiceTag;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s1', 'opencode', 'Session', 'idle', 1, 1)`;
				if (reason === "pinned")
					yield* sql`UPDATE sessions SET pinned_at = 2 WHERE id = 's1'`;
				if (reason === "settled")
					yield* sql`UPDATE sessions SET settled_at = 2 WHERE id = 's1'`;
				if (reason === "permission" || reason === "question") {
					yield* sql`INSERT INTO pending_approvals (id, session_id, type, created_at) VALUES ('a1', 's1', ${reason}, 2)`;
				}
				const result = yield* Effect.either(
					service.snoozeSession(
						"s1",
						reason === "past" ? Date.now() - 1 : null,
					),
				);
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(String(result.left.cause)).toMatch(expected);
				expect(yield* store.readAllBySession("s1")).toEqual([]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.provide(requiredSessionServices),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		});
	}

	it.effect("emits only on a new snooze value and an active unsnooze", () => {
		const { dbFile, layer } = makeLayer();
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* EventStoreEffectTag;
			const service = yield* SessionManagerServiceTag;
			yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s1', 'opencode', 'Session', 'idle', 1, 1)`;
			const firstUntil = Date.now() + 60_000;
			expect(yield* service.snoozeSession("s1", firstUntil)).toBe(true);
			expect(yield* service.snoozeSession("s1", firstUntil)).toBe(false);
			expect(yield* service.snoozeSession("s1", null)).toBe(true);
			expect(yield* service.unsnoozeSession("s1")).toBe(true);
			expect(yield* service.unsnoozeSession("s1")).toBe(false);
			expect(
				(yield* store.readAllBySession("s1")).map((event) => event.type),
			).toEqual(["session.snoozed", "session.snoozed", "session.unsnoozed"]);
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.provide(requiredSessionServices),
			Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
		);
	});

	for (const action of ["settle", "pin"] as const) {
		it.effect(`${action} emits unsnoozed before its own event`, () => {
			const { dbFile, layer } = makeLayer();
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const service = yield* SessionManagerServiceTag;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s1', 'opencode', 'Session', 'idle', 1, 1)`;
				yield* service.snoozeSession("s1", null);
				if (action === "settle")
					yield* service.setSessionSettled("s1", { settled: true });
				else yield* service.setSessionPinned("s1", true);
				expect(
					(yield* store.readAllBySession("s1")).map((event) => event.type),
				).toEqual([
					"session.snoozed",
					"session.unsnoozed",
					action === "settle" ? "session.settled" : "session.pinned",
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.provide(requiredSessionServices),
				Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
			);
		});
	}
});
