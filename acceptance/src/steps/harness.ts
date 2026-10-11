import { expect, type Page } from "@playwright/test";
import { DESKTOP_VIEWPORT, PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openModelPicker,
	openSessionRoute,
	requireRpcControl,
} from "./shared.js";

const heldAccountSwitches = new WeakMap<Page, () => void>();

const harnessLogo = (page: Page, region: string, account: string) =>
	page
		.locator(region === "composer" ? "#input-area" : "#model-picker")
		.locator(`[data-testid="harness-logo"][data-account="${account}"]`)
		.first();

/** Map a harness/instance display label (e.g. "OpenCode · Local") to the
 *  default instance id of its driver. */
function instanceIdForLabel(label: string): string {
	const driverName = (label.split("·")[0] ?? label).trim().toLowerCase();
	if (driverName !== "claude" && driverName !== "opencode") {
		throw new Error(`Unknown harness/instance label: ${label}`);
	}
	return driverName;
}

async function selectHarnessTab(page: Page, label: string): Promise<void> {
	await openModelPicker(page);
	await page.getByTestId(`picker-harness-${label.toLowerCase()}`).click();
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
		name: "start a new session",
		match: /^I start a new session$/,
		run: async ({ world }) => {
			// Phones show the session list until a session or draft is open.
			const newSession = world.page.locator("#new-session-btn:visible");
			if (!(await newSession.isVisible())) {
				await world.page.getByTestId("session-bar-back").click();
			}
			await newSession.click();
			await world.page
				.locator("#input-wrapper")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
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
				// Name, not duration: an earlier visual step freezes durations to 0s.
				await expect(badge).not.toHaveCSS("animation-name", "none");
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
		name: "select Harness tab",
		match:
			/^I select the (Claude|OpenCode|Codex|Gemini|Cursor) Harness tab in the picker$/,
		run: async ({ world, match }) => {
			await selectHarnessTab(world.page, match[1] ?? "");
		},
	},
	{
		name: "select harness",
		match: /^I select the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			await selectHarnessTab(world.page, match[1] ?? "");
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
		name: "assert Harness tab selected and in view",
		match:
			/^the (Claude|OpenCode|Codex|Gemini|Cursor) Harness tab is selected and in view$/,
		run: async ({ world, match }) => {
			const tab = world.page.getByTestId(
				`picker-harness-${(match[1] ?? "").toLowerCase()}`,
			);
			await expect(tab).toHaveAttribute("role", "radio");
			await expect(tab).toHaveAttribute("aria-checked", "true");
			await expect(tab).toBeVisible();
			await expect
				.poll(() =>
					tab.evaluate((element) => {
						const row = element.closest(
							'[data-testid="picker-harness-options"]',
						);
						if (!row) return false;
						const bounds = row.getBoundingClientRect();
						const item = element.getBoundingClientRect();
						return (
							item.left >= bounds.left - 1 && item.right <= bounds.right + 1
						);
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "assert other Harness tabs locked with accessible reason",
		match: /^the other Harness tabs are locked and announce (.+)$/,
		run: async ({ world, match }) => {
			const section = world.page.getByTestId("picker-harness-section");
			await expect(section).toContainText("fixed for this session");
			const selected = section.getByRole("radio", { checked: true });
			await expect(selected).not.toHaveAttribute("aria-disabled", "true");
			await expect(selected).toHaveCSS("opacity", "1");
			const others = section.getByRole("radio", { checked: false });
			const count = await others.count();
			expect(count).toBeGreaterThan(0);
			for (let index = 0; index < count; index++) {
				const tab = others.nth(index);
				await expect(tab).toHaveAttribute("aria-disabled", "true");
				await expect(tab).toHaveAccessibleDescription(match[1] ?? "");
				await expect(tab).toHaveCSS("opacity", "0.5");
			}
		},
	},
	{
		name: "move between Harness tabs with arrow keys",
		match: /^I move to the next Harness with the keyboard$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("picker-harness-options")
				.getByRole("radio", { checked: true })
				.focus();
			await world.page.keyboard.press("ArrowRight");
		},
	},
	{
		name: "assert draft project instance binding",
		match: /^the draft is bound to the (\S+) instance$/,
		run: async ({ world, match }) => {
			const instanceId = match[1] ?? "";
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetProjectInstance" &&
					request.payload["slug"] === "myapp" &&
					request.payload["instanceId"] === instanceId,
			);
			await expect(
				world.page.getByTestId("model-picker-trigger").first(),
			).toHaveAttribute("data-instance-id", instanceId);
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
