import { expect } from "@playwright/test";
import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

export const opencodeConnectionBannerHandlers: StepHandler[] = [
	{
		name: "seed sessions for both providers",
		match: /^the mock relay has Claude and OpenCode sessions$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "shell_snapshot",
				roots: true,
				sessions: ["Claude", "OpenCode"].map((name) => ({
					id: `sess-banner-${name.toLowerCase()}`,
					title: `${name} session`,
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS,
				})),
			});
			await expect(
				world.page.locator('[data-session-id^="sess-banner-"]'),
			).toHaveCount(2);
		},
	},
	{
		name: "view a provider session",
		match:
			/^I view the (Claude|OpenCode) session( using the OpenCode project default| on instance (\S+))?$/,
		run: async ({ world, match }) => {
			const name = match[1] ?? "";
			const sessionId = `sess-banner-${name.toLowerCase()}`;
			const claude = name === "Claude";
			const claudeModel = claude && !match[2];
			const rpc = requireRpcControl(world.page);
			rpc.setResponse("GetModels", {
				projectSlug: "myapp",
				providers: dualDriverProviders,
				active: {
					model: claudeModel ? "claude-opus-4-1" : "claude-sonnet-4",
					provider: claudeModel ? "claude" : "anthropic",
				},
			});
			rpc.setResponse("GetAgents", {
				projectSlug: "myapp",
				...(match[3] ? { instanceId: match[3] } : {}),
				providerScope: { id: claude ? "claude" : "opencode", name },
				agents: [],
			});
			await world.page
				.locator(`[data-session-id="${sessionId}"]`)
				.press("Enter");
			await expect(world.page).toHaveURL(
				(url) => url.pathname === `/s/${sessionId}`,
			);
			await expect(world.page.getByTestId("session-bar-title")).toHaveText(
				`${name} session`,
			);
		},
	},
	{
		name: "report OpenCode connection status",
		match:
			/^the mock relay reports OpenCode (stopped|starting|connected|reconnecting|failed)(?: for instance (\S+))?$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			// These facts ride the project-settings stream, which opens only once
			// the page has attached its project.
			await rpc.waitForRequest(
				(request) => request.tag === "SubscribeProjectSettings",
				15_000,
			);
			rpc.setProjectSetting({
				_tag: "opencodeConnection",
				instanceId: match[2] ?? "opencode",
				status: match[1] as
					| "stopped"
					| "starting"
					| "connected"
					| "reconnecting"
					| "failed",
			});
			// A later fact on the same stream confirms dispatch has finished,
			// so an absent-banner assertion cannot pass before the status arrives.
			rpc.setProjectSetting({ _tag: "clientCount", count: 3 });
			await expect(world.page.locator("#client-count-badge")).toHaveText("3");
			rpc.setProjectSetting({ _tag: "clientCount", count: 2 });
			await expect(world.page.locator("#client-count-badge")).toHaveText("2");
		},
	},
	{
		name: "assert OpenCode connection banner text",
		match: /^the OpenCode connection banner reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator('[data-banner-id="opencode-connection-status"]'),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert OpenCode connection banner is not a warning",
		match: /^the OpenCode connection banner is not a warning$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('[data-banner-id="opencode-connection-status"]'),
			).toHaveAttribute("data-banner-variant", "info");
		},
	},
	{
		name: "assert OpenCode connection banner absent",
		match: /^the OpenCode connection banner is not visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('[data-banner-id="opencode-connection-status"]'),
			).toBeHidden();
		},
	},
];
