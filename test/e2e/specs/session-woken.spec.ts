// ─── Woken badge: kept until the session is opened ───────────────────────────
// A snoozed session that wakes, because its time passed or it asked for an
// approval or an answer, shows a Woke badge until the user opens it from the
// sidebar, whether or not it has an unread dot. Hovering over or clicking its
// open view keeps the badge, and so does a reload; a sidebar pick clears it,
// for good. Picking a session that has not woken leaves its snooze alone.
// Spec: conduit-test-hk9m.9.

import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

type Provider = "opencode" | "claude";
type Wake = "time" | "approval" | "question";

const row = (page: Page, sessionId: string) =>
	page.locator(`#session-list [data-session-id="${sessionId}"]`);

const pill = (page: Page, sessionId: string) =>
	row(page, sessionId).getByTestId("session-woke-pill");

function snoozeState(harness: ReplayHarness, sessionId: string) {
	if (!harness.eventsDbPath) throw new Error("harness has no event store");
	const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
	try {
		return db
			.prepare("SELECT snoozed_at, woken_at FROM sessions WHERE id = ?")
			.get(sessionId);
	} finally {
		db.close();
	}
}

async function snooze(page: Page, sessionId: string, until: number | null) {
	await row(page, sessionId).click({ button: "right" });
	await page.getByTestId("session-ctx-snooze").click();
	if (until === null) {
		await page.getByTestId("snooze-option-indefinite").click();
		return;
	}
	await page.getByTestId("snooze-option-pick").click();
	// datetime-local takes the browser's local time.
	const local = await page.evaluate((at) => {
		const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
		return date.toISOString().slice(0, 19);
	}, until);
	await page.getByTestId("snooze-pick-input").fill(local);
	await page.getByTestId("snooze-pick-submit").click();
}

/** Snoozes the open session, wakes it, and returns the badge it should show. */
async function wake(
	provider: Provider,
	reason: Wake,
	page: Page,
	harness: ReplayHarness,
	sessionId: string,
): Promise<string> {
	if (reason === "time") {
		// Real time: the server decides the wake against its own clock.
		await snooze(page, sessionId, Date.now() + 5_000);
		await expect(row(page, sessionId)).toHaveCount(0);
		return "Woke";
	}
	if (provider === "claude") {
		// Sending brings a snoozed session back, so the turn starts first; its
		// replay is slowed so the snooze lands before it asks to run its Agent
		// tool, and then waits for the answer.
		await new AppPage(page).sendMessage("Wake me with an approval");
		await snooze(page, sessionId, null);
		await expect(row(page, sessionId)).toHaveCount(0);
		return "Woke · approval";
	}
	await snooze(page, sessionId, null);
	await expect(row(page, sessionId)).toHaveCount(0);
	if (reason === "approval") {
		harness.mock.emitTestEvent("permission.asked", {
			id: "per_e2e_wake",
			permission: "bash",
			patterns: ["ls -la"],
			always: ["ls *"],
			metadata: {},
			sessionID: sessionId,
		});
	} else {
		harness.mock.emitTestEvent("question.asked", {
			id: "que_e2e_wake",
			sessionID: sessionId,
			questions: [
				{
					question: "Carry on?",
					header: "Carry on",
					options: [{ label: "Yes" }, { label: "No" }],
				},
			],
		});
	}
	return `Woke · ${reason}`;
}

async function wokenUntilOpened(
	provider: Provider,
	reason: Wake,
	{ page, harness }: { page: Page; harness: ReplayHarness },
) {
	let unsnoozes = 0;
	page.on("websocket", (ws) =>
		ws.on("framesent", ({ payload }) => {
			if (typeof payload === "string" && payload.includes("UnsnoozeSession"))
				unsnoozes++;
		}),
	);
	const sessionId = decodeURIComponent(harness.projectUrl.slice("/s/".length));
	await gotoRelay(page, harness.relayBaseUrl + harness.projectUrl);
	await expect(row(page, sessionId)).toBeVisible();
	// Read before it is snoozed: nothing but the wake can show the badge. A
	// pick of a session that has not woken does not touch its snooze.
	await row(page, sessionId).click();
	await expect(
		row(page, sessionId).getByTestId("session-unread-dot"),
	).toHaveCount(0);

	const badge = await wake(provider, reason, page, harness, sessionId);
	await expect(pill(page, sessionId)).toHaveText(badge, { timeout: 20_000 });
	await page.reload();
	await expect(pill(page, sessionId)).toHaveText(badge);

	// Hovering over and clicking the open view keeps it.
	const transcript = page.locator("#messages");
	const box = await transcript.boundingBox();
	if (!box) throw new Error("the transcript is not rendered");
	await page.mouse.move(box.x + 8, box.y + 8);
	await page.waitForTimeout(600);
	await page.mouse.click(box.x + 8, box.y + 8);
	await page.waitForTimeout(600);
	await expect(pill(page, sessionId)).toHaveText(badge);
	expect(unsnoozes).toBe(0);
	expect(snoozeState(harness, sessionId)).toMatchObject({
		snoozed_at: expect.any(Number),
	});

	// Opening it from the sidebar clears it, and it stays cleared.
	await row(page, sessionId).click();
	await expect(pill(page, sessionId)).toHaveCount(0);
	expect(unsnoozes).toBe(1);
	await expect
		.poll(() => snoozeState(harness, sessionId))
		.toEqual({ snoozed_at: null, woken_at: null });
	await page.reload();
	await expect(row(page, sessionId)).toBeVisible();
	await expect(pill(page, sessionId)).toHaveCount(0);
}

test.describe("Woken badge", () => {
	test.describe.configure({ timeout: 60_000 });

	test.describe("OpenCode", () => {
		test.use({ recording: "chat-simple" });

		for (const reason of ["time", "approval", "question"] as const)
			test(`${reason} wake on a read session stays until the session is opened`, async ({
				page,
				harness,
			}) => {
				await wokenUntilOpened("opencode", reason, { page, harness });
			});
	});

	test.describe("Claude", () => {
		test.describe("time", () => {
			test.use({ claudeReplay: { turns: [] } });

			test("time wake on a read session stays until the session is opened", async ({
				page,
				harness,
			}) => {
				await wokenUntilOpened("claude", "time", { page, harness });
			});
		});

		test.describe("approval", () => {
			test.use({
				claudeReplay: {
					turns: ["subagent-task-turn"],
					askPermissionFor: "Agent",
					delayMs: 300,
				},
			});

			test("approval wake on a read session stays until the session is opened", async ({
				page,
				harness,
			}) => {
				await wokenUntilOpened("claude", "approval", { page, harness });
			});
		});
	});
});
