// Drives the real ingestion path rather than a projector constructed by hand.
// The synchronous projector implemented compaction and was never run by the
// daemon, so a test against it passed while every compaction was dropped.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeSessionCreatedRuntimeEvent } from "../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
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
	version: number;
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
			"SELECT id, session_id, role, is_streaming, version FROM messages WHERE id LIKE 'compaction-%' ORDER BY id",
		);

	const compactionParts = () =>
		harness.query<PartRow>(
			"SELECT id, message_id, type, text, metadata, sort_order FROM message_parts WHERE type = 'compaction' ORDER BY id",
		);

	beforeEach(async () => {
		harness = makeEffectProjectionHarness();
		// A compaction outcome cannot create a session, and none compacts first.
		await harness.ingest(
			opencodeSessionCreatedRuntimeEvent(SESSION_ID, "opencode"),
		);
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
		expect(messages[0]?.version).toBeGreaterThan(0);

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

	it("leaves a started compaction transient and keeps a failed outcome", async () => {
		await harness.ingest(compaction("started"));
		expect(await compactionParts()).toHaveLength(0);

		await harness.ingest(compaction("failed"));
		expect(await compactionMessages()).toHaveLength(1);
		expect(await compactionParts()).toHaveLength(1);
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

	it("keeps the OpenCode summary owner and replays like historical metadata", async () => {
		await harness.ingestBatch([
			providerRuntimeEvent("message.created", SESSION_ID, {
				sessionId: SESSION_ID,
				messageId: "summary",
				role: "assistant",
			}),
			providerRuntimeEvent(
				"message.created",
				SESSION_ID,
				{
					sessionId: SESSION_ID,
					messageId: "later-answer",
					role: "assistant",
				},
				{ eventId: "evt_later_answer", createdAt: Date.now() + 1 },
			),
			{
				...compaction("completed"),
				providerId: "opencode",
				providerRefs: {
					providerMessageId: "summary",
					providerSessionId: "sdk-session",
					providerTurnId: "sdk-turn",
					providerToolUseId: "sdk-tool",
				},
			},
		]);
		expect((await compactionParts())[0]?.message_id).toBe("summary");

		const stored = await harness.storedEvents(SESSION_ID);
		expect(
			stored.find((event) => event.type === "session.compaction")?.metadata,
		).toEqual({
			providerRefs: { providerMessageId: "summary" },
		});
		const historical = makeEffectProjectionHarness();
		const compact = makeEffectProjectionHarness();
		try {
			await historical.reproject(
				stored.map((event) => ({
					...event,
					metadata: {
						...event.metadata,
						providerRuntimeEventId: event.eventId,
						rawSource: "test.provider-runtime",
						providerRefs: {
							providerSessionId: "sdk-session",
							providerTurnId: "sdk-turn",
							providerToolUseId: "sdk-tool",
							...event.metadata.providerRefs,
						},
					},
				})),
			);
			await compact.reproject(stored);
			for (const table of ["sessions", "messages", "message_parts", "turns"]) {
				expect(
					await compact.query(`SELECT * FROM ${table} ORDER BY id`),
				).toEqual(await historical.query(`SELECT * FROM ${table} ORDER BY id`));
			}
		} finally {
			await historical.dispose();
			await compact.dispose();
		}
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
