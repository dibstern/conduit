import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	instanceSlug,
	mockInstances,
	openModelPicker,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const usageLimits = (autoResume: boolean) => ({
	usageLimits: { autoResume, autoSwitch: false, order: [] },
});

export const providerInstancesHandlers: StepHandler[] = [
	{
		name: "seed the daemon's usage limit setting",
		match: /^auto-resume limited sessions is (on|off) on the daemon$/,
		run: ({ world, match }) => {
			const on = match[1] === "on";
			const rpc = requireRpcControl(world.page);
			rpc.setResponse("GetUsageLimitsSetting", usageLimits(on));
			rpc.setResponse("SetUsageLimitsSetting", usageLimits(!on));
		},
	},
	{
		name: "assert the usage limit settings heading",
		match: /^the usage limit settings heading reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator("#usage-limit-settings-title"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert the auto-resume toggle",
		match:
			/^the Auto-resume limited sessions toggle is (on|off) and reads (.+)$/,
		run: async ({ world, match }) => {
			const toggle = world.page
				.locator("#usage-limit-settings")
				.getByRole("switch", { name: "Toggle auto-resume limited sessions" });
			await expect(toggle).toBeEnabled();
			await expect(toggle).toHaveAttribute(
				"aria-checked",
				String(match[1] === "on"),
			);
			await expect(toggle).toContainText("Auto-resume limited sessions");
			await expect(toggle).toContainText(match[2] ?? "");
		},
	},
	{
		name: "turn on auto-resume",
		match: /^I turn on Auto-resume limited sessions$/,
		run: async ({ world }) => {
			await world.page
				.locator("#usage-limit-settings")
				.getByRole("switch", { name: "Toggle auto-resume limited sessions" })
				.click();
		},
	},
	{
		name: "assert SetUsageLimitsSetting RPC",
		match: /^the SetUsageLimitsSetting RPC turns auto-resume on$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "SetUsageLimitsSetting",
			);
			expect(request.payload).toMatchObject(usageLimits(true));
		},
	},
	{
		name: "open settings to instances tab",
		match: /^I open settings to the Instances tab$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { tab: "instances" } }),
				),
			);
			await page
				.locator("#settings-panel")
				.waitFor({ state: "visible", timeout: 5_000 });
			// A phone opens straight into the section, with the list hidden.
			const tab = page.getByTestId("settings-tab-instances");
			if (await tab.isVisible()) await tab.click();
			await page
				.locator("#instances-settings")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "start adding a driver instance",
		match: /^I start adding a (OpenCode|Claude) instance$/,
		run: async ({ world, match }) => {
			const driverName = (match[1] ?? "").toLowerCase();
			await world.page.getByTestId("add-instance-btn").click();
			await world.page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await world.page
				.getByTestId(`instance-form-driver-${driverName}`)
				.click();
		},
	},
	{
		name: "add a named instance",
		match: /^I add an? (OpenCode|Claude) instance named (.+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const driverName = (match[1] ?? "").toLowerCase();
			const name = (match[2] ?? "").trim();
			await page.getByTestId("add-instance-btn").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId(`instance-form-driver-${driverName}`).click();
			await page.getByTestId("instance-form-name").fill(name);
			await page.getByTestId("instance-form-save").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "hidden", timeout: 5_000 });
			// Close settings so the composer/model-picker is interactable next.
			await page.getByTestId("settings-close-btn").click();
			await page
				.locator("#settings-panel")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "named instance already configured",
		match: /^a named (OpenCode|Claude) instance (.+) is already configured$/,
		run: async ({ world, match }) => {
			const driverName = (match[1] ?? "").toLowerCase();
			const name = (match[2] ?? "").trim();
			const inst: Record<string, unknown> = {
				id: instanceSlug(name),
				name,
				port: driverName === "opencode" ? 4099 : 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				driver: driverName,
				...(driverName === "claude" ? { configDir: "/profiles/seed" } : {}),
			};
			// Seed BOTH the mock RPC store (so edit/remove RPCs stay consistent)
			// and the live frontend state (via the mocked SubscribeInstances list).
			const list = [...(mockInstances.get(world.page) ?? []), inst];
			mockInstances.set(world.page, list);
			await requireRelayControl(world.page).sendMessages([
				{ type: "instance_list", instances: list },
			]);
		},
	},
	{
		name: "rename instance via edit",
		match: /^I rename the (.+) instance to (.+) via edit$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = instanceSlug((match[1] ?? "").trim());
			const to = (match[2] ?? "").trim();
			await page.getByTestId(`instance-row-${id}`).click();
			await page.getByTestId("edit-instance-btn").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("instance-form-name").fill(to);
			await page.getByTestId("instance-form-save").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "remove instance from settings",
		match: /^I remove the (.+) instance$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = instanceSlug((match[1] ?? "").trim());
			await page.getByTestId(`instance-row-${id}`).click();
			await page.getByTestId("remove-instance-btn").click();
			await page
				.locator("#confirm-modal")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("confirm-modal-action").click();
			await page
				.locator("#confirm-modal")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "instances list shows name",
		match: /^the Instances list shows (.+)$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await world.page
				.locator("#instance-settings-list")
				.getByText(name, { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "instances list does not show name",
		match: /^the Instances list does not show (.+)$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await world.page.waitForFunction(
				(n) => {
					const list = document.querySelector("#instance-settings-list");
					return list ? !(list.textContent ?? "").includes(n) : true;
				},
				name,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "instance is selectable in the rail",
		match: /^the (.+) instance is selectable in the rail$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await openModelPicker(world.page);
			await world.page.getByTestId("picker-row-harness").click();
			// Harness buttons keep the instance's slug id across picker views.
			const railButton = world.page.getByTestId(
				`picker-instance-${instanceSlug(name)}`,
			);
			await railButton.waitFor({ state: "visible", timeout: 5_000 });
			const disabled = await railButton.getAttribute("aria-disabled");
			if (disabled === "true") {
				throw new Error(`Rail instance "${name}" is present but disabled`);
			}
		},
	},
];
