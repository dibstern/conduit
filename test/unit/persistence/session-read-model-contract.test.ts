import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	makeSessionCreatedEvent,
	makeSessionStatusEvent,
} from "../../helpers/persistence-factories.js";

const readModelAfter = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const readQuery = yield* ReadQueryEffectTag;
		yield* runner.recover();
		for (const event of events) {
			yield* runner.projectEvent(yield* store.append(event));
		}

		const shell = yield* readQuery.readSessionList();
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
				.readSessionList({ familyOf: id })
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
	forkMessageId: undefined,
	forkPointTimestamp: undefined,
	sideThread: undefined,
};

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
						"side-thread": {
							parentID: "source",
							forkMessageId: "fork-boundary",
							forkPointTimestamp: 1_000,
							sideThread: true,
						},
					},
				});
			}),
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
});
