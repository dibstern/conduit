// A model switch refetches the agent list. If that reply lands after the user
// has moved to another session, it must not replace the new session's agents.

import { expect, test } from "@playwright/test";
import { initMessages } from "../fixtures/mockup-state.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

const SESSION_A = "sess-mockup-001";
const SESSION_B = "sess-mockup-002";

const agentsFor = (sessionId: unknown) => ({
	projectSlug: "myapp",
	providerScope: { id: "opencode", name: "OpenCode" },
	agents:
		sessionId === SESSION_B
			? [
					{ id: "b-review", name: "B Review" },
					{ id: "b-write", name: "B Write" },
				]
			: [
					{ id: "a-build", name: "A Build" },
					{ id: "a-plan", name: "A Plan" },
				],
});

test("a late agent list from the previous session leaves the new session's agents alone", async ({
	page,
	baseURL,
}, testInfo) => {
	let holdSessionA = false;
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let heldRequestSeen = false;
	let heldReplySent = false;

	const rpc = await mockWsRpc(page, {
		stubs: {
			GetAgents: async (params) => {
				const sessionId = "sessionId" in params ? params.sessionId : undefined;
				if (!(holdSessionA && sessionId === SESSION_A))
					return agentsFor(sessionId);
				heldRequestSeen = true;
				await released;
				heldReplySent = true;
				return agentsFor(SESSION_A);
			},
			SwitchModel: (params) => ({
				projectSlug: "myapp",
				model: String(params["modelId"]),
				provider: String(params["providerId"]),
				variant: "",
				variants: [],
			}),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}/s/${SESSION_A}`);
	await page.locator("#input").waitFor({ state: "visible" });
	await page.locator(".connect-overlay").waitFor({ state: "hidden" });
	await rpc.waitForRequest(
		(request) =>
			request.tag === "ViewSession" &&
			request.payload["sessionId"] === SESSION_A,
	);

	// Switch model in A, and hold the agent-list refetch that follows.
	holdSessionA = true;
	const trigger = page.getByTestId("model-picker-trigger");
	await openPickerRoot(page, trigger);
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator('[data-model-id="claude-haiku-3.5"][data-provider-id="anthropic"]')
		.click();
	await rpc.waitForRequest((request) => request.tag === "SwitchModel");
	await expect.poll(() => heldRequestSeen).toBe(true);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();

	// Move to B while A's reply is still in flight.
	await new SidebarPage(page).clickSession(SESSION_B);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetAgents" && request.payload["sessionId"] === SESSION_B,
	);
	await openPickerRoot(page, trigger);
	const agentRow = page.getByTestId("picker-row-agent");
	await expect(agentRow).toContainText("B Review");

	release();
	await expect.poll(() => heldReplySent).toBe(true);
	// The reply is sent right after the flag flips; give the client a beat to apply it.
	await page.waitForTimeout(500);

	await expect(agentRow).toContainText("B Review");
	await expect(agentRow).not.toContainText("A Build");
	await testInfo.attach("session-b-picker", {
		body: await page.getByTestId("model-picker").screenshot(),
		contentType: "image/png",
	});
});
