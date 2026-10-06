// Todo overlay feed: the overlay renders the viewed session's
// SubscribeSessionTodos snapshot, then follows its upserts without a refetch.
//
// Uses WS + RPC mocks — no real relay needed.

import { expect, test } from "@playwright/test";
import { initMessages } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const sessionId = "sess-mockup-001";

test("todo overlay shows the session's snapshot and follows its upserts", async ({
	page,
}) => {
	await mockRelayWebSocket(page, { initMessages, responses: new Map() });
	const rpc = await mockWsRpc(page, { handlers: {} });
	rpc.setSessionTodos(sessionId, [
		{ id: "t1", subject: "Write the failing test", status: "completed" },
		{ id: "t2", subject: "Make it pass", status: "in_progress" },
	]);

	await page.goto(`/s/${sessionId}`);
	const overlay = page.locator("#todo-sticky");
	await expect(overlay).not.toHaveClass(/hidden/);
	await expect(overlay).toContainText("Make it pass");
	await expect(overlay).toContainText("1/2");

	rpc.setSessionTodos(sessionId, [
		{ id: "t1", subject: "Write the failing test", status: "completed" },
		{ id: "t2", subject: "Make it pass", status: "completed" },
		{ id: "t3", subject: "Ship it", status: "pending" },
	]);
	await expect(overlay).toContainText("Ship it");
	await expect(overlay).toContainText("2/3");
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "SubscribeSessionTodos"),
	).toEqual([
		{
			tag: "SubscribeSessionTodos",
			payload: expect.objectContaining({ sessionId }),
		},
	]);
});
