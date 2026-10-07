import { expect, type Locator, type Page } from "@playwright/test";
import type { RpcMockControl } from "../../../test/e2e/helpers/rpc-mock.js";
import type { WsMockControl } from "../../../test/e2e/helpers/ws-mock.js";

export const relayControls = new WeakMap<Page, WsMockControl>();
export const rpcControls = new WeakMap<Page, RpcMockControl>();
export const effortOptions = new WeakMap<Page, string[]>();
export const rejectedEffortSwitches = new WeakSet<Page>();
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

/** Move a session's shell row to `status`, the way the server reports a turn
 *  starting (busy) or ending (idle). The row is the client's only busy signal. */
export function setSessionRowStatus(
	page: Page,
	sessionId: string,
	status: "busy" | "idle",
	fields: Record<string, unknown> = {},
): void {
	const rpc = requireRpcControl(page);
	const row = rpc.shellRows?.find(
		(candidate) => (candidate as { id?: string }).id === sessionId,
	);
	rpc.upsertShellRow({
		title: sessionId,
		...(row as object | undefined),
		...fields,
		id: sessionId,
		status,
	});
}

/** Make the app refetch GetModels the way a reconnect does: every shell
 *  `synchronized` marker refetches the catalogs. */
export async function refetchModelCatalog(page: Page): Promise<void> {
	const rpc = requireRpcControl(page);
	const fetches = () =>
		rpc.getRequests().filter((request) => request.tag === "GetModels").length;
	const before = fetches();
	rpc.setShellRows(rpc.shellRows ?? []);
	await expect.poll(fetches).toBeGreaterThan(before);
}

/** Serve a new GetModels catalog and make the app refetch it. */
export async function serveModelCatalog(
	page: Page,
	response: Record<string, unknown>,
): Promise<void> {
	requireRpcControl(page).setResponse("GetModels", {
		projectSlug: "myapp",
		...response,
	});
	await refetchModelCatalog(page);
}

/**
 * Long-press like a person: press, wait for the menu, release. A fixed-length
 * press races the hold timer, and a busy page runs the release first.
 */
export async function holdUntilVisible(
	button: Locator,
	menu: Locator,
): Promise<void> {
	await button.hover();
	await button.page().mouse.down();
	await expect(menu).toBeVisible();
	await button.page().mouse.up();
}

export async function openModelPicker(page: Page): Promise<void> {
	const picker = page.locator("#model-picker");
	if ((await picker.count()) === 0) {
		await page
			.getByTestId(/^(model-picker-trigger|composer-word-model)$/)
			.click();
	}
	await picker.waitFor({ state: "visible", timeout: 5_000 });
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
	await page.getByTestId("picker-row-model").waitFor({ state: "visible" });
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
	const relay = requireRelayControl(page);
	const connections = relay.connections;
	await page.goto(
		new URL(`/s/${encodeURIComponent(sessionId)}`, page.url()).toString(),
	);
	// Fence on the new RPC connection before waiting for the session view.
	await expect.poll(() => relay.connections).toBeGreaterThan(connections);
	await requireRpcControl(page).waitForRequest(
		(request) =>
			request.tag === "ViewSession" &&
			request.payload["sessionId"] === sessionId,
	);
};
