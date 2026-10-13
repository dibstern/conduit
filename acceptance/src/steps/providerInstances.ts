import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { Either, Schema } from "effect";
import {
	type AccountChange,
	type AccountsState,
	accountsStateFromInstances,
	apply,
	list,
} from "../../../src/lib/account-directory.js";
import type { UsageLimitsSetting } from "../../../src/lib/contracts/limit-recovery.js";
import {
	AccountIdSchema,
	KnownProviderDriverKindSchema,
} from "../../../src/lib/contracts/provider-instance.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { isRecord } from "../../../src/lib/utils.js";
import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import { MOCK_SERVER_STATUS } from "../../../test/e2e/helpers/rpc-mock.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
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

const accountDirectories = new WeakMap<Page, AccountsState>();
const accountUsageOrders = new WeakMap<Page, string[]>();

function accountIdForName(page: Page, name: string): string {
	const id = mockInstances
		.get(page)
		?.find((instance) => instance["name"] === name)?.["id"];
	if (typeof id !== "string")
		throw new Error(`No configured account named "${name}"`);
	return id;
}

/** Keep Settings mutations faithful to the daemon's account transitions. */
function seedAccountDirectory(page: Page): void {
	const rows = mockInstances.get(page) ?? [];
	const instances = Schema.decodeUnknownSync(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				driver: KnownProviderDriverKindSchema,
				configDir: Schema.optional(Schema.String),
				env: Schema.optional(
					Schema.Record({ key: Schema.String, value: Schema.String }),
				),
				url: Schema.optional(Schema.String),
				port: Schema.optional(Schema.Number),
				managed: Schema.optional(Schema.Boolean),
			}),
		),
	)(rows);
	const defaultClaudeId = rows.find(
		(row) => row["driver"] === "claude" && row["isDefault"] === true,
	)?.["id"];
	accountDirectories.set(
		page,
		accountsStateFromInstances(
			instances,
			configuredClaudeConfigDir("/profiles/launch"),
			5,
			{
				defaultClaudeId:
					typeof defaultClaudeId === "string" ? defaultClaudeId : undefined,
				deleted: accountDirectories.get(page)?.deleted,
				usageOrder: accountUsageOrders.get(page) ?? [],
			},
		),
	);
	const rpc = requireRpcControl(page);
	const mutate = (change: AccountChange) => {
		const state = accountDirectories.get(page);
		if (!state) throw new Error("Account directory was not seeded");
		const next = Either.getOrThrowWith(
			apply(state, change, accountUsageOrders.get(page) ?? []),
			(error) => error,
		);
		accountDirectories.set(page, next);
		const instances = list(next).map((account) => ({
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1,
			...mockInstances.get(page)?.find((row) => row["id"] === account.id),
			id: account.id,
			name: account.name,
			driver: account.driver,
			isDefault: account.isDefault,
			configDir: account.configuredFolder ?? "",
			usageEligible: account.driver === "claude" && account.usageEligible,
		}));
		mockInstances.set(page, instances);
		rpc.setUsageReadings(
			list(next)
				.filter((account) => account.driver === "claude")
				.map((account) => ({
					accountId: account.id,
					harness: "claude",
					status: "available",
					windows: [{ kind: "five_hour", utilization: 20 }],
					readAt: PINNED_CLOCK_MS,
					stale: false,
				})),
		);
		return {
			instances,
			...(change._tag === "Add"
				? { addedInstanceId: next.accounts.at(-1)?.id }
				: {}),
		};
	};
	for (const tag of ["RemoveInstance", "SetDefault"] as const) {
		rpc.setHandler(tag, (payload) => {
			const id = payload["instanceId"];
			if (typeof id !== "string") throw new Error("Missing account id");
			return mutate({
				_tag: tag === "RemoveInstance" ? "Remove" : "SetDefault",
				id,
			});
		});
	}
	rpc.setHandler("AddInstance", (payload) => {
		const name = payload["name"];
		if (typeof name !== "string") throw new Error("Missing account name");
		return mutate({
			_tag: "Add",
			name,
			driver:
				typeof payload["driver"] === "string" ? payload["driver"] : undefined,
			managed:
				typeof payload["managed"] === "boolean"
					? payload["managed"]
					: undefined,
			port: typeof payload["port"] === "number" ? payload["port"] : undefined,
			url: typeof payload["url"] === "string" ? payload["url"] : undefined,
			configDir:
				typeof payload["configDir"] === "string"
					? payload["configDir"]
					: undefined,
		});
	});
	rpc.setHandler("UpdateInstance", (payload) => {
		const id = payload["instanceId"];
		if (typeof id !== "string") throw new Error("Missing account id");
		return mutate({
			_tag: "Update",
			id,
			updates: {
				name: typeof payload["name"] === "string" ? payload["name"] : undefined,
				configDir:
					typeof payload["configDir"] === "string"
						? payload["configDir"]
						: undefined,
			},
		});
	});
}

export const providerInstancesHandlers: StepHandler[] = [
	{
		name: "save the reviewed account state",
		match:
			/^the (account settings|account composer|account picker) screenshot is saved as ([a-z0-9-]+)$/,
		run: async ({ world, match }) => {
			const directory = resolve("acceptance/visual/artifacts");
			await mkdir(directory, { recursive: true });
			const region =
				match[1] === "account settings"
					? "#instances-settings"
					: match[1] === "account composer"
						? "#input-area"
						: "#model-picker";
			const path = resolve(directory, `${match[2]}.png`);
			await world.page
				.locator(region)
				.screenshot({ path, animations: "disabled" });
			world.artifacts.push(path);
		},
	},
	{
		name: "return to the session list for a terminal",
		match: /^I return to the session list for a terminal$/,
		run: async ({ world }) => {
			await world.page.goto(new URL("/?p=myapp", world.page.url()).toString());
			await expect(world.page.getByTestId("views-rail-terminal")).toBeVisible();
		},
	},
	{
		name: "open a new terminal tab",
		match: /^I open a new terminal tab$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setHandler("CreatePty", () => {
				const count = rpc
					.getRequests()
					.filter((request) => request.tag === "CreatePty").length;
				rpc.sendChunk("SubscribePtys", [
					{
						_tag: "upsert",
						item: {
							id: `terminal-${count}`,
							title: `Terminal ${count}`,
							command: "sh",
							cwd: "/myapp",
							status: "running",
							pid: count,
						},
					},
				]);
				return { ok: true };
			});
			await world.page.getByTestId("views-rail-terminal").click();
			await expect(world.page.locator("#terminal-panel .term-tab")).toHaveCount(
				1,
			);
		},
	},
	{
		name: "add another terminal tab from the panel",
		match: /^I add another terminal tab$/,
		run: async ({ world }) => {
			await world.page.locator("#terminal-panel .term-new-btn").click();
			await expect(world.page.locator("#terminal-panel .term-tab")).toHaveCount(
				2,
			);
		},
	},
	{
		name: "assert terminal account and session scope",
		match:
			/^the terminal create request carries the (Personal|Claude) account for (a draft|the viewed session)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			await rpc.waitForRequest((candidate) => candidate.tag === "CreatePty");
			const request = rpc
				.getRequests()
				.filter((candidate) => candidate.tag === "CreatePty")
				.at(-1);
			if (!request) throw new Error("No terminal create request");
			expect(request.payload["accountId"]).toBe(instanceSlug(match[1] ?? ""));
			expect(request.payload["sessionId"]).toBe(
				match[2] === "a draft" ? undefined : "sess-account-deleted",
			);
		},
	},
	{
		name: "assert sessionless terminal leaves account resolution to the server",
		match:
			/^the terminal create request leaves the account and session unspecified$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "CreatePty",
			);
			expect(request.payload["accountId"]).toBeUndefined();
			expect(request.payload["sessionId"]).toBeUndefined();
		},
	},
	{
		name: "seed an explicitly empty configured account list",
		match: /^no provider (?:accounts|instances) are configured$/,
		run: ({ world }) => {
			mockInstances.set(world.page, []);
			accountDirectories.delete(world.page);
			seedAccountDirectory(world.page);
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances: [],
			});
		},
	},
	{
		name: "seed only the configured Claude accounts",
		match: /^the configured Claude accounts are (.+) with default (.+)$/,
		run: ({ world, match }) => {
			const names =
				match[1] === "none" ? [] : (match[1] ?? "").split(/, | and /);
			const list = [
				...(mockInstances.get(world.page) ?? []).filter(
					(instance) => instance["driver"] !== "claude",
				),
				...names.map((name) => ({
					id: instanceSlug(name),
					name,
					driver: "claude",
					isDefault: name === match[2],
					usageEligible: true,
					configDir: `/profiles/${instanceSlug(name)}`,
					port: 0,
					managed: false,
					status: "unhealthy",
					restartCount: 0,
					createdAt: 1,
				})),
			];
			mockInstances.set(world.page, list);
			seedAccountDirectory(world.page);
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances: list,
			});
		},
	},
	{
		name: "seed the account removal usage order",
		match: /^account removal follows the usage order (.+)$/,
		run: ({ world, match }) => {
			const order = listOf(match[1] ?? "").map((name) =>
				accountIdForName(world.page, name),
			);
			accountUsageOrders.set(world.page, order);
			seedUsageLimits(world.page, usageLimits(false, false, order));
			seedAccountDirectory(world.page);
		},
	},
	{
		name: "assert the configured account names and order",
		match: /^the picker account names are (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("picker-account-name")).toHaveText(
				listOf(match[1] ?? ""),
			);
		},
	},
	{
		name: "assert the picker harness uses its configured account",
		match:
			/^the picker uses (Personal|OpenCode) for the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId(`picker-harness-${(match[2] ?? "").toLowerCase()}`)
					.getByTestId("harness-logo"),
			).toHaveAttribute("data-account", instanceSlug(match[1] ?? ""));
		},
	},
	{
		name: "select the remaining configured driver",
		match: /^I select the surviving OpenCode harness$/,
		run: async ({ world }) => {
			await world.page.getByTestId("picker-harness-opencode").click();
		},
	},
	{
		name: "assert the draft selected the surviving configured account",
		match: /^the draft composer selects the (OpenCode) account$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.locator('#input-area [data-testid="harness-logo"]:visible')
					.first(),
			).toHaveAttribute("data-account", instanceSlug(match[1] ?? ""));
		},
	},
	{
		name: "assert missing accounts do not create a session",
		match:
			/^no session is created(?: or message sent)? without (?:an account|a Claude account)$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(
						(request) =>
							request.tag === "CreateSession" || request.tag === "input.submit",
					),
			).toEqual([]);
		},
	},
	{
		name: "assert Settings offers an account for empty Claude",
		match: /^Settings offers Add account with no Claude accounts$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("server-settings")).toBeVisible();
			const accounts = world.page.getByTestId("claude-accounts-list");
			await expect(accounts.locator('[data-driver="claude"]')).toHaveCount(0);
			await expect(accounts.getByTestId("default-account-marker")).toHaveCount(
				0,
			);
			const empty = world.page.getByTestId("claude-empty-state");
			await expect(empty).toContainText(/No.*accounts/);
			await expect(
				empty.getByRole("button", { name: "Add account", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "assert the empty Claude draft offers an account",
		match: /^the draft composer offers Add account$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator("#input-area").getByTestId("add-claude-account-btn"),
			).toHaveText("Add account");
			await expect(
				world.page.locator(
					'#input-area [data-testid="harness-logo"][data-account="opencode"]',
				),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the empty Claude picker offers an account",
		match: /^the Claude picker offers Add account$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("picker-add-account-btn")).toHaveText(
				"Add account",
			);
			await expect(world.page.getByTestId("picker-row-agent")).toHaveCount(0);
		},
	},
	{
		name: "open Server settings from the empty Claude draft",
		match: /^I use the composer's Add account action$/,
		run: async ({ world }) => {
			await world.page.getByTestId("add-claude-account-btn").click();
			await expect(world.page.locator("#instances-settings")).toBeVisible();
		},
	},
	{
		name: "assert a restored account does not reuse a deleted id",
		match: /^the restored (.+) account has a new id$/,
		run: ({ world, match }) => {
			expect(accountIdForName(world.page, match[1] ?? "")).not.toBe(
				instanceSlug(match[1] ?? ""),
			);
		},
	},
	{
		name: "assert no manufactured former built-in account",
		match: /^no former built-in Claude account is displayed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("picker-account-claude")).toHaveCount(
				0,
			);
			await expect(
				world.page.getByTestId("usage-footer-row-claude"),
			).toHaveCount(0);
		},
	},
	{
		name: "publish a deleted session's effective account",
		match:
			/^(?:a deleted-account session is published on|the deleted-account session is published on) (Personal|Claude)( after a default change)?$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const accountId = instanceSlug(match[1] ?? "");
			const previous = rpc.shellRows?.find(
				(row) => isRecord(row) && row["id"] === "sess-account-deleted",
			);
			if (match[2]) {
				const list = (mockInstances.get(world.page) ?? []).map((instance) =>
					instance["driver"] === "claude"
						? { ...instance, isDefault: instance["id"] === accountId }
						: instance,
				);
				mockInstances.set(world.page, list);
				rpc.setDaemonList("SubscribeInstances", { instances: list });
			}
			rpc.setResponse("GetModels", {
				projectSlug: "myapp",
				providers: [],
				active: { model: "claude-sonnet-4-5", provider: "claude" },
			});
			rpc.setResponse("GetAgents", {
				projectSlug: "myapp",
				instanceId: accountId,
				providerScope: { id: "claude", name: "Claude" },
				agents: [],
			});
			rpc.upsertShellRow({
				...(isRecord(previous) ? previous : {}),
				id: "sess-account-deleted",
				title: "Deleted account history",
				status: "idle",
				projectSlug: "myapp",
				accountId,
				updatedAt: PINNED_CLOCK_MS,
				resumes: [
					{
						at: PINNED_CLOCK_MS,
						instanceId: "deleted-account",
						reason: "user",
					},
				],
			});
		},
	},
	{
		name: "view the deleted-account history",
		match: /^I view the deleted-account session$/,
		run: async ({ world }) => {
			await world.page
				.locator('[data-session-id="sess-account-deleted"]')
				.press("Enter");
			await expect(world.page.getByTestId("session-bar-title")).toHaveText(
				"Deleted account history",
			);
		},
	},
	{
		name: "assert the limit banner uses the session's effective account",
		match: /^the session's usage limit names (Personal|Claude)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("usage-limit-title")).toHaveText(
				`Usage limit reached · ${match[1]}`,
			);
		},
	},
	{
		name: "hold the relay disconnected",
		match: /^the relay disconnects and reconnect attempts are held$/,
		run: async ({ world }) => {
			await world.page.routeWebSocket(/\/rpc(?:\?|$)/, (socket) =>
				socket.close(),
			);
			requireRpcControl(world.page).closeSockets();
			await expect(world.page.locator("#connect-overlay")).toBeVisible();
		},
	},
	{
		name: "assert the Claude overlay has no OpenCode actions",
		match: /^the connect overlay offers no OpenCode instance actions$/,
		run: async ({ world }) => {
			const overlay = world.page.locator("#connect-overlay");
			await expect(overlay).toBeVisible();
			await expect(
				overlay.getByRole("button", { name: "Start Instance" }),
			).toHaveCount(0);
			await expect(
				overlay.getByRole("button", { name: "Switch Instance" }),
			).toHaveCount(0);
		},
	},
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
			seedAccountDirectory(world.page);
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
			seedAccountDirectory(world.page);
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
				`instance-row-${accountIdForName(world.page, match[1] ?? "")}`,
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
					.getByTestId(
						`instance-row-${accountIdForName(world.page, match[1] ?? "")}`,
					)
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
				providers: dualDriverProviders.filter(
					(provider) => provider.id !== "claude",
				),
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
		match:
			/^the (?:draft|session) composer and usage meter use the (.+) account$/,
		run: async ({ world, match }) => {
			const id = accountIdForName(world.page, match[1] ?? "");
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
		name: "assert a sole account drives the composer and the single-line meter",
		match:
			/^the draft composer uses the (.+) account and the usage meter shows only it$/,
		run: async ({ world, match }) => {
			const id = accountIdForName(world.page, match[1] ?? "");
			await expect(
				world.page
					.locator('#input-area [data-testid="harness-logo"]:visible')
					.first(),
			).toHaveAttribute("data-account", id);
			// One account collapses the meter to a single line with no account rows.
			const meter = world.page.getByTestId("usage-footer-single");
			await expect(
				meter.getByTestId(`usage-footer-cell-${id}-five_hour`),
			).toBeVisible();
			await expect(
				meter.locator('[data-testid^="usage-footer-cell-"]'),
			).toHaveCount(1);
		},
	},
	{
		name: "assert the picker selects the default account",
		match: /^the picker selects the (.+) account$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(
					`picker-account-${accountIdForName(world.page, match[1] ?? "")}`,
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
				instanceId: accountIdForName(world.page, match[1] ?? ""),
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
		name: "assert the default Claude edit fields and next-turn notice",
		match: /^the default Claude editor shows name (.+) and folder (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("instance-form-name")).toHaveValue(
				match[1] ?? "",
			);
			await expect(
				world.page.getByTestId("instance-form-configdir"),
			).toHaveValue(match[2] ?? "");
			await expect(world.page.getByTestId("instance-form")).toContainText(
				"Folder changes apply on the next turn",
			);
			await expect(
				world.page.getByRole("radiogroup", { name: "Type" }),
			).toHaveCount(0);
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
		name: "assert the saved default Claude folder without a restart notice",
		match:
			/^the default Claude account shows folder (.+) without a restart notice$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId(
				`instance-row-${AccountIdSchema.make("claude")}`,
			);
			await row.getByRole("button").first().click();
			await expect(row).toContainText(match[1] ?? "");
			await expect(row).not.toContainText("Applies after restart");
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
			// Exact match: the "Claude accounts" heading must not count as an account named Claude.
			await expect(
				world.page
					.locator("#instance-settings-list")
					.getByText((match[1] ?? "").trim(), { exact: true }),
			).toHaveCount(0);
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
