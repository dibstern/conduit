import { expect, type Page } from "@playwright/test";
import type { UsageLimitsSetting } from "../../../src/lib/contracts/limit-recovery.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { MOCK_SERVER_STATUS } from "../../../test/e2e/helpers/rpc-mock.js";
import type { StepHandler } from "../runtime.js";
import {
	instanceSlug,
	mockInstances,
	openModelPicker,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const usageLimits = (
	autoResume: boolean,
	autoSwitch = false,
	order: string[] = [],
	warnAt: UsageLimitsSetting["warnAt"] = 80,
) => ({
	usageLimits: { autoResume, autoSwitch, order, warnAt },
});

/** The daemon saves what it is sent and answers with it. */
export function seedUsageLimits(
	page: Page,
	setting: ReturnType<typeof usageLimits>,
): void {
	const rpc = requireRpcControl(page);
	rpc.setResponse("GetUsageLimitsSetting", setting);
	rpc.setHandler("SetUsageLimitsSetting", (params) => {
		rpc.setResponse("GetUsageLimitsSetting", params);
		return params;
	});
}

const usageLimitToggles = {
	"Auto-resume limited sessions": "Toggle auto-resume limited sessions",
	"Auto-switch account": "Toggle auto-switch account when limited",
} as const;

const usageLimitToggle = (page: Page, label: string) =>
	page.locator("#usage-limit-settings").getByRole("switch", {
		name: usageLimitToggles[label as keyof typeof usageLimitToggles],
	});

const listOf = (list: string) => (list === "none" ? [] : list.split(", "));

export const providerInstancesHandlers: StepHandler[] = [
	{
		name: "seed the daemon's usage limit setting",
		match: /^auto-resume limited sessions is (on|off) on the daemon$/,
		run: ({ world, match }) => {
			seedUsageLimits(world.page, usageLimits(match[1] === "on"));
		},
	},
	{
		name: "seed the daemon's whole usage limit setting",
		match:
			/^the daemon's usage limits are auto-resume (on|off), auto-switch (on|off), order (.+)$/,
		run: ({ world, match }) => {
			seedUsageLimits(
				world.page,
				usageLimits(
					match[1] === "on",
					match[2] === "on",
					listOf(match[3] ?? ""),
				),
			);
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
		name: "assert a usage limit toggle",
		match:
			/^the (Auto-resume limited sessions|Auto-switch account) toggle is (on|off) and reads (.+)$/,
		run: async ({ world, match }) => {
			const toggle = usageLimitToggle(world.page, match[1] ?? "");
			await expect(toggle).toBeEnabled();
			await expect(toggle).toHaveAttribute(
				"aria-checked",
				String(match[2] === "on"),
			);
			await expect(toggle).toContainText(match[1] ?? "");
			await expect(toggle).toContainText(match[3] ?? "");
		},
	},
	{
		name: "turn on a usage limit toggle",
		match: /^I turn on (Auto-resume limited sessions|Auto-switch account)$/,
		run: async ({ world, match }) => {
			await usageLimitToggle(world.page, match[1] ?? "").click();
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
		name: "assert a whole SetUsageLimitsSetting RPC",
		match:
			/^the SetUsageLimitsSetting RPC saves auto-resume (on|off), auto-switch (on|off), order (.+)$/,
		run: async ({ world, match }) => {
			const expected = usageLimits(
				match[1] === "on",
				match[2] === "on",
				listOf(match[3] ?? ""),
			).usageLimits;
			const seen: unknown[] = [];
			await requireRpcControl(world.page)
				.waitForRequest((candidate) => {
					if (candidate.tag !== "SetUsageLimitsSetting") return false;
					seen.push(candidate.payload);
					const saved = candidate.payload["usageLimits"] as
						| UsageLimitsSetting
						| undefined;
					return (
						saved?.autoResume === expected.autoResume &&
						saved.autoSwitch === expected.autoSwitch &&
						saved.warnAt === expected.warnAt &&
						JSON.stringify(saved.order) === JSON.stringify(expected.order)
					);
				})
				.catch(() => {
					throw new Error(
						`No SetUsageLimitsSetting saved ${JSON.stringify(expected)}; saw ${JSON.stringify(seen.slice(-3))}`,
					);
				});
		},
	},
	{
		name: "assert the auto-switch account order",
		match: /^the account order reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.locator("#usage-settings")
					.getByTestId("usage-limit-account-name"),
			).toHaveText(listOf(match[1] ?? ""));
		},
	},
	{
		name: "assert an account row's quota",
		match: /^the account (.+) shows (.+) quota$/,
		run: async ({ world, match }) => {
			const row = world.page
				.locator("#usage-settings")
				.getByTestId("sortable-row")
				.filter({ hasText: match[1] ?? "" });
			await expect(
				row.locator('[data-testid^="usage-settings-status-"]'),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "move an account to the top of the order",
		match: /^I move (.+) to the top of the account order by (keyboard|touch)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const section = page.locator("#usage-settings");
			const handle = section.getByRole("button", {
				name: `Reorder ${match[1]}`,
			});
			const names = await section
				.getByTestId("usage-limit-account-name")
				.allTextContents();
			const index = names.indexOf(match[1] ?? "");
			if (index < 0) throw new Error(`No account row named ${match[1]}`);
			if (match[2] === "keyboard") {
				await handle.focus();
				await page.keyboard.press("Space");
				for (let step = 0; step < index; step++)
					await page.keyboard.press("ArrowUp");
				await page.keyboard.press("Space");
				return;
			}
			const [from, top] = await Promise.all([
				handle.boundingBox(),
				section.getByTestId("sortable-row").first().boundingBox(),
			]);
			if (!from || !top) throw new Error("No handle or first row box");
			const x = from.x + from.width / 2;
			const startY = from.y + from.height / 2;
			// Past the list top: a tall card must carry its centre above a short first card's.
			const endY = Math.max(4, top.y - 40);
			const touch = await page.context().newCDPSession(page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x, y: startY }],
				});
				for (let step = 1; step <= 8; step++)
					await touch.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: [{ x, y: startY + ((endY - startY) * step) / 8 }],
					});
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await touch.detach();
			}
		},
	},
	{
		name: "assert the account order announcement",
		match: /^the account order announces (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("sortable-announcement")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "open settings to Server",
		match: /^I open settings to the Server section$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "server" },
					}),
				),
			);
			await page
				.locator("#settings-panel")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page
				.locator("#instances-settings")
				.waitFor({ state: "visible", timeout: 5_000 });
			await expect(page.getByTestId("server-status-version")).toBeVisible();
		},
	},
	{
		name: "seed daemon supervision",
		match: /^the daemon is (supervised|unsupervised)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setResponse("GetStatus", {
				...MOCK_SERVER_STATUS,
				supervised: match[1] === "supervised",
			});
		},
	},
	{
		name: "assert Server status",
		match:
			/^the Server card shows uptime, version, port and connected browsers$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("server-status-uptime")).toHaveText(
				"up 3d 4h",
			);
			await expect(world.page.getByTestId("server-status-version")).toHaveText(
				"0.42.1",
			);
			await expect(world.page.getByTestId("server-status-port")).toHaveText(
				"port 2633",
			);
			await expect(world.page.getByTestId("server-status-browsers")).toHaveText(
				"2 browsers connected",
			);
		},
	},
	{
		name: "assert Restart visibility",
		match: /^Server Restart is (visible|hidden)$/,
		run: async ({ world, match }) => {
			const restart = world.page.getByTestId("server-restart-btn");
			if (match[1] === "visible") await expect(restart).toBeVisible();
			else await expect(restart).toHaveCount(0);
		},
	},
	{
		name: "open Server shutdown confirmation",
		match: /^I open the Server Shut down confirmation$/,
		run: async ({ world }) => {
			await world.page.getByTestId("server-shutdown-btn").click();
			await expect(
				world.page.getByTestId("server-shutdown-cancel"),
			).toBeFocused();
		},
	},
	{
		name: "assert shutdown warning",
		match: /^the Server Shut down warning says (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("server-shutdown-confirmation"),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "cancel Server shutdown confirmation",
		match: /^I cancel the Server Shut down confirmation$/,
		run: async ({ world }) => {
			await world.page.getByTestId("server-shutdown-cancel").click();
			await expect(
				world.page.getByTestId("server-shutdown-confirmation"),
			).toBeHidden();
		},
	},
	{
		name: "assert the instance editor closes for another Server form",
		match: /^the Server instance editor is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("instance-form")).toBeHidden();
		},
	},
	{
		name: "start adding a driver instance",
		match: /^I start adding an? (OpenCode|Claude) instance$/,
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
		name: "seed OpenCode empty state with a Claude account and CCS",
		match: /^no OpenCode servers are configured and CCS is detected$/,
		run: async ({ world }) => {
			const list = [
				{
					id: "claude",
					name: "Personal Claude",
					driver: "claude",
					isDefault: true,
					usageEligible: true,
					configDir: "~/.claude",
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(world.page, list);
			requireRpcControl(world.page).setResponse("DetectProxy", {
				found: true,
				port: 8317,
			});
			await requireRelayControl(world.page).sendMessages([
				{ type: "instance_list", instances: list },
			]);
		},
	},
	{
		name: "assert OpenCode empty state",
		match: /^the OpenCode empty state offers the serve command and Scan link$/,
		run: async ({ world }) => {
			const empty = world.page.getByTestId("opencode-empty-state");
			await expect(empty).toContainText("No OpenCode servers yet.");
			await expect(empty).toContainText("opencode serve --port 4098");
			await expect(empty.getByTestId("scan-now-link")).toBeVisible();
			await expect(
				world.page.getByTestId("claude-accounts-list"),
			).toContainText("Personal Claude");
		},
	},
	{
		name: "assert collapsed setup guides with CCS detection",
		match: /^the OpenCode setup guides are collapsed with the CCS tick$/,
		run: async ({ world }) => {
			const guides = world.page.getByTestId("opencode-setup-guides");
			await expect(guides.getByRole("button").first()).toHaveAttribute(
				"aria-expanded",
				"false",
			);
			await expect(guides).toContainText("CCS ✓");
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "DetectProxy",
			);
			expect(request.payload["projectSlug"]).toBeUndefined();
		},
	},
	{
		name: "assert managed OpenCode editor fields",
		match:
			/^the OpenCode editor offers name and port with environment variables collapsed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("instance-form-managed"),
			).toHaveAttribute("aria-checked", "true");
			await expect(world.page.getByTestId("instance-form-name")).toBeVisible();
			await expect(world.page.getByTestId("instance-form-port")).toBeVisible();
			await expect(world.page.getByTestId("instance-form-env")).toHaveCount(0);
			await expect(world.page.getByTestId("instance-form-url")).toHaveCount(0);
		},
	},
	{
		name: "expand instance environment variables",
		match: /^I expand the instance environment variables$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: /Environment variables/ })
				.click();
		},
	},
	{
		name: "assert instance environment field",
		match: /^the instance environment field is visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("instance-form-env")).toBeVisible();
		},
	},
	{
		name: "connect to an externally started OpenCode server",
		match: /^I turn off Conduit starts it$/,
		run: async ({ world }) => {
			await world.page.getByTestId("instance-form-managed").click();
		},
	},
	{
		name: "assert external OpenCode editor fields",
		match: /^the OpenCode editor offers name and URL$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("instance-form-name")).toBeVisible();
			await expect(world.page.getByTestId("instance-form-url")).toBeVisible();
			await expect(world.page.getByTestId("instance-form-port")).toHaveCount(0);
			await expect(world.page.getByTestId("instance-form-env")).toHaveCount(0);
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
			if (driverName === "opencode") {
				await page.getByTestId("instance-form-managed").click();
				await page
					.getByTestId("instance-form-url")
					.fill("http://127.0.0.1:4099");
			}
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
				usageEligible: driverName === "claude",
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
			const row = page.getByTestId(`instance-row-${id}`);
			await row.getByRole("button").first().click();
			await row.getByTestId("edit-instance-btn").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await expect(page.getByRole("radiogroup", { name: "Type" })).toHaveCount(
				0,
			);
			await page.getByTestId("instance-form-name").fill(to);
			await page.getByTestId("instance-form-save").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "seed the default Claude account",
		match: /^the default Claude account is named (.+) with folder (.+)$/,
		run: async ({ world, match }) => {
			const id = AccountIdSchema.make("claude");
			const list = [
				...(mockInstances.get(world.page) ?? []).filter(
					(instance) => instance["id"] !== id,
				),
				{
					id,
					name: match[1] ?? "",
					configDir: match[2] ?? "",
					driver: "claude",
					isDefault: true,
					usageEligible: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(world.page, list);
			await requireRelayControl(world.page).sendMessages([
				{ type: "instance_list", instances: list },
			]);
		},
	},
	{
		name: "make a Claude account default",
		match: /^I make the (.+) account default$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId(
				`instance-row-${instanceSlug(match[1] ?? "")}`,
			);
			await row.getByRole("button").first().click();
			await row.getByTestId("make-default-btn").click();
			await expect(row.getByTestId("default-account-marker")).toBeVisible();
		},
	},
	{
		name: "assert exactly one default Claude account",
		match: /^only the (.+) Claude account has the default marker$/,
		run: async ({ world, match }) => {
			const list = world.page.getByTestId("claude-accounts-list");
			await expect(list.getByTestId("default-account-marker")).toHaveCount(1);
			await expect(
				list
					.getByTestId(`instance-row-${instanceSlug(match[1] ?? "")}`)
					.getByTestId("default-account-marker"),
			).toBeVisible();
		},
	},
	{
		name: "assert the default mutation uses daemon RPC",
		match: /^SetDefault saves (.+) as the default account$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "SetDefault",
			);
			expect(request.payload).toMatchObject({
				instanceId: instanceSlug(match[1] ?? ""),
			});
			expect(request.payload).not.toHaveProperty("projectSlug");
		},
	},
	{
		name: "seed a Claude model for unpicked drafts",
		match: /^new drafts use a Claude model$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setResponse("GetModels", {
				projectSlug: "myapp",
				providers: [],
				active: { model: "claude-sonnet-4-5", provider: "claude" },
			});
			rpc.setProjectSetting({
				_tag: "defaultModel",
				model: "claude-sonnet-4-5",
				provider: "claude",
				variant: "",
			});
			rpc.setDaemonList("SubscribeUsage", {
				readings: (mockInstances.get(world.page) ?? [])
					.filter((instance) => instance["driver"] === "claude")
					.map((instance) => ({
						accountId: instance["id"],
						harness: "claude",
						status: "available",
						windows: [{ kind: "five_hour", utilization: 20 }],
						readAt: Date.now(),
						stale: false,
					})),
			});
		},
	},
	{
		name: "assert the draft composer and usage meter agree",
		match: /^the draft composer and usage meter use the (.+) account$/,
		run: async ({ world, match }) => {
			const id = instanceSlug(match[1] ?? "");
			await expect(
				world.page
					.locator('#input-area [data-testid="harness-logo"]:visible')
					.first(),
			).toHaveAttribute("data-account", id);
			await expect(
				world.page.getByTestId(`usage-footer-row-${id}`),
			).toHaveAttribute("data-default", "true");
		},
	},
	{
		name: "assert the picker selects the default account",
		match: /^the picker selects the (.+) account$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(
					`picker-account-${instanceSlug(match[1] ?? "")}`,
				),
			).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "assert the new draft is created on its effective account",
		match: /^the new session is created on the (.+) account$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				instanceId: instanceSlug(match[1] ?? ""),
			});
		},
	},
	{
		name: "open the shared default Claude editor",
		match: /^I edit the default Claude account$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId(
				`instance-row-${AccountIdSchema.make("claude")}`,
			);
			await row.getByRole("button").first().click();
			await row.getByTestId("edit-instance-btn").click();
			await expect(world.page.getByTestId("instance-form-name")).toBeFocused();
		},
	},
	{
		name: "assert the default Claude edit fields and restart notice",
		match: /^the default Claude editor shows name (.+) and folder (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("instance-form-name")).toHaveValue(
				match[1] ?? "",
			);
			await expect(
				world.page.getByTestId("instance-form-configdir"),
			).toHaveValue(match[2] ?? "");
			await expect(world.page.getByTestId("instance-form")).toContainText(
				"Folder changes apply after restart",
			);
			await expect(
				world.page.getByRole("radiogroup", { name: "Type" }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the default Claude account has no Remove action",
		match: /^the default Claude account cannot be removed$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId(
				`instance-row-${AccountIdSchema.make("claude")}`,
			);
			await expect(row.getByTestId("remove-instance-btn")).toHaveCount(0);
			await expect(row).toContainText("The default account can't be removed");
		},
	},
	{
		name: "save the default Claude account through the shared form",
		match: /^I save the default Claude account as (.+) with folder (.+)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId("instance-form-name").fill(match[1] ?? "");
			await world.page
				.getByTestId("instance-form-configdir")
				.fill(match[2] === "empty" ? "" : (match[2] ?? ""));
			await world.page.getByTestId("instance-form-save").click();
			await expect(world.page.getByTestId("instance-form")).toBeHidden();
		},
	},
	{
		name: "assert the saved default Claude folder and restart copy",
		match:
			/^the default Claude account shows folder (.+) with Applies after restart$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId(
				`instance-row-${AccountIdSchema.make("claude")}`,
			);
			await row.getByRole("button").first().click();
			await expect(row).toContainText(match[1] ?? "");
			await expect(row).toContainText("Applies after restart");
		},
	},
	{
		name: "assert UpdateInstance sends the default account's name and folder",
		match:
			/^UpdateInstance saves the default Claude name (.+) and folder (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "UpdateInstance",
			);
			expect(request.payload).toMatchObject({
				instanceId: AccountIdSchema.make("claude"),
				name: match[1] ?? "",
				configDir: match[2] === "empty" ? "" : (match[2] ?? ""),
			});
			expect(request.payload).not.toHaveProperty("projectSlug");
		},
	},
	{
		name: "remove instance from settings",
		match: /^I remove the (.+) instance$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = instanceSlug((match[1] ?? "").trim());
			const row = page.getByTestId(`instance-row-${id}`);
			await row.getByRole("button").first().click();
			await row.getByTestId("remove-instance-btn").click();
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
		name: "instance is selectable in the picker",
		match: /^the (.+) instance is selectable in the picker$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await openModelPicker(world.page);
			const instance = mockInstances
				.get(world.page)
				?.find((candidate) => candidate["id"] === instanceSlug(name));
			if (!instance) throw new Error(`Mock instance "${name}" is missing`);
			await world.page
				.getByTestId(`picker-harness-${instance["driver"]}`)
				.click();
			const railButton = world.page.getByTestId(
				`picker-account-${instanceSlug(name)}`,
			);
			await railButton.waitFor({ state: "visible", timeout: 5_000 });
			const disabled = await railButton.getAttribute("aria-disabled");
			if (disabled === "true") {
				throw new Error(`Rail instance "${name}" is present but disabled`);
			}
		},
	},
];
