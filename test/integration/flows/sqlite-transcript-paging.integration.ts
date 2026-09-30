import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createRelayHarness } from "../helpers/relay-harness.js";

describe("SQLite transcript paging over WebSocket", () => {
	it("keeps two clients' older-page cursors independent", async () => {
		const harness = await createRelayHarness();
		try {
			const first = await harness.connectWsClient();
			const second = await harness.connectWsClient();
			await Promise.all([
				first.waitForInitialState(),
				second.waitForInitialState(),
			]);
			const created = await first.createSession("Paged transcript", {
				instanceId: "claude",
			});
			const sessionId = created["id"];
			if (typeof sessionId !== "string") throw new Error("missing session id");

			const db = new Database(harness.eventsDbPath);
			try {
				const insert = db.prepare(`INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (?, ?, 'user', ?, 0, ?, ?)`);
				db.transaction(() => {
					for (let index = 1; index <= 120; index++) {
						const id = `msg-${String(index).padStart(3, "0")}`;
						insert.run(id, sessionId, `message ${index}`, index, index);
					}
				})();
			} finally {
				db.close();
			}

			first.clearReceived();
			second.clearReceived();
			const firstView = await first.viewSession(sessionId);
			const secondView = await second.viewSession(sessionId);
			for (const view of [firstView, secondView]) {
				const history = view["history"];
				if (
					!history ||
					typeof history !== "object" ||
					!("messages" in history) ||
					!Array.isArray(history.messages)
				)
					throw new Error(`missing projected history: ${JSON.stringify(view)}`);
				expect(
					history.messages.map((message: { id: string }) => message.id),
				).toEqual(
					Array.from(
						{ length: 50 },
						(_, index) => `msg-${String(index + 71).padStart(3, "0")}`,
					),
				);
			}

			const olderA = await first.loadMoreHistory(sessionId, "msg-071");
			const olderB = await second.loadMoreHistory(sessionId, "msg-071");
			expect(olderA.messages.map((message) => message.id)).toEqual(
				olderB.messages.map((message) => message.id),
			);
			expect(olderA.messages).toHaveLength(50);
			expect(olderA.messages[0]?.id).toBe("msg-021");
			expect(olderA.hasMore).toBe(true);

			const oldestA = olderA.messages[0]?.id;
			const oldestB = olderB.messages[0]?.id;
			if (!oldestA || !oldestB) throw new Error("missing page cursor");
			const firstPage = await first.loadMoreHistory(sessionId, oldestA);
			const secondPage = await second.loadMoreHistory(sessionId, oldestB);
			expect(firstPage.messages.map((message) => message.id)).toEqual(
				secondPage.messages.map((message) => message.id),
			);
			expect(firstPage.messages).toHaveLength(20);
			expect(firstPage.messages[0]?.id).toBe("msg-001");
			expect(firstPage.hasMore).toBe(false);

			const newest = await first.loadMoreHistory(sessionId);
			expect(newest.messages[0]?.id).toBe("msg-071");
			expect(newest.hasMore).toBe(true);
			await expect(
				first.loadMoreHistory(sessionId, "missing-message"),
			).rejects.toThrow(/LoadMoreHistory failed/);
		} finally {
			await harness.stop();
		}
	}, 45_000);
});
