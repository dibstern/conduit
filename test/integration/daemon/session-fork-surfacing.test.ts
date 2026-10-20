// Failure modes: a native Claude fork loses verdicts, leaves parent part ids,
// widens its cutoff when a verdict arrives late, loses null probabilities,
// mutates the parent, or drops the inherited values after daemon restart.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("Forked surfacing through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness?.assertNoRunners();
		harness = undefined;
	});

	it("inherits supplied verdicts at re-keyed parts, including a late verdict before the cutoff", async () => {
		harness = ProcessHarness.create();
		const fixture = harness;
		writeFileSync(
			join(fixture.root, "claude", "conduit-test-record-forks"),
			"record\n",
		);
		await fixture.restart({ startupTimeoutMs: 30_000 });
		let browser = await fixture.connect();
		const parentId = await browser.createSession("Surfaced parent");
		await browser.send(parentId, "First answer.");
		await browser.send(parentId, "Second answer.");
		const initial = await browser.history(parentId);
		const answers = initial.filter(({ role }) => role === "assistant");
		expect(answers).toHaveLength(2);
		const verdicts = answers.map((message, index) => {
			const part = message.parts?.find(({ type }) => type === "text");
			if (!part)
				throw new Error("Fake SDK did not produce an assistant text part");
			return {
				messageId: message.id,
				partId: part.id,
				ordinal: index + 1,
				categorySetVersion: 1,
				model: "jev-test",
				probabilities: index === 0 ? { ask: 0.8, routine: 0.2 } : null,
			};
		});
		// Append after both turns, while stopped, then use startup recovery's
		// projectors. No writes are made to a running daemon's SQLite connection.
		await fixture.kill();
		const db = new Database(fixture.daemonStorePath());
		try {
			const head = db
				.prepare(
					"SELECT project_id, MAX(stream_version) AS version FROM events WHERE session_id = ?",
				)
				.get(parentId) as { project_id: string; version: number };
			const insert = db.prepare(
				"INSERT INTO events (project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			db.transaction(() => {
				for (const [index, verdict] of verdicts.entries()) {
					const event = canonicalEvent("text.surfaced", parentId, verdict, {
						provider: "conduit",
					});
					insert.run(
						head.project_id,
						event.eventId,
						parentId,
						head.version + index + 1,
						event.type,
						JSON.stringify(event.data),
						"{}",
						event.provider,
						event.createdAt,
					);
				}
			})();
		} finally {
			db.close();
		}
		await fixture.restart({ startupTimeoutMs: 30_000 });
		browser = await fixture.connect();
		const parent = await browser.history(parentId);
		const forks = [];
		for (const cutoff of [undefined, answers[0]?.id]) {
			const { sessionId } = await sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				{
					_tag: "ForkSession",
					originId: browser.originId,
					sessionId: parentId,
					...(cutoff === undefined ? {} : { messageId: cutoff }),
				},
			);
			const history = await browser.history(sessionId);
			const expected = parent.filter(
				(message) =>
					cutoff === undefined ||
					initial.findIndex(({ id }) => id === message.id) <=
						initial.findIndex(({ id }) => id === cutoff),
			);
			expect(history.map(({ id }) => id)).toEqual(
				expected.map(({ id }) => `${id}_${sessionId}`),
			);
			for (const verdict of verdicts.filter(({ messageId }) =>
				expected.some(({ id }) => id === messageId),
			)) {
				const part = history
					.flatMap(({ parts }) => parts ?? [])
					.find(({ id }) => id === `${verdict.partId}_${sessionId}`);
				expect(part).toMatchObject({
					surfacingOrdinal: verdict.ordinal,
					surfacingProbabilities: verdict.probabilities,
					surfacingSetVersion: verdict.categorySetVersion,
					surfacingModel: verdict.model,
				});
			}
			forks.push({ sessionId, cutoff, history });
		}
		expect(await browser.history(parentId)).toEqual(parent);
		await fixture.kill();
		await fixture.restart({ startupTimeoutMs: 30_000 });
		browser = await fixture.connect();
		for (const fork of forks)
			expect(await browser.history(fork.sessionId)).toEqual(fork.history);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/ahu8-7-fork-surfacing.json",
			JSON.stringify({ parent, verdicts, forks, afterRestart: true }, null, 2),
		);
	}, 60_000);
});
