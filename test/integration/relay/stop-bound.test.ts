import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../../../src/lib/domain/daemon/Services/provider-adapters.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ProviderTurnServiceTag,
	STOP_ABORT_WAIT_MS,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { inboxRunStatusQuery } from "../../../src/lib/persistence/inbox-run-status-query.js";
import { getOrchestrationLayer } from "../../../src/lib/provider/orchestration-wiring.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeOpenCodeInstancesStub,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";
import { makeTestOrchestrationRuntimeLayer as makeOrchestrationRuntimeLayer } from "../../helpers/provider-adapters.js";

const stopLayer = (api: OpenCodeAPI, scratch: string) => {
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		SessionEventBusLive,
	);
	const accounts = makeMockAccountDirectory();
	const orchestration = makeOrchestrationRuntimeLayer({
		configDir: scratch,
		workspaceRoot: scratch,
		shellEnv: () => ({}),
	}).pipe(
		Layer.provideMerge(SessionWorkspaceLive),
		Layer.provideMerge(
			Layer.mergeAll(
				persistence,
				makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
				Layer.succeed(AccountDirectory, accounts),
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({ projectDir: scratch, configDir: scratch }),
				),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		),
	);
	return Layer.unwrap(
		Effect.gen(function* () {
			const wired = yield* getOrchestrationLayer;
			return SessionInboxLive.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						SessionEventBusLive,
						Layer.succeed(Usage, {
							readings: Stream.empty,
							latest: () => Effect.succeed(undefined),
							refresh: (_options) => Effect.succeed([]),
							turnEnded: () => Effect.void,
							pickFailover: () => Effect.succeed(undefined),
						}),
						makeTestHandlerLayer({
							api,
							accountDirectory: accounts,
							config: makeMockConfig({
								projectDir: scratch,
								configDir: scratch,
							}),
							orchestrationEngine: wired.engine,
							providerRegistry: wired.registry,
							persistenceLayer: persistence,
							openCodeModelService: makeMockOpenCodeModelService(
								MOCK_OPENCODE_GPT4_CATALOG,
							),
							seedEvents: [
								makeSessionCreatedEvent("session-1", { provider: "opencode" }),
								...sessionPickEvents("session-1", {
									harness: "opencode",
									model: { providerId: "openai", modelId: "gpt-4" },
									effort: "",
									contextWindow: "",
								}),
							],
						}),
					),
				),
			);
		}),
	).pipe(
		Layer.provideMerge(orchestration),
		Layer.provideMerge(SessionEventBusLive),
	);
};

const scratchDirectory = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-stop-bound-"))),
	(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);

const flushDispatch = Effect.promise<void>(
	() => new Promise((resolve) => setImmediate(resolve)),
);

describe("Stop bound through SQLite ingestion and durable dispatch", () => {
	for (const acknowledgement of [
		"before-terminal",
		"after-terminal",
		"never",
	] as const) {
		it.effect(
			`OpenCode Stop preserves natural completion and fences its pending abort, acknowledgement=${acknowledgement}`,
			() =>
				Effect.gen(function* () {
					const scratch = yield* scratchDirectory;
					const api = makeMockOpenCodeAPI({
						promptProcessId: "opencode:silent-stop",
					});
					let acknowledgeAbort = () => {};
					if (acknowledgement !== "before-terminal")
						api.session.abort = vi.fn(
							() =>
								new Promise<void>((resolve) => {
									acknowledgeAbort = resolve;
								}),
						);
					yield* Effect.gen(function* () {
						const adapters = yield* ProviderAdapters;
						yield* adapters.registerProject(
							"test-project",
							yield* Effect.context<ProviderAdapterProjectContext>(),
						);
						yield* adapters.recover;
						const sql = yield* SqlClient.SqlClient;
						const persist = yield* ClaudeEventPersistEffectTag;
						const turns = yield* ProviderTurnServiceTag;
						yield* persist.persistEvents([
							canonicalEvent(
								"run.requested",
								"session-1",
								{ inputId: "original", runId: "original-run" },
								{ metadata: { runId: "original-run" } },
							),
							canonicalEvent(
								"message.created",
								"session-1",
								{
									sessionId: "session-1",
									messageId: "original",
									role: "user",
									inputId: "original",
								},
								{ metadata: { runId: "original-run" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{
									inputId: "original",
									requestedRunId: "original-run",
									userMessageId: "original",
								},
								{ metadata: { runId: "original-run" } },
							),
							canonicalEvent(
								"session.status",
								"session-1",
								{ sessionId: "session-1", status: "busy" },
								{ metadata: { runId: "original-run" } },
							),
						]);
						const stopped = yield* turns.beginStop({
							clientId: "client-1",
							sessionId: "session-1",
							commandId: "silent-stop",
						});
						yield* TestClock.adjust(100);
						expect(api.session.abort).toHaveBeenCalledOnce();
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = 'original-run'`,
						).toEqual([{ status: "running" }]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
						).toEqual([]);
						expect(turns.turnFences("session-1").stopping).toBe(true);
						const inbox = yield* SessionInboxTag;
						yield* inbox.start;
						yield* inbox.submit({
							clientId: "client-1",
							sessionId: "session-1",
							inputId: "replacement",
							delivery: "queue",
							request: { text: "replacement" },
						});
						yield* persist.persistEvents([
							canonicalEvent(
								"turn.completed",
								"session-1",
								{ messageId: "" },
								{ provider: "opencode", metadata: { runId: "original-run" } },
							),
							canonicalEvent(
								"session.status",
								"session-1",
								{ sessionId: "session-1", status: "idle" },
								{ provider: "opencode", metadata: { runId: "original-run" } },
							),
						]);
						yield* TestClock.adjust(100);
						if (acknowledgement !== "before-terminal") {
							expect(turns.turnFences("session-1").stopping).toBe(true);
							expect(api.session.prompt).not.toHaveBeenCalled();
							expect(
								yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'silent-stop'`,
							).toEqual([{ status: "running" }]);
							if (acknowledgement === "after-terminal") acknowledgeAbort();
							else yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
						}
						yield* stopped;
						yield* TestClock.adjust(500);
						yield* flushDispatch;
						expect(api.session.prompt).toHaveBeenCalledOnce();
						expect(turns.turnFences("session-1").stopping).toBe(false);
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = 'original-run'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
						).toEqual([]);
						const terminals =
							yield* sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.interrupted', 'turn.error') AND json_extract(metadata, '$.runId') = 'original-run'`;
						expect(terminals).toHaveLength(1);
						writeFileSync(
							`/tmp/82tn27-3-round5-opencode-${acknowledgement}.json`,
							JSON.stringify(
								{
									acknowledgement,
									terminals,
									nativeStops: vi.mocked(api.session.abort).mock.calls.length,
									replacementStarts: vi.mocked(api.session.prompt).mock.calls
										.length,
									runs: yield* sql`SELECT id, status FROM provider_runs`,
								},
								null,
								2,
							),
						);
					}).pipe(Effect.provide(stopLayer(api, scratch)));
				}),
		);
	}

	// Before the first echo, only the outbox admission keeps the inbox busy.
	it.effect(
		"unconfirmed OpenCode Stop fails its cohort at the bound and ignores late acknowledgements",
		() =>
			Effect.gen(function* () {
				const scratch = yield* scratchDirectory;
				const api = makeMockOpenCodeAPI({
					promptProcessId: "opencode:stop-bound-original",
				});
				let failOriginalSend: ((cause: Error) => void) | undefined;
				api.session.prompt = vi
					.fn(() => Promise.reject<void>(new Error("replacement send failed")))
					.mockImplementationOnce(
						() =>
							new Promise<void>((_resolve, reject) => {
								failOriginalSend = reject;
							}),
					);
				let acknowledgeAbort: (() => void) | undefined;
				api.session.abort = vi.fn(
					() =>
						new Promise<void>((resolve) => {
							acknowledgeAbort = resolve;
						}),
				);
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const inbox = yield* SessionInboxTag;
					const turns = yield* ProviderTurnServiceTag;
					yield* inbox.start;
					yield* inbox.submit({
						clientId: "client-1",
						sessionId: "session-1",
						inputId: "original",
						delivery: "queue",
						request: { text: "original" },
					});
					yield* flushDispatch;
					expect(api.session.prompt).toHaveBeenCalledOnce();
					const [original] = yield* sql<{ run_id: string }>`SELECT run_id
						FROM provider_command_outbox WHERE command_id = 'original'`;
					expect(original?.run_id).toEqual(expect.any(String));
					expect(yield* sql`SELECT id FROM turns`).toEqual([]);
					expect(yield* sql`SELECT id FROM messages`).toEqual([]);
					const stopped = yield* inbox.withSession(
						"session-1",
						turns.beginStop({
							clientId: "client-1",
							sessionId: "session-1",
							commandId: "stop-original",
						}),
					);
					yield* inbox.submit({
						clientId: "client-1",
						sessionId: "session-1",
						inputId: "replacement",
						delivery: "queue",
						request: { text: "replacement" },
					});
					expect(
						yield* inbox.sendNow({
							clientId: "client-1",
							sessionId: "session-1",
							inputId: "replacement",
							interrupt: true,
						}),
					).toBe("accepted");
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS - 1);
					expect(api.session.abort).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT effect_type, provider_process_id, status FROM provider_command_outbox WHERE command_id = 'stop-original'`,
					).toEqual([
						{
							effect_type: "interrupt_turn",
							provider_process_id: "opencode:stop-bound-original",
							status: "running",
						},
					]);
					expect(
						yield* sql`SELECT status FROM command_receipts WHERE command_id = 'stop-original'`,
					).toEqual([{ status: "side_effect_requested" }]);
					expect(api.session.prompt).toHaveBeenCalledOnce();
					expect(turns.turnFences("session-1").stopping).toBe(true);
					expect(
						yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued'`,
					).toEqual([{ input_id: "replacement" }]);
					yield* TestClock.adjust(1);
					yield* stopped;
					yield* flushDispatch;
					expect(turns.turnFences("session-1").stopping).toBe(false);
					expect(
						yield* sql`SELECT status, error_code FROM provider_command_outbox
						WHERE command_id = 'original'`,
					).toEqual([{ status: "failed", error_code: "stop_unconfirmed" }]);
					expect(
						yield* sql`SELECT status, error_code FROM command_receipts
						WHERE command_id = 'original'`,
					).toEqual([
						{ status: "side_effect_failed", error_code: "stop_unconfirmed" },
					]);
					expect(
						yield* sql`SELECT status, started_at FROM provider_runs WHERE id = ${original?.run_id}`,
					).toEqual([{ status: "error", started_at: null }]);
					yield* sql`SELECT 1 FROM turns WHERE user_message_id = 'msg_conduit_original'`.pipe(
						Effect.repeat({ until: (rows) => rows.length === 1 }),
					);
					expect(
						yield* sql`SELECT state, run_id, started_at FROM turns WHERE user_message_id = 'msg_conduit_original'`,
					).toEqual([
						{
							state: "error",
							run_id: original?.run_id,
							started_at: null,
						},
					]);
					// A late transport error cannot reopen the reservation retired by Stop.
					expect(failOriginalSend).toBeDefined();
					failOriginalSend?.(new Error("original send failed"));
					yield* sql`SELECT 1 FROM provider_command_outbox WHERE command_id = 'replacement'
						AND error_code = 'delivery_indeterminate'`.pipe(
						Effect.repeat({ until: (rows) => rows.length === 1 }),
					);
					expect(api.session.prompt).toHaveBeenCalledTimes(2);
					expect(api.session.prompt).toHaveBeenLastCalledWith(
						"session-1",
						expect.objectContaining({ text: "replacement" }),
					);
					expect(
						yield* inbox.sendNow({
							clientId: "client-1",
							sessionId: "session-1",
							inputId: "replacement",
							interrupt: true,
						}),
					).toBe("already_started");
					expect(api.session.prompt).toHaveBeenCalledTimes(2);
					expect(
						yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'original'`,
					).toEqual([{ status: "failed", error_code: "stop_unconfirmed" }]);
					acknowledgeAbort?.();
					yield* flushDispatch;
					vi.mocked(api.session.abort).mockResolvedValue(undefined);
					const endReplacement = yield* turns.beginStop({
						clientId: "client-1",
						sessionId: "session-1",
						commandId: "confirmed-stop-replacement",
					});
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
					yield* endReplacement;
					expect(yield* inboxRunStatusQuery(sql, "session-1")).toEqual([
						{ status: "error", stopped: 1 },
					]);
					expect(
						yield* sql`SELECT command_id, status FROM provider_command_outbox
						WHERE effect_type = 'send_turn' ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "original", status: "failed" },
						{ command_id: "replacement", status: "failed" },
					]);
					expect(
						yield* sql`SELECT status, started_at FROM provider_runs ORDER BY rowid`,
					).toEqual([
						{ status: "error", started_at: null },
						{ status: "error", started_at: null },
					]);
					expect(
						yield* sql`SELECT command_id, status, error_code FROM command_receipts
						WHERE command_id IN ('original', 'replacement') ORDER BY rowid`,
					).toEqual([
						{
							command_id: "original",
							status: "side_effect_failed",
							error_code: "stop_unconfirmed",
						},
						{
							command_id: "replacement",
							status: "side_effect_failed",
							error_code: "stop_unconfirmed",
						},
					]);
				}).pipe(Effect.provide(stopLayer(api, scratch)));
			}),
	);

	it.effect(
		"commits Stop against the captured process and cancels it before selecting a replacement",
		() =>
			Effect.gen(function* () {
				const scratch = yield* scratchDirectory;
				const api = makeMockOpenCodeAPI({
					promptProcessId: "opencode:captured-process",
				});
				const replacement = makeMockOpenCodeAPI({
					promptProcessId: "opencode:replacement-process",
				});
				const ifRunning = vi
					.fn(() => Effect.succeed(Option.some(replacement)))
					.mockImplementationOnce(() => Effect.succeed(Option.some(api)));
				const use = vi.fn(() => Effect.succeed(replacement));
				const fixture = stopLayer(api, scratch).pipe(
					Layer.tap((context) =>
						Effect.sync(() => {
							const instances = Context.get(context, OpenCodeInstancesTag);
							vi.spyOn(instances, "ifRunning").mockImplementation(ifRunning);
							vi.spyOn(instances, "use").mockImplementation(use);
						}),
					),
				);
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const turns = yield* ProviderTurnServiceTag;
					const stopped = yield* turns.beginStop({
						clientId: "client-1",
						sessionId: "session-1",
						commandId: "stop-replaced-process",
					});
					expect(yield* Effect.result(stopped)).toMatchObject({
						_tag: "Success",
					});
					expect(
						yield* sql`SELECT provider_process_id, status, error_code FROM provider_command_outbox WHERE command_id = 'stop-replaced-process'`,
					).toEqual([
						{
							provider_process_id: "opencode:captured-process",
							status: "cancelled",
							error_code: "provider_process_gone",
						},
					]);
					expect(
						yield* sql`SELECT status, error_code, json_extract(error, '$.causeMessage') AS reason FROM command_receipts WHERE command_id = 'stop-replaced-process'`,
					).toEqual([
						{
							status: "side_effect_failed",
							error_code: "provider_process_gone",
							reason: expect.any(String),
						},
					]);
					expect(ifRunning).toHaveBeenCalledTimes(2);
					expect(use).not.toHaveBeenCalled();
					expect(api.session.abort).not.toHaveBeenCalled();
					expect(replacement.session.abort).not.toHaveBeenCalled();
				}).pipe(Effect.provide(fixture));
			}),
	);

	// Work claimed after Stop must survive retirement of the captured cohort.
	it.effect(
		"retires only the snapshot when a continuation is claimed before ingestion",
		() =>
			Effect.gen(function* () {
				const scratch = yield* scratchDirectory;
				const api = makeMockOpenCodeAPI({
					promptProcessId: "opencode:stop-snapshot",
				});
				api.session.abort = vi.fn(() => new Promise<void>(() => {}));
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const turns = yield* ProviderTurnServiceTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					const ownedInput = (inputId: string) => [
						canonicalEvent(
							"run.requested",
							"session-1",
							{ inputId, runId: `${inputId}-run` },
							{ metadata: { runId: `${inputId}-run` } },
						),
						canonicalEvent(
							"message.created",
							"session-1",
							{
								sessionId: "session-1",
								messageId: inputId,
								role: "user",
								inputId,
							},
							{ metadata: { runId: `${inputId}-run` } },
						),
						canonicalEvent(
							"run.started",
							"session-1",
							{
								inputId,
								requestedRunId: `${inputId}-run`,
								userMessageId: inputId,
							},
							{ metadata: { runId: `${inputId}-run` } },
						),
						canonicalEvent(
							"session.status",
							"session-1",
							{ sessionId: "session-1", status: "busy" },
							{ metadata: { runId: `${inputId}-run` } },
						),
					];
					yield* persist.persistEvents(ownedInput("original"));
					yield* sql`INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at
				) VALUES (1, 'original', 'test-project', 'session-1', 'opencode',
					'send_turn', '{"inputId":"original"}', 'original-run', 'running', 1, 1, 1)`;
					const ingestBatch = ingestion.ingestBatch;
					const retirement = vi
						.spyOn(ingestion, "ingestBatch")
						.mockImplementation((events, options) =>
							persist.persistEvents(ownedInput("continuation")).pipe(
								Effect.orDie,
								Effect.andThen(sql`INSERT INTO provider_command_outbox (
							request_sequence, command_id, project_key, session_id, provider_id,
							effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at
						) VALUES ((SELECT COALESCE(MAX(request_sequence), 0) + 1 FROM provider_command_outbox), 'continuation', 'test-project', 'session-1', 'opencode',
							'send_turn', '{"inputId":"continuation"}', 'continuation-run', 'running', 1, 1, 1)`),
								Effect.andThen(ingestBatch(events, options)),
							),
						);
					const stopped = yield* turns.beginStop({
						clientId: "client-1",
						sessionId: "session-1",
						commandId: "stop-original",
					});
					const completion = yield* Effect.forkChild(
						stopped.pipe(Effect.result),
					);
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
					expect(yield* Fiber.join(completion)).toMatchObject({
						_tag: "Success",
					});
					expect(retirement).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT user_message_id, state FROM turns ORDER BY rowid`,
					).toEqual([
						{ user_message_id: "original", state: "error" },
						{ user_message_id: "continuation", state: "running" },
					]);
					expect(
						yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events
							WHERE type = 'turn.error' AND json_extract(data, '$.code') = 'stop_unconfirmed'`,
					).toEqual([{ run_id: "original-run" }]);
					expect(
						yield* sql`SELECT status FROM sessions WHERE id = 'session-1'`,
					).toEqual([{ status: "busy" }]);
					expect(
						yield* sql`SELECT command_id, status FROM provider_command_outbox WHERE effect_type = 'send_turn' ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "original", status: "failed" },
						{ command_id: "continuation", status: "running" },
					]);
					expect(
						yield* sql`SELECT id, status FROM provider_runs ORDER BY rowid`,
					).toEqual([
						{ id: "original-run", status: "error" },
						{ id: "continuation-run", status: "running" },
					]);
					expect(turns.turnFences("session-1").stopping).toBe(false);
				}).pipe(Effect.provide(stopLayer(api, scratch)));
			}),
	);
});
