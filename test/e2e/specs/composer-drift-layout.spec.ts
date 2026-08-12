// ─── Composer Model-Drift Layout (mobile) ───────────────────────────────────
// Regression coverage for: the model-drift indicator was an inline, shrink-0
// sibling of the model picker inside the composer's bottom control row. Its
// intrinsic width (~260px) exceeded the space left on a phone viewport, so it
// overflowed and painted on top of the approvals pill and the send button —
// looking like a stray toast pinned over the bottom-right of the input area.
//
// Uses WS + RPC mocks — no real relay needed.

import { expect, test } from "@playwright/test";
import {
	modelExecutionMockups,
	modelExecutionProviders,
} from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: false });

const mockup = modelExecutionMockups["drifted-model"];

test("@drift-layout drift indicator never covers the composer controls on mobile", async ({
	page,
}) => {
	await mockRelayWebSocket(page, {
		initMessages: mockup.initMessages,
		responses: new Map(),
	});
	await mockWsRpc(page, {
		handlers: {
			GetProjects: async () => ({
				projects: [{ slug: "myapp", name: "myapp", path: "/tmp/myapp" }],
			}),
			GetModels: async () => ({
				projectSlug: "myapp",
				providers: modelExecutionProviders,
				active: { model: "opus[1m]", provider: "claude" },
				modelExecution: mockup.modelExecution,
			}),
			GetAgents: async () => ({
				projectSlug: "myapp",
				providerScope: { id: "claude", name: "Claude" },
				agents: [{ id: "planner", name: "Planner" }],
			}),
		},
	});

	await page.goto("/p/myapp/");
	await page.locator("#input").waitFor({ state: "visible", timeout: 20_000 });

	const drift = page.getByTestId("current-model-drift");
	await expect(drift).toBeVisible();

	const driftBox = await drift.boundingBox();
	const sendBox = await page.locator("#send").boundingBox();
	const rowBox = await page.locator("#input-bottom").boundingBox();
	expect(driftBox && sendBox && rowBox).toBeTruthy();
	if (!driftBox || !sendBox || !rowBox) return;

	// Never overlaps the controls it used to sit on top of.
	const overlapX =
		Math.min(driftBox.x + driftBox.width, sendBox.x + sendBox.width) -
		Math.max(driftBox.x, sendBox.x);
	const overlapY =
		Math.min(driftBox.y + driftBox.height, sendBox.y + sendBox.height) -
		Math.max(driftBox.y, sendBox.y);
	expect(overlapX <= 0 || overlapY <= 0).toBe(true);

	// And the controls row itself still fits the viewport.
	const viewport = page.viewportSize();
	expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
		(viewport?.width ?? 0) + 1,
	);
	expect(driftBox.x + driftBox.width).toBeLessThanOrEqual(
		(viewport?.width ?? 0) + 1,
	);
});
