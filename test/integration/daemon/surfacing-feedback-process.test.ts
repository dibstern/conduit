// Real-process failure modes: routed marks reach a different project; annotations
// disappear on daemon restart; category edits recalculate an absolute user level.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { surfacingLevel } from "../../../src/lib/contracts/category-set.js";
import {
	GetCategorySet,
	GetSurfacingFeedback,
	ReplaceCategorySet,
	SetSurfacingMark,
} from "../../../src/lib/contracts/ws-rpc.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

it(
	"preserves marked levels and their reasons across restart and weight edits",
	{ timeout: 90_000 },
	async () => {
		const harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
		});
		const observations: Record<string, unknown> = {};
		let passed = false;
		try {
			await harness.restart();
			await harness.terminate();
			const runtime = ManagedRuntime.make(
				makePersistenceEffectLayer(harness.daemonStorePath(), "process-test"),
			);
			try {
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at, history_complete) VALUES ('mark-session','process-test','claude','Feedback restart','idle',1,1,1)`;
						yield* sql`INSERT INTO turns (id,session_id,state,requested_at) VALUES ('mark-turn','mark-session','completed',1)`;
						yield* sql`INSERT INTO messages (id,session_id,turn_id,role,text,created_at,updated_at) VALUES ('mark-message','mark-session','mark-turn','assistant','The query wastes a scan.',1,1)`;
						yield* sql`INSERT INTO message_parts (id,message_id,type,text,sort_order,created_at,updated_at,surfacing_ordinal,surfacing_probabilities) VALUES ('mark-part','mark-message','text','The query wastes a scan.',0,1,1,1,'{"finding":0.9,"routine":0.1}')`;
					}),
				);
			} finally {
				await runtime.dispose();
			}
			await harness.restart();
			await harness.requestRpc(
				new SetSurfacingMark({
					sessionId: "mark-session",
					partId: "mark-part",
					mark: {
						level: "balanced",
						direction: "raise",
						reason: "changes the plan",
					},
				}),
			);
			const saved = await harness.requestRpc(new GetSurfacingFeedback({}));
			expect(saved).toHaveLength(1);
			expect(saved[0]?.mark).toEqual({
				level: "balanced",
				direction: "raise",
				reason: "changes the plan",
			});
			await harness.terminate();
			await harness.restart();
			expect(await harness.requestRpc(new GetSurfacingFeedback({}))).toEqual(
				saved,
			);
			const initial = await harness.requestRpc(new GetCategorySet({}));
			const changed = await harness.requestRpc(
				new ReplaceCategorySet({
					expectedVersion: initial.version,
					nextSet: {
						categories: initial.categories.map((category) =>
							category.id === "finding"
								? { ...category, weight: 100 }
								: category,
						),
					},
				}),
			);
			const after = await harness.requestRpc(new GetSurfacingFeedback({}));
			const entry = after[0];
			if (!entry) throw new Error("Feedback disappeared after a weight edit");
			expect(
				surfacingLevel({ probabilities: entry.probabilities }, changed).level,
			).toBe("key");
			expect(
				surfacingLevel(
					{ probabilities: entry.probabilities },
					changed,
					entry.mark,
				).level,
			).toBe("balanced");
			await harness.requestRpc(
				new SetSurfacingMark({
					sessionId: "mark-session",
					partId: "mark-part",
					mark: null,
				}),
			);
			expect(await harness.requestRpc(new GetSurfacingFeedback({}))).toEqual(
				[],
			);
			Object.assign(observations, {
				saved,
				after,
				unmarkedLevel: surfacingLevel(
					{ probabilities: entry.probabilities },
					changed,
				),
				markedLevel: surfacingLevel(
					{ probabilities: entry.probabilities },
					changed,
					entry.mark,
				),
			});
			passed = true;
		} finally {
			const logs = harness.logTail;
			await harness.dispose();
			harness.assertNoRunners();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-10-surfacing-feedback-process.json",
				`${JSON.stringify({ passed, observations, logs }, null, 2)}\n`,
			);
		}
	},
);
