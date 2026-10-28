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
const histories = new WeakMap<Page, (typeof HistoryMessageSchema.Type)[]>();
const positions = new WeakMap<
	Page,
	{
		prompt: { x: number; y: number; width: number; height: number };
		head: { x: number; y: number; width: number; height: number };
	}
>();
const opening = (page: Page) => page.getByTestId("turn-opening");
const prefaceRules = (page: Page) =>
	page.getByTestId("turn-preface").locator(".compaction-rule");

export const turnOpeningHandlers: StepHandler[] = [
	{
		name: "seed a sent turn without steps",
		match:
			/^the turn opening prompt was sent (\d+) seconds ago( but the turn is not live)?$/,
		run: async ({ world, match }) => {
			const prompt: typeof HistoryMessageSchema.Type = {
				id: "turn-opening-user",
				role: "user",
				time: { created: PINNED_CLOCK_MS - Number(match[1]) * 1000 },
				parts: [{ id: "turn-opening-prompt", type: "text", text: PROMPT }],
			};
			histories.set(world.page, [prompt]);
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				detailRowsOf(prompt),
			);
			setSessionRowStatus(world.page, SESSION, match[2] ? "idle" : "busy", {
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
		name: "report opening compaction on the session row",
		match:
			/^(the turn opening session starts compacting|a compacting row arrives before the turn is live)$/,
		run: ({ world, match }) => {
			setSessionRowStatus(
				world.page,
				SESSION,
				match[1] === "the turn opening session starts compacting"
					? "busy"
					: "idle",
				{ compacting: "Compacting…" },
			);
		},
	},
	{
		name: "report busy after the compacting row",
		match: /^the turn opening session becomes busy$/,
		run: ({ world }) => {
			setSessionRowStatus(world.page, SESSION, "busy");
		},
	},
	{
		name: "assert live compaction replaces the opening and notice",
		match:
			/^the turn opening shows Compacting context without a status message, card or timer$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("turn-opening-compacting"),
			).toBeVisible();
			await expect(opening(world.page)).toHaveText("Compacting context");
			await expect(
				opening(world.page).locator(".assistant-header"),
			).toHaveCount(0);
			await expect(world.page.locator("#messages .system-notice")).toHaveCount(
				0,
			);
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveCount(0);
		},
	},
	{
		name: "complete a compaction in the turn history",
		match:
			/^the turn opening compaction completes (\d+) seconds after send with (\d+) tokens before and (\d+) tokens after$/,
		run: ({ world, match }) => {
			const history = histories.get(world.page);
			const prompt = history?.[0];
			if (!history || prompt?.time?.created === undefined)
				throw new Error("Turn opening prompt was not seeded");
			const stamp = prompt.time.created + Number(match[1]) * 1000;
			const id = `turn-opening-compaction-${history.length}`;
			history.push({
				id,
				role: "assistant",
				parentID: prompt.id,
				time: { created: stamp },
				parts: [
					{
						id: `${id}-part`,
						type: "compaction",
						text: "Context compacted.",
						preTokens: Number(match[2]),
						postTokens: Number(match[3]),
					},
				],
			});
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				history.flatMap(detailRowsOf),
			);
			setSessionRowStatus(world.page, SESSION, "busy", {
				compacting: undefined,
			});
		},
	},
	{
		name: "assert settled compaction figures at transcript level",
		match: /^the settled turn opening rule shows (.+) → (.+) and (.+) saved$/,
		run: async ({ world, match }) => {
			const rule = prefaceRules(world.page).last();
			await expect(rule).toBeVisible();
			await expect(
				rule.getByText("Compacted context", { exact: true }),
			).toBeVisible();
			await expect(
				rule.getByText(`${match[1]} → ${match[2]}`, { exact: true }),
			).toBeVisible();
			await expect(
				rule.getByText(`${match[3]} saved`, { exact: true }),
			).toBeVisible();
			await expect(world.page.locator("#messages .system-notice")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "record live compaction geometry",
		match:
			/^I record the turn opening prompt and live compaction rule positions$/,
		run: async ({ world }) => {
			const prompt = await world.page
				.locator("#messages .msg-user")
				.boundingBox();
			const head = await world.page
				.getByTestId("turn-opening-compacting")
				.boundingBox();
			if (!prompt || !head)
				throw new Error("Compaction geometry is unavailable");
			positions.set(world.page, { prompt, head });
		},
	},
	{
		name: "assert compaction settles in the same box",
		match: /^the settled turn opening rule occupies the live rule's box$/,
		run: async ({ world }) => {
			const before = positions.get(world.page);
			if (!before) throw new Error("Compaction geometry was not recorded");
			await expect
				.poll(() => prefaceRules(world.page).boundingBox())
				.toEqual(before.head);
		},
	},
	{
		name: "assert preface precedes the opening or work card",
		match:
			/^the settled turn opening rules precede the (Working opening|Working card|Worked card)$/,
		run: async ({ world, match }) => {
			const next =
				match[1] === "Working opening"
					? opening(world.page)
					: world.page.locator("#messages .turn-activity");
			await expect(next).toBeVisible();
			const rule = await prefaceRules(world.page).last().boundingBox();
			const box = await next.boundingBox();
			if (!rule || !box)
				throw new Error("Compaction or work geometry is unavailable");
			expect(box.y).toBeGreaterThanOrEqual(rule.y + rule.height);
		},
	},
	{
		name: "assert opening compactions are absent from the ledger",
		match: /^the turn opening ledger has no compaction seam or rule$/,
		run: async ({ world }) => {
			const ledger = world.page.locator("#messages .turn-activity");
			await ledger.locator(".turn-activity-toggle").click();
			await expect(ledger.locator(".turn-activity-toggle")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
			await expect(ledger.locator(".compaction-rule")).toHaveCount(0);
			await expect(ledger.locator("span[data-step-id].bg-text-secondary")).toHaveCount(0);
		},
	},
	{
		name: "assert multiple opening rules retain completion order",
		match: /^the turn preface lists (\d+) rules saving (.+) then (.+)$/,
		run: async ({ world, match }) => {
			await expect(prefaceRules(world.page)).toHaveCount(Number(match[1]));
			await expect(prefaceRules(world.page)).toContainText([
				`${match[2]} saved`,
				`${match[3]} saved`,
			]);
		},
	},
	{
		name: "supply server turn timing",
		match: /^the turn opening server timing starts (\d+) seconds after send$/,
		run: ({ world, match }) => {
			const history = histories.get(world.page);
			const prompt = history?.[0];
			if (!history || prompt?.time?.created === undefined)
				throw new Error("Turn opening prompt was not seeded");
			history[0] = {
				...prompt,
				turnTiming: {
					startedAt: prompt.time.created + Number(match[1]) * 1000,
					waits: [],
				},
			};
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				history.flatMap(detailRowsOf),
			);
		},
	},
	{
		name: "finish and reload a turn with opening compaction",
		match:
			/^the turn opening finishes (\d+) seconds after send and I reload it$/,
		run: async ({ world, match }) => {
			const history = histories.get(world.page);
			const prompt = history?.[0];
			if (!history || prompt?.time?.created === undefined)
				throw new Error("Turn opening prompt was not seeded");
			const end = prompt.time.created + Number(match[1]) * 1000;
			const finished: (typeof HistoryMessageSchema.Type)[] = history.map(
				(message) => ({
					...message,
					...(message.turnTiming
						? { turnTiming: { ...message.turnTiming, endedAt: end } }
						: {}),
					parts: message.parts?.map((part) =>
						part.type === "tool"
							? {
									...part,
									time: { start: message.time?.created, end: end - 1000 },
									state: {
										...part.state,
										status: "completed",
										output: { _tag: "whole" as const, text: "Read the file." },
									},
								}
							: part,
					),
				}),
			);
			finished.push({
				id: "turn-opening-reply",
				role: "assistant",
				parentID: prompt.id,
				cost: 0.01,
				time: { created: end - 1000, completed: end },
				parts: [
					{
						id: "turn-opening-reply-text",
						type: "text",
						text: "The change looks good.",
						time: { start: end - 1000, end },
					},
				],
			});
			histories.set(world.page, finished);
			const rpc = requireRpcControl(world.page);
			rpc.setDetailRows(SESSION, finished.flatMap(detailRowsOf));
			setSessionRowStatus(world.page, SESSION, "idle");
			const before = rpc.getRequests().length;
			await world.page.reload();
			await rpc.waitForRequest(
				(request) =>
					request.tag === "ViewSession" &&
					request.payload["sessionId"] === SESSION &&
					rpc.getRequests().indexOf(request) >= before,
			);
			await expect(world.page.locator("#messages")).toContainText(
				"The change looks good.",
			);
		},
	},
	{
		name: "assert settled work duration after reload",
		match: /^the reloaded turn opening has a Worked card timed (.+)$/,
		run: async ({ world, match }) => {
			const ledger = world.page.locator("#messages .turn-activity");
			await expect(ledger.locator(".turn-activity-toggle")).toContainText(
				"Worked",
			);
			await expect(ledger.locator(".turn-duration")).toHaveText(match[1] ?? "");
			await expect(opening(world.page)).toHaveCount(0);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveCount(0);
		},
	},
	{
		name: "assert completed mid-turn compaction remains in the ledger",
		match:
			/^the turn opening ledger contains (\d+) compaction$/,
		run: async ({ world, match }) => {
			const ledger = world.page.locator("#messages .turn-activity");
			await ledger.locator(".turn-activity-toggle").click();
			await expect(ledger.locator(".compaction-rule")).toHaveCount(
				Number(match[1]),
			);
			await expect(ledger.locator("span[data-step-id].bg-text-secondary")).toHaveCount(
				Number(match[1]),
			);
			await expect(prefaceRules(world.page)).toHaveCount(0);
		},
	},
	{
		name: "project opening compaction failure and clear its session status",
		match: /^the turn opening compaction fails$/,
		run: ({ world }) => {
			const prompt = histories.get(world.page)?.[0];
			if (!prompt) throw new Error("Turn opening prompt was not seeded");
			const failure: typeof HistoryMessageSchema.Type = {
				id: "turn-opening-compaction-failed",
				role: "assistant",
				time: { created: PINNED_CLOCK_MS - 1000 },
				parts: [
					{
						id: "turn-opening-compaction-error",
						type: "compaction",
						text: "Compaction failed.",
						failed: true,
					},
				],
			};
			requireRpcControl(world.page).setDetailRows(SESSION, [
				...detailRowsOf(prompt),
				...detailRowsOf(failure),
			]);
			setSessionRowStatus(world.page, SESSION, "idle", {
				compacting: undefined,
			});
		},
	},
	{
		name: "assert only the compaction error remains",
		match: /^the opening compaction leaves only its error notice$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("system-error-notice")).toHaveText(
				"Compaction failed.",
			);
			await expect(world.page.locator("#messages .system-notice")).toHaveCount(
				1,
			);
			await expect(opening(world.page)).toHaveCount(0);
			await expect(
				world.page.locator("#messages .compaction-rule"),
			).toHaveCount(0);
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveCount(0);
		},
	},
	{
		name: "stop during opening compaction through the composer",
		match: /^I stop the turn during its opening compaction$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setStubs({
				CancelSession: () => {
					setSessionRowStatus(world.page, SESSION, "idle", {
						compacting: undefined,
					});
					return { ok: true };
				},
			});
			await world.page.locator("#stop").click();
			await rpc.waitForRequest(
				(request) =>
					request.tag === "CancelSession" &&
					request.payload["sessionId"] === SESSION,
			);
			await expect(world.page.locator("#stop")).toBeHidden();
		},
	},
	{
		name: "assert stopping leaves no compaction record",
		match: /^the stopped opening compaction leaves no rule or notice$/,
		run: async ({ world }) => {
			await expect(opening(world.page)).toHaveCount(0);
			await expect(
				world.page.locator("#messages .compaction-rule"),
			).toHaveCount(0);
			await expect(world.page.locator("#messages .system-notice")).toHaveCount(
				0,
			);
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("turn-live-elapsed")).toHaveCount(0);
		},
	},
	{
		name: "watch for even a transient plain compaction notice",
		match: /^I watch for a plain opening compaction notice$/,
		run: async ({ world }) => {
			await world.page.locator("#messages").evaluate((messages) => {
				messages.setAttribute("data-plain-compaction-seen", "false");
				new MutationObserver((records) => {
					if (
						messages.textContent?.includes("Compacting…") ||
						records.some(
							(record) =>
								record.oldValue?.includes("Compacting…") ||
								[...record.addedNodes, ...record.removedNodes].some((node) =>
									node.textContent?.includes("Compacting…"),
								),
						)
					)
						messages.setAttribute("data-plain-compaction-seen", "true");
				}).observe(messages, {
					childList: true,
					subtree: true,
					characterData: true,
					characterDataOldValue: true,
				});
			});
		},
	},
	{
		name: "assert the plain compaction notice never appeared",
		match: /^the plain opening compaction notice never appeared$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#messages")
					.getByText("Compacting…", { exact: true }),
			).toHaveCount(0);
			await expect(world.page.locator("#messages")).toHaveAttribute(
				"data-plain-compaction-seen",
				"false",
			);
		},
	},
	{
		name: "assert mid-turn compaction keeps its status message",
		match: /^the mid-turn compaction is a status message$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#messages .system-notice")).toHaveText(
				"Compacting…",
			);
			await expect(
				world.page.locator("#messages .compaction-rule"),
			).toHaveCount(0);
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
		match:
			/^the first ordinary turn opening step arrives(?: (\d+) seconds after send)?$/,
		run: async ({ world, match }) => {
			const history = histories.get(world.page);
			const prompt = history?.[0];
			if (!history || prompt?.time?.created === undefined)
				throw new Error("Turn opening prompt was not seeded");
			const stamp =
				match[1] === undefined
					? PINNED_CLOCK_MS - 1000
					: prompt.time.created + Number(match[1]) * 1000;
			const step: typeof HistoryMessageSchema.Type = {
				id: "turn-opening-assistant",
				role: "assistant",
				parentID: prompt.id,
				time: { created: stamp },
				parts: [
					{
						id: "turn-opening-read",
						type: "tool",
						tool: "Read",
						callID: "turn-opening-read",
						time: { start: stamp },
						state: {
							status: "running",
							input: { _tag: "whole", value: { filePath: "src/index.ts" } },
						},
					},
				],
			};
			history.push(step);
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				history.flatMap(detailRowsOf),
			);
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
