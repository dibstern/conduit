#!/usr/bin/env node
import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Deferred, Effect, FiberSet, Scope } from "effect";
import { BUILD_ID } from "../lib/build-id.js";
import {
	type ClaudeSessionRunnerDeps,
	makeClaudeSessionRunner,
} from "../lib/provider/claude/claude-provider-runtime.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	ClaudeRunnerSocket,
	claudeRunnerFailure,
} from "../lib/provider/claude/claude-runner-protocol.js";
import { ClaudeRunnerReattachGrace } from "../lib/provider/claude/claude-runner-reattach-grace.js";
import {
	registerClaudeRunner,
	removeClaudeRunner,
} from "../lib/provider/claude/claude-runner-registry.js";
import { ClaudeRunnerSpool } from "../lib/provider/claude/claude-runner-spool.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionRunner,
} from "../lib/provider/claude/claude-session-runner.js";
import type { TurnResult } from "../lib/provider/types.js";

const main = Effect.gen(function* () {
	const socketPath = process.argv[2];
	const sessionId = process.argv[3];
	const runnerId = process.argv[4];
	if (!socketPath || !sessionId || !runnerId || !process.send)
		return yield* Effect.die(
			"Claude runner requires a socket path and parent IPC",
		);
	const testModule = process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"];
	let queryFactory: ClaudeSessionRunnerDeps["queryFactory"];
	if (process.env["NODE_ENV"] === "test" && testModule) {
		const module = yield* Effect.tryPromise(
			() =>
				import(testModule) as Promise<{
					claudeSdk: {
						query: NonNullable<ClaudeSessionRunnerDeps["queryFactory"]>;
					};
				}>,
		);
		if (typeof module.claudeSdk?.query !== "function")
			return yield* Effect.die(
				"Process test module must export a Claude query factory",
			);
		queryFactory = module.claudeSdk.query;
		const { __setProbeOverrideForTesting } = yield* Effect.tryPromise(
			() => import("../lib/provider/claude/claude-capabilities-probe.js"),
		);
		__setProbeOverrideForTesting(async () => ({
			models: [],
			agents: [],
			commands: [],
		}));
	}
	const stopped = yield* Deferred.make<void>();
	const scope = yield* Effect.scope;
	const runFork = yield* FiberSet.makeRuntime<never, void, never>();
	let attached = false;
	let expiring = false;
	let exitDeadline: ReturnType<typeof setTimeout> | undefined;
	const grace = new ClaudeRunnerReattachGrace(() => {
		expiring = true;
		runFork(Deferred.succeed(stopped, undefined).pipe(Effect.asVoid));
		// SDK disposal must not defeat the orphan deadline.
		exitDeadline = setTimeout(() => {
			removeClaudeRunner(socketPath);
			process.exit(0);
		}, 2000);
		exitDeadline.unref();
	});
	const disconnected = () => {
		if (!attached) grace.disconnected();
	};
	process.once("disconnect", disconnected);
	if (!process.connected) grace.disconnected();
	let connection: ClaudeRunnerSocket | undefined;
	let runner: ClaudeSessionRunner | undefined;
	let shellEnv: Readonly<Record<string, string | undefined>> = process.env;
	let initializing = false;
	const spool = new ClaudeRunnerSpool(`${socketPath}.spool`);
	const bindings = new Map<string, { sessionId: string; commandId?: string }>();
	const commands = new Map<
		string,
		Deferred.Deferred<TurnResult | undefined, ClaudeSessionFailure>
	>();
	const completedCommands = new Map<
		string,
		{ commandId: string; result?: TurnResult; failure?: ClaudeSessionFailure }
	>();
	const server = createServer((socket) => {
		if (connection || expiring) {
			socket.destroy();
			return;
		}
		let greeted = false;
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => {
				if (message.type === "hello") {
					if (
						initializing ||
						!message.config ||
						message.protocolVersion !== CLAUDE_RUNNER_PROTOCOL_VERSION ||
						message.buildId !== BUILD_ID
					) {
						peer.destroy();
						return;
					}
					initializing = true;
					const config = message.config;
					runFork(
						Effect.gen(function* () {
							if (!runner)
								runner = yield* makeClaudeSessionRunner(
									{
										...config,
										shellEnv: () => shellEnv,
										...(queryFactory ? { queryFactory } : {}),
									},
									(output) => spool.emit(output),
								).pipe(Effect.provideService(Scope.Scope, scope));
							greeted = true;
							peer.write({
								type: "hello",
								protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION,
								buildId: BUILD_ID,
								runnerId,
								sessionId,
								pid: process.pid,
								bindings: [...bindings].map(([sinkId, binding]) => ({
									sinkId,
									...binding,
								})),
								pendingOutputs: spool.pendingOutputs,
								completedCommands: [...completedCommands.values()],
							});
							initializing = false;
						}),
					);
				} else if (message.type === "replay") {
					if (
						!greeted ||
						!Number.isSafeInteger(message.acknowledgedSequence) ||
						message.acknowledgedSequence < 0
					) {
						peer.destroy();
						return;
					}
					attached = true;
					grace.reattached();
					spool.attach(peer, message.acknowledgedSequence);
				} else if (message.type === "output-reply") {
					spool.reply(message);
				} else if (message.type === "command" && runner) {
					const command = message.command;
					const deduplicationKey = `${message.commandId}:${message.attempt ?? 0}`;
					if (command.type === "send-turn") {
						shellEnv = command.shellEnv ?? process.env;
						bindings.set(command.sinkId, {
							sessionId: command.input.sessionId,
							...(command.input.commandId !== undefined
								? { commandId: command.input.commandId }
								: {}),
						});
					}
					if (process.env["NODE_ENV"] === "test" && process.connected)
						process.send?.({
							channel: "conduit-process-test",
							kind: "runner-command",
							commandId: message.commandId,
							type: command.type,
						});
					runFork(
						Effect.gen(function* () {
							const existing = commands.get(deduplicationKey);
							if (existing) return yield* Deferred.await(existing);
							const result = yield* Deferred.make<
								TurnResult | undefined,
								ClaudeSessionFailure
							>();
							commands.set(deduplicationKey, result);
							if (!runner)
								return yield* Effect.die("Claude runner is not initialized");
							const exit = yield* Effect.exit(runner.executeEffect(command));
							yield* Deferred.done(result, exit);
							return yield* Deferred.await(result);
						}).pipe(
							Effect.matchCauseEffect({
								onFailure: (cause) =>
									Effect.sync(() => {
										completedCommands.set(message.commandId, {
											commandId: message.commandId,
											failure: claudeRunnerFailure(
												command.type,
												Cause.squash(cause),
											),
										});
										connection?.write({
											type: "command-reply",
											commandId: message.commandId,
											failure: claudeRunnerFailure(
												command.type,
												Cause.squash(cause),
											),
										});
									}),
								onSuccess: (result) =>
									Effect.gen(function* () {
										if (command.type === "shutdown")
											yield* spool
												.drainEffect()
												.pipe(Effect.timeout("500 millis"), Effect.ignore);
										completedCommands.set(message.commandId, {
											commandId: message.commandId,
											...(result ? { result } : {}),
										});
										connection?.write({
											type: "command-reply",
											commandId: message.commandId,
											...(result ? { result } : {}),
										});
										if (command.type === "shutdown")
											runFork(
												Deferred.succeed(stopped, undefined).pipe(
													Effect.asVoid,
												),
											);
									}),
							}),
						),
					);
				}
			},
			() => {
				spool.disconnect(peer);
				if (connection === peer) {
					attached = false;
					connection = undefined;
					grace.disconnected();
				}
			},
		);
		connection = peer;
	});
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			grace.reattached();
			clearTimeout(exitDeadline);
			process.off("disconnect", disconnected);
			connection?.destroy();
			server.close();
			removeClaudeRunner(socketPath);
		}),
	);
	yield* Effect.tryPromise(
		() =>
			new Promise<void>((done, fail) => {
				server.once("error", fail);
				server.listen(socketPath, () => {
					chmodSync(socketPath, 0o600);
					done();
				});
			}),
	);
	registerClaudeRunner({
		socketPath,
		sessionId,
		runnerId,
		buildId: BUILD_ID,
		pid: process.pid,
	});
	process.send({ channel: "conduit-claude-runner", type: "listening" });
	yield* Deferred.await(stopped);
});

NodeRuntime.runMain(Effect.scoped(main));
