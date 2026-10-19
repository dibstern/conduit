import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

describe("Claude accepted run ownership", () => {
	it("Stop during query setup ends the exact reservation without accepting it", async () => {
		const setup = Effect.runSync(Deferred.make<void>());
		const streamEnd = Effect.runSync(Deferred.make<void>());
		const events: ProviderRuntimeEvent[] = [];
		let busyCount = 0;
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.gen(function* () {
				events.push(event);
				if (event.type === "session.status" && ++busyCount === 2)
					yield* Deferred.await(setup);
			});
		const query = Object.assign(createMockQuery([]), {
			interrupt: vi.fn(async () => {
				Effect.runSync(Deferred.succeed(streamEnd, undefined));
			}),
			[Symbol.asyncIterator]: () =>
				(async function* () {
					await Effect.runPromise(Deferred.await(streamEnd));
					yield makeSuccessResult();
				})(),
		});
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp",
			queryFactory: () => query,
		});
		const send = Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "setup-stop",
					inputId: "setup-input",
					runId: "setup-run",
					eventSink: sink,
					model: { providerId: "claude", modelId: "claude-fable-5" },
				}),
			),
		);
		try {
			await vi.waitFor(() => expect(busyCount).toBe(2));
			const stop = Effect.runPromise(
				instance.interruptTurnEffect("setup-stop"),
			);
			// Let Stop reach the setup lock before making the query available.
			await new Promise<void>((resolve) => setImmediate(resolve));
			Effect.runSync(Deferred.succeed(setup, undefined));
			await stop;
			await vi.waitFor(() =>
				expect(
					events.filter((event) => event.type === "turn.interrupted"),
				).toEqual([
					expect.objectContaining({
						runId: "setup-run",
						data: expect.objectContaining({ userMessageId: "setup-input" }),
					}),
				]),
			);
			expect(events.some((event) => event.type === "run.started")).toBe(false);
			expect(await send).toMatchObject({ status: "interrupted" });
		} finally {
			Effect.runSync(Deferred.succeed(setup, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await send.catch(() => undefined);
		}
	});

	it("names the existing user message when a continuation is accepted", async () => {
		const inputId = "11111111-1111-4111-8111-111111111111";
		const sink = createMockEventSink();
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp",
			queryFactory: () =>
				createMockQuery([
					{
						type: "command_lifecycle",
						command_uuid: inputId,
						state: "started",
						session_id: "continuation-sdk",
						uuid: "00000000-0000-0000-0000-000000000001",
					},
					makeSuccessResult(),
				]),
		});
		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					inputId,
					runId: "continuation-run",
					continuation: { cutOffMessageId: "old-input" },
					eventSink: sink,
					model: { providerId: "claude", modelId: "claude-fable-5" },
				}),
			),
		);
		expect(sink.push).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "run.started",
				runId: "continuation-run",
				data: {
					inputId,
					requestedRunId: "continuation-run",
					userMessageId: "old-input",
				},
			}),
		);
	});
	it.each([
		["steer-during-tool-folds.jsonl", false, ["run-a", "run-a"], ["run-a"]],
		[
			"steer-misses-boundary.jsonl",
			false,
			["run-a", "run-b"],
			["run-a", "run-b"],
		],
		[
			"steer-misses-boundary.jsonl",
			true,
			["run-a", "run-b"],
			["run-a", "run-b"],
		],
	])("keeps the terminal event with its run in %s with delayed snapshot=%s", async (file, delayedSnapshot, owners, terminals) => {
		const messages = readFileSync(
			join(import.meta.dirname, "../../../fixtures/claude-sdk-traces", file),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => decodeClaudeSDKMessage(JSON.parse(line)) as SDKMessage);
		const inputIds = [
			...new Set(
				messages.flatMap((message) =>
					message.type === "command_lifecycle" ? [message.command_uuid] : [],
				),
			),
		];
		const events: ProviderRuntimeEvent[] = [];
		const previousAnswer = messages.find(
			(message) => message.type === "assistant",
		);
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.sync(() => {
				events.push(event);
			});
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp",
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const prompts = prompt[Symbol.asyncIterator]();
				const stream = (async function* () {
					for (const message of messages) {
						if (
							message.type === "command_lifecycle" &&
							message.state === "queued"
						)
							await prompts.next();
						yield message;
						if (
							delayedSnapshot &&
							previousAnswer &&
							message.type === "command_lifecycle" &&
							message.state === "started" &&
							message.command_uuid === inputIds[1]
						)
							yield previousAnswer;
					}
				})();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () => stream,
				});
			},
		});
		const send = (inputId: string, runId: string) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "run-ownership-replay",
						inputId,
						...{ runId },
						workspaceRoot: "/tmp",
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
					}),
				),
			);
		const [firstInput, secondInput] = inputIds;
		if (!firstInput || !secondInput)
			throw new Error("Expected two recorded inputs");
		const first = send(firstInput, "run-a");
		await vi.waitFor(() =>
			expect(events.some((event) => event.type === "message.created")).toBe(
				true,
			),
		);
		const second = send(secondInput, "run-b");
		await Promise.all([first, second]);
		const accepted = events.filter((event) => event.type === "run.started");
		expect(accepted.map((event) => Reflect.get(event, "runId"))).toEqual(
			owners,
		);
		expect(accepted.map((event) => event.data)).toEqual(
			inputIds.map((inputId, index) => ({
				inputId,
				requestedRunId: index === 0 ? "run-a" : "run-b",
			})),
		);
		expect(
			events
				.filter((event) => event.type === "turn.completed")
				.map((event) => Reflect.get(event, "runId")),
		).toEqual(terminals);
		for (const event of events.filter(
			(event) => event.type === "message.created",
		)) {
			expect(Reflect.get(event, "runId")).toBeDefined();
			expect(Reflect.get(event.data as object, "parentID")).toBeDefined();
		}
		if (delayedSnapshot && previousAnswer) {
			const messageId = previousAnswer.message.id ?? previousAnswer.uuid;
			for (const event of events.filter(
				(event) =>
					!event.type.startsWith("turn.") &&
					typeof event.data === "object" &&
					event.data !== null &&
					Reflect.get(event.data, "messageId") === messageId,
			))
				expect(event.runId, event.type).toBe("run-a");
		}
	});
});
