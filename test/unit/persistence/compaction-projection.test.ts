// ─── Compaction Persistence ─────────────────────────────────────────────────
// Drives the real ingestion path rather than a projector constructed by hand.
// The synchronous projector implemented compaction and was never run by the
// daemon, so a test against it passed while every compaction was dropped.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const SESSION_ID = "sess-compaction-001";

interface MessageRow {
	id: string;
	session_id: string;
	role: string;
	is_streaming: number;
}

interface PartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	metadata: string | null;
	sort_order: number;
}

describe("session.compaction projection (real ingestion path)", () => {
	let harness: EffectProjectionHarness;

	const compaction = (
		state: "started" | "completed" | "failed",
		overrides: {
			detail?: string;
			preTokens?: number;
			postTokens?: number;
			eventId?: string;
		} = {},
	) =>
		providerRuntimeEvent(
			"session.compaction",
			SESSION_ID,
			{
				sessionId: SESSION_ID,
				state,
				detail: overrides.detail ?? "Context compacted",
				...(overrides.preTokens != null
					? { preTokens: overrides.preTokens }
					: {}),
				...(overrides.postTokens != null
					? { postTokens: overrides.postTokens }
					: {}),
			},
			{ eventId: overrides.eventId ?? `evt_compaction_${state}` },
		);

	const compactionMessages = () =>
		harness.query<MessageRow>(
			"SELECT id, session_id, role, is_streaming FROM messages WHERE id LIKE 'compaction-%' ORDER BY id",
		);

	const compactionParts = () =>
		harness.query<PartRow>(
			"SELECT id, message_id, type, text, metadata, sort_order FROM message_parts WHERE type = 'compaction' ORDER BY id",
		);

	beforeEach(() => {
		harness = makeEffectProjectionHarness();
	});

	afterEach(async () => {
		await harness.dispose();
	});

	it("persists a completed compaction as a synthetic assistant message", async () => {
		await harness.ingest(
			compaction("completed", { preTokens: 120_000, postTokens: 30_000 }),
		);

		const messages = await compactionMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			session_id: SESSION_ID,
			role: "assistant",
			is_streaming: 0,
		});

		const parts = await compactionParts();
		expect(parts).toHaveLength(1);
		expect(parts[0]?.message_id).toBe(messages[0]?.id);
		expect(parts[0]?.text).toBe("Context compacted");
		expect(JSON.parse(parts[0]?.metadata ?? "{}")).toEqual({
			preTokens: 120_000,
			postTokens: 30_000,
		});
	});

	it("keys message and part ids on the event sequence", async () => {
		await harness.ingest(compaction("completed"));

		const stored = await harness.storedEvents(SESSION_ID);
		const event = stored.find((e) => e.type === "session.compaction");
		expect(event).toBeDefined();

		const messages = await compactionMessages();
		expect(messages[0]?.id).toBe(`compaction-${event?.sequence}`);
		const parts = await compactionParts();
		expect(parts[0]?.id).toBe(`compaction-part-${event?.sequence}`);
	});

	it("leaves started and failed compactions transient", async () => {
		await harness.ingest(compaction("started"));
		await harness.ingest(compaction("failed"));

		expect(await compactionMessages()).toHaveLength(0);
		expect(await compactionParts()).toHaveLength(0);
	});

	it("omits token fields that the provider did not report", async () => {
		await harness.ingest(compaction("completed"));

		const parts = await compactionParts();
		expect(parts).toHaveLength(1);
		expect(JSON.parse(parts[0]?.metadata ?? "null")).toEqual({});
	});

	it("is a no-op when the same event is projected again", async () => {
		await harness.ingest(compaction("completed", { preTokens: 99 }));
		const stored = await harness.storedEvents(SESSION_ID);

		await harness.reproject(stored);

		expect(await compactionMessages()).toHaveLength(1);
		expect(await compactionParts()).toHaveLength(1);
	});

	it("records several compactions in one session separately", async () => {
		await harness.ingest(
			compaction("completed", { detail: "first", eventId: "evt_c1" }),
		);
		await harness.ingest(
			compaction("completed", { detail: "second", eventId: "evt_c2" }),
		);

		const parts = await compactionParts();
		expect(parts.map((p) => p.text)).toEqual(["first", "second"]);
		expect(new Set(parts.map((p) => p.message_id)).size).toBe(2);
	});
});
