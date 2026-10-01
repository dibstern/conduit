// ─── Session unread: the turn-end dot across windows ─────────────────────────
// A session shows a dot when a turn ends, in every window, until the user
// picks it in the sidebar (click or keyboard) or interacts with its view: a
// click, a wheel scroll, a keypress, focus moved into the view, or a pointer
// resting over the transcript. Watching, window focus, a passing pointer, a
// hidden page, an off-screen view and a scrolled-up transcript do not clear
// it. Reload, reconnect and a relay restart keep the dot; a sub-agent never
// gets one. A report that lands late marks only the turn end it was made for;
// one lost to a dropped connection is sent on reconnect if the dot is still
// there.
// A dot marked unread by hand holds against those touches, in every window,
// until the user switches away from the session.
// Spec: docs/adr/0004-session-mutations-are-canonical-events.md (Scope),
// conduit-test-hk9m.3, conduit-test-hk9m.4, conduit-test-hk9m.5 and
// conduit-test-hk9m.6.
//
// Each step records dot state plus the row's last_turn_end_version and
// seen_version into a report. The raw report is attached to the run; the
// golden holds a normalised copy, because stream versions depend on how many
// text deltas the relay coalesced and so vary from run to run.

import { DatabaseSync } from "node:sqlite";
import type { Browser, Page, TestInfo, WebSocketRoute } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

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

const unreadCount = (page: Page) =>
	page.getByTestId("session-filter-chip-unread").locator("b");

async function expectDot(windows: Windows, sessionId: string, shown: boolean) {
	for (const page of [windows.A, windows.B])
		await expect(dot(page, sessionId)).toHaveCount(shown ? 1 : 0);
}

type ReportName =
	| "lifecycle"
	| "sub-agent"
	| "fork"
	| "click-and-typing"
	| "focus-and-scroll"
	| "dwell-and-viewport"
	| "mark-unread"
	| "held-report"
	| "dropped-report";

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
	// runs, or "before turn end N" for a mark unread; anything else stays raw
	// and so fails the golden.
	async check(testInfo: TestInfo, name: ReportName) {
		const file = `${this.provider}-${name}-report.json`;
		await testInfo.attach(file, {
			body: JSON.stringify(this.entries, null, 2),
			contentType: "application/json",
		});
		const label = (sessionId: string, version: number | null) => {
			if (version === null) return null;
			const ends = turnEnds(this.harness, sessionId);
			const index = ends.indexOf(version);
			if (index !== -1) return `turn end ${index + 1}`;
			const next = ends.indexOf(version + 1);
			return next === -1 ? `v${version}` : `before turn end ${next + 1}`;
		};
		const normalised = this.entries.map(({ sessionId, ...entry }) => ({
			...entry,
			session: sessionId === this.entries[0]?.sessionId ? "root" : name,
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
	const sessionId = decodeURIComponent(
		new URL(relayUrl).pathname.slice("/s/".length),
	);
	for (const window of [page, B])
		await expect(row(window, sessionId)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
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
		await A.setViewportSize({ width: viewport.width, height: 300 });
		await transcript(A).evaluate((el) => {
			el.scrollTop = 0;
			// Establish the detached state before the paused-clock interaction.
			el.dispatchEvent(new Event("scroll"));
			el.dispatchEvent(new Event("scroll"));
		});
		await expect(A.locator("[data-turn-end]")).not.toBeInViewport();
		await paused(A, async () => {
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await A.clock.runFor(1_500);
			await expect(A.locator("[data-turn-end]")).not.toBeInViewport();
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

// ─── Mark unread holds until switch-away (conduit-test-hk9m.5) ───────────────
// A row that turns unread while its turn end stays put was marked unread, from
// this window or another: touching the view leaves it until the user switches
// away from the session. A clears the first turn end itself before marking it,
// so its burst guard is already spent; B clears the second, so A has never
// reported it and only the hold can keep the dot.

async function markUnread(page: Page, sessionId: string) {
	await new SidebarPage(page).openContextMenu(sessionId);
	await page.getByTestId("session-ctx-mark-unread").click();
}

/** A rests its pointer on the transcript and clicks it. */
async function restAndClick(A: Page) {
	await paused(A, async () => {
		const centre = await transcriptCentre(A);
		await A.mouse.move(centre.x, centre.y);
		await A.clock.runFor(350);
		await transcript(A).click({ position: { x: 24, y: 24 } });
		await A.clock.runFor(350);
	});
}

const OTHER_SESSION = "ses_e2e_other";

/** A switches to another session and comes back without picking this one. */
async function switchAwayAndBack(ctx: Interaction) {
	const { A } = ctx.windows;
	await row(A, OTHER_SESSION).click();
	await expect(A).not.toHaveURL(new RegExp(`/s/${ctx.sessionId}$`));
	await A.goBack();
	await expect(A).toHaveURL(new RegExp(`/s/${ctx.sessionId}$`));
	await expect(A.locator("[data-turn-end]")).toBeInViewport();
}

async function markUnreadHolds(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const ctx = await openInteraction(provider, fixtures);
	const { A, B } = ctx.windows;
	// Somewhere to switch away to: a session's first streamed event seeds its
	// row, and a user message ends no turn.
	const now = Date.now();
	ctx.harness.mock.emitTestEvent("session.created", {
		info: {
			id: OTHER_SESSION,
			title: "Elsewhere",
			time: { created: now, updated: now },
		},
	});
	ctx.harness.mock.emitTestEvent("message.updated", {
		info: {
			id: "msg_e2e_other",
			sessionID: OTHER_SESSION,
			role: "user",
			time: { created: now },
		},
	});
	await expect(row(A, OTHER_SESSION)).toBeVisible();

	await test.step("marked unread in A with one finished turn, A's pointer and clicks keep it", async () => {
		await newDot(ctx, "First turn");
		await paused(A, async () => {
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await expectCleared(ctx, 1, "click");
		});
		await markUnread(A, ctx.sessionId);
		await expectDot(ctx.windows, ctx.sessionId, true);
		await restAndClick(A);
		await expectKept(ctx, 1, "marked unread in A, then touched");
	});

	await test.step("switching away and back lets a resting pointer clear it", async () => {
		await switchAwayAndBack(ctx);
		await expectKept(ctx, 1, "switched away and back");
		await paused(A, async () => {
			const centre = await transcriptCentre(A);
			await A.mouse.move(centre.x, centre.y);
			await A.clock.runFor(350);
			await expectCleared(ctx, 2, "pointer rest after switching back");
		});
	});

	await test.step("marked unread in B, A's pointer and clicks keep it", async () => {
		await newDot(ctx, "Second turn");
		await row(B, ctx.sessionId).click();
		await expectDot(ctx.windows, ctx.sessionId, false);
		await markUnread(B, ctx.sessionId);
		await expectDot(ctx.windows, ctx.sessionId, true);
		await restAndClick(A);
		await expectKept(ctx, 2, "marked unread in B, then touched in A");
	});

	await test.step("A switching away and back lets a click clear it", async () => {
		await switchAwayAndBack(ctx);
		await expectKept(ctx, 2, "switched away and back after B's mark");
		await paused(A, async () => {
			await transcript(A).click({ position: { x: 24, y: 24 } });
			await expectCleared(ctx, 3, "click after switching back");
		});
	});

	await ctx.report.check(testInfo, "mark-unread");
	await B.context().close();
}

// ─── Failing toward unread (conduit-test-hk9m.6) ─────────────────────────────
// A's sockets go through a proxy that can hold its MarkSessionSeen frames in
// flight, cut the connection and keep it down, so a report can be made to
// land late or not at all.

async function proxySockets(page: Page) {
	let holding = false;
	let offline = false;
	let reports = 0;
	const held: (() => void)[] = [];
	const sockets: WebSocketRoute[] = [];
	await page.routeWebSocket(/\/(ws|rpc)(\?|$)/, (ws) => {
		if (offline) {
			void ws.close();
			return;
		}
		const server = ws.connectToServer();
		sockets.push(ws);
		ws.onMessage((message) => {
			const report =
				typeof message === "string" && message.includes("MarkSessionSeen");
			if (report) reports++;
			if (report && holding) held.push(() => server.send(message));
			else server.send(message);
		});
	});
	return {
		/** MarkSessionSeen frames A has sent, held or not. */
		reports: () => reports,
		hold: () => {
			holding = true;
		},
		release: () => {
			holding = false;
			for (const send of held.splice(0)) send();
		},
		/** Drops A's sockets, and any held frame with them, until `reconnect`. */
		disconnect: async () => {
			offline = true;
			holding = false;
			held.length = 0;
			for (const ws of sockets.splice(0)) await ws.close();
		},
		reconnect: async () => {
			offline = false;
			await expect(page.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
		},
	};
}

const seenVersion = (ctx: Interaction) =>
	query<{ seen_version: number | null }>(
		ctx.harness,
		"SELECT seen_version FROM sessions WHERE id = ?",
		ctx.sessionId,
	)[0]?.seen_version;

async function clickTranscript(page: Page) {
	await paused(page, () =>
		transcript(page).click({ position: { x: 24, y: 24 } }),
	);
}

async function heldReport(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const proxy = await proxySockets(fixtures.page);
	const ctx = await openInteraction(provider, fixtures);
	const { A } = ctx.windows;

	await test.step("a report that lands after the next turn end leaves that turn unread", async () => {
		await newDot(ctx, "First turn");
		proxy.hold();
		await clickTranscript(A);
		await expect.poll(proxy.reports).toBe(1);
		await newDot(ctx, "Second turn");
		proxy.release();
		await expect
			.poll(() => seenVersion(ctx))
			.toBe(turnEnds(ctx.harness, ctx.sessionId)[0]);
		await expectDot(ctx.windows, ctx.sessionId, true);
		await ctx.report.record(
			"held report lands late",
			ctx.windows,
			ctx.sessionId,
		);
	});

	await test.step("the next touch clears it", async () => {
		await clickTranscript(A);
		await expectDot(ctx.windows, ctx.sessionId, false);
		expect(proxy.reports()).toBe(2);
		await ctx.report.record("next touch", ctx.windows, ctx.sessionId);
	});

	await ctx.report.check(testInfo, "held-report");
	await ctx.windows.B.context().close();
}

async function droppedReport(
	provider: Provider,
	fixtures: Fixtures,
	testInfo: TestInfo,
) {
	const proxy = await proxySockets(fixtures.page);
	const ctx = await openInteraction(provider, fixtures);
	const { A, B } = ctx.windows;

	await test.step("a report lost to a dropped connection is sent on reconnect", async () => {
		await newDot(ctx, "First turn");
		proxy.hold();
		await clickTranscript(A);
		await expect.poll(proxy.reports).toBe(1);
		await proxy.disconnect();
		await expect(dot(B, ctx.sessionId)).toHaveCount(1);
		await proxy.reconnect();
		for (const page of [A, B])
			await expect(dot(page, ctx.sessionId)).toHaveCount(0, {
				timeout: 20_000,
			});
		expect(proxy.reports()).toBe(2);
		await ctx.report.record("sent on reconnect", ctx.windows, ctx.sessionId);
	});

	await test.step("a lost report is dropped if another window cleared the dot", async () => {
		await newDot(ctx, "Second turn");
		proxy.hold();
		await clickTranscript(A);
		await expect.poll(proxy.reports).toBe(3);
		await proxy.disconnect();
		await row(B, ctx.sessionId).click();
		await expect(dot(B, ctx.sessionId)).toHaveCount(0);
		await proxy.reconnect();
		await expect(dot(A, ctx.sessionId)).toHaveCount(0, { timeout: 20_000 });
		// Negative observation window: a stray flush would follow the reconnect's session list.
		await A.waitForTimeout(1_000);
		expect(proxy.reports()).toBe(3);
		await ctx.report.record(
			"dropped after B's pick",
			ctx.windows,
			ctx.sessionId,
		);
	});

	await ctx.report.check(testInfo, "dropped-report");
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
		test.use({ recording: "chat-multi-turn" });

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

		test("a marked-unread dot holds against touches until A switches away and back", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await markUnreadHolds(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("a report that lands late leaves the next turn end unread", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await heldReport(
				"opencode",
				{ page, browser, relayUrl, harness },
				testInfo,
			);
		});

		test("a report lost to a dropped connection is sent on reconnect if still unread", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			await droppedReport(
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
		// Counts group by root conversation: the sidebar lists roots only, so a
		// fork's unread turn end lifts its root's row, and a root and fork both
		// unread still count once. The root is seeded from the mock's stream so
		// it is an OpenCode row: this lane's initial session is recorded as
		// Claude, and a Claude fork copies the SDK transcript on disk, which a
		// replay does not have.
		test("a root with an unread fork counts once", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			const rootId = "ses_e2e_root";
			const forkId = "ses_e2e_fork";
			const now = Date.now();
			harness.mock.setExactResponse("POST", `/session/${rootId}/fork`, 200, {
				id: forkId,
				projectID: "e2e",
				directory: process.cwd(),
				title: "Fork",
				version: "1",
				time: { created: now, updated: now },
			});
			const report = new Report("opencode", harness);
			const { windows } = await openWindows(page, browser, relayUrl);
			const expectUnreadCount = async (count: number) => {
				for (const window of [windows.A, windows.B])
					await expect(unreadCount(window)).toHaveText(String(count));
			};

			await test.step("a seen root counts zero", async () => {
				// A session's first streamed event seeds its row.
				await endTurn("opencode", windows, harness, rootId, "First turn");
				await expectDot(windows, rootId, true);
				await row(windows.B, rootId).click();
				await expectDot(windows, rootId, false);
				await expectUnreadCount(0);
				await report.record("root seen", windows, rootId);
			});

			await test.step("a fork's turn end lifts its seen root", async () => {
				await new SidebarPage(windows.A).openContextMenu(rootId);
				await windows.A.getByTestId("session-ctx-fork").click();
				await expect
					.poll(
						() =>
							query<{ id: string }>(
								harness,
								"SELECT id FROM sessions WHERE id = ? AND parent_id = ? AND (fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL)",
								forkId,
								rootId,
							).length,
					)
					.toBe(1);
				await endTurn("opencode", windows, harness, forkId, "Fork turn");
				await expectDot(windows, rootId, true);
				await expectUnreadCount(1);
				await report.record("fork unread", windows, rootId);
				await report.record("fork unread", windows, forkId);
			});

			await test.step("root and fork both unread count once", async () => {
				// The recording has two turns and both are spent, so the root goes
				// unread again by hand.
				await new SidebarPage(windows.A).openContextMenu(rootId);
				await windows.A.getByTestId("session-ctx-mark-unread").click();
				await expect
					.poll(
						() =>
							query<{ unread: number }>(
								harness,
								"SELECT unread FROM sessions WHERE id = ?",
								rootId,
							)[0]?.unread,
					)
					.toBe(1);
				await expectDot(windows, rootId, true);
				await expectUnreadCount(1);
				await report.record("both unread", windows, rootId);
				await report.record("both unread", windows, forkId);
			});

			await report.check(testInfo, "fork");
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

			test("a marked-unread dot holds against touches until A switches away and back", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await markUnreadHolds(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});
		});

		test.describe("failing toward unread", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				},
			});

			test("a report that lands late leaves the next turn end unread", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await heldReport(
					"claude",
					{ page, browser, relayUrl, harness },
					testInfo,
				);
			});

			test("a report lost to a dropped connection is sent on reconnect if still unread", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				await droppedReport(
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
