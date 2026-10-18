import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream, TestClock } from "effect";
import { expect, vi } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ProviderTurnServiceTag,
	STOP_ABORT_WAIT_MS,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	getOrchestrationLayer,
	makeOrchestrationRuntimeLayer,
} from "../../../src/lib/provider/orchestration-wiring.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeOpenCodeInstancesStub,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

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
		Layer.provideMerge(
			Layer.mergeAll(
				persistence,
				makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
				Layer.succeed(AccountDirectory, accounts),
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		),
	);
	return Layer.unwrapScoped(
		Effect.gen(function* () {
			const wired = yield* getOrchestrationLayer;
			return SessionInboxLive.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						SessionEventBusLive,
						Layer.succeed(Usage, {
							readings: Stream.empty,
							latest: () => Effect.succeed(undefined),
							refresh: () => Effect.succeed([]),
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
	).pipe(Layer.provideMerge(orchestration));
};

const scratchDirectory = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-stop-bound-"))),
	(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);

const flushDispatch = Effect.promise<void>(
	() => new Promise((resolve) => setImmediate(resolve)),
);

describe("Stop bound through SQLite ingestion and durable dispatch", () => {
	// Before the first echo, only the outbox admission keeps the inbox busy.
	it.scoped(
		"keeps the replacement queued after the bound until the pre-echo send fails",
		() =>
			Effect.gen(function* () {
				const scratch = yield* scratchDirectory;
				const api = makeMockOpenCodeAPI();
				let failOriginalSend: ((cause: Error) => void) | undefined;
				api.session.prompt = vi
					.fn(() => Promise.reject<void>(new Error("replacement send failed")))
					.mockImplementationOnce(
						() =>
							new Promise<void>((_resolve, reject) => {
								failOriginalSend = reject;
							}),
					);
				api.session.abort = vi.fn(() => new Promise<void>(() => {}));
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
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS - 1);
					expect(api.session.abort).toHaveBeenCalledOnce();
					expect(api.session.prompt).toHaveBeenCalledOnce();
					expect(turns.turnFences("session-1").stopping).toBe(true);
					expect(
						yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued'`,
					).toEqual([{ input_id: "replacement" }]);
					yield* TestClock.adjust(1);
					yield* stopped;
					yield* flushDispatch;
					expect(turns.turnFences("session-1").stopping).toBe(false);
					expect(api.session.prompt).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued'`,
					).toEqual([{ input_id: "replacement" }]);
					expect(
						yield* sql`SELECT status, error_code FROM provider_command_outbox
						WHERE command_id = 'original'`,
					).toEqual([{ status: "running", error_code: null }]);
					expect(
						yield* sql`SELECT status, error_code FROM command_receipts
						WHERE command_id = 'original'`,
					).toEqual([{ status: "side_effect_requested", error_code: null }]);
					expect(yield* sql`SELECT id FROM messages`).toEqual([]);
					expect(failOriginalSend).toBeDefined();
					failOriginalSend?.(new Error("original send failed"));
					yield* flushDispatch;
					expect(api.session.prompt).toHaveBeenCalledTimes(2);
					expect(api.session.prompt).toHaveBeenLastCalledWith(
						"session-1",
						expect.objectContaining({ text: "replacement" }),
					);
					expect(
						yield* sql`SELECT input_id, text FROM messages
						WHERE session_id = 'session-1' AND role = 'user' ORDER BY rowid`,
					).toEqual([
						{ input_id: "original", text: "original" },
						{ input_id: "replacement", text: "replacement" },
					]);
					expect(
						yield* sql`SELECT command_id, status FROM provider_command_outbox
						WHERE effect_type = 'send_turn' ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "original", status: "failed" },
						{ command_id: "replacement", status: "failed" },
					]);
				}).pipe(Effect.provide(stopLayer(api, scratch)));
			}),
	);

	// A continuation can supersede retirement after the worker's last read.
	it.scoped(
		"succeeds when the real ingestion transaction rolls retirement back",
		() =>
			Effect.gen(function* () {
				const scratch = yield* scratchDirectory;
				const api = makeMockOpenCodeAPI();
				api.session.abort = vi.fn(() => new Promise<void>(() => {}));
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const turns = yield* ProviderTurnServiceTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
					VALUES ('turn-1', 'session-1', 'running', 'original', 1)`;
					yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 'session-1'`;
					yield* sql`INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, attempt_count, requested_at, updated_at
				) VALUES (1, 'original', 'test-project', 'session-1', 'opencode',
					'send_turn', '{"inputId":"original"}', 'running', 0, 1, 1)`;
					const ingestBatch = ingestion.ingestBatch;
					const retirement = vi
						.spyOn(ingestion, "ingestBatch")
						.mockImplementation((events, options) =>
							sql`INSERT INTO provider_command_outbox (
							request_sequence, command_id, project_key, session_id, provider_id,
							effect_type, payload_json, status, attempt_count, requested_at, updated_at
						) VALUES (2, 'continuation', 'test-project', 'session-1', 'opencode',
							'send_turn', '{"inputId":"continuation"}', 'running', 0, 1, 1)`.pipe(
								Effect.zipRight(ingestBatch(events, options)),
							),
						);
					const stopped = yield* turns.beginStop({
						clientId: "client-1",
						sessionId: "session-1",
						commandId: "stop-original",
					});
					const completion = yield* Effect.fork(stopped.pipe(Effect.either));
					yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
					expect(yield* Fiber.join(completion)).toMatchObject({
						_tag: "Right",
					});
					expect(retirement).toHaveBeenCalledOnce();
					expect(
						yield* sql`SELECT state FROM turns WHERE id = 'turn-1'`,
					).toEqual([{ state: "running" }]);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
					).toEqual([]);
					expect(
						yield* sql`SELECT status FROM sessions WHERE id = 'session-1'`,
					).toEqual([{ status: "busy" }]);
					expect(
						yield* sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "original", status: "running" },
						{ command_id: "continuation", status: "running" },
					]);
					expect(turns.turnFences("session-1").stopping).toBe(false);
				}).pipe(Effect.provide(stopLayer(api, scratch)));
			}),
	);
});
