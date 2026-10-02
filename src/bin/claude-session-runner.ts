#!/usr/bin/env node
import { chmodSync, rmSync } from "node:fs";
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
import type { ClaudeSessionRunner } from "../lib/provider/claude/claude-session-runner.js";

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
	let shellEnv: Readonly<Record<string, string | undefined>> = process.env;
	let initializing = false;
	const disconnected = () =>
		runFork(Deferred.succeed(stopped, undefined).pipe(Effect.asVoid));
	process.once("disconnect", disconnected);
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			process.off("disconnect", disconnected);
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
							runner = yield* makeClaudeSessionRunner(
								{
									...config,
									shellEnv: () => shellEnv,
									...(queryFactory ? { queryFactory } : {}),
								},
								(output) => peer.outputEffect(output),
							).pipe(Effect.provideService(Scope.Scope, scope));
							peer.write({
								type: "hello",
								protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION,
								buildId: BUILD_ID,
							});
						}),
					);
				} else if (message.type === "command" && runner) {
					const command = message.command;
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
