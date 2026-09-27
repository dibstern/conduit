// ─── Session unread: the turn-end dot across windows ─────────────────────────
// A session shows a dot when a turn ends, in every window, until the user
// picks it in the sidebar (click or keyboard). Reload, reconnect and a relay
// restart keep the dot; a sub-agent never gets one.
// Spec: docs/adr/0004-session-mutations-are-canonical-events.md (Scope) and
// conduit-test-hk9m.3.
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
	async check(testInfo: TestInfo, name: "lifecycle" | "sub-agent" | "fork") {
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
