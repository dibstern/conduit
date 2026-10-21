// Process failure modes: settings route through a project; previews or weights
// call TypeSafe; changed criteria skip or duplicate sample calls; proposals call
// the real SDK, ignore avoid, persist themselves, or bypass version conflicts.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

it(
	"scores the stable sample through fake Jev and proposes through fake one-shot Opus",
	{ timeout: 90_000 },
	async () => {
		const requests: unknown[] = [];
		const fakeJev = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const body = Schema.decodeUnknownSync(
				Schema.fromJsonString(
					Schema.Struct({
						questions: Schema.Struct({
							category: Schema.Struct({
								criteria: Schema.Record(Schema.String, Schema.Unknown),
							}),
						}),
					}),
				),
			)(Buffer.concat(chunks).toString("utf8"));
			requests.push(body);
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
			foregroundCli: true,
		});
		const observations: Record<string, unknown> = {};
		let passed = false;
		try {
			await harness.restart();
			await harness.terminate();
			const store = ManagedRuntime.make(
				makePersistenceEffectLayer(harness.daemonStorePath(), "process-test"),
			);
			try {
				await store.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at, history_complete) VALUES ('tuning-session','process-test','claude','Feedback proof','idle',1,1,1)`;
						yield* sql`INSERT INTO turns (id,session_id,state,user_message_id,requested_at) VALUES ('tuning-turn','tuning-session','completed','tuning-request',1)`;
						yield* sql`INSERT INTO messages (id,session_id,turn_id,role,text,created_at,updated_at) VALUES ('tuning-request','tuning-session','tuning-turn','user','Fix the queue regression',1,1), ('tuning-message','tuning-session','tuning-turn','assistant','The queue wastes a scan.',2,2)`;
						for (let n = 1; n <= 56; n++) {
							yield* sql`INSERT INTO message_parts (id,message_id,type,text,sort_order,created_at,updated_at,surfacing_ordinal,surfacing_probabilities,surfacing_set_version) VALUES (${`tuning-part-${n}`},'tuning-message','text',${`The queue wastes scan ${n}`},${n},${n},${n},${n},'{"finding":1,"routine":0}',1)`;
							if (n <= 5)
								yield* sql`INSERT INTO surfacing_marks (part_id,session_id,message_id,level,direction,reason,created_at) VALUES (${`tuning-part-${n}`},'tuning-session','tuning-message','key','raise','changes the plan',${n})`;
						}
					}),
				);
			} finally {
				await store.dispose();
			}
			await harness.restart({
				serviceEnvironment: {
					TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
					TYPESAFE_API_KEY: "fake-tuning-key",
				},
			});
			await harness.requestRpc({
				_tag: "UpdateMessageSurfacing",
				enabled: true,
			});
			const current = await harness.requestRpc({ _tag: "GetCategorySet" });
			const ledger = await harness.requestRpc({ _tag: "GetSurfacingLedger" });
			expect(ledger).toHaveLength(5);
			expect(ledger[0]).toMatchObject({
				sessionTitle: "Feedback proof",
				requestExcerpt: "Fix the queue regression",
			});
			const before = await harness.requestRpc({
				_tag: "ScoreCategorySet",
				set: current,
				estimateOnly: true,
			});
			expect(before).toMatchObject({
				agree: 0,
				total: 5,
				jevCalls: 0,
				complete: true,
			});
			const weights = {
				categories: current.categories.map((category) =>
					category.id === "finding" ? { ...category, weight: 80 } : category,
				),
			};
			expect(
				await harness.requestRpc({ _tag: "ScoreCategorySet", set: weights }),
			).toMatchObject({ agree: 5, jevCalls: 0, complete: true });
			expect(requests).toHaveLength(0);
			const criteria = {
				categories: weights.categories.map((category) =>
					category.id === "finding"
						? { ...category, criteria: { what: "Names a measured root cause" } }
						: category,
				),
			};
			const estimate = await harness.requestRpc({
				_tag: "ScoreCategorySet",
				set: criteria,
				estimateOnly: true,
			});
			expect(estimate).toMatchObject({
				requiredCalls: 55,
				jevCalls: 0,
				complete: false,
				canTest: true,
			});
			expect(requests).toHaveLength(0);
			const scored = await harness.requestRpc({
				_tag: "ScoreCategorySet",
				set: criteria,
			});
			expect(scored).toMatchObject({
				agree: 5,
				requiredCalls: 0,
				jevCalls: 55,
				complete: true,
			});
			expect(requests).toHaveLength(55);
			expect(scored.levels.map(({ partId }) => partId)).toEqual(
				before.levels.map(({ partId }) => partId),
			);
			expect(
				await harness.requestRpc({ _tag: "ScoreCategorySet", set: criteria }),
			).toMatchObject({ jevCalls: 0, complete: true });
			expect(requests).toHaveLength(55);
			const proposed = await harness.requestRpc({
				_tag: "ProposeCategoryTuning",
			});
			expect(proposed.hunks).toHaveLength(1);
			expect(await harness.requestRpc({ _tag: "GetCategorySet" })).toEqual(
				current,
			);
			const again = await harness.requestRpc({
				_tag: "ProposeCategoryTuning",
				avoid: proposed.hunks,
			});
			expect(again.hunks[0]?.id).not.toBe(proposed.hunks[0]?.id);
			const claudeCalls = harness
				.claudeTitles()
				.filter(({ prompt }) => prompt.includes('"currentSet"'));
			expect(claudeCalls).toHaveLength(2);
			expect(claudeCalls.at(-1)?.prompt).toContain(proposed.hunks[0]?.id);
			const applied = await harness.requestRpc({
				_tag: "ReplaceCategorySet",
				expectedVersion: proposed.baseVersion,
				nextSet: {
					categories: current.categories.map(
						(category) =>
							proposed.hunks.find(
								({ categoryId }) => categoryId === category.id,
							)?.after ?? category,
					),
				},
			});
			expect(applied.version).toBe(current.version + 1);
			await expect(
				harness.requestRpc({
					_tag: "ReplaceCategorySet",
					expectedVersion: current.version,
					nextSet: current,
				}),
			).rejects.toBeDefined();
			Object.assign(observations, {
				marks: ledger.length,
				sample: before.levels.map(({ partId }) => partId),
				estimate,
				scored,
				jevCalls: requests.length,
				claudeCalls,
				appliedVersion: applied.version,
			});
			passed = true;
		} finally {
			const logs = harness.logTail;
			await harness.dispose();
			harness.assertNoRunners();
			await new Promise<void>((accept, reject) =>
				fakeJev.close((error) => (error ? reject(error) : accept())),
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-14-category-tuning-process.json",
				`${JSON.stringify({ passed, observations, logs }, null, 2)}\n`,
			);
		}
	},
);
