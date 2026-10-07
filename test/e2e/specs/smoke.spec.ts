// Structural smoke test proving the UI renders correctly with a real relay
// backed by MockOpenCodeServer. No real OpenCode needed.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test.describe("E2E Smoke Test", () => {
	test("page loads and connects to relay", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Page title
		await expect(page).toHaveTitle("Conduit");

		// Connection overlay should be hidden (WS connected)
		await expect(app.connectOverlay).toBeHidden();

		// Status dot should show connected
		await app.waitForConnected();
	});

	test("opens a replay session URL without an error toast", async ({
		page,
		relayUrl,
		harness,
	}) => {
		// Every reply to this page's ResolveSession request. The toast check below
		// runs once the reply is in, when a failed resolve would already show it.
		const resolveReplies: unknown[] = [];
		page.on("websocket", (ws) => {
			let requestId: string | undefined;
			const parse = (payload: string | Buffer): Record<string, unknown> =>
				typeof payload === "string" ? JSON.parse(payload) : {};
			ws.on("framesent", (frame) => {
				const message = parse(frame.payload);
				if (message["tag"] === "ResolveSession") {
					requestId = String(message["id"]);
				}
			});
			ws.on("framereceived", (frame) => {
				const message = parse(frame.payload);
				if (
					message["_tag"] === "Defect" ||
					(requestId !== undefined && message["requestId"] === requestId)
				) {
					resolveReplies.push(message);
				}
			});
		});
		const app = new AppPage(page);
		await app.goto(relayUrl);

		await expect(
			page.locator(
				`#session-list .session-item.active[data-session-id="${decodeURIComponent(harness.projectUrl.slice("/s/".length))}"]`,
			),
		).toBeVisible();
		await expect(app.messages).toBeVisible();
		await expect
			.poll(() => resolveReplies)
			.toEqual([
				{
					_tag: "Exit",
					requestId: expect.any(String),
					exit: { _tag: "Success", value: { projectSlug: "e2e-replay" } },
				},
			]);
		await expect(page.getByText("Failed to open session")).toHaveCount(0);
	});

	test("returns an unknown session URL to the session list", async ({
		page,
		relayUrl,
	}) => {
		const unknownId = "unknown-session-vik1-34";
		const receivedFrames: Record<string, unknown>[] = [];
		page.on("websocket", (ws) => {
			ws.on("framereceived", (frame) => {
				if (typeof frame.payload === "string") {
					receivedFrames.push(JSON.parse(frame.payload));
				}
			});
		});
		const app = new AppPage(page);
		await app.goto(new URL(`/s/${unknownId}`, relayUrl).href);

		await expect(
			page.getByText("Session not found. That session no longer exists."),
		).toBeVisible();
		await expect(page).toHaveURL(new URL("/", relayUrl).href);
		await expect(page.getByText("Failed to open session")).toHaveCount(0);
		await expect(
			page.locator(
				`#session-list .session-item.active[data-session-id="${unknownId}"]`,
			),
		).toHaveCount(0);
		expect(
			receivedFrames.filter(
				(frame) =>
					(frame["type"] === "session_switched" &&
						frame["sessionId"] === unknownId) ||
					(frame["type"] === "session_family" && frame["rootId"] === unknownId),
			),
		).toEqual([]);
	});

	test("input area is visible and functional", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Textarea is visible and enabled
		await expect(app.input).toBeVisible();
		await expect(app.input).toBeEditable();

		// Send button is visible but disabled when textarea is empty
		await expect(app.sendBtn).toBeVisible();
		await expect(app.sendBtn).toBeDisabled();

		// Typing into the input works — and enables the send button
		await app.input.fill("test");
		const value = await app.input.inputValue();
		expect(value).toBe("test");
		await expect(app.sendBtn).toBeEnabled();
	});

	test("session list is populated on connect", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Session list should have at least one session
		const sessionItems = page.locator("#session-list .session-item");
		await expect(sessionItems.first()).toBeVisible({ timeout: 10_000 });
		const count = await sessionItems.count();
		expect(count).toBeGreaterThan(0);
	});

	test("merged bar controls are present", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Project name
		await expect(app.projectName).toBeVisible();

		// Status dot
		await expect(app.statusDot).toBeVisible();

		await app.moreActionsBtn.click();
		// Share action
		await expect(app.qrBtn).toBeVisible();
	});
});
