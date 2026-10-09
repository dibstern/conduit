import { expect, type Page } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const cutOffMessageId = "msg-cut-off";

const pickerRow = (page: Page, name: string) =>
	page.getByTestId("account-switch-option").filter({ hasText: name });

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

function setClaudeAccounts(
	page: Page,
	accounts: readonly (readonly [id: string, name: string])[],
): void {
	requireRpcControl(page).setDaemonList("SubscribeInstances", {
		instances: accounts.map(([id, name]) => ({
			id,
			name,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1,
			driver: "claude",
		})),
	});
}

type StripAction = "Try again" | "Resume at reset" | "Cancel auto-resume";

const stripActions: Record<StripAction, { testId: string; rpc: string }> = {
	"Try again": { testId: "usage-limit-try-again", rpc: "ContinueSession" },
	"Resume at reset": {
		testId: "usage-limit-resume-at-reset",
		rpc: "ContinueSession",
	},
	"Cancel auto-resume": {
		testId: "usage-limit-cancel-resume",
		rpc: "CancelContinuation",
	},
};

export const usageLimitStripHandlers: StepHandler[] = [
	{
		name: "name a Claude account",
		match: /^the Claude account (\S+) is named (.+)$/,
		run: ({ world, match }) => {
			setClaudeAccounts(world.page, [[match[1] ?? "", match[2] ?? ""]]);
		},
	},
	{
		name: "name several Claude accounts",
		match: /^the Claude accounts are (.+)$/,
		run: ({ world, match }) => {
			setClaudeAccounts(
				world.page,
				(match[1] ?? "").split(", ").map((account) => {
					const [id = "", name = ""] = account.split(" as ");
					return [id, name];
				}),
			);
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
		name: "press a usage limit strip action",
		match:
			/^I press (Try again|Resume at reset|Cancel auto-resume) on the usage limit strip$/,
		run: async ({ world, match }) => {
			const action = stripActions[match[1] as StripAction];
			requireRpcControl(world.page).setResponse(action.rpc, { ok: true });
			await world.page.getByTestId(action.testId).click();
		},
	},
	{
		name: "assert ContinueSession RPC",
		match:
			/^the ContinueSession RPC continues the current session on (\S+) (now|at (\S+))$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "ContinueSession",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["projectSlug"]).toBe("myapp");
			expect(request.payload["instanceId"]).toBe(match[1]);
			expect(request.payload["expectedInstanceId"]).toBe(match[1]);
			expect(request.payload["at"]).toBe(
				match[3] === undefined ? undefined : Date.parse(match[3]) / 1000,
			);
		},
	},
	{
		name: "assert CancelContinuation RPC",
		match: /^the CancelContinuation RPC names the current session$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "CancelContinuation",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["projectSlug"]).toBe("myapp");
		},
	},
	{
		name: "assert a usage limit strip action",
		match:
			/^the usage limit strip (shows|has no) (Try again|Resume at reset|Cancel auto-resume)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				stripActions[match[2] as StripAction].testId,
			);
			if (match[1] === "has no") {
				await expect(button).toHaveCount(0);
				return;
			}
			await expect(button).toHaveText(match[2] ?? "");
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
		name: "assert the usage limit strip state",
		match: /^the usage limit strip is (limited|waiting)$/,
		run: async ({ world, match }) => {
			const strip = world.page.getByTestId("usage-limit-strip");
			await expect(strip).toHaveAttribute("data-state", match[1] ?? "");
			// Waiting wears the theme amber (#f4b740) at 40%; limited the red at 45%.
			await expect(strip).toHaveCSS(
				"border-top-color",
				match[1] === "waiting"
					? "oklab(0.815817 0.0250889 0.14507 / 0.4)"
					: "oklab(0.684887 0.17753 0.0399031 / 0.45)",
			);
		},
	},
	{
		name: "server schedules or cancels the resume",
		match: /^the server (schedules|cancels) the resume at reset$/,
		run: ({ world, match }) => {
			const { scheduledAt: _, ...limited } = limits.get(world.page) ?? {};
			const limitRecovery =
				match[1] === "schedules"
					? { ...limited, scheduledAt: limited["resetsAt"] }
					: limited;
			limits.set(world.page, limitRecovery);
			projectLimit(world.page, limitRecovery);
		},
	},
	{
		name: "the limit policy schedules the resume",
		match: /^the limit policy schedules the resume at reset$/,
		run: ({ world }) => {
			const limited = limits.get(world.page) ?? {};
			const limitRecovery = {
				...limited,
				scheduledAt: limited["resetsAt"],
				auto: true,
			};
			limits.set(world.page, limitRecovery);
			projectLimit(world.page, limitRecovery);
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
			/^the session resumes on (\S+)(?: from (\S+))? by (user|reset|auto-switch) and replies (.+)$/,
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
						{ id: "part-resumed-reply", type: "text", text: match[4] ?? "" },
					],
				},
			]);
			setSessionRowStatus(world.page, currentSessionId(world.page), "idle", {
				title: "Provider tests",
				limitRecovery: null,
				resumes: [
					{
						at,
						instanceId: match[1],
						reason: match[3],
						...(match[2] === undefined ? {} : { from: match[2] }),
					},
				],
			});
			await expect(
				world.page.locator("#messages .msg-assistant").last(),
			).toContainText(match[4] ?? "");
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
	{
		name: "quota check results for the accounts",
		match: /^the quota check reads (.+)$/,
		run: ({ world, match }) => {
			const accounts = (match[1] ?? "").split(", ").map((reading) => {
				const [instanceId = "", ...words] = reading.split(" ");
				const said = words.join(" ");
				const used = /^(\d+)% used$/.exec(said)?.[1];
				const limitedUntil = /^limited until (\S+)$/.exec(said)?.[1];
				const quota =
					used !== undefined
						? { _tag: "Available", utilization: Number(used) }
						: limitedUntil !== undefined
							? {
									_tag: "Limited",
									rateLimitType: "seven_day",
									resetsAt: Date.parse(limitedUntil) / 1000,
								}
							: said === "unavailable"
								? { _tag: "Unavailable", reason: "not logged in" }
								: { _tag: "Unknown" };
				return { instanceId, quota };
			});
			requireRpcControl(world.page).setResponse("QuotaForAccounts", {
				accounts,
			});
		},
	},
	{
		name: "handoff summary for the preview and the delivered handoff",
		match:
			/^the handoff carries (\d+) of (\d+) messages (with|without) the first$/,
		run: ({ world, match }) => {
			const included = Number(match[1]);
			const summary = {
				included,
				omitted: Number(match[2]) - included,
				firstMessageIncluded: match[3] === "with",
				tokens: 18_400,
			};
			const rpc = requireRpcControl(world.page);
			rpc.setResponse("PreviewContinuation", summary);
			rpc.setResponse("GetContinuationHandoff", {
				handoff: {
					...summary,
					eventId: "evt-handoff",
					instanceId: "self",
					at: PINNED_CLOCK_MS - 60_000,
				},
			});
		},
	},
	{
		name: "open the account picker",
		match: /^I open Switch account on the usage limit strip$/,
		run: async ({ world }) => {
			await world.page.getByTestId("usage-limit-switch-account").click();
			await expect(
				world.page.getByTestId("account-switch-picker"),
			).toBeVisible();
		},
	},
	{
		name: "assert an account picker row",
		match:
			/^the account picker row for (.+) reads (.+) and (can|cannot) be picked$/,
		run: async ({ world, match }) => {
			const row = pickerRow(world.page, match[1] ?? "");
			await expect(row.getByTestId("quota-meter-caption")).toHaveText(
				match[2] ?? "",
			);
			if (match[3] === "can")
				await expect(row).not.toHaveAttribute("data-disabled");
			else await expect(row).toHaveAttribute("data-disabled");
		},
	},
	{
		name: "assert the pre-selected account",
		match: /^the account picker pre-selects (.+)$/,
		run: async ({ world, match }) => {
			const selected = world.page.locator(
				'[data-testid="account-switch-option"][data-selected="true"]',
			);
			await expect(selected).toHaveCount(1);
			await expect(selected).toContainText(match[1] ?? "");
		},
	},
	{
		name: "pick an account",
		match: /^I pick (.+) in the account picker$/,
		run: async ({ world, match }) => {
			await pickerRow(world.page, match[1] ?? "").click();
		},
	},
	{
		name: "assert PreviewContinuation RPC",
		match:
			/^the PreviewContinuation RPC previews the current session on (\S+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "PreviewContinuation",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["projectSlug"]).toBe("myapp");
			expect(request.payload["instanceId"]).toBe(match[1]);
		},
	},
	{
		name: "assert the handoff dialog title",
		match: /^the handoff dialog asks (.+)$/,
		run: async ({ world, match }) => {
			const dialog = world.page.getByTestId("handoff-dialog");
			await expect(dialog).toHaveAttribute("data-mode", "confirm");
			await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert the handoff message count",
		match: /^the handoff dialog carries (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("handoff-message-count")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert the swap card",
		match: /^the swap card hands (\S+) at (.+) to (\S+) at (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page.getByTestId("handoff-swap");
			const squash = (text: string | null) => text?.replace(/\s+/g, "");
			// The arrow reads "to" for screen readers.
			await expect
				.poll(async () => squash(await card.textContent()))
				.toBe(squash(`${match[1]}${match[2]}→to${match[3]}${match[4]}`));
			await expect(card.locator("b")).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert an account dot colour",
		match:
			/^the (account picker|handoff dialog|transcript divider|session bar account pill) shows (\S+) with a (violet|teal|blue) dot$/,
		run: async ({ world, match }) => {
			const region = world.page.getByTestId(
				{
					"account picker": "account-switch-picker",
					"handoff dialog": "handoff-dialog",
					"transcript divider": "transcript-divider",
					"session bar account pill": "session-account-pill",
				}[match[1] ?? ""] ?? "",
			);
			await expect(
				region
					.locator(`[data-testid="account-dot"][data-account="${match[2]}"]`)
					.first(),
			).toHaveCSS(
				"background-color",
				{
					violet: "rgb(176, 140, 255)",
					teal: "rgb(47, 211, 192)",
					blue: "rgb(90, 169, 245)",
				}[match[3] ?? ""] ?? "",
			);
		},
	},
	{
		name: "the daemon refuses the switch",
		match: /^the daemon refuses the switch with (.+)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setHandler("ContinueSession", () => {
				throw new WsRpcError({ message: match[1] ?? "" });
			});
		},
	},
	{
		name: "press Switch and continue",
		match: /^I press Switch and continue$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			if (!rpc.getResponseHandler("ContinueSession"))
				rpc.setResponse("ContinueSession", { ok: true });
			await world.page.getByTestId("handoff-confirm").click();
		},
	},
	{
		name: "assert the switching ContinueSession RPC",
		match:
			/^the ContinueSession RPC switches the current session from (\S+) to (\S+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "ContinueSession",
			);
			expect(request.payload["sessionId"]).toBe(currentSessionId(world.page));
			expect(request.payload["expectedInstanceId"]).toBe(match[1]);
			expect(request.payload["instanceId"]).toBe(match[2]);
		},
	},
	{
		name: "assert an error toast",
		match: /^an error toast titled (.+) says (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.getByRole("alert")
				.filter({ hasText: match[1] ?? "" });
			await expect(toast).toBeVisible();
			await expect(toast).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert the handoff dialog is gone",
		match: /^the handoff dialog is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("handoff-dialog")).toHaveCount(0);
		},
	},
	{
		name: "server hands the session to another account",
		match: /^the server switches the session$/,
		run: ({ world }) => {
			const limitRecovery = {
				...limits.get(world.page),
				continued: true,
				switched: true,
			};
			limits.set(world.page, limitRecovery);
			projectLimit(world.page, limitRecovery);
		},
	},
	{
		name: "open What carried over?",
		match: /^I open What carried over\? on the transcript divider$/,
		run: async ({ world }) => {
			await world.page.getByTestId("transcript-divider-handoff").click();
		},
	},
	{
		name: "assert the read-only handoff summary",
		match: /^the handoff dialog is read-only and carries (.+)$/,
		run: async ({ world, match }) => {
			const dialog = world.page.getByTestId("handoff-dialog");
			await expect(dialog).toHaveAttribute("data-mode", "review");
			await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(
				"What carried over?",
			);
			await expect(dialog.getByTestId("handoff-message-count")).toHaveText(
				match[1] ?? "",
			);
			await expect(dialog.getByTestId("handoff-close")).toBeVisible();
			await expect(dialog.getByTestId("handoff-confirm")).toHaveCount(0);
			await expect(dialog.getByTestId("handoff-swap")).toHaveCount(0);
		},
	},
	{
		name: "assert the What carried over? link placement",
		match:
			/^the What carried over\? link sits (inline|on its own line) under the divider$/,
		run: async ({ world, match }) => {
			const divider = world.page.getByTestId("transcript-divider");
			const link = world.page.getByTestId("transcript-divider-handoff");
			await expect(link).toHaveText("What carried over?");
			if (match[1] === "inline") {
				await expect(
					divider.getByTestId("transcript-divider-handoff"),
				).toHaveCount(1);
				return;
			}
			await expect(
				divider.getByTestId("transcript-divider-handoff"),
			).toHaveCount(0);
			const [dividerBox, linkBox] = await Promise.all([
				divider.boundingBox(),
				link.boundingBox(),
			]);
			if (!dividerBox || !linkBox) throw new Error("No divider or link box");
			expect(linkBox.y).toBeGreaterThan(dividerBox.y + dividerBox.height - 4);
			expect(linkBox.x + linkBox.width / 2).toBeCloseTo(
				dividerBox.x + dividerBox.width / 2,
				0,
			);
		},
	},
	{
		name: "bind the project to an instance",
		match: /^the project is bound to (\S+)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setDaemonList("SubscribeProjects", {
				projects: [
					{
						slug: "myapp",
						title: "myapp",
						folders: ["/src/myapp"],
						instanceId: match[1],
					},
				],
			});
		},
	},
	{
		name: "open the session bar account pill",
		match: /^I open the account pill in the session bar$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-account-pill").click();
			await expect(
				world.page.getByTestId("account-switch-picker"),
			).toBeVisible();
		},
	},
	{
		name: "assert the session bar account pill",
		match: /^the session bar account pill reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("session-account-pill")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert the session bar account pill geometry",
		match:
			/^the session bar account pill is (\d+)px tall with (\d+)px monospace text$/,
		run: async ({ world, match }) => {
			const pill = world.page.getByTestId("session-account-pill");
			await expect(pill).toHaveCSS("height", `${match[1]}px`);
			await expect(pill).toHaveCSS("font-size", `${match[2]}px`);
			const { radius, font } = await pill.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					radius: parseFloat(style.borderRadius),
					font: style.fontFamily,
				};
			});
			// Fully rounded: the radius reaches at least half the height.
			expect(radius).toBeGreaterThanOrEqual(Number(match[1]) / 2);
			expect(font).toMatch(/mono/i);
		},
	},
	{
		name: "assert the pill sits after the segment control",
		match:
			/^the session bar account pill sits right after the segment control$/,
		run: async ({ world }) => {
			const [pill, segments] = await Promise.all([
				world.page.getByTestId("session-account-pill").boundingBox(),
				world.page.locator("#session-bar .session-bar-segments").boundingBox(),
			]);
			if (!pill || !segments) throw new Error("No pill or segment box");
			expect(pill.x).toBeGreaterThanOrEqual(segments.x + segments.width);
			expect(pill.x - (segments.x + segments.width)).toBeLessThan(16);
			expect(
				Math.abs(pill.y + pill.height / 2 - (segments.y + segments.height / 2)),
			).toBeLessThan(2);
		},
	},
	{
		name: "assert where the picker opens",
		match: /^the account picker opens (below the pill|as a bottom sheet)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const [picker, pill] = await Promise.all([
				page.getByTestId("account-switch-picker").boundingBox(),
				page.getByTestId("session-account-pill").boundingBox(),
			]);
			if (!picker || !pill) throw new Error("No picker or pill box");
			if (match[1] === "below the pill") {
				expect(picker.y).toBeGreaterThanOrEqual(pill.y + pill.height);
				// Aligned to the pill's end edge.
				expect(
					Math.abs(picker.x + picker.width - (pill.x + pill.width)),
				).toBeLessThan(2);
				return;
			}
			const viewport = page.viewportSize();
			if (!viewport) throw new Error("No viewport");
			expect(Math.abs(picker.y + picker.height - viewport.height)).toBeLessThan(
				2,
			);
			expect(picker.width).toBeGreaterThan(viewport.width - 2);
		},
	},
	{
		name: "assert the session bar shows the badge or the pill",
		match:
			/^the session bar shows (no account pill|no instance badge|the instance badge reading (.+))$/,
		run: async ({ world, match }) => {
			const bar = world.page.getByTestId("session-bar");
			if (match[1] === "no account pill")
				await expect(bar.getByTestId("session-account-pill")).toHaveCount(0);
			else if (match[1] === "no instance badge")
				await expect(bar.getByTestId("instance-badge")).toHaveCount(0);
			else
				await expect(bar.getByTestId("instance-badge")).toHaveText(
					match[2] ?? "",
				);
		},
	},
	{
		name: "rebind the project from the instance badge",
		match: /^I pick (.+) from the instance badge$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("session-bar")
				.getByTestId("instance-badge")
				.click();
			await world.page
				.getByTestId("instance-selector-dropdown")
				.getByRole("menuitemradio", { name: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "assert the project binding RPC",
		match:
			/^the SetProjectInstance RPC (?:was not sent|binds the project to (\S+))$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			if (match[1] === undefined) {
				expect(
					rpc
						.getRequests()
						.filter((request) => request.tag === "SetProjectInstance"),
				).toEqual([]);
				return;
			}
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "SetProjectInstance",
			);
			expect(request.payload["slug"]).toBe("myapp");
			expect(request.payload["instanceId"]).toBe(match[1]);
		},
	},
	{
		name: "assert a toast",
		match: /^a toast titled (.+) says (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.getByRole("status")
				.filter({ hasText: match[1] ?? "" });
			await expect(toast).toBeVisible();
			await expect(toast).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert the toast's actions",
		match: /^the toast offers (.+) at the left and (.+) at the right$/,
		run: async ({ world, match }) => {
			const actions = world.page.getByTestId("toast-action");
			await expect(actions).toHaveText([match[1] ?? "", match[2] ?? ""]);
			await expect(actions.first()).toHaveAttribute("data-kind", "primary");
			const toast = await world.page
				.locator(".toast-card")
				.filter({ has: actions.first() })
				.boundingBox();
			const right = await actions.last().boundingBox();
			if (!toast || !right) throw new Error("No toast or action box");
			expect(toast.x + toast.width - (right.x + right.width)).toBeLessThan(20);
		},
	},
	{
		name: "press a toast action",
		match: /^I press (.+) on the toast$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("toast-action")
				.filter({ hasText: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "assert settings are open on the Instances tab",
		match:
			/^settings are open on the Instances tab at the usage limit settings$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#instances-settings")).toBeVisible();
			await expect(world.page.locator("#usage-limit-settings")).toBeAttached();
		},
	},
];
