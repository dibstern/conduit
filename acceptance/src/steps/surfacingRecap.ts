import { expect, type Locator, type Page } from "@playwright/test";
import { Stream } from "effect";
import type {
	RecapSnapshot,
	TurnRecap,
} from "../../../src/lib/contracts/turn-recap.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockMessageSurfacing,
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";

const SESSION = "sess-surfacing";
const TURN = "surfacing-user";
const WHOLE_TEXT = "The routing review is complete. [#2] [#3] [#8]";
const NEW_TEXT = "The newer messages identify the remaining risk. [#8]";
const EARLIER_TEXT = "The earlier review found a routing decision. [#4]";
const SDK_ERROR = "Claude is not signed in. Run claude auth login.";
const recapFixtures = new WeakMap<
	Page,
	{
		versions: TurnRecap[];
		generating: boolean;
		readsBeforeStream?: number;
		citationScroll?: number;
	}
>();

function summary(page: Page): Locator {
	return page.getByTestId("surfacing-summary").filter({ visible: true });
}

function summaryTrigger(page: Page): Locator {
	return page
		.getByTestId("surfacing-summary-generate")
		.filter({ visible: true });
}

function isPhone(page: Page): boolean {
	return (page.viewportSize()?.width ?? 1440) < 600;
}

async function openSummary(page: Page): Promise<void> {
	if (!(await summary(page).isVisible())) await summaryTrigger(page).click();
	await expect(summary(page)).toBeVisible();
}

function generationRequests(page: Page) {
	return requireRpcControl(page)
		.getRequests()
		.filter((request) => request.tag === "GenerateRecap");
}

function version(
	versionNumber: number,
	scope: "whole" | "new",
	lastOrdinal: number,
	text: string,
): TurnRecap {
	return {
		sessionId: SESSION,
		turnId: TURN,
		version: versionNumber,
		scope,
		firstOrdinal: scope === "whole" ? 1 : 5,
		lastOrdinal,
		text,
		model: "sonnet",
		durationMs: 1600,
		createdAt: PINNED_CLOCK_MS - (3 - versionNumber) * 20_000,
	};
}

export const surfacingRecapHandlers: StepHandler[] = [
	{
		name: "set unfolded Duo reader viewport",
		match: /^the viewport is a duo$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, {
				name: "duo",
				width: 626,
				height: 852,
			});
		},
	},
	{
		name: "open a recap fixture through cached and generated RPCs",
		match:
			/^the recap session has a (live|settled) turn with (current|stale|automatic|no|failing|disabled) summaries(?: and messages ([\d,]+) read)?$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const mode = match[2];
			const previous = mockMessageSurfacing.get(page);
			if (!previous) throw new Error("Surfacing must be seeded before recaps");
			mockMessageSurfacing.set(page, {
				...previous,
				summariesEnabled: mode !== "disabled",
				recap: {
					model: mode === "disabled" ? "off" : "sonnet",
					when: mode === "automatic" ? "turn-end" : "on-request",
				},
			});
			const versions: TurnRecap[] =
				mode === "current" || mode === "disabled"
					? [
							version(1, "whole", 4, EARLIER_TEXT),
							version(2, "new", 8, WHOLE_TEXT),
						]
					: mode === "stale" || mode === "automatic"
						? [version(1, "whole", 4, EARLIER_TEXT)]
						: [];
			const fixture = { versions, generating: false };
			recapFixtures.set(page, fixture);
			let failNext = mode === "failing";
			const rpc = requireRpcControl(page);
			rpc.setStubs({
				ListRecaps: () => [...versions],
				SubscribeRecaps: () =>
					Stream.concat(
						Stream.succeed({
							versions: [...versions],
							generating: fixture.generating,
							error: null,
						}),
						Stream.never,
					),
				GenerateRecap: ({ sessionId, turnId, scope, sourceVersion }) => {
					if (failNext) {
						failNext = false;
						throw new WsRpcError({ message: SDK_ERROR });
					}
					const source = versions.find(
						(item) => item.version === sourceVersion,
					);
					const next = {
						...version(
							versions.length + 1,
							scope,
							8,
							scope === "new" ? NEW_TEXT : WHOLE_TEXT,
						),
						sessionId,
						turnId,
						firstOrdinal:
							source?.firstOrdinal ??
							(scope === "new" ? (versions.at(-1)?.lastOrdinal ?? 0) + 1 : 1),
					};
					versions.push(next);
					return next;
				},
			});
			const read = match[3]?.split(",").map(Number);
			if (read) rpc.setStubs({ SetMessagesRead: () => ({ ok: true }) });
			rpc.setDetailRows(
				SESSION,
				surfacingHistory(match[1] === "live" ? "live" : "settled")
					.map((message) =>
						read
							? {
									...message,
									parts: message.parts?.map((part) =>
										part.type === "text"
											? {
													...part,
													surfacingRead: read.includes(
														part.surfacingOrdinal ?? -1,
													),
												}
											: part,
									),
								}
							: message,
					)
					.flatMap(detailRowsOf),
			);
			setSessionRowStatus(
				page,
				SESSION,
				match[1] === "live" ? "busy" : "idle",
				{
					title: "Turn recap acceptance",
					accountId: "claude",
					updatedAt: PINNED_CLOCK_MS,
				},
			);
			// The app already read its settings before this step seeded recap timing.
			await page.reload();
			await openSessionRoute(page, SESSION);
			await expect(page.locator("#messages")).toContainText(
				"Review the session routing.",
			);
		},
	},
	{
		name: "start another turn while the previous recap is pending",
		match:
			/^the next turn starts (before the recap settles|while its recap is pending on the server)$/,
		run: async ({ world, match }) => {
			if (match[1] === "while its recap is pending on the server") {
				const fixture = recapFixtures.get(world.page);
				if (!fixture) throw new Error("Recap fixture was not seeded");
				fixture.generating = true;
			}
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				surfacingHistory("older").flatMap(detailRowsOf),
			);
			await expect(world.page.locator("#messages")).toContainText(
				"Continue with the next turn.",
			);
		},
	},
	{
		name: "assert pending recap finishes",
		match: /^the summary has finished generating$/,
		run: async ({ world }) => {
			await expect(summary(world.page)).toHaveAttribute("aria-busy", "false");
			await expect(summary(world.page)).not.toContainText("Summarising…");
		},
	},
	{
		name: "publish an automatic recap through the existing subscription",
		match: /^a completed-turn recap arrives from the server$/,
		run: async ({ world }) => {
			const fixture = recapFixtures.get(world.page);
			if (!fixture) throw new Error("Recap fixture was not seeded");
			const rpc = requireRpcControl(world.page);
			await expect.poll(() => rpc.hasStream("SubscribeRecaps")).toBe(true);
			fixture.readsBeforeStream = rpc
				.getRequests()
				.filter(
					({ tag }) => tag === "ListRecaps" || tag === "ViewSession",
				).length;
			const previous = fixture.versions.at(-1);
			if (!previous)
				throw new Error("Automatic recap needs an earlier version");
			fixture.versions.push({
				...version(
					previous.version + 1,
					"new",
					previous.version === 1 ? 6 : 8,
					previous.version === 1
						? "The later review found a blocker. [#5]"
						: NEW_TEXT,
				),
				firstOrdinal: previous.lastOrdinal + 1,
			});
			fixture.generating = false;
			rpc.sendChunk("SubscribeRecaps", [
				{
					versions: [...fixture.versions],
					generating: false,
					error: null,
				} satisfies RecapSnapshot,
			]);
		},
	},
	{
		name: "publish automatic recap generation and failure states",
		match: /^the server recap is (generating|failed)$/,
		run: async ({ world, match }) => {
			const fixture = recapFixtures.get(world.page);
			if (!fixture) throw new Error("Recap fixture was not seeded");
			fixture.generating = match[1] === "generating";
			const rpc = requireRpcControl(world.page);
			await expect.poll(() => rpc.hasStream("SubscribeRecaps")).toBe(true);
			fixture.readsBeforeStream = rpc
				.getRequests()
				.filter(
					({ tag }) => tag === "ListRecaps" || tag === "ViewSession",
				).length;
			rpc.sendChunk("SubscribeRecaps", [
				{
					versions: [...fixture.versions],
					generating: match[1] === "generating",
					error: match[1] === "failed" ? SDK_ERROR : null,
				} satisfies RecapSnapshot,
			]);
		},
	},
	{
		name: "assert automatic generation state",
		match: /^the summary indicates server generation$/,
		run: async ({ world }) => {
			await expect(summary(world.page)).toHaveAttribute("aria-busy", "true");
			await expect(
				summary(world.page).getByRole("button", {
					name: "Regenerate summary",
					exact: true,
				}),
			).toBeDisabled();
			await expect(summary(world.page)).toContainText("Summarising…");
		},
	},
	{
		name: "assert streamed recaps require no refresh",
		match: /^the recap arrived without reloading or listing again$/,
		run: ({ world }) => {
			const fixture = recapFixtures.get(world.page);
			if (fixture?.readsBeforeStream === undefined)
				throw new Error("No automatic recap was published");
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(({ tag }) => tag === "ListRecaps" || tag === "ViewSession")
					.length,
			).toBe(fixture.readsBeforeStream);
		},
	},
	{
		name: "assert responsive settled summary default",
		match: /^the newest cached summary is the settled default$/,
		run: async ({ world }) => {
			if (isPhone(world.page)) {
				await expect(summary(world.page)).toBeHidden();
				await expect(summaryTrigger(world.page)).toContainText("Summary");
			} else {
				await expect(summary(world.page)).toContainText(
					WHOLE_TEXT.split(" [#")[0] ?? "",
				);
			}
		},
	},
	{
		name: "assert the summary foot owns bulk read",
		match: /^the summary foot offers Mark (\d+) read$/,
		run: async ({ world, match }) => {
			// Summaries own the bulk read, so the axis no longer offers it.
			await expect(world.page.getByTestId("surfacing-mark-read")).toHaveCount(
				1,
			);
			await expect(
				summary(world.page).getByTestId("surfacing-mark-read"),
			).toHaveText(`✓ Mark ${match[1]} read`);
		},
	},
	{
		name: "open cached summary",
		match: /^I open the turn summary$/,
		run: ({ world }) => openSummary(world.page),
	},
	{
		name: "assert recap version and prose",
		match: /^recap version (\d+) of (\d+) says (.+)$/,
		run: async ({ world, match }) => {
			await expect(summary(world.page)).toContainText(match[3] ?? "");
			const version = summary(world.page).getByTestId(
				"surfacing-summary-version",
			);
			// A lone version shows no pager, only its scope.
			await (match[2] === "1"
				? expect(version).not.toContainText("/")
				: expect(version).toContainText(`${match[1]}/${match[2]}`));
		},
	},
	{
		name: "assert recap reads are free",
		match: /^no recap generation was requested$/,
		run: ({ world }) => {
			expect(generationRequests(world.page)).toEqual([]);
		},
	},
	{
		name: "assert unwritten summary action",
		match: /^the turn offers Summarize without a summary$/,
		run: async ({ world }) => {
			await expect(summary(world.page)).toBeHidden();
			await expect(summaryTrigger(world.page)).toContainText("Summarize");
		},
	},
	{
		name: "assert unwritten summary has an explicit generation action",
		match: /^the empty summary offers Summarize and its settings$/,
		run: async ({ world }) => {
			await expect(
				summary(world.page).getByTestId("surfacing-summary-new"),
			).toContainText("Summarize");
			await expect(
				summary(world.page).getByTestId("surfacing-summary-settings"),
			).toBeVisible();
			await expect(
				summary(world.page).getByTestId("surfacing-summary-version"),
			).toHaveCount(0);
		},
	},
	{
		name: "generate the first summary",
		match: /^I request the turn summary$/,
		run: async ({ world }) => {
			await openSummary(world.page);
			await summary(world.page).getByTestId("surfacing-summary-new").click();
		},
	},
	{
		name: "assert paid recap scope requests",
		match: /^recap generation scopes are (whole|new)(,(?:whole|new))*$/,
		run: ({ world, text }) => {
			expect(
				generationRequests(world.page).map(({ payload }) => payload["scope"]),
			).toEqual(text.replace("recap generation scopes are ", "").split(","));
		},
	},
	{
		name: "open summary settings",
		match: /^I open summary settings$/,
		run: async ({ world }) => {
			await summary(world.page)
				.getByTestId("surfacing-summary-settings")
				.click();
		},
	},
	{
		name: "assert summary menu labels",
		match: /^the summary settings name their model and timing$/,
		run: async ({ world }) => {
			const menu = world.page.getByRole("menu");
			for (const label of ["Summary model", "Summary timing"])
				await expect(menu).toContainText(label);
			for (const label of [
				"Sonnet",
				"Opus",
				"Off",
				"When a turn ends",
				"On request",
			])
				await expect(
					menu.getByRole("menuitemradio", { name: label, exact: true }),
				).toBeVisible();
		},
	},
	{
		name: "select a summary setting",
		match: /^I choose summary setting (Opus|Off|When a turn ends)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByRole("menuitemradio", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "refresh another device's recap preferences without remounting the turn",
		match: /^another device enables Sonnet summaries and preferences refresh$/,
		run: async ({ world }) => {
			const page = world.page;
			const previous = mockMessageSurfacing.get(page);
			if (!previous) throw new Error("Surfacing settings were not seeded");
			const turn = await page.getByTestId("surfacing-card").elementHandle();
			const rpc = requireRpcControl(page);
			const reads = rpc
				.getRequests()
				.filter(({ tag }) => tag === "GetMessageSurfacing").length;
			mockMessageSurfacing.set(page, {
				...previous,
				summariesEnabled: true,
				recap: { model: "sonnet", when: "on-request" },
			});
			rpc.closeStreamSocket("SubscribeShell");
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "GetMessageSurfacing")
							.length,
				)
				.toBeGreaterThan(reads);
			await expect(summaryTrigger(page)).toBeVisible();
			expect(await turn?.evaluate((element) => element.isConnected)).toBe(true);
		},
	},
	{
		name: "assert summary model follows shared preferences",
		match: /^the summary model is Sonnet$/,
		run: async ({ world }) => {
			await expect(
				summary(world.page).getByTestId("surfacing-summary-settings"),
			).toContainText("Sonnet");
		},
	},
	{
		name: "assert summary setting patch",
		match: /^the summary setting patch is (model|when) (opus|turn-end)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(
					() =>
						requireRpcControl(world.page)
							.getRequests()
							.filter(({ tag }) => tag === "UpdateMessageSurfacing")
							.at(-1)?.payload,
				)
				.toEqual({
					_tag: "UpdateMessageSurfacing",
					recap: { [match[1] ?? ""]: match[2] },
				});
		},
	},
	{
		name: "assert stale actions",
		match: /^the summary offers (\d+) new messages and Whole turn$/,
		run: async ({ world, match }) => {
			await expect(
				summary(world.page).getByTestId("surfacing-summary-new"),
			).toContainText(`Summarize ${match[1]} new`);
			await expect(
				summary(world.page).getByRole("button", {
					name: "Whole turn",
					exact: true,
				}),
			).toBeVisible();
		},
	},
	{
		name: "generate only new messages",
		match: /^I summarize the new messages$/,
		run: async ({ world }) => {
			await summary(world.page).getByTestId("surfacing-summary-new").click();
		},
	},
	{
		name: "generate whole turn again",
		match: /^I summarize the whole turn again$/,
		run: async ({ world }) => {
			await summary(world.page)
				.getByRole("button", { name: "Whole turn", exact: true })
				.click();
		},
	},
	{
		name: "step between recap versions",
		match: /^I select the (previous|next) summary$/,
		run: async ({ world, match }) => {
			await summary(world.page)
				.getByRole("button", {
					name: match[1] === "previous" ? "Previous summary" : "Next summary",
					exact: true,
				})
				.click();
		},
	},
	{
		name: "regenerate selected version",
		match: /^I regenerate the selected summary$/,
		run: async ({ world }) => {
			await summary(world.page)
				.getByRole("button", { name: "Regenerate summary", exact: true })
				.click();
		},
	},
	{
		name: "assert regeneration names the selected source version",
		match: /^the regenerated summary names source version (\d+)$/,
		run: ({ world, match }) => {
			expect(
				generationRequests(world.page).at(-1)?.payload["sourceVersion"],
			).toBe(Number(match[1]));
		},
	},
	{
		name: "follow a recap citation",
		match: /^I follow recap citation #(\d+)$/,
		run: async ({ world, match }) => {
			const fixture = recapFixtures.get(world.page);
			if (!fixture) throw new Error("Recap fixture was not seeded");
			fixture.citationScroll = await world.page
				.locator("#messages")
				.evaluate((element) => element.scrollTop);
			await summary(world.page)
				.getByTestId(`surfacing-recap-cite-${match[1]}`)
				.click();
		},
	},
	{
		name: "assert citation preserves summary",
		match: /^the cited summary remains open$/,
		run: async ({ world }) => {
			await expect(summary(world.page)).toBeVisible();
		},
	},
	{
		name: "close only the cited message",
		match: /^I close the cited message$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Close cited message", exact: true })
				.click();
			await expect(summary(world.page)).toBeVisible();
		},
	},
	{
		name: "assert citation is usable in its reader without scrolling the transcript",
		match:
			/^recap citation #(\d+) is readable below Balanced without moving the transcript$/,
		run: async ({ world, match }) => {
			const card = world.page.getByTestId("surfacing-recap-reader");
			await expect(card).toBeVisible();
			await expect(card).toHaveAttribute("data-ordinal", match[1] ?? "");
			await expect(card).toContainText("At All, below Balanced");
			await expect(card).toContainText("The file includes a second route.");
			await expect(card).toBeInViewport();
			if (isPhone(world.page))
				expect(
					await card.evaluate((element) => !!element.closest("dialog[open]")),
				).toBe(true);
			else if ((world.page.viewportSize()?.width ?? 1440) < 1024) {
				const summaryBox = await summary(world.page).boundingBox();
				const readerBox = await card.boundingBox();
				if (!summaryBox || !readerBox)
					throw new Error("Missing Duo reader geometry");
				expect(readerBox.x).toBeGreaterThanOrEqual(
					summaryBox.x + summaryBox.width,
				);
			}
			expect(
				await world.page
					.locator("#messages")
					.evaluate((element) => element.scrollTop),
			).toBe(recapFixtures.get(world.page)?.citationScroll);
		},
	},
	{
		name: "select a card before testing summary dismissal",
		match: /^I select a transcript card and open its summary$/,
		run: async ({ world }) => {
			if (await summary(world.page).isVisible())
				await summary(world.page)
					.getByRole("button", { name: "Close summary", exact: true })
					.click();
			await world.page.getByTestId("surfacing-pin-2").click();
			await expect(
				world.page.getByTestId("surfacing-msg-card"),
			).toHaveAttribute("data-ordinal", "2");
			await openSummary(world.page);
		},
	},
	{
		name: "dismiss summary before card shortcuts and preserve native phone dismissal",
		match: /^I dismiss the summary with Escape$/,
		run: async ({ world }) => {
			const cancelled = world.page.evaluate(
				() =>
					new Promise<boolean>((resolve) => {
						// The summary stops Escape from reaching the card shortcuts, so
						// observe it on capture and read the outcome after dispatch.
						document.addEventListener(
							"keydown",
							(event) => setTimeout(() => resolve(event.defaultPrevented)),
							{ once: true, capture: true },
						);
					}),
			);
			await summary(world.page)
				.getByRole("button", { name: "Close summary", exact: true })
				.press("Escape");
			expect(await cancelled).toBe(!isPhone(world.page));
		},
	},
	{
		name: "assert Escape preserves the transcript selection",
		match: /^the selected transcript card is unchanged$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-msg-card"),
			).toHaveAttribute("data-ordinal", "2");
		},
	},
	{
		name: "assert followed citation",
		match: /^recap citation #(\d+) is followed$/,
		run: async ({ world, match }) => {
			await expect(
				summary(world.page).getByTestId(`surfacing-recap-cite-${match[1]}`),
			).toHaveAttribute("data-followed", "true");
		},
	},
	{
		name: "assert failed recap and SDK error",
		match: /^the summary failure offers Retry and the SDK sign-in error$/,
		run: async ({ world }) => {
			await expect(
				summary(world.page).getByText("Summary failed", {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				summary(world.page).getByText(SDK_ERROR, { exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "retry a failed recap",
		match: /^I retry the failed summary$/,
		run: async ({ world }) => {
			await summary(world.page)
				.getByRole("button", { name: "Retry", exact: true })
				.click();
		},
	},
	{
		name: "assert recap model Off",
		match: /^the turn has no summary controls$/,
		run: async ({ world }) => {
			for (const id of [
				"surfacing-summary",
				"surfacing-summary-generate",
				"surfacing-summary-settings",
			])
				await expect(world.page.getByTestId(id)).toHaveCount(0);
		},
	},
	{
		name: "toggle recap from focused turn",
		match: /^I toggle the focused turn summary with s$/,
		run: async ({ world }) => {
			// The phone sheet handles shortcuts while focus stays inside its dialog.
			if (isPhone(world.page) && (await summary(world.page).isVisible())) {
				await world.page.getByRole("dialog").press("s");
			} else {
				const panel = world.page.getByTestId("surfacing-card");
				await panel.focus();
				await panel.press("s");
			}
		},
	},
	{
		name: "assert closed summary body",
		match: /^the summary body is closed$/,
		run: async ({ world }) => {
			await expect(summary(world.page)).toBeHidden();
		},
	},
	{
		name: "assert phone sheet geometry and citation hit targets",
		match: /^the phone summary has a bottom sheet and padded citations$/,
		run: async ({ world }) => {
			const dialog = world.page.getByRole("dialog");
			await expect(dialog).toContainText("Turn summary");
			const sheetBox = await dialog.boundingBox();
			const viewport = world.page.viewportSize();
			if (!sheetBox || !viewport)
				throw new Error("Missing phone sheet geometry");
			expect(sheetBox.y).toBeGreaterThan(0);
			expect(sheetBox.y + sheetBox.height).toBeGreaterThanOrEqual(
				viewport.height - 1,
			);
			// Citations pad their hit area with an invisible ::before, so probe
			// the points a 32px target must own rather than the painted pill.
			// Dense inline citations may share a pad edge with a neighbour.
			const missed = await summary(world.page)
				.getByTestId("surfacing-recap-cite-3")
				.evaluate((cite) => {
					const box = cite.getBoundingClientRect();
					const x = box.left + box.width / 2;
					const y = box.top + box.height / 2;
					return [
						[x - 16, y],
						[x + 16, y],
						[x, y - 16],
						[x, y + 16],
					].filter(
						([px = 0, py = 0]) =>
							!document
								.elementFromPoint(px, py)
								?.closest('[data-testid^="surfacing-recap-cite-"]'),
					);
				});
			expect(missed).toEqual([]);
		},
	},
	{
		name: "dismiss phone summary scrim",
		match: /^I dismiss the summary with its scrim$/,
		run: async ({ world }) => {
			const box = await world.page.getByRole("dialog").boundingBox();
			if (!box || box.y < 2)
				throw new Error("Phone summary must leave a scrim above it");
			await world.page.mouse.click(16, box.y / 2);
		},
	},
];
