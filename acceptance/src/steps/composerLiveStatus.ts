import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, setSessionRowStatus } from "./shared.js";

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
			setSessionRowStatus(world.page, "sess-mockup-001", "busy");
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
		name: "assert live turn head visibility",
		match: /^the live turn head is (visible|not visible)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("turn-live-head")
				.waitFor({ state: match[1] === "visible" ? "visible" : "hidden" });
		},
	},
	{
		name: "assert live turn elapsed label",
		match: /^the live turn elapsed label reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveText(
				match[1] ?? "",
			);
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
		name: "expand live turn step log",
		match: /^I expand the live turn step log$/,
		run: async ({ world }) => {
			const toggle = world.page
				.getByTestId("turn-live-head")
				.locator(".turn-activity-toggle");
			// A tap does not scroll the transcript; Playwright's actionability
			// scroll would detach the reader from the live bottom.
			if ((await toggle.getAttribute("aria-expanded")) !== "true")
				await toggle.evaluate((el: HTMLElement) => el.click());
		},
	},
	{
		name: "assert active reasoning in live step log",
		match: /^the live turn step log shows active reasoning (.+)$/,
		run: async ({ world, match }) => {
			const reasoning = world.page
				.getByTestId("turn-live-activity")
				.locator(".thinking-item:not(.done)");
			await expect(reasoning).toBeVisible();
			await expect(reasoning).toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert live turn step log activity",
		match: /^the live turn step log shows (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(".turn-activity").last()).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert live turn running line",
		match: /^the live turn running line is visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("turn-running")).toBeVisible();
		},
	},
	{
		name: "assert Jump to live visibility",
		match: /^the Jump to live control is (visible|not visible)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId("jump-to-live").waitFor({
				state: match[1] === "visible" ? "visible" : "hidden",
			});
		},
	},
	{
		name: "follow live output",
		match: /^I tap the Jump to live control$/,
		run: async ({ world }) => {
			await world.page.getByTestId("jump-to-live").click();
		},
	},
	{
		name: "stream a long live turn",
		match: /^the mock relay streams a long composer turn$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "delta",
				text:
					Array.from(
						{ length: 48 },
						(_, i) => `Live output paragraph ${i + 1}.`,
					).join("\n\n") + "\n\n",
				messageId: "composer-status-output",
			});
			await expect
				.poll(async () => {
					const output = await world.page
						.locator("#messages .msg-assistant")
						.last()
						.boundingBox();
					return output?.height ?? 0;
				})
				.toBeGreaterThan((world.page.viewportSize()?.height ?? 0) + 800);
		},
	},
	{
		name: "assert live turn intersects viewport",
		match: /^the live turn still intersects the viewport$/,
		run: async ({ world }) => {
			await expect(world.page.locator("[data-live-turn]")).toBeInViewport();
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
				world.page
					.locator("#messages .msg-assistant")
					.last()
					.locator(".md-content > :last-child"),
			).toBeInViewport();
		},
	},
];
