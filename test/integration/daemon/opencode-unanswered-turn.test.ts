import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function ledger(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const column = (sql: string) =>
			(db.prepare(sql).all(sessionId) as Array<{ value: string }>).map(
				({ value }) => value,
			);
		return {
			queued: column(
				"SELECT input_id AS value FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at",
			),
			sent: column(
				"SELECT json_extract(data, '$.inputId') AS value FROM events WHERE session_id = ? AND type = 'input.sent' ORDER BY sequence",
			),
			turns: column(
				"SELECT state AS value FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
			),
		};
	} finally {
		db.close();
	}
}

// A user message OpenCode never answers (sent from another client, or failed
// before any reply) used to leave its turn pending, so the inbox held every
// later queued input forever. Failure cases: the queued input never drains
// after the provider goes idle; or it jumps ahead while the unanswered turn
// is still legitimately pending, before any idle.
describe("an unanswered OpenCode user message", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("holds the queue while pending and releases it once OpenCode is idle", async () => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Unanswered",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);

		await fixture.emitOpenCodeEvent({
			directory: realpathSync(fixture.projectDir),
			payload: {
				id: `evt_${randomUUID()}`,
				type: "message.updated",
				properties: {
					info: {
						id: "msg_unanswered",
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		await vi.waitFor(() =>
			expect(ledger(fixture, sessionId).turns).toEqual(["pending"]),
		);

		const inputId = randomUUID();
		const accepted = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				text: "after the unanswered message",
				inputId,
				originId: browser.originId,
				delivery: "queue",
			}),
		);
		expect(accepted).toEqual({ ok: true, sessionId, handedOff: false });
		await vi.waitFor(() =>
			expect(ledger(fixture, sessionId).queued).toEqual([inputId]),
		);
		// Nothing has said the provider stopped: the pending turn keeps its place.
		await new Promise((done) => setTimeout(done, 1_000));
		const held = ledger(fixture, sessionId);
		expect(held).toEqual({ queued: [inputId], sent: [], turns: ["pending"] });

		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "idle",
		});
		await vi.waitFor(
			() =>
				expect(ledger(fixture, sessionId)).toEqual({
					queued: [],
					sent: [inputId],
					turns: ["completed"],
				}),
			{ timeout: 15_000 },
		);
		const prompts = fixture
			.opencodeRequests()
			.filter(
				({ method, url }) =>
					method === "POST" &&
					url.split("?")[0] === `/session/${sessionId}/prompt_async`,
			);
		expect(prompts).toHaveLength(1);

		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-jyr9-12-unanswered-turn.json",
			JSON.stringify(
				{
					sessionId,
					inputId,
					held,
					final: ledger(fixture, sessionId),
					prompts,
				},
				null,
				2,
			),
		);
	}, 60_000);
});
