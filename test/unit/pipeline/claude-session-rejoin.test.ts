import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const SESSION_ID = "ses-rejoin-1";

describe("Claude session processing timeout", () => {
	it("clears PROCESSING_TIMEOUT after a provider error", async () => {
		let timeoutCleared = false;

		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			clearTimeout: () => {
				timeoutCleared = true;
			},
		});

		// Start streaming
		await Effect.runPromise(
			sink.push(
				providerRuntimeEvent("text.delta", SESSION_ID, {
					messageId: "msg-1",
					partId: "p1",
					text: "streaming...",
				}),
			),
		);

		// Simulate turn completing with error (as PROCESSING_TIMEOUT would trigger)
		await Effect.runPromise(
			sink.push(
				providerRuntimeEvent("turn.error", SESSION_ID, {
					messageId: "msg-1",
					error: "Processing timeout",
					code: "PROCESSING_TIMEOUT",
				}),
			),
		);

		// Timeout should have been cleared
		expect(timeoutCleared).toBe(true);
	});
});

describe("Claude session rejoin — delivery-layer specs (TODO)", () => {
	it.todo("thinking block started before navigate-away completes after return");
	// If a thinking block starts, user navigates away, thinking ends
	// while away, text starts, user returns — the text deltas emitted
	// after return should stream to the client.

	it.todo("permission approval after rejoin resumes streaming");
	// If Claude asks permission, user navigates away, returns, approves
	// the (rehydrated) permission — streaming should resume with the
	// SDK's continued output.
});
