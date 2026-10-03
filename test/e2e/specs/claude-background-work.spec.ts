// A Claude session whose turn has ended while a backgrounded shell still runs
// reads as monitoring in the sidebar until the shell ends, and lists the shell
// in the session header's tasks row (with a dot on the composer), whose "Stop
// all" ends the whole session. Bug: it read as done, because the shell's
// liveness lives in memory and nothing re-sent the row.
// Specs: conduit-test-0mmk, conduit-test-nvv6, conduit-test-od8e, conduit-test-va96.1.
//
// Replays a captured trace (no model call): Bash `sleep 8` with
// run_in_background, the turn's result, then the shell ending and the SDK's
// wake-up turn. The replay holds after the result, so "turn over, shell
// alive" is a state the test holds rather than races.
//
// The row is read in a second window with no session open: an open session
// gets its own push, which would mask the sidebar stream this is about. Its
// spoken status at each step is attached as a report, with a screenshot.

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.describe("Claude background work", () => {
	test.use({
		claudeReplay: { turns: ["background-shell-turn"], holdAfterResult: true },
	});

	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"The sidebar is checked on desktop only",
		);
	});

	test("keeps the session monitoring until its background shell ends", async ({
		page,
		browser,
		relayUrl,
		harness,
	}, testInfo) => {
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		// The stored row: its status and how many turns have ended.
		const stored = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const row = db
					.prepare(
						"SELECT status, (SELECT COUNT(*) FROM events WHERE session_id = s.id AND type = 'turn.completed') AS turnEnds FROM sessions s WHERE id = ?",
					)
					.get(sessionId);
				return { status: row?.["status"], turnEnds: Number(row?.["turnEnds"]) };
			} finally {
				db.close();
			}
		};
		const report: {
			step: string;
			label: string | null;
			stored: ReturnType<typeof stored>;
		}[] = [];
		const record = async (step: string) => {
			report.push({
				step,
				label: await row.getAttribute("aria-label"),
				stored: stored(),
			});
			const path = testInfo.outputPath(`${step}.png`);
			await sidebar.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
		};

		const sidebar = await (
			await browser.newContext({ viewport: page.viewportSize() })
		).newPage();
		const row = sidebar.locator(
			`#session-list [data-session-id="${sessionId}"]`,
		);

		try {
			const app = new AppPage(page);
			await app.goto(relayUrl);
			await gotoRelay(sidebar, `${harness.relayBaseUrl}/p/e2e-replay/`);
			await expect(row).not.toHaveClass(/(?:^|\s)active(?:\s|$)/);
			await app.sendMessage("Run sleep 8 in the background");

			// The idle status is written just after the turn end, not with it.
			// Wait for both, or the row is read while still busy from the turn.
			await expect.poll(stored).toEqual({ status: "idle", turnEnds: 1 });
			// The sidebar stream is ordered, so once the second window shows a
			// rename made after that, it has had the idle status too.
			await page.getByTestId("session-bar-title-menu").click();
			await page.getByTestId("session-ctx-rename").click();
			const name = page.getByRole("textbox", { name: "Session name" });
			await name.fill("Background shell");
			await name.press("Enter");
			await expect(row).toHaveAttribute("aria-label", /Background shell/);
			await expect(
				row,
				"the turn ended but the sidebar stopped saying monitoring while its background shell ran",
			).toHaveAttribute("aria-label", /^Monitoring/);
			const tasksRow = page.getByTestId("background-tasks-row");
			const age = tasksRow.getByTestId("background-task-chip-age");
			await expect(tasksRow.getByTestId("background-task-chip")).toContainText(
				"sleep 8",
			);
			await expect(
				page.getByTestId("composer-task-dots").locator("i"),
			).toHaveCount(1);
			// Ages count from when the relay first saw the task, so a reload
			// must not restart them.
			const seconds = async () =>
				Number.parseInt((await age.textContent()) ?? "", 10);
			await expect.poll(seconds).toBeGreaterThanOrEqual(2);
			const before = await seconds();
			await page.reload();
			await expect(age).toBeVisible();
			expect(
				await seconds(),
				"reloading the page restarted the background task's age",
			).toBeGreaterThanOrEqual(before);
			await record("turn-ended-shell-running");
			const composer = testInfo.outputPath("composer-monitoring.png");
			await page.locator("#input-area").screenshot({
				path: composer,
				animations: "disabled",
			});
			await testInfo.attach("composer-monitoring.png", {
				path: composer,
				contentType: "image/png",
			});

			// The shell ending wakes the SDK into a turn of its own. Read the row
			// once that has settled too, not in the gap before it starts.
			harness.claudeReplayer?.release();
			await expect.poll(stored).toEqual({ status: "idle", turnEnds: 2 });
			await expect(
				row,
				"the background shell ended but the sidebar still says working",
			).toHaveAttribute("aria-label", /^Done, unread/);
			await expect(page.getByTestId("background-tasks-row")).toBeHidden();
			await expect(page.getByTestId("composer-task-dots")).toBeHidden();
			await record("shell-ended");
		} finally {
			const path = testInfo.outputPath("background-work-report.json");
			writeFileSync(path, JSON.stringify({ sessionId, report }, null, 2));
			await testInfo.attach("background-work-report.json", {
				path,
				contentType: "application/json",
			});
		}
	});

	test("Stop all in the tasks pull-down ends the session and its background shell", async ({
		page,
		harness,
		relayUrl,
	}, testInfo) => {
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const app = new AppPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Run sleep 8 in the background");

		const tasksRow = page.getByTestId("background-tasks-row");
		const row = page.locator(`#session-list [data-session-id="${sessionId}"]`);
		await expect(tasksRow).toContainText("sleep 8");
		await expect(row).toHaveAttribute("aria-label", /^Monitoring/);

		await tasksRow.click();
		await page.getByTestId("background-tasks-stop-all").click();
		await expect(
			tasksRow,
			"Stop all left the background tasks row up",
		).toBeHidden();
		await expect(
			row,
			"Stop ended the session but the sidebar still says monitoring",
		).not.toHaveAttribute("aria-label", /^Monitoring/);
		const path = testInfo.outputPath("after-stop.png");
		await page.screenshot({ path, animations: "disabled" });
		await testInfo.attach("after-stop.png", { path, contentType: "image/png" });
	});
});
