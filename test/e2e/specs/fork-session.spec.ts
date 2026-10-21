// Tests fork-point rendering: collapsible prior context, fork divider,
// SubagentBackBar hidden for user forks.
//
// Uses replay fixture with MockOpenCodeServer replaying the fork-session
// recording — no real OpenCode needed.
//
// Recording structure:
// 1. Two-turn conversation (alpha, beta) in the original session
// 2. Whole-session fork (no messageId)
// 3. Prompt in the forked session ("What words did I remember?")
//
// The fork response selects the new session. Its inherited transcript renders
// the fork UI (context block + divider) before the third prompt.
//
// The recording's delta events for the third prompt's assistant response
// are attached to a later REST queue entry. We don't wait for the full
// response to complete — we wait for the fork UI elements instead.

import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import NodeWebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

// Session ownership determines the relay on the daemon /rpc endpoint.
async function callRpc<A>(
	relayUrl: string,
	call: (
		client: RpcClient.FromGroup<
			typeof WsRpcGroup,
			RpcClientError.RpcClientError
		>,
	) => Effect.Effect<A, unknown>,
): Promise<A> {
	const url = new URL(relayUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/rpc";
	url.search = "";

	const previousWebSocket = globalThis.WebSocket;
	globalThis.WebSocket =
		NodeWebSocket as unknown as typeof globalThis.WebSocket;
	try {
		return await Effect.runPromise(
			Effect.scoped(Effect.flatMap(RpcClient.make(WsRpcGroup), call)).pipe(
				Effect.provide(RpcClient.layerProtocolSocket()),
				Effect.provide(Socket.layerWebSocket(url.toString())),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
	} finally {
		globalThis.WebSocket = previousWebSocket;
	}
}

/**
 * Run the setup: two prompts, fork, then send the third prompt.
 * Does NOT wait for the third prompt's assistant response to complete
 * (the mock's SSE events for the response text are deeply queued).
 * Instead, waits for the fork UI to appear.
 */
async function setupForkSession(
	page: import("@playwright/test").Page,
	app: AppPage,
	chat: ChatPage,
	relayUrl: string,
): Promise<{ sourceId: string; forkId: string }> {
	const viewedSessions = new Set<string>();
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const requests = new Map<string, string>();
		socket.on("framesent", ({ payload }) => {
			const frame: unknown = JSON.parse(String(payload));
			const messages: readonly unknown[] = Array.isArray(frame)
				? frame
				: [frame];
			for (const request of messages) {
				if (
					isRecord(request) &&
					request["_tag"] === "Request" &&
					request["tag"] === "ViewSession" &&
					isRecord(request["payload"]) &&
					typeof request["payload"]["sessionId"] === "string"
				) {
					requests.set(String(request["id"]), request["payload"]["sessionId"]);
				}
			}
		});
		socket.on("framereceived", ({ payload }) => {
			const frame: unknown = JSON.parse(String(payload));
			const messages: readonly unknown[] = Array.isArray(frame)
				? frame
				: [frame];
			for (const response of messages) {
				if (!isRecord(response) || response["_tag"] !== "Exit") continue;
				const sessionId = requests.get(String(response["requestId"]));
				requests.delete(String(response["requestId"]));
				if (
					sessionId &&
					isRecord(response["exit"]) &&
					response["exit"]["_tag"] === "Success"
				) {
					viewedSessions.add(sessionId);
				}
			}
		});
	});
	async function waitForView(sessionId: string) {
		await expect.poll(() => viewedSessions.has(sessionId)).toBe(true);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => resolve());
				}),
		);
	}
	await app.goto(relayUrl);
	const sessionId = new URL(page.url()).pathname.split("/").at(-1);
	if (!sessionId) throw new Error("Missing source session route");
	await waitForView(sessionId);

	await app.sendMessage(
		"Remember the word 'alpha'. Reply with only: ok, remembered.",
	);
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();

	await app.sendMessage(
		"Now remember 'beta' too. Reply with only: ok, remembered.",
	);
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();

	// Fork: whole-session fork (no messageId)
	const forkedSessionId = await callRpc(relayUrl, (client) =>
		client
			.ForkSession({ sessionId, originId: crypto.randomUUID() })
			.pipe(Effect.map((result) => result.sessionId)),
	);
	await page.evaluate((sessionId) => {
		const route = new URL(window.location.href);
		route.pathname = `/s/${encodeURIComponent(sessionId)}`;
		history.pushState(null, "", route);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, forkedSessionId);

	// ViewSession restores the fork's draft asynchronously. Wait for that reply
	// and a render frame so it cannot clear a prompt typed before it arrived.
	await waitForView(forkedSessionId);
	const forkDivider = page.locator(".fork-divider");
	await forkDivider.waitFor({ state: "visible", timeout: 30_000 });

	await app.sendMessage(
		"What words did I ask you to remember? Reply with just the words.",
	);
	await expect(chat.userMessages.last()).toContainText(
		"What words did I ask you to remember? Reply with just the words.",
	);
	return { sourceId: sessionId, forkId: forkedSessionId };
}

test.describe("Fork Session Rendering", () => {
	test.describe.configure({ timeout: 60_000 });
	test.use({ recording: "fork-session" });

	test("fork creates collapsible prior context and divider", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Fork context block should be visible (collapsed by default)
		const contextBlock = page.locator(".fork-context-block");
		await expect(contextBlock).toBeVisible();

		// The toggle button should say "Prior conversation"
		const toggle = page.locator(".fork-context-toggle");
		await expect(toggle).toContainText("Prior conversation");

		// Context messages should NOT be visible (collapsed)
		const contextMessages = page.locator(".fork-context-messages");
		await expect(contextMessages).not.toBeVisible();

		// Fork divider should contain "Forked from"
		const forkDivider = page.locator(".fork-divider");
		await expect(forkDivider).toContainText("Forked from");

		// SubagentBackBar should NOT be visible for user forks
		await expect(chat.subagentBackBar).not.toBeVisible();
	});

	test("expanding prior context shows inherited messages", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Click the toggle to expand
		const toggle = page.locator(".fork-context-toggle");
		await toggle.click();

		// Context messages should now be visible
		const contextMessages = page.locator(".fork-context-messages");
		await expect(contextMessages).toBeVisible({ timeout: 5_000 });

		// The inherited area should contain message elements
		const inheritedMsgs = contextMessages.locator(".msg-user, .msg-assistant");
		const count = await inheritedMsgs.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test("fork is listed in the sidebar", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		const forkId = decodeURIComponent(
			new URL(page.url()).pathname.split("/").at(-1) ?? "",
		);
		try {
			await expect(
				page.locator(`#session-list [data-session-id="${forkId}"]`),
			).toBeVisible({ timeout: 10_000 });
		} finally {
			// Record what the sidebar listed whether or not the fork made it.
			const sidebarIds = await page
				.locator("#session-list [data-session-id]")
				.evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-session-id")),
				);
			await page.screenshot({
				path: testInfo.outputPath("fork-in-sidebar.png"),
			});
			writeFileSync(
				testInfo.outputPath("fork-in-sidebar.json"),
				JSON.stringify({ forkId, sidebarIds }, null, 2),
			);
		}
	});

	test("deleting the source keeps the fork", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		const { sourceId, forkId } = await setupForkSession(
			page,
			app,
			chat,
			relayUrl,
		);
		await callRpc(relayUrl, (client) =>
			client.DeleteSession({
				sessionId: sourceId,
				originId: crypto.randomUUID(),
			}),
		);

		const divider = page.locator(".fork-divider");
		try {
			await expect(
				page.locator(`#session-list [data-session-id="${sourceId}"]`),
			).toHaveCount(0);
			await expect(
				page.locator(`#session-list [data-session-id="${forkId}"]`),
			).toBeVisible();
			await expect(divider).toHaveText("Forked from a deleted session");
			await expect(divider.getByRole("button")).toHaveCount(0);
		} finally {
			// Record the sidebar and divider whether or not the fork survived.
			const sidebarIds = await page
				.locator("#session-list [data-session-id]")
				.evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-session-id")),
				);
			await page.screenshot({
				path: testInfo.outputPath("fork-after-source-deleted.png"),
			});
			writeFileSync(
				testInfo.outputPath("fork-after-source-deleted.json"),
				JSON.stringify(
					{
						sourceId,
						forkId,
						sidebarIds,
						divider: (await divider.textContent())?.trim() ?? null,
					},
					null,
					2,
				),
			);
		}
	});

	test("SubagentBackBar hidden for user forks", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// SubagentBackBar should NOT be visible for user forks
		// (it only shows for subagent sessions with parentID but no forkMessageId)
		await expect(chat.subagentBackBar).not.toBeVisible();
	});

	test("new messages appear after fork divider, not in inherited block", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Wait for assistant response to the third prompt to complete.
		// This proves the response rendered below the fork divider.
		await chat.waitForStreamingComplete(30_000);

		// The assistant response may arrive via REST polling slightly after
		// the stop button hides.  Wait for it to render in the DOM.
		await page.waitForFunction(
			() => {
				const msgs = document.querySelector("#messages");
				if (!msgs) return false;
				const div = msgs.querySelector(".fork-divider");
				if (!div) return false;
				let el = div.nextElementSibling;
				while (el) {
					if (el.querySelector(".msg-assistant")) return true;
					el = el.nextElementSibling;
				}
				return false;
			},
			{ timeout: 10_000 },
		);

		// The fork divider separates inherited from current messages.
		// Walk siblings after the divider to find user + assistant messages.
		const result = await page.evaluate(() => {
			const messages = document.querySelector("#messages");
			if (!messages) return { error: "no #messages" };

			const divider = messages.querySelector(".fork-divider");
			if (!divider) return { error: "no fork-divider" };

			let userAfter = 0;
			let assistantAfter = 0;
			let el = divider.nextElementSibling;
			while (el) {
				if (el.querySelector(".msg-user")) userAfter++;
				if (el.querySelector(".msg-assistant")) assistantAfter++;
				el = el.nextElementSibling;
			}
			return { userAfter, assistantAfter };
		});

		expect(result).not.toHaveProperty("error");
		const { userAfter, assistantAfter } = result as {
			userAfter: number;
			assistantAfter: number;
		};

		// The third prompt's user message and assistant response must be
		// AFTER the fork divider — not collapsed into "Prior conversation".
		expect(userAfter).toBeGreaterThanOrEqual(1);
		expect(assistantAfter).toBeGreaterThanOrEqual(1);
	});

	test("inherited messages contain visible assistant text when expanded", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Expand the prior conversation block
		const toggle = page.locator(".fork-context-toggle");
		await toggle.click();
		const contextMessages = page.locator(".fork-context-messages");
		await expect(contextMessages).toBeVisible({ timeout: 5_000 });

		// The inherited section must contain at least one assistant message
		// with actual rendered text content (not just empty containers).
		// This catches the SSE-cache bug where inherited messages had no
		// createdAt → no text content rendered (only result bars / thinking).
		const assistantTextContent = await contextMessages
			.locator(".msg-assistant .md-content")
			.evaluateAll((els) =>
				els
					.map((el) => (el.textContent ?? "").trim())
					.filter((t) => t.length > 0),
			);
		expect(assistantTextContent.length).toBeGreaterThanOrEqual(1);
	});
});
