import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { CanonicalEvent } from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: a count follows a page/cursor, a hidden root suppresses the
// shelf, pinned/child/deleted sessions leak into it, a foreign-project refresh
// leaves it stale, live local changes drift from the full shell snapshot, or
// searched local totals disagree with SQLite's ASCII-only case folding.
const settledPerProject = 130;

const seedShelf = (filename: string, projectId: string, prefix: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const events: CanonicalEvent[] = [];
			const createdAt = Date.now() - 60_000;
			for (let index = 0; index < settledPerProject + 30; index++) {
				const settled = index < settledPerProject;
				const sessionId = `${prefix}-${settled ? "settled" : "active"}-${settled ? index : index - settledPerProject}`;
				events.push(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title:
								index === 0
									? `Archive ${prefix} %_done\\now`
									: index === 1
										? `Archive ${prefix} Ö work`
										: `${settled ? "Archive" : "Current"} ${prefix} ${index}`,
							provider: "claude",
						},
						{ provider: "claude", createdAt: createdAt + index },
					),
				);
				if (settled)
					events.push(
						canonicalEvent(
							"session.settled",
							sessionId,
							{ sessionId },
							{ createdAt: createdAt + index },
						),
					);
			}
			const childId = `${prefix}-child`;
			const pinnedId = `${prefix}-pinned`;
			for (const [sessionId, parentId] of [
				[childId, `${prefix}-settled-0`],
				[pinnedId, undefined],
			] as const) {
				events.push(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Outside the settled shelf",
							provider: "claude",
							...(parentId === undefined ? {} : { parentId }),
						},
						{ provider: "claude", createdAt },
					),
					canonicalEvent(
						"session.settled",
						sessionId,
						{ sessionId },
						{ createdAt },
					),
				);
			}
			events.push(
				canonicalEvent(
					"session.pinned",
					pinnedId,
					{ sessionId: pinnedId },
					{ createdAt },
				),
			);
			yield* commit(events, { publish: false });
		}).pipe(Effect.provide(makePersistenceEffectLayer(filename, projectId))),
	);

test("settled shelf shows full scoped totals across pages and live session changes", async ({
	harness,
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	const shelf = page.getByTestId("settled-shelf-toggle");
	const shelfGeometry = (shelf: Element) => {
		const scroller = shelf.closest<HTMLElement>("#session-list-scroller");
		if (!scroller) throw new Error("Missing session scroller");
		const rows = Array.from(
			scroller.querySelectorAll(".session-item[data-session-id]"),
		);
		const header = shelf.getBoundingClientRect();
		const viewport = scroller.getBoundingClientRect();
		return {
			rows: rows.length,
			precedingRows: rows.filter(
				(row) =>
					row.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING,
			).length,
			scrollTop: scroller.scrollTop,
			header: { top: header.top, bottom: header.bottom },
			viewport: { top: viewport.top, bottom: viewport.bottom },
			focused: document.activeElement === shelf,
		};
	};
	const evidence: {
		passed: boolean;
		page?: unknown;
		search?: unknown;
		steps: { action: string; count: number; text: string | null }[];
		pagination: {
			queued: number;
			before?: ReturnType<typeof shelfGeometry>;
			after?: ReturnType<typeof shelfGeometry>;
			collectionError?: string;
		};
	} = { passed: false, steps: [], pagination: { queued: 0 } };
	try {
		const setup = await harness.connect(undefined, undefined, undefined, false);
		const foreignFolder = join(harness.root, "shelf-project");
		mkdirSync(foreignFolder);
		const { savedSlug } = await Effect.runPromise(
			setup.rpc.SaveProject({
				title: "Shelf project",
				folders: [foreignFolder],
			}),
		);
		if (!savedSlug)
			throw new Error("SaveProject omitted the shelf project's slug");
		await harness.terminate();
		await seedShelf(harness.daemonStorePath(), "process-test", "local");
		await seedShelf(harness.daemonStorePath(), savedSlug, "foreign");
		await harness.restart({ keepPort: true });
		const control = await harness.connect(
			undefined,
			undefined,
			undefined,
			false,
		);
		const first = await Effect.runPromise(
			control.rpc.ListDaemonSessions({
				projectSlug: "process-test",
				scope: savedSlug,
				roots: true,
				limit: 20,
			}),
		);
		expect(first.sessions).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		expect(first.sessions.every((session) => session.settledAt == null)).toBe(
			true,
		);
		expect(first.settledCounts).toEqual([
			{ projectSlug: savedSlug, count: settledPerProject },
		]);
		evidence.page = {
			rows: first.sessions.length,
			settledRows: 0,
			hasMore: first.hasMore,
			counts: first.settledCounts,
		};
		const next = await Effect.runPromise(
			control.rpc.ListDaemonSessions({
				projectSlug: "process-test",
				scope: savedSlug,
				roots: true,
				limit: 20,
				...(first.nextCursor ? { cursor: first.nextCursor } : {}),
			}),
		);
		expect(next.settledCounts).toEqual(first.settledCounts);
		const search = await Effect.runPromise(
			control.rpc.ListDaemonSessions({
				projectSlug: "process-test",
				scope: savedSlug,
				roots: true,
				search: "%_done\\",
				limit: 1,
			}),
		);
		expect(search.sessions.map(({ id }) => id)).toEqual(["foreign-settled-0"]);
		expect(search.settledCounts).toEqual([
			{ projectSlug: savedSlug, count: 1 },
		]);
		evidence.search = {
			ids: search.sessions.map(({ id }) => id),
			counts: search.settledCounts,
		};

		await page.addInitScript(() => {
			const NativeObserver = window.IntersectionObserver;
			const delivery: { held: boolean; queued: (() => void)[] } = {
				held: false,
				queued: [],
			};
			window.IntersectionObserver = class extends NativeObserver {
				constructor(
					callback: IntersectionObserverCallback,
					options?: IntersectionObserverInit,
				) {
					super((entries, observer) => {
						if (
							delivery.held &&
							entries.some(
								(entry) =>
									entry.target.id === "session-list-sentinel" &&
									entry.isIntersecting,
							)
						) {
							delivery.queued.push(() => callback(entries, observer));
							return;
						}
						callback(entries, observer);
					}, options);
				}
			};
			Object.assign(window, { __settledShelfPagination: delivery });
		});
		await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
		const observe = async (action: string, count: number) => {
			await expect(shelf).toHaveText(
				new RegExp(`^\\s*Settled\\s*${count}\\s*$`),
			);
			evidence.steps.push({ action, count, text: await shelf.textContent() });
		};
		await observe("project scope counts only its own shelf", settledPerProject);
		await page.getByRole("button", { name: "Clear project scope" }).click();
		await expect(page.getByTestId("session-scope-chip")).toHaveText(
			"All projects",
		);
		await observe("initial full count", settledPerProject * 2);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "local-settled-0",
				settled: false,
			}),
		);
		await observe("unsettle local", 259);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "local-settled-0",
				settled: true,
			}),
		);
		await observe("settle local", 260);
		await Effect.runPromise(
			control.rpc.SetSessionPinned({
				sessionId: "local-settled-1",
				pinned: true,
			}),
		);
		await observe("pin brings local session back", 259);
		await Effect.runPromise(
			control.rpc.SetSessionPinned({
				sessionId: "local-settled-1",
				pinned: false,
			}),
		);
		await observe("unpin keeps session active", 259);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "local-settled-1",
				settled: true,
			}),
		);
		await observe("settle unpinned session", 260);
		await Effect.runPromise(
			control.rpc.DeleteSession({ sessionId: "local-settled-2" }),
		);
		await observe("delete local settled session", 259);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "local-active-0",
				settled: true,
			}),
		);
		await observe("settle active local session", 260);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "foreign-settled-1",
				settled: false,
			}),
		);
		await observe("foreign revision updates the count without navigation", 259);
		await Effect.runPromise(
			control.rpc.SetSessionSettled({
				sessionId: "foreign-settled-1",
				settled: true,
			}),
		);
		await observe(
			"foreign revision restores the count without navigation",
			260,
		);
		const searchInput = page.getByRole("textbox", { name: "Search sessions" });
		await searchInput.fill("ö");
		await expect(page.getByTestId("session-search-summary")).toHaveText(
			/0 matches/,
		);
		await expect(shelf).toBeHidden();
		evidence.steps.push({
			action: "non-ASCII case mismatch has no shelf",
			count: 0,
			text: null,
		});
		await searchInput.fill("Ö WORK");
		await observe("server case matching counts local and foreign roots", 2);
		await searchInput.fill("Archive foreign %_done\\now");
		await observe(
			"search finds a foreign settled root beyond the initial page",
			1,
		);
		const foreignRow = page.locator('[data-session-id="foreign-settled-0"]');
		await foreignRow.click({ button: "right" });
		await page.getByRole("menuitem", { name: /^Un-settle/ }).click();
		await expect(shelf).toBeHidden();
		evidence.steps.push({
			action: "unsettle foreign session from its menu",
			count: 0,
			text: null,
		});
		const delivery = await page.evaluateHandle(
			() =>
				(
					window as unknown as {
						__settledShelfPagination: {
							held: boolean;
							queued: (() => void)[];
						};
					}
				).__settledShelfPagination,
		);
		// Hold only the final search-clear's real intersecting sentinel delivery.
		await delivery.evaluate((state) => {
			state.held = true;
		});
		await searchInput.press("Escape");
		await observe(
			"clear search after the foreign command refreshes totals",
			259,
		);
		// The second Escape puts away the scope suggestions the empty field raised.
		await searchInput.press("Escape");
		await shelf.click();
		// "More" pages from the true total, not from the rows loaded so far.
		const more = page.getByTestId("settled-shelf-more");
		await expect(more).toHaveText("257 more");
		await more.scrollIntoViewIfNeeded();
		await expect(shelf).toBeInViewport();
		await expect(shelf).toBeFocused();
		await expect
			.poll(() => delivery.evaluate((state) => state.queued.length))
			.toBeGreaterThan(0);
		evidence.pagination.queued = await delivery.evaluate(
			(state) => state.queued.length,
		);
		const before = await shelf.evaluate(shelfGeometry);
		evidence.pagination.before = before;
		await delivery.evaluate((state) => {
			state.held = false;
			for (const deliver of state.queued.splice(0)) deliver();
		});
		await expect
			.poll(async () => {
				const after = await shelf.evaluate(shelfGeometry);
				return (
					after.rows > before.rows && after.precedingRows > before.precedingRows
				);
			})
			.toBe(true);
		await expect(shelf).toBeInViewport();
		await expect(shelf).toBeFocused();
		await page.screenshot({ path: testInfo.outputPath("settled-count.png") });
		await testInfo.attach("settled-count-screenshot", {
			path: testInfo.outputPath("settled-count.png"),
			contentType: "image/png",
		});
		evidence.passed = true;
	} finally {
		try {
			evidence.pagination.after = await shelf.evaluate(shelfGeometry);
		} catch (error: unknown) {
			evidence.pagination.collectionError = String(error);
		}
		const artifact = testInfo.outputPath("settled-count.json");
		writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
		await testInfo.attach("settled-count", {
			path: artifact,
			contentType: "application/json",
		});
	}
});
