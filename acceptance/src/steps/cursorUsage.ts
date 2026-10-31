import { expect, type Page } from "@playwright/test";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { seedUsageLimits } from "./providerInstances.js";
import { mockInstances, requireRpcControl } from "./shared.js";

const accountId = "cursor-work";
const enableFailures = new WeakMap<Page, string>();

function publishUsage(
	page: Page,
	state: "can_enable" | "keychain" | "unavailable",
): void {
	const rpc = requireRpcControl(page);
	const instances = (mockInstances.get(page) ?? []).map((instance) =>
		instance["id"] === accountId
			? {
					...instance,
					usageEligible: state !== "can_enable",
					cursorUsageSource: state === "can_enable" ? "can_enable" : "keychain",
				}
			: instance,
	);
	mockInstances.set(page, instances);
	rpc.setDaemonList("SubscribeInstances", { instances });
	const readings: readonly UsageReading[] =
		state === "can_enable"
			? []
			: [
					{
						accountId,
						harness: "cursor",
						status: state === "unavailable" ? "unavailable" : "available",
						windows:
							state === "unavailable"
								? []
								: [
										{
											kind: "month",
											utilization: 38,
											resetsAt: "2026-02-01T00:00:00Z",
										},
									],
						readAt: PINNED_CLOCK_MS,
						stale: false,
						...(state === "unavailable"
							? { reason: "Cursor usage is unavailable. Try again later." }
							: {}),
					},
				];
	rpc.setUsageReadings(readings);
	rpc.setStubs({ QuotaForAccounts: () => readings });
}

export const cursorUsageHandlers: StepHandler[] = [
	{
		name: "configure a second Cursor account that cannot run",
		match: /^a second Cursor usage account is configured but unavailable$/,
		run: ({ world }) => {
			const instances = mockInstances.get(world.page) ?? [];
			const first = instances.find((instance) => instance["id"] === accountId);
			if (!first) throw new Error("Missing first Cursor account");
			const next = [
				...instances,
				{
					...first,
					id: "cursor-personal",
					name: "Cursor personal",
					colorSlot: 5,
					isDefault: false,
					usageEligible: false,
					available: false,
					status: "stopped",
					unavailableReason: "Cursor authentication required.",
				},
			];
			mockInstances.set(world.page, next);
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances: next,
			});
		},
	},
	{
		name: "assert Cursor Usage glyph and configured-driver badge count",
		match:
			/^the Cursor Usage account (cursor-work|cursor-personal) shows its logo (with|without) a letter badge$/,
		run: async ({ world, match }) => {
			const id = match[1] ?? "";
			const badged = match[2] === "with";
			const configured = (mockInstances.get(world.page) ?? []).filter(
				(instance) => instance["driver"] === "cursor",
			);
			expect(configured.length >= 2).toBe(badged);
			const logo = world.page
				.getByTestId(`cursor-usage-card-${id}`)
				.getByTestId("account-logo");
			await expect(logo).toBeVisible();
			await expect(logo).toHaveAttribute("data-driver", "cursor");
			await expect(logo).toHaveAttribute("data-account", id);
			await expect(logo).toHaveCSS("width", "18px");
			const badge = logo.getByTestId("harness-logo-badge");
			await expect(badge).toHaveCount(badged ? 1 : 0);
			if (badged) {
				await expect(badge).toHaveText("C");
				await expect(badge).toHaveAttribute("data-state", "idle");
			}
		},
	},
	{
		name: "assert Cursor Usage account names share a left edge",
		match: /^the Cursor Usage account names are left aligned$/,
		run: async ({ world }) => {
			const positions = await world.page
				.getByTestId("cursor-usage-settings")
				.getByTestId("account-logo")
				.evaluateAll((logos) =>
					logos.map(
						(logo) => logo.nextElementSibling?.getBoundingClientRect().x,
					),
				);
			expect(positions.length).toBeGreaterThan(1);
			for (const x of positions) expect(x).toBeCloseTo(positions[0] ?? 0, 0);
		},
	},
	{
		name: "seed Cursor monthly usage and Keychain binding",
		match: /^Cursor plan usage is (can_enable|keychain|unavailable)$/,
		run: ({ world, match }) => {
			const state = match[1];
			if (
				state !== "can_enable" &&
				state !== "keychain" &&
				state !== "unavailable"
			)
				throw new Error("Unknown Cursor usage state");
			seedUsageLimits(world.page, {
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					warnAt: 80,
					order: ["claude"],
				},
			});
			publishUsage(world.page, state);
			requireRpcControl(world.page).setStubs({
				SetCursorUsageKeychain: (payload) => {
					expect(payload.accountId).toBe(accountId);
					const reason = payload.enabled
						? enableFailures.get(world.page)
						: undefined;
					if (reason) return { enabled: false, reason };
					publishUsage(world.page, payload.enabled ? "keychain" : "can_enable");
					return { enabled: payload.enabled };
				},
			});
		},
	},
	{
		name: "prepare a failed Cursor Keychain Enable",
		match: /^Cursor Keychain Enable will fail with (.+)$/,
		run: ({ world, match }) => {
			enableFailures.set(world.page, match[1] ?? "");
		},
	},
	{
		name: "assert Cursor Month reading in the existing footer",
		match: /^the Cursor Month footer shows (\d+) percent$/,
		run: async ({ world, match }) => {
			const value = world.page.getByTestId(
				`usage-footer-value-${accountId}-month`,
			);
			await expect(value).toBeVisible();
			await expect(value).toHaveText(`${match[1]}%`);
			await expect(
				// Wide labels the Month column; the phone dock labels its single line.
				world.page.getByTestId(
					/^usage-(footer-column-cursor|phone-column)-month$/,
				),
			).toHaveText(/^month$/i);
			const bar = world.page.getByTestId(`usage-footer-bar-${accountId}-month`);
			const fill = await bar.evaluate((element) => ({
				track: element.getBoundingClientRect().width,
				fill: element.firstElementChild?.getBoundingClientRect().width,
			}));
			expect(((fill.fill ?? 0) / fill.track) * 100).toBeCloseTo(
				Number(match[1]),
				0,
			);
		},
	},
	{
		name: "assert Cursor can enable usage without joining Claude's switch order",
		match:
			/^the Cursor usage card offers Enable with the Keychain explanation$/,
		run: async ({ world }) => {
			const card = world.page.getByTestId(`cursor-usage-card-${accountId}`);
			await expect(card).toBeVisible();
			await expect(
				card.getByRole("button", { name: "Enable", exact: true }),
			).toBeEnabled();
			await expect(card).toContainText("this Mac's Keychain");
			await expect(card).toContainText("macOS asks first");
			await expect(card).toContainText('"Always Allow"');
			await expect(card).toContainText("CURSOR_AUTH_TOKEN");
			await expect(
				world.page.getByTestId(`usage-settings-position-${accountId}`),
			).toHaveCount(0);
		},
	},
	{
		name: "enable or disable Cursor Keychain usage through Settings",
		match: /^I (enable|disable) Cursor Keychain usage$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId(`cursor-usage-${match[1]}-${accountId}`)
				.click();
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetCursorUsageKeychain" &&
					request.payload["accountId"] === accountId &&
					request.payload["enabled"] === (match[1] === "enable"),
			);
		},
	},
	{
		name: "assert enabled Cursor Month card",
		match:
			/^the Cursor usage card shows Month (\d+) percent and a reset date with Disable$/,
		run: async ({ world, match }) => {
			const card = world.page.getByTestId(`cursor-usage-card-${accountId}`);
			await expect(
				card.getByRole("meter", { name: "Month", exact: true }),
			).toHaveAttribute("aria-valuenow", match[1] ?? "");
			await expect(
				world.page.getByTestId(`cursor-usage-${accountId}-month-value`),
			).toHaveText(`${match[1]}%`);
			await expect(
				world.page.getByTestId(`cursor-usage-${accountId}-reset`),
			).toHaveText("Resets Feb 1, 2026");
			await expect(
				card.getByRole("button", { name: "Disable", exact: true }),
			).toBeEnabled();
			await expect(
				world.page.getByTestId(`usage-settings-position-${accountId}`),
			).toHaveCount(0);
		},
	},
	{
		name: "assert a Cursor usage or Enable failure reason",
		match: /^the Cursor usage card reports (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page.getByTestId(`cursor-usage-card-${accountId}`);
			await expect(card).toContainText(match[1] ?? "");
			await expect(card.getByRole("meter")).toHaveCount(0);
		},
	},
];
