import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import {
	PushManagerLive,
	PushManagerTag,
} from "../../../src/lib/domain/server/Services/push-service.js";

describe("Push Notifications Effect", () => {
	it.scoped("subscribe adds subscription", () => {
		const mockSend = vi.fn().mockReturnValue(Effect.succeed(undefined));
		return Effect.gen(function* () {
			const push = yield* PushManagerTag;
			yield* push.subscribe({
				id: "sub-1",
				endpoint: "https://a.com",
				keys: { p256dh: "", auth: "" },
			});
			// No error = success
		}).pipe(Effect.provide(PushManagerLive({ sendPush: mockSend })));
	});

	it.scoped("broadcast sends to all", () => {
		const mockSend = vi.fn().mockReturnValue(Effect.succeed(undefined));
		return Effect.gen(function* () {
			const push = yield* PushManagerTag;
			yield* push.subscribe({
				id: "sub-1",
				endpoint: "https://a.com",
				keys: { p256dh: "", auth: "" },
			});
			yield* push.subscribe({
				id: "sub-2",
				endpoint: "https://b.com",
				keys: { p256dh: "", auth: "" },
			});
			yield* push.broadcast({ title: "Test", body: "Hello" });
			expect(mockSend).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(PushManagerLive({ sendPush: mockSend })));
	});

	it.scoped("individual failure does not block others", () => {
		const mockSend = vi
			.fn()
			.mockReturnValueOnce(Effect.fail(new Error("network")))
			.mockReturnValueOnce(Effect.succeed(undefined));
		return Effect.gen(function* () {
			const push = yield* PushManagerTag;
			yield* push.subscribe({
				id: "sub-1",
				endpoint: "https://a.com",
				keys: { p256dh: "", auth: "" },
			});
			yield* push.subscribe({
				id: "sub-2",
				endpoint: "https://b.com",
				keys: { p256dh: "", auth: "" },
			});
			yield* push.broadcast({ title: "Test", body: "Hello" });
			expect(mockSend).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(PushManagerLive({ sendPush: mockSend })));
	});
});
