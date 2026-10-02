import type { Page } from "@playwright/test";
import type { RpcMockControl } from "../../../test/e2e/helpers/rpc-mock.js";
import type { WsMockControl } from "../../../test/e2e/helpers/ws-mock.js";

export const relayControls = new WeakMap<Page, WsMockControl>();
export const rpcControls = new WeakMap<Page, RpcMockControl>();
export const detailFeeds = new WeakMap<Page, RpcMockControl["detailFeed"]>();
export const inheritedClaudeCommitAttribution = "Inherited commit attribution";
/** GetSessionSkills loads served by the mock app; empty unless a scenario seeds them. */
export const mockSessionSkills = new WeakMap<Page, readonly unknown[]>();
/** Per-page mock instance list — mutated by the Add/Update/Remove RPC handlers
 *  so the SettingsPanel editor and the composer rail see consistent state. */
export const mockInstances = new WeakMap<
	Page,
	Array<Record<string, unknown>>
>();

/** Mirror the relay's makeInstanceId slugging so rail test ids stay stable. */
export function instanceSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "instance"
	);
}

export function requireRelayControl(page: Page): WsMockControl {
	const control = relayControls.get(page);
	if (!control) throw new Error("Mock relay was not initialised");
	return control;
}

export function requireRpcControl(page: Page): RpcMockControl {
	const control = rpcControls.get(page);
	if (!control) throw new Error("Mock RPC was not initialised");
	return control;
}

export async function openModelPicker(page: Page): Promise<void> {
	const picker = page.locator("#model-picker");
	if ((await picker.count()) === 0) {
		await page.getByTestId("model-picker-trigger").click();
	}
	await picker.waitFor({ state: "visible", timeout: 5_000 });
}

export function exampleValue(
	example: Record<string, string>,
	key: string,
): string {
	const value = example[key];
	if (value == null) {
		throw new Error(`Missing example value for <${key}>`);
	}
	return value;
}

export const openSessionRoute = async (page: Page, sessionId: string) => {
	await page.goto(
		new URL(`/s/${encodeURIComponent(sessionId)}`, page.url()).toString(),
	);
	await requireRpcControl(page).waitForRequest(
		(request) =>
			request.tag === "ViewSession" &&
			request.payload["sessionId"] === sessionId,
	);
};
