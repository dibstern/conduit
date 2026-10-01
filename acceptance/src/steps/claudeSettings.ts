import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import type { StepHandler } from "../runtime.js";
import {
	inheritedClaudeCommitAttribution,
	openSessionRoute,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const claudeSettingsSessionId = "sess-claude-settings";

export const claudeSettingsHandlers: StepHandler[] = [
	{
		name: "scroll claude settings to the attribution row",
		match: /^I scroll the Claude settings to the Attribution row$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-attribution")
				.scrollIntoViewIfNeeded();
		},
	},
	{
		name: "set claude settings session active",
		match: /^the Claude settings session is active$/,
		run: async ({ world }) => {
			await openSessionRoute(world.page, claudeSettingsSessionId);
		},
	},
	{
		name: "set default approval mode to ask",
		match: /^the default approval mode is Ask$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "default_permission_mode_info",
				mode: "ask",
			});
		},
	},
	{
		name: "set default model and thinking level",
		match:
			/^the default model is Claude Sonnet 4 with a thinking level of high$/,
		run: async ({ world }) => {
			await requireRelayControl(world.page).sendMessages([
				{
					type: "model_list",
					providers: dualDriverProviders.map((provider) => ({
						...provider,
						models: provider.models.map((model) =>
							model.id === "claude-sonnet-4"
								? { ...model, name: "Claude Sonnet 4" }
								: model,
						),
					})),
				},
				{
					type: "default_model_info",
					model: "claude-sonnet-4",
					provider: "anthropic",
					variant: "high",
				},
			]);
		},
	},
	{
		name: "open settings to claude tab",
		match: /^I open settings to the Claude tab$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { tab: "claude" } }),
				),
			);
			await page
				.locator("#settings-panel")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("settings-tab-claude").click();
			await page
				.getByTestId("claude-setting-autoCompactEnabled")
				.waitFor({ state: "visible", timeout: 5_000 });
			const rpcControl = requireRpcControl(page);
			await rpcControl.waitForRequest(
				(request) => request.tag === "GetClaudeSettings",
			);
			await rpcControl.waitForRequest(
				(request) => request.tag === "ResolveClaudeSettings",
			);
		},
	},
	{
		name: "press reload this session",
		match: /^I press Reload this session$/,
		run: async ({ world }) => {
			await world.page.getByTestId("claude-settings-reload-session").click();
		},
	},
	{
		name: "assert reload provider session rpc",
		match: /^a ReloadProviderSession RPC is sent for the active session$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "ReloadProviderSession" &&
					request.payload["sessionId"] === claudeSettingsSessionId,
			);
		},
	},
	{
		name: "assert default model display name",
		match: /^the default model row shows Claude Sonnet 4$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultModel-select")
				.waitFor({ state: "visible", timeout: 5_000 });
			await world.page.waitForFunction(
				`document.querySelector('[data-testid="claude-setting-defaultModel-select"]')?.selectedOptions[0]?.textContent?.trim() === "Claude Sonnet 4"`,
				undefined,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "choose a default model",
		match: /^I choose claude-opus-4-1 as the default model$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultModel-select")
				.selectOption("claude/claude-opus-4-1");
		},
	},
	{
		name: "assert set default model rpc",
		match: /^a SetDefaultModel RPC is sent for claude-opus-4-1$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetDefaultModel" &&
					request.payload["model"] === "claude-opus-4-1" &&
					request.payload["provider"] === "claude",
			);
		},
	},
	{
		name: "choose auto as default approval mode",
		match: /^I choose Auto as the default approval mode$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultPermissionMode-select")
				.selectOption({ label: "Auto" });
		},
	},
	{
		name: "assert default approval mode is auto",
		match: /^the default approval mode is Auto$/,
		run: async ({ world }) => {
			await world.page.waitForFunction(
				`document.querySelector('[data-testid="claude-setting-defaultPermissionMode-select"]')?.value === "auto"`,
				undefined,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert default model thinking level",
		match: /^the default model row shows Thinking level: high$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultModel-thinking")
				.getByText("Thinking level: high", { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "choose full access as default approval mode",
		match: /^I choose Full access as the default approval mode$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultPermissionMode-select")
				.selectOption({ label: "Full access" });
		},
	},
	{
		name: "assert set default permission mode rpc",
		match: /^a SetDefaultPermissionMode RPC is sent with mode (\w+)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetDefaultPermissionMode" &&
					request.payload["mode"] === mode,
			);
		},
	},
	{
		name: "assert default approval warning",
		match:
			/^the default approval mode row shows the elevated-permissions warning$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-defaultPermissionMode")
				.getByText("New sessions will start with elevated permissions.", {
					exact: true,
				})
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "claude settings shown",
		match: /^the Claude settings are shown$/,
		run: async ({ world }) => {
			await world.page
				.getByText(
					"Claude reads these when a session starts. A session that's already running keeps the settings it started with until you reload it.",
					{ exact: true },
				)
				.waitFor({ state: "visible", timeout: 5_000 });
			await world.page
				.getByTestId("claude-setting-autoCompactWindow")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "toggle claude auto compact",
		match: /^I toggle Claude auto-compact$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-autoCompactEnabled")
				.getByRole("switch")
				.click();
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetClaudeSettings" &&
					(
						request.payload["overrides"] as Record<string, unknown> | undefined
					)?.["autoCompactEnabled"] === false,
			);
		},
	},
	{
		name: "auto compact provenance text",
		match: /^the auto-compact provenance reads (.+)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("claude-setting-autoCompactEnabled-provenance")
				.getByText(match[1] ?? "", { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "reset claude auto compact",
		match: /^I reset the Claude auto-compact setting$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-autoCompactEnabled-reset")
				.click();
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetClaudeSettings" &&
					!(
						"autoCompactEnabled" in
						((request.payload["overrides"] as Record<string, unknown>) ?? {})
					),
			);
		},
	},
	{
		name: "managed claude threshold disabled",
		match: /^the managed auto-compact threshold is disabled$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-autoCompactWindow-input")
				.waitFor({ state: "visible", timeout: 5_000 });
			if (
				!(await world.page
					.getByTestId("claude-setting-autoCompactWindow-input")
					.isDisabled())
			) {
				throw new Error("Managed auto-compact threshold remained editable");
			}
			await world.page
				.getByTestId("claude-setting-autoCompactWindow-provenance")
				.getByText("Locked by managed policy", { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "turn off claude hooks and status line",
		match: /^I turn off Claude hooks and status line$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-disableAllHooks")
				.getByRole("switch")
				.click();
		},
	},
	{
		name: "disable all hooks stored as true",
		match: /^disableAllHooks is stored as true$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetClaudeSettings" &&
					(
						request.payload["overrides"] as Record<string, unknown> | undefined
					)?.["disableAllHooks"] === true,
			);
		},
	},
	{
		name: "claude hooks and status line toggle reads off",
		match: /^the Claude hooks and status line toggle reads off$/,
		run: async ({ world }) => {
			const toggle = world.page
				.getByTestId("claude-setting-disableAllHooks")
				.getByRole("switch");
			if ((await toggle.getAttribute("aria-checked")) !== "false") {
				throw new Error("Hooks and status line toggle did not read as off");
			}
		},
	},
	{
		name: "turn off claude attribution session link",
		match: /^I turn off the Claude attribution session link$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-setting-attribution")
				.getByRole("switch")
				.click();
		},
	},
	{
		name: "attribution override preserves inherited commit text",
		match:
			/^the attribution override keeps the inherited commit text with the session link off$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest((request) => {
				if (request.tag !== "SetClaudeSettings") return false;
				const overrides = request.payload["overrides"];
				if (typeof overrides !== "object" || overrides === null) return false;
				const attribution = (overrides as Record<string, unknown>)[
					"attribution"
				];
				if (
					typeof attribution !== "object" ||
					attribution === null ||
					Array.isArray(attribution)
				) {
					return false;
				}
				const fields = attribution as Record<string, unknown>;
				return (
					fields["commit"] === inheritedClaudeCommitAttribution &&
					fields["sessionUrl"] === false
				);
			});
		},
	},
];
