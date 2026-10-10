import { expect, type Page } from "@playwright/test";
import type {
	UsageLimitsSetting,
	UsageReading,
} from "../../../src/lib/contracts/limit-recovery.js";
import type { StepHandler } from "../runtime.js";
import { seedUsageLimits } from "./providerInstances.js";
import { requireRpcControl } from "./shared.js";
import { themeColour } from "./usageFooterMeter.js";

const clockTimes = new WeakMap<Page, number>();
const usageValues = {
	normal: [41, 22],
	warn5: [86, 58],
	warnWk: [30, 91],
	limit: [100, 71],
} as const;

function accountReading(
	accountId: string,
	planLabel: string,
	values: readonly [number, number],
	now: number,
): UsageReading {
	return {
		accountId,
		harness: "claude",
		status: values[0] === 100 ? "limited" : "available",
		planLabel,
		windows: [
			{
				kind: "five_hour",
				utilization: values[0],
				...(values[0] === 0
					? {}
					: {
							resetsAt:
								values[0] === 100
									? "2026-01-01T15:13:00Z"
									: "2026-01-01T17:30:00Z",
						}),
			},
			{
				kind: "seven_day",
				utilization: values[1],
				resetsAt: "2026-01-08T09:00:00Z",
			},
		],
		readAt: now - 120_000,
		stale: false,
	};
}

function snapshot(page: Page): readonly UsageReading[] {
	return (
		requireRpcControl(page).initialDaemonList("SubscribeUsage")[0] as {
			readings: readonly UsageReading[];
		}
	).readings;
}

async function openUsage(page: Page): Promise<void> {
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("settings:open", { detail: { tab: "usage" } }),
		),
	);
	await expect(page.getByTestId("usage-settings")).toBeVisible();
	await expect(page.getByTestId("usage-settings-warn-80")).toBeEnabled();
}

async function assertWindows(
	page: Page,
	prefix: string,
	fiveHour: string,
	week: string,
	full: boolean,
): Promise<void> {
	for (const [kind, value] of [
		["five_hour", fiveHour],
		["seven_day", week],
	] as const) {
		const caption = page.getByTestId(`${prefix}-${kind}-value`);
		const bar = page.getByTestId(`${prefix}-${kind}-bar`);
		if (value === "absent") {
			await expect(caption).toHaveCount(0);
			await expect(bar).toHaveCount(0);
			continue;
		}
		await expect(caption).toHaveText(value);
		await expect(bar).toHaveCSS("height", full ? "6px" : "5px");
		await expect(bar).toHaveAttribute(
			"aria-label",
			full
				? kind === "five_hour"
					? "Current 5-hour window"
					: "This week · all models"
				: kind === "five_hour"
					? "5h"
					: "Week",
		);
		const used = value === "—" ? 0 : Number.parseInt(value, 10);
		const fillToken =
			value === "—"
				? "--color-border-chip"
				: used === 100
					? "--color-fill-red"
					: used >= 80
						? "--color-fill-amber"
						: "--color-text-secondary";
		await expect(bar.locator(":scope > div")).toHaveCSS(
			"background-color",
			await themeColour(page, fillToken),
		);
		const geometry = await bar.evaluate((track) => ({
			track: track.getBoundingClientRect().width,
			parent: track.parentElement?.getBoundingClientRect().width,
			fill: track.firstElementChild?.getBoundingClientRect().width,
		}));
		expect(geometry.track).toBeCloseTo(geometry.parent ?? 0, 0);
		expect(((geometry.fill ?? 0) / geometry.track) * 100).toBeCloseTo(used, 0);
	}
	if (!full && fiveHour !== "absent" && week !== "absent") {
		// One snapshot: separate box reads can straddle the list's reorder animation.
		const [fiveHourBox, weekBox] = await page.evaluate(
			(ids) =>
				ids.map((id) => {
					const box = document
						.querySelector(`[data-testid="${id}"]`)
						?.getBoundingClientRect();
					return box ? { x: box.x, y: box.y, width: box.width } : null;
				}),
			[`${prefix}-five_hour-bar`, `${prefix}-seven_day-bar`],
		);
		if (!fiveHourBox || !weekBox)
			throw new Error("Missing account window bars");
		// Desktop cards put the windows side by side; phone cards stack them.
		if ((page.viewportSize()?.width ?? 0) >= 768) {
			expect(fiveHourBox.y).toBeCloseTo(weekBox.y, 0);
			expect(fiveHourBox.x + fiveHourBox.width).toBeLessThan(weekBox.x);
		} else {
			expect(weekBox.y).toBeGreaterThan(fiveHourBox.y);
			expect(weekBox.x).toBeCloseTo(fiveHourBox.x, 0);
		}
	}
}

async function tapUsage(page: Page, testId: string): Promise<void> {
	const target = page.getByTestId(testId);
	await expect(target).toBeVisible();
	const box = await target.boundingBox();
	if (!box) throw new Error("Missing phone usage touch target");
	const touch = await page.context().newCDPSession(page);
	try {
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
		});
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	} finally {
		await touch.detach();
	}
}

export const usageSettingsHandlers: StepHandler[] = [
	{
		name: "pin the Usage settings clock for reset and update labels",
		match: /^the Usage settings clock is pinned to (\S+)$/,
		run: async ({ world, match }) => {
			const now = Date.parse(match[1] ?? "");
			if (!Number.isFinite(now))
				throw new Error("Invalid Usage settings clock");
			clockTimes.set(world.page, now);
			await world.page.clock.install({ time: now });
			await world.page.addInitScript((time: number) => {
				Date.now = () => time;
			}, now);
			await world.page.evaluate((time: number) => {
				Date.now = () => time;
			}, now);
		},
	},
	{
		name: "advance the wall clock and tick the Usage update timer",
		match: /^the Usage settings clock advances by (\d+) seconds$/,
		run: async ({ world, match }) => {
			const now = (clockTimes.get(world.page) ?? 0) + Number(match[1]) * 1000;
			clockTimes.set(world.page, now);
			await world.page.evaluate((time: number) => {
				Date.now = () => time;
			}, now);
			await world.page.clock.fastForward(30_000);
		},
	},
	{
		name: "seed subscription readings and persisted Usage settings",
		match:
			/^Usage settings have (one|several) Claude accounts? in the (normal|warn5|warnWk|limit|none) state$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const several = match[1] === "several";
			const now = clockTimes.get(world.page) ?? Date.now();
			const ids = several ? ["spare", "work", "claude"] : ["claude"];
			rpc.setDaemonList("SubscribeInstances", {
				instances: ids.map((id) => ({
					id,
					name: id === "claude" ? "Personal" : id === "work" ? "Work" : "Spare",
					driver: "claude",
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				})),
			});
			rpc.setDaemonList("SubscribeProjects", {
				projects: [
					{
						slug: "myapp",
						title: "myapp",
						folders: ["/src/myapp"],
						instanceId: "claude",
					},
				],
			});
			seedUsageLimits(world.page, {
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					order: several ? ["claude", "work", "spare"] : [],
					warnAt: 80,
				},
			});
			const state = match[2] as keyof typeof usageValues | "none";
			const personal: UsageReading =
				state === "none"
					? {
							accountId: "claude",
							harness: "claude",
							status: "unavailable",
							windows: [],
							readAt: now - 120_000,
							stale: false,
						}
					: accountReading(
							"claude",
							several ? "Max 5×" : "Claude Max",
							usageValues[state],
							now,
						);
			const readings = several
				? [
						{
							...accountReading("spare", "Pro", [0, 9], now),
							readAt: now - 30_000,
						},
						{
							...accountReading("work", "Max 20×", [12, 48], now),
							readAt: now - 60_000,
						},
						personal,
					]
				: [personal];
			rpc.setUsageReadings(readings);
			rpc.setResponse("QuotaForAccounts", readings);
		},
	},
	{
		name: "publish reported model windows without changing account status",
		match:
			/^the Usage account (\S+) has model windows Fable (\d+)% and Sonnet (\d+)%$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const readings = snapshot(world.page).map(
				(reading): UsageReading =>
					reading.accountId === match[1]
						? {
								...reading,
								windows: [
									...reading.windows.filter(
										(window) => window.kind !== "seven_day_model",
									),
									{
										kind: "seven_day_model",
										model: "Fable",
										utilization: Number(match[2]),
										resetsAt: "2026-01-08T09:00:00Z",
									},
									{
										kind: "seven_day_model",
										model: "Sonnet",
										utilization: Number(match[3]),
										resetsAt: "2026-01-08T09:00:00Z",
									},
								],
							}
						: reading,
			);
			rpc.setUsageReadings(readings);
			rpc.setResponse("QuotaForAccounts", readings);
		},
	},
	{
		name: "remove a five-hour window from the live subscription",
		match: /^the Usage account (\S+) has no five-hour window$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setUsageReadings(
				snapshot(world.page).map((reading) =>
					reading.accountId === match[1]
						? {
								...reading,
								windows: reading.windows.filter(
									(window) => window.kind !== "five_hour",
								),
							}
						: reading,
				),
			);
		},
	},
	{
		name: "mark a candidate unavailable in the live subscription",
		match: /^the Usage account (\S+) is unavailable$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setUsageReadings(
				snapshot(world.page).map((reading) =>
					reading.accountId === match[1]
						? { ...reading, status: "unavailable", windows: [] }
						: reading,
				),
			);
		},
	},
	{
		name: "publish the legacy quota fixture to Usage without changing strip fixtures",
		match: /^the quota check is published as the live Usage reading$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const handler = rpc.getResponseHandler("QuotaForAccounts");
			if (!handler) throw new Error("Missing seeded quota check");
			const readings = (await handler(
				{},
				{ method: "QuotaForAccounts" },
			)) as readonly UsageReading[];
			rpc.setUsageReadings(readings);
		},
	},
	{
		name: "open Usage using the existing specific-tab settings event",
		match: /^I open settings to the Usage tab$/,
		run: ({ world }) => openUsage(world.page),
	},
	{
		name: "assert the desktop heading or phone screen title",
		match: /^the Usage settings title reads (Claude plan usage|Usage)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("usage-settings")).toBeVisible();
			await expect(
				world.page.getByRole("heading", { name: match[1] ?? "", exact: true }),
			).toBeVisible();
			if (match[1] === "Usage") {
				await expect(
					world.page
						.getByTestId("usage-settings")
						.getByRole("heading", { name: "Claude plan usage" }),
				).toHaveCount(0);
			} else
				await expect(
					world.page.getByTestId("settings-tab-usage"),
				).toHaveAttribute("aria-selected", "true");
		},
	},
	{
		name: "assert Usage follows Claude and precedes Instances",
		match: /^the settings tabs place Usage between Claude and Instances$/,
		run: async ({ world }) => {
			const tabs = world.page.locator('[data-testid^="settings-tab-"]');
			const ids = await tabs.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-testid")),
			);
			const claude = ids.indexOf("settings-tab-claude");
			expect(claude).toBeGreaterThanOrEqual(0);
			expect(ids.slice(claude, claude + 3)).toEqual([
				"settings-tab-claude",
				"settings-tab-usage",
				"settings-tab-instances",
			]);
			await expect(world.page.getByTestId("settings-tab-usage")).toHaveText(
				"Usage",
			);
		},
	},
	{
		name: "assert Instances no longer contains limit settings",
		match: /^the Instances tab has no usage limit settings$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#instances-settings")).toBeVisible();
			await expect(world.page.locator("#usage-limit-settings")).toHaveCount(0);
		},
	},
	{
		name: "assert a full-screen phone Usage screen with scrolling and back navigation",
		match:
			/^the phone Usage screen fills the viewport and has a scrolling body and a back button$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#settings-panel");
			const box = await panel.boundingBox();
			const viewport = world.page.viewportSize();
			if (!box || !viewport) throw new Error("Missing phone Usage viewport");
			expect(box.x).toBeCloseTo(0, 0);
			expect(box.y).toBeCloseTo(0, 0);
			expect(box.width).toBe(viewport.width);
			expect(box.height).toBe(viewport.height);
			await expect(panel.locator(".settings-content")).toHaveCSS(
				"overflow-y",
				"auto",
			);
			await expect(world.page.getByTestId("settings-back-btn")).toBeVisible();
		},
	},
	{
		name: "assert the plan and relative update age subheader",
		match: /^the Usage settings subheader reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("usage-settings-subheader"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert a fleet headline and its theme colour",
		match: /^the Usage settings headline reads (.+) in (muted|red)$/,
		run: async ({ world, match }) => {
			const headline = world.page.getByTestId("usage-settings-headline");
			await expect(headline).toHaveText(match[1] ?? "");
			await expect(headline).toHaveCSS(
				"color",
				await themeColour(
					world.page,
					match[2] === "red" ? "--color-error" : "--color-text-secondary",
				),
			);
		},
	},
	{
		name: "assert full-width single account windows and labels",
		match: /^the Usage single-account windows show 5h (\S+) and Week (\S+)$/,
		run: ({ world, match }) =>
			assertWindows(
				world.page,
				"usage-settings-single",
				match[1] ?? "",
				match[2] ?? "",
				true,
			),
	},
	{
		name: "assert side-by-side card windows and values",
		match: /^the Usage account (\S+) windows show 5h (\S+) and Week (\S+)$/,
		run: ({ world, match }) =>
			assertWindows(
				world.page,
				`usage-settings-card-${match[1]}`,
				match[2] ?? "",
				match[3] ?? "",
				false,
			),
	},
	{
		name: "assert reported single-account model rows, bars and absent reset lines",
		match:
			/^the Usage single-account model rows show Fable (\d+)% and Sonnet (\d+)% without reset lines$/,
		run: async ({ world, match }) => {
			const rows = world.page.getByTestId("usage-settings-single-model-row");
			await expect(rows).toHaveCount(2);
			const weekReset = await world.page
				.getByTestId("usage-settings-single-seven_day-reset")
				.boundingBox();
			if (!weekReset) throw new Error("Missing all-model weekly row");
			let previousBottom = weekReset.y + weekReset.height;
			for (const [index, model] of ["Fable", "Sonnet"].entries()) {
				const row = rows.nth(index);
				const used = Number(match[index + 1]);
				const level = used >= 100 ? "limited" : used >= 80 ? "warn" : "ok";
				await expect(row.getByTestId("usage-settings-model-label")).toHaveText(
					`This week · ${model}`,
				);
				await expect(row.getByTestId("usage-settings-model-value")).toHaveText(
					`${used}%`,
				);
				await expect(row.locator('[data-testid$="-reset"]')).toHaveCount(0);
				await expect(row.locator(":scope > div")).toHaveCount(2);
				const bar = row.getByTestId("usage-settings-model-bar");
				await expect(bar).toHaveAttribute("data-level", level);
				await expect(bar).toHaveAttribute("aria-label", `This week · ${model}`);
				await expect(bar).toHaveAttribute("aria-valuenow", String(used));
				await expect(bar).toHaveCSS("height", "6px");
				await expect(bar.locator(":scope > div")).toHaveCSS(
					"background-color",
					await themeColour(
						world.page,
						used >= 100
							? "--color-fill-red"
							: used >= 80
								? "--color-fill-amber"
								: "--color-text-secondary",
					),
				);
				const geometry = await bar.evaluate((track) => ({
					track: track.getBoundingClientRect().width,
					parent: track.parentElement?.getBoundingClientRect().width,
					fill: track.firstElementChild?.getBoundingClientRect().width,
				}));
				expect(geometry.track).toBeCloseTo(geometry.parent ?? 0, 0);
				expect(((geometry.fill ?? 0) / geometry.track) * 100).toBeCloseTo(
					used,
					0,
				);
				const box = await row.boundingBox();
				if (!box) throw new Error("Missing model weekly row");
				expect(box.y).toBeGreaterThan(previousBottom);
				previousBottom = box.y + box.height;
			}
		},
	},
	{
		name: "assert unreported model rows are absent",
		match: /^the Usage single-account has no model rows$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("usage-settings-single-model-row"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert a dim model summary below card bars or no summary",
		match: /^the Usage account (\S+) model line reads (.+)$/,
		run: async ({ world, match }) => {
			const line = world.page.getByTestId(`usage-settings-models-${match[1]}`);
			if (match[2] === "absent") {
				await expect(line).toHaveCount(0);
				return;
			}
			await expect(line).toHaveText(match[2] ?? "");
			await expect(line).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-text-dimmer"),
			);
			const lineBox = await line.boundingBox();
			const resetBox = await world.page
				.getByTestId(`usage-settings-card-${match[1]}-seven_day-reset`)
				.boundingBox();
			if (!lineBox || !resetBox)
				throw new Error("Missing model summary or weekly reset");
			expect(lineBox.y).toBeGreaterThan(resetBox.y + resetBox.height);
		},
	},
	{
		name: "assert model utilization preserves the available account reading",
		match: /^the Usage account (\S+) remains available$/,
		run: ({ world, match }) => {
			expect(
				snapshot(world.page).find((reading) => reading.accountId === match[1])
					?.status,
			).toBe("available");
		},
	},
	{
		name: "assert single account reset text",
		match: /^the Usage single-account (five_hour|seven_day) reset reads (.+)$/,
		run: async ({ world, match }) => {
			const reset = world.page.getByTestId(
				`usage-settings-single-${match[1]}-reset`,
			);
			if (match[2] === "absent") await expect(reset).toHaveCount(0);
			else await expect(reset).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert card reset text",
		match: /^the Usage account (\S+) (five_hour|seven_day) reset reads (.+)$/,
		run: async ({ world, match }) => {
			const reset = world.page.getByTestId(
				`usage-settings-card-${match[1]}-${match[2]}-reset`,
			);
			if (match[3] === "absent") await expect(reset).toHaveCount(0);
			else await expect(reset).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert the no-plan-data explanation while preserving limit controls",
		match: /^the Usage settings empty message reads (.+)$/,
		run: async ({ world, match }) => {
			const message = world.page
				.getByTestId("usage-settings")
				.getByText(/^No plan limits for this login\./);
			if (match[1] === "absent") await expect(message).toHaveCount(0);
			else await expect(message).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert the no-plan-data card explanation",
		match: /^the Usage no-data card (\S+) reads (.+)$/,
		run: async ({ world, match }) => {
			const message = world.page
				.getByTestId(`usage-settings-card-${match[1]}`)
				.getByText(/^No plan data for this login/);
			if (match[2] === "absent") await expect(message).toHaveCount(0);
			else await expect(message).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert a single account exposes only auto-resume",
		match: /^the Usage single-account limit section has only auto-resume$/,
		run: async ({ world }) => {
			const section = world.page.locator("#usage-limit-settings");
			await expect(section.getByRole("switch")).toHaveCount(1);
			await expect(
				section.getByRole("switch", {
					name: "Toggle auto-resume limited sessions",
				}),
			).toBeVisible();
			await expect(
				world.page.getByRole("list", { name: "Auto-switch account order" }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert account positions, identity dots, plan badges and handles",
		match:
			/^the Usage cards show their positions, account dots, plan badges and drag handles$/,
		run: async ({ world }) => {
			const list = world.page.getByRole("list", {
				name: "Auto-switch account order",
			});
			await expect(list.getByTestId("sortable-row")).toHaveCount(3);
			for (const [index, [id, name, plan]] of [
				["claude", "Personal", "Max 5×"],
				["work", "Work", "Max 20×"],
				["spare", "Spare", "Pro"],
			].entries()) {
				await expect(
					world.page.getByTestId(`usage-settings-position-${id}`),
				).toHaveText(String(index + 1));
				await expect(
					world.page.getByTestId(`usage-settings-dot-${id}`),
				).toHaveAttribute("data-account", id ?? "");
				await expect(
					list.getByRole("button", { name: `Reorder ${name}` }),
				).toHaveText("⠿");
				const account = snapshot(world.page).find(
					(reading) => reading.accountId === id,
				);
				const badge = world.page.getByTestId(`usage-settings-plan-${id}`);
				if (account?.status === "unavailable")
					await expect(badge).toHaveCount(0);
				else await expect(badge).toHaveText(plan ?? "");
			}
		},
	},
	{
		name: "assert account status text and severity colour",
		match: /^the Usage account (\S+) status reads (.+) in (muted|amber|red)$/,
		run: async ({ world, match }) => {
			const status = world.page.getByTestId(
				`usage-settings-status-${match[1]}`,
			);
			await expect(status).toHaveText(match[2] ?? "");
			await expect(status).toHaveCSS(
				"color",
				await themeColour(
					world.page,
					match[3] === "red"
						? "--color-error"
						: match[3] === "amber"
							? "--color-fill-amber"
							: "--color-text-dimmer",
				),
			);
		},
	},
	{
		name: "assert the account order hint",
		match: /^the Usage order hint reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("usage-settings-order-hint"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert desktop or phone warning choice labels",
		match: /^the Usage warning choices read (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByRole("radiogroup", { name: "Warn me at" })
					.getByRole("radio"),
			).toHaveText((match[1] ?? "").split(", "));
		},
	},
	{
		name: "assert each phone warning option has a 44px touch target",
		match: /^the phone Usage warning choices are 44px tall$/,
		run: async ({ world }) => {
			for (const choice of [70, 80, 90, "off"])
				await expect(
					world.page.getByTestId(`usage-settings-warn-${choice}`),
				).toHaveCSS("height", "44px");
		},
	},
	{
		name: "select a persisted warning threshold",
		match: /^I select the Usage warning choice (70|80|90|off)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`usage-settings-warn-${match[1]}`).click();
		},
	},
	{
		name: "assert the selected warning choice",
		match: /^the Usage warning choice (70|80|90|off) is selected$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-settings-warn-${match[1]}`),
			).toHaveAttribute("aria-checked", "true");
			await expect(
				world.page
					.getByRole("radiogroup", { name: "Warn me at" })
					.getByRole("radio", { checked: true }),
			).toHaveCount(1);
		},
	},
	{
		name: "assert the warning choice is sent without losing other settings",
		match: /^the SetUsageLimitsSetting RPC saves warnAt (70|80|90|off)$/,
		run: async ({ world, match }) => {
			const warnAt = match[1] === "off" ? "off" : Number(match[1]);
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) =>
					candidate.tag === "SetUsageLimitsSetting" &&
					(candidate.payload["usageLimits"] as UsageLimitsSetting).warnAt ===
						warnAt,
			);
			expect(request.payload).toMatchObject({
				usageLimits: { autoResume: false, autoSwitch: false, warnAt },
			});
			expect(
				(request.payload["usageLimits"] as UsageLimitsSetting).order,
			).toEqual(
				snapshot(world.page).length === 1 ? [] : ["claude", "work", "spare"],
			);
		},
	},
	{
		name: "reload the app so Usage reads the persisted setting again",
		match: /^I reload the app and open the Usage tab$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
			await expect(world.page.locator("#input")).toBeVisible();
			await openUsage(world.page);
		},
	},
	{
		name: "close Usage settings to inspect the footer",
		match: /^I close settings$/,
		run: async ({ world }) => {
			await world.page.getByTestId("settings-close-btn").click();
			await expect(world.page.locator("#settings-panel")).not.toBeVisible();
		},
	},
	{
		name: "assert footer warning level separately from its bar colour",
		match:
			/^the usage footer (\S+) five_hour level is (normal|warning|danger) with an (normal|amber|red) bar$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-footer-cell-${match[1]}-five_hour`),
			).toHaveAttribute("data-level", match[2] ?? "");
			await expect(
				world.page
					.getByTestId(`usage-footer-bar-${match[1]}-five_hour`)
					.locator(":scope > span"),
			).toHaveCSS(
				"background-color",
				await themeColour(
					world.page,
					match[3] === "red"
						? "--color-fill-red"
						: match[3] === "amber"
							? "--color-fill-amber"
							: "--color-text-secondary",
				),
			);
			await expect(
				world.page.getByTestId(`usage-footer-value-${match[1]}-five_hour`),
			).toHaveCSS(
				"color",
				await themeColour(
					world.page,
					match[2] === "danger"
						? "--color-error"
						: match[2] === "warning"
							? "--color-fill-amber"
							: "--color-text-secondary",
				),
			);
		},
	},
	{
		name: "drag a whole Usage card through its native pointer handle",
		match: /^I drag the Usage account (.+) above (.+)$/,
		run: async ({ world, match }) => {
			const list = world.page.getByRole("list", {
				name: "Auto-switch account order",
			});
			const handle = list.getByRole("button", { name: `Reorder ${match[1]}` });
			const first = list.getByTestId("sortable-row").filter({
				hasText: match[2] ?? "",
			});
			await handle.scrollIntoViewIfNeeded();
			const [from, to] = await Promise.all([
				handle.boundingBox(),
				first.boundingBox(),
			]);
			if (!from || !to) throw new Error("Missing Usage card drag geometry");
			await world.page.mouse.move(
				from.x + from.width / 2,
				from.y + from.height / 2,
			);
			await world.page.mouse.down();
			await world.page.mouse.move(from.x + from.width / 2, to.y + 2, {
				steps: 12,
			});
			await world.page.mouse.up();
		},
	},
	{
		name: "move a card with an arrow key without entering pickup mode",
		match: /^I press (ArrowUp|ArrowDown) on the Usage account (.+) handle$/,
		run: async ({ world, match }) => {
			const handle = world.page.getByRole("button", {
				name: `Reorder ${match[2]}`,
			});
			await expect(handle).toBeEnabled();
			await handle.focus();
			await world.page.keyboard.press(match[1] ?? "ArrowUp");
		},
	},
	{
		name: "make refresh publish new usage while returning the prior RPC snapshot",
		match:
			/^the next Usage refresh publishes the (normal|warn5|warnWk|limit) reading$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setHandler("QuotaForAccounts", () => {
				const previous = snapshot(world.page);
				const now = clockTimes.get(world.page) ?? Date.now();
				rpc.setUsageReadings(
					previous.map((reading) =>
						reading.accountId === "claude"
							? {
									...accountReading(
										"claude",
										reading.planLabel ?? "Claude Max",
										usageValues[match[1] as keyof typeof usageValues],
										now,
									),
									readAt: now,
								}
							: { ...reading, readAt: now },
					),
				);
				return previous;
			});
		},
	},
	{
		name: "request the existing Usage refresh RPC",
		match: /^I press (Refresh|Refresh all) in Usage settings$/,
		run: async ({ world, match }) => {
			const refresh = world.page.getByTestId("usage-settings-refresh");
			await expect(refresh).toHaveText(match[1] ?? "");
			await refresh.click();
		},
	},
	{
		name: "assert refresh uses the attached project's existing quota RPC",
		match: /^the QuotaForAccounts RPC refreshes the attached project$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "QuotaForAccounts",
			);
			expect(request.payload).toMatchObject({
				projectSlug: "myapp",
				originId: expect.any(String),
			});
		},
	},
	{
		name: "click the desktop footer to open Usage",
		match: /^I click the desktop usage footer$/,
		run: async ({ world }) => {
			await world.page.getByTestId("usage-footer-meter").click();
		},
	},
	{
		name: "tap a phone usage chip to open Usage",
		match: /^I tap the phone usage chip (\S+)$/,
		run: ({ world, match }) =>
			tapUsage(world.page, `usage-phone-chip-${match[1]}`),
	},
	{
		name: "tap the phone single-account usage row to open Usage",
		match: /^I tap the phone single-account usage row$/,
		run: ({ world }) => tapUsage(world.page, "usage-phone-single"),
	},
	{
		name: "return from Usage to the phone settings sections",
		match: /^I press the Usage back button$/,
		run: async ({ world }) => {
			await world.page.getByTestId("settings-back-btn").click();
		},
	},
	{
		name: "assert the footer's empty space allows the phone list to scroll",
		match: /^the phone usage footer allows list scrolling around its chips$/,
		run: async ({ world }) => {
			const footer = world.page.getByTestId("usage-footer-phone");
			await expect(footer).toHaveCSS("pointer-events", "none");
			await expect(world.page.getByTestId("usage-phone-chip-claude")).toHaveCSS(
				"pointer-events",
				"auto",
			);
			const scroller = world.page.locator("#session-list-scroller");
			await scroller.evaluate((element) => {
				element.scrollTop = 0;
			});
			const box = await footer.boundingBox();
			if (!box) throw new Error("Missing phone usage footer");
			await world.page.mouse.move(box.x + 3, box.y + 3);
			await world.page.mouse.wheel(0, 300);
			await expect
				.poll(() => scroller.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(0);
		},
	},
];
