import { expect, type Page } from "@playwright/test";
import type { CursorAuthState } from "../../../src/lib/contracts/ws-rpc.js";
import { closeSettings } from "../../../test/e2e/helpers/settings.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { mockInstances, requireRpcControl } from "./shared.js";

const loginUrl = "https://cursor.com/login?request=conduit-acceptance";
const expiry = PINNED_CLOCK_MS + 90 * 86_400_000;
const states = new WeakMap<Page, CursorAuthState>();
const heldReplies = new WeakMap<Page, () => void>();

function stateOf(page: Page): CursorAuthState {
	const state = states.get(page);
	if (!state) throw new Error("Cursor authentication was not seeded");
	return state;
}

function publishAccount(page: Page, available: boolean): void {
	const previous = mockInstances.get(page) ?? [];
	const account = previous.find((row) => row["driver"] === "cursor");
	const instances = [
		...previous.filter((row) => row["driver"] !== "cursor"),
		{
			id: "cursor-work",
			name: "Cursor",
			colorSlot: 4,
			driver: "cursor",
			isDefault: true,
			usageEligible: false,
			port: 0,
			managed: false,
			restartCount: 0,
			createdAt: 1,
			...account,
			available,
			status: available ? "healthy" : "stopped",
			...(available
				? {}
				: {
						unavailableReason:
							"Cursor authentication required. Log in to Cursor in Settings.",
					}),
		},
	];
	mockInstances.set(page, instances);
	const rpc = requireRpcControl(page);
	rpc.setDaemonList("SubscribeInstances", { instances });
	rpc.setProjectSetting({
		_tag: "providerModels",
		accountId: "cursor-work",
		providers: available
			? [
					{
						id: "cursor",
						name: "Cursor",
						configured: true,
						models: [
							{ id: "composer-2.5", name: "Composer 2.5", provider: "cursor" },
						],
					},
				]
			: [],
	});
}

export const cursorAuthHandlers: StepHandler[] = [
	{
		name: "seed Cursor authentication",
		match:
			/^Cursor UI authentication is (logged out|logged in|expiring|from environment)$/,
		run: ({ world, match }) => {
			const mode = match[1];
			const state: CursorAuthState =
				mode === "logged out"
					? {
							source: "none",
							status: "logged-out",
							expiresSoon: false,
							login: { state: "idle" },
						}
					: mode === "from environment"
						? {
								source: "environment",
								status: "logged-in",
								expiresSoon: false,
								login: { state: "idle" },
							}
						: {
								source: "sdk-login",
								status: "logged-in",
								email: "person@example.test",
								apiKeyExpiresAtMs:
									mode === "expiring"
										? PINNED_CLOCK_MS + 2 * 86_400_000
										: expiry,
								expiresSoon: mode === "expiring",
								login: { state: "idle" },
							};
			states.set(world.page, state);
			if (state.status === "logged-in") publishAccount(world.page, true);
			const rpc = requireRpcControl(world.page);
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			const getAgents = rpc.stubs.GetAgents ?? rpc.catalogStubs().GetAgents;
			rpc.setStubs({
				GetCursorAuth: () => stateOf(world.page),
				StartCursorLogin: () => {
					const next: CursorAuthState = {
						...stateOf(world.page),
						login: {
							state: "pending",
							url: loginUrl,
							deadlineAtMs: PINNED_CLOCK_MS + 5 * 60_000,
						},
					};
					states.set(world.page, next);
					return next;
				},
				CancelCursorLogin: () => {
					const next: CursorAuthState = {
						...stateOf(world.page),
						login: { state: "cancelled" },
					};
					states.set(world.page, next);
					return next;
				},
				LogoutCursor: () => {
					const next: CursorAuthState = {
						source: "none",
						status: "logged-out",
						expiresSoon: false,
						login: { state: "idle" },
					};
					states.set(world.page, next);
					publishAccount(world.page, false);
					return next;
				},
				GetModels: (payload) =>
					payload.instanceId === "cursor-work"
						? { projectSlug: "myapp", instanceId: "cursor-work", providers: [] }
						: getModels(payload),
				GetAgents: (payload) =>
					payload.instanceId === "cursor-work"
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providerScope: { id: "cursor", name: "Cursor" },
								agents: [],
							}
						: getAgents(payload),
			});
		},
	},
	{
		name: "assert Cursor auth status",
		match: /^Cursor settings reports (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("cursor-auth-status")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "start Cursor login",
		match: /^I start Cursor login in settings$/,
		run: async ({ world }) => {
			await world.page.getByTestId("cursor-login-start").click();
		},
	},
	{
		name: "assert Cursor login link and deadline",
		match: /^the Cursor login link and its separate flow deadline are shown$/,
		run: async ({ world }) => {
			const link = world.page.getByTestId("cursor-login-link");
			await expect(link).toBeVisible();
			await expect(link).toHaveAttribute("href", loginUrl);
			await expect(link).toHaveAttribute("target", "_blank");
			await expect(link).toHaveAttribute("rel", "noopener noreferrer");
			await expect(world.page.getByTestId("cursor-login-url")).toHaveText(
				loginUrl,
			);
			await expect(
				world.page.getByTestId("cursor-login-deadline").locator("time"),
			).toHaveAttribute(
				"datetime",
				new Date(PINNED_CLOCK_MS + 5 * 60_000).toISOString(),
			);
			await expect(world.page.getByTestId("cursor-auth-expiry")).toHaveCount(0);
		},
	},
	{
		name: "complete Cursor login",
		match: /^Cursor login completes for (\S+)$/,
		run: ({ world, match }) => {
			states.set(world.page, {
				source: "sdk-login",
				status: "logged-in",
				email: match[1] ?? "",
				apiKeyExpiresAtMs: expiry,
				expiresSoon: false,
				login: { state: "complete" },
			});
			publishAccount(world.page, true);
		},
	},
	{
		name: "assert Cursor key expiry",
		match: /^Cursor settings shows the key expiry without a login deadline$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("cursor-auth-expiry")).toContainText(
				"Key expires",
			);
			await expect(
				world.page.getByTestId("cursor-auth-expiry").locator("time"),
			).toHaveAttribute(
				"datetime",
				new Date(stateOf(world.page).apiKeyExpiresAtMs ?? 0).toISOString(),
			);
			await expect(world.page.getByTestId("cursor-login-deadline")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert single authenticated Cursor account",
		match: /^the Cursor account directory has one authenticated account$/,
		run: async ({ world }) => {
			const accounts = (mockInstances.get(world.page) ?? []).filter(
				(row) => row["driver"] === "cursor",
			);
			expect(accounts).toHaveLength(1);
			expect(accounts[0]?.["available"]).toBe(true);
			await expect(
				world.page
					.getByTestId("cursor-accounts-list")
					.locator('[data-driver="cursor"]'),
			).toHaveCount(1);
		},
	},
	{
		name: "close Cursor settings",
		match: /^I close Cursor settings$/,
		run: async ({ world }) => {
			await closeSettings(world.page);
			await expect(world.page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "hold a stale Cursor status response",
		match: /^a Cursor login status reply is held$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const snapshot = stateOf(world.page);
			const before = rpc.getRequests().length;
			const reply = new Promise<CursorAuthState>((resolve) =>
				heldReplies.set(world.page, () => resolve(snapshot)),
			);
			rpc.setStubs({ GetCursorAuth: () => reply });
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.slice(before)
						.some((request) => request.tag === "GetCursorAuth"),
				)
				.toBe(true);
		},
	},
	{
		name: "cancel Cursor login",
		match: /^I cancel Cursor login in settings$/,
		run: async ({ world }) => {
			await world.page.getByTestId("cursor-login-cancel").click();
			await expect(world.page.getByTestId("cursor-login-result")).toHaveText(
				"Login cancelled.",
			);
		},
	},
	{
		name: "release stale Cursor status response",
		match: /^the late Cursor login status reply arrives$/,
		run: async ({ world }) => {
			const release = heldReplies.get(world.page);
			if (!release) throw new Error("No Cursor status reply was held");
			release();
			heldReplies.delete(world.page);
			requireRpcControl(world.page).setStubs({
				GetCursorAuth: () => stateOf(world.page),
			});
			const rpc = requireRpcControl(world.page);
			const before = rpc.getRequests().length;
			await expect(async () => {
				await world.page.getByTestId("cursor-auth-refresh").click();
				expect(
					rpc
						.getRequests()
						.slice(before)
						.some((request) => request.tag === "GetCursorAuth"),
				).toBe(true);
			}).toPass();
		},
	},
	{
		name: "assert Cursor cancellation survives stale response",
		match: /^Cursor login remains cancelled without a link$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("cursor-login-result")).toHaveText(
				"Login cancelled.",
			);
			await expect(world.page.getByTestId("cursor-login-link")).toHaveCount(0);
			await expect(world.page.getByTestId("cursor-login-start")).toBeEnabled();
		},
	},
	{
		name: "assert Cursor key expiry warning",
		match: /^Cursor settings warns that the key expires soon$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("cursor-auth-expiry-warning"),
			).toHaveText("Your Cursor key expires soon. Log in again to renew it.");
		},
	},
	{
		name: "log out of Cursor",
		match: /^I log out of Cursor in settings$/,
		run: async ({ world }) => {
			await world.page.getByTestId("cursor-logout").click();
		},
	},
	{
		name: "assert Cursor logout clears expiry",
		match: /^Cursor settings no longer shows a key expiry$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("cursor-auth-expiry")).toHaveCount(0);
			await expect(
				world.page.getByTestId("cursor-auth-expiry-warning"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert Cursor account unavailable after logout",
		match: /^the Cursor account directory is unavailable$/,
		run: ({ world }) => {
			expect(
				(mockInstances.get(world.page) ?? []).find(
					(row) => row["driver"] === "cursor",
				)?.["available"],
			).toBe(false);
		},
	},
	{
		name: "assert environment hides Cursor mutation actions",
		match: /^Cursor login and logout actions are hidden$/,
		run: async ({ world }) => {
			for (const id of [
				"cursor-login-start",
				"cursor-logout",
				"cursor-login-cancel",
				"cursor-login-link",
			])
				await expect(world.page.getByTestId(id)).toHaveCount(0);
		},
	},
	{
		name: "start login directly from Cursor discovery error",
		match: /^I use the Cursor discovery login action$/,
		run: async ({ world }) => {
			await world.page.getByTestId("picker-harness-cursor-login").click();
		},
	},
];
