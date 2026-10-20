import { it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../../../src/lib/domain/relay/Services/session-workspace.js";
import { makeFailTurn } from "../../../../src/lib/domain/relay/Services/turn-failure.js";
import type { Message } from "../../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { openCodeInputMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { OpenCodeProviderInstance } from "../../../../src/lib/provider/opencode-provider-instance.js";
import { runningRunnerCommands } from "../../../../src/lib/provider/runner/runner-recovery.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../../helpers/mock-factories.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

it.effect(
	"keeps a first native extra-folder directory for the next local send",
	() => {
		const client = makeMockOpenCodeAPI();
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const dependencies = Layer.mergeAll(
			persistence,
			Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
			Layer.succeed(ConfigTag)(
				makeMockConfig({
					projectDir: "/tmp/project",
					extraFolders: ["/tmp/native-extra"],
				}),
			),
			Layer.succeed(LoggerTag)(makeMockLogger()),
			Layer.succeed(OpenCodeAPITag)(client),
		);
		const workspace = SessionWorkspaceLive.pipe(
			Layer.provideMerge(dependencies),
		);
		return Effect.gen(function* () {
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
			);
			yield* ingress.onSSEEventEffect(
				makeSSEEvent("message.updated", {
					info: {
						id: "native-user",
						sessionID: "s",
						role: "user",
						time: { created: 1 },
					},
				}),
				"s",
				"opencode",
				{ directory: "/tmp/native-extra" },
			);
			const directory = yield* (yield* SessionWorkspaceTag).get("s");
			expect(directory).toBe("/tmp/native-extra");
			const provider = new OpenCodeProviderInstance({ client });
			const send = yield* Effect.forkChild(
				provider.sendTurnEffect({
					sessionId: "s",
					inputId: "next",
					awaitIntake: Effect.succeed({
						status: "accepted",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					}),
					runId: "next-run",
					prompt: "Continue",
					history: [],
					providerState: {},
					workspaceRoot: directory,
					extraFolders: [],
					abortSignal: new AbortController().signal,
					eventSink: {
						push: () => Effect.void,
						requestPermission: () => Effect.succeed({ decision: "once" }),
						requestQuestion: () => Effect.succeed({}),
						resolvePermission: () => Effect.void,
						resolveQuestion: () => Effect.void,
					},
				}),
			);
			yield* Effect.promise(() =>
				vi.waitFor(() =>
					expect(client.session.prompt).toHaveBeenCalledWith(
						"s",
						expect.objectContaining({ directory: "/tmp/native-extra" }),
					),
				),
			);
			yield* Fiber.join(send);
			// A recorded reset must override the initial native declaration.
			yield* (yield* makeCommitAndSignal)([
				canonicalEvent("session.workspace_changed", "s", {
					sessionId: "s",
					path: "/tmp/project",
					cause: "user",
					origin: "existing",
					worktrees: {},
				}),
			]);
			expect(yield* (yield* SessionWorkspaceTag).get("s")).toBe("/tmp/project");
			ingress.shutdown();
		}).pipe(
			Effect.provide(
				Layer.merge(
					workspace,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);

it.effect(
	"confirmed instance stop settles its claimed reservation before provider intake",
	() => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
			);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.created", "s", {
					sessionId: "s",
					provider: "opencode",
					title: "Delivered send",
				}),
				canonicalEvent(
					"run.requested",
					"s",
					{ runId: "r", inputId: "input" },
					{ metadata: { runId: "r" } },
				),
				canonicalEvent(
					"message.created",
					"s",
					{
						sessionId: "s",
						messageId: "input",
						role: "user",
					},
					{ metadata: { runId: "r" } },
				),
			]);
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id,
			effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'input', 'test-project', 's', 'opencode', 'send_turn',
			'r', '{"inputId":"input"}', 'running', 1, 1, 1)`;
			yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
			VALUES ('input', 's', 'test-project', 'side_effect_requested', 1, 1)`;
			let guards = 0;
			yield* ingress.onInstanceStopped("opencode", () => ++guards < 3);
			expect(
				yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'input'`,
			).toEqual([{ status: "running" }]);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'r'`,
			).toEqual([{ status: "pending" }]);
			yield* ingress.onInstanceStopped("opencode", () => true);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'r'`,
			).toEqual([{ status: "interrupted" }]);
			expect(
				yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'input'`,
			).toEqual([{ status: "failed" }]);
			expect(
				yield* sql`SELECT status FROM command_receipts WHERE command_id = 'input'`,
			).toEqual([{ status: "side_effect_failed" }]);
			expect(
				yield* sql`SELECT state, run_id FROM turns WHERE user_message_id = 'input'`,
			).toEqual([{ state: "interrupted", run_id: "r" }]);
			ingress.shutdown();
		}).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);

it.effect(
	"interrupts ambiguous outstanding runs when the provider confirms session idle",
	() => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
			);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.created", "s", {
					sessionId: "s",
					provider: "opencode",
					title: "Idle",
				}),
				...["a", "b"].map((runId) =>
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: runId, requestedRunId: runId },
						{ metadata: { runId } },
					),
				),
			]);
			yield* ingress.onSSEEventEffect(
				makeSSEEvent("session.status", {
					sessionID: "s",
					status: { type: "idle" },
				}),
				"s",
				"opencode",
			);
			expect(
				yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
			).toEqual([
				{ id: "a", status: "interrupted" },
				{ id: "b", status: "interrupted" },
			]);
			expect(
				yield* sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'turn.interrupted'`,
			).toEqual([
				{ reason: "OpenCode reported session idle" },
				{ reason: "OpenCode reported session idle" },
			]);
			ingress.shutdown();
		}).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);

it.effect(
	"settles every outstanding run on a provider session-scoped failure",
	() => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
			);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.created", "s", {
					sessionId: "s",
					provider: "opencode",
					title: "Failure",
				}),
				canonicalEvent(
					"run.started",
					"s",
					{ inputId: "external", requestedRunId: "accepted" },
					{ metadata: { runId: "accepted" } },
				),
				canonicalEvent(
					"run.requested",
					"s",
					{ runId: "reserved", inputId: "input" },
					{ metadata: { runId: "reserved" } },
				),
			]);
			yield* ingress.onSSEEventEffect(
				makeSSEEvent("session.error", {
					sessionID: "s",
					error: {
						name: "UnknownError",
						data: { message: "Provider stopped this session" },
					},
				}),
				"s",
				"opencode",
			);
			expect(
				yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
			).toEqual([
				{ id: "accepted", status: "error" },
				{ id: "reserved", status: "error" },
			]);
			expect(
				yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id, json_extract(data, '$.error') AS reason
			FROM events WHERE type = 'turn.error' ORDER BY run_id`,
			).toEqual([
				{ run_id: "accepted", reason: "Provider stopped this session" },
				{ run_id: "reserved", reason: "Provider stopped this session" },
			]);
			ingress.shutdown();
		}).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);

// A confirmed process exit ends every outstanding reservation, even when the
// session shell was already idle. It never declares an unobserved success.
for (const shellStatus of ["busy", "idle"] as const) {
	it.effect(
		`interrupts all outstanding runs on confirmed instance exit with ${shellStatus} shell`,
		() => {
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
			);
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(
					createSilentLogger(),
				);
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						provider: "opencode",
						title: "Exit",
					}),
					canonicalEvent(
						"run.requested",
						"s",
						{
							runId: "accepted",
							inputId: "u",
						},
						{ metadata: { runId: "accepted" } },
					),
					canonicalEvent(
						"message.created",
						"s",
						{
							sessionId: "s",
							messageId: "u",
							role: "user",
						},
						{ metadata: { runId: "accepted" } },
					),
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: "u", requestedRunId: "accepted" },
						{ metadata: { runId: "accepted" } },
					),
					canonicalEvent(
						"run.requested",
						"s",
						{ runId: "reserved", inputId: "queued" },
						{ metadata: { runId: "reserved" } },
					),
				]);
				yield* sql`UPDATE sessions SET status = ${shellStatus} WHERE id = 's'`;
				yield* ingress.onInstanceStopped("opencode", () => false);
				expect(
					yield* sql`SELECT status FROM provider_runs ORDER BY id`,
				).toEqual([{ status: "running" }, { status: "pending" }]);
				yield* ingress.onInstanceStopped("opencode", () => true);
				expect(
					yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "accepted", status: "interrupted" },
					{ id: "reserved", status: "interrupted" },
				]);
				expect(
					yield* sql`SELECT state FROM turns WHERE run_id = 'accepted'`,
				).toEqual([{ state: "interrupted" }]);
				const terminals =
					yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id,
				json_extract(data, '$.reason') AS reason FROM events WHERE type = 'turn.interrupted' ORDER BY run_id`;
				expect(terminals).toEqual([
					{ run_id: "accepted", reason: "OpenCode instance stopped" },
					{ run_id: "reserved", reason: "OpenCode instance stopped" },
				]);
				yield* ingress.onInstanceStopped("opencode", () => true);
				expect(
					yield* sql`SELECT COUNT(*) AS count FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([{ count: 2 }]);
				ingress.shutdown();
			}).pipe(
				Effect.provide(
					Layer.merge(
						persistence,
						ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
					),
				),
			);
		},
	);
}

// A missing directory-scoped status is not proof of idle. Outstanding accepted
// local runs still need reconciliation when their command already completed.
for (const origin of ["native", "completed-command"] as const) {
	for (const proof of ["missing", "idle", "stopped"] as const) {
		it.effect(
			`reconciles ${origin} startup work only after ${proof} status proof`,
			() => {
				const persistence = makePersistenceEffectLayer(
					":memory:",
					"test-project",
				);
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingress = yield* makeEffectOpenCodeRuntimeIngress(
						createSilentLogger(),
					);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "s", {
							sessionId: "s",
							provider: "opencode",
							title: "Startup",
						}),
						...(origin === "completed-command"
							? [
									canonicalEvent(
										"run.requested",
										"s",
										{ runId: "r", inputId: "input" },
										{ metadata: { runId: "r" } },
									),
								]
							: []),
						canonicalEvent("message.created", "s", {
							sessionId: "s",
							messageId: "input",
							role: "user",
						}),
						canonicalEvent(
							"run.started",
							"s",
							{ inputId: "input", requestedRunId: "r" },
							{ metadata: { runId: "r" } },
						),
					]);
					if (origin === "completed-command")
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
						VALUES (1, 'input', 'test-project', 's', 'opencode', 'send_turn',
						'r', '{"inputId":"input"}', 'completed', 1, 1, 1)`;
					yield* ingress.recoverObservedRuns(() =>
						Effect.succeed(
							proof === "stopped"
								? "stopped"
								: proof === "idle"
									? { s: { type: "idle" } }
									: {},
						),
					);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = 'r'`,
					).toEqual([
						{ status: proof === "missing" ? "running" : "interrupted" },
					]);
					if (origin === "completed-command")
						expect(
							yield* sql`SELECT status FROM provider_command_outbox`,
						).toEqual([{ status: "completed" }]);
					ingress.shutdown();
				}).pipe(
					Effect.provide(
						Layer.merge(
							persistence,
							ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
						),
					),
				);
			},
		);
	}
}

// Recovery must settle a reservation before its echo, and must recognize a
// successful exact-parent reply even when the live run missed its idle event.
for (const state of [
	"no-echo",
	"lost-echo-completed",
	"lost-echo-unfinished",
	"completed",
	"joined-native",
	"aborted-after-tool-step",
	"abort-without-message-end",
	"idle-without-message-end",
	"idle-after-tool-step",
] as const) {
	it.effect(`settles the owned OpenCode run after ${state} daemon loss`, () => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const dependencies = Layer.merge(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		);
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const userId = openCodeInputMessageId("input-1");
			const aborted =
				state === "aborted-after-tool-step" ||
				state === "abort-without-message-end";
			const unfinished =
				state === "idle-without-message-end" ||
				state === "lost-echo-unfinished";
			const echoed =
				state !== "no-echo" &&
				state !== "lost-echo-completed" &&
				state !== "lost-echo-unfinished";
			const failed =
				state === "no-echo" ||
				aborted ||
				unfinished ||
				state === "idle-after-tool-step";
			const history: Message[] =
				state !== "no-echo"
					? [
							{
								id: userId,
								role: "user",
								sessionID: "s",
								time: { created: 10 },
								parts: [{ id: "p-u", type: "text", text: "prompt" }],
							},
							{
								id: "reply",
								role: "assistant",
								sessionID: "s",
								parentID: userId,
								time: {
									created: 11,
									...(unfinished ? {} : { completed: 12 }),
								},
								...(unfinished
									? {}
									: {
											finish:
												aborted || state === "idle-after-tool-step"
													? "tool-calls"
													: "stop",
										}),
								parts: [{ id: "p-a", type: "text", text: "answer" }],
							},
							...(aborted
								? [
										{
											id: "aborted-reply",
											role: "assistant",
											sessionID: "s",
											parentID: userId,
											...(state === "aborted-after-tool-step"
												? { finish: "stop" }
												: {}),
											time: {
												created: 13,
												...(state === "abort-without-message-end"
													? {}
													: { completed: 14 }),
											},
											error: {
												name: "MessageAbortedError",
												data: { message: "The message was aborted" },
											},
											parts: [],
										},
									]
								: []),
						]
					: [];
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
				() => Effect.succeed(history),
			);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.created", "s", {
					sessionId: "s",
					provider: "opencode",
					title: "Recovery",
				}),
				canonicalEvent(
					"run.requested",
					"s",
					{ runId: "r1", inputId: "input-1" },
					{ metadata: { runId: "r1" } },
				),
				...(echoed
					? [
							canonicalEvent(
								"message.created",
								"s",
								{
									sessionId: "s",
									messageId: userId,
									inputId: "input-1",
									role: "user",
								},
								{ metadata: { runId: "r1" } },
							),
							canonicalEvent(
								"run.started",
								"s",
								{ inputId: "input-1", requestedRunId: "r1" },
								{ metadata: { runId: "r1" } },
							),
						]
					: []),
				...(state === "joined-native"
					? [
							canonicalEvent(
								"message.created",
								"s",
								{
									sessionId: "s",
									messageId: "native-user",
									role: "user",
								},
								{ metadata: { runId: "r1" } },
							),
							canonicalEvent(
								"run.started",
								"s",
								{ inputId: "native-user", requestedRunId: "r1" },
								{ metadata: { runId: "r1" } },
							),
						]
					: []),
			]);
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'input-1', 'test-project', 's', 'opencode', 'send_turn',
				'r1', '{"inputId":"input-1"}', 'running', 1, 1, 1)`;
			const commands = yield* runningRunnerCommands(
				sql,
				"opencode",
				() => "opencode",
			);
			const fail = yield* makeFailTurn;
			yield* ingress.recoverCommands(
				commands,
				() =>
					Effect.succeed(
						state === "no-echo" ? "stopped" : { s: { type: "idle" } },
					),
				fail,
			);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'r1'`,
			).toEqual([{ status: failed ? "error" : "completed" }]);
			expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: failed ? "failed" : "completed" },
			]);
			if (state !== "no-echo")
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual(
					Array.from({ length: state === "joined-native" ? 2 : 1 }, () => ({
						state: failed ? "error" : "completed",
						run_id: "r1",
					})),
				);
			if (!echoed)
				expect(
					yield* sql`SELECT started_at FROM turns WHERE user_message_id = ${userId}`,
				).toEqual(state === "no-echo" ? [] : [{ started_at: null }]);
			expect(
				yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events
				WHERE type = ${failed ? "turn.error" : "session.status"}`,
			).toEqual([{ run_id: "r1" }]);
			ingress.shutdown();
		}).pipe(
			Effect.provideService(LoggerTag, createSilentLogger()),
			Effect.provide(dependencies),
		);
	});
}
