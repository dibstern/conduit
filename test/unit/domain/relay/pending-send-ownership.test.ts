import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	PendingSendOwnershipLive,
	PendingSendOwnershipTag,
} from "../../../../src/lib/domain/relay/Services/pending-send-ownership.js";

const makeOwnership = () =>
	Effect.runSync(
		PendingSendOwnershipTag.pipe(Effect.provide(PendingSendOwnershipLive)),
	);

describe("relay pending send ownership", () => {
	it("isolates identical session and message IDs between relay lifetimes", () => {
		const first = makeOwnership();
		const second = makeOwnership();
		first.register("session", {
			commandId: "send",
			originId: "first",
			text: "hello",
		});
		second.register("session", {
			commandId: "send",
			originId: "second",
			text: "hello",
		});
		expect(first.resolve("session", "message", "hello")).toBe("first");
		expect(second.resolve("session", "message", "hello")).toBe("second");
	});
});

it("keeps only the most recent 64 confirmed IDs and command IDs per session", () => {
	const ownership = makeOwnership();
	for (let index = 0; index < 65; index++) {
		ownership.register("session", {
			commandId: `command-${index}`,
			originId: `owner-${index}`,
			text: "ok",
		});
		expect(ownership.resolve("session", `message-${index}`, "ok")).toBe(
			`owner-${index}`,
		);
	}
	ownership.register("session", {
		commandId: "command-64",
		originId: "duplicate",
		text: "ok",
	});
	expect(ownership.resolve("session", "message-64", "ok")).toBe("owner-64");
	ownership.register("session", {
		commandId: "command-0",
		originId: "new-owner",
		text: "ok",
	});
	expect(ownership.resolve("session", "message-0", "ok")).toBe("new-owner");
	expect(ownership.resolve("session", "fresh-message", "ok")).toBeUndefined();
});
