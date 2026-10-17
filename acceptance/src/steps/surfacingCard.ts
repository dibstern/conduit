import { expect, type Locator, type Page } from "@playwright/test";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type {
	HistoryMessagePartSchema,
	HistoryMessageSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockMessageSurfacing,
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

type History = typeof HistoryMessageSchema.Type;
type Part = typeof HistoryMessagePartSchema.Type;
type FixtureKind =
	| "live"
	| "settled"
	| "short"
	| "hand-back"
	| "older"
	| "empty";
const SESSION = "sess-surfacing";
const START = PINNED_CLOCK_MS - 90_000;
const PENDING = "surfacing-agent/surfacing-pending";
const fixtures = new WeakMap<Page, History[]>();
const levels = {
	Final: "final",
	Key: "key",
	Balanced: "balanced",
	All: "all",
} as const;
const verdicts = [
	{ finding: 1 },
	{ ask: 0.95 },
	{ finding: 0.6 },
	{ decision: 0.9 },
	{ blocked: 0.95 },
	{ routine: 1 },
	null,
	{ risk: 0.95 },
] satisfies Array<Record<string, number> | null>;
const texts = [
	"The routing table has three consumers.",
	"Recapture the phone baseline, or keep the old paint order?",
	"The file includes a second route.",
	"I will preserve the old route for one release.",
	"The missing schema prevents the next check.",
	"Let me read the next file.",
	"This message could not be judged.",
	"Opening one subscription per session could exhaust the socket budget.",
];

function tool(id: string, at: number, name = "Read"): Part {
	return {
		id,
		type: "tool",
		tool: name,
		callID: `call-${id}`,
		time: { start: at, end: at + 3_000 },
		state: {
			status: "completed",
			input: {
				_tag: "whole",
				value:
					name === "AskUserQuestion"
						? {
								questions: [
									{
										header: "Target",
										question: "Which target?",
										options: [
											{ label: "Staging", description: "Use staging." },
										],
									},
								],
							}
						: { filePath: `src/route-${id}.ts` },
			},
			output: {
				_tag: "whole",
				text: name === "AskUserQuestion" ? "Staging" : "Read the file.",
			},
		},
	};
}

function history(kind: FixtureKind): History[] {
	const ordinals =
		kind === "short"
			? [1, 2]
			: kind === "empty"
				? [3, 6, 7]
				: [1, 2, 3, 4, 5, 6, 7, 8];
	const parts: Part[] = [];
	for (const ordinal of ordinals) {
		const at = START + ordinal * 8_000;
		parts.push({
			id: `surfacing-part-${ordinal}`,
			type: "text",
			text: texts[ordinal - 1] ?? "",
			time: { start: at, end: at + 1_000 },
			surfacingOrdinal: ordinal,
			surfacingProbabilities: verdicts[ordinal - 1] ?? null,
			surfacingSetVersion: 1,
			surfacingModel: "jev-test",
		});
		parts.push(tool(`surfacing-tool-${ordinal}`, at + 1_000));
		if (kind === "hand-back" && ordinal === 4) {
			parts.push(tool("surfacing-hand-back", at + 4_000, "AskUserQuestion"));
			parts.push(tool("surfacing-resume", at + 7_000));
		}
	}
	if (kind !== "live")
		parts.push({
			id: "surfacing-final",
			type: "text",
			text: "The final reply remains in the transcript.",
			time: { start: PINNED_CLOCK_MS - 6_000, end: PINNED_CLOCK_MS - 5_000 },
		});
	const messages: History[] = [
		{
			id: "surfacing-user",
			role: "user",
			time: { created: START - 1_000 },
			parts: [
				{
					id: "surfacing-prompt",
					type: "text",
					text: "Review the session routing.",
				},
			],
		},
		{
			id: "surfacing-agent",
			role: "assistant",
			parentID: "surfacing-user",
			time: {
				created: START,
				...(kind !== "live" ? { completed: PINNED_CLOCK_MS - 4_000 } : {}),
			},
			parts,
		},
	];
	if (kind === "older")
		messages.push({
			id: "surfacing-next-user",
			role: "user",
			time: { created: PINNED_CLOCK_MS - 2_000 },
			parts: [
				{
					id: "surfacing-next-prompt",
					type: "text",
					text: "Continue with the next turn.",
				},
			],
		});
	return messages;
}

function panel(page: Page): Locator {
	return page.getByTestId("surfacing-card").last();
}
function card(page: Page): Locator {
	return page.getByTestId("surfacing-msg-card");
}
function pin(page: Page, ordinal: string): Locator {
	return page.getByTestId(`surfacing-pin-${ordinal}`);
}
function control(page: Page, name: string): Locator {
	return panel(page).getByRole("button", { name, exact: true });
}

function publish(page: Page, messages: History[]): void {
	fixtures.set(page, messages);
	requireRpcControl(page).setDetailRows(
		SESSION,
		messages.flatMap(detailRowsOf),
	);
}

async function pick(page: Page, ordinal: string): Promise<void> {
	await pin(page, ordinal).click();
	await expect(card(page)).toHaveAttribute("data-ordinal", ordinal);
}

export const surfacingCardHandlers: StepHandler[] = [
	{
		name: "opt into surfacing before app startup",
		match:
			/^message surfacing is (active|inactive|missing-key|invalid-key) at (Final|Key|Balanced|All)$/,
		run: ({ world, match }) => {
			const level = levels[match[2] as keyof typeof levels];
			mockMessageSurfacing.set(world.page, {
				...DEFAULT_MESSAGE_SURFACING_SETTINGS,
				defaultLevel: level,
				enabled: match[1] !== "inactive",
				active: match[1] === "active",
				key: {
					state:
						match[1] === "active"
							? "valid"
							: match[1] === "invalid-key"
								? "invalid"
								: "none",
				},
			});
		},
	},
	{
		name: "open projected surfacing fixture",
		match:
			/^the surfacing session has an? (live|settled|short|hand-back|older|empty) turn$/,
		run: async ({ world, match }) => {
			const kind = match[1] as FixtureKind;
			publish(world.page, history(kind));
			setSessionRowStatus(
				world.page,
				SESSION,
				kind === "live" ? "busy" : "idle",
				{
					title: "Surfacing acceptance",
					accountId: "claude",
					updatedAt: PINNED_CLOCK_MS,
				},
			);
			await openSessionRoute(world.page, SESSION);
			await expect(world.page.locator("#messages")).toContainText(
				"Review the session routing.",
			);
		},
	},
	{
		name: "assert inactive surfacing has no new UI",
		match: /^the turn has only its existing activity UI$/,
		run: async ({ world }) => {
			await expect(world.page.locator(".turn-activity")).toBeVisible();
			for (const id of [
				"surfacing-card",
				"surfacing-msg-card",
				"surfacing-scrub",
				"surfacing-level",
				"surfacing-pins",
			])
				await expect(world.page.getByTestId(id)).toHaveCount(0);
		},
	},
	{
		name: "assert the Jev card and pin scale",
		match:
			/^the full-width message card sits above pins aligned with their own steps$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(card(page)).toBeVisible();
			const messageBox = await card(page).boundingBox();
			const lane = panel(page).getByTestId("surfacing-pins");
			const laneBox = await lane.boundingBox();
			if (!messageBox || !laneBox)
				throw new Error("Missing card or pin lane bounds");
			expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(
				laneBox.y + 1,
			);
			expect(Math.abs(messageBox.width - laneBox.width)).toBeLessThanOrEqual(2);
			const scrub = panel(page).getByTestId("surfacing-scrub");
			await expect(scrub).toHaveAttribute("role", "slider");
			await expect(scrub).toHaveCSS("touch-action", "pan-y");
			for (const ordinal of ["1", "2", "4", "5", "8"]) {
				const button = pin(page, ordinal);
				await expect(button).toHaveAccessibleName(
					new RegExp(`#${ordinal} .+, \\d+:\\d+`),
				);
				const partId = await button.getAttribute("data-surface-part");
				if (!partId) throw new Error("Pin is missing its part reference");
				const step = panel(page).locator(`[data-step-id="${partId}"]`);
				const stepBox = await step.boundingBox();
				if (!stepBox) throw new Error(`Missing strip step for #${ordinal}`);
				const pinBox = await button.boundingBox();
				if (!pinBox) throw new Error(`Missing pin bounds for #${ordinal}`);
				expect(
					Math.abs(pinBox.x + pinBox.width / 2 - stepBox.x - stepBox.width / 2),
				).toBeLessThanOrEqual(1.5);
			}
		},
	},
	{
		name: "pick a surfacing pin",
		match: /^I pick surfaced message #(\d+)$/,
		run: async ({ world, match }) => {
			await pick(world.page, match[1] ?? "");
		},
	},
	{
		name: "tap within the four pixel threshold",
		match: /^I tap surfaced message #(\d+) moving (\d+) pixels$/,
		run: async ({ world, match }) => {
			const box = await pin(world.page, match[1] ?? "").boundingBox();
			if (!box) throw new Error("Missing pin bounds");
			const x = box.x + box.width / 2,
				y = box.y + box.height / 2;
			await world.page.mouse.move(x, y);
			await world.page.mouse.down();
			await world.page.mouse.move(x + Number(match[2]), y);
			await world.page.mouse.up();
		},
	},
	{
		name: "scrub either the pin lane or strip",
		match: /^I scrub the (pins|strip) from message #(\d+) to #(\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const scrub = panel(page).getByTestId("surfacing-scrub");
			const bounds = await scrub.boundingBox();
			const region =
				match[1] === "pins"
					? panel(page).getByTestId("surfacing-pins")
					: panel(page).locator("[data-step-id]").first();
			const regionBox = await region.boundingBox();
			if (!bounds || !regionBox) throw new Error("Missing scrub region bounds");
			const xOf = async (n: string) =>
				bounds.x +
				(bounds.width * Number(await pin(page, n).getAttribute("data-x"))) /
					100;
			const y = regionBox.y + regionBox.height / 2;
			await page.mouse.move(await xOf(match[2] ?? ""), y);
			await page.mouse.down();
			await page.mouse.move(await xOf(match[3] ?? ""), y, { steps: 8 });
			await expect(card(page)).toHaveAttribute("data-ordinal", match[3] ?? "");
			await page.mouse.up();
			await expect(card(page)).toHaveAttribute("data-ordinal", match[3] ?? "");
		},
	},
	{
		name: "assert card target and slider announcement",
		match:
			/^the surfaced card shows #(\d+) and announces its category and position$/,
		run: async ({ world, match }) => {
			await expect(card(world.page)).toHaveAttribute(
				"data-ordinal",
				match[1] ?? "",
			);
			await expect(
				panel(world.page).getByTestId("surfacing-scrub"),
			).toHaveAttribute(
				"aria-valuetext",
				new RegExp(`#${match[1]} .+, \\d+:\\d+, \\d+ of \\d+`),
			);
		},
	},
	{
		name: "change surfacing level",
		match: /^I set the surfacing level to (Final|Key|Balanced|All)$/,
		run: async ({ world, match }) => {
			await panel(world.page)
				.getByTestId("surfacing-level")
				.getByRole("radio", { name: new RegExp(`^${match[1]}(?:\\b|$)`) })
				.click();
		},
	},
	{
		name: "assert level pin counts and stable ordinal gaps",
		match:
			/^the surfacing pins are (\d+(?:,\d+)*) and level counts are Key (\d+), Balanced (\d+), All (\d+)$/,
		run: async ({ world, match }) => {
			await expect(
				panel(world.page).locator('[data-testid^="surfacing-pin-"]'),
			).toHaveCount((match[1] ?? "").split(",").length);
			const shown = await panel(world.page)
				.locator('[data-testid^="surfacing-pin-"]')
				.evaluateAll((elements) =>
					elements
						.map((element) =>
							element
								.getAttribute("data-testid")
								?.replace("surfacing-pin-", ""),
						)
						.sort((a, b) => Number(a) - Number(b)),
				);
			expect(shown.join(",")).toBe(match[1]);
			for (const [label, count] of [
				["Key", match[2]],
				["Balanced", match[3]],
				["All", match[4]],
			])
				await expect(
					panel(world.page)
						.getByTestId("surfacing-level")
						.getByRole("radio", { name: new RegExp(`^${label}\\b`) }),
				).toContainText(count ?? "");
		},
	},
	{
		name: "assert override marker and browser persistence",
		match:
			/^the session surfacing override is (Final|Key|Balanced|All|absent)$/,
		run: async ({ world, match }) => {
			const expected =
				match[1] === "absent"
					? undefined
					: levels[match[1] as keyof typeof levels];
			await expect
				.poll(async () =>
					world.page.evaluate(
						(id) =>
							JSON.parse(
								localStorage.getItem("surfacing-level-by-session") ?? "{}",
							)[id],
						SESSION,
					),
				)
				.toBe(expected);
			await expect(
				panel(world.page).getByTestId("surfacing-level-default-dot"),
			).toHaveCount(expected ? 1 : 0);
		},
	},
	{
		name: "open a different session without inheriting the local override",
		match: /^I open another surfacing session using the daemon default$/,
		run: async ({ world }) => {
			const sessionId = "sess-surfacing-other";
			requireRpcControl(world.page).setDetailRows(
				sessionId,
				history("settled").flatMap(detailRowsOf),
			);
			setSessionRowStatus(world.page, sessionId, "idle", {
				title: "Another surfacing session",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, sessionId);
			await expect(panel(world.page)).toBeVisible();
		},
	},
	{
		name: "reload surfacing session",
		match: /^I reload the surfacing session$/,
		run: async ({ world }) => {
			if (new URL(world.page.url()).pathname !== `/s/${SESSION}`)
				await openSessionRoute(world.page, SESSION);
			const rpc = requireRpcControl(world.page);
			const before = rpc.getRequests().length;
			await world.page.reload();
			await rpc.waitForRequest(
				(request) =>
					request.tag === "ViewSession" &&
					request.payload["sessionId"] === SESSION &&
					rpc.getRequests().indexOf(request) >= before,
			);
			await expect(panel(world.page)).toBeVisible();
		},
	},
	{
		name: "use surfacing level options",
		match: /^I choose surfacing (Make default|Back to default)$/,
		run: async ({ world, match }) => {
			await control(world.page, "Level options").click();
			await world.page
				.getByRole("menuitem", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "assert surfacing default patch",
		match:
			/^the daemon default becomes (Final|Key|Balanced|All) without changing other settings$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter((request) => request.tag === "UpdateMessageSurfacing")
							.at(-1)?.payload,
				)
				.toEqual({
					_tag: "UpdateMessageSurfacing",
					defaultLevel: levels[match[1] as keyof typeof levels],
				});
		},
	},
	{
		name: "assert effective surfacing level",
		match: /^the effective surfacing level is (Final|Key|Balanced|All)$/,
		run: async ({ world, match }) => {
			await expect(
				panel(world.page)
					.getByTestId("surfacing-level")
					.getByRole("radio", { name: new RegExp(`^${match[1]}\\b`) }),
			).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "publish a folded pending part",
		match: /^a new folded surfacing message awaits its verdict$/,
		run: ({ world }) => {
			const messages = fixtures.get(world.page) ?? [];
			publish(
				world.page,
				messages.map((message) =>
					message.id === "surfacing-agent"
						? {
								...message,
								parts: [
									...(message.parts ?? []),
									{
										id: "surfacing-pending",
										type: "text",
										text: "I am inspecting the final dependency.",
										time: {
											start: PINNED_CLOCK_MS - 12_000,
											end: PINNED_CLOCK_MS - 11_000,
										},
									},
									tool("surfacing-pending-tool", PINNED_CLOCK_MS - 11_000),
								],
							}
						: message,
				),
			);
		},
	},
	{
		name: "assert pending pin has no ordinal",
		match: /^the card follows the pending message without inventing a number$/,
		run: async ({ world }) => {
			await expect(card(world.page)).toHaveAttribute("data-part", PENDING);
			await expect(card(world.page)).not.toHaveAttribute("data-ordinal", /\d/);
			await expect(
				panel(world.page).getByTestId(`surfacing-pin-pending-${PENDING}`),
			).toContainText("…");
		},
	},
	{
		name: "publish a routine verdict for the pending part",
		match: /^the pending surfacing verdict is routine$/,
		run: ({ world }) => {
			publish(
				world.page,
				(fixtures.get(world.page) ?? []).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						part.id === "surfacing-pending"
							? {
									...part,
									surfacingOrdinal: 9,
									surfacingProbabilities: { routine: 1 },
									surfacingSetVersion: 1,
									surfacingModel: "jev-test",
								}
							: part,
					),
				})),
			);
		},
	},
	{
		name: "follow latest surfacing output",
		match: /^I follow the latest surfaced message$/,
		run: async ({ world }) => {
			await control(world.page, "Follow latest").first().click();
		},
	},
	{
		name: "assert picked live card exposes now",
		match: /^the surfaced card offers Follow latest$/,
		run: async ({ world }) => {
			await expect(control(world.page, "Follow latest").first()).toBeVisible();
		},
	},
	{
		name: "settle an unjudged part",
		match: /^the surfacing turn settles without the pending verdict$/,
		run: async ({ world }) => {
			publish(
				world.page,
				(fixtures.get(world.page) ?? []).map((message) =>
					message.id === "surfacing-agent"
						? {
								...message,
								time: { created: START, completed: PINNED_CLOCK_MS - 4_000 },
								parts: [
									...(message.parts ?? []),
									{
										id: "surfacing-final",
										type: "text",
										text: "The final reply remains in the transcript.",
									},
								],
							}
						: message,
				),
			);
			setSessionRowStatus(world.page, SESSION, "idle");
			await expect(
				panel(world.page).getByTestId(`surfacing-pin-pending-${PENDING}`),
			).toHaveCount(0);
			await expect(card(world.page)).not.toHaveAttribute("data-part", PENDING);
		},
	},
	{
		name: "assert open Ask in the head",
		match: /^the open Ask head chip (shows #\d+|is absent)$/,
		run: async ({ world, match }) => {
			const ask = world.page.getByTestId("surfacing-ask-chip");
			if (match[1] === "is absent") await expect(ask).toHaveCount(0);
			else {
				await expect(ask).toBeVisible();
				await expect(ask).toContainText(match[1]?.replace("shows ", "") ?? "");
			}
		},
	},
	{
		name: "send a later user message",
		match: /^a later user message answers the open Ask$/,
		run: async ({ world }) => {
			publish(world.page, [
				...(fixtures.get(world.page) ?? []),
				{
					id: "surfacing-answer",
					role: "user",
					time: { created: PINNED_CLOCK_MS - 1_000 },
					parts: [
						{
							id: "surfacing-answer-text",
							type: "text",
							text: "Keep the existing paint order.",
						},
					],
				},
			]);
			setSessionRowStatus(world.page, SESSION, "idle");
		},
	},
	{
		name: "fold or close surfaced message",
		match: /^I (fold|close) the surfaced message$/,
		run: async ({ world, match }) => {
			await control(
				world.page,
				match[1] === "fold" ? "Fold message" : "Close message",
			).click();
		},
	},
	{
		name: "assert folding keeps pins and strip",
		match: /^the surfaced card is hidden but pins and the strip remain$/,
		run: async ({ world }) => {
			await expect(card(world.page)).toHaveCount(0);
			await expect(
				panel(world.page).getByTestId("surfacing-pins"),
			).toBeVisible();
			await expect(
				panel(world.page).locator("[data-step-id]").first(),
			).toBeVisible();
		},
	},
	{
		name: "assert Final keeps the strip",
		match: /^Final shows (\d+) hidden messages and keeps the strip$/,
		run: async ({ world, match }) => {
			await expect(card(world.page)).toHaveCount(0);
			await expect(
				panel(world.page).locator('[data-testid^="surfacing-pin-"]'),
			).toHaveCount(0);
			await expect(panel(world.page)).toContainText(
				`Final only · ${match[1]} hidden`,
			);
			await expect(
				panel(world.page).locator("[data-step-id]").first(),
			).toBeVisible();
		},
	},
	{
		name: "assert not judged note and empty level",
		match: /^the turn shows (\d+) not judged and Nothing at (Key|Balanced)$/,
		run: async ({ world, match }) => {
			await expect(
				panel(world.page).getByTestId("surfacing-not-judged"),
			).toContainText(`${match[1]} not judged`);
			await expect(panel(world.page)).toContainText(`Nothing at ${match[2]}`);
			await expect(control(world.page, "Show All")).toBeVisible();
		},
	},
	{
		name: "show all from empty level",
		match: /^I show all surfaced messages from the empty state$/,
		run: async ({ world }) => {
			await control(world.page, "Show All").click();
		},
	},
	{
		name: "assert hand-back uses local parts and turn ordinals",
		match:
			/^the two hand-back blocks keep turn-wide numbers on their own strips$/,
		run: async ({ world }) => {
			const panels = world.page.getByTestId("surfacing-card");
			await expect(panels).toHaveCount(2);
			for (const [index, expected] of [
				[0, ["1", "2", "4"]],
				[1, ["5", "8"]],
			] as const) {
				const block = panels.nth(index);
				const actual = await block
					.locator('[data-testid^="surfacing-pin-"]')
					.evaluateAll((elements) =>
						elements.map((element) =>
							element
								.getAttribute("data-testid")
								?.replace("surfacing-pin-", ""),
						),
					);
				expect(actual).toEqual(expected);
				for (const ordinal of expected)
					await expect(
						block.locator(
							`[data-step-id="surfacing-agent/surfacing-part-${ordinal}"]`,
						),
					).toBeVisible();
			}
			await expect(
				panels.first().getByTestId("surfacing-msg-card"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert old turns start folded",
		match: /^the older turn starts folded with its pins available$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("surfacing-msg-card")).toHaveCount(0);
			await expect(pin(world.page, "2")).toBeVisible();
		},
	},
	{
		name: "click and hover a work segment without changing the selected pin",
		match:
			/^an ordinary strip segment still captions the head and opens its log row$/,
		run: async ({ world }) => {
			const page = world.page;
			await pick(page, "2");
			const work = panel(page).locator(
				'[data-step-id="surfacing-agent/surfacing-tool-4"]',
			);
			const box = await work.boundingBox();
			if (!box) throw new Error("Missing ordinary work step");
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await expect(page.getByRole("tooltip")).toContainText(
				"route-surfacing-tool-4.ts",
			);
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			await expect(
				page.locator(
					'.step-log [data-part="surfacing-agent/surfacing-tool-4"]',
				),
			).toBeVisible();
			await expect(card(page)).toHaveAttribute("data-ordinal", "2");
		},
	},
	{
		name: "exercise surfacing keyboard navigation",
		match:
			/^surfacing keyboard navigation selects messages and consumes focused-turn shortcuts$/,
		run: async ({ world }) => {
			const page = world.page;
			await pick(page, "4");
			await card(page).focus();
			for (const [key, ordinal] of [
				["ArrowLeft", "2"],
				["ArrowRight", "4"],
				["Home", "1"],
				["End", "8"],
				["a", "2"],
			]) {
				await page.keyboard.press(key ?? "");
				await expect(card(page)).toHaveAttribute("data-ordinal", ordinal ?? "");
			}
			await page.keyboard.press("3");
			await page.keyboard.press("Enter");
			await expect(card(page)).toHaveAttribute("data-ordinal", "3");
			await expect(
				panel(page)
					.getByTestId("surfacing-level")
					.getByRole("radio", { name: /^All\b/ }),
			).toHaveAttribute("aria-checked", "true");
			for (const key of ["s", "u", "r", "m", "h", "a", "+", "−"]) {
				await expect(card(page)).toBeVisible();
				const prevented = await card(page).evaluate(
					(element, pressed) =>
						!element.dispatchEvent(
							new KeyboardEvent("keydown", {
								key: pressed,
								bubbles: true,
								cancelable: true,
							}),
						),
					key,
				);
				expect(prevented, `Focused turn must consume ${key}`).toBe(true);
			}
			await page.keyboard.press("Escape");
			await expect(card(page)).toHaveCount(0);
		},
	},
];
