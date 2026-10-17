import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeMessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: daemon RPC bypasses the surfacing gate; reload spends again;
// cached versions or stable citations change after categorisation; New input
// repeats old messages or omits prior text; a short completion spends money.
describe("recaps through daemon RPC and the fake Claude SDK", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		if (!harness) return;
		const current = harness;
		try {
			await current.dispose();
		} finally {
			mkdirSync("test-results/recap", { recursive: true });
			writeFileSync(
				"test-results/recap/process.json",
				JSON.stringify(current.proof(), null, 2),
			);
			harness = undefined;
		}
	});
	it("keeps immutable cached versions across restart and sends only later messages for New", async () => {
		harness = await ProcessHarness.start();
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Recap proof");
		await harness.kill();
		await Effect.runPromise(
			Effect.gen(function* () {
				if (!harness) return;
				const settings = yield* makeMessageSurfacingSettings(
					harness.configDir,
					{ env: {}, transport: async () => new Response("{}") },
				);
				yield* settings.update({
					enabled: true,
					apiKey: "fake-recap-key",
					recap: { when: "on-request" },
				});
			}),
		);
		const db = new Database(harness.daemonStorePath());
		try {
			db.prepare(
				"INSERT INTO turns (id, session_id, state, user_message_id, assistant_message_id, requested_at) VALUES ('recap-turn', ?, 'completed', 'recap-turn', 'recap-answer', 1)",
			).run(sessionId);
			db.prepare(
				"INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('recap-turn', ?, 'recap-turn', 'user', 'Fix the problem', 1, 1)",
			).run(sessionId);
			db.prepare(
				"INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('recap-answer', ?, 'recap-turn', 'assistant', 'Final answer', 2, 2)",
			).run(sessionId);
			for (let n = 1; n <= 4; n++)
				db.prepare(
					"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities) VALUES (?, 'recap-answer', 'text', ?, ?, ?, ?, ?, '{\"finding\":1}')",
				).run(`recap-part-${n}`, `Recap finding ${n}`, n, n + 2, n + 2, n);
		} finally {
			db.close();
		}
		await harness.restart();
		browser = await harness.connect(sessionId);
		const target = { sessionId, turnId: "recap-turn" };
		const summaryCalls = () =>
			harness
				?.claudeTitles()
				.filter(({ prompt }) =>
					prompt.startsWith("Summarize this coding-assistant turn"),
				) ?? [];
		expect(await Effect.runPromise(browser.rpc.ListRecaps(target))).toEqual([]);
		expect(summaryCalls()).toEqual([]);
		const whole = await Effect.runPromise(
			browser.rpc.GenerateRecap({ ...target, scope: "whole" }),
		);
		expect(whole).toMatchObject({
			version: 1,
			firstOrdinal: 1,
			lastOrdinal: 4,
		});
		expect(whole.text).toContain("[#1]");
		expect(whole.text).not.toContain("[#999]");
		await harness.kill();
		const later = new Database(harness.daemonStorePath());
		try {
			later
				.prepare(
					"UPDATE message_parts SET surfacing_probabilities = '{\"routine\":1}' WHERE id = 'recap-part-1'",
				)
				.run();
			later
				.prepare(
					"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities) VALUES ('recap-part-5', 'recap-answer', 'text', 'Later finding 5', 5, 7, 7, 5, '{\"finding\":1}')",
				)
				.run();
		} finally {
			later.close();
		}
		await harness.restart();
		browser = await harness.connect(sessionId);
		expect(await Effect.runPromise(browser.rpc.ListRecaps(target))).toEqual([
			whole,
		]);
		expect(summaryCalls()).toHaveLength(1);
		const next = await Effect.runPromise(
			browser.rpc.GenerateRecap({ ...target, scope: "new" }),
		);
		expect(next).toMatchObject({
			version: 2,
			scope: "new",
			firstOrdinal: 5,
			lastOrdinal: 5,
		});
		const prompt = summaryCalls().at(-1)?.prompt ?? "";
		expect(prompt).toContain("Later finding 5");
		expect(prompt).not.toContain("Recap finding 1");
		expect(prompt).toContain(whole.text);
		expect(await Effect.runPromise(browser.rpc.ListRecaps(target))).toEqual([
			whole,
			next,
		]);
		const history = await browser.history(sessionId);
		expect(
			history
				.flatMap(({ parts }) => parts ?? [])
				.find(({ id }) => id === "recap-part-1")?.surfacingOrdinal,
		).toBe(1);
		await Effect.runPromise(
			browser.rpc.UpdateMessageSurfacing({ recap: { when: "turn-end" } }),
		);
		await browser.send(sessionId, "short-recap-turn");
		expect(summaryCalls()).toHaveLength(2);
		mkdirSync("test-results/recap", { recursive: true });
		writeFileSync(
			"test-results/recap/versions.json",
			JSON.stringify({ whole, next, summaryCalls: summaryCalls() }, null, 2),
		);
	});
});
