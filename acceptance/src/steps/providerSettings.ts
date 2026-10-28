import { expect, type Page } from "@playwright/test";
import type { OpenCodeInstance } from "../../../src/lib/frontend/types.js";
import type { StepHandler } from "../runtime.js";
import { mockInstances, requireRpcControl } from "./shared.js";

function directory(): OpenCodeInstance[] {
	const account = (
		id: string,
		driver: string,
		extra: Partial<OpenCodeInstance> = {},
	): OpenCodeInstance => ({
		id,
		name: id,
		driver,
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 1,
		...extra,
	});
	return [
		account("personal", "claude", {
			colorSlot: 0,
			configDir: "~/.claude",
			isDefault: true,
		}),
		account("work", "claude", { colorSlot: 1, configDir: "~/.claude-work" }),
		account("codex", "codex", { colorSlot: 2, isDefault: true }),
		account("codex-lab", "codex", {
			name: "lab",
			colorSlot: 3,
			available: false,
			unavailableCode: "auth_required",
		}),
		account("cursor", "cursor", { colorSlot: 4, isDefault: true }),
		account("local", "opencode", {
			port: 4098,
			managed: true,
			isDefault: true,
		}),
		account("ccs", "opencode", { port: 4099 }),
		account("gpu-box", "opencode", {
			port: 4100,
			managed: true,
			status: "stopped",
		}),
	];
}

function publish(page: Page, instances: OpenCodeInstance[]): void {
	mockInstances.set(
		page,
		instances.map((account) => ({ ...account })),
	);
	requireRpcControl(page).setDaemonList("SubscribeInstances", { instances });
}

const row = (page: Page, id: string) =>
	page.getByTestId(`provider-account-${id}`);
const list = (page: Page) =>
	page.getByRole("region", { name: "Provider accounts", exact: true });
const detail = (page: Page) =>
	page.getByRole("region", { name: "Account detail", exact: true });

export const providerSettingsHandlers: StepHandler[] = [
	{
		name: "seed the approved Providers directory",
		match: /^Providers has the approved account directory$/,
		run: ({ world }) => {
			publish(world.page, directory());
			requireRpcControl(world.page).setUsageReadings([
				{
					accountId: "personal",
					harness: "claude",
					planLabel: "Max",
					status: "available",
					windows: [],
					readAt: Date.now(),
					stale: false,
				},
				{
					accountId: "codex",
					harness: "codex",
					planLabel: "Plus",
					status: "available",
					windows: [],
					readAt: Date.now(),
					stale: false,
				},
				{
					accountId: "cursor",
					harness: "cursor",
					planLabel: "Pro",
					status: "available",
					windows: [],
					readAt: Date.now(),
					stale: false,
				},
			]);
		},
	},
	{
		name: "open Providers settings",
		match: /^I open settings to the Providers section$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "providers" },
					}),
				),
			);
			await expect(list(world.page)).toBeVisible();
		},
	},
	{
		name: "assert provider cards and row copy",
		match:
			/^Providers lists Claude, Codex, Cursor and OpenCode in order with account counts$/,
		run: async ({ world }) => {
			await expect(
				list(world.page).getByRole("heading", { level: 3 }),
			).toHaveText(["Claude", "Codex", "Cursor", "OpenCode"]);
			await expect(
				list(world.page).getByTestId("provider-account-count"),
			).toHaveText(["2", "2", "1", "3"]);
			await expect(row(world.page, "personal")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			for (const [id, copy] of [
				["personal", "Max · default"],
				["codex", "Plus · default"],
				["cursor", "Pro · default"],
				["local", ":4098 · default"],
				["ccs", ":4099 · discovered"],
				["gpu-box", ":4100 · stopped"],
			])
				await expect(row(world.page, id ?? "")).toContainText(copy ?? "");
		},
	},
	{
		name: "assert provider hero identity",
		match: /^the Providers detail shows (.+) with (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				detail(world.page).getByRole("heading", {
					name: match[1] ?? "",
					exact: true,
				}),
			).toBeVisible();
			for (const text of (match[2] ?? "").split(" and "))
				await expect(detail(world.page)).toContainText(text);
		},
	},
	{
		name: "select an account in Providers",
		match: /^I pick the Providers account (.+)$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "").click();
		},
	},
	{
		name: "assert amber signed-out Codex row",
		match: /^the Codex lab row says Not signed in in amber$/,
		run: async ({ world }) => {
			await expect(
				row(world.page, "codex-lab").getByText("Not signed in", {
					exact: true,
				}),
			).toHaveClass(/text-warning/);
		},
	},
	{
		name: "assert read-only Providers scope",
		match: /^Providers has no account actions, quota, models or defaults$/,
		run: async ({ world }) => {
			const tab = world.page.getByTestId("providers-settings");
			await expect(
				tab.getByRole("button", {
					name: /^(Add|Scan|Edit|Remove|Start|Stop|Sign in)/,
				}),
			).toHaveCount(0);
			await expect(tab.getByRole("switch")).toHaveCount(0);
			await expect(
				tab.getByText(/^(Quota|Models|New sessions start on|Session titles)$/),
			).toHaveCount(0);
		},
	},
	{
		name: "assert global settings width and retained Instances",
		match:
			/^every settings tab uses the wider dialog and Server keeps Instances$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#settings-panel");
			expect((await panel.boundingBox())?.width).toBe(1020);
			for (const tab of ["general", "models", "server", "providers"]) {
				await world.page.getByTestId(`settings-tab-${tab}`).click();
				expect((await panel.boundingBox())?.width).toBe(1020);
				if (tab === "server")
					await expect(world.page.locator("#instances-settings")).toBeVisible();
			}
			const order = await world.page
				.getByRole("tablist", { name: "Settings sections" })
				.getByRole("tab")
				.evaluateAll((elements) =>
					elements.map((element) => element.getAttribute("data-testid")),
				);
			expect(order.indexOf("settings-tab-providers") + 1).toBe(
				order.indexOf("settings-tab-models"),
			);
		},
	},
	{
		name: "assert empty Providers explanations",
		match: /^Providers explains its empty cards and empty selection$/,
		run: async ({ world }) => {
			for (const text of [
				"No Claude accounts configured.",
				"No Codex accounts configured.",
				"Cursor is not installed.",
				"No OpenCode servers configured.",
				"Pick or add an account to see its details.",
			])
				await expect(world.page.getByText(text, { exact: true })).toBeVisible();
		},
	},
	{
		name: "publish external account changes",
		match: /^another device adds, renames and removes provider accounts$/,
		run: ({ world }) => {
			const accounts = directory().filter(
				(account) => account.id !== "personal",
			);
			const work = accounts[0];
			if (!work) throw new Error("Missing work fixture");
			work.name = "renamed work";
			publish(world.page, [
				...accounts,
				{ ...work, id: "new-claude", name: "new account" },
			]);
		},
	},
	{
		name: "assert live Providers account changes",
		match:
			/^Providers reflects the live account changes and keeps a valid selection$/,
		run: async ({ world }) => {
			await expect(row(world.page, "personal")).toHaveCount(0);
			await expect(row(world.page, "work")).toContainText("renamed work");
			await expect(row(world.page, "new-claude")).toContainText("new account");
			await expect(detail(world.page)).toContainText("renamed work");
		},
	},
	{
		name: "publish removal of every account",
		match: /^another device removes every provider account$/,
		run: ({ world }) => {
			publish(world.page, []);
		},
	},
	{
		name: "navigate Providers with arrows and activation",
		match: /^I navigate Providers accounts with the keyboard$/,
		run: async ({ world }) => {
			await row(world.page, "personal").focus();
			await world.page.keyboard.press("ArrowDown");
			await expect(row(world.page, "work")).toBeFocused();
			await world.page.keyboard.press("ArrowDown");
			await expect(row(world.page, "codex")).toBeFocused();
			await world.page.keyboard.press("Enter");
		},
	},
	{
		name: "seed a long Providers list",
		match: /^Providers has many accounts$/,
		run: ({ world }) => {
			const accounts = directory();
			const first = accounts[0];
			if (!first) throw new Error("Missing Claude fixture");
			publish(world.page, [
				...accounts,
				...Array.from({ length: 20 }, (_, index) => ({
					...first,
					id: `claude-${index}`,
					name: `Claude ${index}`,
					isDefault: false,
				})),
			]);
		},
	},
	{
		name: "assert independent Providers scrolling",
		match:
			/^Providers has independent columns with a sticky header and a conditional fade$/,
		run: async ({ world }) => {
			const column = list(world.page);
			await expect(column).toHaveAttribute("data-more", "true");
			for (const pane of [column, detail(world.page)])
				expect(
					await pane.evaluate((element) => getComputedStyle(element).overflowY),
				).toBe("auto");
			const before = await detail(world.page).boundingBox();
			await column.evaluate((element) => {
				element.scrollTop = 100;
			});
			const header = await column
				.getByRole("heading", { name: "Claude", exact: true })
				.locator("..")
				.boundingBox();
			expect(header?.y).toBeCloseTo((await column.boundingBox())?.y ?? 0, 0);
			expect(await detail(world.page).boundingBox()).toEqual(before);
			await column.evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await expect(column).toHaveAttribute("data-more", "false");
		},
	},
	{
		name: "assert phone Providers list page",
		match: /^the phone Providers page shows the account list only$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("heading", { name: "Providers", exact: true }),
			).toBeVisible();
			await expect(list(world.page)).toBeVisible();
			await expect(detail(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert pushed phone Providers detail",
		match:
			/^the phone Providers detail is titled lab with a back button to Providers$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#settings-panel-title")).toHaveText(
				"lab",
			);
			await expect(
				world.page.getByRole("button", {
					name: "Back to Providers",
					exact: true,
				}),
			).toBeFocused();
			await expect(list(world.page)).toHaveCount(0);
			await expect(detail(world.page)).toContainText("Codex login");
		},
	},
	{
		name: "return from phone account detail",
		match: /^I return from the Providers detail$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Back to Providers", exact: true })
				.click();
			await expect(row(world.page, "codex-lab")).toBeFocused();
		},
	},
];
