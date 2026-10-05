// The composer's "Working" clock and the turn activity panel's live header are
// two views of one number: how long the model has worked on this prompt. They
// must read the same at every tick, keep counting across a page reload, settle
// on what they last showed, and read the same settled time after a restart.
// Time the agent spends blocked on the user (a permission prompt) is not work,
// and the clock stops for good when the turn really ends.

import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

interface Clocks {
	composer: string | null;
	activity: string | null;
}

// One evaluate, so both readings come from the same rendered frame.
const readClocks = (page: Page): Promise<Clocks> =>
	page.evaluate(() => {
		const composer = document
			.querySelector('[data-testid="composer-status-elapsed"]')
			?.textContent?.trim()
			.replace(/^Working\s*/, "");
		const panels = document.querySelectorAll(".turn-activity");
		const activity = panels[panels.length - 1]
			?.querySelector(".turn-duration")
			?.textContent?.trim();
		return { composer: composer ?? null, activity: activity ?? null };
	});

/** `1:05` or `1:01:05` to seconds. */
const clockSeconds = (text: string): number =>
	text.split(":").reduce((total, part) => total * 60 + Number(part), 0);

/** `Worked for 1m 5s` or `Worked for 12s` to seconds. */
const workedSeconds = (text: string): number => {
	const match = /(?:(\d+)m\s*)?(\d+)s/.exec(text);
	if (!match) throw new Error(`No duration in "${text}"`);
	return Number(match[1] ?? 0) * 60 + Number(match[2]);
};

const CLOCK = /^\d+:\d{2}(?::\d{2})?$/;

/** Both clocks visible, in clock format, and equal: sampled across ticks. */
async function expectMatchingClocks(page: Page, samples: number) {
	const readings: Clocks[] = [];
	for (let i = 0; i < samples; i++) {
		await expect
			.poll(
				async () => {
					const clocks = await readClocks(page);
					return clocks.composer !== null && clocks.activity !== null;
				},
				// The panel appears with the first tool, a dozen replay gaps in.
				{ timeout: 45_000 },
			)
			.toBe(true);
		const clocks = await readClocks(page);
		readings.push(clocks);
		expect(clocks.composer).toMatch(CLOCK);
		expect(clocks.activity).toBe(clocks.composer);
		await page.waitForTimeout(700);
	}
	return readings;
}

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

	test("the composer and the activity panel tick together through a reload", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		await page.mouse.move(0, 0);
		await app.sendMessage("Read the extra folder");

		const beforeReload = await expectMatchingClocks(page, 3);
		await page.screenshot({ path: testInfo.outputPath("live-clocks.png") });

		// A reload mid-turn must not restart either clock at 0:00.
		await gotoRelay(page, page.url());
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await page.mouse.move(0, 0);
		const afterReload = await expectMatchingClocks(page, 2);
		const lastBefore = clockSeconds(beforeReload.at(-1)?.composer ?? "");
		expect(clockSeconds(afterReload[0]?.composer ?? "")).toBeGreaterThanOrEqual(
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
		expect(worked).toMatch(/^Worked\sfor\s/);
		const lastLive = clockSeconds(afterReload.at(-1)?.composer ?? "");
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
		await expect(header).toContainText("Worked for");
		const before = workedSeconds(await header.innerText());

		await harness.restart();
		await gotoRelay(page, relayUrl);
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await expect(header).toContainText("Worked for");
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
		// Stop once the panel is up, so there is a header to settle.
		await expectMatchingClocks(page, 2);
		await chat.stopBtn.click();
		const stoppedAt = Date.now();
		await chat.waitForStreamingComplete();
		await expect(page.getByTestId("composer-status-header")).toHaveCount(0);

		const header = page
			.locator(".turn-activity")
			.last()
			.locator(".turn-activity-toggle");
		await expect(header).toContainText("Worked for");
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
		await expect(header).toContainText("Worked for");
		const afterReload = workedSeconds(await header.innerText());
		expect(Math.abs(afterReload - settled)).toBeLessThanOrEqual(1);
		writeFileSync(
			testInfo.outputPath("stopped-readings.json"),
			JSON.stringify({ settled, afterReload }, null, 2),
		);
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
			const composer = async () => (await readClocks(page)).composer ?? "";
			await expect.poll(composer, { timeout: 5_000 }).toMatch(CLOCK);
			const waitStartedAt = Date.now();
			const paused = await composer();
			await page.waitForTimeout(3_000);
			expect(await composer()).toBe(paused);

			// The open wait comes from the server, so a reload stays paused.
			await gotoRelay(page, page.url());
			await expect(page.locator("#connect-overlay")).toBeHidden({
				timeout: 30_000,
			});
			await expect(allow).toBeVisible({ timeout: 30_000 });
			await expect.poll(composer, { timeout: 5_000 }).toBe(paused);
			await page.waitForTimeout(1_500);
			expect(await composer()).toBe(paused);
			await page.screenshot({ path: testInfo.outputPath("paused-clock.png") });

			await allow.click();
			const waitedMs = Date.now() - waitStartedAt;
			await expect
				.poll(async () => clockSeconds(await composer()), { timeout: 10_000 })
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
