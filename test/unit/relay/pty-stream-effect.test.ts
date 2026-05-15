// ─── PTY Stream Effect Tests ─────────────────────────────────────────────────
// Tests for the Effect.Stream-based PTY upstream WebSocket implementation.

import { Duration, Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	PtyConnectionError,
	PtyConnectionTimeout,
	type PtyEvent,
} from "../../../src/lib/domain/relay/Services/pty-stream.js";

describe("PTY Stream Effect", () => {
	it("PtyConnectionTimeout has correct tag", () => {
		const err = new PtyConnectionTimeout({});
		expect(err._tag).toBe("PtyConnectionTimeout");
	});

	it("PtyConnectionError wraps cause", () => {
		const err = new PtyConnectionError({ cause: new Error("ws failed") });
		expect(err._tag).toBe("PtyConnectionError");
	});

	it("timeout produces PtyConnectionTimeout on stale stream", async () => {
		const neverStream = Stream.never as Stream.Stream<PtyEvent, never>;
		const exit = await Effect.runPromiseExit(
			Stream.runDrain(
				neverStream.pipe(
					Stream.timeoutFail(
						() => new PtyConnectionTimeout({}),
						Duration.millis(50),
					),
				),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
