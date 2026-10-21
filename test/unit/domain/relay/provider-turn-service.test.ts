import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../../src/lib/account-directory.js";
import {
	AccountIdSchema,
	type ClaudeAccount,
} from "../../../../src/lib/contracts/account.js";
import {
	MessageVersion,
	PartVersion,
} from "../../../../src/lib/contracts/tool-wire.js";
import type { DaemonConfig } from "../../../../src/lib/daemon/config-persistence.js";
import {
	AccountDirectory,
	AccountDirectoryFromConfigLive,
	AccountDirectoryStateLive,
} from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { AgentServiceTag } from "../../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../../src/lib/domain/relay/Services/alerts.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceLive,
	type ProviderTurnServiceSendInput,
	ProviderTurnServiceTag,
	STOP_ABORT_WAIT_MS,
} from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusTag } from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	OverridesStateTag,
	setPermissionMode,
	startProcessingTimeout,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { SessionTitleService } from "../../../../src/lib/domain/relay/Services/session-title-service.js";
import { SessionTitleServiceTag } from "../../../../src/lib/domain/relay/Services/session-title-service.js";
import type { OpenCodeAPI } from "../../../../src/lib/instance/opencode-api.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "../../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type ProviderStateEffect,
	ProviderStateEffectTag,
} from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import type { SessionRow } from "../../../../src/lib/persistence/read-model-types.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	ProviderInstanceFailure,
	ProviderNotRegistered,
} from "../../../../src/lib/provider/errors.js";
import { openCodeInputMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { OpenCodeProviderInstance } from "../../../../src/lib/provider/opencode-provider-instance.js";
import {
	type OrchestrationCommand,
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../../src/lib/provider/orchestration-read-model.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../../src/lib/provider/provider-registry.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../../src/lib/provider/provider-runtime-event-to-domain.js";
import { settleSessionRuns } from "../../../../src/lib/provider/session-run-settlement.js";
import type {
	EventSink,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "../../../../src/lib/provider/types.js";
import {
	MOCK_PROJECT_DIR,
	makeMockAccountDirectory,
	makeMockAgentService,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
	PassThroughSessionInbox,
} from "../../../helpers/mock-factories.js";
import { partialFake } from "../../../helpers/partial-fake.js";
import { providerRuntimeEvent } from "../../../helpers/provider-runtime-event.js";

const completedTurn = (overrides?: Partial<TurnResult>): TurnResult => ({
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
	...overrides,
});

const openCodeCatalog = {
	providers: [
		{
			id: "openai",
			name: "OpenAI",
			models: [
				{
					id: "gpt-4.1",
					name: "GPT-4.1",
					variants: { high: {} },
					contextWindowOptions: [{ value: "128k", label: "128k" }],
				},
			],
		},
		{
			id: "opencode",
			name: "OpenCode",
			models: [
				{ id: "test-model", name: "Test Model" },
				{ id: "test", name: "Test" },
			],
		},
	],
	defaults: {},
	connected: ["openai", "opencode"],
};

const flushDispatch = () =>
	Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));

const tempConfigDirs: string[] = [];

afterEach(() => {
	for (const configDir of tempConfigDirs.splice(0)) {
		rmSync(configDir, { recursive: true, force: true });
	}
});

const writeDaemonConfig = (config: DaemonConfig): string => {
	const configDir = mkdtempSync(join(tmpdir(), "provider-turn-routing-"));
	tempConfigDirs.push(configDir);
	writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
	return configDir;
};

type TestSendInputOverrides = Omit<
	Partial<ProviderTurnServiceSendInput>,
	"model"
> & {
	model?: ProviderTurnServiceSendInput["model"] | undefined;
};

const defaultInput = (
	overrides?: TestSendInputOverrides,
): ProviderTurnServiceSendInput => {
	const { model: overrideModel, ...rest } = overrides ?? {};
	const model =
		overrides && "model" in overrides
			? overrideModel
			: {
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				};
	return {
		clientId: "client-1",
		commandId: "cmd-send-default",
		sessionId: "session-1",
		text: "current prompt",
		...(model === undefined ? {} : { model }),
		...rest,
	};
};

const historyRow = (text: string) => ({
	id: `message-${text}`,
	session_id: "session-1",
	turn_id: "turn-1",
	role: "user",
	text,
	cost: null,
	tokens_in: null,
	tokens_out: null,
	tokens_cache_read: null,
	tokens_cache_write: null,
	context_window: null,
	version: MessageVersion.make(0),
	is_streaming: 0,
	is_backfilled: 0,
	created_at: 1,
	updated_at: 1,
	parts: [
		{
			id: `part-${text}`,
			message_id: `message-${text}`,
			type: "text",
			text,
			tool_name: null,
			call_id: null,
			input: null,
			result: null,
			metadata: null,
			duration: null,
			status: null,
			sort_order: 0,
			version: PartVersion.make(0),
			created_at: 1,
			updated_at: 1,
		},
	],
});

const makeReadQuery = (
	getSessionMessagesWithParts: ReadQueryEffect["getSessionMessagesWithParts"],
	getSessionHistoryMetadata: ReadQueryEffect["getSessionHistoryMetadata"] = () =>
		Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
): ReadQueryEffect => ({
	listPendingClaudeQuestionTools: vi.fn(() => Effect.succeed([])),
	readToolDetails: vi.fn(() => Effect.succeed([])),
	getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
	getSessionFamilyRoot: () => Effect.succeed(undefined),
	getSession: vi.fn(() =>
		Effect.succeed(
			partialFake<SessionRow>({
				id: "session-1",
				title: "Named session",
				provider: "claude",
				model_provider: "claude",
				model_id: "claude-sonnet-4-5",
				variant: "",
				context_window: "",
				side_thread: 0,
				goal_state: null,
			}),
		),
	),
	getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
	getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
	getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
	getSessionsForReconciliation: () => Effect.succeed([]),
	getStrandedChildren: () => Effect.succeed([]),
	listSessions: vi.fn(() => Effect.succeed([])),
	listSessionInfos: vi.fn(() => Effect.succeed([])),
	countSettledSessions: () => Effect.succeed(0),
	listSessionGitRefreshTargets: vi.fn(() => Effect.succeed([])),
	getSessionSkillMessages: vi.fn(() => Effect.succeed([])),
	getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
	countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
	readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
	getSessionMessagesWithParts,
	readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
	readInboxState: () => Effect.succeed(undefined),
	readStoreIdentity: () => Effect.succeed("store"),
	getSessionHistoryMetadata,
	readSessionTranscriptPage: vi.fn(() =>
		Effect.succeed({ messages: [], hasMore: false, version: 0 }),
	),
	readSessionTranscriptCatchUp: () =>
		Effect.succeed({ messages: [], version: 0 }),
	readSessionTranscript: vi.fn(() =>
		Effect.succeed({ messages: [], version: 0 }),
	),
	readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
});

const makePersistService = (
	persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"],
): ClaudeEventPersistEffect => ({
	persistHandoffDelivered: vi.fn(() => Effect.void),
	persistEvent: vi.fn(() => Effect.void),
	persistEvents: vi.fn(() => Effect.void),
	persistUserMessage,
	ensureClaudeSubagentSession: vi.fn(() => Effect.void),
	readClaudeSubagentTranscript: () =>
		Effect.succeed({ messages: [], parts: [] }),
});

const makeProviderState = (
	overrides?: Partial<ProviderStateEffect>,
): ProviderStateEffect => ({
	projectId: "test-project",
	nativeThread: vi.fn(() => Effect.succeed(undefined)),
	getState: vi.fn(() => Effect.succeed({})),
	saveUpdates: vi.fn(() => Effect.void),
	clearState: vi.fn(() => Effect.void),
	...overrides,
});

const withPlaceholderSession = (
	readQuery: ReadQueryEffect,
): ReadQueryEffect => ({
	...readQuery,
	getSession: vi.fn((sessionId: string) =>
		readQuery
			.getSession(sessionId)
			.pipe(Effect.map((row) => row && { ...row, title: "Untitled" })),
	),
});

const makeTitleService = (): SessionTitleService => ({
	titleFromMessage: vi.fn(() => Effect.void),
});

const makeIngestion = (
	overrides?: Partial<ProviderRuntimeIngestion>,
): ProviderRuntimeIngestion => ({
	ingest: vi.fn(() => Effect.succeed(1)),
	ingestBatch: vi.fn(() => Effect.succeed(1)),
	drain: vi.fn(() => Effect.void),
	...overrides,
});

const makeEngine = (input?: {
	readonly providerId?: string | undefined;
	readonly result?: TurnResult;
	readonly dispatchEffect?: (
		command: OrchestrationCommand,
	) => ReturnType<OrchestrationEngine["dispatchEffect"]>;
}) => {
	const dispatchEffect =
		input?.dispatchEffect ??
		vi.fn(() => Effect.succeed(input?.result ?? completedTurn()));
	let providerId: string | undefined = input?.providerId;
	return {
		resolveCallContextEffect: () => Effect.succeed(undefined),
		resolveSessionCallContextEffect: () => Effect.succeed(undefined),
		getProviderForSessionEffect: vi.fn(() => Effect.succeed(providerId)),
		bindSession: vi.fn((_sessionId: string, nextProviderId: string) => {
			providerId = nextProviderId;
		}),
		unbindSession: vi.fn(() => {
			providerId = undefined;
		}),
		dispatchEffect,
	} as unknown as OrchestrationEngine;
};

const serviceLayer = (input: {
	readonly engine?: OrchestrationEngine;
	readonly registry?: ProviderRegistry;
	readonly readQuery?: ReadQueryEffect;
	readonly persist?: ClaudeEventPersistEffect;
	readonly ingestion?: ProviderRuntimeIngestion;
	readonly providerState?: ProviderStateEffect;
	readonly titleService?: SessionTitleService;
	readonly api?: OpenCodeAPI;
	readonly configDir?: string;
	readonly accountDirectory?: AccountDirectory["Service"];
}) => {
	const wsHandler = makeMockWebSocketHandler({
		getClientsForSession: vi.fn(() => ["client-1"]),
	});
	const log = makeMockLogger();
	const sessionManagerService = makeMockSessionManagerService();
	const ingestion = input.ingestion ?? makeIngestion();
	const api = input.api ?? makeMockOpenCodeAPI();
	let baseLayer = Layer.mergeAll(
		Layer.succeed(ProviderRegistryTag)(
			input.registry ?? new ProviderRegistry(),
		),
		input.accountDirectory !== undefined
			? Layer.succeed(AccountDirectory)(input.accountDirectory)
			: input.configDir === undefined
				? Layer.succeed(AccountDirectory)(makeMockAccountDirectory())
				: AccountDirectoryFromConfigLive(
						input.configDir,
						configuredClaudeConfigDir("/isolated-provider-home/.claude"),
					),
		Layer.succeed(OpenCodeAPITag)(api),
		Layer.succeed(OpenCodeInstancesTag)(
			makeOpenCodeInstancesStub({ opencode: api }),
		),
		Layer.succeed(OpenCodeModelServiceTag)(
			makeMockOpenCodeModelService(openCodeCatalog),
		),
		Layer.succeed(WebSocketHandlerTag)(wsHandler),
		Layer.succeed(LoggerTag)(log),
		Layer.succeed(ConfigTag)(
			makeMockConfig({
				projectDir: MOCK_PROJECT_DIR,
				...(input.configDir === undefined
					? {}
					: { configDir: input.configDir }),
			}),
		),
		Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		makePersistenceEffectLayer(":memory:", "test-project"),
		Layer.succeed(ClaudeEventPersistEffectTag)(
			input.persist ?? makePersistService(() => Effect.void),
		),
		Layer.succeed(OrchestrationEngineTag)(input.engine ?? makeEngine()),
		Layer.succeed(ProviderRuntimeIngestionTag)(ingestion),
		AlertsLive,
		Layer.succeed(SessionTitleServiceTag)(
			input.titleService ?? makeTitleService(),
		),
	);
	if (input.readQuery) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ReadQueryEffectTag)(input.readQuery),
		);
	}
	if (input.providerState) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ProviderStateEffectTag)(input.providerState),
		);
	}
	return {
		layer: Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.provideMerge(SessionWorkspaceLive, baseLayer),
		),
		liveLayer: Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.provideMerge(
				SessionWorkspaceLive,
				Layer.provideMerge(
					ProviderRuntimeIngestionLive,
					Layer.provideMerge(
						Layer.effect(
							ClaudeEventPersistEffectTag,
							makeClaudeEventPersistEffect,
						),
						baseLayer,
					),
				),
			),
		),
		wsHandler,
		log,
		sessionManagerService,
		ingestion,
	};
};

const sendTurn = (input?: TestSendInputOverrides) =>
	Effect.gen(function* () {
		const request = defaultInput(input);
		const engine = yield* OrchestrationEngineTag;
		const providerId = yield* engine.getProviderForSessionEffect(
			request.sessionId,
		);
		const model =
			providerId === "opencode" && request.model?.providerID === "claude"
				? { providerID: "openai", modelID: "gpt-4.1" }
				: (request.model ??
					(providerId === "opencode"
						? { providerID: "openai", modelID: "gpt-4.1" }
						: { providerID: "claude", modelID: "claude-sonnet-4-5" }));
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT OR IGNORE INTO sessions
			(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
			VALUES (${request.sessionId}, ${providerId ?? model.providerID}, 'Stored session',
				${model.providerID}, ${model.modelID}, ${request.variant ?? ""}, ${request.contextWindow ?? ""}, 1, 1)`;
		const service = yield* ProviderTurnServiceTag;
		yield* service.sendTurn(request);
		yield* flushDispatch();
	});

const interruptTurn = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT OR IGNORE INTO sessions (id, provider, title, created_at, updated_at)
			VALUES ('session-1', 'opencode', 'Stored session', 1, 1)`;
		const service = yield* ProviderTurnServiceTag;
		const stopped = yield* service.beginStop({
			clientId: "client-1",
			commandId: "cmd-interrupt-default",
			sessionId: "session-1",
		});
		yield* stopped;
	});

describe("ProviderTurnService", () => {
	for (const mode of ["refresh", "rebound", "other-driver", "removed"] as const)
		it.effect(
			mode === "removed"
				? "rejects steering after the admitted account is removed with a fallback available"
				: `steers with current account credentials and the admitted account folder (${mode})`,
			() => {
				const account: ClaudeAccount = {
					id: AccountIdSchema.make("steering-account"),
					name: "Steering account",
					driver: "claude",
					folder: configuredClaudeConfigDir("/tmp/82tn9-current-folder"),
					usageEligible: false,
					env: { ANTHROPIC_API_KEY: "synthetic-current-steering-key" },
				};
				const admitted: ClaudeAccount = {
					...account,
					folder: configuredClaudeConfigDir("/tmp/82tn9-admitted-folder"),
					env: { ANTHROPIC_API_KEY: "synthetic-admitted-steering-key" },
				};
				const extraFolder = mkdtempSync(
					join(tmpdir(), "82tn9-steering-extra-"),
				);
				tempConfigDirs.push(extraFolder);
				return Effect.gen(function* () {
					const accountDirectory = yield* AccountDirectory.pipe(
						Effect.provide(
							AccountDirectoryStateLive(
								accountsStateFromInstances(
									[
										admitted,
										{
											id: "steering-fallback",
											name: "Fallback",
											driver: mode === "other-driver" ? "cursor" : "claude",
											env: { ANTHROPIC_API_KEY: "synthetic-fallback-key" },
										},
									],
									admitted.folder,
									5,
									{ defaultAccountIds: { claude: admitted.id } },
								),
							),
						),
					);
					const { liveLayer } = serviceLayer({ accountDirectory });
					return yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent("session.created", "session-1", {
								sessionId: "session-1",
								provider: account.id,
								title: "Steering credentials",
							}),
						]);
						yield* sql`UPDATE sessions SET model_provider = 'claude', model_id = 'claude-sonnet-4-5', variant = '', context_window = '' WHERE id = 'session-1'`;
						const running = yield* Deferred.make<SendTurnInput>();
						const steering = yield* Deferred.make<SendTurnInput>();
						const release = yield* Deferred.make<void>();
						const ended = yield* Deferred.make<void>();
						let ownerRunId: string | undefined;
						const instance = partialFake<ProviderInstance>({
							providerId: "claude",
							sendTurnEffect: (input) =>
								Effect.gen(function* () {
									const runId = ownerRunId ?? input.runId;
									if (!runId || !input.runId)
										throw new Error("Missing steering run reservation");
									ownerRunId = runId;
									yield* input.eventSink.push(
										providerRuntimeEvent(
											"run.started",
											input.sessionId,
											{ inputId: input.inputId, requestedRunId: input.runId },
											{ runId, eventId: `started:${input.inputId}` },
										),
									);
									if (input.inputId === "running-input") {
										yield* Deferred.succeed(running, input);
										yield* Deferred.await(release);
										yield* input.eventSink.push(
											providerRuntimeEvent(
												"turn.completed",
												input.sessionId,
												{ messageId: "" },
												{ runId },
											),
										);
										yield* Deferred.succeed(ended, undefined);
										return completedTurn();
									}
									yield* Deferred.succeed(steering, input);
									return completedTurn({ status: "joined" });
								}).pipe(
									Effect.mapError(
										(cause) =>
											new ProviderInstanceFailure({
												providerId: "claude",
												operation: "sendTurn",
												cause,
											}),
									),
								),
						});
						let sequence = 0;
						const engine = new OrchestrationEngine({
							registry: new ProviderRegistry([instance]),
							accountDirectory,
							durableCommands: {
								sql,
								projectKey: "test-project",
								write: commit.write,
								snapshot: yield* new CommandReadModelRepository(
									sql,
									"test-project",
								).bootstrap(),
								ingestion: yield* ProviderRuntimeIngestionTag,
								persistUserMessage: (yield* ClaudeEventPersistEffectTag)
									.persistUserMessage,
								now: () => 1000,
								generateId: () => `steering-dispatch-${++sequence}`,
							},
						});
						const dispatch = vi.spyOn(engine, "dispatchEffect");
						yield* Effect.gen(function* () {
							const service = yield* ProviderTurnServiceTag;
							yield* service.sendTurn(
								defaultInput({ commandId: "running-input" }),
							);
							const first = yield* Deferred.await(running);
							const runningStatus =
								yield* (yield* ReadQueryEffectTag).getSessionStatus(
									"session-1",
								);
							if (mode === "removed") {
								const state = yield* accountDirectory.apply({
									_tag: "Remove",
									id: account.id,
								});
								expect(state.deleted).toContainEqual({
									id: account.id,
									driver: "claude",
								});
								expect(
									(yield* accountDirectory.resolve({
										_tag: "Id",
										id: account.id,
									})).id,
								).toBe("steering-fallback");
								const outcome = yield* Effect.result(
									service.sendTurn(
										defaultInput({ commandId: "steering-input", steer: true }),
									),
								);
								expect.soft(outcome).toMatchObject({
									_tag: "Failure",
									failure: {
										_tag: "ProviderInstanceFailure",
										message: expect.stringContaining(account.id),
									},
								});
								expect
									.soft(
										dispatch.mock.calls.filter(
											([command]) => command.type === "send_turn",
										),
									)
									.toHaveLength(1);
								yield* Deferred.succeed(release, undefined);
								yield* Deferred.await(ended);
								return;
							}
							yield* accountDirectory.apply({
								_tag: "Update",
								id: account.id,
								updates: { configDir: account.folder.path, env: account.env },
							});
							if (mode === "rebound" || mode === "other-driver") {
								engine.bindSession("session-1", "steering-fallback");
								yield* sql`UPDATE sessions SET provider = 'steering-fallback' WHERE id = 'session-1'`;
							}
							yield* service.sendTurn(
								defaultInput({ commandId: "steering-input", steer: true }),
							);
							const command = dispatch.mock.calls
								.map(([command]) => command)
								.find(
									(command) =>
										command.type === "send_turn" &&
										command.commandId === "steering-input",
								);
							if (!command || command.type !== "send_turn")
								throw new Error("Missing steering dispatch");
							const delivered = yield* Deferred.await(steering);
							const observed = {
								runningStatus,
								dispatchAccount: command.input.account,
								account: delivered.account,
								workspaceRoot: delivered.workspaceRoot,
								extraFolders: delivered.extraFolders,
							};
							mkdirSync("test-results/process-harness", { recursive: true });
							writeFileSync(
								`test-results/process-harness/82tn-9-credentials-steering-${mode}.json`,
								JSON.stringify(observed, null, 2),
							);
							expect.soft(runningStatus).toBe("busy");
							expect
								.soft(command.input.account)
								.toEqual({ ...admitted, env: account.env });
							expect
								.soft(delivered.account)
								.toEqual({ ...admitted, env: account.env });
							expect.soft(delivered.workspaceRoot).toBe(first.workspaceRoot);
							expect.soft(delivered.extraFolders).toEqual(first.extraFolders);
							expect.soft(delivered.extraFolders).toEqual([extraFolder]);
							yield* Deferred.succeed(release, undefined);
							yield* Deferred.await(ended);
							expect(
								yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
							).toEqual([
								{ status: "side_effect_completed" },
								{ status: "side_effect_completed" },
							]);
						}).pipe(
							Effect.provide(
								ProviderTurnServiceLive.pipe(
									Layer.provide(
										Layer.mergeAll(
											Layer.succeed(OrchestrationEngineTag)(engine),
											Layer.succeed(ConfigTag)(
												makeMockConfig({
													projectDir: MOCK_PROJECT_DIR,
													extraFolders: [extraFolder],
												}),
											),
										),
									),
									Layer.fresh,
								),
							),
						);
					}).pipe(Effect.provide(liveLayer));
				});
			},
		);
	it.effect(
		"pauses queued handoffs rejected before a provider reservation exists",
		() => {
			const send = vi.fn(() => Effect.void);
			const { liveLayer } = serviceLayer({});
			const dependencies = Layer.mergeAll(
				liveLayer,
				Layer.succeed(ProviderTurnServiceTag)(
					partialFake<ProviderTurnService>({
						sendTurn: send,
						turnFences: () => ({ stopping: false, switching: false }),
						fenceLifts: Effect.succeed(Stream.empty),
					}),
				),
				Layer.succeed(AgentServiceTag)(makeMockAgentService()),
				Layer.succeed(ProviderRegistryTag)(new ProviderRegistry()),
				Layer.succeed(SessionEventBusTag)({
					publish: () => Effect.void,
					publishAdvance: () => Effect.void,
					subscribe: () => Effect.succeed(Stream.empty),
					subscribeAdvances: () => Effect.succeed(Stream.empty),
				}),
				Layer.succeed(Usage)({
					readings: Stream.empty,
					latest: () => Effect.succeed(undefined),
					refresh: () => Effect.succeed([]),
					turnEnded: () => Effect.void,
					pickFailover: () => Effect.succeed(undefined),
				}),
			);
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						provider: "claude",
						title: "Unsent queue",
					}),
					...["queued-a", "queued-b"].map((inputId) =>
						canonicalEvent("input.admitted", "session-1", {
							sessionId: "session-1",
							inputId,
							delivery: "queue",
							request: { text: inputId },
						}),
					),
				]);
				const inbox = yield* SessionInboxTag;
				yield* inbox.sendNow({
					clientId: "browser",
					sessionId: "session-1",
					inputId: "queued-a",
				});
				expect(
					yield* sql`SELECT turn.state, turn.started_at, run.status FROM turns turn JOIN provider_runs run ON run.id = turn.run_id WHERE turn.id = 'queued-a'`,
				).toEqual([{ state: "error", started_at: null, status: "error" }]);
				expect(
					yield* sql`SELECT json_extract(data, '$.userMessageId') AS input_id FROM events WHERE type = 'turn.error'`,
				).toEqual([{ input_id: null }]);
				expect(
					yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
				).toMatchObject({ paused: true });
				yield* inbox.start;
				yield* flushDispatch();
				expect(send).toHaveBeenCalledOnce();
				expect(
					yield* sql`SELECT input_id, state FROM pending_inputs WHERE state = 'queued'`,
				).toEqual([{ input_id: "queued-b", state: "queued" }]);
			}).pipe(
				Effect.provide(SessionInboxLive.pipe(Layer.provideMerge(dependencies))),
			);
		},
	);

	// A failure can commit before cleanup places the user. Placement must retain
	// that exact reservation's failed end without inventing intake. OpenCode must
	// also retain its reserved message ID so a delayed native echo cannot duplicate it.
	for (const driver of ["claude", "opencode"] as const) {
		for (const mode of ["error", "interrupted", "pending"] as const) {
			if (driver === "claude" && mode === "pending") continue;
			const terminal = mode === "pending" ? "error" : mode;
			it.effect(
				`retains ${driver} ${terminal} when the user is placed ${mode === "pending" ? "before delivery failure" : "after the owned end"}`,
				() => {
					let dispatch: (
						command: SendTurnCommand,
					) => Effect.Effect<TurnResult, ProviderInstanceFailure> = () =>
						Effect.die("uninitialized dispatch");
					const dispatchEffect = vi.fn((command: SendTurnCommand) =>
						dispatch(command),
					) as unknown as OrchestrationEngine["dispatchEffect"];
					const { liveLayer } = serviceLayer({
						engine: makeEngine({ providerId: driver, dispatchEffect }),
					});
					return Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						const ingestion = yield* ProviderRuntimeIngestionTag;
						const inputId = "cmd-send-default";
						const messageId =
							driver === "opencode" ? openCodeInputMessageId(inputId) : inputId;
						let endedAt = 0;
						yield* commit([
							canonicalEvent("session.created", "session-1", {
								sessionId: "session-1",
								provider: driver,
								title: "Late placement",
							}),
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-b",
								delivery: "queue",
								request: { text: "next" },
							}),
						]);
						yield* sql`UPDATE sessions SET provider = ${driver}, model_provider = ${driver === "opencode" ? "openai" : "claude"},
							model_id = ${driver === "opencode" ? "gpt-4.1" : "claude-sonnet-4-5"}, variant = '', context_window = '' WHERE id = 'session-1'`;
						dispatch = (command) =>
							Effect.gen(function* () {
								yield* commit([
									...(command.events ?? []),
									canonicalEvent(
										"run.requested",
										"session-1",
										{ inputId, runId: "reserved-run" },
										{ metadata: { runId: "reserved-run" } },
									),
								]);
								yield* sql`INSERT INTO provider_command_outbox
							(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
							VALUES (1, ${inputId}, 'test-project', 'session-1', ${driver}, 'send_turn',
								'reserved-run', '{"inputId":"cmd-send-default"}', 'running', 1, 1, 1)`;
								yield* command.onAccepted ?? Effect.void;
								endedAt = Date.now();
								if (mode !== "pending")
									yield* command.input.eventSink.push({
										...providerRuntimeEvent(
											terminal === "error" ? "turn.error" : "turn.interrupted",
											"session-1",
											{
												messageId: "",
												...(terminal === "error"
													? {
															error: "Stopped before echo",
															code: "provider_error",
														}
													: { reason: "Stopped before echo" }),
											},
											{ createdAt: endedAt },
										),
										runId: "reserved-run",
									});
							}).pipe(
								Effect.orDie,
								Effect.andThen(
									mode === "pending"
										? Effect.fail(
												new ProviderInstanceFailure({
													providerId: driver,
													operation: "sendTurn",
													cause: new Error("Stopped before echo"),
												}),
											)
										: Effect.succeed(
												completedTurn({
													status: terminal,
													error: {
														code: "provider_error",
														message: "Stopped before echo",
													},
												}),
											),
								),
							);
						yield* sendTurn();
						expect(dispatchEffect).toHaveBeenCalledOnce();
						expect(
							yield* sql`SELECT id, input_id FROM messages WHERE role = 'user'`,
						).toEqual([{ id: messageId, input_id: inputId }]);
						expect(
							yield* sql`SELECT state, run_id, started_at, completed_at FROM turns`,
						).toEqual([
							{
								state: terminal,
								run_id: "reserved-run",
								started_at: null,
								completed_at: mode === "pending" ? expect.any(Number) : endedAt,
							},
						]);
						expect(
							yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
						).toMatchObject({ paused: true });
						expect(
							yield* sql`SELECT input_id, state FROM pending_inputs`,
						).toEqual([{ input_id: "queued-b", state: "queued" }]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
						).toEqual([]);
						expect(
							yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events
							WHERE type IN ('turn.error', 'turn.interrupted')`,
						).toEqual([{ type: `turn.${terminal}`, run_id: "reserved-run" }]);
						if (driver === "opencode") {
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"message.created",
									"session-1",
									{ sessionId: "session-1", messageId, inputId, role: "user" },
									{ eventId: "late-native-echo", providerId: driver },
								),
							);
							expect(yield* sql`SELECT id, state FROM turns`).toEqual([
								{ id: messageId, state: terminal },
							]);
						}
					}).pipe(Effect.provide(liveLayer));
				},
			);
		}
	}
	// Before intake, only the executor can distinguish a local recall from indeterminate delivery.
	for (const continuation of [false, true]) {
		it.effect(
			`processing timer defers pending intake to the executor (${continuation ? "continuation" : "send"})`,
			() => {
				let accept: (command: SendTurnCommand) => Effect.Effect<TurnResult> =
					() => Effect.die("uninitialized dispatch");
				const dispatchEffect = vi.fn((command: SendTurnCommand) =>
					accept(command),
				) as unknown as OrchestrationEngine["dispatchEffect"];
				const { liveLayer: layer } = serviceLayer({
					engine: makeEngine({ providerId: "claude", dispatchEffect }),
				});
				const dependencies = Layer.mergeAll(
					layer,
					Layer.succeed(AgentServiceTag)(makeMockAgentService()),
					Layer.succeed(ProviderRegistryTag)(new ProviderRegistry()),
					Layer.succeed(SessionEventBusTag)({
						publish: () => Effect.void,
						publishAdvance: () => Effect.void,
						subscribe: () => Effect.succeed(Stream.empty),
						subscribeAdvances: () => Effect.succeed(Stream.empty),
					}),
					Layer.succeed(Usage)({
						readings: Stream.empty,
						latest: () => Effect.succeed(undefined),
						refresh: () => Effect.succeed([]),
						turnEnded: () => Effect.void,
						pickFailover: () => Effect.succeed(undefined),
					}),
				);
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* commit([
						canonicalEvent("session.created", "session-1", {
							sessionId: "session-1",
							provider: "claude",
							title: "Timeout ownership",
						}),
					]);
					yield* sql`UPDATE sessions SET provider = 'claude', model_provider = 'claude', model_id = 'claude-sonnet-4-5', variant = '', context_window = '' WHERE id = 'session-1'`;
					const placed = yield* Deferred.make<void>();
					const inputId = continuation ? "cut-off-input" : "cmd-send-default";
					accept = (command) =>
						Effect.gen(function* () {
							yield* commit([
								...(command.events ?? []),
								canonicalEvent(
									"run.requested",
									"session-1",
									{
										runId: "reserved-run",
										inputId: command.input.inputId,
									},
									{ metadata: { runId: "reserved-run" } },
								),
							]);
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"message.created",
									"session-1",
									{
										messageId: inputId,
										role: "user",
										inputId,
										sessionId: "session-1",
									},
									{ runId: "reserved-run" },
								),
							);
							yield* command.onAccepted ?? Effect.void;
							yield* Deferred.succeed(placed, undefined);
							return yield* Effect.never;
						}).pipe(Effect.orDie);
					yield* sendTurn({
						...(continuation
							? { continuation: { cutOffMessageId: inputId } }
							: {}),
					});
					expect(dispatchEffect).toHaveBeenCalledOnce();
					yield* Deferred.await(placed);
					const inbox = yield* SessionInboxTag;
					const queue = (id: string) =>
						inbox.submit({
							sessionId: "session-1",
							clientId: "browser",
							inputId: id,
							delivery: "queue",
							request: { text: id },
						});
					yield* queue("queued-b");
					expect(
						yield* sql`SELECT state, run_id, started_at FROM turns WHERE id = ${inputId}`,
					).toEqual([
						{ state: "pending", run_id: "reserved-run", started_at: null },
					]);
					const state = yield* Ref.get(yield* OverridesStateTag);
					const timeout = state.processingTimeouts.get("session-1");
					expect(timeout).toBeDefined();
					yield* timeout?.callback() ??
						Effect.die("missing processing timeout");
					expect(
						yield* sql`SELECT state, run_id, started_at FROM turns WHERE id = ${inputId}`,
					).toEqual([
						{ state: "pending", run_id: "reserved-run", started_at: null },
					]);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = 'reserved-run'`,
					).toEqual([{ status: "pending" }]);
					expect(
						yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
					).toMatchObject({ paused: false });
					yield* inbox.start;
					yield* flushDispatch();
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs ORDER BY input_id`,
					).toEqual([{ input_id: "queued-b", state: "queued" }]);
					expect(dispatchEffect).toHaveBeenCalledTimes(1);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
					).toEqual([]);
				}).pipe(
					Effect.provide(
						SessionInboxLive.pipe(Layer.provideMerge(dependencies)),
					),
				);
			},
		);
	}
	// Stop fence failure modes: the abort fails (unregistered account, rejected
	// dispatch) and the fence stays up; the worker's identity lookup fails before
	// the abort is issued; the provider never answers and its turn stays open; a
	// concurrent Stops must share the worker's success or rejection; the fence lifts without
	// waking the inbox drain; the provider acknowledges before the turn ends; a
	// continuation admitted behind the fence is stopped too.
	describe("Stop fence", () => {
		const seedCapturedStop = (commandId = "cmd-interrupt-default") =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type, provider_process_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (100, ${commandId}, 'test-project', 'session-1', 'claude', 'interrupt_turn', 'original-process', '{}', 'running', 1, 1, 1)`;
			});
		const confirmProcessLoss = (
			command: Extract<OrchestrationCommand, { type: "end_session" }>,
		) =>
			Effect.gen(function* () {
				expect(command).toMatchObject({
					retireProcess: true,
					targetProviderId: "claude",
					providerProcessId: "original-process",
				});
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const owners = yield* sql<{ runId: string }>`SELECT run_id AS runId
					FROM provider_command_outbox WHERE session_id = ${command.sessionId}
					AND effect_type = 'send_turn' AND provider_process_id = ${command.providerProcessId}`;
				yield* settleSessionRuns(
					sql,
					command.sessionId,
					"Provider process exited",
					(events) => ingestion.ingestBatch(events),
					{ owners },
				);
				return completedTurn();
			});
		const seedSession = Effect.flatMap(
			SqlClient.SqlClient,
			(
				sql,
			) => sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
				VALUES ('session-1', 'claude', 'Stored session', 1, 1)`,
		);

		const seedClaimedRun = (
			inputId: string,
			sequence: number,
			accepted = true,
			placed = true,
		) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const runId = `run-${inputId}`;
				const metadata = { metadata: { runId } };
				yield* commit([
					canonicalEvent(
						"run.requested",
						"session-1",
						{ runId, inputId },
						metadata,
					),
					...(placed
						? [
								canonicalEvent(
									"message.created",
									"session-1",
									{
										sessionId: "session-1",
										messageId: inputId,
										inputId,
										role: "user",
									},
									metadata,
								),
							]
						: []),
					...(accepted
						? [
								canonicalEvent(
									"run.started",
									"session-1",
									{
										requestedRunId: runId,
										inputId,
									},
									metadata,
								),
							]
						: []),
				]);
				yield* sql`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type, provider_process_id, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (${sequence}, ${inputId}, 'test-project', 'session-1', 'claude', 'send_turn', 'original-process', ${runId},
						${JSON.stringify({ inputId })}, 'running', 1, 1, 1)`;
				yield* sql`INSERT INTO command_receipts
					(command_id, session_id, project_key, status, created_at, updated_at)
					VALUES (${inputId}, 'session-1', 'test-project', 'side_effect_requested', 1, 1)`;
			});

		it.effect(
			"lifts and wakes the inbox in memory when the abort fails",
			() => {
				const dispatchEffect = vi.fn(() =>
					Effect.fail(new ProviderNotRegistered({ providerId: "claude" })),
				);
				const engine = makeEngine({ providerId: "claude", dispatchEffect });
				const { liveLayer } = serviceLayer({ engine });
				return Effect.gen(function* () {
					const service = yield* ProviderTurnServiceTag;
					yield* seedSession;
					yield* seedClaimedRun("active-input", 1);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("input.admitted", "session-1", {
							sessionId: "session-1",
							inputId: "unclaimed-input",
							delivery: "queue",
							request: { text: "unsent" },
						}),
						canonicalEvent("input.sent", "session-1", {
							sessionId: "session-1",
							inputId: "unclaimed-input",
						}),
					]);
					yield* seedClaimedRun("unclaimed-input", 2, false);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE provider_command_outbox SET status = 'pending', attempt_count = 0 WHERE command_id = 'unclaimed-input'`;
					const lifts = yield* service.fenceLifts;
					const failed = yield* interruptTurn().pipe(Effect.flip);
					expect(failed).toMatchObject({ _tag: "ProviderNotRegistered" });
					expect(service.turnFences("session-1").stopping).toBe(false);
					expect(
						yield* sql`SELECT status FROM provider_runs ORDER BY id`,
					).toEqual([{ status: "running" }, { status: "interrupted" }]);
					expect(yield* sql`SELECT state FROM turns ORDER BY id`).toEqual([
						{ state: "running" },
						{ state: "interrupted" },
					]);
					expect(
						yield* sql`SELECT status FROM provider_command_outbox ORDER BY command_id`,
					).toEqual([{ status: "running" }, { status: "failed" }]);
					expect(
						yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
					).toEqual([
						{ status: "side_effect_requested" },
						{ status: "side_effect_failed" },
					]);
					// Native rejection leaves A open; C never left our queue and was recalled locally.
					expect(
						yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id,
							json_extract(data, '$.reason') AS reason FROM events
							WHERE type IN ('turn.interrupted', 'turn.error')`,
					).toEqual([
						{
							type: "turn.interrupted",
							run_id: "run-unclaimed-input",
							reason: "Stopped before delivery",
						},
					]);
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs`,
					).toEqual([{ input_id: "unclaimed-input", state: "queued" }]);
					expect(
						yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
					).toMatchObject({ paused: true });
					// No store write stands between the lift and the drain.
					expect(yield* Stream.runCollect(Stream.take(lifts, 1))).toEqual([
						"session-1",
					]);
					// A repeated Stop issues a fresh abort instead of awaiting the failed one.
					yield* interruptTurn().pipe(Effect.flip);
					expect(dispatchEffect).toHaveBeenCalledTimes(2);
					expect(
						yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id
						FROM events WHERE type IN ('turn.interrupted', 'turn.error')`,
					).toEqual([{ run_id: "run-unclaimed-input" }]);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = 'run-active-input'`,
					).toEqual([{ status: "running" }]);
				}).pipe(Effect.provide(liveLayer));
			},
		);

		it.effect(
			"concurrent Stops share interrupt rejection without settling the claimed run",
			() => {
				const issued = Deferred.makeUnsafe<void>();
				const reject = Deferred.makeUnsafe<void>();
				const dispatchEffect = vi.fn(() =>
					Deferred.succeed(issued, undefined).pipe(
						Effect.andThen(Deferred.await(reject)),
						Effect.andThen(
							Effect.fail(new ProviderNotRegistered({ providerId: "claude" })),
						),
					),
				);
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const service = yield* ProviderTurnServiceTag;
					yield* seedSession;
					yield* seedClaimedRun("active-input", 1);
					const first = yield* Effect.forkChild(
						interruptTurn().pipe(Effect.result),
					);
					yield* Deferred.await(issued);
					const second = yield* Effect.forkChild(
						interruptTurn().pipe(Effect.result),
					);
					yield* TestClock.adjust(1);
					expect(first.pollUnsafe()).toBeUndefined();
					expect(second.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(reject, undefined);
					for (const caller of [first, second]) {
						expect(yield* Fiber.join(caller)).toMatchObject({
							_tag: "Failure",
							failure: { _tag: "ProviderNotRegistered" },
						});
					}
					expect(dispatchEffect).toHaveBeenCalledOnce();
					expect(service.turnFences("session-1").stopping).toBe(false);
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "running" },
					]);
					expect(
						yield* sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
					).toEqual([]);
				}).pipe(
					Effect.provide(
						serviceLayer({
							engine: makeEngine({ providerId: "claude", dispatchEffect }),
						}).liveLayer,
					),
				);
			},
		);

		for (const missingTable of [
			"provider_runs",
			"provider_command_outbox",
		] as const) {
			it.effect(`lifts when the ${missingTable} identity lookup fails`, () => {
				const engine = makeEngine({ providerId: "claude" });
				const { layer } = serviceLayer({ engine });
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const service = yield* ProviderTurnServiceTag;
					yield* seedSession;
					let injected = false;
					const failed = yield* interruptTurn().pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) => {
							const [query] = statement.compile();
							if (injected || !query.includes(`FROM ${missingTable}`))
								return Effect.succeed(statement);
							injected = true;
							return Effect.succeed(
								sql.unsafe("SELECT * FROM unavailable_identity"),
							);
						}),
						Effect.result,
					);
					expect(injected).toBe(true);
					expect(failed._tag).toBe("Failure");
					expect(service.turnFences("session-1").stopping).toBe(false);
					yield* interruptTurn();
					expect(engine.dispatchEffect).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(layer));
			});
		}

		for (const providerId of ["claude", "personal-claude"]) {
			it.effect(
				`Stop preserves a pending steer on ${providerId} after the running turn's native terminal`,
				() => {
					const issued = Deferred.makeUnsafe<void>();
					const engine = makeEngine({
						providerId,
						dispatchEffect: () =>
							Deferred.succeed(issued, undefined).pipe(
								Effect.as(completedTurn()),
							),
					});
					const accountDirectory = makeMockAccountDirectory([
						{
							driver: "claude",
							id: AccountIdSchema.make(providerId),
							name: "Claude account",
							folder: configuredClaudeConfigDir("/isolated-test-login"),
							usageEligible: true,
						},
					]);
					const registry = new ProviderRegistry([
						partialFake<ProviderInstance>({
							providerId: "claude",
						}),
					]);
					return Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						yield* seedSession;
						yield* sql`UPDATE sessions SET provider = ${providerId} WHERE id = 'session-1'`;
						yield* seedClaimedRun("active-input", 1);
						yield* commit([
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-steer",
								delivery: "steer",
								request: { text: "correction" },
							}),
							canonicalEvent("input.sent", "session-1", {
								sessionId: "session-1",
								inputId: "queued-steer",
								steer: true,
							}),
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-c",
								delivery: "queue",
								request: { text: "later" },
							}),
						]);
						yield* seedClaimedRun("queued-steer", 2, false, false);
						const stopped = yield* Effect.forkChild(interruptTurn());
						yield* Deferred.await(issued);
						yield* commit([
							canonicalEvent(
								"turn.interrupted",
								"session-1",
								{ messageId: "" },
								{ metadata: { runId: "run-active-input" } },
							),
						]);
						yield* TestClock.adjust(100);
						yield* Fiber.join(stopped);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ id: "run-active-input", status: "interrupted" },
							{ id: "run-queued-steer", status: "pending" },
						]);
						expect(
							yield* sql`SELECT state, started_at FROM turns WHERE id = 'queued-steer'`,
						).toEqual([]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'queued-steer'`,
						).toEqual([{ status: "side_effect_requested" }]);
						yield* commit([
							canonicalEvent(
								"message.created",
								"session-1",
								{
									sessionId: "session-1",
									messageId: "queued-steer",
									inputId: "queued-steer",
									role: "user",
								},
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{
									inputId: "queued-steer",
									requestedRunId: "run-queued-steer",
								},
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
						]);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ id: "run-active-input", status: "interrupted" },
							{ id: "run-queued-steer", status: "completed" },
						]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'queued-steer'`,
						).toEqual([{ status: "side_effect_completed" }]);
						expect(
							yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
						).toMatchObject({ paused: true });
						expect(
							yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued'`,
						).toEqual([{ input_id: "queued-c" }]);
					}).pipe(
						Effect.provide(
							serviceLayer({ engine, accountDirectory, registry }).liveLayer,
						),
					);
				},
			);
		}

		for (const replyEnd of ["native result", "native interruption"] as const) {
			it.effect(
				`Stop after the ${replyEnd} preserves the pending steer and returns without interrupting`,
				() => {
					const issued = Deferred.makeUnsafe<void>();
					const dispatchEffect = vi.fn(() =>
						Deferred.succeed(issued, undefined).pipe(
							Effect.as(completedTurn()),
						),
					);
					const engine = makeEngine({
						providerId: "claude",
						dispatchEffect,
					});
					const registry = new ProviderRegistry([
						partialFake<ProviderInstance>({
							providerId: "claude",
						}),
					]);
					return Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						yield* seedSession;
						yield* seedClaimedRun("active-input", 1);
						yield* commit([
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-steer",
								delivery: "steer",
								request: { text: "correction" },
							}),
							canonicalEvent("input.sent", "session-1", {
								sessionId: "session-1",
								inputId: "queued-steer",
								steer: true,
							}),
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-c",
								delivery: "queue",
								request: { text: "later" },
							}),
						]);
						yield* seedClaimedRun("queued-steer", 2, false, false);
						if (replyEnd === "native interruption") {
							const stopped = yield* (yield* ProviderTurnServiceTag).beginStop({
								clientId: "browser",
								commandId: "first-stop",
								sessionId: "session-1",
							});
							yield* Deferred.await(issued);
							// Concurrent callers share the original Stop's outcome.
							const repeated = yield* Effect.forkChild(interruptTurn());
							yield* TestClock.adjust(1);
							expect(repeated.pollUnsafe()).toBeUndefined();
							expect(dispatchEffect).toHaveBeenCalledOnce();
							yield* commit([
								canonicalEvent(
									"turn.interrupted",
									"session-1",
									{ messageId: "" },
									{ metadata: { runId: "run-active-input" } },
								),
							]);
							yield* TestClock.adjust(100);
							yield* stopped;
							yield* Fiber.join(repeated);
						} else {
							yield* commit([
								canonicalEvent(
									"turn.completed",
									"session-1",
									{ messageId: "" },
									{
										provider: "claude",
										metadata: { runId: "run-active-input" },
									},
								),
							]);
						}
						const stopped = yield* Effect.forkChild(interruptTurn());
						yield* TestClock.adjust(1);
						expect(stopped.pollUnsafe()).toBeDefined();
						yield* Fiber.join(stopped);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{
								id: "run-active-input",
								status:
									replyEnd === "native result" ? "completed" : "interrupted",
							},
							{ id: "run-queued-steer", status: "pending" },
						]);
						expect(dispatchEffect).toHaveBeenCalledTimes(
							replyEnd === "native interruption" ? 1 : 0,
						);
						expect(
							yield* sql`SELECT state, started_at FROM turns WHERE id = 'queued-steer'`,
						).toEqual([]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'queued-steer'`,
						).toEqual([{ status: "side_effect_requested" }]);
						// Real placement/intake makes B stoppable; its own terminal settles it once.
						yield* commit([
							canonicalEvent(
								"message.created",
								"session-1",
								{
									sessionId: "session-1",
									messageId: "queued-steer",
									inputId: "queued-steer",
									role: "user",
								},
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{
									inputId: "queued-steer",
									requestedRunId: "run-queued-steer",
								},
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{ provider: "claude", metadata: { runId: "run-queued-steer" } },
							),
						]);
						expect(
							yield* sql`SELECT state FROM turns WHERE id = 'queued-steer'`,
						).toEqual([{ state: "completed" }]);
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = 'run-queued-steer'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'queued-steer'`,
						).toEqual([{ status: "side_effect_completed" }]);
						expect(
							yield* sql`SELECT COUNT(*) AS n FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') AND json_extract(metadata, '$.runId') = 'run-queued-steer'`,
						).toEqual([{ n: 1 }]);
					}).pipe(Effect.provide(serviceLayer({ engine, registry }).liveLayer));
				},
			);
		}
		it.effect(
			"Run now joins an existing plain Stop and dispatches after its bound retires the cohort",
			() => {
				const issued = Deferred.makeUnsafe<void>();
				const delivered = Deferred.makeUnsafe<void>();
				let deliver: (command: SendTurnCommand) => Effect.Effect<TurnResult> =
					() => Effect.die("uninitialized delivery");
				const dispatchEffect = vi.fn((command: OrchestrationCommand) =>
					command.type === "send_turn"
						? deliver(command)
						: command.type === "end_session"
							? confirmProcessLoss(command)
							: Deferred.succeed(issued, undefined).pipe(
									Effect.andThen(Effect.never),
								),
				) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = makeEngine({ providerId: "claude", dispatchEffect });
				const dependencies = Layer.mergeAll(
					serviceLayer({ engine }).liveLayer,
					Layer.succeed(AgentServiceTag)(makeMockAgentService()),
					Layer.succeed(ProviderRegistryTag)(new ProviderRegistry()),
					Layer.succeed(SessionEventBusTag)({
						publish: () => Effect.void,
						publishAdvance: () => Effect.void,
						subscribe: () => Effect.succeed(Stream.empty),
						subscribeAdvances: () => Effect.succeed(Stream.empty),
					}),
					Layer.succeed(Usage)({
						readings: Stream.empty,
						latest: () => Effect.succeed(undefined),
						refresh: () => Effect.succeed([]),
						turnEnded: () => Effect.void,
						pickFailover: () => Effect.succeed(undefined),
					}),
				);
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const context =
						yield* Effect.context<
							Effect.Services<ReturnType<typeof seedClaimedRun>>
						>();
					const service = yield* ProviderTurnServiceTag;
					const inbox = yield* SessionInboxTag;
					yield* commit([
						canonicalEvent("session.created", "session-1", {
							sessionId: "session-1",
							provider: "claude",
							title: "Stop then Run now",
						}),
					]);
					yield* sql`UPDATE sessions SET model_provider = 'claude', model_id = 'claude-sonnet-4-5', variant = '', context_window = '' WHERE id = 'session-1'`;
					yield* seedClaimedRun("active-input", 1);
					yield* seedCapturedStop("plain-stop");
					deliver = (command) =>
						Effect.gen(function* () {
							yield* commit(command.events ?? []);
							yield* seedClaimedRun(command.input.inputId, 2);
							yield* command.onAccepted ?? Effect.void;
							yield* Deferred.succeed(delivered, undefined);
							return completedTurn();
						}).pipe(Effect.orDie, Effect.provide(context));
					yield* inbox.start;
					const stopped = yield* service.beginStop({
						clientId: "browser",
						sessionId: "session-1",
						commandId: "plain-stop",
					});
					yield* Deferred.await(issued);
					yield* inbox.submit({
						clientId: "browser",
						sessionId: "session-1",
						inputId: "queued-b",
						delivery: "queue",
						request: { text: "Bravo" },
					});
					expect(
						yield* inbox.sendNow({
							clientId: "browser",
							sessionId: "session-1",
							inputId: "queued-b",
							interrupt: true,
						}),
					).toBe("accepted");
					expect(dispatchEffect).toHaveBeenCalledTimes(1);
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
					yield* stopped;
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = 'run-active-input'`,
					).toEqual([{ status: "interrupted" }]);
					yield* Deferred.await(delivered);
					expect(
						vi
							.mocked(dispatchEffect)
							.mock.calls.map(([command]) => command.type),
					).toEqual(["interrupt_turn", "end_session", "send_turn"]);
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs`,
					).toEqual([{ input_id: "queued-b", state: "removed" }]);
					expect(
						yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ id: "run-active-input", status: "interrupted" },
						{ id: "run-queued-b", status: "running" },
					]);
					yield* inbox.sendNow({
						clientId: "browser",
						sessionId: "session-1",
						inputId: "queued-b",
						interrupt: true,
					});
					expect(dispatchEffect).toHaveBeenCalledTimes(3);
				}).pipe(
					Effect.provide(
						SessionInboxLive.pipe(Layer.provideMerge(dependencies)),
					),
				);
			},
		);

		it.effect(
			"lifts after the bound and retires only its claimed cohort once",
			() =>
				Effect.gen(function* () {
					const issued = yield* Deferred.make<void>();
					const engine = makeEngine({
						providerId: "claude",
						dispatchEffect: vi.fn((command: OrchestrationCommand) =>
							command.type === "end_session"
								? confirmProcessLoss(command)
								: Deferred.succeed(issued, undefined).pipe(
										Effect.andThen(Effect.never),
									),
						) as unknown as OrchestrationEngine["dispatchEffect"],
					});
					const { liveLayer } = serviceLayer({ engine });
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const service = yield* ProviderTurnServiceTag;
						const commit = yield* makeCommitAndSignal;
						yield* seedSession;
						yield* seedClaimedRun("active-input", 1);
						yield* seedCapturedStop();
						yield* commit([
							canonicalEvent("input.admitted", "session-1", {
								sessionId: "session-1",
								inputId: "queued-input",
								delivery: "queue",
								request: { text: "later" },
							}),
							canonicalEvent("input.interrupt_requested", "session-1", {
								sessionId: "session-1",
								inputId: "queued-input",
							}),
						]);
						const stopped = yield* Effect.forkChild(interruptTurn());
						yield* Deferred.await(issued);
						// A continuation can be admitted while the native interrupt is stalled.
						yield* seedClaimedRun("fresh-input", 2);
						yield* sql`UPDATE provider_command_outbox SET provider_process_id = 'replacement-process' WHERE command_id = 'fresh-input'`;
						yield* TestClock.adjust(STOP_ABORT_WAIT_MS - 1);
						expect(service.turnFences("session-1").stopping).toBe(true);
						yield* TestClock.adjust(1);
						yield* Fiber.join(stopped);
						expect(service.turnFences("session-1").stopping).toBe(false);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ id: "run-active-input", status: "interrupted" },
							{ id: "run-fresh-input", status: "running" },
						]);
						expect(
							yield* sql`SELECT command_id, status FROM provider_command_outbox WHERE effect_type = 'send_turn' ORDER BY command_id`,
						).toEqual([
							{ command_id: "active-input", status: "failed" },
							{ command_id: "fresh-input", status: "running" },
						]);
						expect(
							yield* sql`SELECT command_id, status FROM command_receipts ORDER BY command_id`,
						).toEqual([
							{ command_id: "active-input", status: "side_effect_failed" },
							{ command_id: "fresh-input", status: "side_effect_requested" },
						]);
						expect(
							yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
						).toMatchObject({ paused: false });
						const [before] =
							yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 'session-1'`;
						yield* commit([
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{
									provider: "claude",
									metadata: { runId: "run-active-input" },
								},
							),
						]);
						expect(
							yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 'session-1'`,
						).toEqual([before]);
						expect(
							yield* sql`SELECT state FROM turns WHERE id = 'active-input'`,
						).toEqual([{ state: "interrupted" }]);
						yield* commit([
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{
									provider: "claude",
									metadata: { runId: "run-fresh-input" },
								},
							),
						]);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ id: "run-active-input", status: "interrupted" },
							{ id: "run-fresh-input", status: "completed" },
						]);
					}).pipe(Effect.provide(liveLayer));
				}),
		);

		it.effect("holds the fence until the acknowledged run ends", () => {
			const engine = makeEngine({ providerId: "claude" });
			const { liveLayer } = serviceLayer({ engine });
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const service = yield* ProviderTurnServiceTag;
				const commit = yield* makeCommitAndSignal;
				yield* seedSession;
				yield* seedClaimedRun("active-input", 1);
				const stopped = yield* Effect.forkChild(interruptTurn());
				// A live background task acknowledges before the native terminal.
				yield* TestClock.adjust(1_000);
				expect(engine.dispatchEffect).toHaveBeenCalledOnce();
				expect(service.turnFences("session-1").stopping).toBe(true);
				yield* commit([
					canonicalEvent(
						"turn.interrupted",
						"session-1",
						{ messageId: "" },
						{
							metadata: { runId: "run-active-input" },
						},
					),
				]);
				yield* TestClock.adjust(100);
				yield* Fiber.join(stopped);
				expect(service.turnFences("session-1").stopping).toBe(false);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(1);
			}).pipe(Effect.provide(liveLayer));
		});

		it.effect(
			"stops admissions from before the fence, not a continuation behind it",
			() =>
				Effect.gen(function* () {
					const issued = yield* Deferred.make<void>();
					const engine = makeEngine({
						providerId: "claude",
						dispatchEffect: vi.fn((command: OrchestrationCommand) =>
							command.type === "end_session"
								? confirmProcessLoss(command)
								: Deferred.succeed(issued, undefined).pipe(
										Effect.andThen(Effect.never),
									),
						) as unknown as OrchestrationEngine["dispatchEffect"],
					});
					const { liveLayer } = serviceLayer({ engine });
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* seedSession;
						// Intake need not have occurred for a claimed input to belong to Stop.
						yield* seedClaimedRun("active-input", 1, false);
						yield* seedClaimedRun("queued-steer", 2, false, false);
						yield* seedCapturedStop();
						const stopped = yield* Effect.forkChild(interruptTurn());
						yield* Deferred.await(issued);
						yield* seedClaimedRun("continuation", 3, false);
						yield* sql`UPDATE provider_command_outbox SET provider_process_id = 'replacement-process' WHERE command_id = 'continuation'`;
						const [interrupt] = vi
							.mocked(engine.dispatchEffect)
							.mock.calls.map(([command]) => command);
						expect(interrupt).toMatchObject({ type: "interrupt_turn" });
						expect(
							interrupt?.type === "interrupt_turn"
								? [...(interrupt.turnIds ?? [])].sort()
								: [],
						).toEqual(["active-input", "queued-steer"]);
						yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
						yield* Fiber.join(stopped);
						expect(
							yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ id: "run-active-input", status: "interrupted" },
							{ id: "run-continuation", status: "pending" },
							{ id: "run-queued-steer", status: "interrupted" },
						]);
						expect(
							yield* sql`SELECT state, started_at FROM turns WHERE id = 'continuation'`,
						).toEqual([{ state: "pending", started_at: null }]);
					}).pipe(Effect.provide(liveLayer));
				}),
		);
	});

	for (const driver of ["opencode", "claude"] as const) {
		for (const sideThread of [0, 1]) {
			it.effect(
				`prepares a ${driver} plan turn from session side_thread=${sideThread}`,
				() => {
					const engine = makeEngine({ providerId: driver });
					const readQuery: ReadQueryEffect = {
						...makeReadQuery(vi.fn(() => Effect.succeed([]))),
						getSession: vi.fn(() =>
							Effect.succeed(
								partialFake<SessionRow>({
									id: "session-1",
									provider: driver,
									model_provider: driver,
									model_id: "test-model",
									variant: "",
									context_window: "",
									side_thread: sideThread,
									goal_state: null,
								}),
							),
						),
					};
					const { layer } = serviceLayer({ engine, readQuery });

					return Effect.gen(function* () {
						yield* setPermissionMode("session-1", "plan");
						yield* sendTurn({
							model: { providerID: driver, modelID: "test-model" },
							agent: "coder",
						});
						const command = vi.mocked(engine.dispatchEffect).mock
							.calls[0]?.[0] as SendTurnCommand;
						expect(command.input.permissionMode).toBe("plan");
						expect(command.input.agent).toBe("coder");
						expect(command.input.sideThread).toBe(
							sideThread === 1 ? true : undefined,
						);
						expect(command.input.goalState).toEqual(
							driver === "claude"
								? { sessionId: "session-1", goal: null }
								: undefined,
						);
						expect(readQuery.getSession).toHaveBeenCalledWith("session-1");
					}).pipe(Effect.provide(layer));
				},
			);
		}
	}

	it.effect(
		"sends the stored Claude model with explicit empty effort and context window",
		() => {
			const engine = makeEngine();
			const { layer } = serviceLayer({
				engine,
				readQuery: makeReadQuery(vi.fn(() => Effect.succeed([]))),
				persist: makePersistService(vi.fn(() => Effect.void)),
				ingestion: makeIngestion(),
			});

			return Effect.gen(function* () {
				yield* sendTurn();
				const command = vi.mocked(engine.dispatchEffect).mock
					.calls[0]?.[0] as SendTurnCommand;
				expect(command.input.model).toEqual({
					providerId: "claude",
					modelId: "claude-sonnet-4-5",
				});
				expect(command.input.variant).toBe("");
				expect(command.input.contextWindow).toBe("");
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"returns PICK_REQUIRED without dispatch or model changes when a stored pick is missing",
		() => {
			const engine = makeEngine({ providerId: "claude" });
			const readQuery = {
				...makeReadQuery(vi.fn(() => Effect.succeed([]))),
				getSession: vi.fn(() =>
					Effect.succeed(
						partialFake<SessionRow>({
							id: "session-1",
							provider: "claude",
							model_provider: null,
							model_id: null,
							variant: null,
							context_window: null,
						}),
					),
				),
			};
			const persist = makePersistService(vi.fn(() => Effect.void));
			const { layer, ingestion } = serviceLayer({ engine, readQuery, persist });

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* sendTurn();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
				expect(readQuery.getSessionMessagesWithParts).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).toHaveBeenCalledExactlyOnceWith(
					"session-1",
					"current prompt",
					{
						inputId: "cmd-send-default",
						messageId: "cmd-send-default",
						provider: "claude",
						failure: {
							message:
								"A session model pick is required before sending a message.",
							code: "PICK_REQUIRED",
						},
					},
				);
				expect(persist.persistEvents).not.toHaveBeenCalled();
				expect(persist.persistEvent).not.toHaveBeenCalled();
				expect(engine.bindSession).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).not.toHaveBeenCalled();
				expect(ingestion.ingestBatch).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"sends the stored Claude pick without discovery despite a different request pick",
		() => {
			const dispatchEffect = vi.fn((command) =>
				command.type === "discover"
					? Effect.die(new Error("unexpected discovery"))
					: Effect.succeed(completedTurn()),
			) as unknown as OrchestrationEngine["dispatchEffect"];
			const engine = makeEngine({ providerId: "claude", dispatchEffect });
			const { layer } = serviceLayer({ engine });

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'claude', 'Stored session', 'claude', 'sonnet', 'high', '1m', 1, 1)`;
				yield* sendTurn({
					model: { providerID: "claude", modelID: "opus" },
					variant: "low",
					contextWindow: "200k",
				});

				expect(
					vi
						.mocked(dispatchEffect)
						.mock.calls.some(([command]) => command.type === "discover"),
				).toBe(false);
				expect(dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						input: expect.objectContaining({
							model: { providerId: "claude", modelId: "sonnet" },
							variant: "high",
							contextWindow: "1m",
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches the first Claude turn without reading the transcript and leaves user-message placement to the adapter",
		() => {
			const engine = makeEngine();
			const events: string[] = [];
			const readQuery = withPlaceholderSession(
				makeReadQuery(vi.fn(() => Effect.succeed([]))),
			);
			const persist = makePersistService(
				vi.fn(() => Effect.sync(() => events.push("persist"))),
			);
			const ingestion = makeIngestion();
			const titleService: SessionTitleService = {
				titleFromMessage: vi.fn(() => Effect.sync(() => events.push("title"))),
			};
			const providerState = makeProviderState({
				nativeThread: vi.fn(() =>
					Effect.succeed({
						resumeSessionId: "prev",
						projectId: "test-project",
						firstSequence: 3,
						deliveredThrough: 8,
					}),
				),
			});
			const { layer } = serviceLayer({
				engine,
				readQuery,
				persist,
				ingestion,
				providerState,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn({
					commandId: "cmd-send-1",
				} as Partial<ProviderTurnServiceSendInput>);
				const command = vi.mocked(engine.dispatchEffect).mock
					.calls[0]?.[0] as SendTurnCommand;

				expect(readQuery.getSessionMessagesWithParts).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).not.toHaveBeenCalled();
				expect(events).toEqual(["title"]);
				expect(providerState.getState).toHaveBeenCalledWith("session-1");
				expect(providerState.nativeThread).not.toHaveBeenCalled();
				expect(command).toMatchObject({
					type: "send_turn",
					commandId: "cmd-send-1",
					providerId: "claude",
					input: {
						sessionId: "session-1",
						prompt: "current prompt",
						history: [],
						instanceId: "claude",
						workspaceRoot: MOCK_PROJECT_DIR,
						model: {
							providerId: "claude",
							modelId: "claude-sonnet-4-5",
						},
					},
				});

				const event = providerRuntimeEvent(
					"text.delta",
					"session-1",
					{ messageId: "assistant-1", partId: "assistant-1-0", text: "hello" },
					{ providerId: "claude", eventId: "evt-required-ingestion" },
				);
				const result = yield* Effect.result(
					command.input.eventSink.push(event),
				);
				expect(result._tag).toBe("Success");
				expect(ingestion.ingest).toHaveBeenCalledWith(event, undefined);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"applies Claude turn policy to a named Claude instance binding",
		() => {
			const configDir = writeDaemonConfig({
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
						configDir: "/instances/work-claude",
					},
				],
			});
			const engine = makeEngine({ providerId: "work-claude" });
			const readQuery: ReadQueryEffect = {
				...makeReadQuery(vi.fn(() => Effect.succeed([]))),
				getSession: vi.fn(() =>
					Effect.succeed(
						partialFake<SessionRow>({
							id: "session-1",
							provider: "work-claude",
							model_provider: "claude",
							model_id: "claude-sonnet-4-5",
							variant: "",
							context_window: "",
						}),
					),
				),
			};
			const persist = makePersistService(vi.fn(() => Effect.void));
			const { layer } = serviceLayer({
				engine,
				readQuery,
				persist,
				ingestion: makeIngestion(),
				configDir,
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(readQuery.getSessionMessagesWithParts).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "work-claude",
						input: expect.objectContaining({
							configDir: configuredClaudeConfigDir("/instances/work-claude"),
							history: [],
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"surfaces SEND_FAILED without dispatch when the bound instance has no default route",
		() => {
			const configDir = writeDaemonConfig({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: [],
			});
			const engine = makeEngine({ providerId: "deleted-instance" });
			const persist = makePersistService(vi.fn(() => Effect.void));
			const { layer, ingestion } = serviceLayer({
				engine,
				persist,
				configDir,
				accountDirectory: makeMockAccountDirectory([]),
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(engine.dispatchEffect).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).toHaveBeenCalledExactlyOnceWith(
					"session-1",
					"current prompt",
					{
						inputId: "cmd-send-default",
						messageId: "cmd-send-default",
						failure: {
							code: "SEND_FAILED",
							message: expect.stringContaining("deleted-instance"),
						},
					},
				);
				expect(ingestion.ingestBatch).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("does not start title generation for a continuation turn", () => {
		const engine = makeEngine({ providerId: "claude" });
		const titleService = makeTitleService();
		const { layer } = serviceLayer({
			engine,
			readQuery: withPlaceholderSession(
				makeReadQuery(vi.fn(() => Effect.succeed([]))),
			),
			titleService,
		});

		return Effect.gen(function* () {
			yield* sendTurn({
				continuation: { cutOffMessageId: "message-cut-off" },
			});

			expect(titleService.titleFromMessage).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({ type: "send_turn" }),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"dispatches a later Claude turn without starting title generation",
		() => {
			const configDir = writeDaemonConfig({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: [],
			});
			const engine = makeEngine({ providerId: "claude" });
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer } = serviceLayer({
				engine,
				persist,
				titleService,
				configDir,
			});

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
					VALUES ('session-1', 'claude', 'Existing session', 'claude', 'claude-sonnet-4-5', '', '', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at, updated_at)
					VALUES ('prior-message', 'session-1', 'assistant', 'Earlier reply', 10, 20, 30, 40, 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, tokens_cache_read, tokens_cache_write, rest_payload, created_at, updated_at)
					VALUES ('cache-only', 'session-1', 'assistant', 9, 1, NULL, 2, 2),
					('snapshot-cache', 'session-1', 'assistant', 5, 2, ${JSON.stringify({ id: "snapshot-cache", role: "assistant", parts: [], tokens: { cache: { read: 5, write: 2 } } })}, 3, 3)`;
				yield* sendTurn();

				expect(persist.persistUserMessage).not.toHaveBeenCalled();
				expect(titleService.titleFromMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							history: [],
							cumulativeTokens: 107,
						}),
					}),
				);
				const command = vi.mocked(engine.dispatchEffect).mock.calls[0]?.[0];
				if (command?.type !== "send_turn") {
					throw new Error("Expected a send_turn command");
				}
				expect(command.input.configDir).toEqual({
					_tag: expect.stringMatching(/^(Configured|SdkDefault)$/),
					path: expect.any(String),
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches with zero usage and no title when Claude history metadata load fails",
		() => {
			const engine = makeEngine({ providerId: "claude" });
			const readQuery = makeReadQuery(
				vi.fn(() => Effect.succeed([])),
				vi.fn(() =>
					Effect.fail(
						new ReadQueryEffectError({
							operation: "getSessionHistoryMetadata",
							cause: new Error("db unavailable"),
						}),
					),
				),
			);
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer, log } = serviceLayer({
				engine,
				readQuery,
				persist,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining(
						"Failed to load prior Claude history metadata",
					),
				);
				expect(readQuery.getSessionHistoryMetadata).toHaveBeenCalledWith(
					"session-1",
				);
				expect(titleService.titleFromMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						input: expect.objectContaining({ history: [] }),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("ignores provider state returned without an owned terminal", () => {
		const engine = makeEngine({
			providerId: "claude",
			result: completedTurn({
				providerStateUpdates: [
					{
						key: "nativeThread:claude",
						value: JSON.stringify({
							resumeSessionId: "next",
							firstSequence: 3,
							deliveredThrough: 8,
						}),
					},
				],
			}),
		});
		const providerState = makeProviderState();
		const { layer, log, ingestion } = serviceLayer({
			engine,
			providerState,
		});

		return Effect.gen(function* () {
			yield* sendTurn();

			expect(providerState.saveUpdates).not.toHaveBeenCalled();
			expect(log.warn).not.toHaveBeenCalledWith(
				expect.stringContaining("Non-fatal provider state persistence error"),
			);
			expect(ingestion.ingestBatch).not.toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ type: "turn.error" }),
				]),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"does not invent an OpenCode failure or native placement after a submitted RPC fails",
		() => {
			// A submitted RPC failure cannot prove that OpenCode rejected the input.
			// Keep attachments in its command until a native echo establishes placement.
			const images = [
				"data:text/plain;name=notes.txt;base64,Y2Fmw6k=",
				"data:application/pdf;name=guide.pdf;base64,JVBERi0xLjQ=",
			];
			const api = makeMockOpenCodeAPI();
			api.session.prompt = vi.fn(async () => {
				throw new Error("prompt unavailable");
			});
			const registry = new ProviderRegistry();
			registry.registerInstance(new OpenCodeProviderInstance({ client: api }));
			const inlineEngine = new OrchestrationEngine({ registry });
			inlineEngine.bindSession("session-1", "opencode");
			const dispatchEffect = vi.fn((command: SendTurnCommand) =>
				inlineEngine.dispatchEffect({
					...command,
					input: { ...command.input, awaitIntake: Effect.never },
				}),
			) as unknown as OrchestrationEngine["dispatchEffect"];
			const engine = makeEngine({ providerId: "opencode", dispatchEffect });
			const persist = makePersistService(vi.fn(() => Effect.void));
			const { layer, ingestion } = serviceLayer({ engine, api, persist });
			return Effect.gen(function* () {
				yield* sendTurn({
					commandId: "cmd-error",
					text: "",
					images,
					model: { providerID: "opencode", modelID: "test" },
				});
				expect(api.session.prompt).toHaveBeenCalledOnce();
				expect(api.session.abort).not.toHaveBeenCalled();
				expect(ingestion.ingestBatch).not.toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							type: "turn.error",
							sessionId: "session-1",
						}),
					]),
				);
				expect(persist.persistUserMessage).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"leaves a newer turn's timeout and browser state alone after an explicit interrupt result",
		() => {
			const engine = makeEngine({
				providerId: "opencode",
				result: completedTurn({ status: "interrupted" }),
			});
			const { layer, ingestion } = serviceLayer({ engine });

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* sendTurn();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
				expect(ingestion.ingestBatch).not.toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({ type: "turn.error" }),
					]),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"keeps the timeout active when only a dispatch result reports interruption",
		() => {
			const engine = makeEngine({
				providerId: "opencode",
				result: {
					status: "interrupted",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
					error: { code: "interrupted", message: "Turn interrupted" },
				},
			});
			const { layer, ingestion } = serviceLayer({ engine });

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* sendTurn();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
				expect(ingestion.ingestBatch).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches OpenCode turns with a no-op sink and without Claude policy",
		() => {
			let eventSink: EventSink | undefined;
			const engine = makeEngine({
				providerId: "opencode",
				dispatchEffect: vi.fn((command) =>
					Effect.sync(() => {
						eventSink = (command as SendTurnCommand).input.eventSink;
						return completedTurn();
					}),
				) as unknown as OrchestrationEngine["dispatchEffect"],
			});
			const readQuery: ReadQueryEffect = {
				...makeReadQuery(vi.fn(() => Effect.succeed([historyRow("bad")]))),
				getSession: vi.fn(() =>
					Effect.succeed(
						partialFake<SessionRow>({
							id: "session-1",
							title: "OpenCode session",
							provider: "opencode",
							model_provider: "openai",
							model_id: "gpt-4.1",
							variant: "",
							context_window: "",
						}),
					),
				),
			};
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer } = serviceLayer({
				engine,
				readQuery,
				persist,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn({
					model: { providerID: "openai", modelID: "gpt-4.1" },
				});

				expect(readQuery.getSessionMessagesWithParts).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).not.toHaveBeenCalled();
				expect(titleService.titleFromMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
						input: expect.objectContaining({ history: [] }),
					}),
				);
				const command = vi.mocked(engine.dispatchEffect).mock.calls[0]?.[0];
				if (command?.type !== "send_turn") {
					throw new Error("Expected a send_turn command");
				}
				expect(command.input).not.toHaveProperty("configDir");

				if (eventSink) {
					yield* eventSink.push(
						providerRuntimeEvent(
							"text.delta",
							"session-1",
							{
								messageId: "assistant-1",
								partId: "assistant-1-0",
								text: "should not emit",
							},
							{ providerId: "opencode" },
						),
					);
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"sends the stored OpenCode pick when the request omits the model",
		() => {
			const engine = makeEngine({ providerId: "opencode" });
			const { layer } = serviceLayer({ engine });

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'opencode', 'Stored session', 'openai', 'gpt-4.1', 'high', '128k', 1, 1)`;
				yield* sendTurn({ model: undefined });

				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
					}),
				);
				const command = vi.mocked(engine.dispatchEffect).mock.calls[0]?.[0];
				if (command?.type !== "send_turn") {
					throw new Error("Expected a send_turn command");
				}
				expect(command.input.model).toEqual({
					providerId: "openai",
					modelId: "gpt-4.1",
				});
				expect(command.input.variant).toBe("high");
				expect(command.input.contextWindow).toBe("128k");
				expect(
					vi
						.mocked(engine.dispatchEffect)
						.mock.calls.some(([call]) => call.type === "discover"),
				).toBe(false);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches Stop for an unbound session through the engine and clears processing timeout",
		() => {
			const api = partialFake<OpenCodeAPI>({
				session: partialFake<OpenCodeAPI["session"]>({
					abort: vi.fn(async () => undefined),
				}),
			});
			const engine = makeEngine();
			const { layer } = serviceLayer({ api, engine });

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Unbound session', 1, 1)`;
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* interruptTurn();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "interrupt_turn",
					commandId: "cmd-interrupt-default",
					sessionId: "session-1",
					turnIds: [],
					stop: {
						deadlineAt: STOP_ABORT_WAIT_MS,
						owners: [],
						turnIds: [],
						runnerBacked: false,
						retainedSteers: false,
					},
				});
				expect(api.session.abort).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	for (const { replay, joined } of [
		{ replay: false, joined: false },
		{ replay: true, joined: false },
		{ replay: true, joined: true },
	]) {
		it.effect(
			`Stop returns a scheduled retry without retaining an executable ordering head (replay: ${replay}, joined: ${joined})`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const meta = { metadata: { runId: "retry-run" } };
					yield* commit([
						canonicalEvent("session.created", "session-1", {
							sessionId: "session-1",
							title: "Retry return",
							provider: "opencode",
						}),
						canonicalEvent("input.admitted", "session-1", {
							sessionId: "session-1",
							inputId: "retry",
							delivery: "queue",
							request: { text: "retry" },
						}),
						canonicalEvent("input.sent", "session-1", {
							sessionId: "session-1",
							inputId: "retry",
						}),
						canonicalEvent(
							"run.requested",
							"session-1",
							{ runId: "retry-run", inputId: "retry" },
							meta,
						),
						canonicalEvent(
							"message.created",
							"session-1",
							{
								sessionId: "session-1",
								messageId: "retry",
								inputId: "retry",
								role: "user",
							},
							meta,
						),
						...(joined
							? []
							: [
									canonicalEvent(
										"run.started",
										"session-1",
										{ requestedRunId: "retry-run", inputId: "retry" },
										meta,
									),
								]),
					]);
					if (joined)
						yield* commit([
							canonicalEvent(
								"run.requested",
								"session-1",
								{ runId: "native-run", inputId: "native" },
								{ metadata: { runId: "native-run" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{ requestedRunId: "native-run", inputId: "native" },
								{ metadata: { runId: "native-run" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{ requestedRunId: "retry-run", inputId: "retry" },
								{ metadata: { runId: "native-run" } },
							),
						]);
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'retry', 'test-project', 'session-1', 'opencode', 'send_turn', 'retry-run', '{}', 'running', 1, 1, 1)`;
					yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
				VALUES ('retry', 'session-1', 'test-project', 'side_effect_requested', 1, 1)`;
					yield* commit([
						canonicalEvent(
							"turn.error",
							"session-1",
							{
								messageId: "",
								error: "unavailable",
								code: "provider_unavailable",
								retryable: true,
							},
							joined ? { metadata: { runId: "native-run" } } : meta,
						),
					]);
					yield* interruptTurn();
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs`,
					).toEqual([{ input_id: "retry", state: "queued" }]);
					expect(
						yield* sql`SELECT status FROM provider_runs ORDER BY id`,
					).toEqual(
						joined
							? [{ status: "error" }, { status: "joined" }]
							: [{ status: "error" }],
					);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_failed" },
					]);
					if (replay) {
						yield* sql`DELETE FROM provider_command_outbox`;
						yield* sql`DELETE FROM pending_inputs`;
						yield* sql`DELETE FROM turns`;
						yield* sql`DELETE FROM provider_runs`;
						yield* sql`UPDATE projector_cursors SET last_applied_seq = 0`;
						yield* (yield* ProjectionRunnerEffectTag).recover();
						expect(
							yield* sql`SELECT input_id, state FROM pending_inputs`,
						).toEqual([{ input_id: "retry", state: "queued" }]);
					}
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox`,
					).toEqual([]);
					yield* commit([
						canonicalEvent("input.cancelled", "session-1", {
							sessionId: "session-1",
							inputId: "retry",
						}),
					]);
					expect(yield* sql`SELECT state FROM pending_inputs`).toEqual([
						{ state: "removed" },
					]);
				}).pipe(
					Effect.provide(
						serviceLayer({
							engine: makeEngine({ providerId: "opencode" }),
							api: partialFake<OpenCodeAPI>({
								session: partialFake<OpenCodeAPI["session"]>({
									abort: vi.fn(async () => undefined),
								}),
							}),
						}).liveLayer,
					),
				),
		);
	}
	it.effect(
		"Stop returns multiple unclaimed sends in their original inbox order",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						title: "Return order",
						provider: "opencode",
					}),
				]);
				for (const [index, inputId] of [
					"already-queued",
					"earlier",
					"later",
					"queued",
				].entries())
					yield* commit([
						canonicalEvent(
							"input.admitted",
							"session-1",
							{
								sessionId: "session-1",
								inputId,
								delivery: "queue",
								request: { text: inputId },
							},
							{ createdAt: index + 1 },
						),
					]);
				for (const [index, inputId] of ["later", "earlier"].entries()) {
					const runId = `run-${inputId}`;
					yield* commit([
						canonicalEvent("input.sent", "session-1", {
							sessionId: "session-1",
							inputId,
							...(inputId === "later" ? { steer: true as const } : {}),
						}),
						canonicalEvent(
							"run.requested",
							"session-1",
							{ runId, inputId },
							{ metadata: { runId } },
						),
					]);
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (${index + 1}, ${inputId}, 'test-project', 'session-1', 'opencode', 'send_turn', ${runId}, '{}', 'pending', 0, 1, 1)`;
					yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
					VALUES (${inputId}, 'session-1', 'test-project', 'side_effect_requested', 1, 1)`;
				}
				yield* interruptTurn();
				expect(
					yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued' ORDER BY admitted_at, rowid`,
				).toEqual([
					{ input_id: "already-queued" },
					{ input_id: "earlier" },
					{ input_id: "later" },
					{ input_id: "queued" },
				]);
			}).pipe(
				Effect.provide(
					serviceLayer({
						engine: makeEngine({ providerId: "opencode" }),
						api: partialFake<OpenCodeAPI>({
							session: partialFake<OpenCodeAPI["session"]>({
								abort: vi.fn(async () => undefined),
							}),
						}),
					}).liveLayer,
				),
			),
	);
	for (const { providerId, indeterminate } of [
		{ providerId: "opencode", indeterminate: true },
		{ providerId: "claude", indeterminate: true },
		{ providerId: "claude", indeterminate: false },
	] as const) {
		it.effect(
			indeterminate
				? `explicit ${providerId} Stop returns unclaimed sends to the paused queue`
				: "ordinary Claude Stop retains the pending steer's native ownership",
			() => {
				const stopped = Deferred.makeUnsafe<void>();
				const issued = Deferred.makeUnsafe<void>();
				const awaitStop = Deferred.succeed(issued, undefined).pipe(
					Effect.andThen(Deferred.await(stopped)),
				);
				const abort = vi.fn(() => Effect.runPromise(awaitStop));
				const engine = makeEngine({ providerId });
				const dispatchEffect = vi.mocked(engine.dispatchEffect);
				dispatchEffect.mockImplementation(() => awaitStop);
				const api = partialFake<OpenCodeAPI>({
					session: partialFake<OpenCodeAPI["session"]>({ abort }),
				});
				const { liveLayer } = serviceLayer({
					api,
					engine,
				});
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "session-1", {
							sessionId: "session-1",
							provider: providerId,
							title: "Stop indeterminate",
						}),
					]);
					for (const [index, inputId] of [
						"accepted-a",
						"indeterminate-b",
						"unclaimed-c",
					].entries()) {
						const runId = `run-${inputId}`;
						yield* commit([
							...(index === 1
								? [
										canonicalEvent("input.sent", "session-1", {
											sessionId: "session-1",
											inputId,
											steer: true,
										}),
									]
								: []),
							...(index === 2
								? [
										canonicalEvent("input.admitted", "session-1", {
											sessionId: "session-1",
											inputId,
											delivery: "queue",
											request: { text: "never sent" },
										}),
										canonicalEvent("input.sent", "session-1", {
											sessionId: "session-1",
											inputId,
										}),
									]
								: []),
							canonicalEvent(
								"run.requested",
								"session-1",
								{ inputId, runId },
								{ metadata: { runId } },
							),
							canonicalEvent(
								"message.created",
								"session-1",
								{ sessionId: "session-1", messageId: inputId, role: "user" },
								{ metadata: { runId } },
							),
							...(index === 0
								? [
										canonicalEvent(
											"run.started",
											"session-1",
											{ inputId, requestedRunId: runId },
											{ metadata: { runId } },
										),
									]
								: []),
						]);
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
						provider_id, effect_type, run_id, payload_json, status, error_code, attempt_count, requested_at, updated_at)
						VALUES (${index + 1}, ${inputId}, 'test-project', 'session-1', ${providerId}, 'send_turn', ${runId}, '{}',
						${index === 2 ? "pending" : "running"}, ${index === 1 && indeterminate ? "delivery_indeterminate" : null}, ${index === 2 ? 0 : 1}, 1, 1)`;
						yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
						VALUES (${inputId}, 'session-1', 'test-project', 'side_effect_requested', 1, 1)`;
					}
					yield* commit([
						canonicalEvent("input.admitted", "session-1", {
							sessionId: "session-1",
							inputId: "queued-d",
							delivery: "queue",
							request: { text: "later" },
						}),
					]);
					const interrupt = yield* Effect.forkChild(interruptTurn());
					yield* Deferred.await(issued);
					expect(dispatchEffect).toHaveBeenCalledOnce();
					expect(abort).not.toHaveBeenCalled();
					expect(
						yield* sql`SELECT status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ status: "running" },
						{ status: "pending" },
						{ status: "interrupted" },
					]);
					yield* Deferred.succeed(stopped, undefined);
					if (indeterminate) {
						// Acknowledgement leaves delivered sends running until native terminal.
						yield* commit(
							["accepted-a", "indeterminate-b"].map((inputId) =>
								canonicalEvent(
									"turn.interrupted",
									"session-1",
									{ messageId: "" },
									{
										provider: providerId,
										metadata: { runId: `run-${inputId}` },
									},
								),
							),
						);
						yield* TestClock.adjust(100);
					} else {
						// An ordinary Stop preserves the pending steer's actual native answer.
						yield* commit([
							canonicalEvent(
								"turn.interrupted",
								"session-1",
								{ messageId: "" },
								{
									provider: "claude",
									metadata: { runId: "run-accepted-a" },
								},
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{
									inputId: "indeterminate-b",
									requestedRunId: "run-indeterminate-b",
								},
								{
									provider: "claude",
									metadata: { runId: "run-indeterminate-b" },
								},
							),
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{
									provider: "claude",
									metadata: { runId: "run-indeterminate-b" },
								},
							),
						]);
						yield* TestClock.adjust(100);
					}
					yield* Fiber.join(interrupt);
					if (providerId === "claude")
						expect(dispatchEffect).toHaveBeenCalledWith(
							expect.objectContaining({
								type: indeterminate ? "end_session" : "interrupt_turn",
							}),
						);
					if (!indeterminate) {
						expect(
							yield* sql`SELECT status FROM provider_runs ORDER BY id`,
						).toEqual([
							{ status: "interrupted" },
							{ status: "completed" },
							{ status: "interrupted" },
						]);
						expect(
							yield* sql`SELECT state, started_at FROM turns WHERE id = 'indeterminate-b'`,
						).toEqual([{ state: "completed", started_at: expect.any(Number) }]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'indeterminate-b'`,
						).toEqual([{ status: "side_effect_completed" }]);
						expect(
							yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
						).toMatchObject({ paused: true });
						return;
					}
					expect(
						yield* sql`SELECT status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ status: "interrupted" },
						{ status: "interrupted" },
						{ status: "interrupted" },
					]);
					expect(
						yield* sql`SELECT state, started_at FROM turns ORDER BY id`,
					).toEqual([
						{ state: "interrupted", started_at: expect.any(Number) },
						{ state: "interrupted", started_at: null },
						{ state: "interrupted", started_at: null },
					]);
					expect(
						yield* sql`SELECT status, error_code FROM provider_command_outbox ORDER BY command_id`,
					).toEqual([
						{ status: "failed", error_code: "interrupted" },
						{ status: "failed", error_code: "interrupted" },
						{ status: "failed", error_code: "interrupted" },
					]);
					expect(
						yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
					).toEqual([
						{ status: "side_effect_failed" },
						{ status: "side_effect_failed" },
						{ status: "side_effect_failed" },
					]);
					expect(
						yield* (yield* ReadQueryEffectTag).readInboxState("session-1"),
					).toMatchObject({ paused: true });
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs ORDER BY admitted_at, rowid`,
					).toEqual([
						{ input_id: "unclaimed-c", state: "queued" },
						{ input_id: "queued-d", state: "queued" },
					]);
				}).pipe(Effect.provide(liveLayer));
			},
		);
	}

	for (const { providerId, questionCount, recoveredCount, interrupts } of [
		{
			providerId: "claude",
			questionCount: 1,
			recoveredCount: 0,
			interrupts: true,
		},
		{
			providerId: "claude",
			questionCount: 0,
			recoveredCount: 0,
			interrupts: false,
		},
		{
			providerId: "claude",
			questionCount: 0,
			recoveredCount: 1,
			interrupts: false,
		},
		{
			providerId: "claude",
			questionCount: 1,
			recoveredCount: 1,
			interrupts: true,
		},
		{
			providerId: "opencode",
			questionCount: 1,
			recoveredCount: 0,
			interrupts: false,
		},
	]) {
		it.effect(
			`prepareTurnSession with ${questionCount} live and ${recoveredCount} recovered ${providerId} questions`,
			() => {
				const engine = makeEngine({ providerId });
				const ingestion = makeIngestion();
				const { layer: dependencies } = serviceLayer({ engine, ingestion });
				const layer = PassThroughSessionInbox.pipe(
					Layer.provideMerge(dependencies),
				);

				return Effect.gen(function* () {
					const interactions = yield* PendingInteractionServiceTag;
					for (let i = 0; i < questionCount; i++) {
						yield* interactions.recordQuestionRequest({
							requestId: `question-${i}`,
							sessionId: "session-1",
							questions: [],
						});
					}
					for (let i = 0; i < recoveredCount; i++) {
						yield* interactions.recoverPendingQuestions([
							{
								requestId: `recovered-${i}`,
								sessionId: "session-1",
								toolCallId: `recovered-${i}`,
								messageId: "message-1",
								questions: [{ question: "Continue?" }],
							},
						]);
					}
					const service = yield* ProviderTurnServiceTag;
					yield* service.prepareTurnSession({
						clientId: "client-1",
						commandId: "cmd-reply",
						sessionId: "session-1",
					});

					expect(
						vi
							.mocked(engine.dispatchEffect)
							.mock.calls.some(([call]) => call.type === "interrupt_turn"),
					).toBe(interrupts);
					expect(vi.mocked(ingestion.ingestBatch).mock.calls).toHaveLength(
						recoveredCount,
					);
					if (recoveredCount > 0) {
						const events =
							vi.mocked(ingestion.ingestBatch).mock.calls[0]?.[0] ?? [];
						expect(events).toMatchObject([
							{
								type: "tool.started",
								data: { partId: "recovered-0", toolName: "AskUserQuestion" },
							},
							{
								type: "tool.completed",
								sessionId: "session-1",
								data: { partId: "recovered-0", result: null },
							},
							{
								type: "question.resolved",
								data: { id: "recovered-0", answers: {} },
							},
						]);
						const [start, completion, resolution] = events;
						if (!start || !completion || !resolution)
							return yield* Effect.fail(
								new Error("Missing recovered tool events"),
							);
						const started = translateProviderRuntimeEventToDomain(
							start,
							emptyProviderRuntimeDomainMapperState,
						);
						const completed = translateProviderRuntimeEventToDomain(
							completion,
							started.state,
						);
						expect(completed.events.map((event) => event.type)).toEqual([
							"tool.completed",
						]);
						expect(
							translateProviderRuntimeEventToDomain(resolution, completed.state)
								.events,
						).toMatchObject([
							{ type: "question.resolved", data: { id: "recovered-0" } },
						]);
						expect(
							(yield* interactions.listPendingQuestions("session-1")).filter(
								(question) => question.recovered,
							),
						).toHaveLength(0);
					}
				}).pipe(Effect.provide(layer));
			},
		);
	}

	it.effect(
		"completes a disposed question using its projected tool identity",
		() => {
			const ingestion = makeIngestion();
			const getPendingClaudeQuestionTool = vi.fn(() =>
				Effect.succeed({
					id: "part-1",
					call_id: "toolu-1",
					message_id: "assistant-message-1",
					input: null,
					created_at: 1,
					session_id: "session-1",
				}),
			);
			const readQuery = {
				...makeReadQuery(() => Effect.succeed([])),
				getPendingClaudeQuestionTool,
			};
			const { layer } = serviceLayer({ ingestion, readQuery });
			return Effect.gen(function* () {
				const service = yield* ProviderTurnServiceTag;
				if (!service.completeRecoveredQuestion)
					return yield* Effect.fail(
						new Error("Missing recovered question handler"),
					);
				yield* service.completeRecoveredQuestion(
					{
						requestId: "toolu-1",
						sessionId: "session-1",
						toolCallId: "toolu-1",
						questions: [{ question: "Which colour?" }],
						recovered: true,
						timestamp: 1,
					},
					'Answer to your question "Which colour?": red',
				);
				expect(getPendingClaudeQuestionTool).toHaveBeenCalledWith(
					"session-1",
					"toolu-1",
				);
				expect(ingestion.ingestBatch).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							type: "tool.completed",
							providerId: "claude",
							data: {
								messageId: "assistant-message-1",
								partId: "part-1",
								result: 'Answer to your question "Which colour?": red',
								duration: 0,
							},
						}),
						expect.objectContaining({
							type: "question.resolved",
							data: { id: "toolu-1", answers: {} },
						}),
					]),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"interrupts a first Claude turn while engine dispatch is still in flight",
		() =>
			Effect.gen(function* () {
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				const interruptTurnEffect = vi.fn(() => Effect.void);
				const instance: ProviderInstance = {
					providerId: "claude",
					generateTextEffect: () => Effect.die("not used"),
					discoverEffect: vi.fn(() =>
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
					),
					sendTurnEffect: vi.fn(() =>
						Effect.gen(function* () {
							yield* Deferred.succeed(sendStarted, undefined);
							yield* Deferred.await(releaseSend);
							return completedTurn();
						}),
					),
					interruptTurnEffect,
					resolvePermissionEffect: vi.fn(() => Effect.void),
					resolveQuestionEffect: vi.fn(() => Effect.void),
					shutdownEffect: vi.fn(() => Effect.void),
					endSessionEffect: vi.fn(() => Effect.void),
				};
				const registry = new ProviderRegistry();
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({ registry });
				const api = partialFake<OpenCodeAPI>({
					session: partialFake<OpenCodeAPI["session"]>({
						abort: vi.fn(async () => undefined),
					}),
				});
				const { layer } = serviceLayer({ engine, api });

				yield* Effect.gen(function* () {
					yield* sendTurn();
					yield* Deferred.await(sendStarted);
					yield* interruptTurn();

					expect(interruptTurnEffect).toHaveBeenCalledWith("session-1", []);
					expect(api.session.abort).not.toHaveBeenCalled();

					yield* Deferred.succeed(releaseSend, undefined);
					yield* flushDispatch();
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"interrupts a first Claude turn immediately after send returns before dispatch starts",
		() =>
			Effect.gen(function* () {
				let boundProviderId: string | undefined;
				const dispatchEffect = vi.fn((command) => {
					if (command.type === "interrupt_turn") return Effect.void;
					return Effect.succeed(completedTurn());
				}) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = {
					resolveCallContextEffect: () => Effect.succeed(undefined),
					resolveSessionCallContextEffect: () => Effect.succeed(undefined),
					getProviderForSessionEffect: vi.fn(() =>
						Effect.succeed(boundProviderId),
					),
					bindSession: vi.fn((_sessionId: string, providerId: string) => {
						boundProviderId = providerId;
					}),
					unbindSession: vi.fn(() => {
						boundProviderId = undefined;
					}),
					dispatchEffect,
				} as unknown as OrchestrationEngine;
				const api = partialFake<OpenCodeAPI>({
					session: partialFake<OpenCodeAPI["session"]>({
						abort: vi.fn(async () => undefined),
					}),
				});
				const { layer } = serviceLayer({ engine, api });

				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions
						(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
						VALUES ('session-1', 'claude', 'Stored session', 'claude', 'claude-sonnet-4-5', '', '', 1, 1)`;
					const service = yield* ProviderTurnServiceTag;
					yield* service.sendTurn(defaultInput());
					yield* yield* service.beginStop({
						clientId: "client-1",
						commandId: "cmd-interrupt-1",
						sessionId: "session-1",
					});

					expect(dispatchEffect).toHaveBeenCalledWith({
						type: "interrupt_turn",
						commandId: "cmd-interrupt-1",
						sessionId: "session-1",
						turnIds: [],
						stop: {
							deadlineAt: STOP_ABORT_WAIT_MS,
							owners: [],
							turnIds: [],
							runnerBacked: true,
							retainedSteers: false,
						},
					});
					expect(api.session.abort).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"cancels pending send dispatch when the provider turn service scope closes",
		() =>
			Effect.gen(function* () {
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				let boundProviderId: string | undefined;
				const dispatchEffect = vi.fn((command) => {
					if (command.type !== "send_turn") return Effect.void;
					return Effect.gen(function* () {
						yield* command.onAccepted ?? Effect.void;
						yield* Deferred.succeed(sendStarted, undefined);
						yield* Deferred.await(releaseSend);
						return yield* Effect.fail(new Error("late send failure"));
					});
				}) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = {
					resolveCallContextEffect: () => Effect.succeed(undefined),
					resolveSessionCallContextEffect: () => Effect.succeed(undefined),
					getProviderForSessionEffect: vi.fn(() =>
						Effect.succeed(boundProviderId),
					),
					bindSession: vi.fn((_sessionId: string, providerId: string) => {
						boundProviderId = providerId;
					}),
					unbindSession: vi.fn(() => {
						boundProviderId = undefined;
					}),
					dispatchEffect,
				} as unknown as OrchestrationEngine;
				const { layer, ingestion } = serviceLayer({ engine });

				yield* Effect.gen(function* () {
					yield* sendTurn();
					yield* Deferred.await(sendStarted);
				}).pipe(Effect.provide(layer));

				yield* Deferred.succeed(releaseSend, undefined);
				yield* flushDispatch();
				expect(ingestion.ingestBatch).not.toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({ type: "turn.error" }),
					]),
				);
			}),
	);
});
