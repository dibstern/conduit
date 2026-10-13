import { expect, type Page } from "@playwright/test";
import type {
	UsageReading,
	UsageWindow,
} from "../../../src/lib/contracts/limit-recovery.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { openModelPicker, requireRpcControl } from "./shared.js";

const states = {
	normal: [41, 22],
	warn5: [86, 58],
	warnWk: [30, 91],
	limit: [100, 71],
} as const;

/** A real finger: CDP touch events, which the page also sees as pointer events. */
async function touchFinger(page: Page, x: number, y: number) {
	const touch = await page.context().newCDPSession(page);
	let at = y;
	await touch.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y }],
	});
	return {
		async move(dy: number) {
			for (let step = 1; step <= 12; step++)
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: at + (dy * step) / 12 }],
				});
			at += dy;
		},
		async lift() {
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await touch.detach();
			}
		},
	};
}

async function touchDrag(page: Page, x: number, y: number, dy: number) {
	const finger = await touchFinger(page, x, y);
	try {
		await finger.move(dy);
	} finally {
		await finger.lift();
	}
}

function reading(
	accountId: string,
	harness: UsageReading["harness"],
	windows: readonly UsageWindow[],
	status: UsageReading["status"] = "available",
): UsageReading {
	return {
		accountId,
		harness,
		status,
		windows,
		readAt: PINNED_CLOCK_MS,
		stale: false,
	};
}

function singleReading(state: string): UsageReading {
	if (state === "none") return reading("claude", "claude", [], "unavailable");
	const values = states[state as keyof typeof states];
	if (!values) throw new Error(`Unknown usage footer state: ${state}`);
	return reading(
		"claude",
		"claude",
		[
			{
				kind: "five_hour",
				utilization: values[0],
				resetsAt: "2026-01-01T03:13:00Z",
			},
			{ kind: "seven_day", utilization: values[1] },
		],
		state === "limit" ? "limited" : "available",
	);
}

function setAccounts(
	page: Page,
	accounts: readonly (readonly [
		id: string,
		name: string,
		driver?: "claude" | "opencode",
	])[],
): void {
	const rpc = requireRpcControl(page);
	rpc.setResponse("GetUsageLimitsSetting", {
		usageLimits: {
			autoResume: false,
			autoSwitch: false,
			order: ["claude", "work", "spare", "unreadable", "chatgpt", "cursor"],
		},
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: accounts.map(([id, name, driver = "claude"]) => ({
			id,
			name,
			driver,
			isDefault: id === "claude" || id === "opencode",
			usageEligible: driver === "claude" && id !== "api-key",
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1,
			...(id === "api-key"
				? { env: { ANTHROPIC_API_KEY: "fixture-key" } }
				: {}),
		})),
	});
	rpc.setDaemonList("SubscribeProjects", {
		projects: [{ slug: "myapp", title: "myapp", folders: ["/src/myapp"] }],
	});
	// A Claude default model makes the claude account current outside a session.
	rpc.setProjectSetting({
		_tag: "defaultModel",
		model: "claude-sonnet-5",
		provider: "claude",
		variant: "",
	});
}

export async function themeColour(page: Page, token: string): Promise<string> {
	return page.evaluate((variable) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${variable})`;
		document.body.append(probe);
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	}, token);
}

export const usageFooterMeterHandlers: StepHandler[] = [
	{
		name: "seed a single account's usage footer",
		match: /^the usage footer has one Claude account in the (\S+) state$/,
		run: ({ world, match }) => {
			setAccounts(world.page, [["claude", "Claude"]]);
			requireRpcControl(world.page).setUsageReadings([
				singleReading(match[1] ?? ""),
			]);
		},
	},
	{
		name: "push the next live usage reading",
		match: /^the usage footer receives the (\S+) reading$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setUsageReadings([
				singleReading(match[1] ?? ""),
			]);
		},
	},
	{
		name: "update one window while replaying the complete usage snapshot",
		match:
			/^the usage footer (\S+) (five_hour|seven_day|month) reading is (\d+)% resetting at (\S+)$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const snapshot = rpc.initialDaemonList("SubscribeUsage")[0] as {
				readings: readonly UsageReading[];
			};
			const account = snapshot.readings.find(
				(item) => item.accountId === match[1],
			);
			if (
				!account ||
				!account.windows.some((window) => window.kind === match[2])
			)
				throw new Error(
					"The usage window update requires a seeded account window",
				);
			const windows = account.windows.map((window) =>
				window.kind === match[2]
					? {
							kind: window.kind,
							utilization: Number(match[3]),
							...(match[4] === "none" ? {} : { resetsAt: match[4] ?? "" }),
						}
					: window,
			);
			rpc.setUsageReadings(
				snapshot.readings.map((item) =>
					item.accountId === account.accountId
						? {
								...item,
								windows,
								status: windows.some((window) => window.utilization >= 100)
									? "limited"
									: "available",
							}
						: item,
				),
			);
		},
	},
	{
		name: "seed grouped accounts in an unsorted instance snapshot",
		match:
			/^the usage footer has several accounts with an (unknown|unavailable) Claude reading$/,
		run: ({ world, match }) => {
			setAccounts(world.page, [
				["cursor", "Cursor", "opencode"],
				["spare", "Spare"],
				["work", "Work"],
				["unreadable", "Unreadable"],
				["chatgpt", "ChatGPT", "opencode"],
				["claude", "Personal"],
				["opencode", "OpenCode", "opencode"],
				["api-key", "API key"],
			]);
			const twoWindows = (
				fiveHour: number,
				week: number,
			): readonly UsageWindow[] => [
				{ kind: "five_hour", utilization: fiveHour },
				{ kind: "seven_day", utilization: week },
			];
			requireRpcControl(world.page).setUsageReadings([
				reading("cursor", "cursor", [{ kind: "month", utilization: 38 }]),
				reading("spare", "claude", twoWindows(0, 9)),
				reading("work", "claude", twoWindows(12, 48)),
				reading(
					"unreadable",
					"claude",
					[],
					match[1] === "unknown" ? "unknown" : "unavailable",
				),
				reading("chatgpt", "codex", twoWindows(30, 64)),
				singleReading("normal"),
				reading("api-key", "claude", [], "unavailable"),
			]);
		},
	},
	{
		name: "assert the footer occupies the bottom of the sidebar",
		match: /^the usage footer is pinned below the session list$/,
		run: async ({ world }) => {
			const footer = world.page.getByTestId("usage-footer-meter");
			await expect(footer).toBeVisible();
			const [footerBox, sidebarBox, listBox] = await Promise.all([
				footer.boundingBox(),
				world.page.locator("#sidebar").boundingBox(),
				world.page.locator("#session-list-container").boundingBox(),
			]);
			if (!footerBox || !sidebarBox || !listBox)
				throw new Error("Missing sidebar layout boxes");
			expect(footerBox.y).toBeGreaterThanOrEqual(
				listBox.y + listBox.height - 1,
			);
			expect(footerBox.y + footerBox.height).toBeCloseTo(
				sidebarBox.y + sidebarBox.height,
				0,
			);
		},
	},
	{
		name: "assert the single footer labels and values",
		match: /^the single usage footer shows 5h (\S+) and Week (\S+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("usage-footer-single")).toBeVisible();
			await expect(
				world.page.getByTestId("usage-footer-column-claude-five_hour"),
			).toHaveText("5h");
			await expect(
				world.page.getByTestId("usage-footer-column-claude-seven_day"),
			).toHaveText("Week");
			await expect(
				world.page.getByTestId("usage-footer-value-claude-five_hour"),
			).toHaveText(match[1] ?? "");
			await expect(
				world.page.getByTestId("usage-footer-value-claude-seven_day"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert the window's warning level against the saved threshold",
		match:
			/^the usage footer (\S+) (five_hour|seven_day|month) window is at level (normal|warning|danger)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-footer-cell-${match[1]}-${match[2]}`),
			).toHaveAttribute("data-level", match[3] ?? "");
		},
	},
	{
		name: "assert the window's threshold colour and filled share",
		match:
			/^the usage footer (\S+) (five_hour|seven_day|month) meter is (normal|warning|danger) at (\d+) percent$/,
		run: async ({ world, match }) => {
			const key = `${match[1]}-${match[2]}`;
			const level = match[3] ?? "normal";
			const fillToken =
				level === "danger"
					? "--color-fill-red"
					: level === "warning"
						? "--color-fill-amber"
						: "--color-text-secondary";
			const valueToken = level === "danger" ? "--color-error" : fillToken;
			const cell = world.page.getByTestId(`usage-footer-cell-${key}`);
			const bar = world.page.getByTestId(`usage-footer-bar-${key}`);
			await expect(cell).toHaveAttribute("data-level", level);
			await expect(bar).toBeVisible();
			await expect(bar).toHaveCSS("height", "4px");
			await expect(bar.locator(":scope > span")).toHaveCSS(
				"background-color",
				await themeColour(world.page, fillToken),
			);
			await expect(
				world.page.getByTestId(`usage-footer-value-${key}`),
			).toHaveCSS("color", await themeColour(world.page, valueToken));
			const share = await bar.evaluate((track) => {
				const fill = track.firstElementChild;
				if (!fill) throw new Error("Usage meter has no fill");
				return (
					(fill.getBoundingClientRect().width /
						track.getBoundingClientRect().width) *
					100
				);
			});
			expect(share).toBeCloseTo(Number(match[4]), 0);
		},
	},
	{
		name: "assert the single footer's compact bar widths",
		match: /^the single usage footer bars are 40px and 36px wide$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("usage-footer-bar-claude-five_hour"),
			).toHaveCSS("width", "40px");
			await expect(
				world.page.getByTestId("usage-footer-bar-claude-seven_day"),
			).toHaveCSS("width", "36px");
		},
	},
	{
		name: "assert no footer for an account without plan windows",
		match: /^the usage footer is not visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("usage-footer-meter")).toHaveCount(0);
		},
	},
	{
		name: "assert daemon-wide usage subscription payload",
		match: /^the SubscribeUsage RPC has no project payload$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(item) => item.tag === "SubscribeUsage",
			);
			expect(request.payload).toEqual({});
		},
	},
	{
		name: "assert harness group order and headings",
		match: /^the usage footer groups read CLAUDE, CODEX, CURSOR in that order$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("usage-footer-meter")
					.locator('[data-testid^="usage-footer-heading-"]'),
			).toHaveText(["CLAUDE", "CODEX", "CURSOR"]);
		},
	},
	{
		name: "assert account order follows the configured auto-switch order",
		match:
			/^the Claude usage footer rows read Personal, Work, Spare, Unreadable in auto-switch order$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("usage-footer-group-claude")
					.locator('[data-testid^="usage-footer-name-"]'),
			).toHaveText(["Personal", "Work", "Spare", "Unreadable"]);
		},
	},
	{
		name: "assert the current account's colour and tooltip",
		match: /^the usage footer (\S+) row is the highlighted current account$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId(`usage-footer-row-${match[1]}`);
			await expect(
				world.page
					.getByTestId("usage-footer-meter")
					.locator('[data-default="true"]'),
			).toHaveCount(1);
			await expect(row).toHaveAttribute("data-default", "true");
			await expect(row).toHaveAttribute("title", "Current account");
			await expect(row).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-bg-alt"),
			);
			await expect(
				world.page.getByTestId(`usage-footer-name-${match[1]}`),
			).toHaveCSS("color", await themeColour(world.page, "--color-text"));
		},
	},
	{
		name: "assert account dots match the composer account badge colour",
		match: /^the usage footer (\S+) dot matches the composer account badge$/,
		run: async ({ world, match }) => {
			const footerDot = world.page.getByTestId(`usage-footer-dot-${match[1]}`);
			const badge = world.page
				.locator(
					`#input-area [data-testid="harness-logo"][data-account="${match[1]}"]`,
				)
				.getByTestId("harness-logo-badge");
			await expect(footerDot).toHaveAttribute("data-account", match[1] ?? "");
			await expect(badge).toBeVisible();
			await expect(footerDot).toHaveCSS(
				"background-color",
				await badge.evaluate((dot) => getComputedStyle(dot).backgroundColor),
			);
		},
	},
	{
		name: "assert each account's two window values",
		match: /^the usage footer (\S+) shows five_hour (\S+) and seven_day (\S+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-footer-value-${match[1]}-five_hour`),
			).toHaveText(match[2] ?? "");
			await expect(
				world.page.getByTestId(`usage-footer-value-${match[1]}-seven_day`),
			).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert two-window harness headings",
		match: /^the (Claude|Codex) usage footer headings read 5H and WEEK$/,
		run: async ({ world, match }) => {
			const harness = (match[1] ?? "").toLowerCase();
			await expect(
				world.page.getByTestId(`usage-footer-column-${harness}-five_hour`),
			).toHaveText("5H");
			await expect(
				world.page.getByTestId(`usage-footer-column-${harness}-seven_day`),
			).toHaveText("WEEK");
		},
	},
	{
		name: "assert the monthly harness heading",
		match: /^the Cursor usage footer heading reads MONTH$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("usage-footer-column-cursor-month"),
			).toHaveText("MONTH");
		},
	},
	{
		name: "assert a single window spans both grid columns",
		match:
			/^the usage footer cursor month window reads 38% and spans both columns$/,
		run: async ({ world }) => {
			const cell = world.page.getByTestId("usage-footer-cell-cursor-month");
			await expect(
				world.page.getByTestId("usage-footer-value-cursor-month"),
			).toHaveText("38%");
			await expect(cell).toHaveCSS("grid-column-start", "span 2");
			await expect(
				world.page.getByTestId("usage-footer-column-cursor-month"),
			).toHaveCSS("grid-column-start", "span 2");
			await expect(
				world.page.getByTestId("usage-footer-bar-cursor-month"),
			).toHaveCSS("width", "88px");
		},
	},
	{
		name: "assert accounts with no quota source are omitted",
		match: /^the usage footer omits accounts without a quota source$/,
		run: async ({ world }) => {
			for (const accountId of ["opencode", "api-key"])
				await expect(
					world.page.getByTestId(`usage-footer-row-${accountId}`),
				).toHaveCount(0);
		},
	},
	{
		name: "resize the actual sidebar through its drag handle",
		match: /^I resize the sidebar to its 180px minimum$/,
		run: async ({ world }) => {
			const [handle, sidebar] = await Promise.all([
				world.page.locator(".sidebar-resize-handle").boundingBox(),
				world.page.locator("#sidebar").boundingBox(),
			]);
			if (!handle || !sidebar) throw new Error("Missing sidebar resize handle");
			const x = handle.x + handle.width / 2;
			const y = handle.y + handle.height / 2;
			await world.page.mouse.move(x, y);
			await world.page.mouse.down();
			await world.page.mouse.move(x - sidebar.width + 160, y, { steps: 8 });
			await world.page.mouse.up();
			await expect(world.page.locator("#sidebar")).toHaveCSS("width", "180px");
		},
	},
	{
		name: "assert the narrow layout removes second-window headings and cells",
		match: /^the usage footer second window columns are hidden$/,
		run: async ({ world }) => {
			for (const harness of ["claude", "codex"])
				await expect(
					world.page.getByTestId(`usage-footer-column-${harness}-seven_day`),
				).not.toBeVisible();
			for (const accountId of [
				"claude",
				"work",
				"spare",
				"unreadable",
				"chatgpt",
			])
				await expect(
					world.page.getByTestId(`usage-footer-cell-${accountId}-seven_day`),
				).not.toBeVisible();
		},
	},
	{
		name: "assert a window value",
		match:
			/^the usage footer (\S+) (five_hour|seven_day|month) value reads (\S+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-footer-value-${match[1]}-${match[2]}`),
			).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert a window is hidden",
		match:
			/^the usage footer (\S+) (five_hour|seven_day|month) cell is not visible$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-footer-cell-${match[1]}-${match[2]}`),
			).not.toBeVisible();
		},
	},
	{
		name: "assert visible footer content stays inside the sidebar",
		match: /^the usage footer has no horizontal clipping$/,
		run: async ({ world }) => {
			const footer = world.page.getByTestId("usage-footer-meter");
			await expect(footer).toBeVisible();
			const overflow = await footer.evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				return {
					width: element.clientWidth,
					scrollWidth: element.scrollWidth,
					overflowingCells: Array.from(
						element.querySelectorAll<HTMLElement>(
							'[data-testid^="usage-footer-cell-"]',
						),
					)
						.filter(
							(cell) =>
								cell.getBoundingClientRect().width > 0 &&
								cell.scrollWidth > cell.clientWidth,
						)
						.map((cell) => cell.getAttribute("data-testid")),
					outside: Array.from(
						element.querySelectorAll('[data-testid^="usage-footer-"]'),
					)
						.filter((child) => {
							const box = child.getBoundingClientRect();
							return (
								box.width > 0 &&
								(box.x < bounds.x - 1 || box.right > bounds.right + 1)
							);
						})
						.map((child) => child.getAttribute("data-testid")),
				};
			});
			expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
			expect(overflow.overflowingCells).toEqual([]);
			expect(overflow.outside).toEqual([]);
		},
	},
	{
		name: "seed a scrollable phone list for footer clearance",
		match: /^the session list has (\d+) rows for usage footer clearance$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setShellRows([
				...(rpc.shellRows ?? []),
				...Array.from({ length: Number(match[1]) }, (_, index) => ({
					id: `sess-usage-footer-${index + 1}`,
					title: `Usage footer session ${index + 1}`,
					projectSlug: "myapp",
					instanceId: "claude",
					accountId: "claude",
					status: "idle",
					updatedAt: PINNED_CLOCK_MS - (index + 1) * 60_000,
				})),
			]);
		},
	},
	{
		// The draft's pick is the only per-tab account choice; it decides the
		// highlighted account until a session exists.
		name: "pick an account for a new session draft",
		match: /^I pick (\S+) for a new session draft$/,
		run: async ({ world, match }) => {
			const newSession = world.page.locator("#new-session-btn:visible");
			if ((await newSession.count()) === 0)
				await world.page.getByTestId("session-bar-back").click();
			await newSession.click();
			await openModelPicker(world.page);
			await world.page.getByTestId("picker-harness-claude").click();
			await world.page.getByTestId(`picker-account-${match[1]}`).click();
			await world.page.keyboard.press("Escape");
			await expect(
				world.page.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				),
			).toHaveAttribute("data-instance-id", match[1] ?? "");
		},
	},
	{
		// Opening a session from the list attaches its project, which is
		// what gives the phone list a current account after going back.
		name: "open a project session from the phone session list",
		match: /^I open "([^"]+)" from the phone session list$/,
		run: async ({ world, match }) => {
			await world.page.locator("[data-testid='session-bar-back']").click();
			await world.page
				.locator("#sidebar-panel-sessions")
				.getByText(match[1] ?? "", { exact: true })
				.click();
			await world.page
				.locator("[data-testid='session-bar-back']")
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "assert the phone dock's rows follow shared account order",
		match: /^the phone usage rows are (.+) in that order$/,
		run: async ({ world, match }) => {
			const expected = (match[1] ?? "").split(", ");
			const rows = world.page
				.getByTestId("usage-footer-phone")
				.locator('[data-testid^="usage-footer-row-"]');
			await expect(rows).toHaveCount(expected.length);
			for (const [index, accountId] of expected.entries())
				await expect(rows.nth(index)).toHaveAttribute(
					"data-testid",
					`usage-footer-row-${accountId}`,
				);
		},
	},
	{
		name: "assert the highlighted current account in the phone dock or sheet",
		match:
			/^the (phone usage|usage sheet) row (\S+) is the highlighted current account$/,
		run: async ({ world, match }) => {
			const [scope, prefix] =
				match[1] === "usage sheet"
					? ["usage-sheet", "usage-sheet"]
					: ["usage-footer-phone", "usage-footer"];
			const row = world.page.getByTestId(`${prefix}-row-${match[2]}`);
			await expect(
				world.page.getByTestId(scope).locator('[data-default="true"]'),
			).toHaveCount(1);
			await expect(row).toHaveAttribute("data-default", "true");
			await expect(row).toHaveAttribute("title", "Current account");
			await expect(row).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-bg-alt"),
			);
			await expect(
				world.page.getByTestId(`${prefix}-name-${match[2]}`),
			).toHaveCSS("color", await themeColour(world.page, "--color-text"));
		},
	},
	{
		name: "assert the accounts folded behind the phone dock's count",
		match: /^the phone usage footer folds (\d+) more accounts?$/,
		run: async ({ world, match }) => {
			const count = Number(match[1]);
			const more = world.page.getByTestId("usage-phone-more");
			if (count === 0) {
				await expect(more).toHaveCount(0);
				return;
			}
			await expect(world.page.getByTestId("usage-phone-more-count")).toHaveText(
				`+${count} more`,
			);
			await expect(
				more.locator('[data-testid^="usage-phone-folded-"]'),
			).toHaveCount(count);
		},
	},
	{
		name: "open the usage sheet from the phone dock",
		match: /^I open the phone usage sheet$/,
		run: async ({ world }) => {
			await world.page.getByTestId("usage-phone-dock").click();
			await expect(world.page.getByTestId("usage-sheet")).toBeVisible();
			await expect(
				world.page.getByRole("dialog", { name: "Usage" }),
			).toBeVisible();
		},
	},
	{
		name: "assert the usage sheet lists every account by harness",
		match: /^the usage sheet groups read CLAUDE, CODEX, CURSOR with rows (.+)$/,
		run: async ({ world, match }) => {
			const sheet = world.page.getByTestId("usage-sheet");
			await expect(
				sheet.locator('[data-testid^="usage-sheet-heading-"]'),
			).toHaveText(["CLAUDE", "CODEX", "CURSOR"]);
			const expected = (match[1] ?? "").split(", ");
			const rows = sheet.locator('[data-testid^="usage-sheet-row-"]');
			await expect(rows).toHaveCount(expected.length);
			for (const [index, accountId] of expected.entries())
				await expect(rows.nth(index)).toHaveAttribute(
					"data-testid",
					`usage-sheet-row-${accountId}`,
				);
		},
	},
	{
		name: "pull the phone usage dock up with a finger",
		match: /^I drag the phone usage dock up by (\d+) pixels$/,
		run: async ({ world, match }) => {
			const box = await world.page
				.getByTestId("usage-phone-dock")
				.boundingBox();
			if (!box) throw new Error("Missing phone usage dock");
			await touchDrag(
				world.page,
				box.x + box.width / 2,
				box.y + box.height / 2,
				-Number(match[1]),
			);
		},
	},
	{
		name: "the usage sheet rises one for one with a finger on the dock",
		match: /^the usage sheet follows my finger up the phone usage dock$/,
		run: async ({ world }) => {
			const box = await world.page
				.getByTestId("usage-phone-dock")
				.boundingBox();
			if (!box) throw new Error("Missing phone usage dock");
			const sheet = world.page.getByTestId("usage-sheet");
			// Touch moves reach the page frame-aligned, so measure once two frames have passed.
			const settledTop = async () => {
				await world.page.evaluate(
					() =>
						new Promise((done) =>
							requestAnimationFrame(() => requestAnimationFrame(done)),
						),
				);
				return (await sheet.boundingBox())?.y ?? Number.NaN;
			};
			const finger = await touchFinger(
				world.page,
				box.x + box.width / 2,
				box.y + box.height / 2,
			);
			try {
				await finger.move(-60);
				const before = await settledTop();
				await finger.move(-40);
				const after = await settledTop();
				expect(before - after).toBeCloseTo(40, 0);
			} finally {
				await finger.lift();
			}
		},
	},
	{
		name: "the usage sheet folds into the dock rather than off screen",
		match:
			/^the usage sheet dragged down past the phone usage dock stops on it$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("usage-sheet");
			// A drag moves the sheet from where it rests, so let the opening glide finish first.
			await sheet.evaluate((node) =>
				Promise.all(
					(node.parentElement?.getAnimations() ?? []).map((a) => a.finished),
				),
			);
			const box = await sheet.boundingBox();
			const dock = await world.page
				.getByTestId("usage-footer-phone")
				.boundingBox();
			const viewport = world.page.viewportSize();
			if (!box || !dock || !viewport) throw new Error("Missing usage sheet");
			const startY = box.y + 10;
			const finger = await touchFinger(
				world.page,
				box.x + box.width / 2,
				startY,
			);
			try {
				// To the screen's edge: far past the dock even if the sheet was still rising.
				await finger.move(viewport.height - 2 - startY);
				await expect
					.poll(async () => (await sheet.boundingBox())?.y)
					.toBeCloseTo(dock.y, 0);
			} finally {
				await finger.lift();
			}
		},
	},
	{
		name: "the usage sheet wears the dock's background",
		match: /^the usage sheet has the phone usage dock's background$/,
		run: async ({ world }) => {
			const background = (testId: string) =>
				world.page
					.getByTestId(testId)
					.evaluate((node) => getComputedStyle(node).backgroundColor);
			expect(await background("usage-sheet")).toBe(
				await background("usage-footer-phone"),
			);
		},
	},
	{
		name: "pull the usage sheet down by its grab handle",
		match: /^I drag the usage sheet down by (\d+) pixels$/,
		run: async ({ world, match }) => {
			const box = await world.page.getByTestId("usage-sheet").boundingBox();
			if (!box) throw new Error("Missing usage sheet");
			await touchDrag(
				world.page,
				box.x + box.width / 2,
				box.y + 10,
				Number(match[1]),
			);
		},
	},
	{
		name: "assert whether the usage sheet is open",
		match: /^the usage sheet is (open|closed)$/,
		run: async ({ world, match }) => {
			const dialog = world.page.getByRole("dialog", { name: "Usage" });
			if (match[1] === "open") await expect(dialog).toBeVisible();
			else await expect(world.page.getByTestId("usage-sheet")).toHaveCount(0);
		},
	},
	{
		name: "assert an account's two windows in the usage sheet",
		match: /^the usage sheet (\S+) shows five_hour (\S+) and seven_day (\S+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-sheet-value-${match[1]}-five_hour`),
			).toHaveText(match[2] ?? "");
			await expect(
				world.page.getByTestId(`usage-sheet-value-${match[1]}-seven_day`),
			).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "open Usage settings from the usage sheet",
		match: /^I tap Settings in the usage sheet$/,
		run: async ({ world }) => {
			await world.page.getByTestId("usage-sheet-settings").click();
		},
	},
	{
		name: "assert the sheet gave way to Usage settings",
		match: /^the usage sheet is closed and Usage settings are open$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("usage-sheet")).toHaveCount(0);
			await expect(world.page.locator("#settings-panel")).toBeVisible();
			await expect(world.page.locator("#usage-limit-settings")).toBeVisible();
		},
	},
	{
		name: "assert the single phone account uses the inline design",
		match: /^the single phone usage footer shows 5h (\S+) and Wk (\S+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("usage-phone-single")).toBeVisible();
			await expect(world.page.getByTestId("usage-phone-dock")).toHaveCount(0);
			await expect(
				world.page.getByTestId("usage-phone-column-five_hour"),
			).toHaveText("5h");
			await expect(
				world.page.getByTestId("usage-phone-column-seven_day"),
			).toHaveText("Wk");
			await expect(
				world.page.getByTestId("usage-footer-value-claude-five_hour"),
			).toHaveText(match[1] ?? "");
			await expect(
				world.page.getByTestId("usage-footer-value-claude-seven_day"),
			).toHaveText(match[2] ?? "");
			await expect(
				world.page.getByTestId("usage-footer-bar-claude-five_hour"),
			).toHaveCSS("width", "40px");
			await expect(
				world.page.getByTestId("usage-footer-bar-claude-seven_day"),
			).toHaveCSS("width", "32px");
		},
	},
	{
		name: "assert missing plan data hides the phone footer",
		match: /^the phone usage footer is not visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("usage-footer-phone"),
			).not.toBeVisible();
			await expect(world.page.getByTestId("usage-phone-single")).toHaveCount(0);
		},
	},
	{
		name: "assert the dock, new-session button and last row stack without overlap",
		match:
			/^the phone usage footer clears the new-session button and the last row text$/,
		run: async ({ world }) => {
			const footer = world.page.getByTestId("usage-footer-phone");
			await expect(footer).toBeVisible();
			await expect
				.poll(async () => {
					await world.page
						.locator("#session-list-scroller")
						.evaluate((element) => {
							element.scrollTop = element.scrollHeight;
						});
					return footer.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						const button = document
							.querySelector("#new-session-btn")
							?.getBoundingClientRect();
						const scroller = document.querySelector("#session-list-scroller");
						const lastRow = scroller?.querySelectorAll(".session-item");
						const text = lastRow?.[lastRow.length - 1]?.querySelectorAll(
							".session-item-title, .session-item-context, .session-item-meta",
						);
						if (!button || !scroller || !text?.length)
							throw new Error("Missing phone list geometry");
						const listBounds = scroller.getBoundingClientRect();
						const textBounds = Array.from(text, (item) =>
							item.getBoundingClientRect(),
						).filter((box) => box.width > 0 && box.height > 0);
						return {
							scrollable: scroller.scrollHeight > scroller.clientHeight,
							dockAtBottom: Math.round(bounds.bottom) === window.innerHeight,
							buttonAboveDock: button.bottom <= bounds.top,
							lastTextClearOfButton:
								textBounds.length > 0 &&
								textBounds.every(
									(box) =>
										box.top >= listBounds.top && box.bottom <= button.top,
								),
						};
					});
				})
				.toEqual({
					scrollable: true,
					dockAtBottom: true,
					buttonAboveDock: true,
					lastTextClearOfButton: true,
				});
		},
	},
];
