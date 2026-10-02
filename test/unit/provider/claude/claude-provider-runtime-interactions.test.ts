import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeProviderRuntime,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import type {
	PermissionResult,
	Options as SDKOptions,
} from "../../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

const capabilitiesService = {
	get: () =>
		Effect.fail(
			new ClaudeBoundaryError({
				operation: "probeCapabilities",
				cause: new Error("No live SDK in interaction tests"),
			}),
		),
};

function toolQuery(run: (options: SDKOptions, turn: number) => Promise<void>) {
	const query = createMockQuery([]);
	const factory = vi.fn(
		({
			prompt,
			options,
		}: Parameters<
			NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
		>[0]) => {
			const stream = (async function* () {
				let turn = 0;
				for await (const _message of prompt) {
					if (!options) throw new Error("Missing SDK options");
					await run(options, ++turn);
					yield makeSuccessResult();
				}
			})();
			return Object.assign(query, { [Symbol.asyncIterator]: () => stream });
		},
	);
	return { query, factory };
}

describe("Claude runner interaction transport", () => {
	it.each([
		"Bash",
		"AskUserQuestion",
	])("returns denial and completes the turn when the %s interaction dies", async (toolName) => {
		const permissions: Array<PermissionResult | null> = [];
		const { factory } = toolQuery(async (options) => {
			if (!options.canUseTool || !options.abortController)
				throw new Error("Missing SDK permission bridge");
			permissions.push(
				await options.canUseTool(
					toolName,
					{ command: "pwd", questions: [{ question: "Continue?" }] },
					{
						signal: options.abortController.signal,
						toolUseID: "tool-1",
						requestId: "request-1",
					},
				),
			);
		});
		const sink = createMockEventSink();
		sink.requestPermission = () => Effect.die(new Error("permission defect"));
		sink.requestQuestion = () => Effect.die(new Error("question defect"));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Effect.promise(() =>
						vi.waitFor(() => expect(permissions).toHaveLength(1)),
					);
					expect(permissions[0]).toMatchObject({ behavior: "deny" });
					expect((yield* Fiber.join(turn)).status).toBe("completed");
				}),
			),
		);
	});

	it.each([
		"interrupt",
		"shutdown",
	])("continues %s teardown when the cancellation hook throws", async (operation) => {
		const requested = await Effect.runPromise(Deferred.make<void>());
		const { query, factory } = toolQuery(async (options) => {
			if (!options.canUseTool || !options.abortController)
				throw new Error("Missing SDK permission bridge");
			await options.canUseTool(
				"Bash",
				{ command: "pwd" },
				{
					signal: options.abortController.signal,
					toolUseID: "tool-1",
					requestId: "request-1",
				},
			);
		});
		const sink = createMockEventSink();
		sink.requestPermission = () =>
			Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
		sink.cancelSessionInteractions = () => {
			throw new Error("cancellation hook defect");
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Deferred.await(requested);
					yield* operation === "interrupt"
						? runtime.interruptTurnEffect("session-1")
						: runtime.shutdownEffect();
					expect(query.interrupt).toHaveBeenCalledOnce();
					if (operation === "interrupt") {
						expect((yield* Fiber.join(turn)).status).toBe("interrupted");
					} else {
						const exit = yield* Fiber.await(turn);
						expect(Exit.isFailure(exit)).toBe(true);
						if (Exit.isFailure(exit)) {
							expect(Cause.pretty(exit.cause)).toContain(
								"Provider instance shutting down",
							);
						}
					}
				}),
			),
		);
	});

	it.each([
		"Bash",
		"AskUserQuestion",
	])("cancels the relay's %s wait when the SDK aborts, before a warm retry", async (toolName) => {
		const requested = await Effect.runPromise(Deferred.make<void>());
		const abort = new AbortController();
		const finalized = vi.fn();
		const { factory } = toolQuery(async (options, turn) => {
			if (turn !== 1) return;
			if (!options.canUseTool) throw new Error("Missing SDK permission bridge");
			await options.canUseTool(
				toolName,
				{ command: "pwd", questions: [{ question: "Continue?" }] },
				{
					signal: abort.signal,
					toolUseID: "tool-1",
					requestId: "request-1",
				},
			);
		});
		const sink = createMockEventSink();
		const wait = () =>
			Deferred.succeed(requested, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.sync(finalized)),
			);
		sink.requestPermission = wait;
		sink.requestQuestion = wait;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Deferred.await(requested);
					abort.abort();
					expect((yield* Fiber.join(turn)).status).toBe("completed");
					expect(
						(yield* runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								turnId: "turn-2",
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						)).status,
					).toBe("completed");
					expect(factory).toHaveBeenCalledOnce();
					expect(finalized).toHaveBeenCalledOnce();
				}),
			),
		);
	});
});
