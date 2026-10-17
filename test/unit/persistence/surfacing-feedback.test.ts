// Failure modes: an annotation is lost on reopen; changing weights moves an
// absolute mark; clearing fails to publish a part revision; the original Jev
// verdict changes; cross-project, user, final or tool parts accept marks; a
// deleted session leaves feedback behind. Exercise real SQLite and the RPC seam.
// Replay can delete then recreate a part: both its annotation and ledger entry
// must survive, including while the part is absent and across every history read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { expect, it } from "vitest";
import {
	DEFAULT_CATEGORY_SET,
	surfacingLevel,
} from "../../../src/lib/contracts/category-set.js";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import {
	GetSurfacingFeedback,
	SetSurfacingMark,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeSurfacingFeedback } from "../../../src/lib/domain/relay/Services/surfacing-feedback.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { sessionsHandlers } from "../../../src/lib/server/ws-rpc/sessions.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

const seed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 'Marks', 'idle', 1, 1), ('foreign', 'other-project', 'claude', 'Other', 'idle', 1, 1)`;
	yield* sql`INSERT INTO turns (id, session_id, state, requested_at, assistant_message_id) VALUES ('t', 's', 'completed', 1, 'final')`;
	yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('m', 's', 't', 'assistant', 'Finding', 1, 1), ('final', 's', 't', 'assistant', 'Done', 2, 2), ('user', 's', 't', 'user', 'Hello', 1, 1), ('fm', 'foreign', NULL, 'assistant', 'Foreign', 1, 1)`;
	yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities) VALUES ('p', 'm', 'text', 'Finding', 0, 1, 1, 1, '{"finding":0.9,"routine":0.1}'), ('final-p', 'final', 'text', 'Done', 0, 1, 1, NULL, NULL), ('user-p', 'user', 'text', 'Hello', 0, 1, 1, NULL, NULL), ('foreign-p', 'fm', 'text', 'Foreign', 0, 1, 1, 1, '{"ask":1}'), ('tool-p', 'm', 'tool', '', 1, 1, 1, NULL, NULL)`;
});

it("preserves annotations while snapshot replay deletes and recreates their part", async () => {
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(":memory:", "test-project"),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const feedback = yield* makeSurfacingFeedback;
				const read = yield* ReadQueryEffectTag;
				const mark = {
					level: "balanced" as const,
					category: "ask",
					direction: "raise" as const,
					reason: "Keep this finding",
				};
				yield* feedback.set("p", mark);
				const saved = (yield* feedback.ledger())[0];
				for (const includePart of [false, true]) {
					yield* store.append(
						canonicalEvent(
							"message.snapshot",
							"s",
							{
								messageId: "m",
								digest: `snapshot-${includePart}`,
								message: {
									id: "m",
									sessionID: "s",
									role: "assistant",
									time: { created: 1, completed: 1 },
									parts: includePart
										? [{ id: "p", type: "text", text: "Finding" }]
										: [],
								},
							},
							{ metadata: { rawSource: "opencode.rest" } },
						),
					);
					expect((yield* runner.recover()).totalReplayed).toBeGreaterThan(0);
					expect(
						yield* sql`SELECT id FROM message_parts WHERE id = 'p'`,
					).toEqual(includePart ? [{ id: "p" }] : []);
					expect(yield* feedback.ledger()).toMatchObject([
						{
							sessionId: "s",
							messageId: "m",
							partId: "p",
							mark,
							createdAt: saved?.createdAt,
						},
					]);
				}
				const views = [
					yield* read.getSessionMessagesWithParts("s"),
					(yield* read.readSessionTranscriptPage("s", { limit: 10 })).messages,
					(yield* read.readSessionTranscriptPage("s", {
						limit: 10,
						previewTools: true,
					})).messages,
					(yield* read.readSessionTranscript("s")).messages,
				];
				for (const messages of views) {
					expect(
						messageRowsToHistory(messages, { pageSize: 10 })
							.messages.find(({ id }) => id === "m")
							?.parts?.find(({ id }) => id === "p")?.surfacingMark,
					).toEqual(mark);
				}
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

it("persists absolute marks without changing verdicts, and stamps saves and clears", async () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-marks-"));
	const advances: ReadModelAdvance[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	});
	const open = () =>
		ManagedRuntime.make(
			makePersistenceEffectLayer(
				join(directory, "events.db"),
				"test-project",
			).pipe(Layer.provideMerge(bus)),
		);
	let runtime = open();
	try {
		await runtime.runPromise(seed);
		await runtime.runPromise(
			sessionsHandlers.SetSurfacingMark(
				new SetSurfacingMark({
					sessionId: "s",
					partId: "p",
					mark: {
						level: "balanced",
						direction: "raise",
						reason: "Useful finding",
					},
				}),
			),
		);
		const saved = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return (yield* sql<{
					version: number;
					surfacing_probabilities: string;
				}>`SELECT version, surfacing_probabilities FROM message_parts WHERE id = 'p'`)[0];
			}),
		);
		expect(saved?.surfacing_probabilities).toBe(
			'{"finding":0.9,"routine":0.1}',
		);
		expect(advances.at(-1)?.sessionIds).toEqual(["s"]);
		await runtime.dispose();
		runtime = open();
		const feedback = await runtime.runPromise(
			makeSurfacingFeedback.pipe(Effect.flatMap((service) => service.ledger())),
		);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.mark).toEqual({
			level: "balanced",
			direction: "raise",
			reason: "Useful finding",
		});
		const changed = {
			categories: DEFAULT_CATEGORY_SET.categories.map((category) => ({
				...category,
				weight: 100,
			})),
		};
		expect(
			surfacingLevel({ probabilities: { finding: 0.9 } }, changed).level,
		).toBe("key");
		expect(
			surfacingLevel(
				{ probabilities: { finding: 0.9 } },
				changed,
				feedback[0]?.mark,
			).level,
		).toBe("balanced");
		await runtime.runPromise(
			sessionsHandlers.SetSurfacingMark(
				new SetSurfacingMark({
					sessionId: "s",
					partId: "p",
					mark: null,
				}),
			),
		);
		const cleared = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return (yield* sql<{
					version: number;
				}>`SELECT version FROM message_parts WHERE id = 'p'`)[0];
			}),
		);
		expect(cleared?.version).toBeGreaterThan(saved?.version ?? -1);
		expect(advances).toHaveLength(2);
		const hydrated = await runtime.runPromise(
			Effect.flatMap(ReadQueryEffectTag, (read) =>
				read.getSessionMessagesWithParts("s"),
			),
		);
		expect(
			messageRowsToHistory(hydrated, { pageSize: 10 })
				.messages.find(({ id }) => id === "m")
				?.parts?.find(({ id }) => id === "p")?.surfacingMark,
		).toBeUndefined();
		expect(
			await runtime.runPromise(
				makeSurfacingFeedback.pipe(
					Effect.flatMap((service) => service.ledger()),
				),
			),
		).toEqual([]);
	} finally {
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects unrelated parts and removes marks with their session", async () => {
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(":memory:", "test-project"),
	);
	try {
		await runtime.runPromise(seed);
		for (const partId of [
			"missing",
			"foreign-p",
			"user-p",
			"final-p",
			"tool-p",
		]) {
			await expect(
				runtime.runPromise(
					sessionsHandlers.SetSurfacingMark(
						new SetSurfacingMark({
							sessionId: "s",
							partId,
							mark: { level: "key" },
						}),
					),
				),
			).rejects.toBeDefined();
		}
		await expect(
			runtime.runPromise(
				sessionsHandlers.SetSurfacingMark(
					new SetSurfacingMark({
						sessionId: "foreign",
						partId: "p",
						mark: { level: "key" },
					}),
				),
			),
		).rejects.toBeDefined();
		await runtime.runPromise(
			sessionsHandlers.SetSurfacingMark(
				new SetSurfacingMark({
					sessionId: "s",
					partId: "p",
					mark: { level: "key", direction: "retype", category: "ask" },
				}),
			),
		);
		const raisedRetype = {
			level: "balanced" as const,
			direction: "lower" as const,
			category: "ask",
		};
		await runtime.runPromise(
			makeSurfacingFeedback.pipe(
				Effect.flatMap((feedback) =>
					Effect.gen(function* () {
						yield* feedback.set("p", raisedRetype);
						yield* feedback.set("p", null);
						yield* feedback.set("p", raisedRetype);
						expect((yield* feedback.ledger())[0]?.mark).toEqual(raisedRetype);
					}),
				),
			),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`DELETE FROM sessions WHERE id = 's'`;
				expect(yield* sql`SELECT part_id FROM surfacing_marks`).toEqual([]);
			}),
		);
		expect(
			await runtime.runPromise(
				makeSurfacingFeedback.pipe(
					Effect.flatMap((service) => service.ledger()),
				),
			),
		).toEqual([]);
	} finally {
		await runtime.dispose();
	}
});

it("reads the daemon-wide feedback ledger without starting a project relay", async () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-global-marks-"));
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(join(directory, "events.db"), "test-project"),
	);
	try {
		await runtime.runPromise(seed);
		await runtime.runPromise(
			makeSurfacingFeedback.pipe(
				Effect.flatMap((feedback) =>
					feedback.set("p", { level: "key", direction: "raise" }),
				),
			),
		);
	} finally {
		await runtime.dispose();
	}
	const daemon = ManagedRuntime.make(
		makeDaemonRpcTestLayer([], undefined, { configDir: directory }),
	);
	try {
		const ledger = await daemon.runPromise(
			Effect.flatMap(DaemonWsRpcHandlersTag, (handlers) =>
				handlers.GetSurfacingFeedback(new GetSurfacingFeedback({})),
			),
		);
		expect(ledger).toMatchObject([
			{
				projectId: "test-project",
				sessionId: "s",
				partId: "p",
				mark: { level: "key", direction: "raise" },
			},
		]);
	} finally {
		await daemon.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
