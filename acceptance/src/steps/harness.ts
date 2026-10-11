import { expect, type Page } from "@playwright/test";
import { DESKTOP_VIEWPORT, PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	exampleValue,
	openModelPicker,
	openSessionRoute,
	requireRpcControl,
} from "./shared.js";

const heldAccountSwitches = new WeakMap<Page, () => void>();

const harnessLogo = (page: Page, region: string, account: string) =>
	page
		.locator(region === "composer" ? "#input-area" : "#model-picker")
		.locator(`[data-testid="harness-logo"][data-account="${account}"]`);

/** Map a harness/instance display label (e.g. "OpenCode · Local") to the
 *  default instance id of its driver. */
function instanceIdForLabel(label: string): string {
	const driverName = (label.split("·")[0] ?? label).trim().toLowerCase();
	if (driverName !== "claude" && driverName !== "opencode") {
		throw new Error(`Unknown harness/instance label: ${label}`);
	}
	return driverName;
}

async function selectRailInstance(page: Page, label: string): Promise<void> {
	await openModelPicker(page);
	await page.getByTestId("picker-row-harness").click();
	await page
		.getByTestId(`picker-instance-${instanceIdForLabel(label)}`)
		.click();
	await page.getByTestId("picker-row-model").waitFor({ state: "visible" });
}

async function openPickerAgentView(page: Page): Promise<void> {
	const choices = page.locator('#model-picker [data-testid^="picker-agent-"]');
	if ((await choices.count()) === 0) {
		await openModelPicker(page);
		await page.getByTestId("picker-row-agent").click();
	}
	await choices.first().waitFor({ state: "visible", timeout: 5_000 });
}

export const harnessHandlers: StepHandler[] = [
	{
		name: "set harness logo tier",
		match: /^the harness logo is viewed in the (wide|narrow|phone) tier$/,
		run: async ({ world, match }) => {
			const tier = match[1];
			await world.driver.setViewport(
				world.page,
				tier === "phone" ? PHONE_VIEWPORT : DESKTOP_VIEWPORT,
			);
			if (tier === "narrow") {
				await world.page.locator("#input-wrapper").evaluate((element) => {
					element.style.width = "520px";
				});
			}
		},
	},
	{
		name: "choose composer controls for harness logo",
		match: /^the composer uses (icons|words) controls$/,
		run: async ({ world, match }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("settings:open")),
			);
			await world.page.getByTestId("settings-tab-composer").click();
			await world.page
				.getByTestId(`settings-composer-controls-${match[1]}`)
				.click();
			await world.page.getByTestId("settings-close-btn").click();
			await expect(world.page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "assert harness logo has no badge",
		match: /^the (composer|picker) harness logo for (\S+) has no badge$/,
		run: async ({ world, match }) => {
			const logo = harnessLogo(world.page, match[1] ?? "", match[2] ?? "");
			await expect(logo).toBeVisible();
			await expect(logo.getByTestId("harness-logo-badge")).toHaveCount(0);
		},
	},
	{
		name: "assert harness logo badge letter",
		match:
			/^the (composer|picker) harness logo for (\S+) shows (\S) on its badge$/,
		run: async ({ world, match }) => {
			const badge = harnessLogo(
				world.page,
				match[1] ?? "",
				match[2] ?? "",
			).getByTestId("harness-logo-badge");
			await expect(badge).toBeVisible();
			await expect(badge).toHaveAttribute("data-account", match[2] ?? "");
			await expect(badge).toHaveText(match[3] ?? "");
			await expect(badge).toHaveAttribute("data-state", "idle");
		},
	},
	{
		name: "assert harness badge matches AccountDot",
		match:
			/^the (composer|picker) harness badge for (\S+) matches its AccountDot colour$/,
		run: async ({ world, match }) => {
			const account = match[2] ?? "";
			const dot = world.page
				.locator(`[data-testid="account-dot"][data-account="${account}"]`)
				.first();
			await expect(dot).toBeVisible();
			const colour = await dot.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			);
			await expect(
				harnessLogo(world.page, match[1] ?? "", account).getByTestId(
					"harness-logo-badge",
				),
			).toHaveCSS("background-color", colour);
		},
	},
	{
		name: "hold account switch reply",
		match: /^the account switch reply is held$/,
		run: ({ world }) => {
			const reply = new Promise<{ ok: true }>((resolve) => {
				heldAccountSwitches.set(world.page, () => resolve({ ok: true }));
			});
			requireRpcControl(world.page).setHandler("ContinueSession", () => reply);
		},
	},
	{
		name: "release account switch reply",
		match: /^the account switch reply lands$/,
		run: ({ world }) => {
			const release = heldAccountSwitches.get(world.page);
			if (!release) throw new Error("No account switch reply is held");
			release();
			heldAccountSwitches.delete(world.page);
		},
	},
	{
		name: "assert harness badge switch state",
		match: /^the (composer|picker) harness badge for (\S+) is (spinning|idle)$/,
		run: async ({ world, match }) => {
			const badge = harnessLogo(
				world.page,
				match[1] ?? "",
				match[2] ?? "",
			).getByTestId("harness-logo-badge");
			await expect(badge).toBeVisible();
			await expect(badge).toHaveAttribute("data-state", match[3] ?? "");
			if (match[3] === "spinning") {
				await expect(badge).toHaveText("");
				await expect(badge).toHaveCSS("animation-duration", "0.8s");
			}
		},
	},
	{
		name: "session exists on harness",
		match: /^a session already exists on the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			const harness = match[1] ?? "";
			const claude = instanceIdForLabel(harness) === "claude";
			const sessionId = claude ? "sess-bound-claude" : "sess-bound-opencode";
			const rpc = requireRpcControl(world.page);
			// A real session has a shell row; its turn ends ride on it.
			if (
				!rpc.shellRows?.some((row) => (row as { id?: string }).id === sessionId)
			)
				rpc.upsertShellRow({
					id: sessionId,
					title: `${harness} session`,
					status: "idle",
					updatedAt: Date.now(),
				});
			const previousRequests = rpc.getRequests().length;
			await openSessionRoute(world.page, sessionId);
			// The session's GetModels reply binds the trigger to its harness.
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.slice(previousRequests)
						.some(
							(request) =>
								request.tag === "GetModels" &&
								request.payload["sessionId"] === sessionId,
						),
				)
				.toBe(true);
			await expect(
				world.page.getByTestId("model-picker-trigger").first(),
			).toHaveAttribute("data-instance-id", instanceIdForLabel(harness));
		},
	},
	{
		name: "open model picker",
		match: /^I open the model picker$/,
		run: async ({ world }) => {
			await openModelPicker(world.page);
		},
	},
	{
		name: "select instance in rail",
		match: /^I select the (.+) instance in the rail$/,
		run: async ({ world, match }) => {
			await selectRailInstance(world.page, match[1] ?? "");
		},
	},
	{
		name: "select harness",
		match: /^I select the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			await selectRailInstance(world.page, match[1] ?? "");
			// Close the picker so follow-up steps interact with the toolbar.
			await world.page.keyboard.press("Escape");
			await world.page
				.locator("#model-picker")
				.waitFor({ state: "detached", timeout: 5_000 });
		},
	},
	{
		name: "assert session created on harness",
		match: /^a session is created on the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			const expected = instanceIdForLabel(match[1] ?? "");
			const rpcControl = requireRpcControl(world.page);
			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "CreateSession" &&
					request.payload["instanceId"] === expected,
			);
		},
	},
	{
		name: "assert model trigger instance icon",
		match: /^the model trigger shows the (Claude|OpenCode) instance icon$/,
		run: async ({ world, match }) => {
			await world.page.waitForFunction(
				(expected) => {
					const trigger = document.querySelector(
						'[data-testid="model-picker-trigger"]',
					);
					const icon = trigger?.querySelector("[data-driver]");
					return (
						trigger?.getAttribute("data-instance-id") === expected &&
						icon?.getAttribute("data-driver") === expected
					);
				},
				instanceIdForLabel(match[1] ?? ""),
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert rail instance selected",
		match: /^the (Claude|OpenCode) instance in the rail is selected$/,
		run: async ({ world, match }) => {
			const id = instanceIdForLabel(match[1] ?? "");
			await world.page.waitForFunction(
				(instanceId) => {
					const button = document.querySelector(
						`[data-testid="picker-instance-${instanceId}"]`,
					);
					return button?.getAttribute("aria-pressed") === "true";
				},
				id,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert other harness instances disabled",
		match: /^instances of other harnesses in the rail are disabled$/,
		run: async ({ world, example }) => {
			const bound = instanceIdForLabel(exampleValue(example, "harness"));
			const result = await world.page.evaluate((boundId) => {
				const buttons = Array.from(
					document.querySelectorAll('[data-testid^="picker-instance-"]'),
				);
				const others = buttons.filter(
					(b) => b.getAttribute("data-driver") !== boundId,
				);
				return {
					otherCount: others.length,
					allDisabled: others.every(
						(b) => b.getAttribute("aria-disabled") === "true",
					),
				};
			}, bound);
			if (result.otherCount === 0) {
				throw new Error("No other-harness instances rendered in the rail");
			}
			if (!result.allDisabled) {
				throw new Error(
					"Expected all other-harness rail instances to be disabled",
				);
			}
		},
	},
	{
		name: "assert agent selector lists agents",
		match: /^the agent selector lists (.+)$/,
		run: async ({ world, match }) => {
			await openPickerAgentView(world.page);
			const agentIds = (match[1] ?? "").split(",").map((id) => id.trim());
			for (const agentId of agentIds) {
				await world.page
					.locator(`[data-testid="picker-agent-${agentId}"]`)
					.waitFor({ state: "visible", timeout: 5_000 });
			}
		},
	},
	{
		name: "assert agent selector does not list agents",
		match: /^the agent selector does not list (.+)$/,
		run: async ({ world, match }) => {
			await openPickerAgentView(world.page);
			const agentIds = (match[1] ?? "").split(",").map((id) => id.trim());
			await world.page.waitForFunction(
				(ids) =>
					ids.every(
						(id) =>
							document.querySelector(`[data-testid="picker-agent-${id}"]`) ===
							null,
					),
				agentIds,
				{ timeout: 5_000 },
			);
		},
	},
];
