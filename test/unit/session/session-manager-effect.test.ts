import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	AccountDirectory,
	AccountDirectoryFromConfigLive,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionCommandError } from "../../../src/lib/domain/relay/Services/session-command.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { listSessions } from "../../../src/lib/domain/relay/Services/session-manager-list.js";
import { persistSessionPermissionMode } from "../../../src/lib/domain/relay/Services/session-manager-permission-mode.js";
import {
	deleteSession,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	getSessionParentMap,
	recordMessageActivity,
} from "../../../src/lib/domain/relay/Services/session-manager-state-operations.js";
import { restoreSessionSettings } from "../../../src/lib/domain/relay/Services/session-model-settings.js";
import {
	getContextWindow,
	getModel,
	getOverrides,
	getPermissionMode,
	getVariant,
	makeOverridesStateLive,
	setDefaultPermissionMode,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { backfillSessionPicks } from "../../../src/lib/domain/relay/Services/session-pick.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type EffectProjector,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { partialFake } from "../../helpers/partial-fake.js";

describe("SessionManager Effect", () => {
	const makeMockApi = () =>
		partialFake<OpenCodeAPI>({
			session: partialFake<OpenCodeAPI["session"]>({
				list: vi.fn(async () => [
					partialFake<SessionDetail>({ id: "s1", title: "Test" }),
				]),
				create: vi.fn(async () =>
					partialFake<SessionDetail>({ id: "s-new", title: "New" }),
				),
				delete: vi.fn(async () => undefined),
				update: vi.fn(async () => undefined),
			}),
		});

	const makeTestLayer = (
		mockApi: ReturnType<typeof makeMockApi>,
		configDir?: string,
	) => {
		const configLayer = Layer.succeed(
			ConfigTag,
			makeMockConfig(configDir ? { configDir } : {}),
		);
		const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
		return Layer.mergeAll(
			configDir === undefined
				? Layer.succeed(AccountDirectory, makeMockAccountDirectory())
				: AccountDirectoryFromConfigLive(
						configDir,
						configuredClaudeConfigDir(join(configDir, "login")),
					),
			makeSessionManagerStateLive(),
			Layer.succeed(OpenCodeAPITag, mockApi),
			makePersistenceEffectLayer(":memory:", "test-project"),
			configLayer,
			loggerLayer,
			Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
			Layer.effect(SessionActivityTag, makeSessionActivity),
			RelayStatusSnapshotLive,
			makeOverridesStateLive(),
			Layer.succeed(
				OpenCodeInstancesTag,
				makeOpenCodeInstancesStub({ opencode: mockApi }),
			),
		);
	};

	const makeLiveServiceLayer = (
		mockApi: ReturnType<typeof makeMockApi>,
		filename: string,
		readQueryOverride?: ReadQueryEffect,
		configDir?: string,
		projectors?: readonly EffectProjector[],
	) => {
		const persistenceLayer = makePersistenceEffectLayer(
			filename,
			"test-project",
		);
		const projectionRunnerOverride = projectors
			? Layer.effect(
					ProjectionRunnerEffectTag,
					makeProjectionRunnerEffect(projectors),
				).pipe(Layer.provide(persistenceLayer))
			: undefined;

		return Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				Layer.fresh(makeTestLayer(mockApi, configDir)),
				Layer.succeed(LoggerTag, makeMockLogger()),
				DaemonEventBusLive,
				persistenceLayer,
				Layer.succeed(
					OrchestrationEngineTag,
					new OrchestrationEngine({ registry: new ProviderRegistry() }),
				),
				...(readQueryOverride
					? [Layer.succeed(ReadQueryEffectTag, readQueryOverride)]
					: []),
				...(projectionRunnerOverride ? [projectionRunnerOverride] : []),
			),
		);
	};

	it.effect("recordMessageActivity updates timestamp", () => {
		const mockApi = makeMockApi();

		return Effect.gen(function* () {
			yield* recordMessageActivity("s1", 12345);
			const ref = yield* SessionManagerStateTag;
			const state = yield* Ref.get(ref);
			const result = HashMap.get(state.lastMessageAt, "s1").pipe(
				Option.getOrNull,
			);

			expect(result).toBe(12345);
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect(
		"keeps Side Thread lineage while excluding its edge from activity and notifications",
		() =>
			Effect.gen(function* () {
				const parents = new Map([
					["side", "root"],
					["agent", "side"],
					["ordinary", "root"],
				]);
				const full = yield* getSessionParentMap();
				const activity = yield* getSessionParentMap({ activityOnly: true });
				expect(full).toEqual(parents);
				expect(activity).toEqual(
					new Map([
						["agent", "side"],
						["ordinary", "root"],
					]),
				);
				expect(yield* getSessionParentMap()).toEqual(parents);
			}).pipe(
				Effect.provide(
					makeSessionManagerStateLive({
						cachedParentMap: HashMap.make(
							["side", "root"],
							["agent", "side"],
							["ordinary", "root"],
						),
						cachedSideThreadIds: new Set(["side"]),
					}),
				),
			),
	);

	it.effect("deleteSession clears session activity and parent mappings", () => {
		const mockApi = makeMockApi();

		return Effect.gen(function* () {
			// Seed some state first
			yield* recordMessageActivity("s1", 12345);
			const ref = yield* SessionManagerStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				cachedParentMap: HashMap.make(["child1", "s1"]),
			}));

			// Delete
			yield* deleteSession("s1");

			const state = yield* Ref.get(ref);
			const result = {
				hasActivity: HashMap.has(state.lastMessageAt, "s1"),
				// child1's parent was s1, so it should be removed from parent map
				hasChildInParentMap: HashMap.has(state.cachedParentMap, "child1"),
			};

			expect(result.hasActivity).toBe(false);
			expect(result.hasChildInParentMap).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect(
		"renames SQLite-backed Claude sessions through the event store",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-session-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-claude-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
					VALUES (${sessionId}, 'test-project', 'claude', 'Claude Session', 'idle', 1000, 1000)`;

				const created = yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Claude Session",
							provider: "claude",
						},
						{ provider: "claude", createdAt: 1000 },
					),
				);
				yield* runner.projectEvent(created);

				yield* service.renameSession(sessionId, "Useful title");

				let row = yield* readQuery.getSession(sessionId);
				let events = yield* store.readBySession(sessionId);
				expect(mockApi.session.update).not.toHaveBeenCalled();
				expect(row?.title).toBe("Useful title");
				expect(events.map((event) => event.type)).toEqual([
					"session.created",
					"session.renamed",
				]);
				expect(events[1]?.data).toEqual({
					sessionId,
					title: "Useful title",
				});

				const duplicateCreated = yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Claude Session",
							provider: "claude",
						},
						{ provider: "claude", createdAt: 3000 },
					),
				);
				yield* runner.projectEvent(duplicateCreated);

				row = yield* readQuery.getSession(sessionId);
				events = yield* store.readBySession(sessionId);
				const rows = yield* sql<{ title: string }>`
					SELECT title FROM sessions WHERE id = ${sessionId}`;
				expect(row?.title).toBe("Useful title");
				expect(rows[0]?.title).toBe("Useful title");
				expect(events.map((event) => event.type)).toEqual([
					"session.created",
					"session.renamed",
					"session.created",
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect("rename surfaces a projector failure with its cause intact", () => {
		const mockApi = makeMockApi();
		const dir = mkdtempSync(join(tmpdir(), "conduit-rename-failure-"));
		const filename = join(dir, "events.db");
		const sessionId = "ses-claude-rename-failure";
		const rootCause = new Error("rename projection exploded");
		const failingProjector: EffectProjector = {
			name: "failing-rename-projector",
			handles: ["session.renamed"],
			project: () =>
				Effect.fail(
					new ProjectionError({
						projector: "failing-rename-projector",
						operation: "project",
						cause: rootCause,
					}),
				),
		};
		const layer = makeLiveServiceLayer(
			mockApi,
			filename,
			undefined,
			undefined,
			[failingProjector],
		);

		return Effect.gen(function* () {
			const runner = yield* ProjectionRunnerEffectTag;
			const service = yield* SessionManagerServiceTag;
			const sql = yield* SqlClient.SqlClient;
			yield* runner.markRecovered();
			yield* sql`
				INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
				VALUES (${sessionId}, 'test-project', 'claude', 'Claude Session', 'idle', 1000, 1000)`;

			const result = yield* Effect.either(
				service.renameSession(sessionId, "Useful title"),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(SessionManagerError);
				// Rename now runs through the command seam, so the projector failure
				// arrives wrapped in the seam's error rather than a rename-specific one.
				expect(result.left.operation).toBe("renameSession");
				expect(result.left.cause).toBeInstanceOf(SessionCommandError);
				if (result.left.cause instanceof SessionCommandError) {
					expect(result.left.cause.operation).toBe("session.renamed.commit");
					expect(result.left.cause.cause).toBeInstanceOf(ProjectionRunnerError);
					if (result.left.cause.cause instanceof ProjectionRunnerError) {
						expect(result.left.cause.cause.cause).toBeInstanceOf(
							ProjectionError,
						);
						if (result.left.cause.cause.cause instanceof ProjectionError) {
							expect(result.left.cause.cause.cause.cause).toBe(rootCause);
						}
					}
				}
			}
			expect(mockApi.session.update).not.toHaveBeenCalled();
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		);
	});

	it.effect(
		"renames a named Claude instance session through the event store",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-named-session-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-named-claude-rename";
			writeFileSync(
				join(dir, "daemon.json"),
				JSON.stringify({
					pid: 1234,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
					instances: [
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
						},
					],
				}),
			);
			const layer = makeLiveServiceLayer(mockApi, filename, undefined, dir);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
					VALUES (${sessionId}, 'test-project', 'work-claude', 'Claude Session', 'idle', 1000, 1000)`;

				const created = yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Claude Session",
							provider: "work-claude",
						},
						{ provider: "work-claude", createdAt: 1000 },
					),
				);
				yield* runner.projectEvent(created);

				yield* service.renameSession(sessionId, "Named title");

				expect(mockApi.session.update).not.toHaveBeenCalled();
				expect((yield* readQuery.getSession(sessionId))?.title).toBe(
					"Named title",
				);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"falls back to API rename when persistence has no matching session row",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-missing-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-missing-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const service = yield* SessionManagerServiceTag;

				yield* service.renameSession(sessionId, "API title");

				// No row to mutate, so nothing is appended — but upstream may still
				// know the session, so the rename is still forwarded.
				const events = yield* store.readBySession(sessionId);
				expect(events).toEqual([]);
				expect(mockApi.session.update).toHaveBeenCalledWith(sessionId, {
					title: "API title",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"records an OpenCode-created session as a canonical event, not just a row",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-create-event-"));
			const filename = join(dir, "events.db");
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("New", {
					account: {
						driver: "opencode",
						id: AccountIdSchema.make("opencode"),
						name: "OpenCode",
					},
					pick: {
						harness: "opencode",
						model: { providerId: "openai", modelId: "gpt-4" },
						effort: "high",
						contextWindow: "",
					},
				});

				// conduit-test-48mo.1: create used to INSERT the sessions row directly
				// and append nothing, so a read model rebuilt from the event store lost
				// every OpenCode-backed session.
				const events = yield* store.readBySession(session.id);
				expect(events.map((e) => e.type)).toEqual([
					"session.created",
					"session.model_changed",
					"session.variant_changed",
					"session.context_window_changed",
				]);
				expect(yield* readQuery.getSession(session.id)).toMatchObject({
					provider: "opencode",
					model_id: "gpt-4",
					model_provider: "openai",
					variant: "high",
					context_window: "",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"renames an OpenCode-backed session in the read model and upstream",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-opencode-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-opencode-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
					VALUES (${sessionId}, 'test-project', 'opencode', 'OpenCode Session', 'idle', 1000, 1000)`;

				yield* service.renameSession(sessionId, "API title");

				// conduit-test-xy29: this used to reach OpenCode only, so a SQLite
				// reader kept serving the old title. Rename now appends its event
				// like every other mutation, and upstream is synced from it.
				const events = yield* store.readBySession(sessionId);
				expect(events.map((event) => event.type)).toEqual(["session.renamed"]);
				expect(mockApi.session.update).toHaveBeenCalledWith(sessionId, {
					title: "API title",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"fails instead of falling back to API rename when the persisted session lookup fails",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-read-fails-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-read-fails-rename";
			const readQueryFailure = new ReadQueryEffectError({
				operation: "getSession",
				cause: "read model unavailable",
			});
			const readQuery: ReadQueryEffect = {
				listPendingClaudeQuestionTools: () => Effect.succeed([]),
				readToolDetails: vi.fn(() => Effect.succeed([])),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getSession: vi.fn(() => Effect.fail(readQueryFailure)),
				getSessionFamilyRoot: vi.fn(() => Effect.fail(readQueryFailure)),
				getGoalDetails: () =>
					Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				getStrandedChildren: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				listSessionGitRefreshTargets: vi.fn(() => Effect.succeed([])),
				getSessionSkillMessages: vi.fn(() => Effect.succeed([])),
				readSessionTranscriptCatchUp: () =>
					Effect.succeed({ messages: [], version: 0 }),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() =>
					Effect.succeed({ rows: [], version: 0 }),
				),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
				getSessionHistoryMetadata: vi.fn(() =>
					Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
				),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
				readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
				readInboxState: () => Effect.succeed(undefined),
				readStoreIdentity: () => Effect.succeed("store"),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
			};
			const layer = makeLiveServiceLayer(mockApi, filename, readQuery);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				const result = yield* Effect.either(
					service.renameSession(sessionId, "API title"),
				);

				expect(result._tag).toBe("Left");
				expect(mockApi.session.update).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"persists permission mode as an event and projects the session row",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-permission-mode-"));
			const filename = join(dir, "events.db");

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const sessionId = "ses-permission-mode";
				yield* runner.markRecovered();
				yield* sql`
				INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
				VALUES (${sessionId}, 'test-project', 'claude', 'Permission session', 'idle', 1000, 1000)`;

				yield* persistSessionPermissionMode(sessionId, "full");

				const events = yield* store.readBySession(sessionId);
				expect(events.map((event) => event.type)).toEqual([
					"session.permission_mode_changed",
				]);
				expect(events[0]?.data).toEqual({ sessionId, mode: "full" });
				expect((yield* readQuery.getSession(sessionId))?.permission_mode).toBe(
					"full",
				);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"restores sparse model settings and valid permission modes in one read",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-restore-mode-"));
			const filename = join(dir, "events.db");

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (
						id, project_id, provider, title, status, permission_mode, created_at, updated_at
					) VALUES
						('ses-auto', 'test-project', 'claude', 'Auto', 'idle', 'auto', 1000, 1000),
						('ses-default', 'test-project', 'claude', 'Default', 'idle', NULL, 1000, 1000),
						('ses-invalid', 'test-project', 'claude', 'Invalid', 'idle', 'broken', 1000, 1000)`;
				yield* sql`INSERT INTO sessions (
					id, project_id, provider, title, status, created_at, updated_at,
					model_id, model_provider, variant, context_window, permission_mode
				) VALUES
					('ses-complete', 'test-project', 'claude', 'Complete', 'idle', 1000, 1000, 'model', 'claude', 'high', '1m', 'full'),
					('ses-model-only', 'test-project', 'claude', 'Partial', 'idle', 1000, 1000, 'model', NULL, NULL, NULL, NULL),
					('ses-provider-only', 'test-project', 'claude', 'Partial', 'idle', 1000, 1000, NULL, 'claude', NULL, NULL, NULL),
					('ses-variant', 'test-project', 'claude', 'Empty', 'idle', 1000, 1000, NULL, NULL, '', NULL, NULL),
					('ses-context', 'test-project', 'claude', 'Empty', 'idle', 1000, 1000, NULL, NULL, NULL, '', NULL)`;
				yield* setDefaultPermissionMode("plan");
				const read = yield* ReadQueryEffectTag;
				const fullRead = vi.fn(read.listSessions);
				expect(
					yield* restoreSessionSettings().pipe(
						Effect.provideService(ReadQueryEffectTag, {
							...read,
							listSessions: fullRead,
						}),
					),
				).toEqual({ modelSettings: 4, permissionModes: 2 });
				expect(fullRead).not.toHaveBeenCalled();
				expect(yield* getPermissionMode("ses-auto")).toBe("auto");
				expect(yield* getPermissionMode("ses-default")).toBe("plan");
				expect(yield* getPermissionMode("ses-invalid")).toBe("plan");
				expect(yield* getOverrides("ses-invalid")).toBeUndefined();
				expect(yield* getOverrides("ses-model-only")).toBeUndefined();
				expect(yield* getOverrides("ses-provider-only")).toBeUndefined();
				expect(yield* getOverrides("ses-variant")).toEqual({ variant: "" });
				expect(yield* getOverrides("ses-context")).toEqual({
					contextWindow: "",
				});
				expect(yield* getModel("ses-complete")).toEqual({
					modelID: "model",
					providerID: "claude",
				});
				expect(yield* getVariant("ses-complete")).toBe("high");
				expect(yield* getContextWindow("ses-complete")).toBe("1m");
				expect(yield* getPermissionMode("ses-complete")).toBe("full");
			}).pipe(
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(filename, "test-project"),
						Layer.fresh(makeOverridesStateLive()),
					),
				),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
	it.effect(
		"recovers pending projections before durable pick repair and retries recoverable records",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-pick-repair-"));
			const filename = join(dir, "events.db");
			writeFileSync(
				join(dir, "daemon.json"),
				JSON.stringify({
					...defaultDaemonConfig(),
					instances: [],
					accountDefaults: {},
				}),
			);
			const layer = () =>
				Layer.mergeAll(
					makePersistenceEffectLayer(filename, "test-project"),
					Layer.succeed(ConfigTag, makeMockConfig({ configDir: dir })),
					AccountDirectoryFromConfigLive(
						dir,
						configuredClaudeConfigDir(join(dir, "login")),
					),
				);
			return Effect.gen(function* () {
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* (yield* ProjectionRunnerEffectTag).markRecovered();
					yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at, model_id, model_provider, variant, context_window)
					VALUES ('partial', 'opencode', 1, 1, 'model', 'openai', NULL, '1m'),
					('no-history', 'opencode', 1, 1, NULL, NULL, NULL, NULL),
					('unresolved', 'late-instance', 1, 1, 'model', 'claude', NULL, NULL)`;
					yield* (yield* EventStoreEffectTag).appendBatch([
						canonicalEvent("session.created", "lagged", {
							sessionId: "lagged",
							title: "Pending projection",
							provider: "opencode",
							providerSessionId: "lagged",
						}),
						canonicalEvent("session.model_changed", "lagged", {
							sessionId: "lagged",
							modelId: "model",
							providerId: "openai",
						}),
					]);
					// Reopen as a pre-repair store, with durable events still unprojected.
					yield* sql`DROP TABLE session_pick_backfill`;
					yield* sql`DROP TABLE session_pick_backfill_state`;
					yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 57`;
				}).pipe(Effect.provide(layer()));
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT session_id FROM session_pick_backfill`,
					).toEqual([]);
					expect(yield* backfillSessionPicks()).toBe(2);
					expect(
						yield* sql`SELECT session_id, retry_reason FROM session_pick_backfill`,
					).toEqual([
						{ session_id: "unresolved", retry_reason: "driver_unresolved" },
					]);
					expect(
						yield* sql`SELECT variant, context_window FROM sessions WHERE id = 'partial'`,
					).toEqual([{ variant: "", context_window: "1m" }]);
					expect(
						yield* sql`SELECT model_id, variant, context_window FROM sessions WHERE id = 'lagged'`,
					).toEqual([{ model_id: "model", variant: "", context_window: "" }]);
				}).pipe(Effect.provide(layer()));
				yield* Effect.gen(function* () {
					const read = yield* ReadQueryEffectTag;
					const rowRead = vi.fn(read.getSession);
					expect(
						yield* backfillSessionPicks().pipe(
							Effect.provideService(ReadQueryEffectTag, {
								...read,
								getSession: rowRead,
							}),
						),
					).toBe(0);
					expect(rowRead).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer()));
				yield* Effect.sync(() =>
					writeFileSync(
						join(dir, "daemon.json"),
						JSON.stringify({
							pid: 1,
							port: 2633,
							projects: [],
							pinHash: null,
							tls: false,
							debug: false,
							keepAwake: false,
							instances: [
								{
									id: "late-instance",
									name: "Late",
									port: 0,
									managed: false,
									driver: "claude",
								},
							],
						}),
					),
				);
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* backfillSessionPicks()).toBe(1);
					expect(
						yield* sql`SELECT session_id FROM session_pick_backfill`,
					).toEqual([]);
				}).pipe(Effect.provide(layer()));
				yield* Effect.gen(function* () {
					const read = yield* ReadQueryEffectTag;
					const rowRead = vi.fn(read.getSession);
					expect(
						yield* backfillSessionPicks().pipe(
							Effect.provideService(ReadQueryEffectTag, {
								...read,
								getSession: rowRead,
							}),
						),
					).toBe(0);
					expect(rowRead).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer()));
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"deleteSession removes a SQLite-backed session from the list",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-delete-sqlite-"));
			const filename = join(dir, "events.db");
			const mockApi = makeMockApi();

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (
						id, provider, title, status, created_at, updated_at, project_id
					) VALUES ('ses-doomed', 'claude', 'Doomed', 'idle', 1000, 1000, 'test-project')`;

				const before = yield* listSessions("test-project", undefined, {
					slug: "test-project",
					folders: [tmpdir()],
				});
				expect(before.map((s) => s.id)).toContain("ses-doomed");

				yield* deleteSession("ses-doomed");

				const after = yield* listSessions("test-project", undefined, {
					slug: "test-project",
					folders: [tmpdir()],
				});
				expect(after.map((s) => s.id)).not.toContain("ses-doomed");
			}).pipe(
				Effect.provide(makeLiveServiceLayer(mockApi, filename)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"deleteSession removes a session that has subagent children",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-delete-children-"));
			const filename = join(dir, "events.db");
			const mockApi = makeMockApi();

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* sql`
				INSERT INTO sessions (
					id, project_id, provider, title, status, parent_id, created_at, updated_at
				) VALUES
					('ses-parent', 'test-project', 'claude', 'Parent', 'idle', NULL, 1000, 1000),
					('ses-child', 'test-project', 'claude', 'Subagent', 'idle', 'ses-parent', 1000, 1000)`;

				yield* deleteSession("ses-parent");

				const after = yield* listSessions("test-project", undefined, {
					slug: "test-project",
					folders: [tmpdir()],
				});
				const ids = after.map((s) => s.id);
				expect(ids).not.toContain("ses-parent");
				expect(ids).not.toContain("ses-child");
			}).pipe(
				Effect.provide(makeLiveServiceLayer(mockApi, filename)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
