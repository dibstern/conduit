// A session's messages read in the order the store wrote them, then by time,
// then by id (conduit-test-lczrn.1, as t3code orders a thread's items).
// Failure modes: equal times on first load and across a page boundary; a
// later snapshot moving a row; a rebuild from the same events reordering rows.
import { afterEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";

const AT = 1000;
let sequence = 0;
const stored = <T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	metadata: StoredEvent["metadata"] = {},
): StoredEvent =>
	({
		sequence: ++sequence,
		projectId: "test-project",
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata,
		provider: "opencode",
		createdAt: AT,
	}) as StoredEvent;

// Written e, d, c, b, a at one time: id order is the reverse of write order.
const WRITTEN = ["m-e", "m-d", "m-c", "m-b", "m-a"] as const;
const events = (): StoredEvent[] => [
	stored("session.created", "s1", {
		sessionId: "s1",
		title: "Equal times",
		provider: "opencode",
	}),
	...WRITTEN.map((messageId, index) =>
		stored("message.created", "s1", {
			messageId,
			sessionId: "s1",
			role: index % 2 === 0 ? "user" : "assistant",
		}),
	),
];

const ids = (rows: readonly { readonly id: string }[]) =>
	rows.map((row) => row.id);

/** Every page from the newest back, oldest message first. */
const pageBack = async (harness: EffectProjectionHarness, limit: number) => {
	const seen: string[] = [];
	let page = await harness.transcriptPage("s1", { limit });
	seen.unshift(...ids(page.messages));
	while (page.hasMore) {
		const before = page.messages[0]?.id;
		if (before === undefined) throw new Error("expected a cursor");
		page = await harness.transcriptPage("s1", { limit, before });
		seen.unshift(...ids(page.messages));
	}
	return seen;
};

describe("message write order", () => {
	const harnesses: EffectProjectionHarness[] = [];
	const open = () => {
		const harness = makeEffectProjectionHarness();
		harnesses.push(harness);
		return harness;
	};
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
	});

	it("reads equal-time messages in write order on first load and paging back", async () => {
		const harness = open();
		await harness.reproject(events());
		expect(ids(await harness.sessionMessagesWithParts("s1"))).toEqual(WRITTEN);
		expect(await pageBack(harness, 2)).toEqual(WRITTEN);
		expect(await pageBack(harness, 1)).toEqual(WRITTEN);
	});

	it("keeps a message's place when a later snapshot rewrites it", async () => {
		const harness = open();
		await harness.reproject([
			...events(),
			stored(
				"message.snapshot",
				"s1",
				{
					messageId: "m-e",
					digest: "rewritten",
					message: {
						id: "m-e",
						sessionID: "s1",
						role: "user",
						time: { created: AT },
						parts: [{ id: "m-e-text", type: "text", text: "prompt" }],
					},
				},
				{ rawSource: "opencode.rest" },
			),
		]);
		expect(ids(await harness.sessionMessagesWithParts("s1"))).toEqual(WRITTEN);
		expect(await pageBack(harness, 2)).toEqual(WRITTEN);
	});

	it("gives the same order when the projections are rebuilt from the events", async () => {
		const log = events();
		const live = open();
		await live.reproject(log);
		const rebuilt = open();
		await rebuilt.reproject(log);
		const order = "SELECT id, ordinal FROM messages ORDER BY ordinal";
		expect(await rebuilt.query(order)).toEqual(await live.query(order));
		expect(ids(await rebuilt.sessionMessagesWithParts("s1"))).toEqual(WRITTEN);
	});
});
