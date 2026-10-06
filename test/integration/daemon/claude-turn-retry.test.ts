import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

// C1: a provider retry is transient status on the session's shell row. It
// shows its reason while the provider waits, clears once the turn moves on,
// is never appended to the event log, and so is gone after a reload.
// Failure cases: the retry is persisted, rendered as a transcript error, never
// reaches the row, or outlives the retry.
describe("a Claude API retry through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async () => {
		const fixture = harness;
		harness = undefined;
		if (!fixture) return;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ni8-34-claude-retry.json",
				JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
			);
		}
	});

	it("shows the retry on the shell row, then clears it without appending it", async () => {
		const fixture = ProcessHarness.create({
			claudeReplay: { turns: ["api-retry-pong-turn"], delayMs: 250 },
		});
		harness = fixture;
		evidence = { ticket: "conduit-test-ni8.34", at: new Date().toISOString() };
		await fixture.restart();
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Retrying turn");
		evidence["sessionId"] = sessionId;
		const cursor = browser.frames.length;
		const reply = await browser.send(sessionId, "Reply with pong.");
		evidence["reply"] = reply;
		expect(reply.done["code"]).toBe(0);
		expect(reply.chunks.join("")).toBe("pong");

		const isRow = (message: Record<string, unknown>) =>
			message["type"] === "session_row" && message["id"] === sessionId;
		const retryingAt = browser.frames.findIndex(
			({ message }, index) =>
				index >= cursor &&
				isRow(message) &&
				typeof message["retrying"] === "string",
		);
		evidence["retrying"] = browser.frames[retryingAt]?.message;
		expect(retryingAt).toBeGreaterThanOrEqual(cursor);
		expect(String(browser.frames[retryingAt]?.message["retrying"])).toMatch(
			/attempt 1\/10.*HTTP 529.*overloaded.*next in 1\.2s/,
		);
		await browser.waitFor(
			(message) =>
				isRow(message) &&
				message["retrying"] === undefined &&
				message["status"] === "idle",
			retryingAt + 1,
		);

		const history = await browser.history(sessionId);
		evidence["history"] = history;
		expect(
			history.flatMap(({ parts }) => parts ?? []).map(({ type }) => type),
		).not.toContain("error");

		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const retries = db
				.prepare(
					"SELECT count(*) AS n FROM events WHERE session_id = ? AND type = 'session.status' AND json_extract(data, '$.status') = 'retry'",
				)
				.get(sessionId) as { n: number };
			expect(retries.n).toBe(0);
		} finally {
			db.close();
		}

		const reloaded = await fixture.connect();
		await reloaded.followSessions();
		const snapshotRow = reloaded.frames
			.map(({ message }) => message)
			.find(isRow);
		expect(snapshotRow).toBeDefined();
		expect(snapshotRow).not.toHaveProperty("retrying");
	}, 60_000);
});
