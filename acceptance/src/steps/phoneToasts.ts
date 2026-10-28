import { expect } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

const sheetSelector =
	'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]';

export const phoneToastsHandlers: StepHandler[] = [
	{
		name: "fail the phone list's real pin request",
		match: /^pinning a phone session fails$/,
		run: async ({ world }) => {
			const cards = world.page.getByTestId("toast");
			const previous = (await cards.count())
				? await cards.elementHandle()
				: null;
			requireRpcControl(world.page).setStubs({
				SetSessionPinned: () => {
					throw new WsRpcError({ message: "Please try again." });
				},
			});
			await world.page
				.locator('[data-session-id="sess-usage-footer-1"]')
				.click({ button: "right" });
			await world.page.getByTestId("session-ctx-pin").click();
			// Newest first; a replaced card lingers while it plays its exit.
			await expect(world.page.getByTestId("toast").first()).toContainText(
				"Couldn't pin session",
			);
			// Wait for the second response to replace the first card before counting.
			if (previous) {
				await expect
					.poll(() => previous.evaluate((element) => element.isConnected))
					.toBe(false);
				await previous.dispose();
			}
		},
	},
	{
		name: "assert the error toast is visible",
		match: /^the phone error toast is visible$/,
		run: async ({ world }) => {
			const toast = world.page.getByTestId("toast");
			await expect(toast).toBeVisible();
			await expect(toast).toHaveAttribute("data-variant", "error");
			await expect(toast).toContainText("Please try again.");
		},
	},
	{
		name: "assert the top toast clears New session and leaves it tappable",
		match:
			/^the toast floats at the top, clear of New session, which receives taps$/,
		run: async ({ world }) => {
			const button = world.page.locator("#new-session-btn:visible");
			await expect(button).toBeVisible();
			await expect
				.poll(() =>
					button.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const toast = document
							.querySelector('[data-testid="toast"]')
							?.getBoundingClientRect();
						const hit = document.elementFromPoint(
							box.x + box.width / 2,
							box.y + box.height / 2,
						);
						return {
							belowNewSession: !!toast && box.bottom <= toast.top,
							insetPx: toast && [
								Math.round(toast.left),
								Math.round(window.innerWidth - toast.right),
							],
							hitTarget: !!hit && element.contains(hit),
						};
					}),
				)
				.toEqual({ belowNewSession: true, insetPx: [8, 8], hitTarget: true });
		},
	},
	{
		name: "tap New session beside the toast",
		match: /^I tap New session beside the toast$/,
		run: async ({ world }) => {
			await world.page.locator("#new-session-btn:visible").click();
		},
	},
	{
		name: "the open session starts asking for approval",
		match: /^the open session starts asking for approval$/,
		run: ({ world }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			setSessionRowStatus(world.page, sessionId, "idle", {
				attention: "needs-approval",
				pendingPermissionCount: 1,
			});
		},
	},
	{
		name: "another usage footer session starts asking for approval",
		match: /^Usage footer session ([0-9]+) starts asking for approval$/,
		run: ({ world, match }) => {
			setSessionRowStatus(world.page, `sess-usage-footer-${match[1]}`, "idle", {
				title: `Usage footer session ${match[1]}`,
				attention: "needs-approval",
				pendingPermissionCount: 1,
			});
		},
	},
	{
		name: "assert the single arrival toast",
		match: /^an arrival toast says (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page.getByTestId("toast");
			await expect(toast).toHaveCount(1);
			await expect(toast).toHaveAttribute("data-variant", "attention");
			await expect(toast).toHaveAttribute("role", "status");
			await expect(
				toast.getByText(match[1] ?? "", { exact: true }),
			).toBeVisible();
			await expect(toast.getByTestId("toast-action")).toHaveText("Open");
		},
	},
	{
		name: "assert the toast sits between the session bar and the composer",
		match: /^the toast floats between the session bar and the composer$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page.evaluate(() => {
						const [toast, back, composer] = [
							'[data-testid="toast"]',
							'[data-testid="session-bar-back"]',
							"#input-area",
						].map((selector) =>
							document.querySelector(selector)?.getBoundingClientRect(),
						);
						return {
							belowBar: !!toast && !!back && back.bottom <= toast.top,
							aboveComposer:
								!!toast && !!composer && toast.bottom <= composer.top,
						};
					}),
				)
				.toEqual({ belowBar: true, aboveComposer: true });
		},
	},
	{
		name: "tap Open on the arrival toast",
		match: /^I tap Open on the arrival toast$/,
		run: async ({ world }) => {
			await world.page.getByTestId("toast").getByTestId("toast-action").click();
		},
	},
	{
		name: "assert the chat for a session is open",
		match: /^the chat for (sess-[a-z0-9-]+) is open$/,
		run: async ({ world, match }) => {
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${match[1]}(?:[/?]|$)`),
			);
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
	{
		name: "assert the toast floats above the open session sheet",
		match: /^the toast floats above the open session sheet$/,
		run: async ({ world }) => {
			const sheet = world.page.locator(sheetSelector);
			await expect(sheet).toBeVisible();
			await expect(sheet.getByTestId("toast")).toHaveCount(0);
			const toast = world.page.getByTestId("toast");
			await expect
				.poll(() =>
					toast.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const hit = document.elementFromPoint(
							box.x + box.width / 2,
							box.y + box.height / 2,
						);
						return !!hit && element.contains(hit);
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "dismiss the toast",
		match: /^I dismiss the toast$/,
		run: async ({ world }) => {
			await world.page.getByTestId("toast-close").click();
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
	{
		name: "assert the session sheet survived the toast",
		match: /^the session sheet is still open$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator(`:is(${sheetSelector})[data-state="open"]`),
			).toBeVisible();
		},
	},
	{
		name: "assert New session opened a draft",
		match: /^a new session draft is open$/,
		run: async ({ world }) => {
			await expect(world.page).toHaveURL(/\/draft\/[^/?]+(?:\?|$)/);
			await expect(world.page.locator("#input-area")).toBeVisible();
		},
	},
	{
		name: "assert identical errors leave one toast card",
		match: /^exactly one toast card is visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("toast")).toHaveCount(1);
		},
	},
];
