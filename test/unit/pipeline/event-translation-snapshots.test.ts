import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";

const SESSION_ID = "ses-snap-1";

describe("RelayEventSink lifecycle", () => {
	it("pending permission resolves through the pending interaction port", async () => {
		let trackedId: string | undefined;
		let repliedId: string | undefined;
		let resolvePermission:
			| ((response: { decision: "once" | "always" | "reject" }) => void)
			| undefined;

		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			pendingInteractions: {
				beginPermissionRequest(entry) {
					trackedId = entry.requestId;
					const promise = new Promise<{
						decision: "once" | "always" | "reject";
					}>((resolve) => {
						resolvePermission = resolve;
					});
					return Effect.succeed({
						awaitResponse: Effect.promise(() => promise),
					});
				},
				resolvePermissionRequest(requestId, response) {
					return Effect.sync(() => {
						repliedId = requestId;
						resolvePermission?.(response);
						return true;
					});
				},
				beginQuestionRequest: () =>
					Effect.succeed({
						awaitAnswers: Effect.succeed({}),
					}),
				resolveQuestionRequest: () => Effect.succeed(true),
			},
		});

		// Request permission — creates pending service entry
		const permissionPromise = Effect.runPromise(
			sink.requestPermission({
				requestId: "perm-1",
				sessionId: SESSION_ID,
				toolName: "bash",
				toolInput: { command: "echo test" },
				turnId: "turn-1",
				providerItemId: "item-1",
				always: [],
			}),
		);

		expect(trackedId).toBe("perm-1");

		await Effect.runPromise(
			sink.resolvePermission("perm-1", { decision: "reject" }),
		);

		const result = await permissionPromise;
		expect(result.decision).toBe("reject");
		expect(repliedId).toBe("perm-1");
	});

	it("cancels service-owned pending interactions through the port", async () => {
		const cancelSessionInteractions = vi.fn(() => Effect.void);
		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			pendingInteractions: {
				beginPermissionRequest: () =>
					Effect.succeed({
						awaitResponse: Effect.succeed({ decision: "reject" }),
					}),
				resolvePermissionRequest: () => Effect.succeed(true),
				beginQuestionRequest: () =>
					Effect.succeed({
						awaitAnswers: Effect.succeed({}),
					}),
				resolveQuestionRequest: () => Effect.succeed(true),
				cancelSessionInteractions,
			},
		});

		await Effect.runPromise(
			sink.cancelSessionInteractions?.("session ended", {
				recoverQuestions: true,
			}) ?? Effect.void,
		);

		expect(cancelSessionInteractions).toHaveBeenCalledWith("session ended", {
			recoverQuestions: true,
		});
	});
});
