// Failure mode: a parent error leaves its active Task running when no completion
// delta arrived, after the legacy metadata outcome flag is retired.
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { CursorTurnEvents } from "../../../../src/lib/provider/cursor/cursor-turn-events.js";
import { createMockEventSink } from "../../../helpers/mock-sdk.js";

it("fails an active Task through the typed tool outcome when its parent fails", async () => {
	const emitted: ProviderRuntimeEvent[] = [];
	const events = new CursorTurnEvents(
		"parent",
		"message",
		{
			...createMockEventSink(),
			push: (event) =>
				Effect.sync(() => {
					emitted.push(event);
				}),
		},
		process.cwd(),
		{ ensure: () => Effect.void },
	);
	await Effect.runPromise(
		events.delta({
			type: "tool-call-started",
			callId: "task",
			toolCall: {
				type: "task",
				args: { description: "Inspect", prompt: "Inspect" },
			},
		}),
	);
	await Effect.runPromise(events.finishChildren("error"));
	const completed = emitted.find((event) => event.type === "tool.completed");
	expect(completed?.data).toMatchObject({ outcome: "failed" });
	expect(completed?.data).not.toHaveProperty("metadata.isError");
	expect(completed?.data).not.toHaveProperty("metadata.outcome");
});

it("retains the failure text in a reconciled child snapshot", async () => {
	const emitted: ProviderRuntimeEvent[] = [];
	const events = new CursorTurnEvents(
		"parent",
		"message",
		{
			...createMockEventSink(),
			push: (event) =>
				Effect.sync(() => {
					emitted.push(event);
				}),
		},
		process.cwd(),
		{ ensure: () => Effect.void },
	);
	await Effect.runPromise(
		events.delta({
			type: "tool-call-completed",
			callId: "task",
			toolCall: {
				type: "task",
				args: {},
				result: {
					status: "success",
					value: {
						isBackground: false,
						conversationSteps: [
							{
								toolCall: {
									toolCallId: "shell",
									shellToolCall: {
										args: { command: "echo hi" },
										result: { rejected: { reason: "Command denied" } },
									},
								},
							},
						],
					},
				},
			},
		}),
	);
	const snapshot = emitted.find((event) => event.type === "message.snapshot");
	expect(snapshot?.type).toBe("message.snapshot");
	expect(snapshot?.data).toMatchObject({
		message: {
			parts: expect.arrayContaining([
				expect.objectContaining({
					type: "tool",
					state: expect.objectContaining({
						status: "error",
						error: "Command denied",
					}),
				}),
			]),
		},
	});
});
