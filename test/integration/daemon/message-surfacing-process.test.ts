// Failure modes: Jev judges while off for the session, or skips a session
// turned on while the global default is off; a fold is missed, judged twice or
// numbered wrongly; the final reply is judged; the request drifts from the
// category set or model; an outage or a full queue drops a verdict instead of
// recording null; a verdict needs a reload to reach an open browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

type JevRequest = {
	model: string;
	state: { request: string; message: string };
	questions: {
		category: { type: string; criteria: Record<string, unknown> };
	};
};
type Verdict = {
	partId: string;
	ordinal: number;
	categorySetVersion: number;
	model: string;
	probabilities: Record<string, number> | null;
};

const script = (blocks: readonly string[], padding = "") =>
	`jev-fold-script ${JSON.stringify(blocks)}${padding ? `\n${padding}` : ""}`;

it(
	"judges each folded mid-turn text part once, live, only while Jev is on for the session",
	{ timeout: 180_000 },
	async () => {
		const requests: JevRequest[] = [];
		let mode: "ok" | "outage" | "slow" = "ok";
		const fakeJev = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const body = JSON.parse(
				Buffer.concat(chunks).toString("utf8"),
			) as JevRequest;
			requests.push(body);
			if (mode === "outage") {
				response.writeHead(500).end("{}");
				return;
			}
			if (mode === "slow")
				await new Promise<void>((done) => setTimeout(done, 1_000));
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					answers: {
						category: {
							probabilities: Object.fromEntries(
								Object.keys(body.questions.category.criteria).map((id) => [
									id,
									id === "finding" ? 1 : 0,
								]),
							),
						},
					},
				}),
			);
		});
		await new Promise<void>((accept, reject) => {
			fakeJev.once("error", reject);
			fakeJev.listen(0, "127.0.0.1", accept);
		});
		const address = fakeJev.address();
		if (address === null || typeof address === "string")
			throw new Error("Fake Jev has no TCP address");
		const harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
		});
		const observations: Record<string, unknown> = {};
		let passed = false;
		const read = <T>(query: (db: Database.Database) => T): T => {
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			try {
				return query(db);
			} finally {
				db.close();
			}
		};
		const verdicts = (sessionId: string): Verdict[] =>
			read((db) =>
				db
					.prepare(
						"SELECT data FROM events WHERE session_id = ? AND type = 'text.surfaced' ORDER BY sequence",
					)
					.all(sessionId)
					.map((row) => JSON.parse((row as { data: string }).data) as Verdict),
			);
		const textParts = (sessionId: string) =>
			read(
				(db) =>
					db
						.prepare(
							"SELECT p.id, p.text, m.turn_id AS turnId FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND m.role = 'assistant' AND p.type = 'text' ORDER BY m.created_at, p.sort_order, p.created_at",
						)
						.all(sessionId) as {
						id: string;
						text: string;
						turnId: string | null;
					}[],
			);
		const settle = async (sessionId: string, count: number) => {
			const deadline = Date.now() + 20_000;
			while (verdicts(sessionId).length < count && Date.now() < deadline)
				await new Promise<void>((done) => setTimeout(done, 100));
			// A duplicate would land just after the expected count.
			await new Promise<void>((done) => setTimeout(done, 1_000));
			return verdicts(sessionId);
		};
		try {
			await harness.restart({
				serviceEnvironment: {
					TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
					TYPESAFE_API_KEY: "fake-live-key",
				},
			});
			const browser = await harness.connect();
			const rpc = <A, E>(effect: Effect.Effect<A, E>) =>
				Effect.runPromise(effect);
			const folds = script(["tool", "Second.", "Third.", "thinking", "Final."]);

			// Global off, session default: nothing is judged.
			const quiet = await browser.createSession("Jev default off");
			await browser.send(quiet, folds);
			expect(await settle(quiet, 0)).toEqual([]);
			expect(requests).toHaveLength(0);

			// Global on, session off: nothing is judged.
			await rpc(browser.rpc.UpdateMessageSurfacing({ enabled: true }));
			const muted = await browser.createSession("Jev session off");
			await rpc(browser.rpc.SetSessionJev({ sessionId: muted, jev: "off" }));
			await browser.send(muted, folds);
			expect(await settle(muted, 0)).toEqual([]);
			expect(requests).toHaveLength(0);

			// Global off, session on: tool, back-to-back text and thinking folds.
			await rpc(browser.rpc.UpdateMessageSurfacing({ enabled: false }));
			const judged = await browser.createSession("Jev session on");
			await rpc(browser.rpc.SetSessionJev({ sessionId: judged, jev: "on" }));
			const padded = script(
				["tool", "Second.", "Third.", "thinking", "Final."],
				"x".repeat(1_200),
			);
			const cursor = browser.frames.length;
			await browser.send(judged, padded);
			const first = await settle(judged, 3);
			const parts = textParts(judged);
			expect(parts.map(({ text }) => text.slice(0, 7))).toEqual([
				"Echo(je",
				"Second.",
				"Third.",
				"Final.",
			]);
			expect(first.map(({ partId, ordinal }) => ({ partId, ordinal }))).toEqual(
				parts.slice(0, 3).map(({ id }, n) => ({ partId: id, ordinal: n + 1 })),
			);
			expect(
				first.every(({ probabilities }) => probabilities?.["finding"] === 1),
			).toBe(true);
			expect(requests).toHaveLength(3);
			const set = await rpc(browser.rpc.GetCategorySet({}));
			const active = set.categories.filter(({ retired }) => !retired);
			for (const body of requests) {
				expect(body.model).toBe("jev-1.13.0");
				expect(body.questions.category.type).toBe("choice");
				expect(Object.keys(body.questions.category.criteria).sort()).toEqual(
					[...active.map(({ id }) => id), "routine"].sort(),
				);
				for (const category of active)
					expect(body.questions.category.criteria[category.id]).toEqual(
						category.criteria,
					);
				expect(body.state.request).toBe(padded.slice(0, 1_000));
			}
			// Long messages keep their head and tail.
			const excerpt = (text: string) =>
				text.length <= 2_500
					? text
					: `${text.slice(0, 2_000)}\n…\n${text.slice(-500)}`;
			expect(requests.map(({ state }) => state.message).sort()).toEqual(
				parts
					.slice(0, 3)
					.map(({ text }) => excerpt(text))
					.sort(),
			);
			expect(parts[0]?.text.length).toBeGreaterThan(2_500);
			expect(first.every(({ model }) => model === "jev-1.13.0")).toBe(true);
			expect(
				first.every(
					({ categorySetVersion }) => categorySetVersion === set.version,
				),
			).toBe(true);
			// The open browser receives each verdict without a reload.
			for (const { id } of parts.slice(0, 3))
				await browser.waitFor(
					(message) =>
						message["type"] === "transcript_message" &&
						message["sessionId"] === judged &&
						Array.isArray(message["parts"]) &&
						(
							message["parts"] as { id: string; surfacingOrdinal?: number }[]
						).some(
							(part) => part.id === id && part.surfacingOrdinal !== undefined,
						),
					cursor,
					10_000,
				);
			observations["turnIds"] = [...new Set(parts.map(({ turnId }) => turnId))];

			// A later turn numbers its own folds from 1; a restart judges nothing again.
			await harness.kill();
			await harness.restart({
				serviceEnvironment: {
					TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
					TYPESAFE_API_KEY: "fake-live-key",
				},
			});
			const after = await harness.connect(judged);
			await after.send(judged, script(["Again.", "tool", "Done."]));
			const second = await settle(judged, 5);
			const secondParts = textParts(judged).slice(4);
			expect(
				second.slice(3).map(({ partId, ordinal }) => ({ partId, ordinal })),
			).toEqual([
				{ partId: secondParts[0]?.id, ordinal: 1 },
				{ partId: secondParts[1]?.id, ordinal: 2 },
			]);
			expect(new Set(second.map(({ partId }) => partId)).size).toBe(
				second.length,
			);

			// An outage (500, then 500 on the retry) records a null verdict.
			mode = "outage";
			const beforeOutage = requests.length;
			await after.send(judged, script(["tool", "Recovered."]));
			const outage = await settle(judged, 6);
			expect(outage[5]?.probabilities).toBeNull();
			expect(requests.length - beforeOutage).toBe(2);

			// A burst past 8 in flight and the queue records null verdicts.
			mode = "slow";
			const burst = await after.createSession("Jev burst");
			await rpc(after.rpc.SetSessionJev({ sessionId: burst, jev: "on" }));
			const beforeBurst = requests.length;
			await after.send(
				burst,
				script([
					...Array.from({ length: 24 }, (_, n) => [
						"tool",
						`Burst ${n + 1}.`,
					]).flat(),
				]),
			);
			const burstVerdicts = await settle(burst, 24);
			expect(burstVerdicts).toHaveLength(24);
			expect(
				burstVerdicts.map(({ ordinal }) => ordinal).sort((a, b) => a - b),
			).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
			const overflowed = burstVerdicts.filter(
				({ probabilities }) => probabilities === null,
			);
			expect(overflowed.length).toBeGreaterThan(0);
			expect(requests.length - beforeBurst).toBe(24 - overflowed.length);
			Object.assign(observations, {
				first,
				second,
				outage: outage[5],
				burst: {
					verdicts: 24,
					overflowedOrdinals: overflowed.map(({ ordinal }) => ordinal),
				},
				requests: requests.length,
			});
			passed = true;
		} finally {
			const logs = harness.logTail;
			await harness.dispose();
			await new Promise<void>((accept, reject) =>
				fakeJev.close((error) => (error ? reject(error) : accept())),
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-4-message-surfacing-process.json",
				`${JSON.stringify({ passed, observations, capturedRequests: requests, logs }, null, 2)}\n`,
			);
		}
	},
);
