import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { EffectSessionSeeder } from "../../../src/lib/persistence/effect/session-seeder-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	makeSessionCreatedEvent,
	makeSessionStatusEvent,
} from "../../helpers/persistence-factories.js";

const scope = { projectIds: ["test-project"] } as const;

const readModelAfter = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const readQuery = yield* ReadQueryEffectTag;
		yield* runner.recover();
		for (const event of events) {
			yield* runner.projectEvent(yield* store.append(event));
		}

		const shell = yield* readQuery.readSessionList(scope);
		// Resolve the anchor as SubscribeSessionFamily does, including deleted
		// anchors so a missing shell row cannot hide surviving family members.
		const anchors = new Set(
			yield* Effect.forEach(
				new Set(events.map((event) => event.sessionId)),
				(id) =>
					readQuery
						.getSessionFamilyRoot(id)
						.pipe(Effect.map((root) => root ?? id)),
			),
		);
		const families = yield* Effect.forEach(anchors, (id) =>
			readQuery
				.readSessionList(scope, { familyOf: id })
				.pipe(Effect.map((family) => ({ id, rows: family.rows }))),
		);
		return {
			roots: shell.rows.map(({ item }) => item.id).sort(),
			families: Object.fromEntries(
				families.map(
					({ id, rows }) =>
						[id, rows.map(({ item }) => item.id).sort()] as const,
				),
			),
			rollups: Object.fromEntries(
				shell.rows.map(
					({ item }) =>
						[
							item.id,
							{
								status: item.status,
								processing: item.processing ?? false,
								unread: item.unread ?? false,
								attention: item.attention,
							},
						] as const,
				),
			),
			lineage: Object.fromEntries(
				families.flatMap(({ rows }) =>
					rows.map(
						({ item }) =>
							[
								item.id,
								{
									parentID: item.parentID,
									forkedFrom: item.forkedFrom,
									forkMessageId: item.forkMessageId,
									forkPointTimestamp: item.forkPointTimestamp,
									sideThread: item.sideThread,
								},
							] as const,
					),
				),
			),
		};
	}).pipe(
		Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
	);

const source = makeSessionCreatedEvent("source");
const unrelated = makeSessionCreatedEvent("unrelated");
const subagent = canonicalEvent("session.created", "subagent", {
	sessionId: "subagent",
	title: "Subagent",
	provider: "opencode",
	parentId: "source",
});
const nested = canonicalEvent("session.created", "nested", {
	sessionId: "nested",
	title: "Nested subagent",
	provider: "opencode",
	parentId: "subagent",
});
const sideThread = canonicalEvent("session.created", "side-thread", {
	sessionId: "side-thread",
	title: "Side Thread",
	provider: "opencode",
	parentId: "source",
	forkPointEvent: "fork-boundary",
	forkPointTimestamp: 1_000,
	sideThread: true,
});
const idle = {
	status: "idle",
	processing: false,
	unread: false,
	attention: "idle",
};
const noLineage = {
	parentID: undefined,
	forkedFrom: undefined,
	forkMessageId: undefined,
	forkPointTimestamp: undefined,
	sideThread: undefined,
};
const forkOf = (id: string, sourceId: string) =>
	canonicalEvent("session.created", id, {
		sessionId: id,
		title: `${id} (fork)`,
		provider: "opencode",
		forkedFrom: sourceId,
		forkPointEvent: "fork-boundary",
		forkPointTimestamp: 1_000,
	});
const sideThreadOf = (id: string, sourceId: string) =>
	canonicalEvent("session.created", id, {
		sessionId: id,
		title: id,
		provider: "opencode",
		parentId: sourceId,
		forkedFrom: sourceId,
		forkPointEvent: "fork-boundary",
		forkPointTimestamp: 1_000,
		sideThread: true,
	});
const forkLineage = (sourceId: string) => ({
	...noLineage,
	forkedFrom: sourceId,
	forkMessageId: "fork-boundary",
	forkPointTimestamp: 1_000,
});
const sideThreadLineage = (sourceId: string) => ({
	...forkLineage(sourceId),
	parentID: sourceId,
	sideThread: true,
});

describe("session read-model contract", () => {
	it.effect("lists a plain session as its own Family Root", () =>
		Effect.gen(function* () {
			expect(yield* readModelAfter([source])).toStrictEqual({
				roots: ["source"],
				families: { source: ["source"] },
				rollups: { source: idle },
				lineage: { source: noLineage },
			});
		}),
	);

	it.effect("rolls a busy subagent up only to its owner's sidebar row", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					unrelated,
					subagent,
					nested,
					makeSessionStatusEvent("nested", "busy"),
				]),
			).toStrictEqual({
				roots: ["source", "unrelated"],
				families: {
					source: ["nested", "source", "subagent"],
					unrelated: ["unrelated"],
				},
				rollups: {
					source: { ...idle, processing: true, attention: "working" },
					unrelated: idle,
				},
				lineage: {
					source: noLineage,
					unrelated: noLineage,
					subagent: { ...noLineage, parentID: "source" },
					nested: { ...noLineage, parentID: "subagent" },
				},
			});
		}),
	);

	it.effect(
		"keeps a subagent's completed turn from marking its owner unread",
		() =>
			Effect.gen(function* () {
				expect(
					yield* readModelAfter([
						source,
						unrelated,
						subagent,
						canonicalEvent("turn.completed", "subagent", {
							messageId: "answer",
						}),
					]),
				).toStrictEqual({
					roots: ["source", "unrelated"],
					families: {
						source: ["source", "subagent"],
						unrelated: ["unrelated"],
					},
					rollups: {
						source: idle,
						unrelated: idle,
					},
					lineage: {
						source: noLineage,
						unrelated: noLineage,
						subagent: { ...noLineage, parentID: "source" },
					},
				});
			}),
	);

	it.effect(
		"keeps a busy Side Thread in its Source's Family and out of roots",
		() =>
			Effect.gen(function* () {
				expect(
					yield* readModelAfter([
						source,
						sideThread,
						makeSessionStatusEvent("side-thread", "busy"),
					]),
				).toStrictEqual({
					roots: ["source"],
					families: { source: ["side-thread", "source"] },
					rollups: { source: idle },
					lineage: {
						source: noLineage,
						"side-thread": sideThreadLineage("source"),
					},
				});
			}),
	);

	it.effect(
		"lists a busy Fork as a Family Root that never marks its Source",
		() =>
			Effect.gen(function* () {
				const busyRoot = (yield* readModelAfter([
					makeSessionCreatedEvent("fork"),
					makeSessionStatusEvent("fork", "busy"),
				])).rollups["fork"];
				expect(
					yield* readModelAfter([
						source,
						forkOf("fork", "source"),
						makeSessionStatusEvent("fork", "busy"),
					]),
				).toStrictEqual({
					roots: ["fork", "source"],
					families: { fork: ["fork"], source: ["source"] },
					rollups: { fork: busyRoot, source: idle },
					lineage: { fork: forkLineage("source"), source: noLineage },
				});
			}),
	);

	it.effect("lists a Fork of a Fork as its own Family Root", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					forkOf("fork", "source"),
					forkOf("fork-of-fork", "fork"),
				]),
			).toStrictEqual({
				roots: ["fork", "fork-of-fork", "source"],
				families: {
					fork: ["fork"],
					"fork-of-fork": ["fork-of-fork"],
					source: ["source"],
				},
				rollups: { fork: idle, "fork-of-fork": idle, source: idle },
				lineage: {
					fork: forkLineage("source"),
					"fork-of-fork": forkLineage("fork"),
					source: noLineage,
				},
			});
		}),
	);

	it.effect("keeps a Fork's Side Thread in the Fork's Family", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					forkOf("fork", "source"),
					sideThreadOf("fork-side-thread", "fork"),
				]),
			).toStrictEqual({
				roots: ["fork", "source"],
				families: { fork: ["fork", "fork-side-thread"], source: ["source"] },
				rollups: { fork: idle, source: idle },
				lineage: {
					fork: forkLineage("source"),
					"fork-side-thread": sideThreadLineage("fork"),
					source: noLineage,
				},
			});
		}),
	);

	it.effect("lists a Fork of a Side Thread as its own Family Root", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					sideThread,
					forkOf("side-fork", "side-thread"),
				]),
			).toStrictEqual({
				roots: ["side-fork", "source"],
				families: {
					"side-fork": ["side-fork"],
					source: ["side-thread", "source"],
				},
				rollups: { "side-fork": idle, source: idle },
				lineage: {
					"side-fork": forkLineage("side-thread"),
					"side-thread": sideThreadLineage("source"),
					source: noLineage,
				},
			});
		}),
	);

	it.effect("rolls a Fork's busy subagent up to the Fork, not its Source", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					forkOf("fork", "source"),
					canonicalEvent("session.created", "fork-subagent", {
						sessionId: "fork-subagent",
						title: "Fork subagent",
						provider: "opencode",
						parentId: "fork",
					}),
					makeSessionStatusEvent("fork-subagent", "busy"),
				]),
			).toStrictEqual({
				roots: ["fork", "source"],
				families: { fork: ["fork", "fork-subagent"], source: ["source"] },
				rollups: {
					fork: { ...idle, processing: true, attention: "working" },
					source: idle,
				},
				lineage: {
					fork: forkLineage("source"),
					"fork-subagent": { ...noLineage, parentID: "fork" },
					source: noLineage,
				},
			});
		}),
	);

	it.effect("records session.forked as lineage only", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					makeSessionCreatedEvent("fork"),
					canonicalEvent("session.forked", "fork", {
						sessionId: "fork",
						parentId: "source",
						forkPointEvent: "fork-boundary",
						forkPointTimestamp: 1_000,
					}),
				]),
			).toStrictEqual({
				roots: ["fork", "source"],
				families: { fork: ["fork"], source: ["source"] },
				rollups: { fork: idle, source: idle },
				lineage: { fork: forkLineage("source"), source: noLineage },
			});
		}),
	);

	// OpenCode ingress seeds a session it has not seen yet, with OpenCode's
	// native parentID, after checking the store. A Fork stored in that gap
	// must stay a Family Root.
	it.effect(
		"keeps a Fork a Family Root when a native parent arrives later",
		() =>
			Effect.gen(function* () {
				expect(
					yield* readModelAfter([
						source,
						forkOf("fork", "source"),
						canonicalEvent("session.created", "fork", {
							sessionId: "fork",
							title: "Untitled",
							provider: "opencode",
							parentId: "source",
						}),
					]),
				).toStrictEqual({
					roots: ["fork", "source"],
					families: { fork: ["fork"], source: ["source"] },
					rollups: { fork: idle, source: idle },
					lineage: { fork: forkLineage("source"), source: noLineage },
				});
			}),
	);

	it.effect("deleting a Source keeps its Forks as Family Roots", () =>
		Effect.gen(function* () {
			const before = [source, unrelated, forkOf("fork", "source"), sideThread];
			expect((yield* readModelAfter(before)).lineage["fork"]).toStrictEqual(
				forkLineage("source"),
			);
			expect(
				yield* readModelAfter([
					...before,
					canonicalEvent("session.deleted", "source", { sessionId: "source" }),
				]),
			).toStrictEqual({
				roots: ["fork", "unrelated"],
				families: {
					fork: ["fork"],
					source: [],
					"side-thread": [],
					unrelated: ["unrelated"],
				},
				rollups: { fork: idle, unrelated: idle },
				lineage: {
					fork: { ...forkLineage("source"), forkedFrom: undefined },
					unrelated: noLineage,
				},
			});
		}),
	);

	it.effect("announces a Fork whose Source is deleted to live readers", () =>
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			const readQuery = yield* ReadQueryEffectTag;
			yield* runner.recover();
			for (const event of [source, forkOf("fork", "source")])
				yield* runner.projectEvent(yield* store.append(event));
			const before = yield* readQuery.readSessionList(scope);
			yield* runner.projectEvent(
				yield* store.append(
					canonicalEvent("session.deleted", "source", { sessionId: "source" }),
				),
			);
			// What an open browser's sidebar and family feeds read next.
			const forkIn = (window: {
				rows: readonly {
					item: { id: string; forkedFrom?: string | undefined };
				}[];
			}) => window.rows.find(({ item }) => item.id === "fork")?.item;
			const lineage = (item: { forkedFrom?: string | undefined } | undefined) =>
				item && { forkedFrom: item.forkedFrom };
			expect(
				lineage(
					forkIn(
						yield* readQuery.readSessionList(scope, { after: before.version }),
					),
				),
			).toStrictEqual({ forkedFrom: undefined });
			expect(
				lineage(
					forkIn(
						yield* readQuery.readSessionList(scope, {
							after: before.version,
							familyOf: "fork",
						}),
					),
				),
			).toStrictEqual({ forkedFrom: undefined });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);

	it.effect("deleting an owner removes its Side Threads and subagents", () =>
		Effect.gen(function* () {
			expect(
				yield* readModelAfter([
					source,
					unrelated,
					subagent,
					nested,
					sideThread,
					canonicalEvent("session.deleted", "source", { sessionId: "source" }),
				]),
			).toStrictEqual({
				roots: ["unrelated"],
				families: {
					source: [],
					subagent: [],
					nested: [],
					"side-thread": [],
					unrelated: ["unrelated"],
				},
				rollups: { unrelated: idle },
				lineage: { unrelated: noLineage },
			});
		}),
	);
	describe("shell feed", () => {
		// What an open sidebar reads next: the families that moved, and the ones
		// that left, past the version it last read.
		const shellChange = (after: {
			rows: readonly { item: { id: string } }[];
			removed?: readonly { id: string; deleted: boolean }[];
		}) => ({
			upserts: after.rows.map(({ item }) => item.id).sort(),
			removes: (after.removed ?? []).map(({ id, deleted }) => ({
				id,
				deleted,
			})),
		});

		it.effect(
			"removes a provider-stream root once session.created contains it",
			() =>
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					const readQuery = yield* ReadQueryEffectTag;
					yield* runner.recover();
					yield* runner.projectEvent(yield* store.append(source));
					// OpenCode streams a new Side Thread before Conduit records it,
					// so it is seeded with no owner and listed as a root.
					yield* new EffectSessionSeeder().ensureSession(
						"side-thread",
						"opencode",
					);
					yield* runner.projectEvent(
						yield* store.append(makeSessionStatusEvent("side-thread", "busy")),
					);
					const before = yield* readQuery.readSessionList(scope);
					expect(before.rows.map(({ item }) => item.id).sort()).toStrictEqual([
						"side-thread",
						"source",
					]);
					yield* runner.projectEvent(
						yield* store.append(sideThreadOf("side-thread", "source")),
					);
					expect(
						shellChange(
							yield* readQuery.readSessionList(scope, {
								after: before.version,
							}),
						),
					).toStrictEqual({
						// A Side Thread's activity stays off its owner's row.
						upserts: [],
						removes: [{ id: "side-thread", deleted: false }],
					});
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
		);

		it.effect("upserts a contained session once session.forked frees it", () =>
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				yield* runner.recover();
				for (const event of [
					source,
					canonicalEvent("session.created", "fork", {
						sessionId: "fork",
						title: "fork",
						provider: "opencode",
						parentId: "source",
					}),
				])
					yield* runner.projectEvent(yield* store.append(event));
				const before = yield* readQuery.readSessionList(scope);
				expect(before.rows.map(({ item }) => item.id)).toStrictEqual([
					"source",
				]);
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent("session.forked", "fork", {
							sessionId: "fork",
							parentId: "source",
						}),
					),
				);
				expect(
					shellChange(
						yield* readQuery.readSessionList(scope, { after: before.version }),
					),
				).toStrictEqual({
					upserts: ["fork", "source"],
					removes: [],
				});
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});

	describe("legacy events", () => {
		// Before Forks recorded lineage, a Fork was created contained in its
		// Source with a fork point and no Side Thread flag.
		const legacyForkOf = (id: string, sourceId: string) =>
			canonicalEvent("session.created", id, {
				sessionId: id,
				title: `${id} (fork)`,
				provider: "claude",
				parentId: sourceId,
				forkPointEvent: "fork-boundary",
				forkPointTimestamp: 1_000,
			});

		it.effect("reads a contained session with a fork point as a Fork", () =>
			Effect.gen(function* () {
				const busyRoot = (yield* readModelAfter([
					makeSessionCreatedEvent("fork"),
					makeSessionStatusEvent("fork", "busy"),
				])).rollups["fork"];
				expect(
					yield* readModelAfter([
						source,
						legacyForkOf("fork", "source"),
						makeSessionStatusEvent("fork", "busy"),
					]),
				).toStrictEqual({
					roots: ["fork", "source"],
					families: { fork: ["fork"], source: ["source"] },
					rollups: { fork: busyRoot, source: idle },
					lineage: { fork: forkLineage("source"), source: noLineage },
				});
			}),
		);

		it.effect(
			"keeps a legacy Fork's Side Thread and subagent in the Fork's Family",
			() =>
				Effect.gen(function* () {
					expect(
						yield* readModelAfter([
							source,
							legacyForkOf("fork", "source"),
							legacyForkOf("fork-of-fork", "fork"),
							canonicalEvent("session.created", "fork-side-thread", {
								sessionId: "fork-side-thread",
								title: "fork-side-thread",
								provider: "claude",
								parentId: "fork",
								forkPointEvent: "fork-boundary",
								forkPointTimestamp: 1_000,
								sideThread: true,
							}),
							canonicalEvent("session.created", "fork-subagent", {
								sessionId: "fork-subagent",
								title: "Fork subagent",
								provider: "claude",
								parentId: "fork",
							}),
							makeSessionStatusEvent("fork-subagent", "busy"),
						]),
					).toStrictEqual({
						roots: ["fork", "fork-of-fork", "source"],
						families: {
							fork: ["fork", "fork-side-thread", "fork-subagent"],
							"fork-of-fork": ["fork-of-fork"],
							source: ["source"],
						},
						rollups: {
							fork: { ...idle, processing: true, attention: "working" },
							"fork-of-fork": idle,
							source: idle,
						},
						lineage: {
							fork: forkLineage("source"),
							"fork-of-fork": forkLineage("fork"),
							"fork-side-thread": sideThreadLineage("fork"),
							"fork-subagent": { ...noLineage, parentID: "fork" },
							source: noLineage,
						},
					});
				}),
		);

		it.effect("reads session.forked without a fork point as a Fork", () =>
			Effect.gen(function* () {
				expect(
					yield* readModelAfter([
						source,
						makeSessionCreatedEvent("fork"),
						canonicalEvent("session.forked", "fork", {
							sessionId: "fork",
							parentId: "source",
						}),
					]),
				).toStrictEqual({
					roots: ["fork", "source"],
					families: { fork: ["fork"], source: ["source"] },
					rollups: { fork: idle, source: idle },
					lineage: {
						fork: { ...noLineage, forkedFrom: "source" },
						source: noLineage,
					},
				});
			}),
		);

		it.effect("keeps a legacy Side Thread contained, with lineage", () =>
			Effect.gen(function* () {
				expect(yield* readModelAfter([source, sideThread])).toStrictEqual({
					roots: ["source"],
					families: { source: ["side-thread", "source"] },
					rollups: { source: idle },
					lineage: {
						source: noLineage,
						"side-thread": sideThreadLineage("source"),
					},
				});
			}),
		);
	});
});
