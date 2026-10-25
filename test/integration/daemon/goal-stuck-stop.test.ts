// Failure modes: off-by-one verdict counting, synthetic user messages or steers
// resetting the count, progress/user replies not resetting it, waiting for turn
// end inside the bus consumer, duplicate stops/pushes, and missing relay layers.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionInboxTag } from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { notificationContent } from "../../../src/lib/notification-content.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import type { PushPayload } from "../../../src/lib/server/push.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import { createMockQuery, makeErrorResult } from "../../helpers/mock-sdk.js";
import { createTestProjectRelay } from "../../helpers/project-relay.js";

it("stops and pushes after ten live stuck verdicts, restarting the count after user input and progress", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-goal-stuck-stop-"));
	const sessionId = "stuck-goal";
	const nativeId = "sdk-stuck-goal";
	const reason =
		"Release approval is missing; the user must approve the release.";
	const messages: (SDKMessage | undefined)[] = [];
	let wake = () => {};
	let closed = false;
	const emit = (message: SDKMessage | undefined) => {
		messages.push(message);
		wake();
	};
	const interrupt = vi.fn(async () => {});
	const pushes: PushPayload[] = [];
	const logs: unknown[][] = [];
	const log = createSilentLogger();
	log.warn =
		log.error =
		log.info =
		log.debug =
		log.verbose =
			(...args) => {
				logs.push(args);
			};
	log.child = () => log;
	const relay = await createTestProjectRelay({
		httpServer: createServer(),
		persistenceDbPath: join(root, "events.db"),
		projectDir: root,
		configDir: root,
		slug: "goal-stuck-test",
		noServer: true,
		opencodeUrl: "http://127.0.0.1:1",
		publishGlobalSetting: () => Effect.void,
		log,
		pushManager: {
			getPublicKey: () => null,
			addSubscription: () => {},
			removeSubscription: () => {},
			getSubscriptionIds: () => ["device"],
			sendTo: async (_recipientId, payload) => {
				pushes.push(payload);
				return { delivered: ["device"], failed: [], expired: [] };
			},
			sendToAll: async () => {
				throw new Error("Expected per-recipient delivery");
			},
		},
		claudeSdk: {
			...claudeSdk,
			query: ({ prompt }) => {
				logs.push(["query created"]);
				const stream = (async function* () {
					if (typeof prompt === "string")
						throw new Error("Expected prompt stream");
					yield decodeClaudeSDKMessage({
						type: "system",
						subtype: "init",
						uuid: randomUUID(),
						session_id: nativeId,
						apiKeySource: "none",
						claude_code_version: "test",
						cwd: root,
						tools: [],
						mcp_servers: [],
						model: "claude-sonnet-4-6",
						permissionMode: "default",
						slash_commands: [],
						output_style: "default",
						skills: [],
						plugins: [],
					});
					for await (const _input of prompt) {
						while (!closed) {
							if (messages.length === 0)
								await new Promise<void>((resolve) => {
									wake = resolve;
								});
							const message = messages.shift();
							if (!message) return;
							// An interrupt deliberately does not end the turn until the test
							// supplies a result. More verdicts can arrive in the meantime.
							yield message;
							if (message.type === "result") break;
						}
					}
				})();
				return Object.assign(createMockQuery([]), {
					interrupt,
					close: () => {
						closed = true;
						emit(undefined);
					},
					next: stream.next.bind(stream),
					return: stream.return.bind(stream),
					throw: stream.throw.bind(stream),
					[Symbol.asyncIterator]: () => stream,
				});
			},
		},
	});
	const runtime = relay.effectRuntime.runtime;
	const goalPushes = () => pushes.filter((push) => push.type === "goal_stuck");
	const stops = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					command_id: string;
				}>`SELECT json_extract(metadata, '$.commandId') AS command_id
			FROM events WHERE session_id = ${sessionId} AND type = 'interrupt.requested' ORDER BY sequence`;
			}),
		);
	const send = async (text: string) => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const turns = yield* Effect.serviceOption(ProviderTurnServiceTag);
				const inbox = yield* Effect.serviceOption(SessionInboxTag);
				if (inbox._tag === "None" || turns._tag === "None")
					return yield* Effect.die("Missing relay inbox/turn service");
				const inputId = randomUUID();
				yield* turns.value
					.prepareTurnSession({
						clientId: "test",
						commandId: inputId,
						sessionId,
					})
					.pipe(Effect.provideService(SessionInboxTag, inbox.value));
				return yield* inbox.value.submit({
					clientId: "test",
					inputId,
					sessionId,
					delivery: "queue",
					request: { text },
				});
			}),
		);
	};
	const finishStop = async () => {
		emit(
			decodeClaudeSDKMessage(
				makeErrorResult({ session_id: nativeId, uuid: randomUUID() }),
			),
		);
		await vi.waitFor(async () => {
			const [row] = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql<{
						status: string;
					}>`SELECT status FROM sessions WHERE id = ${sessionId}`;
				}),
			);
			expect(row?.status).toBe("idle");
		});
	};
	let iteration = 0;
	let stuck = false;
	const verdict = async (lastReason = reason) => {
		iteration++;
		emit({
			type: "active_goal",
			uuid: randomUUID(),
			session_id: nativeId,
			value: {
				condition: "Publish the release",
				set_at: 100,
				tokens_at_start: 0,
				iterations: iteration,
				last_reason: lastReason,
			},
		});
		await vi.waitFor(
			async () => {
				const [row] = await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{
							iterations: number;
							goal_stuck: string | null;
						}>`SELECT
					json_extract(goal_state, '$.goal.iterations') AS iterations, goal_stuck FROM sessions WHERE id = ${sessionId}`;
					}),
				);
				expect(row?.iterations).toBe(iteration);
				stuck = row?.goal_stuck != null;
			},
			{ interval: 5, timeout: 5000 },
		);
		// Drain the post-commit subscriber before making a negative assertion.
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	};
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* SessionManagerServiceTag).createSession("Stuck goal", {
					sessionId,
					pick: {
						harness: "claude",
						model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
						effort: "",
						contextWindow: "",
					},
				});
			}),
		);
		await send("Publish the release");
		let counted = 0;
		while (counted < 9) {
			await verdict();
			if (stuck) counted++;
			if (counted === 5)
				await runtime.runPromise(
					Effect.gen(function* () {
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent("message.created", sessionId, {
								sessionId,
								messageId: "synthetic",
								role: "user",
							}),
							canonicalEvent("input.sent", sessionId, {
								sessionId,
								inputId: "steer",
								steer: true,
							}),
						]);
					}),
				);
		}
		expect(await stops()).toEqual([]);
		await verdict();
		await vi.waitFor(async () => expect(await stops()).toHaveLength(1));
		const [trigger] = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					event_id: string;
				}>`SELECT event_id FROM events WHERE session_id = ${sessionId}
				AND type = 'session.goal_changed' ORDER BY sequence DESC LIMIT 1`;
			}),
		);
		const originId = `goal-stuck:${trigger?.event_id}`;
		expect(await stops()).toEqual([{ command_id: originId }]);
		await vi.waitFor(() =>
			expect(goalPushes()).toEqual([
				expect.objectContaining({
					title: "Goal waiting on you",
					body: reason,
					tag: "opencode-done",
					alertId: originId,
					sessionId,
				}),
			]),
		);
		for (let n = 0; n < 5; n++) await verdict();
		expect(await stops()).toHaveLength(1);
		expect(interrupt).toHaveBeenCalledTimes(1);
		expect(goalPushes()).toHaveLength(1);
		await finishStop();
		await send("Approval is still pending; check again");
		for (let n = 0; n < 9; n++) await verdict();
		expect(await stops()).toHaveLength(1);
		await verdict();
		await vi.waitFor(async () => expect(await stops()).toHaveLength(2));
		await finishStop();
		await send("Continue verifying deployment");
		for (let n = 0; n < 5; n++) await verdict();
		const progress =
			"Approval arrived. Deployment verification is now failing; rebuild the artifact.";
		await verdict(progress);
		expect(stuck).toBe(false);
		counted = 0;
		while (counted < 9) {
			await verdict(progress);
			if (stuck) counted++;
		}
		expect(await stops()).toHaveLength(2);
		await verdict(progress);
		await vi.waitFor(async () => expect(await stops()).toHaveLength(3));
		await vi.waitFor(() => expect(goalPushes()).toHaveLength(3));
		const receipts = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql`SELECT alert_key, anchor, state FROM sent_alerts WHERE session_id = ${sessionId}
				AND alert_key LIKE '%goal_stuck%' ORDER BY sent_at`;
			}),
		);
		expect(receipts).toHaveLength(3);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/goal-stuck-stop.json",
			JSON.stringify(
				{ stops: await stops(), pushes: goalPushes(), receipts },
				null,
				2,
			),
		);
	} finally {
		mkdirSync("test-results", { recursive: true });
		const events = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql`SELECT type, data FROM events WHERE session_id = ${sessionId} ORDER BY sequence DESC LIMIT 15`;
			}),
		);
		writeFileSync(
			"test-results/goal-stuck-stop-events.json",
			JSON.stringify({ events, logs }, null, 2),
		);
		closed = true;
		emit(undefined);
		await relay.stop();
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	}
}, 30_000);

it.each([
	{ reason: "", body: "The goal keeps asking to continue. Reply to resume." },
	{ reason: "x".repeat(200), body: `${"x".repeat(139)}…` },
])("formats a goal stuck notification with reason length $reason.length", ({
	reason,
	body,
}) => {
	expect(
		notificationContent({
			_tag: "goal_stuck",
			sessionId: "session",
			originId: "stop",
			reason,
		}),
	).toEqual({
		title: "Goal waiting on you",
		body,
		tag: "opencode-done",
	});
});
