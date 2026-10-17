import { expect, type Locator, type Page } from "@playwright/test";
import type { SurfacingMark } from "../../../src/lib/contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import {
	type HistoryMessagePartSchema,
	type HistoryMessageSchema,
	WsRpcError,
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
	| "dense"
	| "empty";
const SESSION = "sess-surfacing";
const START = PINNED_CLOCK_MS - 90_000;
const PENDING = "surfacing-agent/surfacing-pending";
const fixtures = new WeakMap<Page, History[]>();
const readFixtures = new WeakMap<Page, ReadonlySet<number>>();
const failingReadWrites = new WeakSet<Page>();
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
		kind === "dense"
			? Array.from({ length: 56 }, (_, index) => index + 1)
			: kind === "short"
				? [1, 2]
				: kind === "empty"
					? [3, 6, 7]
					: [1, 2, 3, 4, 5, 6, 7, 8];
	const parts: Part[] = [];
	for (const ordinal of ordinals) {
		const at = START + ordinal * (kind === "dense" ? 1_300 : 8_000);
		const category =
			ordinal === 24
				? "ask"
				: ordinal === 8 || ordinal === 40
					? "blocked"
					: "finding";
		parts.push({
			id: `surfacing-part-${ordinal}`,
			type: "text",
			text:
				kind === "dense"
					? `Dense message #${ordinal}.`
					: (texts[ordinal - 1] ?? ""),
			time: { start: at, end: at + 1_000 },
			surfacingOrdinal: ordinal,
			surfacingProbabilities:
				kind === "dense" ? { [category]: 1 } : (verdicts[ordinal - 1] ?? null),
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

export { history as surfacingHistory };

function panel(page: Page): Locator {
	return page.getByTestId("surfacing-card").last();
}
function card(page: Page): Locator {
	return page.getByTestId("surfacing-msg-card");
}
function pin(page: Page, ordinal: string): Locator {
	return page.getByTestId(`surfacing-pin-${ordinal}`);
}
async function pinNumbers(scope: Locator): Promise<string[]> {
	return scope
		.locator("[data-group-members]")
		.evaluateAll((elements) =>
			elements
				.flatMap(
					(element) =>
						element.getAttribute("data-group-members")?.split(",") ?? [],
				)
				.sort((a, b) => Number(a) - Number(b)),
		);
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

export function setSurfacingFixtureMark(
	page: Page,
	partId: string,
	mark: SurfacingMark | null,
): void {
	publish(
		page,
		(fixtures.get(page) ?? []).map((message) => ({
			...message,
			parts: message.parts?.map((part) =>
				part.id === partId ? { ...part, surfacingMark: mark } : part,
			),
		})),
	);
}

async function pick(page: Page, ordinal: string): Promise<void> {
	await pin(page, ordinal).click();
	await expect(card(page)).toHaveAttribute("data-ordinal", ordinal);
}

function readRequests(page: Page) {
	return requireRpcControl(page)
		.getRequests()
		.filter((request) => request.tag === "SetMessagesRead");
}

function trackReads(page: Page): void {
	const read = readFixtures.get(page);
	if (!read) return;
	requireRpcControl(page).setStubs({
		SetMessagesRead: ({ sessionId, partIds, read }) => {
			expect(sessionId).toBe(SESSION);
			if (failingReadWrites.has(page))
				throw new WsRpcError({ message: "Read state is unavailable" });
			const selected = new Set(partIds);
			publish(
				page,
				(fixtures.get(page) ?? []).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						selected.has(part.id) ? { ...part, surfacingRead: read } : part,
					),
				})),
			);
			return { ok: true };
		},
	});
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
					source:
						match[1] === "active" || match[1] === "invalid-key"
							? "stored"
							: "none",
					rejected: match[1] === "invalid-key",
				},
			});
		},
	},
	{
		name: "open projected surfacing fixture",
		match:
			/^the surfacing session has an? (live|settled|short|hand-back|older|empty|dense) turn$/,
		run: async ({ world, match }) => {
			const kind = match[1] as FixtureKind;
			const read = readFixtures.get(world.page);
			if (read) {
				await world.page.clock.install({ time: PINNED_CLOCK_MS });
				await world.page.clock.pauseAt(PINNED_CLOCK_MS + 1_000);
			}
			trackReads(world.page);
			publish(
				world.page,
				history(kind).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						read && part.type === "text"
							? {
									...part,
									surfacingRead: read.has(part.surfacingOrdinal ?? -1),
								}
							: part,
					),
				})),
			);
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
		name: "assert dense pin rows and group geometry",
		match:
			/^dense surfaced messages occupy two non-overlapping rows with labelled groups$/,
		run: async ({ world }) => {
			const lane = panel(world.page).getByTestId("surfacing-pins");
			await expect(lane).toHaveAttribute("data-layout-ready", "true");
			await expect(lane.getByTestId("surfacing-group").first()).toBeVisible();
			const chips = await lane.locator("button").evaluateAll((buttons) =>
				buttons.map((button) => {
					const chip = button.querySelector(".pin-chip");
					if (!chip) throw new Error("Missing chip");
					const box = chip.getBoundingClientRect();
					return {
						row: button.getAttribute("data-row"),
						left: box.left,
						right: box.right,
						top: box.top,
						name: button.getAttribute("aria-label"),
						members: button.getAttribute("data-group-members"),
					};
				}),
			);
			expect(new Set(chips.map(({ row }) => row))).toEqual(new Set(["0", "1"]));
			const box = await lane.boundingBox();
			if (!box) throw new Error("Missing lane");
			for (const row of ["0", "1"]) {
				const ordered = chips
					.filter((chip) => chip.row === row)
					.sort((a, b) => a.left - b.left);
				for (const [index, chip] of ordered.entries()) {
					expect(chip.left).toBeGreaterThanOrEqual(box.x - 1);
					expect(chip.right).toBeLessThanOrEqual(box.x + box.width + 1);
					if (index > 0)
						expect(
							chip.left - (ordered[index - 1]?.right ?? 0),
						).toBeGreaterThanOrEqual(9);
					if ((chip.members?.split(",").length ?? 0) > 1)
						expect(chip.name).toMatch(/^Group of \d+, led by #\d+ \w+/);
				}
			}
			const first = chips.find(({ row }) => row === "0"),
				upper = chips.find(({ row }) => row === "1");
			expect((first?.top ?? 0) - (upper?.top ?? 0)).toBe(
				(world.page.viewportSize()?.width ?? 1024) < 768 ? 38 : 24,
			);
			const members = chips.flatMap(
				({ members }) => members?.split(",").map(Number) ?? [],
			);
			expect(members.sort((a, b) => a - b)).toEqual(
				Array.from({ length: 56 }, (_, index) => index + 1),
			);
		},
	},
	{
		name: "assert open Ask and Blocked group leaders",
		match:
			/^the open Ask stays separate and a Blocked message leads its group$/,
		run: async ({ world }) => {
			await expect(pin(world.page, "24")).toHaveAttribute(
				"data-group-members",
				"24",
			);
			await expect(pin(world.page, "24")).toHaveAccessibleName(/^#24 Ask/);
			const group = panel(world.page)
				.getByRole("button", { name: /^Group of \d+, led by #(8|40) Blocked/ })
				.first();
			await expect(group).toHaveAccessibleName(
				/^Group of \d+, led by #(8|40) Blocked/,
			);
		},
	},
	{
		name: "tap and cycle the group's members",
		match:
			/^tapping a group cycles through its own members from the leader and wraps$/,
		run: async ({ world }) => {
			const group = panel(world.page).getByTestId("surfacing-group").first();
			const members =
				(await group.getAttribute("data-group-members"))?.split(",") ?? [];
			expect(members.length).toBeGreaterThan(1);
			const leader = await group.getAttribute("data-group-leader");
			const leaderIndex = members.indexOf(leader ?? "");
			expect(leaderIndex).toBeGreaterThanOrEqual(0);
			for (let offset = 0; offset <= members.length; offset++) {
				const ordinal = members[(leaderIndex + offset) % members.length];
				await group.click();
				await expect(card(world.page)).toHaveAttribute(
					"data-ordinal",
					ordinal ?? "",
				);
				await expect(group).toHaveAttribute("aria-pressed", "true");
				await expect(group.locator(".pin-chip.current")).toHaveAttribute(
					"data-number",
					ordinal ?? "",
				);
			}
		},
	},
	{
		name: "scrub and step every grouped member",
		match:
			/^scrubbing and stepping reach every member and fill its group pill$/,
		run: async ({ world }) => {
			const page = world.page;
			const group = panel(page).getByTestId("surfacing-group").first();
			const members =
				(await group.getAttribute("data-group-members"))?.split(",") ?? [];
			expect(members.length).toBeGreaterThan(1);
			const lane = panel(page).getByTestId("surfacing-pins");
			const box = await lane.boundingBox();
			if (!box) throw new Error("Missing lane");
			const strip = panel(page).locator("[data-step-id]").first();
			const stripBox = await strip.boundingBox();
			if (!stripBox) throw new Error("Missing strip");
			for (const ordinal of members) {
				const step = panel(page).locator(
					`[data-step-id="surfacing-agent/surfacing-part-${ordinal}"]`,
				);
				const target = await step.boundingBox();
				if (!target) throw new Error(`Missing step #${ordinal}`);
				await page.mouse.move(
					target.x + target.width / 2 > box.x + box.width / 2
						? box.x + 1
						: box.x + box.width - 1,
					stripBox.y + stripBox.height / 2,
				);
				await page.mouse.down();
				await page.mouse.move(
					target.x + target.width / 2,
					stripBox.y + stripBox.height / 2,
					{ steps: 4 },
				);
				await page.mouse.up();
				await expect(card(page)).toHaveAttribute("data-ordinal", ordinal);
				await expect(group).toHaveAttribute("aria-pressed", "true");
				await expect(group.locator(".pin-chip.current")).toHaveAttribute(
					"data-number",
					ordinal,
				);
			}
			// Park the pointer so the strip's hover tooltip does not linger.
			await page.mouse.move(0, 0);
			await panel(page).getByTestId("surfacing-scrub").focus();
			await page.keyboard.press("Home");
			for (let ordinal = 1; ordinal <= 56; ordinal++) {
				await expect(card(page)).toHaveAttribute(
					"data-ordinal",
					String(ordinal),
				);
				if (ordinal < 56) await page.keyboard.press("ArrowRight");
			}
		},
	},
	{
		name: "resize the pin lane into overflow",
		match: /^the pin lane narrows to (\d+) pixels$/,
		run: async ({ world, match }) => {
			const lane = panel(world.page).getByTestId("surfacing-pins");
			await lane.evaluate((element, width) => {
				element.style.width = `${width}px`;
			}, Number(match[1]));
			await expect(lane).toHaveAttribute("data-lane-width", match[1] ?? "");
		},
	},
	{
		name: "enable deterministic message read fixtures",
		match:
			/^surfacing read tracking starts with (none|[\d,]+) read and summaries off$/,
		run: ({ world, match }) => {
			readFixtures.set(
				world.page,
				new Set(match[1] === "none" ? [] : match[1]?.split(",").map(Number)),
			);
			const settings = mockMessageSurfacing.get(world.page);
			if (!settings) throw new Error("Configure message surfacing first");
			mockMessageSurfacing.set(world.page, {
				...settings,
				recap: { ...settings.recap, model: "off" },
			});
		},
	},
	{
		name: "start a fresh continuous read interval",
		match: /^I start reading surfaced message #(\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await card(page).scrollIntoViewIfNeeded();
			await expect(card(page)).toBeInViewport();
			await page.clock.runFor(32);
			await pick(page, match[1] === "1" ? "2" : "1");
			await pick(page, match[1] ?? "");
		},
	},
	{
		name: "advance the continuous read clock",
		match: /^the surfacing read clock advances (\d+) milliseconds$/,
		run: async ({ world, match }) => {
			await world.page.clock.runFor(Number(match[1]));
		},
	},
	{
		name: "assert read state changes use the RPC boundary",
		match: /^the surfacing read RPC count is (\d+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => readRequests(world.page).length)
				.toBe(Number(match[1]));
		},
	},
	{
		name: "assert exact read RPC targets",
		match:
			/^surfacing read RPC (\d+) marks only messages ([\d,]+) (read|unread)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => readRequests(world.page)[Number(match[1]) - 1]?.payload)
				.toEqual({
					_tag: "SetMessagesRead",
					sessionId: SESSION,
					partIds: match[2]
						?.split(",")
						.map((ordinal) => `surfacing-part-${ordinal}`),
					read: match[3] === "read",
				});
		},
	},
	{
		name: "assert card checkbox reflects persisted read state",
		match: /^the surfaced message Read checkbox is (checked|unchecked)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("surfacing-read-toggle")).toBeChecked(
				{ checked: match[1] === "checked" },
			);
		},
	},
	{
		name: "toggle card read state explicitly",
		match: /^I (check|uncheck) the surfaced message Read checkbox$/,
		run: async ({ world, match }) => {
			const checkbox = world.page.getByTestId("surfacing-read-toggle");
			await expect(checkbox).toBeChecked({ checked: match[1] !== "check" });
			await checkbox.click();
		},
	},
	{
		name: "assert head unread count at the effective level",
		match: /^the surfacing head says (\d+ unread|All read ✓)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("surfacing-head-unread")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "change document visibility without relying on browser focus",
		match: /^the surfacing document becomes (hidden|visible)$/,
		run: async ({ world, match }) => {
			await world.page.evaluate((visibility) => {
				Object.defineProperty(document, "visibilityState", {
					configurable: true,
					value: visibility,
				});
				Object.defineProperty(document, "hidden", {
					configurable: true,
					value: visibility === "hidden",
				});
				document.dispatchEvent(new Event("visibilitychange"));
			}, match[1]);
		},
	},
	{
		name: "move the real card outside and inside the viewport",
		match: /^the surfaced card moves (outside|inside) the viewport$/,
		run: async ({ world, match }) => {
			await card(world.page).evaluate((element, outside) => {
				element.style.transform = outside ? "translateY(-200vh)" : "";
			}, match[1] === "outside");
			await world.page.clock.runFor(32);
			if (match[1] === "outside")
				await expect(card(world.page)).not.toBeInViewport();
			else await expect(card(world.page)).toBeInViewport();
		},
	},
	{
		name: "scrub slowly without reading intermediate messages",
		match: /^I slowly scrub pins from #(\d+) through #(\d+) to #(\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const lane = await panel(page)
				.getByTestId("surfacing-pins")
				.boundingBox();
			const scrub = await panel(page)
				.getByTestId("surfacing-scrub")
				.boundingBox();
			if (!lane || !scrub) throw new Error("Missing scrub bounds");
			const xOf = async (ordinal: string) =>
				scrub.x +
				(scrub.width *
					Number(await pin(page, ordinal).getAttribute("data-x"))) /
					100;
			await page.mouse.move(
				await xOf(match[1] ?? ""),
				lane.y + lane.height / 2,
			);
			await page.mouse.down();
			for (const ordinal of [match[2], match[3]]) {
				await page.mouse.move(
					await xOf(ordinal ?? ""),
					lane.y + lane.height / 2,
					{ steps: 8 },
				);
				await expect(card(page)).toHaveAttribute("data-ordinal", ordinal ?? "");
				await page.clock.runFor(1_200);
				expect(readRequests(page)).toHaveLength(0);
			}
			await page.mouse.up();
		},
	},
	{
		name: "mark all messages at the effective level read",
		match: /^I mark (\d+) surfaced messages read$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("surfacing-mark-read")
				.filter({ hasText: `Mark ${match[1]} read` })
				.click();
			// The button unmounts; keep the pointer off whatever slides under it.
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "assert axis bulk read count and zero state",
		match: /^the surfacing axis offers (?:Mark (\d+) read|no bulk read)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId("surfacing-mark-read");
			if (match[1] === undefined) await expect(button).toHaveCount(0);
			else {
				await expect(button).toHaveText(`✓ Mark ${match[1]} read`);
				await expect(button).toBeEnabled();
			}
		},
	},
	{
		name: "jump to the next unread message from the head",
		match: /^I open the next unread surfaced message from the head$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-head-unread").click();
			// reveal() waits a frame, and read fixtures pause the clock.
			await world.page.clock.runFor(32);
		},
	},
	{
		name: "use focused read state shortcuts",
		match: /^I press surfacing read shortcut (u|m)$/,
		run: async ({ world, match }) => {
			await (match[1] === "m"
				? world.page.getByTestId("surfacing-read-toggle")
				: card(world.page)
			).focus();
			await world.page.keyboard.press(match[1] ?? "");
			await world.page.clock.runFor(32);
		},
	},
	{
		name: "fail or recover persisted message read writes",
		match: /^surfacing read writes (fail|recover)$/,
		run: ({ world, match }) => {
			if (match[1] === "fail") failingReadWrites.add(world.page);
			else failingReadWrites.delete(world.page);
		},
	},
	{
		name: "assert failed read writes do not report success",
		match: /^the surfaced message reports a read save failure$/,
		run: async ({ world }) => {
			await expect(panel(world.page).getByRole("alert")).toContainText(
				"Couldn't save read state",
			);
			await expect(
				world.page.getByTestId("surfacing-read-toggle"),
			).not.toBeChecked();
			expect(
				fixtures
					.get(world.page)
					?.flatMap((message) => message.parts ?? [])
					.find((part) => part.id === "surfacing-part-8")?.surfacingRead,
			).toBe(false);
		},
	},
	{
		name: "set the surfacing capture theme",
		match: /^the surfacing capture uses the (dark|light) theme$/,
		run: async ({ world, match }) => {
			await world.page.clock.resume();
			await world.page.evaluate((light) => {
				document.documentElement.classList.toggle("light-theme", light);
			}, match[1] === "light");
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
				const chip = await button.locator(".pin-chip").evaluate((node) => ({
					left: node.getBoundingClientRect().x,
					right: node.getBoundingClientRect().right,
					tick: Number.parseFloat(getComputedStyle(node, "::after").left),
				}));
				// The stem stays 9px inside a pill pushed off the lane edge, as in the spec.
				const stepX = Math.min(
					Math.max(stepBox.x + stepBox.width / 2, chip.left + 9),
					chip.right - 9,
				);
				expect(
					Math.abs(chip.left + chip.tick - stepX),
					`stem of #${ordinal}`,
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
			await expect
				.poll(() => pinNumbers(panel(world.page)))
				.toEqual((match[1] ?? "").split(","));
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
										...(readFixtures.has(world.page)
											? { surfacingRead: false }
											: {}),
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
				panel(world.page).locator("[data-group-members]"),
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
				await expect.poll(() => pinNumbers(block)).toEqual(expected);
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
			// `s` toggles the turn summary (a modal sheet on phone), so it closes again before the card keys.
			for (const key of ["s", "s", "u", "r", "m", "h", "a", "+", "−"]) {
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
				// "a" and "u" reveal a frame later; let it land so a later Escape isn't undone by it.
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => resolve()),
							),
						),
				);
				if (
					(key === "+" || key === "−") &&
					(await page.getByTestId("surfacing-mark-why").count()) > 0
				) {
					await page.keyboard.press("Escape");
					await expect(page.getByTestId("surfacing-mark-why")).toHaveCount(0);
					await expect(card(page)).toBeFocused();
				}
			}
			await expect(card(page)).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(card(page)).toHaveCount(0);
		},
	},
];
