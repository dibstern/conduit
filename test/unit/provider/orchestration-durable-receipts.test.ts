import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { afterAll, expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	type Account,
	AccountIdSchema,
	OpenCodeAccountSchema,
} from "../../../src/lib/contracts/account.js";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
	makeAccountDirectory,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	effectiveDispatchFingerprint,
	fingerprintHash,
} from "../../../src/lib/provider/orchestration-command-fingerprint.js";
import {
	type DurableCommandStoreOptions,
	type EndSessionCommand,
	type InterruptTurnCommand,
	OrchestrationEngine,
	type ResolvePermissionCommand,
	type ResolveQuestionCommand,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { makeRecoveredEventSink } from "../../../src/lib/provider/runner/runner-event-sink.js";
import { createRunnerPermissionReplies } from "../../../src/lib/provider/runner/runner-receipts.js";
import type {
	PermissionResponse,
	ProviderInstance,
	TurnResult,
} from "../../../src/lib/provider/types.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";

const reviewEvidence: Record<string, unknown> = {};
afterAll(() => {
	mkdirSync("test-results/process-harness", { recursive: true });
	writeFileSync(
		"test-results/process-harness/82tn-9-fix-review-engine.json",
		JSON.stringify(reviewEvidence, null, 2),
	);
});

const COMPLETED: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 1, output: 1 },
	durationMs: 1,
	providerStateUpdates: [],
};

// Receipts can strand if fixtures return an adapter result without provider
// intake/end, skip projection, or omit the committed command's reservation.
function finishTurn(
	input: SendTurnCommand["input"],
	providerId: string,
	result = COMPLETED,
	createdAt = 1000,
) {
	return Effect.gen(function* () {
		const base = {
			providerId,
			sessionId: input.sessionId,
			runId: input.runId,
			providerRefs: {},
			rawSource: { kind: "test.provider-runtime" },
			createdAt,
		};
		yield* input.eventSink.push({
			...base,
			eventId: `${input.runId}:started`,
			type: "run.started",
			data: { inputId: input.inputId, requestedRunId: input.runId },
		});
		yield* input.eventSink.push({
			...base,
			eventId: `${input.runId}:ended`,
			type:
				result.status === "error"
					? "turn.error"
					: providerId === "opencode"
						? "session.status"
						: "turn.completed",
			data:
				result.status === "error"
					? {
							messageId: "",
							error: result.error?.message ?? "Failed",
							code: result.error?.code,
							retryable: result.error?.retryable,
							retryHandled: result.error?.retryHandled,
						}
					: providerId === "opencode"
						? { sessionId: input.sessionId, status: "idle" }
						: { messageId: "", duration: result.durationMs },
		});
		return result;
	}).pipe(Effect.orDie);
}

function makeStubInstance(
	providerId: string,
	createdAt = 1000,
): ProviderInstance & {
	sendTurnEffect: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
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
		sendTurnEffect: vi.fn((input: SendTurnCommand["input"]) =>
			finishTurn(input, providerId, COMPLETED, createdAt),
		),
		interruptTurnEffect: vi.fn(() => Effect.void),
		resolvePermissionEffect: vi.fn(() => Effect.void),
		resolveQuestionEffect: vi.fn(() => Effect.void),
		shutdownEffect: vi.fn(() => Effect.void),
		endSessionEffect: vi.fn(() => Effect.void),
	};
}

function sendTurnCommand(
	overrides: {
		commandId?: string;
		prompt?: string;
		providerId?: string;
		configDir?: SendTurnCommand["input"]["configDir"];
		abortSignal?: AbortSignal;
	} = {},
): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: overrides.commandId ?? "cmd-durable-1",
		providerId: overrides.providerId ?? "opencode",
		input: {
			sessionId: "session-1",
			inputId: "turn-1",
			prompt: overrides.prompt ?? "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			extraFolders: [],
			configDir: configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
			folderSource: "account",
			...(overrides.configDir === undefined
				? {}
				: { configDir: overrides.configDir }),
			eventSink: createMockEventSink(),
			abortSignal: overrides.abortSignal ?? new AbortController().signal,
		},
	};
}

function makeFixtureLayer() {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Layer.merge(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
	);
}

function makeDurableOptions(fixture: {
	readonly sql: SqlClient.SqlClient;
	readonly now?: () => number;
	readonly generateId?: () => string;
}) {
	return Effect.gen(function* () {
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const commit = yield* makeCommitAndSignal;
		yield* fixture.sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session-1', 'test-project', 'opencode', 1000, 1000)`;
		const snapshot = yield* new CommandReadModelRepository(
			fixture.sql,
			"test-project",
		).bootstrap();
		return {
			sql: fixture.sql,
			snapshot,
			projectKey: "test-project",
			now: fixture.now ?? (() => 1000),
			generateId: fixture.generateId ?? (() => "disp-1"),
			ingestion,
			write: commit.write,
		} satisfies DurableCommandStoreOptions;
	});
}

function makeEngine(
	instance: ProviderInstance,
	fixture: Parameters<typeof makeDurableOptions>[0],
) {
	return Effect.map(
		makeDurableOptions(fixture),
		(durableCommands) =>
			new OrchestrationEngine({
				registry: new ProviderRegistry([instance]),
				durableCommands,
			}),
	);
}

function seedReceipt(
	sql: SqlClient.SqlClient,
	command: SendTurnCommand,
	options: {
		status?: "side_effect_requested" | "side_effect_completed";
		version?: number;
	} = {},
) {
	const hash = fingerprintHash(effectiveDispatchFingerprint(command));
	return sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type,
		project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
		VALUES (${command.commandId}, 'session-1', ${options.status ?? "side_effect_requested"}, 1000, 'send_turn',
		'test-project', ${hash}, ${options.version ?? 2}, 1, 1000)`;
}

function receiptRow(sql: SqlClient.SqlClient, commandId: string) {
	return sql<{
		readonly status: string;
		readonly fingerprint_hash: string | null;
		readonly updated_at: number | null;
	}>`SELECT status, fingerprint_hash, updated_at FROM command_receipts WHERE command_id = ${commandId}`.pipe(
		Effect.map((rows) => rows[0]),
	);
}

const CONTROL_KINDS = [
	"interrupt_turn",
	"resolve_permission",
	"resolve_question",
	"end_session",
] as const;
type ControlKind = (typeof CONTROL_KINDS)[number];
type TargetedControl = (
	| InterruptTurnCommand
	| ResolvePermissionCommand
	| ResolveQuestionCommand
	| EndSessionCommand
) & {
	readonly providerProcessId: string;
	readonly nativeRequestId?: string;
	readonly response?: PermissionResponse;
	readonly operation?: "reply" | "reject";
};

function controlCommand(
	kind: ControlKind,
	commandId = `control-${kind}`,
): TargetedControl {
	const target = {
		commandId,
		sessionId: "session-1",
		providerProcessId: "process-1",
	};
	switch (kind) {
		case "interrupt_turn":
			return { ...target, type: kind, turnIds: ["turn-1"] };
		case "resolve_permission":
			return {
				...target,
				type: kind,
				requestId: "permission-1",
				nativeRequestId: "native-permission-1",
				decision: "always",
				response: {
					decision: "always",
					permissionUpdates: [
						{
							type: "addRules",
							rules: [{ toolName: "Bash", ruleContent: "pwd" }],
							behavior: "allow",
							destination: "session",
						},
					],
				},
			};
		case "resolve_question":
			return {
				...target,
				type: kind,
				requestId: "question-1",
				nativeRequestId: "native-question-1",
				answers: {},
				operation: "reject",
			};
		case "end_session":
			return { ...target, type: kind, targetProviderId: "opencode" };
	}
}

function controlIntentType(kind: ControlKind) {
	switch (kind) {
		case "interrupt_turn":
			return "interrupt.requested";
		case "resolve_permission":
			return "permission.resolved";
		case "resolve_question":
			return "question.resolved";
		case "end_session":
			return "session.end_requested";
	}
}

function seedControlPrompts() {
	return Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"permission.asked",
				"session-1",
				{
					id: "permission-1",
					sessionId: "session-1",
					toolName: "Bash",
					input: { command: "pwd" },
					providerProcessId: "process-1",
					providerRequestId: "native-permission-1",
				},
				{ createdAt: 900 },
			),
			canonicalEvent(
				"question.asked",
				"session-1",
				{
					id: "question-1",
					sessionId: "session-1",
					questions: [{ question: "Continue?", header: "Next", options: [] }],
					providerProcessId: "process-1",
					providerRequestId: "native-question-1",
				},
				{ createdAt: 900 },
			),
		]);
	});
}

function controlProvider(instance: ProviderInstance, kind: ControlKind) {
	switch (kind) {
		case "interrupt_turn":
			return vi.mocked(instance.interruptTurnEffect);
		case "resolve_permission":
			return vi.mocked(instance.resolvePermissionEffect);
		case "resolve_question":
			return vi.mocked(instance.resolveQuestionEffect);
		case "end_session":
			return vi.mocked(instance.endSessionEffect);
	}
}

describe("OrchestrationEngine durable controls", () => {
	for (const kind of ["permission", "question"] as const) {
		it.effect(
			`${kind} recovery registers legacy and outbox-owned answers without delivering either`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* makeEngine(makeStubInstance("opencode"), { sql });
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const pending = yield* PendingInteractionServiceTag;
					const commit = yield* makeCommitAndSignal;
					yield* createRunnerPermissionReplies(sql);
					for (const owned of [false, true]) {
						const id = `${kind}-${owned ? "owned" : "legacy"}`;
						const metadata = owned
							? { source: "conduit.control-outbox", commandId: `answer-${id}` }
							: {};
						yield* commit(
							kind === "permission"
								? [
										canonicalEvent("permission.asked", "session-1", {
											id,
											sessionId: "session-1",
											toolName: "Bash",
											input: {},
										}),
										canonicalEvent(
											"permission.resolved",
											"session-1",
											{ id, decision: "once" },
											{ metadata },
										),
									]
								: [
										canonicalEvent("question.asked", "session-1", {
											id,
											sessionId: "session-1",
											questions: [{ question: "Continue?" }],
										}),
										canonicalEvent(
											"question.resolved",
											"session-1",
											{ id, answers: { Next: "yes" } },
											{ metadata },
										),
									],
						);
						const registered = yield* Deferred.make<void>();
						const sink = makeRecoveredEventSink({
							sessionId: "session-1",
							driverKind: "opencode",
							sql,
							ingestion,
							pending,
							onRegistered: () => Deferred.succeed(registered, undefined),
							timeoutHooks: { clearTimeout: () => {}, resetTimeout: () => {} },
						});
						const request =
							kind === "permission"
								? sink.requestPermission({
										requestId: id,
										sessionId: "session-1",
										turnId: "recovered-turn",
										providerItemId: "recovered-tool",
										toolName: "Bash",
										toolInput: {},
									})
								: sink.requestQuestion({
										requestId: id,
										questions: [
											{ question: "Continue?", header: "Next", options: [] },
										],
									});
						const response = yield* Effect.forkChild(request);
						yield* Deferred.await(registered);
						yield* TestClock.adjust("1 millis");
						expect(response.pollUnsafe()).toBeUndefined();
						yield* Fiber.interrupt(response);
					}
				}).pipe(
					Effect.provide(
						Layer.merge(
							makeFixtureLayer(),
							makePendingInteractionServiceLive(),
						),
					),
				),
		);
	}

	for (const kind of CONTROL_KINDS) {
		it.effect(
			`${kind} reuses the accepted process target when replayed without an explicit target`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const command = controlCommand(kind);
					yield* engine.dispatchEffect(command);
					const { providerProcessId: _providerProcessId, ...unqualified } =
						command;
					const result = yield* Effect.result(
						engine.dispatchEffect(unqualified),
					);
					expect(result._tag).toBe("Success");
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT json_extract(payload_json, '$.providerProcessId') AS provider_process_id FROM provider_command_outbox WHERE command_id = ${command.commandId}`,
					).toEqual([{ provider_process_id: "process-1" }]);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} shares an in-flight duplicate delivery and rejects a changed payload while awaiting acknowledgement`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const firstEngine = yield* makeEngine(instance, { sql });
					const secondEngine = yield* makeEngine(instance, { sql });
					firstEngine.bindSession("session-1", "opencode");
					secondEngine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					controlProvider(instance, kind).mockImplementation(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					);
					const command = controlCommand(kind);
					const first = yield* Effect.forkChild(
						firstEngine.dispatchEffect(command),
					);
					yield* Deferred.await(entered);
					const receipt =
						yield* sql`SELECT * FROM command_receipts WHERE command_id = ${command.commandId}`;
					const duplicate = yield* Effect.forkChild(
						secondEngine.dispatchEffect(command),
					);
					yield* TestClock.adjust("1 millis");
					const changed = yield* Effect.result(
						secondEngine.dispatchEffect({
							...command,
							providerProcessId: "replacement-process",
						}),
					);
					expect(changed._tag).toBe("Failure");
					if (changed._tag === "Failure")
						expect(changed.failure).toMatchObject({
							_tag: "CommandFingerprintMismatch",
							commandId: command.commandId,
						});
					expect(first.pollUnsafe()).toBeUndefined();
					expect(duplicate.pollUnsafe()).toBeUndefined();
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT * FROM command_receipts WHERE command_id = ${command.commandId}`,
					).toEqual(receipt);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(first);
					yield* TestClock.adjust("1 second");
					yield* Fiber.join(duplicate);
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = ${command.commandId}`,
					).toHaveLength(1);
					expect(
						yield* sql`SELECT sequence FROM events WHERE json_extract(metadata, '$.commandId') = ${command.commandId}`,
					).toHaveLength(1);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} commits its intent, immutable receipt and process-targeted outbox before delivery without creating a run`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const started = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					controlProvider(instance, kind).mockImplementation(() =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					);
					const command = controlCommand(kind);
					const pending = yield* Effect.forkChild(
						engine.dispatchEffect(command),
					);
					yield* Deferred.await(started);
					const context = {
						commandId: command.commandId,
						providerProcessId: "process-1",
					};
					switch (command.type) {
						case "interrupt_turn":
							expect(
								instance.interruptTurnEffect,
							).toHaveBeenCalledExactlyOnceWith(
								"session-1",
								["turn-1"],
								undefined,
								context,
							);
							break;
						case "resolve_permission":
							expect(
								instance.resolvePermissionEffect,
							).toHaveBeenCalledExactlyOnceWith(
								"session-1",
								"native-permission-1",
								"always",
								"process-1",
								undefined,
								{ ...context, response: command.response },
							);
							break;
						case "resolve_question":
							expect(
								instance.resolveQuestionEffect,
							).toHaveBeenCalledExactlyOnceWith(
								"session-1",
								"native-question-1",
								{},
								undefined,
								{ ...context, operation: "reject" },
							);
							break;
						case "end_session":
							expect(instance.endSessionEffect).toHaveBeenCalledExactlyOnceWith(
								"session-1",
								undefined,
								context,
							);
							break;
					}
					const rows = yield* sql<{
						type: string;
						status: string;
						effect_type: string;
						provider_process_id: string;
						run_id: string | null;
						payload_json: string;
					}>`
					SELECT events.type, receipt.status, outbox.effect_type, outbox.provider_process_id, outbox.run_id, outbox.payload_json
					FROM command_receipts AS receipt JOIN provider_command_outbox AS outbox USING (command_id)
					JOIN events ON json_extract(events.metadata, '$.commandId') = receipt.command_id
					WHERE receipt.command_id = ${command.commandId}`;
					expect(rows).toHaveLength(1);
					expect(rows[0]).toMatchObject({
						type: controlIntentType(kind),
						status: "side_effect_requested",
						effect_type: kind,
						provider_process_id: "process-1",
						run_id: null,
					});
					const payload = JSON.parse(rows[0]?.payload_json ?? "null") as Record<
						string,
						unknown
					>;
					expect(payload).toMatchObject({ providerProcessId: "process-1" });
					if (kind === "interrupt_turn")
						expect(payload).toMatchObject({ turnIds: ["turn-1"] });
					if (kind === "resolve_permission")
						expect(payload).toMatchObject({
							requestId: "permission-1",
							nativeRequestId: "native-permission-1",
							response: command.response,
						});
					if (kind === "resolve_question")
						expect(payload).toMatchObject({
							requestId: "question-1",
							nativeRequestId: "native-question-1",
							operation: "reject",
							answers: {},
						});
					expect(yield* sql`SELECT id FROM provider_runs`).toEqual([]);
					expect(pending.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(pending);
					expect((yield* receiptRow(sql, command.commandId))?.status).toBe(
						"side_effect_completed",
					);
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} rolls back the event, receipt and outbox together when projection fails`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const before =
						yield* sql`SELECT sequence, type FROM events ORDER BY sequence`;
					yield* sql`CREATE TRIGGER fail_control_projection BEFORE UPDATE ON read_model_counter BEGIN SELECT RAISE(ABORT, 'injected control projection failure'); END`;
					const result = yield* Effect.result(
						engine.dispatchEffect(controlCommand(kind)),
					);
					expect(result._tag).toBe("Failure");
					expect(
						yield* sql`SELECT sequence, type FROM events ORDER BY sequence`,
					).toEqual(before);
					expect(yield* sql`SELECT command_id FROM command_receipts`).toEqual(
						[],
					);
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox`,
					).toEqual([]);
					expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
						{ status: "pending" },
						{ status: "pending" },
					]);
					expect(controlProvider(instance, kind)).not.toHaveBeenCalled();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} replays its first acknowledged outcome after engine reconstruction without another delivery`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const command = controlCommand(kind);
					yield* engine.dispatchEffect(command);
					const receipts = yield* sql`SELECT * FROM command_receipts`;
					const events =
						yield* sql`SELECT sequence, type FROM events ORDER BY sequence`;
					const restarted = yield* makeEngine(instance, { sql });
					restarted.bindSession("session-1", "opencode");
					yield* restarted.dispatchEffect(command);
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					expect(yield* sql`SELECT * FROM command_receipts`).toEqual(receipts);
					expect(
						yield* sql`SELECT sequence, type FROM events ORDER BY sequence`,
					).toEqual(events);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} rejects changed payload under an accepted command id`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const command = controlCommand(kind);
					yield* engine.dispatchEffect(command);
					const changed = {
						...command,
						providerProcessId: "replacement-process",
					};
					const result = yield* Effect.result(engine.dispatchEffect(changed));
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure")
						expect(result.failure).toMatchObject({
							_tag: "CommandFingerprintMismatch",
							commandId: command.commandId,
						});
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		it.effect(
			`${kind} replays a nonretryable typed provider failure after its accepting waiter detaches`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					controlProvider(instance, kind).mockImplementation(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: "control",
										code: "auth_required",
										cause: Object.assign(new Error("Control delivery denied"), {
											retryable: false,
										}),
									}),
								),
							),
						),
					);
					const command = controlCommand(kind);
					const accepting = yield* Effect.forkChild(
						engine.dispatchEffect(command),
					);
					yield* Deferred.await(entered);
					const duplicate = yield* Effect.forkChild(
						Effect.result(engine.dispatchEffect(command)),
					);
					yield* TestClock.adjust("1 millis");
					yield* Fiber.interrupt(accepting);
					yield* Deferred.succeed(release, undefined);
					yield* TestClock.adjust("1 second");
					const first = yield* Fiber.join(duplicate);
					const restarted = yield* makeEngine(instance, { sql });
					restarted.bindSession("session-1", "opencode");
					const replay = yield* Effect.result(
						restarted.dispatchEffect(command),
					);
					expect(first._tag).toBe("Failure");
					expect(replay._tag).toBe("Failure");
					if (first._tag === "Failure" && replay._tag === "Failure") {
						expect(replay.failure).toMatchObject({
							_tag: "ProviderInstanceFailure",
							code: "auth_required",
							providerId: "opencode",
							operation: "control",
						});
						expect(replay.failure.message).toBe(first.failure.message);
					}
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);

		for (const waiter of ["accepting", "duplicate"] as const) {
			it.effect(
				`${kind} delivers once when its ${waiter} waiter is interrupted in flight`,
				() =>
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const instance = makeStubInstance("opencode");
						const engine = yield* makeEngine(instance, { sql });
						engine.bindSession("session-1", "opencode");
						yield* seedControlPrompts();
						const started = yield* Deferred.make<void>();
						const release = yield* Deferred.make<void>();
						let deliveryInterrupted = false;
						controlProvider(instance, kind).mockImplementation(() =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.onInterrupt(() =>
									Effect.sync(() => {
										deliveryInterrupted = true;
									}),
								),
							),
						);
						const command = controlCommand(kind);
						const original = yield* Effect.forkChild(
							Effect.result(engine.dispatchEffect(command)),
						);
						yield* Deferred.await(started);
						const duplicate =
							waiter === "duplicate"
								? yield* Effect.forkChild(
										Effect.result(engine.dispatchEffect(command)),
									)
								: undefined;
						yield* TestClock.adjust("1 millis");
						yield* Fiber.interrupt(duplicate ?? original);
						const interruptedBeforeRelease = deliveryInterrupted;
						yield* Deferred.succeed(release, undefined);
						yield* TestClock.adjust("1 second");
						if (duplicate) {
							const remaining = yield* Fiber.join(original);
							expect(remaining._tag).toBe("Success");
						}
						expect((yield* receiptRow(sql, command.commandId))?.status).toBe(
							"side_effect_completed",
						);
						expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
						const restarted = yield* makeEngine(instance, { sql });
						restarted.bindSession("session-1", "opencode");
						const replay = yield* Effect.result(
							restarted.dispatchEffect(command),
						);
						expect(interruptedBeforeRelease).toBe(false);
						expect(replay._tag).toBe("Success");
						expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					}).pipe(Effect.provide(makeFixtureLayer())),
			);
		}
	}

	it.effect(
		"an interrupted end waiter keeps its binding until delivery is acknowledged",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });
				engine.bindSession("session-1", "opencode");
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				vi.mocked(instance.endSessionEffect).mockImplementation(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				);
				const command = { ...controlCommand("end_session"), unbind: true };
				const waiter = yield* Effect.forkChild(engine.dispatchEffect(command));
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(waiter);
				const bindingBeforeAcknowledgement =
					yield* engine.getProviderForSessionEffect("session-1");
				yield* Deferred.succeed(release, undefined);
				const replay = yield* Effect.forkChild(
					Effect.result(engine.dispatchEffect(command)),
				);
				yield* TestClock.adjust("1 second");
				const result = yield* Fiber.join(replay);
				expect(bindingBeforeAcknowledgement).toBe("opencode");
				expect(result._tag).toBe("Success");
				expect(
					yield* engine.getProviderForSessionEffect("session-1"),
				).toBeUndefined();
				expect(instance.endSessionEffect).toHaveBeenCalledOnce();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"engine shutdown releases a detached delivery before shutting its provider down",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });
				engine.bindSession("session-1", "opencode");
				const entered = yield* Deferred.make<void>();
				const calls: string[] = [];
				vi.mocked(instance.interruptTurnEffect).mockImplementation(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								calls.push("delivery released");
							}),
						),
					),
				);
				vi.mocked(instance.shutdownEffect).mockImplementation(() =>
					Effect.sync(() => {
						calls.push("provider shutdown");
					}),
				);
				const command = controlCommand("interrupt_turn");
				const waiter = yield* Effect.forkChild(engine.dispatchEffect(command));
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(waiter);
				const callsBeforeShutdown = [...calls];
				yield* engine.shutdownEffect();
				expect(callsBeforeShutdown).toEqual([]);
				expect(calls).toEqual(["delivery released", "provider shutdown"]);
				expect((yield* receiptRow(sql, command.commandId))?.status).toBe(
					"side_effect_requested",
				);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	for (const sparse of [false, true]) {
		it.effect(
			`allocates a control after an ${sparse ? "imported sparse outbox sequence" : "outbox sequence equal to its next intent event"} without conflating event identity`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const engine = yield* makeEngine(instance, { sql });
					engine.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const [clock] = yield* sql<{
						next_event: number;
					}>`SELECT COALESCE(MAX(sequence), 0) + 1 AS next_event FROM events`;
					const nextEvent = clock?.next_event ?? 1;
					const previousRequest = sparse ? 1000 : nextEvent;
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (${previousRequest}, 'imported-completed-send', 'test-project', 'session-1', 'opencode', 'send_turn', '{}', 'completed', 1, 800, 900)`;
					const command = controlCommand(
						"interrupt_turn",
						"control-after-import",
					);
					yield* engine.dispatchEffect(command);
					expect(
						yield* sql`SELECT outbox.request_sequence, receipt.accepted_sequence, receipt.side_effect_sequence, events.sequence AS intent_sequence, events.type
					FROM provider_command_outbox AS outbox JOIN command_receipts AS receipt USING (command_id)
					JOIN events ON json_extract(events.metadata, '$.commandId') = receipt.command_id
					WHERE outbox.command_id = 'control-after-import'`,
					).toEqual([
						{
							request_sequence: previousRequest + 1,
							accepted_sequence: previousRequest + 1,
							side_effect_sequence: previousRequest + 1,
							intent_sequence: nextEvent,
							type: "interrupt.requested",
						},
					]);
					expect(instance.interruptTurnEffect).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	}

	it.effect(
		"replaying an acknowledged end does not unbind a newer binding for the same provider",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });
				engine.bindSession("session-1", "opencode");
				const command = {
					...controlCommand("end_session", "retire-old-binding"),
					unbind: true,
				};
				yield* engine.dispatchEffect(command);
				engine.bindSession("session-1", "opencode");
				yield* engine.dispatchEffect(command);
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"opencode",
				);
				expect(instance.endSessionEffect).toHaveBeenCalledOnce();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	for (const kind of ["resolve_permission", "resolve_question"] as const) {
		for (const waiter of ["accepting", "duplicate"] as const) {
			it.effect(
				`${kind} delivers a queued answer once after its ${waiter} waiter is interrupted`,
				() =>
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const instance = makeStubInstance("opencode");
						const engine = yield* makeEngine(instance, { sql });
						engine.bindSession("session-1", "opencode");
						yield* seedControlPrompts();
						const entered = yield* Deferred.make<void>();
						const release = yield* Deferred.make<void>();
						vi.mocked(instance.interruptTurnEffect).mockImplementation(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						);
						const blocker = yield* Effect.forkChild(
							engine.dispatchEffect(
								controlCommand("interrupt_turn", "blocking-control"),
							),
						);
						yield* Deferred.await(entered);
						const command = controlCommand(kind, "queued-control");
						const original = yield* Effect.forkChild(
							Effect.result(engine.dispatchEffect(command)),
						);
						yield* TestClock.adjust("1 millis");
						expect((yield* receiptRow(sql, command.commandId))?.status).toBe(
							"side_effect_requested",
						);
						expect(
							yield* sql`SELECT status FROM pending_approvals WHERE id = ${kind === "resolve_permission" ? "permission-1" : "question-1"}`,
						).toEqual([{ status: "resolved" }]);
						expect(controlProvider(instance, kind)).not.toHaveBeenCalled();
						const duplicate =
							waiter === "duplicate"
								? yield* Effect.forkChild(
										Effect.result(engine.dispatchEffect(command)),
									)
								: undefined;
						yield* TestClock.adjust("1 millis");
						yield* Fiber.interrupt(duplicate ?? original);
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(blocker);
						yield* engine.drainSideEffects();
						yield* TestClock.adjust("1 second");
						if (duplicate) {
							const remaining = yield* Fiber.join(original);
							expect(remaining._tag).toBe("Success");
						}
						expect((yield* receiptRow(sql, command.commandId))?.status).toBe(
							"side_effect_completed",
						);
						expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
						const restarted = yield* makeEngine(instance, { sql });
						restarted.bindSession("session-1", "opencode");
						const replay = yield* Effect.result(
							restarted.dispatchEffect(command),
						);
						expect(replay._tag).toBe("Success");
						expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					}).pipe(Effect.provide(makeFixtureLayer())),
			);
		}
	}

	it.effect(
		"delivers once when its accepting waiter is interrupted at the committed claim boundary",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				const options = yield* makeDurableOptions({ sql });
				const claimed = yield* Deferred.make<void>();
				const releaseClaim = yield* Deferred.make<void>();
				let held = false;
				const write: DurableCommandStoreOptions["write"] = (
					body,
					commitOptions,
				) =>
					options.write(body, {
						...commitOptions,
						afterCommit: (commitOptions?.afterCommit ?? Effect.void).pipe(
							Effect.andThen(
								Effect.gen(function* () {
									const [row] = yield* sql<{
										status: string;
									}>`SELECT status FROM provider_command_outbox WHERE command_id = 'detach-at-claim-boundary'`;
									if (held || row?.status !== "running") return;
									held = true;
									yield* Deferred.succeed(claimed, undefined);
									yield* Deferred.await(releaseClaim);
								}),
							),
							Effect.orDie,
						),
					});
				const engine = new OrchestrationEngine({
					registry: new ProviderRegistry([instance]),
					durableCommands: { ...options, write },
				});
				engine.bindSession("session-1", "opencode");
				const command = controlCommand(
					"interrupt_turn",
					"detach-at-claim-boundary",
				);
				const caller = yield* Effect.forkChild(engine.dispatchEffect(command));
				yield* Deferred.await(claimed);
				expect(instance.interruptTurnEffect).not.toHaveBeenCalled();
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(caller));
				yield* TestClock.adjust("1 millis");
				yield* Deferred.succeed(releaseClaim, undefined);
				yield* Fiber.join(interrupting);
				const restarted = yield* makeEngine(instance, { sql });
				restarted.bindSession("session-1", "opencode");
				const replaying = yield* Effect.forkChild(
					Effect.result(
						restarted.dispatchEffect(command).pipe(Effect.timeout("1 second")),
					),
				);
				yield* TestClock.adjust("1 second");
				const replay = yield* Fiber.join(replaying);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'detach-at-claim-boundary'`,
				).toEqual([{ status: "completed", error_code: null }]);
				expect(replay._tag).toBe("Success");
				expect(instance.interruptTurnEffect).toHaveBeenCalledOnce();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	for (const kind of ["resolve_permission", "resolve_question"] as const) {
		it.effect(
			`${kind} allows only one of two different command ids to answer the same prompt`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const first = yield* makeEngine(instance, { sql });
					const second = yield* makeEngine(instance, { sql });
					first.bindSession("session-1", "opencode");
					second.bindSession("session-1", "opencode");
					yield* seedControlPrompts();
					const results = yield* Effect.all(
						[
							Effect.result(
								first.dispatchEffect(controlCommand(kind, "answer-first")),
							),
							Effect.result(
								second.dispatchEffect(controlCommand(kind, "answer-second")),
							),
						],
						{ concurrency: "unbounded" },
					);
					expect(results.map((result) => result._tag).sort()).toEqual([
						"Failure",
						"Success",
					]);
					expect(controlProvider(instance, kind)).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox`,
					).toHaveLength(1);
					expect(
						yield* sql`SELECT type FROM events WHERE type = ${controlIntentType(kind)}`,
					).toHaveLength(1);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	}
});

describe("OrchestrationEngine durable receipts", () => {
	for (const snapshotEnv of [
		undefined,
		{ ANTHROPIC_API_KEY: "synthetic-stale-key" },
	])
		it.effect(
			`refreshes live account credentials at delivery (${snapshotEnv ? "stale" : "missing"} snapshot env)`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const account = {
						id: AccountIdSchema.make("live-account"),
						name: "Live account",
						driver: "claude" as const,
						folder: configuredClaudeConfigDir("/tmp/82tn9-admitted-folder"),
						usageEligible: false,
						env: snapshotEnv,
					};
					let currentKey = "synthetic-before-admission";
					const accountDirectory = makeAccountDirectory(
						Effect.sync(() => ({
							...accountsStateFromInstances(
								[],
								configuredClaudeConfigDir("/tmp/82tn9-default"),
							),
							accounts: [
								{
									...account,
									folder: configuredClaudeConfigDir(
										"/tmp/82tn9-current-folder",
									),
									env: { ANTHROPIC_API_KEY: currentKey },
								},
							],
						})),
					);
					const instance = makeStubInstance("claude");
					const engine = new OrchestrationEngine({
						registry: new ProviderRegistry([instance]),
						accountDirectory,
						durableCommands: yield* makeDurableOptions({ sql }),
					});
					const command = sendTurnCommand({ providerId: account.id });
					yield* engine.dispatchEffect({
						...command,
						input: {
							...command.input,
							account,
							extraFolders: ["/tmp/82tn9-extra"],
						},
						onAccepted: Effect.sync(() => {
							currentKey = "synthetic-current-delivery-key";
						}),
					});
					const delivered = instance.sendTurnEffect.mock.calls[0]?.[0] as
						| SendTurnCommand["input"]
						| undefined;
					const observed = {
						account: delivered?.account,
						workspaceRoot: delivered?.workspaceRoot,
						extraFolders: delivered?.extraFolders,
					};
					reviewEvidence[`liveAccount:${snapshotEnv ? "stale" : "missing"}`] =
						observed;
					expect(observed).toEqual({
						account: {
							...account,
							env: { ANTHROPIC_API_KEY: "synthetic-current-delivery-key" },
						},
						workspaceRoot: "/tmp/project",
						extraFolders: ["/tmp/82tn9-extra"],
					});
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	for (const [driver, retry] of [
		["claude", false],
		["cursor", false],
		["claude", true],
		["cursor", true],
	] as const)
		it.effect(
			`fails ${retry ? "retry" : "redelivery"} terminally when the admitted ${driver} account was removed`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const account: Account = {
						id: AccountIdSchema.make(`removed-${driver}`),
						name: "Removed account",
						usageEligible: false,
						env: {
							ANTHROPIC_API_KEY: "synthetic-removed-key",
							CURSOR_API_KEY: "synthetic-removed-key",
						},
						...(driver === "claude"
							? {
									driver,
									folder: configuredClaudeConfigDir(
										"/tmp/82tn9-removed-account",
									),
								}
							: { driver }),
					};
					const accountDirectory = yield* AccountDirectory.pipe(
						Effect.provide(
							AccountDirectoryStateLive(
								accountsStateFromInstances(
									[
										account,
										{
											id: `fallback-${driver}`,
											name: "Fallback account",
											driver,
											env: {
												CURSOR_API_KEY: "synthetic-fallback-key",
												ANTHROPIC_API_KEY: "synthetic-fallback-key",
											},
										},
									],
									configuredClaudeConfigDir("/tmp/82tn9-default"),
									5,
									{ defaultAccountIds: { [driver]: account.id } },
								),
							),
						),
					);
					const instance = makeStubInstance(driver);
					let now = 1000;
					const durableCommands = {
						...(yield* makeDurableOptions({ sql, now: () => now })),
						persistUserMessage: (yield* ClaudeEventPersistEffectTag)
							.persistUserMessage,
					};
					const options = {
						registry: new ProviderRegistry([instance]),
						accountDirectory,
						durableCommands,
					};
					const engine = new OrchestrationEngine(options);
					const command = sendTurnCommand({ providerId: account.id });
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "session-1", {
							sessionId: "session-1",
							provider: account.id,
							title: "Removed account redelivery",
						}),
						canonicalEvent("input.admitted", "session-1", {
							sessionId: "session-1",
							inputId: "turn-1",
							delivery: "queue",
							request: { text: "hello" },
						}),
					]);
					yield* Effect.exit(
						engine.dispatchEffect({
							...command,
							input: { ...command.input, account },
							events: [
								canonicalEvent("input.sent", "session-1", {
									sessionId: "session-1",
									inputId: "turn-1",
								}),
							],
							onAccepted: Effect.interrupt,
						}),
					);
					expect(instance.sendTurnEffect).not.toHaveBeenCalled();
					expect(
						yield* sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "pending" }]);
					if (retry) {
						instance.sendTurnEffect.mockImplementationOnce(() =>
							Effect.fail(
								new ProviderInstanceFailure({
									providerId: driver,
									operation: "sendTurn",
									cause: {
										retryable: true,
										message: "Synthetic pre-intake failure",
									},
								}),
							),
						);
						yield* engine.drainSideEffects();
						expect(
							yield* sql`SELECT status FROM provider_command_outbox`,
						).toEqual([{ status: "retryable_failed" }]);
					}
					const removed = yield* accountDirectory.apply({
						_tag: "Remove",
						id: account.id,
					});
					expect(removed.deleted).toContainEqual({ id: account.id, driver });
					expect(
						(yield* accountDirectory.resolve({ _tag: "Id", id: account.id }))
							.id,
					).toBe(`fallback-${driver}`);
					const replay = new OrchestrationEngine(options);
					now += 3_600_000;
					yield* replay.drainSideEffects();
					now += 3_600_000;
					yield* replay.drainSideEffects();
					const observed = {
						launches: instance.sendTurnEffect.mock.calls.length,
						outbox:
							yield* sql`SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox`,
						receipts: yield* sql`SELECT status FROM command_receipts`,
						runs: yield* sql`SELECT status FROM provider_runs`,
						turns: yield* sql`SELECT state FROM turns`,
						inbox: yield* sql`SELECT state FROM pending_inputs`,
						sessionStatus: yield* (yield* ReadQueryEffectTag).getSessionStatus(
							"session-1",
						),
						errors: yield* sql<{
							text: string;
						}>`SELECT text FROM message_parts WHERE type = 'error'`,
						acceptedRuns:
							yield* sql`SELECT event_id FROM events WHERE type = 'run.started'`,
					};
					reviewEvidence[`removedAccount:${driver}`] = observed;
					expect.soft(observed.launches).toBe(retry ? 1 : 0);
					expect.soft(observed.outbox).toEqual([
						{
							status: "failed",
							attempt_count: retry ? 2 : 1,
							next_attempt_at: null,
						},
					]);
					expect
						.soft(observed.receipts)
						.toEqual([{ status: "side_effect_failed" }]);
					expect
						.soft(observed.runs)
						.toEqual(
							retry
								? [{ status: "error" }, { status: "error" }]
								: [{ status: "error" }],
						);
					expect.soft(observed.turns).toEqual([{ state: "error" }]);
					expect.soft(observed.inbox).toEqual([{ state: "removed" }]);
					expect.soft(observed.sessionStatus).not.toBe("busy");
					expect
						.soft(observed.errors)
						.toContainEqual({ text: expect.stringContaining(account.id) });
					expect.soft(observed.acceptedRuns).toEqual([]);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	for (const explicitProcessTarget of [false, true])
		for (const targetProviderId of [undefined, "account-b"] as const)
			it.effect(
				`ends ${targetProviderId ? "explicitly targeted B" : "running A"} after rebinding from Claude A to Cursor B (explicitProcessTarget=${explicitProcessTarget})`,
				() =>
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const accountA: Account = {
							id: AccountIdSchema.make("account-a"),
							name: "A",
							driver: "claude",
							usageEligible: false,
							folder: configuredClaudeConfigDir("/tmp/82tn9-account-a"),
						};
						const accountB: Account = {
							id: AccountIdSchema.make("account-b"),
							name: "B",
							driver: "cursor",
							usageEligible: false,
						};
						const claude = makeStubInstance("claude");
						const cursor = makeStubInstance("cursor");
						const engine = new OrchestrationEngine({
							registry: new ProviderRegistry([claude, cursor]),
							durableCommands: yield* makeDurableOptions({ sql }),
							resolveCallContext: (request) =>
								Effect.succeed({
									projectId: "test-project",
									sessionId: request.sessionId,
									account: request.account ?? accountB,
									workspaceRoot: request.workspaceRoot ?? "/pending-b",
									extraFolders: request.extraFolders ?? [],
									shellEnv: {},
								}),
						});
						engine.bindSession("session-1", accountA.id);
						for (const [sequence, runId, status, account, workspaceRoot] of [
							[1, "run-a", "running", accountA, "/running-a"],
							[2, "run-b", "pending", accountB, "/pending-b"],
						] as const) {
							yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${runId}, 'session-1', ${status}, 1000)`;
							const payload = JSON.stringify({
								projectId: "test-project",
								sessionId: "session-1",
								account,
								workspaceRoot,
								extraFolders: [],
							});
							yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
						VALUES (${sequence}, ${`send-${runId}`}, 'test-project', 'session-1', ${account.driver}, 'send_turn', ${payload}, ${runId}, ${status}, 0, 1000, 1000)`;
						}
						engine.bindSession("session-1", accountB.id);
						yield* engine.dispatchEffect({
							type: "end_session",
							commandId: "end-rebound-session",
							sessionId: "session-1",
							...(targetProviderId ? { targetProviderId } : {}),
							...(explicitProcessTarget
								? { providerProcessId: "process-1" }
								: {}),
						});
						const selected = targetProviderId ? cursor : claude;
						const other = targetProviderId ? claude : cursor;
						expect(selected.endSessionEffect).toHaveBeenCalledExactlyOnceWith(
							"session-1",
							{
								projectId: "test-project",
								sessionId: "session-1",
								account: {
									...(targetProviderId ? accountB : accountA),
									env: undefined,
								},
								workspaceRoot: targetProviderId ? "/pending-b" : "/running-a",
								extraFolders: [],
								shellEnv: {},
							},
							{
								commandId: "end-rebound-session",
								providerProcessId: explicitProcessTarget
									? "process-1"
									: "absent:end-rebound-session",
							},
						);
						expect(other.endSessionEffect).not.toHaveBeenCalled();
					}).pipe(Effect.provide(makeFixtureLayer())),
			);
	for (const explicitProcessTarget of [false, true])
		for (const fallback of [false, true])
			it.effect(
				`reaches controls after their admitted account is tombstoned (fallback=${fallback}, explicitProcessTarget=${explicitProcessTarget})`,
				() =>
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const directory = yield* AccountDirectory.pipe(
							Effect.provide(
								AccountDirectoryStateLive(
									accountsStateFromInstances(
										[
											{
												id: "control-account",
												name: "Control account",
												driver: "cursor",
												env: { CURSOR_API_KEY: "synthetic-admitted-key" },
											},
											...(fallback
												? [
														{
															id: "control-fallback",
															name: "Fallback",
															driver: "cursor" as const,
															env: { CURSOR_API_KEY: "synthetic-fallback-key" },
														},
													]
												: []),
										],
										configuredClaudeConfigDir("/tmp/82tn9-default"),
										5,
										{ defaultAccountIds: { cursor: "control-account" } },
									),
								),
							),
						);
						const account = yield* directory.resolve({
							_tag: "Id",
							id: "control-account",
						});
						const instance = makeStubInstance("cursor");
						const engine = new OrchestrationEngine({
							registry: new ProviderRegistry([instance]),
							accountDirectory: directory,
							durableCommands: yield* makeDurableOptions({ sql }),
							resolveCallContext: (request) =>
								Effect.gen(function* () {
									return {
										projectId: "test-project",
										sessionId: request.sessionId,
										account:
											request.account ??
											(yield* directory.resolve({
												_tag: "Id",
												id: request.providerId ?? account.id,
											})),
										workspaceRoot:
											request.workspaceRoot ?? "/tmp/82tn9-project",
										extraFolders: request.extraFolders ?? [],
										shellEnv: {},
									};
								}).pipe(
									Effect.mapError(
										(cause) =>
											new ProviderInstanceFailure({
												providerId: "cursor",
												operation: "resolveCallContext",
												cause,
											}),
									),
								),
						});
						engine.bindSession("session-1", account.id);
						yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('control-run', 'session-1', 'running', 1000)`;
						const payload = JSON.stringify({
							projectId: "test-project",
							sessionId: "session-1",
							account,
							workspaceRoot: "/tmp/82tn9-project",
							extraFolders: ["/tmp/82tn9-extra"],
						});
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'control-send', 'test-project', 'session-1', 'cursor', 'send_turn', ${payload}, 'control-run', 'running', 0, 1000, 1000)`;
						yield* (yield* makeCommitAndSignal)([
							canonicalEvent(
								"permission.asked",
								"session-1",
								{
									id: "control-permission",
									sessionId: "session-1",
									toolName: "Bash",
									input: {},
									providerProcessId: "control-process",
								},
								{ metadata: { runId: "control-run" } },
							),
							canonicalEvent(
								"question.asked",
								"session-1",
								{
									id: "control-question",
									sessionId: "session-1",
									questions: [],
									providerProcessId: "control-process",
								},
								{ metadata: { runId: "control-run" } },
							),
						]);
						const removed = yield* directory.apply({
							_tag: "Remove",
							id: account.id,
						});
						expect(removed.deleted).toContainEqual({
							id: account.id,
							driver: account.driver,
						});
						for (const command of [
							{
								type: "interrupt_turn",
								commandId: "control-stop",
								sessionId: "session-1",
							},
							{
								type: "resolve_permission",
								commandId: "control-allow",
								sessionId: "session-1",
								requestId: "control-permission",
								decision: "once",
							},
							{
								type: "resolve_question",
								commandId: "control-answer",
								sessionId: "session-1",
								requestId: "control-question",
								answers: {},
							},
							{
								type: "end_session",
								commandId: "control-end",
								sessionId: "session-1",
							},
							{
								type: "end_session",
								commandId: "control-end-targeted",
								sessionId: "session-1",
								targetProviderId: account.id,
							},
							{
								type: "end_session",
								commandId: "control-end-targeted-with-account",
								sessionId: "session-1",
								targetProviderId: account.id,
								account: fallback
									? yield* directory.resolve({ _tag: "Id", id: account.id })
									: account,
							},
						] as const) {
							const outcome = yield* Effect.result(
								engine.dispatchEffect({
									...command,
									...(explicitProcessTarget
										? { providerProcessId: "control-process" }
										: {}),
								}),
							);
							expect.soft(outcome).toMatchObject({
								_tag: "Success",
							});
						}
						const call = {
							projectId: "test-project",
							sessionId: "session-1",
							account: { ...account, env: undefined },
							workspaceRoot: "/tmp/82tn9-project",
							extraFolders: ["/tmp/82tn9-extra"],
							shellEnv: {},
						};
						expect
							.soft(instance.interruptTurnEffect)
							.toHaveBeenCalledExactlyOnceWith("session-1", undefined, call, {
								commandId: "control-stop",
								providerProcessId: explicitProcessTarget
									? "control-process"
									: "absent:control-stop",
							});
						expect
							.soft(instance.resolvePermissionEffect)
							.toHaveBeenCalledExactlyOnceWith(
								"session-1",
								"control-permission",
								"once",
								"control-process",
								call,
								{
									commandId: "control-allow",
									providerProcessId: "control-process",
								},
							);
						expect
							.soft(instance.resolveQuestionEffect)
							.toHaveBeenCalledExactlyOnceWith(
								"session-1",
								"control-question",
								{},
								call,
								{
									commandId: "control-answer",
									providerProcessId: "control-process",
									operation: "reply",
								},
							);
						yield* sql`UPDATE provider_runs SET status = 'completed' WHERE id = 'control-run'`;
						for (const targetProviderId of [undefined, account.id]) {
							const outcome = yield* Effect.result(
								engine.dispatchEffect({
									type: "end_session",
									commandId: `control-end-settled-${targetProviderId}`,
									sessionId: "session-1",
									...(targetProviderId ? { targetProviderId } : {}),
									...(explicitProcessTarget
										? { providerProcessId: "control-process" }
										: {}),
								}),
							);
							expect.soft(outcome).toMatchObject({ _tag: "Success" });
						}
						expect.soft(instance.endSessionEffect).toHaveBeenCalledTimes(5);
						for (let index = 1; index <= 5; index++) {
							expect.soft(instance.endSessionEffect).toHaveBeenNthCalledWith(
								index,
								"session-1",
								call,
								expect.objectContaining({
									providerProcessId: explicitProcessTarget
										? "control-process"
										: expect.stringMatching(/^absent:control-end/),
								}),
							);
						}
						const rows = yield* sql<{
							payload_json: string;
						}>`SELECT payload_json FROM provider_command_outbox WHERE effect_type != 'send_turn'`;
						expect(rows).toHaveLength(8);
						for (const row of rows) {
							expect(row.payload_json).not.toContain("synthetic-admitted-key");
							expect(row.payload_json).not.toContain("synthetic-fallback-key");
						}
						if (fallback) {
							engine.bindSession("session-1", "control-fallback");
							const nextAccount = yield* directory.resolve({
								_tag: "Id",
								id: "control-fallback",
							});
							yield* engine.dispatchEffect({
								type: "end_session",
								commandId: "control-end-next-account",
								sessionId: "session-1",
								...(explicitProcessTarget
									? { providerProcessId: "control-process" }
									: {}),
							});
							expect(instance.endSessionEffect).toHaveBeenLastCalledWith(
								"session-1",
								{
									...call,
									account: nextAccount,
									extraFolders: [],
								},
								{
									commandId: "control-end-next-account",
									providerProcessId: explicitProcessTarget
										? "control-process"
										: "absent:control-end-next-account",
								},
							);
						}
						reviewEvidence[
							`tombstonedControls:fallback=${fallback}:explicitProcessTarget=${explicitProcessTarget}`
						] = call;
					}).pipe(Effect.provide(makeFixtureLayer())),
			);
	for (const durable of [false, true])
		it.effect(
			`routes controls to running A rather than newer pending B using turn and prompt provenance (durable=${durable})`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance("opencode");
					const interrupt = vi.spyOn(instance, "interruptTurnEffect");
					const permission = vi.spyOn(instance, "resolvePermissionEffect");
					const question = vi.spyOn(instance, "resolveQuestionEffect");
					const durableCommands = yield* makeDurableOptions({ sql });
					const accountA = OpenCodeAccountSchema.make({
						id: AccountIdSchema.make("account-a"),
						name: "A",
						driver: "opencode",
						usageEligible: false,
					});
					const accountB = {
						...accountA,
						id: AccountIdSchema.make("account-b"),
						name: "B",
					};
					const engine = new OrchestrationEngine({
						registry: new ProviderRegistry([instance]),
						durableCommands,
						resolveCallContext: (request) =>
							Effect.succeed({
								projectId: "test-project",
								sessionId: request.sessionId,
								account: request.account ?? accountB,
								workspaceRoot: request.workspaceRoot ?? "/pending-b",
								extraFolders: request.extraFolders ?? [],
								shellEnv: {},
							}),
					});
					engine.bindSession("session-1", "opencode");
					for (const [sequence, runId, status, account, directory, inputId] of [
						[1, "run-a", "running", accountA, "/running-a", "input-a"],
						[2, "run-b", "pending", accountB, "/pending-b", "input-b"],
					] as const) {
						yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${runId}, 'session-1', ${status}, 1000)`;
						const payload = JSON.stringify({
							projectId: "test-project",
							sessionId: "session-1",
							account,
							workspaceRoot: directory,
							extraFolders: [],
							inputId,
							...(runId === "run-b"
								? { continuation: { cutOffMessageId: "input-a" } }
								: {}),
						});
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
					VALUES (${sequence}, ${`send-${runId}`}, 'test-project', 'session-1', 'opencode', 'send_turn', ${payload}, ${runId}, ${status}, 0, 1000, 1000)`;
					}
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent(
							"permission.asked",
							"session-1",
							{
								id: "permission-a",
								sessionId: "session-1",
								toolName: "Bash",
								input: { command: "pwd" },
								providerProcessId: "process-1",
							},
							{ metadata: { runId: "run-a" } },
						),
						canonicalEvent(
							"question.asked",
							"session-1",
							{
								id: "question-a",
								sessionId: "session-1",
								questions: [],
								providerProcessId: "process-1",
							},
							{ metadata: { runId: "run-a" } },
						),
					]);
					yield* engine.dispatchEffect({
						type: "interrupt_turn",
						commandId: "stop-a",
						sessionId: "session-1",
						turnIds: ["input-a"],
						...(durable ? { providerProcessId: "process-1" } : {}),
					});
					yield* engine.dispatchEffect({
						type: "resolve_permission",
						commandId: "allow-a",
						sessionId: "session-1",
						requestId: "permission-a",
						decision: "once",
						...(durable ? { providerProcessId: "process-1" } : {}),
					});
					yield* engine.dispatchEffect({
						type: "resolve_question",
						commandId: "answer-a",
						sessionId: "session-1",
						requestId: "question-a",
						answers: {},
						...(durable ? { providerProcessId: "process-1" } : {}),
					});
					yield* engine.dispatchEffect({
						type: "interrupt_turn",
						commandId: "stop-running",
						sessionId: "session-1",
						...(durable ? { providerProcessId: "process-1" } : {}),
					});
					yield* engine.dispatchEffect({
						type: "interrupt_turn",
						commandId: "stop-unknown",
						sessionId: "session-1",
						turnIds: ["missing-input"],
						...(durable ? { providerProcessId: "process-1" } : {}),
					});
					const calls = [
						interrupt.mock.calls[0]?.[2],
						permission.mock.calls[0]?.[4],
						question.mock.calls[0]?.[3],
						interrupt.mock.calls[1]?.[2],
						interrupt.mock.calls[2]?.[2],
					];
					const observed = calls.map((call) =>
						call
							? { account: call.account.id, directory: call.workspaceRoot }
							: null,
					);
					reviewEvidence["controls"] = observed;
					expect(observed).toEqual([
						{ account: "account-a", directory: "/running-a" },
						{ account: "account-a", directory: "/running-a" },
						{ account: "account-a", directory: "/running-a" },
						{ account: "account-a", directory: "/running-a" },
						null,
					]);
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	it.effect(
		"keeps environment values out of completed outbox rows and resolves current overrides on redelivery",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "82tn9-review-env-"))),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const env = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new ProjectShellEnvResolver({
								env: {
									HOME: root,
									PATH: "/usr/bin:/bin",
									INHERITED_SECRET: "synthetic-inherited-secret",
								},
								shell: "/bin/sh",
							}),
					),
					(resolver) => Effect.sync(() => resolver.close()),
				);
				env.register(
					root,
					{ overrides: { ANTHROPIC_AUTH_TOKEN: "synthetic-project-secret" } },
					"test-project",
				);
				yield* Effect.tryPromise(() =>
					env.waitUntilReady(root, "test-project"),
				);
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				const account = OpenCodeAccountSchema.make({
					id: AccountIdSchema.make("opencode"),
					name: "OpenCode",
					driver: "opencode",
					usageEligible: false,
					env: { ACCOUNT_SECRET: "synthetic-account-secret" },
				});
				const durableCommands = yield* makeDurableOptions({ sql });
				const options = {
					registry: new ProviderRegistry([instance]),
					durableCommands,
					resolveCallContext: () =>
						Effect.succeed(
							Object.freeze({
								projectId: "test-project",
								sessionId: "session-1",
								account,
								workspaceRoot: root,
								extraFolders: [],
								shellEnv: env.get(root, "test-project"),
							}),
						),
				};
				const engine = new OrchestrationEngine(options);
				const command = sendTurnCommand();
				const input = {
					...command.input,
					projectId: "test-project",
					account,
					workspaceRoot: root,
					shellEnv: env.get(root, "test-project"),
				};
				yield* engine.dispatchEffect({ ...command, input });
				expect(instance.sendTurnEffect).toHaveBeenCalledWith(
					expect.objectContaining({ shellEnv: input.shellEnv }),
				);
				const rows = yield* sql<{
					payload_json: string;
					status: string;
				}>`SELECT payload_json, status FROM provider_command_outbox`;
				const observed = rows.map((row) => ({
					status: row.status,
					hasShellEnv: row.payload_json.includes('"shellEnv"'),
					hasProjectSecret: row.payload_json.includes(
						"synthetic-project-secret",
					),
					hasInheritedSecret: row.payload_json.includes(
						"synthetic-inherited-secret",
					),
					hasAccountSecret: row.payload_json.includes(
						"synthetic-account-secret",
					),
				}));
				reviewEvidence["outbox"] = observed;
				expect.soft(observed).toEqual([
					{
						status: "completed",
						hasShellEnv: false,
						hasProjectSecret: false,
						hasInheritedSecret: false,
						hasAccountSecret: false,
					},
				]);

				// Stop after admission to leave a real committed, undelivered command.
				yield* Effect.exit(
					engine.dispatchEffect({
						...command,
						commandId: "redeliver-env",
						input: { ...input, inputId: "turn-redeliver" },
						onAccepted: Effect.interrupt,
					}),
				);
				env.register(
					root,
					{ overrides: { ANTHROPIC_AUTH_TOKEN: "synthetic-current-secret" } },
					"test-project",
				);
				yield* Effect.tryPromise(() =>
					env.waitUntilReady(root, "test-project"),
				);
				yield* new OrchestrationEngine(options).drainSideEffects();
				const delivered = instance.sendTurnEffect.mock.calls.at(-1)?.[0] as
					| SendTurnCommand["input"]
					| undefined;
				reviewEvidence["redelivery"] = {
					currentOverride: delivered?.shellEnv?.["ANTHROPIC_AUTH_TOKEN"],
					inherited: delivered?.shellEnv?.["INHERITED_SECRET"],
					launches: instance.sendTurnEffect.mock.calls.length,
				};
				expect(delivered?.shellEnv?.["ANTHROPIC_AUTH_TOKEN"]).toBe(
					"synthetic-current-secret",
				);
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(2);
				const completed = yield* sql<{
					payload_json: string;
					status: string;
				}>`SELECT payload_json, status FROM provider_command_outbox ORDER BY request_sequence`;
				const completedRows = completed.map((row) => ({
					status: row.status,
					hasEnvironmentValue: row.payload_json.includes("synthetic-"),
				}));
				reviewEvidence["completedRowsAfterRedelivery"] = completedRows;
				expect(completedRows).toEqual([
					{ status: "completed", hasEnvironmentValue: false },
					{ status: "completed", hasEnvironmentValue: false },
				]);
			}).pipe(Effect.scoped, Effect.provide(makeFixtureLayer())),
	);
	it.effect(
		"releases foreground admission so C drains after the indeterminate run's own end",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementationOnce(() =>
					Effect.succeed({ ...COMPLETED, status: "indeterminate" }),
				);
				const engine = yield* makeEngine(instance, { sql });
				expect((yield* engine.dispatchEffect(sendTurnCommand())).status).toBe(
					"indeterminate",
				);
				const command = sendTurnCommand({ commandId: "command-c" });
				const next = yield* Effect.forkChild(
					engine.dispatchEffect({
						...command,
						input: { ...command.input, inputId: "input-c" },
					}),
				);
				yield* TestClock.adjust("10 millis");
				expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				const first = instance.sendTurnEffect.mock
					.calls[0]?.[0] as SendTurnCommand["input"];
				yield* finishTurn(first, "opencode");
				yield* engine.drainSideEffects();
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(2);
				yield* TestClock.adjust("1 second");
				expect((yield* Fiber.join(next)).status).toBe("completed");
				expect(
					yield* sql`SELECT status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([{ status: "completed" }, { status: "completed" }]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	it.effect(
		"replays an indeterminate reservation after restart without interrupting or resending",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockReturnValue(
					Effect.succeed({ ...COMPLETED, status: "indeterminate" }),
				);
				const command = sendTurnCommand();
				const first = yield* makeEngine(instance, { sql });
				expect((yield* first.dispatchEffect(command)).status).toBe(
					"indeterminate",
				);
				const restarted = yield* makeEngine(instance, { sql });
				expect((yield* restarted.dispatchEffect(command)).status).toBe(
					"indeterminate",
				);
				yield* restarted.drainSideEffects();
				expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "running", error_code: "delivery_indeterminate" },
				]);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "pending", started_at: null }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	// A drain must not steal the commit-to-claim gap, replace the caller's
	// result/sink/signal, or impose the receipt poll timeout on a long live turn.
	it.effect(
		"concurrent immediate Resumes retry a returned handoff exactly once while its old caller unwinds",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const committed = yield* Deferred.make<void>();
				const allowClaim = yield* Deferred.make<void>();
				const instance = makeStubInstance("opencode", 4000);
				let now = 1000;
				const engine = yield* makeEngine(instance, { sql, now: () => now });
				const command = sendTurnCommand();
				const original = yield* Effect.forkChild(
					engine.dispatchEffect({
						...command,
						onAccepted: Deferred.succeed(committed, undefined).pipe(
							Effect.andThen(Deferred.await(allowClaim)),
						),
					}),
				);
				yield* Deferred.await(committed);
				const [row] = yield* sql<{
					run_id: string;
				}>`SELECT run_id FROM provider_command_outbox`;
				if (!row) throw new Error("No committed handoff");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"turn.interrupted",
						"session-1",
						{
							messageId: "",
							code: "interrupted",
							reason: "Stopped before delivery",
						},
						{ createdAt: 2000, metadata: { runId: row.run_id } },
					),
				]);
				now = 3000;
				const resumed = yield* Effect.forkChild(engine.dispatchEffect(command));
				const duplicate = yield* Effect.forkChild(
					engine.dispatchEffect(command),
				);
				yield* TestClock.adjust("1 millis");
				yield* Deferred.succeed(allowClaim, undefined);
				yield* TestClock.adjust("1 second");
				expect((yield* Fiber.join(original)).status).toBe("interrupted");
				expect((yield* Fiber.join(resumed)).status).toBe("completed");
				expect((yield* Fiber.join(duplicate)).status).toBe("completed");
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs ORDER BY requested_at`,
				).toEqual([
					{ status: "interrupted", started_at: null },
					{ status: "completed", started_at: 4000 },
				]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	it.effect("keeps a committed live command out of overlapping drains", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const committed = yield* Deferred.make<void>();
			const allowClaim = yield* Deferred.make<void>();
			const started = yield* Deferred.make<SendTurnCommand["input"]>();
			const instance = makeStubInstance("opencode");
			const cancellation = new AbortController();
			const command = sendTurnCommand({ abortSignal: cancellation.signal });
			let signal: AbortSignal | undefined;
			const result: TurnResult = { ...COMPLETED, cost: 7 };
			instance.sendTurnEffect.mockImplementation(
				(input: SendTurnCommand["input"]) =>
					Effect.gen(function* () {
						signal = input.abortSignal;
						yield* input.eventSink.push({
							eventId: "live-intake",
							type: "run.started",
							providerId: "opencode",
							sessionId: input.sessionId,
							runId: input.runId,
							providerRefs: {},
							rawSource: { kind: "test.native" },
							createdAt: 1000,
							data: { inputId: input.inputId, requestedRunId: input.runId },
						});
						yield* Deferred.succeed(started, input);
						return { ...COMPLETED, status: "accepted" as const };
					}),
			);
			const engine = yield* makeEngine(instance, { sql });
			const live = yield* Effect.forkChild(
				engine.dispatchEffect({
					...command,
					onAccepted: Deferred.succeed(committed, undefined).pipe(
						Effect.andThen(Deferred.await(allowClaim)),
					),
				}),
			);
			yield* Deferred.await(committed);
			const drain = yield* Effect.forkChild(engine.drainSideEffects());
			yield* TestClock.adjust("16 minutes");
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			yield* Fiber.join(drain);
			yield* Deferred.succeed(allowClaim, undefined);
			const input = yield* Deferred.await(started);
			expect(signal?.aborted).toBe(false);
			yield* TestClock.adjust("16 minutes");
			expect(live.pollUnsafe()).toBeUndefined();
			yield* finishTurn(input, "opencode", result);
			yield* TestClock.adjust("500 millis");
			expect(yield* Fiber.join(live)).toEqual({
				...COMPLETED,
				durationMs: 0,
				tokens: { input: 0, output: 0 },
			});
			yield* engine.drainSideEffects();
			expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
			cancellation.abort();
			expect(signal?.aborted).toBe(true);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	// Caller-supplied command ids are globally unique keys, not ownership proof.
	it.effect("rejects replay of another project's orphaned command", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const command = sendTurnCommand();
			const hash = fingerprintHash(effectiveDispatchFingerprint(command));
			yield* sql`INSERT INTO command_receipts (
				command_id, session_id, project_key, status, created_at,
				fingerprint_hash, fingerprint_version, updated_at
			) VALUES (${command.commandId}, 'session-b', 'project-b',
				'side_effect_requested', 1000, ${hash}, 2, 1000)`;
			yield* sql`INSERT INTO provider_command_outbox (
				request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, payload_json, status, attempt_count, requested_at, updated_at
			) VALUES (1, ${command.commandId}, 'project-b', 'session-b', 'opencode',
				'send_turn', '{}', 'pending', 0, 1000, 1000)`;
			const before = JSON.stringify({
				receipts: yield* sql`SELECT * FROM command_receipts`,
				outbox: yield* sql`SELECT * FROM provider_command_outbox`,
			});
			const instance = makeStubInstance("opencode");
			const engine = yield* makeEngine(instance, { sql });
			const result = yield* Effect.result(engine.dispatchEffect(command));
			expect(result._tag).toBe("Failure");
			expect(
				JSON.stringify({
					receipts: yield* sql`SELECT * FROM command_receipts`,
					outbox: yield* sql`SELECT * FROM provider_command_outbox`,
				}),
			).toBe(before);
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	for (const providerId of ["claude", "opencode"]) {
		it.effect(
			`commits ${providerId} send_turn without a transcript in the outbox`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance(providerId);
					const engine = yield* makeEngine(instance, { sql });
					const command = sendTurnCommand({ providerId });
					yield* engine.dispatchEffect({
						...command,
						input: {
							...command.input,
							inputId: "current-user",
							history: [{ role: "assistant", text: "prior transcript" }],
						},
					});

					const [row] = yield* sql<{ payload_json: string }>`
					SELECT payload_json FROM provider_command_outbox
					WHERE command_id = ${command.commandId}`;
					expect(row).toBeDefined();
					const payload: unknown = JSON.parse(row?.payload_json ?? "null");
					expect(payload).not.toHaveProperty("history");
					expect(payload).toMatchObject({
						prompt: "hello",
						inputId: "current-user",
					});
					expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	}

	it.effect("uses injected id and time sources", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const now = vi.fn(() => 4242);
			const generateId = vi.fn(() => "disp-xyz");
			const instance = makeStubInstance("opencode", 4242);
			const engine = yield* makeEngine(instance, { sql, now, generateId });

			const result = yield* engine.dispatchEffect(sendTurnCommand());

			expect(result).toMatchObject({ status: "completed" });
			expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
			expect(now).toHaveBeenCalled();
			expect(generateId).toHaveBeenCalled();
			const row = yield* receiptRow(sql, "cmd-durable-1");
			expect(row?.status).toBe("side_effect_completed");
			expect(row?.fingerprint_hash).toMatch(/^sha256:/);
			expect(row?.updated_at).toBe(4242);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect("preserves a Claude config dir through durable dispatch", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const instance = makeStubInstance("claude");
			const engine = yield* makeEngine(instance, { sql });

			yield* engine.dispatchEffect(
				sendTurnCommand({
					providerId: "claude",
					configDir: configuredClaudeConfigDir("/instances/work-claude"),
				}),
			);

			expect(instance.sendTurnEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					configDir: configuredClaudeConfigDir("/instances/work-claude"),
				}),
			);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"routes committed send_turn through the reactor to provider runtime ingestion",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runtimeEvent = decodeProviderRuntimeEvent({
					eventId: "runtime-text-1",
					type: "text.delta",
					providerId: "opencode",
					sessionId: "session-1",
					turnId: "turn-1",
					providerRefs: {},
					rawSource: { kind: "test.provider-runtime" },
					createdAt: 1000,
					data: { messageId: "message-1", partId: "text-1", text: "streamed" },
				});
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const ingest = vi.fn((event: ProviderRuntimeEvent) =>
					ingestion.ingest(event),
				);
				const command = sendTurnCommand();
				const commandSinkPush = vi.spyOn(command.input.eventSink, "push");
				const instance = makeStubInstance("opencode");
				// Provider streams output through the sink it is handed; the reactor's
				// sink routes to ProviderRuntimeIngestion, not the command's sink.
				instance.sendTurnEffect.mockImplementation((input) =>
					input.eventSink
						.push(runtimeEvent)
						.pipe(Effect.andThen(finishTurn(input, "opencode"))),
				);
				const engine = new OrchestrationEngine({
					registry: new ProviderRegistry([instance]),
					durableCommands: {
						...(yield* makeDurableOptions({ sql })),
						ingestion: {
							ingest,
							ingestBatch: ingestion.ingestBatch,
						},
					},
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(ingest).toHaveBeenCalledWith(runtimeEvent);
				expect(commandSinkPush).not.toHaveBeenCalled();
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_completed",
				);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect("id generation failure does not consume command receipt", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const instance = makeStubInstance("opencode");
			const engine = yield* makeEngine(instance, {
				sql,
				generateId: vi.fn(() => {
					throw new Error("id service down");
				}),
			});

			const failed = yield* Effect.result(
				engine.dispatchEffect(sendTurnCommand()),
			);

			expect(failed._tag).toBe("Failure");
			if (failed._tag === "Failure") {
				expect(failed.failure._tag).toBe("CommandIdGenerationFailed");
			}
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			expect(yield* receiptRow(sql, "cmd-durable-1")).toBeUndefined();
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"replays accepted send_turn after restart without provider call",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				const firstInstance = makeStubInstance("opencode");
				const firstEngine = yield* makeEngine(firstInstance, { sql });
				yield* firstEngine.dispatchEffect(sendTurnCommand());
				expect(firstInstance.sendTurnEffect).toHaveBeenCalledTimes(1);

				// Fresh engine over the same DB (simulated restart).
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });

				const replayed = yield* secondEngine.dispatchEffect(sendTurnCommand());

				expect(replayed).toMatchObject({ status: "completed" });
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"rejects reused command id with different fingerprint (changed dispatch identity)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				const firstEngine = yield* makeEngine(makeStubInstance("opencode"), {
					sql,
				});
				yield* firstEngine.dispatchEffect(sendTurnCommand({ prompt: "hello" }));

				// Restart, same command id, different effective dispatch (prompt).
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });

				const rejected = yield* Effect.result(
					secondEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);

				expect(rejected._tag).toBe("Failure");
				if (rejected._tag === "Failure") {
					expect(rejected.failure._tag).toBe("CommandFingerprintMismatch");
				}
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();

				// Durable: a further fresh engine still rejects the mismatch.
				const thirdInstance = makeStubInstance("opencode");
				const thirdEngine = yield* makeEngine(thirdInstance, { sql });
				const rejectedAgain = yield* Effect.result(
					thirdEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);
				expect(rejectedAgain._tag).toBe("Failure");
				expect(thirdInstance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"resolves provider permission requests through the caller's sink on the durable path (finding #3)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// The caller's real, interaction-capable sink must answer the
				// provider's permission request; on the durable path the reactor
				// used to substitute a failing ingestion-only sink (deny).
				const requestPermission = vi.fn(() =>
					Effect.succeed({ decision: "once" as const }),
				);
				command.input.eventSink.requestPermission = requestPermission;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementation((input) =>
					input.eventSink
						.requestPermission({
							requestId: "req-1",
							sessionId: "session-1",
							turnId: "turn-1",
							toolName: "Bash",
							toolInput: { command: "whoami" },
							providerItemId: "tool-1",
						})
						.pipe(Effect.andThen(finishTurn(input, "opencode"))),
				);
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(requestPermission).toHaveBeenCalledTimes(1);
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_completed",
				);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"redispatch after retryable failure leaves one live outbox row; drain does not re-invoke the provider (finding #2)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let providerCalls = 0;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementation(
					(input: SendTurnCommand["input"]) =>
						Effect.suspend(() => {
							providerCalls += 1;
							if (providerCalls === 1) {
								return Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: "sendTurn",
										cause: { code: "rate_limit", retryable: true },
									}),
								);
							}
							return finishTurn(input, "opencode");
						}),
				);
				const engine = yield* makeEngine(instance, { sql });

				expect(yield* engine.dispatchEffect(sendTurnCommand())).toMatchObject({
					status: "error",
					error: { code: "rate_limit" },
				});
				expect(providerCalls).toBe(1);

				const retry = yield* engine.dispatchEffect(sendTurnCommand());
				expect(retry).toMatchObject({ status: "completed" });
				expect(providerCalls).toBe(2);

				// The leftover-pending-row bug made a background drain invoke the
				// provider a third time for the already-completed command.
				yield* engine.drainSideEffects();
				expect(providerCalls).toBe(2);

				const rows = yield* sql.unsafe<{ status: string }>(
					`SELECT status FROM provider_command_outbox
					 WHERE command_id = ? ORDER BY request_sequence`,
					["cmd-durable-1"],
				);
				expect(rows.map((r) => r.status)).toEqual(["completed"]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"records provider-declared error turns as failed, not completed (finding #4)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const errorTurn: TurnResult = {
					status: "error",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					error: { code: "provider_error", message: "boom" },
					providerStateUpdates: [],
				};
				const instance = makeStubInstance("opencode");
				// Provider declares failure on the SUCCESS channel.
				instance.sendTurnEffect.mockImplementation(
					(input: SendTurnCommand["input"]) =>
						finishTurn(input, "opencode", errorTurn),
				);
				const engine = yield* makeEngine(instance, { sql });

				expect(yield* engine.dispatchEffect(sendTurnCommand())).toMatchObject({
					status: "error",
					error: { code: "provider_error" },
				});
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_failed",
				);

				// Restart replay must NOT synthesize success without executing.
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });
				yield* Effect.result(secondEngine.dispatchEffect(sendTurnCommand()));
				expect(secondInstance.sendTurnEffect).toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"replays an orphaned committed-but-unexecuted command as incomplete, not completed (finding #7)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// Simulate a crash after commit but before execution: a
				// side_effect_requested receipt whose fingerprint matches the command.
				yield* seedReceipt(sql, command);
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);

				expect(result.status).toBe("interrupted");
				expect(result.status).not.toBe("completed");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"orphan replay terminalizes the leftover outbox row so a later drain cannot execute it (re-review finding #2)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						title: "Orphan",
						provider: "opencode",
					}),
					canonicalEvent(
						"run.requested",
						"session-1",
						{ runId: "orphaned-run", inputId: command.input.inputId },
						{ metadata: { runId: "orphaned-run" } },
					),
				]);
				// Crash after commit but before execution: a side_effect_requested
				// receipt AND the still-pending outbox row it committed.
				yield* seedReceipt(sql, command);
				const {
					eventSink: _sink,
					abortSignal: _abort,
					...payload
				} = command.input;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
					provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
					VALUES (1, ${command.commandId}, 'test-project', 'session-1', 'opencode', 'send_turn',
					${JSON.stringify({ ...payload, dispatchId: "disp-1" })}, 'orphaned-run', 'pending', 0, 1000, 1000)`;
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);
				expect(result.status).toBe("interrupted");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				// A later recovery drain must NOT execute the orphaned command.
				yield* engine.drainSideEffects();
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				const rows = yield* sql.unsafe<{ status: string }>(
					`SELECT status FROM provider_command_outbox
					 WHERE command_id = ? ORDER BY request_sequence`,
					[command.commandId],
				);
				expect(
					rows.every(
						(r) =>
							r.status !== "pending" &&
							r.status !== "running" &&
							r.status !== "retryable_failed",
					),
				).toBe(true);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"rejects a receipt written under an older fingerprint scheme version instead of replaying it (re-review finding #5)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// Hash matches the current command, but the receipt was written under
				// fingerprint scheme version 1. Hashes are only comparable within a
				// scheme version, so this must be treated as a fingerprint mismatch,
				// never a completed replay and never a re-execution.
				yield* seedReceipt(sql, command, {
					status: "side_effect_completed",
					version: 1,
				});
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* Effect.result(engine.dispatchEffect(command));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") {
					expect((result.failure as { _tag: string })._tag).toBe(
						"CommandFingerprintMismatch",
					);
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"honors stale-command tombstones from the narrow command read model",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Seed a session-scope tombstone directly in the command read model
				// (no full relay/UI snapshot rows exist).
				yield* sql.unsafe(
					`INSERT INTO provider_command_tombstones
						(project_key, scope_kind, scope_id, event_sequence, reason_code, tombstoned_at)
					 VALUES ('test-project', 'session', 'session-1', 1, 'session_deleted', 500)`,
				);

				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const rejected = yield* Effect.result(
					engine.dispatchEffect(sendTurnCommand()),
				);

				expect(rejected._tag).toBe("Failure");
				if (rejected._tag === "Failure") {
					expect(rejected.failure._tag).toBe("StaleCommandRejected");
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
				expect(yield* receiptRow(sql, "cmd-durable-1")).toBeUndefined();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
});
