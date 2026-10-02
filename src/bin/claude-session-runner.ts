#!/usr/bin/env node
import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Deferred, Effect, FiberSet, Scope } from "effect";
import { BUILD_ID } from "../lib/build-id.js";
import { createLogger } from "../lib/logger.js";
import {
	type ClaudeSessionRunnerDeps,
	makeClaudeSessionRunner,
} from "../lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeRunnerIdleExit } from "../lib/provider/claude/claude-runner-idle.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	ClaudeRunnerSocket,
	claudeRunnerFailure,
	claudeRunnerHelloFailure,
	claudeRunnerIdleFailure,
} from "../lib/provider/claude/claude-runner-protocol.js";
import type { ClaudeSessionRunner } from "../lib/provider/claude/claude-session-runner.js";

const log = createLogger("claude-session-runner");

const main = Effect.gen(function* () {
	const socketPath = process.argv[2];
	if (!socketPath || !process.send)
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
	let connection: ClaudeRunnerSocket | undefined;
	let runner: ClaudeSessionRunner | undefined;
	let idle: ReturnType<typeof makeClaudeRunnerIdleExit> | undefined;
	let shellEnv: Readonly<Record<string, string | undefined>> = process.env;
	let initializing = false;
	let exiting = false;
	const disconnected = () =>
		runFork(Deferred.succeed(stopped, undefined).pipe(Effect.asVoid));
	process.once("disconnect", disconnected);
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			process.off("disconnect", disconnected);
			idle?.close();
		}),
	);
	const server = createServer((socket) => {
		if (connection) {
			socket.destroy();
			return;
		}
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => {
				if (message.type === "idle-exit-ack" && exiting) {
					finishIdleExit();
					return;
				}
				if (message.type === "hello") {
					const failure =
						claudeRunnerHelloFailure(message, "server") ??
						(initializing || !message.config
							? claudeRunnerFailure(
									"runner hello",
									"Claude runner refused invalid or repeated server hello",
								)
							: undefined);
					if (failure) {
						log.error(failure.message);
						peer.refuse(failure);
						return;
					}
					initializing = true;
					const config = message.config;
					if (!config) return;
					runFork(
						Effect.gen(function* () {
							runner = yield* makeClaudeSessionRunner(
								{
									...config,
									shellEnv: () => shellEnv,
									...(queryFactory ? { queryFactory } : {}),
								},
								(output) => {
									idle?.activity(output);
									return peer.outputEffect(output);
								},
							).pipe(Effect.provideService(Scope.Scope, scope));
							const testIdle =
								process.env["NODE_ENV"] === "test"
									? process.env["CONDUIT_TEST_RUNNER_IDLE_MS"]
									: undefined;
							idle = makeClaudeRunnerIdleExit(
								() => {
									exiting = true;
									peer.write({ type: "idle-exit" });
									if (process.env["NODE_ENV"] === "test" && process.connected)
										process.send?.({
											channel: "conduit-process-test",
											kind: "runner-idle-exit-started",
											pid: process.pid,
										});
								},
								testIdle === "null"
									? null
									: testIdle !== undefined
										? Number(testIdle)
										: undefined,
								process.env["NODE_ENV"] === "test" &&
									process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"]
									? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"])
									: undefined,
							);
							if (
								process.env["NODE_ENV"] === "test" &&
								process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]
							) {
								process.send?.({
									channel: "conduit-process-test",
									kind: "runner-hello-pending",
									pid: process.pid,
								});
								yield* Effect.sleep(
									Number(process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]),
								);
							}
							peer.write({
								type: "hello",
								protocolVersion:
									process.env["NODE_ENV"] === "test" &&
									process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"]
										? Number(process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"])
										: CLAUDE_RUNNER_PROTOCOL_VERSION,
								buildId: BUILD_ID,
							});
						}),
					);
				} else if (message.type === "command" && runner) {
					const command = message.command;
					if (exiting) {
						peer.write({
							type: "command-reply",
							commandId: message.commandId,
							failure: claudeRunnerIdleFailure(),
						});
						return;
					}
					if (command.type === "send-turn")
						peer.write({
							type: "command-accepted",
							commandId: message.commandId,
							sinkId: command.sinkId,
						});
					idle?.activity();
					if (command.type === "send-turn") idle?.beginTurn();
					if (command.type === "send-turn" || command.type === "pre-warm")
						shellEnv = command.shellEnv ?? process.env;
					if (process.env["NODE_ENV"] === "test" && process.connected)
						process.send?.({
							channel: "conduit-process-test",
							kind: "runner-command",
							commandId: message.commandId,
							type: command.type,
						});
					runFork(
						runner.executeEffect(command).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									if (command.type === "send-turn") idle?.endTurn();
								}),
							),
							Effect.matchCauseEffect({
								onFailure: (cause) =>
									Effect.sync(() =>
										peer.write({
											type: "command-reply",
											commandId: message.commandId,
											failure: claudeRunnerFailure(
												command.type,
												Cause.squash(cause),
											),
										}),
									),
								onSuccess: (result) =>
									Effect.sync(() =>
										peer.write({
											type: "command-reply",
											commandId: message.commandId,
											...(result ? { result } : {}),
										}),
									),
							}),
						),
					);
				}
			},
			disconnected,
		);
		connection = peer;
		function finishIdleExit() {
			const delay =
				process.env["NODE_ENV"] === "test"
					? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_EXIT_DELAY_MS"] ?? 0)
					: 0;
			runFork(
				Effect.sleep(delay).pipe(
					Effect.andThen(Deferred.succeed(stopped, undefined)),
					Effect.asVoid,
				),
			);
		}
	});
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			connection?.destroy();
			server.close();
			rmSync(socketPath, { force: true });
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
	process.send({ channel: "conduit-claude-runner", type: "listening" });
	if (!process.connected) disconnected();
	yield* Deferred.await(stopped);
});

NodeRuntime.runMain(Effect.scoped(main));
