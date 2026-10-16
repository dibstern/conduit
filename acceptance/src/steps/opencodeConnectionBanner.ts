import { expect } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockInstances,
	openModelPicker,
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

export const opencodeConnectionBannerHandlers: StepHandler[] = [
	{
		name: "seed persisted session instance during an outage",
		match:
			/^the (Claude|OpenCode) session is persisted on instance (\S+)( as the first OpenCode instance)? with another instance healthy$/,
		run: ({ world, match }) => {
			const name = match[1] ?? "";
			const instanceId = match[2] ?? "";
			const rpc = requireRpcControl(world.page);
			rpc.upsertShellRow({
				id: `sess-banner-${name.toLowerCase()}`,
				accountId: instanceId,
				title: `${name} session`,
				status: "idle",
				projectSlug: "myapp",
				updatedAt: PINNED_CLOCK_MS,
				resumes: [{ at: PINNED_CLOCK_MS, instanceId, reason: "user" }],
			});
			rpc.setDaemonList("SubscribeInstances", {
				// The relay drives the first OpenCode instance in the list.
				instances: (match[3]
					? [instanceId, "healthy-oc"]
					: ["healthy-oc", instanceId]
				).map((id) => ({
					id,
					name: id,
					driver:
						id === instanceId && name === "Claude" ? "claude" : "opencode",
					port: 0,
					managed: false,
					status: id === instanceId ? "unhealthy" : "healthy",
					restartCount: 0,
					createdAt: PINNED_CLOCK_MS,
				})),
			});
		},
	},
	{
		name: "seed sessions for both providers",
		match: /^the mock relay has Claude and OpenCode sessions$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "shell_snapshot",
				roots: true,
				sessions: ["Claude", "OpenCode"].map((name) => ({
					id: `sess-banner-${name.toLowerCase()}`,
					accountId: name.toLowerCase(),
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
			/^I view the (Claude|OpenCode) session( with an OpenCode project default| on instance (\S+))?( with rejected agent discovery)?$/,
		run: async ({ world, match }) => {
			const name = match[1] ?? "";
			const sessionId = `sess-banner-${name.toLowerCase()}`;
			const claude = name === "Claude";
			const rpc = requireRpcControl(world.page);
			if (match[3]) {
				const instanceId = match[3];
				setSessionRowStatus(world.page, sessionId, "idle", {
					accountId: instanceId,
				});
				const { instances } = rpc.initialDaemonList(
					"SubscribeInstances",
				)[0] as {
					instances: Record<string, unknown>[];
				};
				if (!instances.some((instance) => instance["id"] === instanceId)) {
					rpc.setDaemonList("SubscribeInstances", {
						instances: [
							...instances,
							{
								id: instanceId,
								name: instanceId,
								driver: claude ? "claude" : "opencode",
								isDefault: false,
								usageEligible: claude,
								port: 0,
								managed: false,
								status: "healthy",
								restartCount: 0,
								createdAt: PINNED_CLOCK_MS,
							},
						],
					});
				}
			}
			if (match[2] === " with an OpenCode project default") {
				rpc.setProjectSetting({
					_tag: "defaultModel",
					model: "claude-sonnet-4",
					provider: "anthropic",
					variant: "",
				});
			}
			rpc.setStubs({
				GetModels: () => ({
					defaultOpenCodeInstanceId: "opencode",
					projectSlug: "myapp",
					instanceId: match[3] ?? (claude ? "claude" : "opencode"),
					providers: dualDriverProviders.filter(
						(provider) => provider.id !== "claude",
					),
					active: {
						model: claude ? "claude-opus-4-1" : "claude-sonnet-4",
						provider: claude ? "claude" : "anthropic",
					},
					variant: { variant: "", variants: [] },
					contextWindow: { contextWindow: "", options: [] },
				}),
			});
			const agents = {
				projectSlug: "myapp",
				...(match[3] ? { instanceId: match[3] } : {}),
				providerScope: { id: claude ? "claude" : "opencode", name },
				agents: [],
			};
			let rejected = false;
			if (match[4]) {
				rpc.setStubs({
					GetAgents: (payload) => {
						if (payload["sessionId"] === sessionId) {
							rejected = true;
							throw new WsRpcError({
								message: "OpenCode agent discovery is unavailable",
							});
						}
						return agents;
					},
				});
			} else {
				rpc.setStubs({ GetAgents: () => agents });
			}
			await world.page
				.locator(`[data-session-id="${sessionId}"]`)
				.press("Enter");
			await expect(world.page).toHaveURL(
				(url) => url.pathname === `/s/${sessionId}`,
			);
			await expect(world.page.getByTestId("session-bar-title")).toHaveText(
				`${name} session`,
			);
			if (match[4]) await expect.poll(() => rejected).toBe(true);
		},
	},
	{
		name: "reject session creation on the selected instance",
		match: /^creating a session on instance (\S+) fails with (.+)$/,
		run: async ({ world, match }) => {
			const instanceId = match[1] ?? "";
			const rpc = requireRpcControl(world.page);
			const { instances } = rpc.initialDaemonList("SubscribeInstances")[0] as {
				instances: Record<string, unknown>[];
			};
			rpc.setDaemonList("SubscribeInstances", {
				instances: [
					...instances.filter((instance) => instance["id"] !== instanceId),
					{
						id: instanceId,
						name: instanceId,
						driver: "opencode",
						isDefault: false,
						usageEligible: false,
						port: 0,
						managed: false,
						status: "unhealthy",
						restartCount: 0,
						createdAt: PINNED_CLOCK_MS,
					},
				],
			});
			rpc.setHandler("CreateSession", (payload) => {
				expect(payload["instanceId"]).toBe(instanceId);
				throw new WsRpcError({ message: match[2] ?? "" });
			});
			await openModelPicker(world.page);
			await world.page.getByTestId("picker-harness-opencode").click();
			await world.page.getByTestId(`picker-account-${instanceId}`).click();
			await world.page
				.getByTestId("picker-row-model")
				.waitFor({ state: "visible" });
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert session creation cause in composer toast",
		match: /^an error toast contains (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.getByRole("alert")
				.filter({ hasText: match[1] ?? "" });
			await expect(toast).toBeVisible();
			await expect(toast).toHaveAttribute("aria-live", "assertive");
		},
	},
	{
		name: "assert creation failure preserves the composer draft",
		match: /^the composer still contains (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "assert unrelated instance health warning absent",
		match: /^the generic instance health warning is not visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('[data-banner-id="no-healthy-instances"]'),
			).toBeHidden();
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
