// A Claude subagent's child session carries a persisted status derived from
// its parent's Task tool: busy while the tool runs, idle once it completes or
// the parent turn is interrupted (conduit-test-zbct). Real relay and event
// store; the SDK turn replays a committed Task trace held mid-subagent.

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

function query(dbPath: string, sql: string, ...params: string[]) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

/** The parent's subagent children: forks and side threads also carry parent_id. */
const childStatuses = (dbPath: string, parentId: string) =>
	query(
		dbPath,
		"SELECT id, status FROM sessions WHERE parent_id = ? AND id LIKE 'claude-subagent-%'",
		parentId,
	).map((row) => ({ id: String(row["id"]), status: String(row["status"]) }));

/** The parent's tool events, in order, with the child each one names. */
const toolEvents = (dbPath: string, parentId: string) =>
	query(
		dbPath,
		`SELECT sequence, type, json_extract(data, '$.partId') AS part,
			json_extract(data, '$.metadata.childSessionId') AS child
		 FROM events WHERE session_id = ? AND type LIKE 'tool.%' ORDER BY sequence`,
		parentId,
	).map((row) => ({
		sequence: Number(row["sequence"]),
		type: String(row["type"]),
		part: String(row["part"]),
		child: row["child"] === null ? null : String(row["child"]),
	}));

const countEvents = (dbPath: string, parentId: string, type: string) =>
	Number(
		query(
			dbPath,
			"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = ?",
			parentId,
			type,
		)[0]?.["n"],
	);

test.describe("Claude subagent child status", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});
	test.use({
		claudeReplay: {
			turns: ["subagent-task-turn"],
			holdTurnBeforeToolResult: 1,
		},
	});

	const startHeldSubagent = async (
		page: import("@playwright/test").Page,
		relayUrl: string,
		dbPath: string,
	) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Ask a subagent to summarise package.json");
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		const parentId = new URL(page.url()).pathname.split("/").at(-1);
		if (!parentId) throw new Error("Parent session route is missing");
		// Held before the subagent's first tool result: the Task is running.
		await expect
			.poll(() => childStatuses(dbPath, parentId).map((c) => c.status))
			.toEqual(["busy"]);
		return parentId;
	};

	test("is busy while the Task runs and idle once it completes", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(90_000);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("Claude replay lane is not wired");
		const db = harness.eventsDbPath;
		const parentId = await startHeldSubagent(page, relayUrl, db);
		const whileRunning = childStatuses(db, parentId);

		replayer.release();
		await expect
			.poll(() => countEvents(db, parentId, "turn.completed"))
			.toBe(1);
		await new ChatPage(page).waitForStreamingComplete();
		const [child] = whileRunning;
		const afterCompletion = childStatuses(db, parentId);
		await testInfo.attach("child-status.json", {
			body: JSON.stringify(
				{ whileRunning, afterCompletion, tools: toolEvents(db, parentId) },
				null,
				2,
			),
			contentType: "application/json",
		});
		expect(afterCompletion).toEqual([{ id: child?.id, status: "idle" }]);
	});

	test("settles to idle when the parent turn is interrupted", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(90_000);
		const db = harness.eventsDbPath;
		const parentId = await startHeldSubagent(page, relayUrl, db);
		const whileRunning = childStatuses(db, parentId);

		await new ChatPage(page).stopBtn.click();
		await expect
			.poll(() => countEvents(db, parentId, "turn.interrupted"))
			.toBe(1);
		const afterInterrupt = childStatuses(db, parentId);
		await testInfo.attach("child-status.json", {
			body: JSON.stringify(
				{ whileRunning, afterInterrupt, tools: toolEvents(db, parentId) },
				null,
				2,
			),
			contentType: "application/json",
		});
		expect(afterInterrupt).toEqual([
			{ id: whileRunning[0]?.id, status: "idle" },
		]);
	});
});

// The SDK can end the parent turn in an error while the Task is still open: no
// tool result ever closes it, so the turn end must settle the child.
test.describe("Claude subagent child status on a failed parent turn", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});
	test.use({ claudeReplay: { turns: ["subagent-task-error-turn"] } });

	test("settles to idle when the parent turn errors mid-Task", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(90_000);
		const db = harness.eventsDbPath;
		const app = new AppPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Ask a subagent to summarise package.json");
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		const parentId = new URL(page.url()).pathname.split("/").at(-1);
		if (!parentId) throw new Error("Parent session route is missing");

		await expect.poll(() => countEvents(db, parentId, "turn.error")).toBe(1);
		await new ChatPage(page).waitForStreamingComplete();
		const afterError = childStatuses(db, parentId);
		const tools = toolEvents(db, parentId);
		await testInfo.attach("child-status.json", {
			body: JSON.stringify({ afterError, tools }, null, 2),
			contentType: "application/json",
		});
		// The Task part never completed, and its child once ran.
		expect(tools.some((e) => e.type === "tool.completed")).toBe(false);
		expect(tools.some((e) => e.child === afterError[0]?.id)).toBe(true);
		expect(afterError).toEqual([{ id: afterError[0]?.id, status: "idle" }]);
	});
});
