import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import type { StepHandler } from "../runtime.js";
import {
	inheritedClaudeCommitAttribution,
	openSessionRoute,
	requireRpcControl,
	serveModelCatalog,
	setSessionRowStatus,
} from "./shared.js";

const claudeSettingsSessionId = "sess-claude-settings";

export const claudeSettingsHandlers: StepHandler[] = [
	{
		name: "assert claude attribution is collapsed with its fixed summary",
		match:
			/^the Claude Attribution group is collapsed with summary "Commit · PR · Session link"$/,
		run: async ({ world }) => {
			const disclosure = world.page
				.getByTestId("claude-attribution-group")
				.getByRole("button", {
					name: "Attribution Commit · PR · Session link",
					exact: true,
				});
			await disclosure.waitFor({ state: "visible", timeout: 5_000 });
			if ((await disclosure.getAttribute("aria-expanded")) !== "false") {
				throw new Error("Claude Attribution was not collapsed by default");
			}
			await world.page
				.getByTestId("claude-setting-attribution")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "expand claude attribution group",
		match: /^I expand the Claude Attribution group$/,
		run: async ({ world }) => {
			const group = world.page.getByTestId("claude-attribution-group");
			await group
				.getByRole("button", {
					name: "Attribution Commit · PR · Session link",
					exact: true,
				})
				.click();
			await group
				.locator('button[aria-expanded="true"]')
				.waitFor({ state: "visible", timeout: 5_000 });
			await group
				.getByTestId("claude-setting-attribution-commit-input")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "scroll claude settings to the attribution row",
		match: /^I scroll the Claude settings to the Attribution row$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("claude-attribution-group")
				.scrollIntoViewIfNeeded();
		},
	},
	{
		name: "set claude settings session active",
		match: /^the Claude settings session is active$/,
		run: async ({ world }) => {
			await openSessionRoute(world.page, claudeSettingsSessionId);
			// The server publishes the session's resolved account.
			setSessionRowStatus(world.page, claudeSettingsSessionId, "idle", {
				accountId: "claude",
			});
		},
	},
	{
		name: "set default approval mode to ask",
		match: /^the default approval mode is Ask$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setProjectSetting({
				_tag: "defaultPermissionMode",
				mode: "ask",
			});
		},
	},
	{
		name: "set default model and thinking level",
		match:
			/^the default model is Claude Sonnet 4 with a thinking level of high$/,
		run: async ({ world }) => {
			await serveModelCatalog(world.page, {
				providers: dualDriverProviders.map((provider) => ({
					...provider,
					models: provider.models.map((model) =>
						model.id === "claude-sonnet-4-5"
							? { ...model, name: "Claude Sonnet 4", variants: ["high"] }
							: model,
					),
				})),
				active: { model: "claude-sonnet-4", provider: "anthropic" },
			});
			requireRpcControl(world.page).setProjectSetting({
				_tag: "harnessDefaults",
				claude: {
					pick: {
						providerId: "claude",
						modelId: "claude-sonnet-4-5",
						effort: "high",
						contextWindow: "",
					},
					status: "ok",
				},
				opencode: { status: "missing" },
			});
			requireRpcControl(world.page).setHandler(
				"SwitchModel",
				({ projectSlug, providerId, modelId }) => ({
					projectSlug,
					provider: providerId,
					model: modelId,
					variant: "",
					variants: [],
				}),
			);
			requireRpcControl(world.page).setHandler(
				"SetHarnessDefault",
				({
					projectSlug,
					harness,
					providerId,
					modelId,
					effort,
					contextWindow,
				}) => ({
					projectSlug,
					harness,
					state: {
						pick: { providerId, modelId, effort, contextWindow },
						status: "ok",
					},
				}),
			);
		},
	},
	{
		name: "open settings to models and agents section",
		match: /^I open settings to the Models & agents section$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { section: "models" } }),
				),
			);
			await world.page
				.getByTestId("settings-harness-default-claude-model")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "open settings to claude section",
		match: /^I open settings to the Claude section$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { section: "claude" } }),
				),
			);
			await page
				.locator("#settings-panel")
				.waitFor({ state: "visible", timeout: 5_000 });
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
				.getByTestId("settings-harness-default-claude-model")
				.waitFor({ state: "visible", timeout: 5_000 });
			await world.page.waitForFunction(
				`document.querySelector('[data-testid="settings-harness-default-claude-model"]')?.selectedOptions[0]?.textContent?.trim() === "Claude Sonnet 4"`,
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
				.getByTestId("settings-harness-default-claude-model")
				.selectOption("claude/claude-opus-4-1");
		},
	},
	{
		name: "assert set harness default rpc",
		match: /^a SetHarnessDefault RPC is sent for claude-opus-4-1$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetHarnessDefault" &&
					request.payload["harness"] === "claude" &&
					request.payload["modelId"] === "claude-opus-4-1" &&
					request.payload["providerId"] === "claude",
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
			await world.page.waitForFunction(
				`document.querySelector('[data-testid="settings-harness-default-claude-effort"]')?.value === "high"`,
				undefined,
				{ timeout: 5_000 },
			);
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
