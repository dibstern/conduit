import { expect } from "@playwright/test";
import type {
	LimitRecovery,
	UsageReading,
} from "../../../src/lib/contracts/limit-recovery.js";
import type { StepHandler } from "../runtime.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { themeColour } from "./usageFooterMeter.js";
import {
	currentSessionId,
	projectLimit,
	setClaudeAccounts,
} from "./usageLimitStrip.js";
import { accountReading, snapshot } from "./usageSettings.js";

export const composerSendAtResetHandlers: StepHandler[] = [
	{
		name: "assert the composer's usage send mode",
		match: /^the composer send mode is (normal|warning|at-reset|switch)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#send")).toHaveAttribute(
				"data-send-mode",
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert neutral send during usage warning",
		match: /^the warning send button stays a neutral circle without words$/,
		run: async ({ world }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveText("");
			await expect(button).toHaveCSS("width", "34px");
			await expect(button).toHaveCSS("height", "34px");
			await expect(button).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-inverse-bg"),
			);
			await expect(button).toHaveCSS("box-shadow", "none");
			await expect(button.locator("svg.lucide-arrow-up")).toBeVisible();
			await expect(world.page.getByTestId("usage-warning-strip")).toBeVisible();
			await expect(
				world.page.getByTestId("composer-send-at-label"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the ordinary send button",
		match: /^the composer has a plain Send button$/,
		run: async ({ world }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveAccessibleName("Send");
			await expect(button).toHaveText("");
			await expect(button).toHaveCSS("box-shadow", "none");
			await expect(
				world.page.getByTestId("composer-send-at-label"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert accessible reset time and clock icon",
		match: /^the reset send control announces (.+)$/,
		run: async ({ world, match }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveAccessibleName(match[1] ?? "");
			await expect(button.locator("svg.lucide-clock")).toBeVisible();
			const caption = world.page.getByTestId("composer-send-at-label");
			if ((world.page.viewportSize()?.width ?? 0) < 768)
				await expect(caption).toHaveCount(0);
			else await expect(caption).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert phone reset clock geometry",
		match: /^the phone reset send control is a neutral 34 pixel clock$/,
		run: async ({ world }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveCSS("height", "34px");
			await expect(button).toHaveCSS("width", "34px");
			await expect(button).toHaveText("");
			await expect(button.locator("svg.lucide-clock")).toBeVisible();
			await expect(button).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-inverse-bg"),
			);
		},
	},
	{
		name: "assert neutral filled split send pill",
		match: /^the reset send split pill is neutral$/,
		run: async ({ world }) => {
			const group = world.page.getByTestId("composer-send-control");
			await expect(group).toHaveCSS("height", "34px");
			await expect(group).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-inverse-bg"),
			);
			await expect(group).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-inverse-text"),
			);
			await expect(
				group.getByTestId("composer-send-menu-trigger"),
			).toBeVisible();
		},
	},
	{
		name: "project a scheduled reset continuation without a cut-off",
		match: /^the session has a scheduled reset continuation at (\S+)$/,
		run: ({ world, match }) => {
			const scheduledAt = Date.parse(match[1] ?? "") / 1000;
			if (!Number.isFinite(scheduledAt))
				throw new Error("Invalid scheduled composer reset time");
			projectLimit(world.page, {
				instanceId: "claude",
				rateLimitType: "five_hour",
				limitedAt:
					(snapshot(world.page).find(
						(reading) => reading.accountId === "claude",
					)?.readAt ?? 0) - 1,
				rearms: 0,
				continued: false,
				scheduledAt,
			} satisfies LimitRecovery);
		},
	},
	{
		name: "queue submitted inputs through the existing pending-input projection",
		match: /^the mock relay holds submitted messages until reset$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const relay = requireRelayControl(world.page);
			rpc.setStubs({
				"input.submit": (request) => {
					const { sessionId, inputId, text } = request;
					const row = rpc.shellRows?.find(
						(candidate) => (candidate as { id?: string }).id === sessionId,
					) as
						| { accountId?: string | null; limitRecovery?: LimitRecovery }
						| undefined;
					const resetsAt = snapshot(world.page)
						.find((reading) => reading.accountId === row?.accountId)
						?.windows.find(
							(window) => window.utilization >= 100 && window.resetsAt,
						)?.resetsAt;
					if (row?.limitRecovery?.scheduledAt === undefined && resetsAt)
						projectLimit(world.page, {
							instanceId: row?.accountId ?? "",
							rateLimitType: "five_hour",
							limitedAt:
								(snapshot(world.page).find(
									(reading) => reading.accountId === row?.accountId,
								)?.readAt ?? 0) - 1,
							rearms: 0,
							continued: false,
							scheduledAt: Date.parse(resetsAt) / 1000,
						} satisfies LimitRecovery);
					relay.sendMessage({
						type: "mock_pending_input",
						sessionId,
						inputId,
						text,
					});
					return { ok: true, sessionId, handedOff: false };
				},
				"input.cancel": ({ sessionId, inputId }) => {
					relay.sendMessage({
						type: "mock_pending_input_removed",
						sessionId,
						inputId,
					});
					return { ok: true };
				},
			});
		},
	},
	{
		name: "commit the reset choice through the button or keyboard",
		match:
			/^I send the reset-bound message with (the button|the keyboard|the shortcut)$/,
		run: async ({ world, match }) => {
			const input = world.page.locator("#input");
			const text = await input.inputValue();
			if (match[1] === "the keyboard") await input.press("Enter");
			else if (match[1] === "the shortcut") await input.press("Meta+Enter");
			else await world.page.locator("#send").click();
			const rpc = requireRpcControl(world.page);
			await rpc.waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === text &&
					request.payload["sessionId"] === currentSessionId(world.page) &&
					request.payload["delivery"] === "queue",
			);
			expect(
				rpc
					.getRequests()
					.filter((request) => request.tag === "ContinueSession"),
			).toHaveLength(0);
			await expect(input).toHaveValue("");
		},
	},
	{
		name: "select the reset mode without sending",
		match: /^I choose Send at reset with (the pointer|the keyboard)$/,
		run: async ({ world, match }) => {
			const reset = world.page.getByTestId("composer-send-menu-reset");
			if (match[1] === "the keyboard") {
				await reset.focus();
				await reset.press("Enter");
			} else await reset.click();
			await expect(world.page.getByTestId("composer-send-menu")).toHaveCount(0);
		},
	},
	{
		name: "dismiss the send menu without changing the choice",
		match: /^I dismiss the composer send menu$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(world.page.getByTestId("composer-send-menu")).toHaveCount(0);
		},
	},
	{
		name: "assert the effective send label",
		match: /^the composer commit button announces (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#send")).toHaveAccessibleName(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert selection has sent no input or account switch",
		match: /^the composer has sent no message or account switch$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(
						(request) =>
							request.tag === "input.submit" ||
							request.tag === "ContinueSession",
					),
			).toHaveLength(0);
		},
	},
	{
		name: "open a session to check its composer send choice",
		match: /^I open send-menu session (\S+)$/,
		run: async ({ world, match }) => {
			const sessionId = match[1] ?? "";
			setSessionRowStatus(world.page, sessionId, "idle", {
				accountId: "claude",
			});
			await world.page
				.locator(
					`#session-list [data-session-id="${sessionId}"] .session-item-title`,
				)
				.click({ position: { x: 8, y: 6 } });
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${sessionId}(?:\\?|$)`),
			);
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "ViewSession" &&
					request.payload["sessionId"] === sessionId,
			);
			await expect(world.page.locator("#input")).toBeVisible();
		},
	},
	{
		name: "assert shortcut delivery keeps its queue or steer meaning",
		match: /^the composer commits (.+) as (queue|steer)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === match[1],
			);
			expect(request.payload["delivery"]).toBe(match[2]);
		},
	},
	{
		name: "assert the send menu chevron is present only when offered",
		match: /^the composer send menu trigger is (visible|absent)$/,
		run: async ({ world, match }) => {
			const trigger = world.page.getByTestId("composer-send-menu-trigger");
			if (match[1] === "absent") {
				await expect(trigger).toHaveCount(0);
				await expect(world.page.getByTestId("composer-send-menu")).toHaveCount(
					0,
				);
			} else {
				await expect(trigger).toBeVisible();
				await expect(trigger).toHaveAccessibleName("Send options");
				await expect(trigger.locator("svg")).toHaveCount(1);
				await expect(trigger.locator("button")).toHaveCount(0);
			}
		},
	},
	{
		name: "open the composer send options without sending",
		match: /^I open the composer send menu$/,
		run: async ({ world }) => {
			await world.page.getByTestId("composer-send-menu-trigger").click();
			// The viewport-only phone fixture has a mouse; do not leave it hovering a sheet row.
			const viewport = world.page.viewportSize();
			if (viewport && viewport.width < 768) await world.page.mouse.move(0, 0);
			await expect(world.page.getByTestId("composer-send-menu")).toBeVisible();
			await requireRpcControl(world.page).waitForRequest(
				(request) => request.tag === "QuotaForAccounts",
			);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(
						(request) =>
							request.tag === "input.submit" ||
							request.tag === "ContinueSession",
					),
			).toHaveLength(0);
		},
	},
	{
		name: "assert the reset choice and its selection state come first",
		match: /^the send menu starts with (selected|unselected) (.+) on (.+)$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByTestId("composer-send-menu");
			const reset = menu.getByRole("menuitem").first();
			await expect(reset).toHaveAttribute(
				"data-testid",
				"composer-send-menu-reset",
			);
			if (match[1] === "selected") {
				await expect(reset).toHaveAttribute("data-selected", "true");
				await expect(reset).toHaveCSS(
					"background-color",
					await themeColour(world.page, "--color-border-chip"),
				);
			} else await expect(reset).not.toHaveAttribute("data-selected", "true");
			await expect(
				reset.getByText(match[2] ?? "", { exact: true }),
			).toBeVisible();
			await expect(reset.getByText(match[3] ?? "", { exact: true })).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-text-dimmer"),
			);
			await expect(reset.locator("svg")).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-status-red"),
			);
		},
	},
	{
		name: "assert the selected account row",
		match: /^the send menu selects account (\S+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("composer-send-menu-account")
					.and(world.page.locator(`[data-account="${match[1]}"]`)),
			).toHaveAttribute("data-selected", "true");
		},
	},
	{
		name: "assert the current-account override is absent",
		match: /^the send menu has no Send now on this account option$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("menuitem", {
					name: "Send now on this account",
					exact: true,
				}),
			).toHaveCount(0);
		},
	},
	{
		name: "assert account choices follow the persisted switch order",
		match: /^the send menu account order is (.+)$/,
		run: async ({ world, match }) => {
			const accounts = match[1] === "none" ? [] : (match[1] ?? "").split(", ");
			const menu = world.page.getByTestId("composer-send-menu");
			const rows = menu.getByTestId("composer-send-menu-account");
			await expect(rows).toHaveCount(accounts.length);
			await expect(menu.getByRole("menuitem")).toHaveCount(accounts.length + 1);
			for (const [index, account] of accounts.entries()) {
				await expect(rows.nth(index)).toHaveAttribute("data-account", account);
				await expect(
					rows.nth(index).getByTestId("account-dot"),
				).toHaveAttribute("data-account", account);
			}
		},
	},
	{
		name: "assert an account's name and fuller plan window",
		match:
			/^send menu account (\S+) offers Send now on (.+) with (5h|wk) ([0-9]+)%$/,
		run: async ({ world, match }) => {
			const row = world.page
				.getByTestId("composer-send-menu-account")
				.and(world.page.locator(`[data-account="${match[1]}"]`));
			await expect(
				row.getByText(`Send now on ${match[2]}`, { exact: true }),
			).toBeVisible();
			await expect(
				row.getByText(`${match[3]} ${match[4]}%`, { exact: true }),
			).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-text-dimmer"),
			);
		},
	},
	{
		name: "assert an account's unknown Usage Reading label",
		match:
			/^send menu account (\S+) offers Send now on (.+) with usage unknown$/,
		run: async ({ world, match }) => {
			const row = world.page
				.getByTestId("composer-send-menu-account")
				.and(world.page.locator(`[data-account="${match[1]}"]`));
			await expect(
				row.getByText(`Send now on ${match[2]}`, { exact: true }),
			).toBeVisible();
			await expect(row.getByText("usage unknown", { exact: true })).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-text-dimmer"),
			);
		},
	},
	{
		name: "publish a stale Usage Reading through the shared mock feed",
		match: /^the mock usage reading for (\S+) becomes stale$/,
		run: ({ world, match }) => {
			const readings = snapshot(world.page).map((reading) =>
				reading.accountId === match[1] ? { ...reading, stale: true } : reading,
			);
			const rpc = requireRpcControl(world.page);
			rpc.setUsageReadings(readings);
			rpc.setStubs({ QuotaForAccounts: () => readings });
		},
	},
	{
		name: "project a composer's Limit Recovery beside its Usage Reading",
		match:
			/^the session has a Limit Recovery recorded at (\S+) resetting at (\S+)$/,
		run: ({ world, match }) => {
			projectLimit(world.page, {
				instanceId: "claude",
				rateLimitType: "five_hour",
				...(match[1] === "unknown"
					? {}
					: { limitedAt: Date.parse(match[1] ?? "") }),
				resetsAt: Date.parse(match[2] ?? "") / 1000,
				rearms: 0,
				continued: false,
			});
		},
	},
	{
		name: "assert the send menu footnote wraps under a border",
		match: /^the send menu explains the account takeover$/,
		run: async ({ world }) => {
			const note = world.page.getByTestId("composer-send-menu-note");
			await expect(note).toHaveText(
				"Another account takes over the session, as Switch account does.",
			);
			await expect(note).toHaveCSS("white-space", "normal");
			await expect(note).toHaveCSS("border-top-width", "1px");
			await expect(note).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-text-dimmer"),
			);
		},
	},
	{
		name: "assert desktop positioning or the phone sheet",
		match: /^the send menu is a (popover|sheet)$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByTestId("composer-send-menu");
			const menuBox = await menu.boundingBox();
			const triggerBox = await world.page
				.getByTestId("composer-send-menu-trigger")
				.boundingBox();
			const viewport = world.page.viewportSize();
			if (!menuBox || !triggerBox || !viewport)
				throw new Error("Missing send menu geometry");
			if (match[1] === "sheet") {
				await expect(world.page.getByTestId("menu-sheet-scrim")).toBeVisible();
				expect(menuBox.x).toBeCloseTo(0, 0);
				expect(menuBox.width).toBeCloseTo(viewport.width, 0);
				expect(menuBox.y + menuBox.height).toBeCloseTo(viewport.height, 0);
			} else {
				await expect(world.page.getByTestId("menu-sheet-scrim")).toHaveCount(0);
				await expect(menu).toHaveCSS("width", "250px");
				expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
				// The popover snaps to whole pixels; the trigger can sit on a half pixel.
				expect(
					Math.abs(
						menuBox.x + menuBox.width - (triggerBox.x + triggerBox.width),
					),
				).toBeLessThanOrEqual(0.5);
			}
		},
	},
	{
		name: "seed limited, unread and freshly blocked alternative accounts",
		match: /^the send menu also has limited and unread accounts$/,
		run: async ({ world }) => {
			setClaudeAccounts(world.page, [
				["claude", "Personal"],
				["work", "Work"],
				["spare", "Spare"],
				["limited", "Limited"],
				["unknown", "Unknown"],
				["unavailable", "Unavailable"],
				["missing", "Missing"],
				["blocked", "Blocked"],
				["unmeasured", "Unmeasured"],
				["full", "Full"],
			]);
			const now = await world.page.evaluate(() => Date.now());
			const readings: UsageReading[] = [
				...snapshot(world.page),
				accountReading("limited", "Pro", [100, 9], now),
				{ ...accountReading("unknown", "Pro", [0, 9], now), status: "unknown" },
				{
					...accountReading("unavailable", "Pro", [0, 9], now),
					status: "unavailable",
				},
				accountReading("blocked", "Pro", [0, 9], now),
				{ ...accountReading("unmeasured", "Pro", [0, 9], now), windows: [] },
				{
					...accountReading("full", "Pro", [100, 9], now),
					status: "available",
				},
			];
			const rpc = requireRpcControl(world.page);
			rpc.setUsageReadings(readings);
			rpc.setStubs({
				QuotaForAccounts: () =>
					readings.map((reading) =>
						reading.accountId === "blocked"
							? accountReading("blocked", "Pro", [100, 9], now)
							: reading,
					),
			});
		},
	},
	{
		name: "accept a menu switch and project its destination account",
		match: /^the mock relay accepts send-menu switches$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				ContinueSession: ({ sessionId, instanceId, expectedInstanceId }) => {
					if (
						typeof sessionId !== "string" ||
						typeof instanceId !== "string" ||
						typeof expectedInstanceId !== "string"
					)
						throw new Error("Incomplete send-menu switch");
					setSessionRowStatus(world.page, sessionId, "idle", {
						accountId: instanceId,
						limitRecovery: null,
						resumes: [
							{
								at: Date.parse("2026-01-01T14:25:00Z"),
								instanceId,
								from: expectedInstanceId,
								reason: "user",
							},
						],
					});
					return { ok: true };
				},
			});
		},
	},
	{
		name: "select a send-now account without sending",
		match: /^I choose Send now on (\S+)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("composer-send-menu-account")
				.and(world.page.locator(`[data-account="${match[1]}"]`))
				.click();
			await expect(world.page.getByTestId("composer-send-menu")).toHaveCount(0);
		},
	},
	{
		name: "commit the account choice through the button or keyboard",
		match:
			/^I send the switch-bound message with (the button|the keyboard|the shortcut)$/,
		run: async ({ world, match }) => {
			if (match[1] === "the keyboard")
				await world.page.locator("#input").press("Enter");
			else if (match[1] === "the shortcut")
				await world.page.locator("#input").press("Meta+Enter");
			else await world.page.locator("#send").click();
		},
	},
	{
		name: "assert the switch finishes before this session's composer submission",
		match: /^the composer submits (.+) after switching to (\S+)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const submitted = await rpc.waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === match[1],
			);
			const requests = rpc.getRequests();
			const switches = requests.filter(
				(request) => request.tag === "ContinueSession",
			);
			expect(switches).toHaveLength(1);
			const switched = switches[0];
			if (!switched) throw new Error("No send-menu switch was recorded");
			expect(switched.payload["instanceId"]).toBe(match[2]);
			expect(switched.payload["expectedInstanceId"]).toBe("claude");
			expect(switched.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(switched.payload["originId"]).toBeTruthy();
			expect(submitted.payload["originId"]).toBe(switched.payload["originId"]);
			expect(submitted.payload["sessionId"]).toBe(
				switched.payload["sessionId"],
			);
			expect(requests.indexOf(submitted)).toBeGreaterThan(
				requests.indexOf(switched),
			);
			expect(
				requests.filter((request) => request.tag === "PreviewContinuation"),
			).toHaveLength(0);
			await expect(world.page.getByTestId("handoff-dialog")).toHaveCount(0);
			await expect(world.page.locator("#input")).toHaveValue("");
		},
	},
	{
		name: "assert a refused account switch sends no input",
		match: /^the refused send-menu switch submits no input$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "input.submit"),
			).toHaveLength(0);
		},
	},
	{
		name: "assert the neutral auto-switch pill names its first account",
		match: /^the auto-switch send button reads (.+) for (\S+)$/,
		run: async ({ world, match }) => {
			const button = world.page.locator("#send");
			await expect(button.getByTestId("composer-send-switch-label")).toHaveText(
				match[1]?.replace(/^Send on /, "") ?? "",
			);
			await expect(button).toHaveAccessibleName(
				`Send on ${match[1]?.replace(/^Send on /, "")}`,
			);
			await expect(button.getByTestId("account-dot")).toHaveAttribute(
				"data-account",
				match[2] ?? "",
			);
			await expect(button).toHaveCSS(
				"color",
				await themeColour(world.page, "--color-inverse-text"),
			);
			await expect(world.page.getByTestId("composer-send-control")).toHaveCSS(
				"background-color",
				await themeColour(world.page, "--color-inverse-bg"),
			);
		},
	},
	{
		name: "assert a queued input's release caption",
		match: /^pending-input row ([0-9]+) has the reset caption (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("pending-input-row")
					.nth(Number(match[1]) - 1)
					.getByTestId("pending-input-sends-at"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "edit or remove the queued reset input",
		match: /^I (Edit|Remove) pending reset input row ([0-9]+)$/,
		run: async ({ world, match }) => {
			const row = world.page
				.getByTestId("pending-input-row")
				.nth(Number(match[2]) - 1);
			const inputId = await row.getAttribute("data-input-id");
			await row
				.getByTestId(
					match[1] === "Edit" ? "pending-input-edit" : "pending-input-remove",
				)
				.click();
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.cancel" &&
					request.payload["inputId"] === inputId,
			);
			await expect(
				world.page.locator(
					`[data-testid="pending-input-row"][data-input-id="${inputId}"]`,
				),
			).toHaveCount(0);
		},
	},
];
