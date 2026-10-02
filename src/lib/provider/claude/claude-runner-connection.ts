import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { Cause, Deferred, Effect } from "effect";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	type ClaudeRunnerHello,
	ClaudeRunnerSocket,
	claudeRunnerBuildId,
	claudeRunnerFailure,
	claudeRunnerHelloFailure,
} from "./claude-runner-protocol.js";
import {
	currentClaudeRunnerOutput,
	type makeClaudeRunnerReceiptStore,
} from "./claude-runner-receipts.js";
import type { ClaudeRunnerUpgradeState } from "./claude-runner-upgrade.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
} from "./claude-session-runner.js";

type ReceiptStore = Effect.Effect.Success<
	ReturnType<typeof makeClaudeRunnerReceiptStore>
>;

/** A verified attachment is the only authority to signal a discovered PID. */
export const connectClaudeRunner = (options: {
	readonly socketPath: string;
	readonly sessionId: string;
	readonly runnerId: string;
	readonly pid?: number;
	readonly helloTimeoutMs?: number;
	readonly preserveRole?: boolean;
	readonly deps: ClaudeSessionRunnerDeps;
	readonly receipts?: ReceiptStore;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
	readonly emit: (
		output: ClaudeSessionOutput,
		sessionId: string,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>;
	readonly onHello: (
		hello: ClaudeRunnerHello,
		connection: ClaudeRunnerSocket,
	) => Effect.Effect<void, ClaudeSessionFailure>;
	readonly onClose: (failure: ClaudeSessionFailure) => void;
	readonly onIdleExit?: () => void;
	readonly onCommandAccepted?: (sinkId: string) => void;
	readonly onUpgradeState?: (state: ClaudeRunnerUpgradeState) => void;
}) =>
	Effect.gen(function* () {
		const outputLock = yield* Effect.makeSemaphore(1);
		const attachmentId = randomUUID();
		let acknowledged = 0;
		let lastReply: ClaudeSessionOutputReply = {};
		let heldAck = false;
		return yield* Effect.async<ClaudeRunnerSocket, ClaudeSessionFailure>(
			(resume) => {
				let settled = false;
				let active = true;
				let greeted = false;
				let resyncScheduled = false;
				let resyncFailures = 0;
				const socket = createConnection(options.socketPath);
				const finish = (
					effect: Effect.Effect<ClaudeRunnerSocket, ClaudeSessionFailure>,
				) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resume(effect);
				};
				const timer = setTimeout(() => {
					finish(
						Effect.fail(
							claudeRunnerFailure(
								"runner hello",
								"Claude runner handshake timed out",
							),
						),
					);
					connection.destroy();
				}, options.helloTimeoutMs ?? 2000);
				const connection = new ClaudeRunnerSocket(
					socket,
					(message) => {
						if (message.type === "upgrade-state") {
							options.onUpgradeState?.(message.state);
							return;
						}
						if (message.type === "idle-exit") {
							options.onIdleExit?.();
							connection.write({ type: "idle-exit-ack" });
							return;
						}
						if (message.type === "command-accepted") {
							options.onCommandAccepted?.(message.sinkId);
							return;
						}
						if (message.type === "refused") {
							finish(Effect.fail(message.failure));
							options.onClose(message.failure);
							connection.destroy();
							return;
						}
						if (message.type === "hello") {
							if (greeted) return;
							const helloFailure = claudeRunnerHelloFailure(message, "runner");
							if (
								helloFailure ||
								message.runnerId !== options.runnerId ||
								message.sessionId !== options.sessionId ||
								(options.pid !== undefined && message.pid !== options.pid)
							) {
								finish(
									Effect.fail(
										helloFailure ??
											claudeRunnerFailure(
												"runner hello",
												"Claude runner identity/protocol/build mismatch",
											),
									),
								);
								connection.destroy();
								return;
							}
							greeted = true;
							options.runFork(
								Effect.gen(function* () {
									const cursor = options.receipts
										? yield* options.receipts
												.attach(options.runnerId, attachmentId)
												.pipe(
													Effect.mapError((cause) =>
														claudeRunnerFailure("attach runner", cause),
													),
												)
										: { sequence: 0, result: {} };
									acknowledged = cursor.sequence;
									lastReply = cursor.result;
									const restored = options.receipts
										? {
												runnerId: options.runnerId,
												sequence: acknowledged,
												attachmentId,
												committed: yield* Deferred.make<void>(),
												consumed: true,
											}
										: undefined;
									if (restored)
										yield* Deferred.succeed(restored.committed, undefined);
									// Restored interaction fibers inherit the new attachment's fence,
									// without advancing an output sequence already acknowledged.
									yield* options
										.onHello(
											{ ...message, acknowledgedSequence: acknowledged },
											connection,
										)
										.pipe(Effect.locally(currentClaudeRunnerOutput, restored));
								}).pipe(
									Effect.matchCauseEffect({
										onFailure: (cause) =>
											Effect.sync(() => {
												finish(
													Effect.fail(
														claudeRunnerFailure(
															"restore runner",
															Cause.squash(cause),
														),
													),
												);
												connection.destroy();
											}),
										onSuccess: () =>
											Effect.sync(() => {
												connection.write({
													type: "replay",
													acknowledgedSequence: acknowledged,
													...(options.preserveRole
														? { preserveRole: true }
														: {}),
												});
												finish(Effect.succeed(connection));
											}),
									}),
								),
							);
						} else if (message.type === "output") {
							let replied = false;
							const reply = (result: ClaudeSessionOutputReply) => {
								if (replied || !active) return;
								replied = true;
								if (
									!heldAck &&
									process.env["NODE_ENV"] === "test" &&
									message.output.type === "event" &&
									message.output.event.type ===
										process.env["CONDUIT_TEST_HOLD_RUNNER_ACK"]
								) {
									heldAck = true;
									return;
								}
								connection.write({
									type: "output-reply",
									outputId: message.outputId,
									sequence: message.sequence,
									result,
								});
							};
							options.runFork(
								outputLock
									.withPermits(1)(
										Effect.gen(function* () {
											if (!active) return {};
											const sequence = message.sequence;
											if (
												sequence === undefined ||
												!Number.isSafeInteger(sequence) ||
												sequence < 1
											)
												return yield* Effect.fail(
													claudeRunnerFailure(
														"runner output",
														"Missing runner sequence",
													),
												);
											if (sequence <= acknowledged) {
												if (
													options.receipts &&
													(message.output.type === "read-turn-history" ||
														message.output.type === "materialize-subagents")
												)
													return yield* options.receipts
														.replyAt(options.runnerId, sequence)
														.pipe(
															Effect.mapError((cause) =>
																claudeRunnerFailure("read runner reply", cause),
															),
														);
												return sequence === acknowledged ? lastReply : {};
											}
											if (sequence !== acknowledged + 1)
												return yield* Effect.fail(
													claudeRunnerFailure(
														"runner output",
														"Non-contiguous runner output",
													),
												);
											const committed = yield* Deferred.make<void>();
											if (
												process.env["NODE_ENV"] === "test" &&
												process.env["CONDUIT_TEST_HOLD_RUNNER_OUTPUT"] ===
													message.output.type
											) {
												const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
												if (proof)
													appendFileSync(
														proof,
														`${JSON.stringify({ kind: "held-output", type: message.output.type, sequence })}\n`,
													);
												yield* Effect.never;
											}
											const receipt = {
												runnerId: options.runnerId,
												sequence,
												attachmentId,
												committed,
												consumed: false,
												onCommitted:
													message.output.type === "event" &&
													message.output.event.type === "turn.completed"
														? () => {
																// The SDK may settle the completed turn once its event and
																// cursor are durable; publication still holds outputLock.
																acknowledged = sequence;
																lastReply = {};
																reply({});
															}
														: undefined,
											};
											const result = yield* options
												.emit(message.output, options.sessionId)
												.pipe(
													Effect.locally(
														currentClaudeRunnerOutput,
														options.receipts ? receipt : undefined,
													),
												);
											if (options.receipts) {
												// Interaction routing forks its waiter. Wait for the ask's actual
												// durable commit before acknowledging that output.
												if (
													message.output.type === "permission-request" ||
													message.output.type === "question-request"
												)
													yield* Deferred.await(committed);
												else if (
													!receipt.consumed ||
													result.history !== undefined ||
													result.children !== undefined
												)
													yield* options.receipts
														.acknowledge(
															options.runnerId,
															sequence,
															result,
															attachmentId,
														)
														.pipe(
															Effect.mapError((cause) =>
																claudeRunnerFailure(
																	"acknowledge runner",
																	cause,
																),
															),
														);
											}
											acknowledged = sequence;
											lastReply = result;
											return result;
										}),
									)
									.pipe(
										Effect.matchCauseEffect({
											onFailure: (cause) =>
												Effect.suspend(() => {
													if (
														!active ||
														resyncScheduled ||
														Cause.isInterruptedOnly(cause)
													)
														return Effect.void;
													// Keep the runner's waiter pending and replay from the durable
													// boundary. Coalesce failures and back off persistent write errors.
													resyncScheduled = true;
													const delay = Math.min(
														1000,
														25 * 2 ** Math.min(resyncFailures++, 6),
													);
													return Effect.sleep(delay).pipe(
														Effect.zipRight(
															Effect.sync(() => {
																resyncScheduled = false;
																if (active)
																	connection.write({
																		type: "replay",
																		acknowledgedSequence: acknowledged,
																	});
															}),
														),
													);
												}),
											onSuccess: (result) =>
												Effect.sync(() => {
													resyncFailures = 0;
													reply(result);
												}),
										}),
									),
							);
						}
					},
					(failure) => {
						active = false;
						finish(Effect.fail(failure));
						options.onClose(failure);
					},
				);
				socket.once("connect", () =>
					connection.write({
						type: "hello",
						protocolVersion:
							process.env["NODE_ENV"] === "test" &&
							process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"]
								? Number(process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"])
								: CLAUDE_RUNNER_PROTOCOL_VERSION,
						buildId: claudeRunnerBuildId(),
						acknowledgedSequence: acknowledged,
						config: {
							workspaceRoot: options.deps.workspaceRoot,
							...(options.deps.daemonConfigDir !== undefined
								? { daemonConfigDir: options.deps.daemonConfigDir }
								: {}),
							materializeSubagents: options.deps.materializeSubagents ?? false,
							...(options.deps.subagentPollTimeoutMs !== undefined
								? { subagentPollTimeoutMs: options.deps.subagentPollTimeoutMs }
								: {}),
						},
					}),
				);
				return Effect.sync(() => {
					clearTimeout(timer);
					connection.destroy();
				});
			},
		);
	});

import { randomUUID } from "node:crypto";
