import { expect, type Page } from "@playwright/test";
import { DESKTOP_VIEWPORT, PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockInstances,
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
		name: "register Cursor discovery",
		match:
			/^a Cursor account is (available with its live models|unavailable with reason (.+))$/,
		run: ({ world, match }) => {
			const available = match[1] === "available with its live models";
			const instances = [
				...(mockInstances.get(world.page) ?? []),
				{
					id: "cursor-work",
					name: "Cursor work",
					driver: "cursor",
					isDefault: true,
					usageEligible: false,
					available,
					...(available ? {} : { unavailableReason: match[2] }),
					configDir: "/tmp/cursor-work",
					port: 0,
					managed: false,
					status: available ? "healthy" : "stopped",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(world.page, instances);
			const rpc = requireRpcControl(world.page);
			rpc.setDaemonList("SubscribeInstances", { instances });
			if (!available) return;
			// Mirrors publishDiscoveredModels: one account-scoped Cursor catalogue.
			rpc.setProjectSetting({
				_tag: "providerModels",
				accountId: "cursor-work",
				providers: [
					{
						id: "cursor",
						name: "Cursor",
						configured: true,
						models: [
							{ id: "composer-2.5", name: "Composer 2.5", provider: "cursor" },
							{ id: "grok-4.7", name: "Grok 4.7", provider: "cursor" },
						],
					},
				],
			});
			const getModels = rpc.getResponseHandler("GetModels");
			rpc.setHandler("GetModels", (payload, request) =>
				payload["instanceId"] === "cursor-work"
					? { projectSlug: "myapp", instanceId: "cursor-work", providers: [] }
					: getModels?.(payload, request),
			);
			const getAgents = rpc.getResponseHandler("GetAgents");
			rpc.setHandler("GetAgents", (payload, request) =>
				payload["instanceId"] === "cursor-work"
					? {
							projectSlug: "myapp",
							instanceId: "cursor-work",
							providerScope: { id: "cursor", name: "Cursor" },
							agents: [],
						}
					: getAgents?.(payload, request),
			);
		},
	},
	{
		name: "assert available Cursor provider rail",
		match: /^the Cursor provider rail choice is available$/,
		run: async ({ world }) => {
			const choice = world.page.getByTestId("picker-harness-cursor");
			await expect(choice).toBeVisible();
			await expect(choice).toHaveAccessibleName("Cursor");
			await expect(choice).toBeEnabled();
			await expect(
				world.page.getByTestId("picker-harness-cursor-unavailable"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert Cursor live model catalog",
		match: /^the Cursor model list contains exactly (.+)$/,
		run: async ({ world, match }) => {
			const models = world.page.locator("#model-picker .model-item");
			const names = (match[1] ?? "").split(", ");
			await expect(models).toHaveCount(names.length);
			for (const name of names) {
				await expect(models.filter({ hasText: name })).toBeVisible();
			}
		},
	},
	{
		name: "assert Cursor draft model binding",
		match: /^the draft composer uses Cursor with model (\S+)$/,
		run: async ({ world, match }) => {
			const trigger = world.page
				.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				)
				.first();
			await expect(trigger).toHaveAttribute("data-instance-id", "cursor-work");
			await expect(trigger).toHaveAttribute("data-shown-harness", "cursor");
			await expect(trigger).toHaveAttribute("data-shown-provider", "cursor");
			await expect(trigger).toHaveAttribute("data-shown-model", match[1] ?? "");
		},
	},
	{
		name: "assert unavailable Cursor provider rail",
		match: /^the Cursor provider rail choice is unavailable with reason (.+)$/,
		run: async ({ world, match }) => {
			const choice = world.page.getByTestId("picker-harness-cursor");
			await expect(choice).toBeVisible();
			await expect(choice).toHaveAccessibleName("Cursor");
			await expect(choice).toBeDisabled();
			await expect(choice).toHaveAccessibleDescription(match[1] ?? "");
			await expect(
				choice.locator(
					'[data-testid="harness-logo"][data-driver="cursor"] svg path',
				),
			).toHaveAttribute("fill", "currentColor");
			await expect(
				world.page.getByTestId("picker-harness-cursor-unavailable"),
			).toHaveText(`Cursor unavailable · ${match[1] ?? ""}`);
		},
	},
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
			await world.page.getByTestId("settings-tab-general").click();
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
			requireRpcControl(world.page).setStubs({ ContinueSession: () => reply });
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
					accountId: claude ? "claude" : "opencode",
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
		name: "assert composer harness trigger instance icon",
		match: /^the harness trigger shows the (Claude|OpenCode) instance icon$/,
		run: async ({ world, match }) => {
			await world.page.waitForFunction(
				(expected) => {
					const trigger = document.querySelector(
						'[data-testid="composer-harness-trigger"], [data-testid="model-picker-trigger"]',
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
		name: "assert draft instance",
		match: /^the draft is bound to the (\S+) instance$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("model-picker-trigger").first(),
			).toHaveAttribute("data-instance-id", match[1] ?? "");
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
