import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

type DetailEnvelope = typeof SessionDetailEnvelopeSchema.Type;
const keptIds = ["a-kept-user", "b-kept-assistant"];
const hiddenIds = ["c-cut-user", "d-hidden-assistant"];
const seededIds = [...keptIds, ...hiddenIds];

/**
 * What a tab holds, folded as the browser folds it: a removed message takes
 * its parts with it, so a message restored without its parts comes back empty.
 * `ids` names only the seeded messages held whole, header and text part.
 */
function detailState(client: TestWsClient, sessionId: string) {
	const ids = new Set<string>();
	const parts = new Map<string, Set<string>>();
	let pending: string | null = null;
	for (const frame of client.getReceivedOfType("session_detail")) {
		if (frame["sessionId"] !== sessionId) continue;
		const envelope = frame as unknown as DetailEnvelope;
		if (envelope._tag === "snapshot") {
			ids.clear();
			parts.clear();
			pending = null;
		}
		if (envelope._tag === "remove") {
			ids.delete(envelope.id);
			parts.delete(envelope.id);
		}
		const items =
			envelope._tag === "snapshot"
				? envelope.rows
				: envelope._tag === "upsert"
					? [envelope.item]
					: [];
		for (const item of items) {
			if (item._tag === "message") ids.add(item.message.id);
			else if (item._tag === "part")
				parts.set(
					item.messageId,
					(parts.get(item.messageId) ?? new Set()).add(item.part.id),
				);
			else if (item._tag === "rewind") pending = item.messageId;
		}
	}
	return {
		ids: [...ids]
			.filter(
				(id) => seededIds.includes(id) && parts.get(id)?.has(`${id}-text`),
			)
			.sort(),
		pending,
	};
}

function persistedRewinds(harness: RelayHarness, sessionId: string) {
	const db = new Database(harness.eventsDbPath, { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT pending_rewind_message_id FROM sessions WHERE id = ?")
				.get(sessionId) as { pending_rewind_message_id: string | null },
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('session.rewound', 'session.rewind_undone', 'session.rewind_committed', 'message.removed') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			messages: db
				.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY rowid")
				.all(sessionId) as Array<{ id: string }>,
			tombstones: db
				.prepare(
					"SELECT message_id, version FROM message_tombstones WHERE session_id = ? ORDER BY version",
				)
				.all(sessionId) as Array<{ message_id: string; version: number }>,
		};
	} finally {
		db.close();
	}
}

async function seedTurns(harness: RelayHarness, client: TestWsClient) {
	const created = await client.createSession("Pending rewind", {
		providerId: "opencode",
	});
	const sessionId = String(created["id"]);
	const createdAt = Date.now();
	harness.mock.injectSSEEvents(
		seededIds.flatMap((id, index) => [
			{
				type: "message.updated",
				properties: {
					info: {
						id,
						sessionID: sessionId,
						role: index % 2 === 0 ? "user" : "assistant",
						time: { created: createdAt, completed: createdAt },
					},
				},
			},
			{
				type: "message.part.updated",
				properties: {
					part: {
						id: `${id}-text`,
						sessionID: sessionId,
						messageID: id,
						type: "text",
						text: id,
					},
				},
			},
		]),
	);
	await vi.waitFor(
		async () => {
			const page = await client.loadMoreHistory(sessionId);
			expect(page.messages.map((message) => message.id)).toEqual(
				expect.arrayContaining(seededIds),
			);
		},
		{ timeout: 5000 },
	);
	return sessionId;
}

describe("OpenCode pending rewind through the relay", () => {
	let harness: RelayHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async (context) => {
		if (!harness) return;
		const fixture = harness;
		harness = undefined;
		try {
			evidence["requests"] = fixture.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" &&
					/\/(revert|unrevert|prompt_async)(?:\?|$)/.test(entry.detail ?? ""),
			);
			await fixture.stop();
		} finally {
			mkdirSync("test-results/rewind", { recursive: true });
			writeFileSync(
				`test-results/rewind/opencode-${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	});

	// Failure cases: equal timestamps change the cut, another tab misses the
	// pending point, paging leaks hidden messages, undo loses turns, or duplicate
	// provider removals fail after the committed transcript has removed them.
	it("hides and restores turns across tabs, then commits once on the next prompt", async () => {
		harness = await createRelayHarness();
		evidence = { tickets: ["conduit-test-qqqm", "conduit-test-bu61"] };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = await seedTurns(harness, client);
		const second = await harness.connectWsClient();
		await second.switchSession(sessionId);
		const target = hiddenIds[0] as string;
		const rewind = () =>
			client.rpcCall((rpc) =>
				rpc.RewindSession({
					projectSlug: "integration-test",
					sessionId,
					messageId: target,
				}),
			);

		await rewind();
		expect(harness.mock.requestBodies).toContainEqual({
			method: "POST",
			path: `/session/${sessionId}/revert`,
			body: JSON.stringify({ messageID: target }),
		});
		await vi.waitFor(() => {
			for (const tab of [client, second])
				expect(detailState(tab, sessionId)).toEqual({
					ids: [...keptIds].sort(),
					pending: target,
				});
		});
		const pendingPage = await second.loadMoreHistory(sessionId);
		for (const id of hiddenIds)
			expect(pendingPage.messages.map((message) => message.id)).not.toContain(
				id,
			);
		expect(pendingPage.messages.map((message) => message.id)).toEqual(
			expect.arrayContaining(keptIds),
		);
		await expect(
			second.loadMoreHistory(sessionId, hiddenIds[1]),
		).rejects.toThrow();
		const earlier = await second.loadMoreHistory(sessionId, keptIds[1]);
		expect(earlier.messages.map((message) => message.id)).toContain(keptIds[0]);
		for (const id of hiddenIds)
			expect(earlier.messages.map((message) => message.id)).not.toContain(id);
		evidence["pending"] = persistedRewinds(harness, sessionId);
		expect(
			persistedRewinds(harness, sessionId).events.map(({ type }) => type),
		).toEqual(["session.rewound"]);
		expect(
			persistedRewinds(harness, sessionId).messages.map(({ id }) => id),
		).toEqual(expect.arrayContaining(seededIds));
		const reloaded = await harness.connectWsClient();
		await reloaded.switchSession(sessionId);
		expect(detailState(reloaded, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: target,
		});

		await second.rpcCall((rpc) =>
			rpc.UndoRewind({ projectSlug: "integration-test", sessionId }),
		);
		expect(
			harness.mock.diagnostics.filter((entry) =>
				entry.detail?.startsWith(`POST /session/${sessionId}/unrevert`),
			),
		).toHaveLength(1);
		await vi.waitFor(() => {
			for (const tab of [client, second, reloaded])
				expect(detailState(tab, sessionId)).toEqual({
					ids: [...seededIds].sort(),
					pending: null,
				});
		});
		expect(
			(await second.loadMoreHistory(sessionId)).messages.map(({ id }) => id),
		).toEqual(expect.arrayContaining(seededIds));

		await rewind();
		await client.sendMessage("Commit the rewind", { sessionId });
		await client.waitForTurnEnd(sessionId);
		await vi.waitFor(() => {
			const state = persistedRewinds(harness as RelayHarness, sessionId);
			expect(state.session.pending_rewind_message_id).toBeNull();
			for (const id of hiddenIds)
				expect(state.messages.map((message) => message.id)).not.toContain(id);
			expect(state.tombstones.map((tombstone) => tombstone.message_id)).toEqual(
				expect.arrayContaining(hiddenIds),
			);
		});
		const beforeDuplicate = persistedRewinds(harness, sessionId);
		for (const id of hiddenIds)
			harness.mock.emitTestEvent("message.removed", {
				sessionID: sessionId,
				messageID: id,
			});
		// A provider event after both repeated removals fences their ingestion.
		harness.mock.injectSSEEvents([
			{
				type: "message.updated",
				properties: {
					info: {
						id: "rewind-removal-fence",
						sessionID: sessionId,
						role: "assistant",
						time: { created: Date.now() },
					},
				},
			},
		]);
		await vi.waitFor(() =>
			expect(
				persistedRewinds(harness as RelayHarness, sessionId).messages,
			).toContainEqual({
				id: "rewind-removal-fence",
			}),
		);
		const committed = persistedRewinds(harness, sessionId);
		expect(committed.tombstones).toEqual(beforeDuplicate.tombstones);
		expect(committed.events).toEqual(beforeDuplicate.events);
		const removals = committed.events
			.filter((event) => event.type === "message.removed")
			.map(
				(event) => (JSON.parse(event.data) as { messageId: string }).messageId,
			);
		expect(removals.sort()).toEqual([...hiddenIds].sort());
		const reopened = await harness.connectWsClient();
		await reopened.switchSession(sessionId);
		expect(detailState(reopened, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: null,
		});
		const history = await reopened.loadMoreHistory(sessionId);
		for (const id of hiddenIds)
			expect(history.messages.map((message) => message.id)).not.toContain(id);
		await expect(
			reopened.rpcCall((rpc) =>
				rpc.UndoRewind({ projectSlug: "integration-test", sessionId }),
			),
		).rejects.toThrow();
		evidence["committed"] = committed;
		evidence["reload"] = history;
	}, 60_000);

	it("keeps the canonical transcript unchanged when revert or unrevert fails", async () => {
		harness = await createRelayHarness();
		evidence = { ticket: "conduit-test-bu61" };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = await seedTurns(harness, client);
		const target = hiddenIds[0] as string;
		const rewind = () =>
			client.rpcCall((rpc) =>
				rpc.RewindSession({
					projectSlug: "integration-test",
					sessionId,
					messageId: target,
				}),
			);
		harness.mock.setExactResponse("POST", `/session/${sessionId}/revert`, 500, {
			error: "revert failed",
		});
		await expect(rewind()).rejects.toThrow();
		expect(persistedRewinds(harness, sessionId).events).toEqual([]);
		expect(detailState(client, sessionId)).toEqual({
			ids: [...seededIds].sort(),
			pending: null,
		});
		harness.mock.setExactResponse("POST", `/session/${sessionId}/revert`, 200, {
			id: sessionId,
		});
		await rewind();
		const pending = persistedRewinds(harness, sessionId);
		harness.mock.setExactResponse(
			"POST",
			`/session/${sessionId}/unrevert`,
			500,
			{
				error: "unrevert failed",
			},
		);
		await expect(
			client.rpcCall((rpc) =>
				rpc.UndoRewind({ projectSlug: "integration-test", sessionId }),
			),
		).rejects.toThrow();
		expect(persistedRewinds(harness, sessionId)).toEqual(pending);
		const reloaded = await harness.connectWsClient();
		await reloaded.switchSession(sessionId);
		expect(detailState(reloaded, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: target,
		});
		evidence["pendingAfterFailure"] = pending;
	}, 45_000);
});
