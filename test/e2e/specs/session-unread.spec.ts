// ─── Session unread: the turn-end dot across windows ─────────────────────────
// A session shows a dot when a turn ends, in every window, until the user
// picks it in the sidebar (click or keyboard) or interacts with its view: a
// click, a wheel scroll, a keypress, focus moved into the view, or a pointer
// resting over the transcript. Watching, window focus, a passing pointer, a
// hidden page, an off-screen view and a scrolled-up transcript do not clear
// it. Reload, reconnect and a relay restart keep the dot; a sub-agent never
// gets one.
// Spec: docs/adr/0004-session-mutations-are-canonical-events.md (Scope),
// conduit-test-hk9m.3 and conduit-test-hk9m.4.
//
// Each step records dot state plus the row's last_turn_end_version and
// seen_version into a report. The raw report is attached to the run; the
// golden holds a normalised copy, because stream versions depend on how many
// text deltas the relay coalesced and so vary from run to run.

import { DatabaseSync } from "node:sqlite";
import type { Browser, Page, TestInfo } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

type Provider = "opencode" | "claude";
type Windows = { readonly A: Page; readonly B: Page };

interface ReportEntry {
	readonly provider: Provider;
	readonly scenario: string;
	readonly sessionId: string;
	readonly window: "A" | "B";
	readonly dot: boolean;
	readonly lastTurnEndVersion: number | null;
	readonly seenVersion: number | null;
	readonly unread: number | null;
}

function query<T>(
	harness: ReplayHarness,
	sql: string,
	...params: string[]
): T[] {
	if (!harness.eventsDbPath) throw new Error("harness has no event store");
	const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

const turnEnds = (harness: ReplayHarness, sessionId: string): number[] =>
	query<{ v: number }>(
		harness,
		"SELECT stream_version AS v FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error') ORDER BY stream_version",
		sessionId,
	).map((row) => row.v);

const row = (page: Page, sessionId: string) =>
	page.locator(`#session-list [data-session-id="${sessionId}"]`);

const dot = (page: Page, sessionId: string) =>
	row(page, sessionId).getByTestId("session-unread-dot");

async function expectDot(windows: Windows, sessionId: string, shown: boolean) {
	for (const page of [windows.A, windows.B])
		await expect(dot(page, sessionId)).toHaveCount(shown ? 1 : 0);
}

type ReportName =
	| "lifecycle"
	| "sub-agent"
	| "click-and-typing"
	| "focus-and-scroll"
	| "dwell-and-viewport";

class Report {
	readonly entries: ReportEntry[] = [];

	constructor(
		private readonly provider: Provider,
		private readonly harness: ReplayHarness,
	) {}

	async record(scenario: string, windows: Windows, sessionId: string) {
		const [state] = query<{
			last_turn_end_version: number | null;
			seen_version: number | null;
			unread: number | null;
		}>(
			this.harness,
			"SELECT last_turn_end_version, seen_version, unread FROM sessions WHERE id = ?",
			sessionId,
		);
		for (const [window, page] of Object.entries(windows) as ["A" | "B", Page][])
			this.entries.push({
				provider: this.provider,
				scenario,
				sessionId,
				window,
				dot: (await dot(page, sessionId).count()) > 0,
				lastTurnEndVersion: state?.last_turn_end_version ?? null,
				seenVersion: state?.seen_version ?? null,
				unread: state?.unread ?? null,
			});
	}

	// Versions become "turn end N" of their session, which is stable across
	// runs; anything that is not a turn end stays raw and so fails the golden.
	async check(testInfo: TestInfo, name: ReportName) {
		const file = `${this.provider}-${name}-report.json`;
		await testInfo.attach(file, {
			body: JSON.stringify(this.entries, null, 2),
			contentType: "application/json",
		});
		const label = (sessionId: string, version: number | null) => {
			if (version === null) return null;
			const index = turnEnds(this.harness, sessionId).indexOf(version);
			return index === -1 ? `v${version}` : `turn end ${index + 1}`;
		};
		const normalised = this.entries.map(({ sessionId, ...entry }) => ({
			...entry,
			session: sessionId === this.entries[0]?.sessionId ? "root" : "sub-agent",
			lastTurnEndVersion: label(sessionId, entry.lastTurnEndVersion),
			seenVersion: label(sessionId, entry.seenVersion),
		}));
		expect(JSON.stringify(normalised, null, 2)).toMatchSnapshot(file);
	}
}

// B's sockets go through a pass-through proxy, so the test can drop them and
// make the client reconnect the way a network blip would.
async function openWindows(page: Page, browser: Browser, relayUrl: string) {
	const context = await browser.newContext({ viewport: page.viewportSize() });
	const B = await context.newPage();
	const sockets: { close(): Promise<void> }[] = [];
	await B.routeWebSocket(/\/(ws|rpc)(\?|$)/, (ws) => {
		ws.connectToServer();
		sockets.push(ws);
	});
	await gotoRelay(page, relayUrl);
	await gotoRelay(B, relayUrl);
	const windows: Windows = { A: page, B };
	return {
		windows,
		dropSockets: async () => {
			for (const ws of sockets.splice(0)) await ws.close();
			await expect.poll(() => sockets.length).toBeGreaterThan(0);
		},
	};
}

async function screenshotRow(page: Page, sessionId: string, name: string) {
	await page.mouse.move(0, 0);
	await expect(row(page, sessionId)).toHaveScreenshot(name, {
		mask: [row(page, sessionId).locator(".session-item-meta")],
	});
}

// Claude turns go through the composer and the trace replayer. OpenCode turns
// are released straight from the mock's recording: in the persistence lane
// the relay routes a composer send for the initial session to Claude (its row
// is recorded with provider "claude"), so the prompt never reaches the mock.
async function endTurn(
	provider: Provider,
	windows: Windows,
	harness: ReplayHarness,
	sessionId: string,
	text: string,
) {
	const before = turnEnds(harness, sessionId).length;
	if (provider === "opencode") harness.mock.triggerPromptSse(sessionId);
	else {
		await new AppPage(windows.A).sendMessage(text);
		await new ChatPage(windows.A).waitForStreamingComplete();
	}
	await expect
		.poll(() => turnEnds(harness, sessionId).length, { timeout: 20_000 })
		.toBe(before + 1);
}

async function dotLifecycle(
	provider: Provider,
	{
		page,
		browser,
		relayUrl,
		harness,
	}: {
		page: Page;
		browser: Browser;
		relayUrl: string;
		harness: ReplayHarness;
	},
	testInfo: TestInfo,
) {
	const sessionId = decodeURIComponent(harness.projectUrl.slice("/s/".length));
	const report = new Report(provider, harness);
	const { windows, dropSockets } = await openWindows(page, browser, relayUrl);

	await test.step("turn end shows the dot in both windows", async () => {
		await endTurn(provider, windows, harness, sessionId, "First turn");
		await expectDot(windows, sessionId, true);
		await report.record("turn end", windows, sessionId);
		await screenshotRow(windows.A, sessionId, `${provider}-dot.png`);
	});

	await test.step("reload and reconnect keep it", async () => {
		await gotoRelay(windows.A, relayUrl);
		await dropSockets();
		await expect(windows.B.locator("#connect-overlay")).toBeHidden();
		await expectDot(windows, sessionId, true);
		await report.record("reload and reconnect", windows, sessionId);
	});

	await test.step("a sidebar click in B clears it in both", async () => {
		await row(windows.B, sessionId).click();
		await expectDot(windows, sessionId, false);
		await report.record("sidebar click", windows, sessionId);
		await screenshotRow(windows.A, sessionId, `${provider}-seen.png`);
	});

	await test.step("a relay restart keeps a new dot", async () => {
		await endTurn(provider, windows, harness, sessionId, "Second turn");
		await expectDot(windows, sessionId, true);
		await harness.restart();
		for (const window of [windows.A, windows.B])
			await expect(window.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
		await expectDot(windows, sessionId, true);
		await report.record("relay restart", windows, sessionId);
	});

	await test.step("a keyboard pick in A clears it in both", async () => {
		await row(windows.A, sessionId).focus();
		await windows.A.keyboard.press("Enter");
		await expectDot(windows, sessionId, false);
		await report.record("keyboard pick", windows, sessionId);
	});

	await report.check(testInfo, "lifecycle");
	await windows.B.context().close();
}

// ─── Interaction with the session view (conduit-test-hk9m.4) ─────────────────
// Window A is the one the user touches; B only watches, so B's dot shows that
// A's report reached every window. A runs on Playwright's clock: interaction
// steps pause it, so the ~300 ms pointer dwell fires only when a step runs the
// clock past it and never races the gesture under test.

interface Fixtures {
	readonly page: Page;
	readonly browser: Browser;
	readonly relayUrl: string;
	readonly harness: ReplayHarness;
}

interface Interaction {
	readonly provider: Provider;
	readonly harness: ReplayHarness;
	readonly sessionId: string;
	readonly windows: Windows;
	readonly report: Report;
	/** MarkSessionSeen requests A has sent: none for a negative, one per turn end. */
	readonly reports: () => number;
}

const transcript = (page: Page) => page.locator("#messages");

async function openInteraction(
	provider: Provider,
	{ page, browser, relayUrl, harness }: Fixtures,
): Promise<Interaction> {
	let sent = 0;
	page.on("websocket", (ws) =>
		ws.on("framesent", ({ payload }) => {
			if (typeof payload === "string" && payload.includes("MarkSessionSeen"))
				sent++;
		}),
	);
	await page.clock.install();
	const { windows } = await openWindows(page, browser, relayUrl);
	await page.mouse.move(0, 0);
	return {
		provider,
		harness,
		sessionId: decodeURIComponent(harness.projectUrl.slice("/s/".length)),
		windows,
		report: new Report(provider, harness),
		reports: () => sent,
	};
}

/** Runs `body` with A's clock paused, then parks the pointer and resumes. */
async function paused(page: Page, body: () => Promise<void>) {
	// Far enough ahead that the running clock cannot pass it before the call lands.
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
	try {
		await body();
	} finally {
		await page.mouse.move(0, 0);
		await page.clock.resume();
	}
}

async function transcriptCentre(page: Page) {
	const box = await transcript(page).boundingBox();
	if (!box) throw new Error("the transcript is not rendered");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function newDot(ctx: Interaction, text: string) {
	await endTurn(ctx.provider, ctx.windows, ctx.harness, ctx.sessionId, text);
	await ctx.windows.A.mouse.move(0, 0);
	await expectDot(ctx.windows, ctx.sessionId, true);
}

/** A negative: A touched the view in a way that must not count. */
async function expectKept(ctx: Interaction, reports: number, scenario: string) {
	await expectDot(ctx.windows, ctx.sessionId, true);
	expect(ctx.reports()).toBe(reports);
	await ctx.report.record(scenario, ctx.windows, ctx.sessionId);
}

async function expectCleared(
	ctx: Interaction,
	reports: number,
	scenario: string,
) {
	await expectDot(ctx.windows, ctx.sessionId, false);
	expect(ctx.reports()).toBe(reports);
	await ctx.report.record(scenario, ctx.windows, ctx.sessionId);
}

async function clickAndTyping(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const ctx = await openInteraction(provider, fixtures);
	const { A } = ctx.windows;

	await test.step("watching without touching keeps the dot", async () => {
		await newDot(ctx, "First turn");
		await expectKept(ctx, 0, "watching");
	});

	await test.step("clicks in A's transcript clear it in both, with one report", async () => {
		await paused(A, async () => {
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await expectCleared(ctx, 1, "click");
		});
	});

	await test.step("typing in A's composer clears the next one", async () => {
		// Focused while the row is read, so only the keypress can count.
		await A.locator("#input").focus();
		await newDot(ctx, "Second turn");
		await A.locator("#input").focus();
		await A.keyboard.type("ok");
		await expectCleared(ctx, 2, "typing");
	});

	await ctx.report.check(testInfo, "click-and-typing");
	await ctx.windows.B.context().close();
}

async function focusAndScroll(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const ctx = await openInteraction(provider, fixtures);
	const { A } = ctx.windows;

	await test.step("window focus alone keeps the dot", async () => {
		await A.locator("#input").focus();
		await newDot(ctx, "First turn");
		// When the window regains focus the browser focuses the element that
		// had it, with no related target: the same events as blur then focus.
		await A.locator("#input").evaluate((input) => {
			input.blur();
			input.focus();
		});
		await expectKept(ctx, 0, "window focus");
	});

	await test.step("tabbing into A's view clears it in both", async () => {
		await A.evaluate(() => {
			const view = document.querySelector<HTMLElement>("#messages");
			const tabbable = [
				...document.querySelectorAll<HTMLElement>(
					"a[href], button:not([disabled]), input, textarea, select, [tabindex]",
				),
			].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
			const before = view ? tabbable[tabbable.indexOf(view) - 1] : undefined;
			if (!before) throw new Error("nothing is tabbable before the transcript");
			before.focus();
		});
		await A.keyboard.press("Tab");
		await expect(transcript(A)).toBeFocused();
		await expectCleared(ctx, 1, "tab into view");
	});

	await test.step("a wheel scroll over A's transcript clears the next one", async () => {
		await A.locator("#input").focus();
		await newDot(ctx, "Second turn");
		await paused(A, async () => {
			const centre = await transcriptCentre(A);
			await A.mouse.move(centre.x, centre.y);
			await A.mouse.wheel(0, -120);
			await expectCleared(ctx, 2, "wheel");
		});
	});

	await ctx.report.check(testInfo, "focus-and-scroll");
	await ctx.windows.B.context().close();
}

async function dwellAndViewport(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const ctx = await openInteraction(provider, fixtures);
	const { A } = ctx.windows;

	await test.step("a passing pointer keeps the dot, a resting one clears it", async () => {
		await newDot(ctx, "First turn");
		await paused(A, async () => {
			const centre = await transcriptCentre(A);
			await A.mouse.move(centre.x, centre.y);
			await A.clock.runFor(200);
			await A.mouse.move(0, 0);
			await A.clock.runFor(1_000);
			await expectKept(ctx, 0, "pointer pass");
			await A.mouse.move(centre.x, centre.y);
			await A.clock.runFor(350);
			await expectCleared(ctx, 1, "pointer rest");
		});
	});

	await test.step("nothing counts while the page is hidden", async () => {
		await newDot(ctx, "Second turn");
		await A.evaluate(() =>
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				get: () => "hidden",
			}),
		);
		await paused(A, async () => {
			const centre = await transcriptCentre(A);
			await A.mouse.move(centre.x, centre.y);
			await A.clock.runFor(1_000);
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await A.keyboard.press("ArrowUp");
			await A.clock.runFor(1_500);
		});
		await A.evaluate(() => Reflect.deleteProperty(document, "visibilityState"));
		await expectKept(ctx, 1, "hidden page");
	});

	await test.step("nothing counts while the view is off screen", async () => {
		await A.evaluate(() => {
			const app = document.querySelector<HTMLElement>("#app");
			if (app) app.style.transform = "translateY(200vh)";
		});
		await expect(A.locator("[data-turn-end]")).not.toBeInViewport();
		// Focus without scrolling, or the page scrolls the view back on screen.
		await A.locator("#input").evaluate((input) =>
			input.focus({ preventScroll: true }),
		);
		await A.keyboard.press("ArrowUp");
		await expect(A.locator("[data-turn-end]")).not.toBeInViewport();
		await A.evaluate(() => {
			const app = document.querySelector<HTMLElement>("#app");
			if (app) app.style.transform = "";
		});
		await expectKept(ctx, 1, "off-screen view");
	});

	await test.step("scrolled up keeps it until the turn end is in view", async () => {
		const viewport = A.viewportSize();
		if (!viewport) throw new Error("window A has no viewport");
		await A.setViewportSize({ width: viewport.width, height: 420 });
		await transcript(A).evaluate((el) => {
			el.scrollTop = 0;
		});
		await expect(A.locator("[data-turn-end]")).not.toBeInViewport();
		await paused(A, async () => {
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await A.clock.runFor(1_500);
			await expectKept(ctx, 1, "scrolled up");
			const centre = await transcriptCentre(A);
			await A.mouse.move(centre.x, centre.y);
			await A.mouse.wheel(0, 10_000);
			await expect(A.locator("[data-turn-end]")).toBeInViewport();
			await expectCleared(ctx, 2, "scrolled to the turn end");
		});
	});

	await ctx.report.check(testInfo, "dwell-and-viewport");
	await ctx.windows.B.context().close();
}

test.describe("Session unread dot", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Sidebar tests run on desktop viewport only",
		);
	});

	test.describe("OpenCode", () => {
		test.use({ recording: "chat-multi-turn", persistence: true });

		test("turn end, pick, reload, reconnect and restart across two windows", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await dotLifecycle(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("watching keeps the dot; a click or typing clears it", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await clickAndTyping(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("window focus keeps the dot; tabbing in or scrolling clears it", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await focusAndScroll(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("a resting pointer clears the dot; a pass, a hidden page, an off-screen or scrolled-up view do not", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await dwellAndViewport(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("a sub-agent never gets a dot", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			const parentId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const childId = "ses_e2e_subagent";
			const report = new Report("opencode", harness);
			const { windows } = await openWindows(page, browser, relayUrl);
			const now = Date.now();
			// OpenCode announces a sub-agent with session.created carrying
			// parentID, then streams its turn like any other session.
			harness.mock.emitTestEvent("session.created", {
				info: {
					id: childId,
					parentID: parentId,
					title: "Sub-agent",
					time: { created: now, updated: now },
				},
			});
			harness.mock.emitTestEvent("message.updated", {
				info: {
					id: "msg_e2e_subagent",
					sessionID: childId,
					role: "assistant",
					time: { created: now, completed: now + 1 },
				},
			});
			await expect
				.poll(() => turnEnds(harness, childId).length, { timeout: 20_000 })
				.toBe(1);
			await expect(dot(windows.A, childId)).toHaveCount(0);
			await expect(dot(windows.B, childId)).toHaveCount(0);
			await report.record("sub-agent", windows, parentId);
			await report.record("sub-agent", windows, childId);
			await report.check(testInfo, "sub-agent");
			await windows.B.context().close();
		});
	});

	test.describe("Claude", () => {
		test.describe("dot lifecycle", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				},
			});

			test("turn end, pick, reload, reconnect and restart across two windows", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await dotLifecycle(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});
		});

		test.describe("interaction", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				},
			});

			test("watching keeps the dot; a click or typing clears it", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await clickAndTyping(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});

			test("window focus keeps the dot; tabbing in or scrolling clears it", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await focusAndScroll(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});

			test("a resting pointer clears the dot; a pass, a hidden page, an off-screen or scrolled-up view do not", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await dwellAndViewport(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});
		});

		test.describe("sub-agent", () => {
			test.use({ claudeReplay: { turns: ["subagent-task-turn"] } });

			test("a sub-agent never gets a dot", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				const parentId = decodeURIComponent(
					harness.projectUrl.slice("/s/".length),
				);
				const report = new Report("claude", harness);
				const { windows } = await openWindows(page, browser, relayUrl);
				await endTurn(
					"claude",
					windows,
					harness,
					parentId,
					"Ask a subagent to summarise package.json",
				);
				const [child] = query<{ id: string }>(
					harness,
					"SELECT id FROM sessions WHERE parent_id = ?",
					parentId,
				);
				if (!child) throw new Error("the trace created no sub-agent session");
				await expectDot(windows, parentId, true);
				await expect(dot(windows.A, child.id)).toHaveCount(0);
				await expect(dot(windows.B, child.id)).toHaveCount(0);
				await report.record("sub-agent", windows, parentId);
				await report.record("sub-agent", windows, child.id);
				await report.check(testInfo, "sub-agent");
				await windows.B.context().close();
			});
		});
	});
});
