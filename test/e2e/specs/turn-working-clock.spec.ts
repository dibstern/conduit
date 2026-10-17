// The turn head owns the working clock. It keeps counting across a page reload,
// settles on what it last showed, and retains that time after a restart.
// Time the agent spends blocked on the user (a permission prompt) is not work,
// and the clock stops for good when the turn really ends.

import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

interface Clocks {
	activity: string | null;
}

const readClocks = (page: Page): Promise<Clocks> =>
	page.evaluate(() => {
		const panels = document.querySelectorAll(".turn-activity");
		const activity = panels[panels.length - 1]
			?.querySelector(".turn-duration")
			?.textContent?.trim();
		return { activity: activity ?? null };
	});

/** The duration may be a live label or part of a settled Worked head. */
const workedSeconds = (text: string): number => {
	const match = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s/.exec(text);
	if (!match) throw new Error(`No duration in "${text}"`);
	return (
		Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3])
	);
};

const clockSeconds = workedSeconds;
const CLOCK = /^(?:\d+h\s*)?(?:\d+m\s*)?\d+s$/;

/** Sample the live clock across ticks and prove the composer stays header-free. */
async function sampleLiveClock(page: Page, samples: number) {
	const readings: Clocks[] = [];
	for (let i = 0; i < samples; i++) {
		await expect
			.poll(
				async () => {
					const clocks = await readClocks(page);
					return clocks.activity !== null;
				},
				{ timeout: 45_000 },
			)
			.toBe(true);
		const clocks = await readClocks(page);
		readings.push(clocks);
		expect(clocks.activity).toMatch(CLOCK);
		await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
		await page.waitForTimeout(700);
	}
	return readings;
}

/** The live head shows from the send, but a turn stopped before its first step
 *  keeps no head. Wait for a step so Stop leaves a Worked head to settle. */
const expectLoggedStep = (page: Page) =>
	expect(
		page
			.locator(".turn-activity")
			.last()
			.getByRole("slider", { name: /^Activity timeline — [1-9]/ }),
	).toBeVisible({ timeout: 45_000 });

test.describe("Turn working clock", () => {
	test.use({
		claudeReplay: { turns: ["extra-folder-read-turn"], delayMs: 1_000 },
	});
	test.describe.configure({ timeout: 90_000 });

	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Claude replay chat tests run on desktop viewport only",
		);
	});

	test("the live turn clock keeps its time through a reload", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		await page.mouse.move(0, 0);
		await app.sendMessage("Read the extra folder");

		const beforeReload = await sampleLiveClock(page, 3);
		await page.screenshot({ path: testInfo.outputPath("live-clocks.png") });

		// A reload mid-turn must not restart either clock at 0:00.
		await gotoRelay(page, page.url());
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await page.mouse.move(0, 0);
		const afterReload = await sampleLiveClock(page, 2);
		const lastBefore = clockSeconds(beforeReload.at(-1)?.activity ?? "");
		expect(clockSeconds(afterReload[0]?.activity ?? "")).toBeGreaterThanOrEqual(
			lastBefore,
		);
		await page.screenshot({
			path: testInfo.outputPath("live-clocks-after-reload.png"),
		});

		// Settling keeps what the clock last showed: no snap back.
		await chat.waitForStreamingComplete();
		await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
		const worked = await page
			.locator(".turn-activity")
			.last()
			.locator(".turn-activity-toggle")
			.innerText();
		// \s: the label may join words with a non-breaking space.
		expect(worked).toMatch(/^Worked\s/);
		const lastLive = clockSeconds(afterReload.at(-1)?.activity ?? "");
		expect(workedSeconds(worked)).toBeGreaterThanOrEqual(lastLive);

		writeFileSync(
			testInfo.outputPath("clock-readings.json"),
			JSON.stringify({ beforeReload, afterReload, worked }, null, 2),
		);
	});

	test("the settled working time reads the same after a relay restart", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Read the extra folder");
		await chat.waitForStreamingComplete();
		const header = page
			.locator(".turn-activity")
			.last()
			.locator(".turn-activity-toggle");
		// The Stop button may not have rendered when the wait above ran, so
		// the settled header is what proves the turn ended.
		await expect(header).toContainText("Worked", { timeout: 60_000 });
		const before = workedSeconds(await header.innerText());

		await harness.restart();
		await gotoRelay(page, relayUrl);
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await expect(header).toContainText("Worked");
		const after = workedSeconds(await header.innerText());
		// Live stamps come from the browser and history stamps from the server,
		// so the floor can tip by one second, never more.
		expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
		await page.screenshot({
			path: testInfo.outputPath("settled-after-restart.png"),
		});
		writeFileSync(
			testInfo.outputPath("settled-readings.json"),
			JSON.stringify({ before, after }, null, 2),
		);
	});

	test("Stop ends the clock for good", async ({ page, relayUrl }, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		const sentAt = Date.now();
		await app.sendMessage("Read the extra folder");
		await sampleLiveClock(page, 2);
		await expectLoggedStep(page);
		await chat.stopBtn.click();
		const stoppedAt = Date.now();
		await chat.waitForStreamingComplete();
		await expect(page.getByTestId("composer-status-header")).toHaveCount(0);

		const header = page
			.locator(".turn-activity")
			.last()
			.locator(".turn-activity-toggle");
		await expect(header).toContainText("Worked");
		const settled = workedSeconds(await header.innerText());
		expect(settled).toBeLessThanOrEqual(
			Math.ceil((stoppedAt - sentAt) / 1000) + 1,
		);
		await page.waitForTimeout(3_000);
		expect(workedSeconds(await header.innerText())).toBe(settled);

		await gotoRelay(page, page.url());
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await expect(header).toContainText("Worked");
		const afterReload = workedSeconds(await header.innerText());
		expect(Math.abs(afterReload - settled)).toBeLessThanOrEqual(1);
		writeFileSync(
			testInfo.outputPath("stopped-readings.json"),
			JSON.stringify({ settled, afterReload }, null, 2),
		);
	});

	test.describe("a prompt queued behind a running one", () => {
		test.use({
			claudeReplay: {
				// Distinct traces: a replay keeps tool ids, and a repeat would merge.
				turns: ["extra-folder-read-turn", "skill-loads-turn"],
				delayMs: 1_000,
			},
		});
		test.describe.configure({ timeout: 120_000 });

		test("waiting in the queue is not work, and Stop ends the queued prompt", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			await page.mouse.move(0, 0);
			const sentA = Date.now();
			await app.sendMessage("Read the extra folder");
			await sampleLiveClock(page, 1);
			const sentB = Date.now();
			await app.sendMessage("Load the skill");

			// B waits in the tray and starts when A finishes; the turn head then times B.
			const liveClock = async () =>
				clockSeconds((await readClocks(page)).activity ?? "0s");
			let lastA = await liveClock();
			await expect
				.poll(
					async () => {
						const now = await liveClock();
						const dropped = now < lastA;
						lastA = Math.max(lastA, now);
						return dropped;
					},
					{ timeout: 45_000, intervals: [250] },
				)
				.toBe(true);
			const takeover = Date.now();
			const firstB = await liveClock();
			// Timed from its send, B would already read the time it sat queued.
			const queuedSeconds = (takeover - sentB) / 1000;
			expect(queuedSeconds).toBeGreaterThan(4);
			expect(firstB).toBeLessThanOrEqual(queuedSeconds - 3);

			// Stop during B, once it has logged a step.
			await expect(page.locator(".turn-activity")).toHaveCount(2, {
				timeout: 45_000,
			});
			await expectLoggedStep(page);
			await chat.stopBtn.click();
			const stoppedAt = Date.now();
			await chat.waitForStreamingComplete();
			await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
			await page.screenshot({
				path: testInfo.outputPath("queued-stopped.png"),
			});

			const headers = page.locator(".turn-activity .turn-activity-toggle");
			const worked = async () =>
				(await headers.allInnerTexts()).map(workedSeconds);
			await expect(headers.last()).toContainText("Worked");
			await expect(headers.first()).toContainText("Worked");
			const [workedA = -1, workedB = -1] = await worked();
			expect(workedA).toBeLessThanOrEqual(
				Math.ceil((takeover - sentA) / 1000) + 1,
			);
			expect(workedB).toBeLessThanOrEqual(
				Math.ceil((stoppedAt - takeover) / 1000) + 2,
			);
			await page.waitForTimeout(3_000);
			expect(await worked()).toEqual([workedA, workedB]);

			// History agrees: both turns settled, and the running one is the
			// prompt the live head times from.
			await gotoRelay(page, page.url());
			await expect(page.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
			await expect(headers.last()).toContainText("Worked");
			await expect(page.getByText("no prompt to time from")).toHaveCount(0);
			await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
			const afterReload = await worked();
			expect(Math.abs((afterReload[0] ?? -9) - workedA)).toBeLessThanOrEqual(1);
			expect(Math.abs((afterReload[1] ?? -9) - workedB)).toBeLessThanOrEqual(1);
			writeFileSync(
				testInfo.outputPath("queued-readings.json"),
				JSON.stringify(
					{ queuedSeconds, firstB, workedA, workedB, afterReload },
					null,
					2,
				),
			);
		});
	});

	test.describe("Stop while a prompt waits in the queue", () => {
		test.use({
			claudeReplay: {
				// Stop pauses the queue and the queued prompt is removed unsent,
				// so only A and C play.
				turns: ["extra-folder-read-turn", "skill-loads-turn"],
				delayMs: 1_000,
			},
		});
		test.describe.configure({ timeout: 120_000 });

		test("the next prompt still ends idle, even reloaded the moment it finishes", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const idle = async (label: string) => {
				await expect(chat.stopBtn).toBeHidden();
				await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
				await expect(page.getByTestId("pending-input-row")).toHaveCount(0);
				await page.screenshot({ path: testInfo.outputPath(`${label}.png`) });
			};
			await app.goto(relayUrl);
			await app.sendMessage("Read the extra folder");
			await expect(page.getByTestId("turn-live-elapsed")).toBeVisible({
				timeout: 30_000,
			});
			await app.sendMessage("Queued prompt");
			await expect(page.getByTestId("pending-input-row")).toHaveCount(1);
			await chat.stopBtn.click();
			await chat.waitForStreamingComplete();
			await expect(page.getByTestId("pending-input-paused")).toBeVisible();
			await page.getByTestId("pending-input-remove").click();
			await idle("stopped");

			await app.sendMessage("Load the skill");
			await expect(page.locator(".turn-activity")).toHaveCount(1, {
				timeout: 30_000,
			});
			await expect(page.getByText("notes ready").last()).toBeVisible({
				timeout: 60_000,
			});
			await chat.waitForStreamingComplete();
			const finishedAt = Date.now();
			// Claude stores idle a moment after the turn's done. A client that
			// connects in between must still end up idle.
			await gotoRelay(page, page.url());
			await expect(page.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
			const reloadedAfterMs = Date.now() - finishedAt;
			await idle("reloaded");
			writeFileSync(
				testInfo.outputPath("stop-queued-readings.json"),
				JSON.stringify({ reloadedAfterMs }, null, 2),
			);
		});
		test("Stop stays on through the whole of the next prompt", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			await app.sendMessage("Read the extra folder");
			await expect(page.getByTestId("turn-live-elapsed")).toBeVisible({
				timeout: 30_000,
			});
			await app.sendMessage("Queued prompt");
			await chat.stopBtn.click();
			await chat.waitForStreamingComplete();

			// Sample every 50ms in the page, from the moment Stop first shows, so
			// a blink of a few frames is caught.
			await page.evaluate(() => {
				const w = window as unknown as { stopGaps: number[] };
				w.stopGaps = [];
				let start: number | undefined;
				const timer = setInterval(() => {
					if (document.body.innerText.includes("notes ready"))
						return clearInterval(timer);
					const stopShown = Boolean(document.querySelector("#stop"));
					if (start === undefined) {
						if (stopShown) start = performance.now();
					} else if (!stopShown) {
						w.stopGaps.push(Math.round(performance.now() - start));
					}
				}, 50);
			});
			await app.sendMessage("Load the skill");
			await expect(page.getByText("notes ready").last()).toBeVisible({
				timeout: 60_000,
			});
			const stopGaps = await page.evaluate(
				() => (window as unknown as { stopGaps: number[] }).stopGaps,
			);
			writeFileSync(
				testInfo.outputPath("stop-gaps.json"),
				JSON.stringify({ stopGaps }, null, 2),
			);
			expect(stopGaps).toEqual([]);
		});
	});

	test.describe("waiting on the user", () => {
		test.use({
			claudeReplay: {
				turns: ["extra-folder-read-turn"],
				delayMs: 1_000,
				askPermissionFor: "Read",
			},
		});

		test("an open permission prompt pauses the clock, through a reload", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			const sentAt = Date.now();
			await app.sendMessage("Read the extra folder");

			const allow = page
				.locator(".permission-card")
				.getByRole("button", { name: "Allow", exact: true });
			await expect(allow).toBeVisible({ timeout: 45_000 });
			const liveClock = async () => (await readClocks(page)).activity ?? "";
			await expect.poll(liveClock, { timeout: 5_000 }).toMatch(CLOCK);
			const waitStartedAt = Date.now();
			const paused = await liveClock();
			await page.waitForTimeout(3_000);
			expect(await liveClock()).toBe(paused);

			// The open wait comes from the server, so a reload stays paused.
			await gotoRelay(page, page.url());
			await expect(page.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
			await expect(allow).toBeVisible({ timeout: 30_000 });
			await expect.poll(liveClock, { timeout: 5_000 }).toBe(paused);
			await page.waitForTimeout(1_500);
			expect(await liveClock()).toBe(paused);
			await page.screenshot({ path: testInfo.outputPath("paused-clock.png") });

			await allow.click();
			const waitedMs = Date.now() - waitStartedAt;
			await expect
				.poll(async () => clockSeconds(await liveClock()), { timeout: 10_000 })
				.toBeGreaterThan(clockSeconds(paused));

			await chat.waitForStreamingComplete();
			const wallSeconds = (Date.now() - sentAt) / 1000;
			const worked = await page
				.locator(".turn-activity")
				.last()
				.locator(".turn-activity-toggle")
				.innerText();
			// The wait is left out: work is at most wall time minus the wait.
			expect(workedSeconds(worked)).toBeLessThanOrEqual(
				Math.ceil(wallSeconds - waitedMs / 1000) + 1,
			);
			expect(workedSeconds(worked)).toBeGreaterThanOrEqual(
				clockSeconds(paused),
			);
			writeFileSync(
				testInfo.outputPath("paused-readings.json"),
				JSON.stringify({ paused, waitedMs, wallSeconds, worked }, null, 2),
			);
		});
	});
});
