import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const cutOffMessageId = "msg-cut-off";

function currentSessionId(page: Page): string {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("The usage limit steps need an open session");
	return sessionId;
}

/** The transcript as the server last sent it. */
const transcripts = new WeakMap<Page, readonly Record<string, unknown>[]>();

function sendTranscript(
	page: Page,
	messages: readonly Record<string, unknown>[],
): void {
	transcripts.set(page, messages);
	requireRelayControl(page).sendMessage({
		type: "mock_transcript_snapshot",
		sessionId: currentSessionId(page),
		history: { messages, hasMore: false },
	});
}

/** The session row's limitRecovery, as the server last projected it. */
const limits = new WeakMap<Page, Record<string, unknown>>();

function projectLimit(page: Page, limitRecovery: unknown): void {
	setSessionRowStatus(page, currentSessionId(page), "idle", {
		title: "Provider tests",
		limitRecovery,
	});
}

export const usageLimitStripHandlers: StepHandler[] = [
	{
		name: "name a Claude account",
		match: /^the Claude account (\S+) is named (.+)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances: [
					{
						id: match[1],
						name: match[2],
						port: 0,
						managed: false,
						status: "healthy",
						restartCount: 0,
						createdAt: 1,
						driver: "claude",
					},
				],
			});
		},
	},
	{
		name: "seed a transcript ending in an unanswered message",
		match: /^the transcript ends with the unanswered message (.+)$/,
		run: async ({ world, match }) => {
			const text = match[1] ?? "";
			const created = PINNED_CLOCK_MS - 3 * 60_000;
			sendTranscript(world.page, [
				{
					id: "msg-limit-earlier",
					role: "user",
					time: { created },
					parts: [
						{
							id: "part-limit-earlier",
							type: "text",
							text: "Thread configDir through the subagent materializer",
						},
					],
				},
				{
					id: "msg-limit-earlier-reply",
					role: "assistant",
					parentID: "msg-limit-earlier",
					time: { created: created + 1, completed: created + 60_000 },
					parts: [
						{
							id: "part-limit-earlier-reply",
							type: "text",
							text: "Done. Both read paths now pass the session's config dir through the SDK worker; typecheck is clean.",
						},
					],
				},
				{
					id: cutOffMessageId,
					role: "user",
					time: { created: created + 120_000 },
					parts: [{ id: "part-cut-off", type: "text", text }],
				},
			]);
			await expect(
				world.page.locator("#messages .msg-user").last(),
			).toContainText(text);
		},
	},
	{
		name: "project a usage limit onto the session row",
		match: /^the session hits the (\S+) limit on (\S+) resetting at (\S+)$/,
		run: ({ world, match }) => {
			const resets = match[3] ?? "none";
			const limitRecovery = {
				instanceId: match[2],
				rateLimitType: match[1],
				...(resets === "none" ? {} : { resetsAt: Date.parse(resets) / 1000 }),
				cutOffMessageId,
				rearms: 0,
				continued: false,
			};
			limits.set(world.page, limitRecovery);
			projectLimit(world.page, limitRecovery);
		},
	},
	{
		name: "server clears the cut-off",
		match: /^the server clears the cut-off$/,
		run: ({ world }) => {
			const { cutOffMessageId: _, ...limitRecovery } =
				limits.get(world.page) ?? {};
			projectLimit(world.page, limitRecovery);
		},
	},
	{
		name: "server clears the usage limit",
		match: /^a reply clears the usage limit$/,
		run: ({ world }) => {
			projectLimit(world.page, null);
		},
	},
	{
		name: "assert usage limit strip text",
		match: /^the usage limit strip (title|detail) reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-limit-${match[1]}`),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert the strip sits directly above the composer",
		match: /^the usage limit strip sits directly above the composer$/,
		run: async ({ world }) => {
			const strip = world.page.getByTestId("usage-limit-strip");
			await expect(strip).toBeVisible();
			const [stripBox, inputBox] = await Promise.all([
				strip.boundingBox(),
				world.page.locator("#input-row").boundingBox(),
			]);
			if (!stripBox || !inputBox) throw new Error("No strip or composer box");
			expect(stripBox.x).toBeCloseTo(inputBox.x, 0);
			expect(stripBox.width).toBeCloseTo(inputBox.width, 0);
			expect(inputBox.y - (stripBox.y + stripBox.height)).toBeGreaterThan(0);
			expect(inputBox.y - (stripBox.y + stripBox.height)).toBeLessThan(12);
		},
	},
	{
		name: "assert visibility of the usage limit UI",
		match: /^the (usage limit strip|cut-off tag) is (visible|not visible)$/,
		run: async ({ world, match }) => {
			const target = world.page.getByTestId(
				match[1] === "cut-off tag" ? "cut-off-tag" : "usage-limit-strip",
			);
			if (match[2] === "visible") await expect(target).toBeVisible();
			else await expect(target).toHaveCount(0);
		},
	},
	{
		name: "assert cut-off tag text and placement",
		match: /^the cut-off tag under (.+) reads (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page
				.locator("#messages .msg-user")
				.filter({ hasText: match[1] ?? "" });
			const tag = card.getByTestId("cut-off-tag");
			await expect(tag).toHaveText(match[2] ?? "");
			await expect(world.page.getByTestId("cut-off-tag")).toHaveCount(1);
			// Right-aligned under the card: below it, ending at its right edge.
			const [tagBox, cardBox] = await Promise.all([
				tag.locator("button").boundingBox(),
				card.locator(":scope > div").first().boundingBox(),
			]);
			if (!tagBox || !cardBox) throw new Error("No tag or card box");
			expect(tagBox.y).toBeGreaterThan(cardBox.y + cardBox.height);
			expect(tagBox.x + tagBox.width).toBeCloseTo(cardBox.x + cardBox.width, 0);
		},
	},
	{
		name: "press Dismiss on the cut-off tag",
		match: /^I press Dismiss on the cut-off tag$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setResponse("DismissCutOff", { ok: true });
			await world.page.getByTestId("cut-off-dismiss").click();
		},
	},
	{
		name: "assert DismissCutOff RPC",
		match: /^the DismissCutOff RPC names the current session$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "DismissCutOff",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["projectSlug"]).toBe("myapp");
		},
	},
	{
		name: "press Try again on the usage limit strip",
		match: /^I press Try again on the usage limit strip$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setResponse("ContinueSession", {
				ok: true,
			});
			await world.page.getByTestId("usage-limit-try-again").click();
		},
	},
	{
		name: "assert ContinueSession RPC",
		match:
			/^the ContinueSession RPC continues the current session on (\S+) now$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "ContinueSession",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["projectSlug"]).toBe("myapp");
			expect(request.payload["instanceId"]).toBe(match[1]);
			expect(request.payload["expectedInstanceId"]).toBe(match[1]);
			expect(request.payload["at"]).toBeUndefined();
		},
	},
	{
		name: "assert Try again visibility",
		match: /^the usage limit strip (shows|has no) Try again$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId("usage-limit-try-again");
			if (match[1] === "has no") {
				await expect(button).toHaveCount(0);
				return;
			}
			await expect(button).toHaveText("Try again");
			await expect(button).toBeEnabled();
			const [buttonBox, stripBox] = await Promise.all([
				button.boundingBox(),
				world.page.getByTestId("usage-limit-strip").boundingBox(),
			]);
			if (!buttonBox || !stripBox) throw new Error("No button or strip box");
			// Desktop: the right slot of the strip. Phone: a full-width row of its own.
			const compact = (world.page.viewportSize()?.width ?? 1280) < 768;
			if (compact) expect(buttonBox.width).toBeGreaterThan(stripBox.width - 30);
			else
				expect(
					stripBox.x + stripBox.width - (buttonBox.x + buttonBox.width),
				).toBeLessThan(16);
		},
	},
	{
		name: "server marks the continuation running",
		match: /^the server starts the continuation$/,
		run: ({ world }) => {
			const limitRecovery = { ...limits.get(world.page), continued: true };
			limits.set(world.page, limitRecovery);
			projectLimit(world.page, limitRecovery);
		},
	},
	{
		name: "server records a resume and the reply",
		match:
			/^the session resumes on (\S+) by (user|reset|auto-switch) and replies (.+)$/,
		run: async ({ world, match }) => {
			const previous = transcripts.get(world.page) ?? [];
			const parent = previous.at(-1);
			const parentCreated =
				(parent?.["time"] as { created?: number } | undefined)?.created ??
				PINNED_CLOCK_MS - 60_000;
			const at = parentCreated + 30_000;
			sendTranscript(world.page, [
				...previous,
				{
					id: "msg-resumed-reply",
					role: "assistant",
					parentID: parent?.["id"],
					time: { created: at + 1, completed: at + 20_000 },
					parts: [
						{ id: "part-resumed-reply", type: "text", text: match[3] ?? "" },
					],
				},
			]);
			setSessionRowStatus(world.page, currentSessionId(world.page), "idle", {
				title: "Provider tests",
				limitRecovery: null,
				resumes: [{ at, instanceId: match[1], reason: match[2] }],
			});
			await expect(
				world.page.locator("#messages .msg-assistant").last(),
			).toContainText(match[3] ?? "");
		},
	},
	{
		name: "assert the transcript divider sits above the reply",
		match:
			/^the transcript divider reading (.+) sits directly above the reply (.+)$/,
		run: async ({ world, match }) => {
			const divider = world.page.getByTestId("transcript-divider");
			await expect(divider).toHaveCount(1);
			await expect(divider).toHaveText(match[1] ?? "");
			await expect(divider.locator("b")).toHaveCSS("color", "rgb(0, 229, 255)");
			const reply = world.page
				.locator("#messages .msg-assistant")
				.filter({ hasText: match[2] ?? "" });
			const user = world.page.locator("#messages .msg-user").last();
			const [dividerBox, replyBox, userBox] = await Promise.all([
				divider.boundingBox(),
				reply.boundingBox(),
				user.boundingBox(),
			]);
			if (!dividerBox || !replyBox || !userBox)
				throw new Error("No divider, reply or user box");
			expect(dividerBox.y).toBeGreaterThan(userBox.y + userBox.height - 1);
			expect(replyBox.y).toBeGreaterThan(dividerBox.y + dividerBox.height - 1);
			expect(replyBox.y - (dividerBox.y + dividerBox.height)).toBeLessThan(40);
		},
	},
];
