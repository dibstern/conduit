import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const STATUS_CLOCK = new Date("2026-10-02T00:00:00Z");

export const composerLiveStatusHandlers: StepHandler[] = [
	{
		name: "freeze composer status clock",
		match: /^the composer status clock is frozen$/,
		run: async ({ world }) => {
			// Freeze Date without pausing animation frames, timers or feed retries.
			await world.page.clock.setFixedTime(STATUS_CLOCK);
		},
	},
	{
		name: "start composer turn",
		match: /^the mock relay starts a composer turn$/,
		run: async ({ world }) => {
			const createdAt = await world.page.evaluate(() => Date.now());
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "user_message",
				sessionId: "sess-mockup-001",
				messageId: `composer-status-user-${createdAt}`,
				text: "Start a composer turn.",
				createdAt,
			});
			relay.sendMessage({
				type: "status",
				status: "processing",
				sessionId: "sess-mockup-001",
			});
			await world.page.locator("#stop").waitFor({ state: "visible" });
		},
	},
	{
		name: "advance composer status clock",
		match: /^the composer status clock advances by ([0-9]+) seconds$/,
		run: async ({ world, match }) => {
			await world.page.clock.setFixedTime(
				new Date(STATUS_CLOCK.getTime() + Number(match[1]) * 1000),
			);
		},
	},
	{
		name: "assert composer status visibility",
		match: /^the composer status header is (visible|not visible)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId("composer-status-header").waitFor({
				state: match[1] === "visible" ? "visible" : "hidden",
			});
		},
	},
	{
		name: "assert composer elapsed label",
		match: /^the composer elapsed label reads (Working [0-9]+:[0-9:]+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("composer-status-elapsed"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "replay composer reasoning",
		match: /^the mock relay (begins|ends) composer reasoning$/,
		run: async ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: match[1] === "begins" ? "thinking_delta" : "thinking_stop",
				text: "Consider the next step.",
				messageId: "composer-status-turn",
			});
		},
	},
	{
		name: "replay composer tool",
		match: /^the mock relay runs (Bash|Read) with (.+)$/,
		run: async ({ world, match }) => {
			const name = match[1] ?? "Read";
			const argument = match[2] ?? "";
			const relay = requireRelayControl(world.page);
			const id = `composer-status-${name}`;
			relay.sendMessage({
				type: "tool_start",
				id,
				name,
				messageId: "composer-status-turn",
			});
			// Wait for the projected tool before the retained input update.
			await world.page.locator(`[data-tool-id="${id}"]`).waitFor();
			relay.sendMessage({
				type: "tool_executing",
				id,
				name,
				input: name === "Bash" ? { command: argument } : { filePath: argument },
			});
		},
	},
	{
		name: "finish composer tool",
		match: /^the mock relay finishes the composer tool$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "tool_result",
				id: "composer-status-Bash",
				content: "Finished",
				is_error: false,
			});
		},
	},
	{
		name: "assert composer activity",
		match: /^the composer activity reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("composer-status-activity"),
			).toHaveText(`· ${match[1] ?? ""}`);
		},
	},
	{
		name: "assert composer activity absent",
		match: /^the composer activity is not visible$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("composer-status-activity")
				.waitFor({ state: "hidden" });
		},
	},
	{
		name: "assert composer activity truncation",
		match: /^the composer activity is truncated to one line$/,
		run: async ({ world }) => {
			await world.page.waitForFunction(() => {
				const activity = document.querySelector(
					'[data-testid="composer-status-activity"]',
				);
				if (!(activity instanceof HTMLElement)) return false;
				const style = getComputedStyle(activity);
				return (
					style.whiteSpace === "nowrap" &&
					style.textOverflow === "ellipsis" &&
					style.overflowX === "hidden" &&
					activity.scrollWidth > activity.clientWidth &&
					activity.getBoundingClientRect().height <=
						Number.parseFloat(style.lineHeight) + 1
				);
			});
		},
	},
	{
		name: "assert composer live control visibility",
		match: /^the composer live control is (visible|not visible)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId("composer-status-live").waitFor({
				state: match[1] === "visible" ? "visible" : "hidden",
			});
		},
	},
	{
		name: "follow latest composer output",
		match: /^I tap the composer live control$/,
		run: async ({ world }) => {
			await world.page.getByTestId("composer-status-live").click();
		},
	},
	{
		name: "stream composer output",
		match: /^the mock relay streams composer output (.+)$/,
		run: async ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "delta",
				text: match[1] ?? "",
				messageId: "composer-status-output",
			});
			await expect(world.page.locator("#messages")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert latest composer output visible",
		match: /^the latest composer output is visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator("#messages .msg-assistant").last(),
			).toBeInViewport();
		},
	},
];
