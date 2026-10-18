// OpenCode can't steer (conduit-test-jyr9.11; see
// docs/plans/2026-10-05-steer-and-queue/opencode-v2.md): its adapter declares
// no `steering`, so a busy OpenCode session offers only Queue, and the server
// refuses a steer with `no_steering`. Real relay and event store; OpenCode
// REST/SSE replays a real capture that holds the turn in a running bash call.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const query = (dbPath: string, sql: string, sessionId: string) => {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(sessionId);
	} finally {
		db.close();
	}
};

/** The session's last status and whether its turn has started a tool. */
const turnState = (dbPath: string, sessionId: string) => ({
	status: query(
		dbPath,
		`SELECT json_extract(data, '$.status') AS status FROM events
		WHERE session_id = ? AND type = 'session.status' ORDER BY sequence DESC LIMIT 1`,
		sessionId,
	)[0]?.["status"],
	toolStarted:
		query(
			dbPath,
			"SELECT 1 FROM events WHERE session_id = ? AND type = 'tool.started'",
			sessionId,
		).length > 0,
});

const firstPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const toolPrompt =
	"Use the bash tool to run: sleep 10; printf mid-turn-marker. Then reply with only its output.";

test.describe("OpenCode steering", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});
	// Recorded by test/e2e/scripts/capture-side-thread-status.ts mid-turn.
	test.use({ recording: "side-thread-mid-turn" });

	test("a busy OpenCode session hides Steer and the server refuses one", async ({
		page,
		relayUrl,
		harness,
	}) => {
		test.setTimeout(90_000);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		const sessionId = new URL(page.url()).pathname.split("/").at(-1);
		if (!sessionId) throw new Error("Session route is missing");

		await app.sendMessage(firstPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			/ok, remembered/i,
		);
		await expect
			.poll(() => turnState(harness.eventsDbPath, sessionId))
			.toEqual({ status: "idle", toolStarted: false });
		await chat.waitForStreamingComplete();
		// The recording holds this turn in its running bash call.
		await app.sendMessage(toolPrompt);
		await expect
			.poll(() => turnState(harness.eventsDbPath, sessionId))
			.toEqual({ status: "busy", toolStarted: true });

		// The server is the judge: a steer is refused before anything is admitted.
		const refused = await Effect.runPromise(
			Effect.scoped(
				Effect.flatMap(RpcClient.make(WsRpcGroup), (client) =>
					client.input.submit({
						sessionId,
						inputId: randomUUID(),
						text: "Bravo",
						delivery: "steer",
					}),
				),
			).pipe(
				Effect.provide(RpcClient.layerProtocolSocket()),
				Effect.provide(
					Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
				),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
		expect(refused).toEqual({ ok: false, reason: "no_steering" });

		// The composer offers only Queue: no steer hint, and ⌘/Ctrl+Enter queues.
		await app.input.fill("Charlie");
		await expect(app.sendBtn).toHaveAccessibleName("Queue message");
		await expect(app.sendBtn).toHaveAttribute("title", "Queue message");
		await app.input.press("ControlOrMeta+Enter");
		const row = page.getByTestId("pending-input-row");
		await expect(row.getByTestId("pending-input-text")).toHaveText("Charlie");
		await expect(row.getByTestId("pending-input-state")).toHaveText("Queued");
		await expect(row.getByTestId("pending-input-steer")).toHaveCount(0);
		// The refused steer was never admitted; the two sent prompts left the inbox.
		expect(
			query(
				harness.eventsDbPath,
				"SELECT text, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at",
				sessionId,
			),
		).toEqual([
			{ text: firstPrompt, state: "removed" },
			{ text: toolPrompt, state: "removed" },
			{ text: "Charlie", state: "queued" },
		]);
	});
});
