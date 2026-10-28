import { expect, type Page } from "@playwright/test";
import type {
	HistoryMessagePartSchema,
	HistoryMessageSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

type History = typeof HistoryMessageSchema.Type;
type Part = typeof HistoryMessagePartSchema.Type;
const SESSION = "sess-turn-log";
const START = PINNED_CLOCK_MS - 60_000;
const EARLIER = "I recommend staging before the next step.";
const REPLY = "The final reply stays below the turn log.";
const questions = [
	{
		header: "Target",
		question: "Which target?",
		options: [{ label: "Staging", description: "Use staging." }],
		multiSelect: false,
		custom: true,
	},
];
const panel = (page: Page) => page.locator("#messages .turn-activity");
const kinds = new WeakMap<Page, string>();

function text(id: string, value: string, offset: number, judged = false): Part {
	return {
		id,
		type: "text",
		text: value,
		time: { start: START + offset, end: START + offset + 1000 },
		...(judged
			? {
					surfacingOrdinal: 1,
					surfacingProbabilities: { decision: 1 },
					surfacingSetVersion: 1,
					surfacingModel: "jev-test",
				}
			: {}),
	};
}

function tool(id: string, name: string, offset: number, waiting = false): Part {
	return {
		id,
		type: "tool",
		tool: name,
		callID: id,
		time: {
			start: START + offset,
			...(waiting ? {} : { end: START + offset + 1000 }),
		},
		state: {
			status: waiting ? "running" : "completed",
			input: {
				_tag: "whole",
				value:
					name === "Read"
						? { filePath: `src/${id}.ts` }
						: name === "AskUserQuestion"
							? { questions }
							: { plan: "Deploy to staging." },
			},
			...(waiting
				? {}
				: {
						output: {
							_tag: "whole" as const,
							text:
								name === "ExitPlanMode"
									? "Approved"
									: name === "AskUserQuestion"
										? "Staging"
										: "Read the file.",
						},
					}),
		},
	};
}

export const turnActivityHandlers: StepHandler[] = [
	{
		name: "assert Full log notes use its active stop",
		match: /^the Full log has no Answer-only note$/,
		run: async ({ world }) => {
			await expect(panel(world.page).locator(".axis-notes")).not.toContainText(
				"Answer only",
			);
		},
	},
	{
		name: "assert turn message stop counts",
		match:
			/^the message stop counts are Key (\d+), Most (\d+), All messages (\d+)$/,
		run: async ({ world, match }) => {
			for (const [index, label] of ["Key", "Most", "All messages"].entries())
				await expect(
					world.page
						.getByTestId("surfacing-level")
						.getByRole("radio", { name: new RegExp(`^${label}\\b`) }),
				).toContainText(match[index + 1] ?? "");
		},
	},
	{
		name: "assert turn step counts",
		match: /^the (activity strip|Full log) announces (\d+) steps$/,
		run: async ({ world, match }) => {
			const region =
				match[1] === "activity strip"
					? panel(world.page).locator('[aria-label^="Activity timeline"]')
					: panel(world.page).locator(".step-log");
			await expect(region).toHaveAttribute(
				"aria-label",
				new RegExp(`\\b${match[2]} steps$`),
			);
		},
	},
	{
		name: "assert compaction stays a rule in chronological order",
		match: /^the combined log keeps its compaction rule between the messages$/,
		run: async ({ world }) => {
			const log = panel(world.page).locator(".step-log");
			await expect(log.locator(".compaction-rule")).toHaveCount(1);
			expect(
				await log
					.locator("[data-log-part]")
					.evaluateAll((rows) =>
						rows.map((row) =>
							row.getAttribute("data-log-part")?.split("/").at(-1),
						),
					),
			).toEqual([
				"first-read",
				"earlier",
				"compacted",
				"later-message",
				"later-read",
				"last-read",
			]);
		},
	},
	{
		name: "open Full log message row",
		match: /^I open message #(\d+) from the Full log row$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`surfacing-step-open-${match[1]}`).click();
		},
	},
	{
		name: "assert Full log pins",
		match: /^the Full log pins are (\d+(?:,\d+)*)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(async () =>
					world.page
						.locator("[data-group-members]")
						.evaluateAll((groups) =>
							groups.flatMap((group) =>
								(group.getAttribute("data-group-members") ?? "").split(","),
							),
						),
				)
				.toEqual((match[1] ?? "").split(","));
		},
	},
	{
		name: "assert Full log card level",
		match: /^the card has no below-stop note$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-msg-card").locator(".card-note"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert category preview stop name",
		match: /^the category preview says Most shows$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-category-preview"),
			).toContainText("Most shows");
		},
	},
	{
		name: "assert message stop labels",
		match:
			/^the (message|default message) stops read Answer, Key, Most and All messages$/,
		run: async ({ world, match }) => {
			const control =
				match[1] === "message"
					? world.page.getByTestId("surfacing-level")
					: world.page.getByRole("radiogroup", {
							name: "Default level",
							exact: true,
						});
			for (const label of ["Answer", "Key", "Most", "All messages"])
				await expect(
					control.getByRole("radio", { name: new RegExp(`^${label}\\b`) }),
				).toBeVisible();
		},
	},
	{
		name: "assert mark prompt stop names",
		match: /^the turn mark prompt contains (.+) and (.+)$/,
		run: async ({ world, match }) => {
			const prompt = world.page.getByTestId("surfacing-mark-prompt");
			await expect(prompt).toContainText(match[1] ?? "");
			await expect(prompt).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert card and summary stop notes",
		match: /^the (turn card|summary) (?:stop )?note says (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(
					match[1] === "turn card"
						? "surfacing-msg-card"
						: "surfacing-recap-reader",
				),
			).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert feedback stop names",
		match: /^the feedback ledger names Most and Full log$/,
		run: async ({ world }) => {
			const records = world.page.getByTestId("surfacing-ledger-record");
			await expect(
				records.filter({ hasText: "you: ▲ Most" }).first(),
			).toBeVisible();
			await expect(
				records.filter({ hasText: "you: ▼ Full log" }).first(),
			).toBeVisible();
		},
	},
	{
		name: "seed multi-segment turn log",
		match:
			/^the turn log session has a (two-segment AskUserQuestion|two-segment ExitPlanMode|wake|counted-wake|wake-reply|wake-empty|waiting|async) turn$/,
		run: async ({ world, match }) => {
			const kind = match[1] ?? "";
			kinds.set(world.page, kind);
			const wake = kind.startsWith("wake") || kind === "counted-wake";
			const counted = kind === "counted-wake";
			const waiting = kind === "waiting" || kind === "async";
			const asyncQuestion = kind === "async";
			const handBack = kind.endsWith("ExitPlanMode")
				? "ExitPlanMode"
				: "AskUserQuestion";
			const before =
				kind === "wake-empty"
					? []
					: [
							tool("first-read", "Read", 1000),
							{
								...text("earlier", EARLIER, 4000, true),
								...(counted ? { surfacingProbabilities: { ask: 1 } } : {}),
							},
						];
			const after = [
				...(counted
					? [
							{
								id: "compacted",
								type: "compaction",
								text: "Context compacted.",
								time: { start: START + 29_500 },
							},
							{
								...text(
									"later-message",
									"The wake Run found the second route.",
									30_000,
									true,
								),
								surfacingOrdinal: 2,
								surfacingProbabilities: { finding: 0.6 },
							},
						]
					: []),
				...(kind === "wake-reply" || kind === "wake-empty"
					? []
					: [tool("later-read", "Read", 30_000)]),
				...(counted ? [tool("last-read", "Read", 33_000)] : []),
				text("reply", REPLY, 35_000),
			];
			const messages: History[] = [
				{
					id: "turn-log-user",
					role: "user",
					time: { created: START },
					parts: [
						{ id: "prompt", type: "text", text: "Deploy the reviewed change." },
					],
				},
				{
					id: "turn-log-agent",
					role: "assistant",
					parentID: "turn-log-user",
					...(wake ? { cost: 0.01 } : {}),
					time: {
						created: START + 1000,
						...(wake
							? { completed: START + 8000 }
							: waiting
								? {}
								: { completed: START + 40_000 }),
					},
					parts: wake
						? before
						: [
								...before,
								tool("answered", handBack, 8000),
								...(asyncQuestion
									? [
											{
												...tool("waiting", "AskUserQuestion", 25_000),
												state: {
													status: "completed",
													input: {
														_tag: "whole" as const,
														value: { questions, delivery: "async" },
													},
													output: { _tag: "whole" as const, text: "null" },
												},
											},
										]
									: []),
								...after,
								...(waiting && !asyncQuestion
									? [tool("waiting", "AskUserQuestion", 40_000, true)]
									: []),
							],
				},
				...(wake
					? [
							{
								id: "turn-log-wake",
								role: "assistant" as const,
								parentID: "turn-log-user",
								cost: 0.01,
								time: { created: START + 30_000, completed: START + 40_000 },
								parts: after,
							},
						]
					: []),
			];
			const rpc = requireRpcControl(world.page);
			rpc.setDetailRows(SESSION, messages.flatMap(detailRowsOf));
			rpc.setStubs({
				AnswerQuestion: () => {
					rpc.sendChunk("SubscribeApprovals", [
						{ _tag: "remove", id: "waiting-question", sequence: 2 },
					]);
					rpc.setDetailRows(
						SESSION,
						messages
							.map((message) => ({
								...message,
								parts: message.parts?.map((part) =>
									part.id === "waiting"
										? tool("waiting", "AskUserQuestion", 40_000)
										: part,
								),
							}))
							.flatMap(detailRowsOf),
					);
					return { ok: true };
				},
			});
			setSessionRowStatus(world.page, SESSION, waiting ? "busy" : "idle", {
				title: "Turn log acceptance",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
				...(wake
					? {
							resumes: [
								{ at: START + 29_000, instanceId: "claude", reason: "user" },
							],
						}
					: {}),
			});
			await openSessionRoute(world.page, SESSION);
			await expect.poll(() => rpc.hasStream("SubscribeApprovals")).toBe(true);
			if (waiting)
				rpc.sendChunk("SubscribeApprovals", [
					{
						_tag: "upsert",
						sequence: 1,
						item: {
							_tag: "question",
							sessionId: SESSION,
							toolId: "waiting-question",
							toolUseId: "waiting",
							providerId: "claude",
							...(asyncQuestion ? { delivery: "async" } : {}),
							questions,
						},
					},
				]);
			await expect(world.page.locator("#messages")).toContainText(
				"Deploy the reviewed change.",
			);
		},
	},
	{
		name: "assert one turn component",
		match: /^the turn has one activity head, strip and log$/,
		run: async ({ world }) => {
			await expect(panel(world.page)).toHaveCount(1);
			await expect(
				panel(world.page).locator(".turn-activity-toggle"),
			).toHaveCount(1);
			await expect(
				panel(world.page).locator('[aria-label^="Activity timeline"]'),
			).toHaveCount(1);
			await panel(world.page).locator(".turn-activity-toggle").click();
			await expect(panel(world.page).locator(".step-log")).toHaveCount(1);
			await panel(world.page).locator(".turn-activity-toggle").click();
		},
	},
	{
		name: "assert final reply placement",
		match: /^only the final turn reply is outside the activity$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#messages .msg-assistant")).toHaveCount(
				1,
			);
			await expect(
				world.page.locator("#messages .msg-assistant"),
			).toContainText(REPLY);
		},
	},
	{
		name: "open combined turn log",
		match: /^I open the combined turn log$/,
		run: async ({ world }) => {
			await panel(world.page).locator(".turn-activity-toggle").click();
		},
	},
	{
		name: "assert hand-back log order",
		match:
			/^the combined log orders the earlier message, hand-back and later work$/,
		run: async ({ world }) => {
			const log = panel(world.page).locator(".step-log");
			await expect(log.locator("[data-log-part]")).toHaveCount(4);
			expect(
				await log
					.locator("[data-log-part]")
					.evaluateAll((rows) =>
						rows.map((row) =>
							row.getAttribute("data-log-part")?.split("/").at(-1),
						),
					),
			).toEqual(["first-read", "earlier", "answered", "later-read"]);
			await expect(log).toContainText(EARLIER);
			await expect(log.getByTestId("turn-hand-back-row")).toContainText(
				kinds.get(world.page)?.endsWith("ExitPlanMode")
					? "Approved"
					: "Which target? → Staging",
			);
			await expect(log.locator(".question-tool-header")).toHaveCount(0);
		},
	},
	{
		name: "assert earlier reply pin and verdict",
		match: /^the earlier hand-back message has its judged pin$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-pin-1").click();
			await expect(world.page.getByTestId("surfacing-msg-card")).toContainText(
				EARLIER,
			);
			await expect(world.page.getByTestId("surfacing-msg-card")).toContainText(
				"Decision",
			);
		},
	},
	{
		name: "expand answered hand-back",
		match: /^I expand the answered hand-back row$/,
		run: async ({ world }) => {
			await world.page.getByTestId("turn-hand-back-row").click();
		},
	},
	{
		name: "assert original hand-back details",
		match: /^the answered hand-back shows its original tool details$/,
		run: async ({ world }) => {
			await expect(
				panel(world.page).locator('.step-log [data-tool-id="answered"]'),
			).toBeVisible();
			await expect(panel(world.page).locator(".step-log")).toContainText(
				kinds.get(world.page)?.endsWith("ExitPlanMode")
					? "Deploy to staging."
					: "Use staging.",
			);
		},
	},
	{
		name: "assert wake divider position",
		match: /^the wake divider sits between the earlier reply and resumed work$/,
		run: async ({ world }) => {
			const log = panel(world.page).locator(".step-log");
			await expect(log.getByTestId("transcript-divider")).toContainText(
				"Resumed on",
			);
			expect(
				await log
					.locator("[data-log-part], [data-testid=transcript-divider]")
					.evaluateAll((rows) =>
						rows.map(
							(row) =>
								row.getAttribute("data-log-part")?.split("/").at(-1) ??
								"resumed",
						),
					),
			).toEqual(
				kinds.get(world.page) === "wake-empty"
					? ["resumed"]
					: kinds.get(world.page) === "wake-reply"
						? ["first-read", "earlier", "resumed"]
						: ["first-read", "earlier", "resumed", "later-read"],
			);
		},
	},
	{
		name: "assert waiting question placement",
		match: /^the open hand-back is below the reply$/,
		run: async ({ world }) => {
			const form = world.page.locator(".question-card");
			await expect(form).toBeVisible();
			await expect(panel(world.page).locator(".question-card")).toHaveCount(0);
			const reply = await world.page
				.locator("#messages .msg-assistant")
				.boundingBox();
			const question = await form.boundingBox();
			if (!reply || !question)
				throw new Error("Reply or question has no bounds");
			expect(question.y).toBeGreaterThanOrEqual(reply.y + reply.height);
		},
	},
	{
		name: "answer waiting turn question",
		match: /^I answer the waiting turn question$/,
		run: async ({ world }) => {
			await world.page
				.locator(".question-card")
				.getByText("Staging", { exact: true })
				.click();
			await world.page.locator(".question-submit-btn").click();
		},
	},
	{
		name: "assert answered waiting question joins the log",
		match: /^the waiting hand-back becomes a compact log row$/,
		run: async ({ world }) => {
			await expect(
				panel(world.page).getByTestId("turn-hand-back-row"),
			).toHaveCount(2);
			await expect(
				panel(world.page).getByTestId("turn-hand-back-row").last(),
			).toContainText("Which target? → Staging");
			await expect(world.page.locator(".question-card")).toHaveCount(0);
		},
	},
	{
		name: "assert waiting turn answer RPC",
		match: /^the waiting turn answer reaches the relay$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "AnswerQuestion",
			);
			expect(request.payload["toolId"]).toBe("waiting-question");
			expect(request.payload["answers"]).toEqual({ "0": "Staging" });
		},
	},
];
