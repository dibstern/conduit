import { expect, type Page } from "@playwright/test";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const SESSION = "sess-turn-opening";
const PROMPT = "Review the change.";
const prompts = new WeakMap<Page, typeof HistoryMessageSchema.Type>();
const positions = new WeakMap<
	Page,
	{
		prompt: { x: number; y: number; width: number; height: number };
		head: { y: number; height: number };
	}
>();
const opening = (page: Page) => page.getByTestId("turn-opening");

export const turnOpeningHandlers: StepHandler[] = [
	{
		name: "seed a sent turn without steps",
		match: /^the turn opening prompt was sent (\d+) seconds ago$/,
		run: async ({ world, match }) => {
			const prompt: typeof HistoryMessageSchema.Type = {
				id: "turn-opening-user",
				role: "user",
				time: { created: PINNED_CLOCK_MS - Number(match[1]) * 1000 },
				parts: [{ id: "turn-opening-prompt", type: "text", text: PROMPT }],
			};
			prompts.set(world.page, prompt);
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				detailRowsOf(prompt),
			);
			setSessionRowStatus(world.page, SESSION, "busy", {
				title: "Turn opening acceptance",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
			await expect(world.page.locator("#messages .msg-user")).toContainText(
				PROMPT,
			);
		},
	},
	{
		name: "seed a busy session without transcript rows",
		match: /^the turn opening session is busy with no transcript rows$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setDetailRows(SESSION, []);
			setSessionRowStatus(world.page, SESSION, "busy", {
				title: "Turn opening acceptance",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
		},
	},
	{
		name: "report the draft send as busy before placing its prompt",
		match: /^the draft turn opening is reported busy$/,
		run: ({ world }) => {
			setSessionRowStatus(world.page, "sess-first-send", "busy");
		},
	},
	{
		name: "assert quiet turn opening",
		match:
			/^the turn opening reads (Sending…|Working) without a card or timer$/,
		run: async ({ world, match }) => {
			await expect(opening(world.page)).toBeVisible();
			await expect(opening(world.page)).toHaveText(match[1] ?? "");
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveCount(0);
		},
	},
	{
		name: "deliver a notice before any step",
		match: /^a retry notice arrives before the first step$/,
		run: ({ world }) => {
			setSessionRowStatus(world.page, SESSION, "busy", {
				retrying: "Provider is retrying.",
			});
		},
	},
	{
		name: "assert opening precedes its notice",
		match: /^the retry notice follows the turn opening$/,
		run: async ({ world }) => {
			const notice = world.page
				.locator("#messages")
				.getByText("Provider is retrying.", { exact: true });
			await expect(notice).toBeVisible();
			const pulse = await opening(world.page).boundingBox();
			const box = await notice.boundingBox();
			if (!pulse || !box) throw new Error("Opening or notice is unavailable");
			expect(box.y).toBeGreaterThanOrEqual(pulse.y + pulse.height);
		},
	},
	{
		name: "assert turn opening is absent",
		match: /^the turn opening is not visible$/,
		run: async ({ world }) => {
			await expect(opening(world.page)).toHaveCount(0);
		},
	},
	{
		name: "deliver the first ordinary step",
		match: /^the first ordinary turn opening step arrives$/,
		run: async ({ world }) => {
			const prompt = prompts.get(world.page);
			if (!prompt) throw new Error("Turn opening prompt was not seeded");
			const step: typeof HistoryMessageSchema.Type = {
				id: "turn-opening-assistant",
				role: "assistant",
				parentID: prompt.id,
				time: { created: PINNED_CLOCK_MS - 1000 },
				parts: [
					{
						id: "turn-opening-read",
						type: "tool",
						tool: "Read",
						callID: "turn-opening-read",
						time: { start: PINNED_CLOCK_MS - 1000 },
						state: {
							status: "running",
							input: { _tag: "whole", value: { filePath: "src/index.ts" } },
						},
					},
				],
			};
			requireRpcControl(world.page).setDetailRows(SESSION, [
				...detailRowsOf(prompt),
				...detailRowsOf(step),
			]);
		},
	},
	{
		name: "assert first step card and send-based timer",
		match: /^the turn opening is replaced by a Working card timed (.+)$/,
		run: async ({ world, match }) => {
			await expect(opening(world.page)).toHaveCount(0);
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				1,
			);
			await expect(world.page.getByTestId("turn-live-head")).toContainText(
				"Working",
			);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "record opening geometry",
		match: /^I record the turn opening prompt and head positions$/,
		run: async ({ world }) => {
			const prompt = await world.page
				.locator("#messages .msg-user")
				.boundingBox();
			const head = await opening(world.page)
				.locator(".assistant-header")
				.boundingBox();
			if (!prompt || !head) throw new Error("Opening geometry is unavailable");
			positions.set(world.page, { prompt, head });
		},
	},
	{
		name: "assert prompt does not move",
		match: /^the turn opening prompt bounding box is unchanged$/,
		run: async ({ world }) => {
			const before = positions.get(world.page);
			if (!before) throw new Error("Opening geometry was not recorded");
			await expect
				.poll(() => world.page.locator("#messages .msg-user").boundingBox())
				.toEqual(before.prompt);
		},
	},
	{
		name: "assert the turn's name row takes the opening row's place",
		match: /^the assistant name row occupies the opening row$/,
		run: async ({ world }) => {
			const before = positions.get(world.page);
			if (!before) throw new Error("Opening geometry was not recorded");
			const head = await world.page
				.locator("#messages .turn-activity .assistant-header")
				.last()
				.boundingBox();
			expect(head).not.toBeNull();
			expect(head?.y).toBe(before.head.y);
			expect(head?.height).toBe(before.head.height);
		},
	},
	{
		name: "enable reduced motion for opening",
		match: /^reduced motion is enabled for the turn opening$/,
		run: async ({ world }) => {
			await world.page.emulateMedia({ reducedMotion: "reduce" });
		},
	},
	{
		name: "assert opening has no running animation",
		match: /^the turn opening has no running animation$/,
		run: async ({ world }) => {
			expect(
				await opening(world.page).evaluate(
					(element) =>
						element
							.getAnimations({ subtree: true })
							.filter((animation) => animation.playState === "running").length,
				),
			).toBe(0);
		},
	},
];
