import { expect, type Locator, type Page } from "@playwright/test";
import type { MessageSurfacingStatus } from "../../../src/lib/contracts/message-surfacing.js";
import type {
	GetModelsResponse,
	GetSessionSkillsResponseSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import type { RpcMockControl } from "../../../test/e2e/helpers/rpc-mock.js";
import type { WsMockControl } from "../../../test/e2e/helpers/ws-mock.js";

export const relayControls = new WeakMap<Page, WsMockControl>();
export const rpcControls = new WeakMap<Page, RpcMockControl>();
/** Explicit opt-in for the surfacing acceptance scenarios. */
export const mockMessageSurfacing = new WeakMap<Page, MessageSurfacingStatus>();
export const effortOptions = new WeakMap<Page, string[]>();
/** Quota reads made while the fixture seeds a draft through the picker. */
export const pickerFixtureQuotaReads = new WeakMap<Page, number>();
export const rejectedEffortSwitches = new WeakSet<Page>();
export const detailFeeds = new WeakMap<Page, RpcMockControl["detailFeed"]>();
/** How long the mock app takes to answer CreateSession, in ms. */
export const createSessionDelays = new WeakMap<Page, number>();
export const inheritedClaudeCommitAttribution = "Inherited commit attribution";
/** GetSessionSkills loads served by the mock app; empty unless a scenario seeds them. */
export const mockSessionSkills = new WeakMap<
	Page,
	(typeof GetSessionSkillsResponseSchema.Type)["loads"]
>();
/** Per-page mock instance list — mutated by the Add/Update/Remove RPC handlers
 *  so the SettingsPanel editor and the composer rail see consistent state. */
export const mockInstances = new WeakMap<
	Page,
	Array<Record<string, unknown>>
>();

/** Mirror the relay's makeInstanceId slugging so rail test ids stay stable. */
/** Waits for CSS transitions, such as a phone drop-down gliding in, so geometry reads its resting place. */
export async function settleTransitions(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// A transition replaced mid-flight rejects `finished`; wait on its successor instead.
		for (let round = 0; round < 10; round += 1) {
			const moving = document
				.getAnimations()
				.filter(
					(animation) =>
						animation instanceof CSSTransition &&
						animation.playState === "running",
				);
			if (moving.length === 0) return;
			await Promise.allSettled(moving.map((animation) => animation.finished));
		}
	});
}

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

/** Publish Claude's live catalog and refetch OpenCode's catalog. */
export async function serveModelCatalog(
	page: Page,
	response: Omit<GetModelsResponse, "projectSlug">,
): Promise<void> {
	const rpc = requireRpcControl(page);
	const previous = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
	rpc.setStubs({
		GetModels: async (payload) => {
			const binding =
				"sessionId" in payload ? await previous(payload) : undefined;
			const instanceId =
				!("sessionId" in payload) && typeof payload["instanceId"] === "string"
					? payload["instanceId"]
					: undefined;
			const claude = mockInstances
				.get(page)
				?.some(
					(instance) =>
						instance["id"] === instanceId && instance["driver"] === "claude",
				);
			const row =
				"sessionId" in payload
					? rpc.shellRows?.find(
							(row) => isRecord(row) && row["id"] === payload.sessionId,
						)
					: undefined;
			const catalogAccountId =
				instanceId ??
				binding?.instanceId ??
				(isRecord(row) ? row["accountId"] : undefined) ??
				(!("sessionId" in payload)
					? mockInstances
							.get(page)
							?.find(
								(instance) =>
									instance["driver"] === "claude" &&
									instance["isDefault"] === true,
							)?.["id"]
					: undefined);
			if (
				typeof catalogAccountId === "string" &&
				mockInstances
					.get(page)
					?.some(
						(instance) =>
							instance["id"] === catalogAccountId &&
							instance["driver"] === "claude",
					)
			)
				rpc.setProjectSetting({
					_tag: "providerModels",
					accountId: catalogAccountId,
					providers: response.providers.filter(
						(provider) => provider.id === "claude",
					),
				});
			return {
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "myapp",
				...(typeof binding === "object" && binding !== null ? binding : {}),
				...response,
				...(response.variant && binding?.variant
					? {
							variant: {
								...response.variant,
								variant: binding.variant.variant,
							},
						}
					: {}),
				...(instanceId
					? {
							instanceId,
							active:
								(response.active?.provider === "claude") === Boolean(claude)
									? response.active
									: undefined,
						}
					: {}),
				providers: claude
					? response.providers.filter((provider) => provider.id === "claude")
					: response.providers.filter((provider) => provider.id !== "claude"),
			};
		},
	});
	rpc.setProjectSetting({
		_tag: "providerModels",
		providers: response.providers.filter(
			(provider) => provider.id === "claude",
		),
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
		// One locator, not a count-then-pick: a tier change can swap the triggers mid-step.
		await page
			.getByTestId(
				/^(composer-harness-trigger|model-picker-trigger|composer-word-model|composer-words-sheet-trigger)$/,
			)
			.first()
			.click();
		const sheet = page.getByTestId("composer-more-sheet");
		if (await sheet.isVisible())
			await page.getByTestId("composer-more-model").click();
	}
	await picker.waitFor({ state: "visible", timeout: 5_000 });
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
	await page.getByTestId("picker-row-model").waitFor({ state: "visible" });
}

export async function openComposerMoreSheet(page: Page): Promise<void> {
	const sheet = page.getByTestId("composer-more-sheet");
	if (!(await sheet.isVisible()))
		await page
			.getByTestId(/^(model-picker-trigger|composer-words-sheet-trigger)$/)
			.click();
	await expect(sheet).toBeVisible();
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
