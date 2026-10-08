// The sidebar read model (conduit-test-y7eo.2), on real SQLite, checked against
// today's full computation: `listSessionInfos({ roots: true })`, which walks
// every family from scratch on each call. The sidebar table must give the
// same rows while recomputing only the families a commit touched, and must
// move a row's version only when what the sidebar shows has changed.
//
// Failure modes, written before the code:
//  1. A child moves between parents: both the old and the new family change,
//     and a root that gains a parent leaves the sidebar.
//  2. A family member is deleted (the root's roll-up drops it), or the root
//     itself is deleted (the row goes with it).
//  3. Side threads are hidden: their activity rolls into the side thread, not
//     the root, but their pending prompts still reach the root.
//  4. A question or permission is answered and the pending count goes stale,
//     because only session stamps refresh the row. The approval projector
//     must refresh it in the same transaction.
//  5. Unread is set or cleared on a child (a fork) through the seen writer,
//     which stamps rows without an event.
//  6. Projections are replayed or rebuilt after a restart and the table is
//     not rebuilt with them.
//  7. A family whose only change is deep in a descendant keeps its old version
//     and a subscriber never re-reads it.
//  8. A streamed chunk moves the version (every device resends and reorders),
//     or a status change or turn boundary does not.
//  9. Backfill on an existing store is wrong or slow (well under 1 s on 10k).
// 10. A family re-created after removal does not come back.
// 11. Background work is stored (it is in-memory liveness), or announcing it
//     does not move the row so no device re-reads it.
// 12. A delta read costs more than 5 ms on the 10k-session fixture.
// 13. Last-activity time moves without a visible change (reorders the sidebar
//     on a chunk), or does not follow the root when the row does change.
// 14. An orphan (its parent is missing) or a parent cycle loops the upkeep, is
//     shown in some family, or gets a root the migration's backfill would not
//     give it. Neither reaches a top-level session, so neither has a root.
// 15. Upkeep runs once per event, so a commit costs events x family size
//     inside the write transaction.
//
// Resuming past a removal tombstone belongs to conduit-test-y7eo.3.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, ManagedRuntime, Tracer } from "effect";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
} from "../../../src/lib/contracts/stored-event.js";
import {
	announceBackgroundWork,
	markSeen,
	markUnread,
} from "../../../src/lib/domain/relay/Services/session-attention.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	refreshSidebar,
	rerootSession,
} from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SessionBackground } from "../../../src/lib/session/background-liveness.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { seedSessionLoadFixture } from "../../fixtures/session-load.js";

const openStore = (filename: string) =>
	ManagedRuntime.make(makePersistenceEffectLayer(filename));
type Store = ReturnType<typeof openStore>;

type Command =
	| {
			readonly kind: "create";
			readonly id: string;
			readonly parent?: string | undefined;
			readonly side: boolean;
			readonly fork: boolean;
	  }
	| { readonly kind: "fork"; readonly id: string; readonly parent: string }
	/** Re-parent under a session that does not exist. */
	| { readonly kind: "orphan"; readonly id: string; readonly parent: string }
	| { readonly kind: "delete"; readonly id: string }
	| {
			readonly kind: "status";
			readonly id: string;
			readonly status: "idle" | "busy" | "retry" | "error";
	  }
	| { readonly kind: "chunk"; readonly id: string }
	| { readonly kind: "turn"; readonly id: string; readonly error: boolean }
	| { readonly kind: "ask"; readonly id: string; readonly question: boolean }
	| { readonly kind: "answer"; readonly pick: number }
	| { readonly kind: "seen"; readonly id: string }
	| { readonly kind: "unread"; readonly id: string }
	| { readonly kind: "rename"; readonly id: string }
	| {
			readonly kind: "background";
			readonly id: string;
			readonly work?: SessionBackground["work"] | undefined;
	  };

// Commands that change rows only through what the sidebar shows, so an
// unchanged item must keep its version. Lineage and background commands can
// also move a row for what it holds but does not show (its members).
const QUIET = new Set<Command["kind"]>([
	"status",
	"chunk",
	"turn",
	"ask",
	"answer",
	"seen",
	"unread",
	"rename",
]);

type Item = Omit<SessionInfo, "updatedAt">;
interface Shown {
	readonly item: Item;
	readonly updatedAt: SessionInfo["updatedAt"];
	readonly version: number;
}

const visible = ({ updatedAt: _, ...item }: SessionInfo): Item => item;
const byId = (items: readonly Item[]) =>
	[...items].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Drive one store through commands, checking the sidebar against the full
 * computation after each one. Returns what the sidebar showed last.
 */
const scenario = (store: Store) => {
	let clock = Date.UTC(2026, 0, 1);
	let messages = 0;
	let approvals = 0;
	const parents = new Map<string, string | undefined>();
	const lastMessage = new Map<string, string>();
	const pending: { id: string; sessionId: string; question: boolean }[] = [];
	const background = new Map<string, SessionBackground>();
	const backgroundOf = (id: string) => background.get(id);
	let shown = new Map<string, Shown>();
	let readVersion = -1;

	const event = <T extends CanonicalEventType>(
		type: T,
		sessionId: string,
		data: EventPayloadMap[T],
	): CanonicalEvent =>
		canonicalEvent(type, sessionId, data, {
			provider: "claude",
			createdAt: (clock += 1000),
		});

	const commit = (events: readonly CanonicalEvent[]) =>
		Effect.gen(function* () {
			const commitAndSignal = yield* makeCommitAndSignal;
			yield* commitAndSignal(events, { publish: false });
		});

	// No event can name a missing parent while foreign keys are on. A write
	// with them off can, as the fork-lineage import does during migration.
	const orphan = (id: string, parent: string) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commitAndSignal = yield* makeCommitAndSignal;
			yield* sql`PRAGMA foreign_keys = OFF`;
			yield* commitAndSignal
				.write(
					(_project, stamp) =>
						stamp((version) =>
							Effect.gen(function* () {
								yield* sql`UPDATE sessions SET parent_id = ${parent}, version = ${version} WHERE id = ${id}`;
								yield* refreshSidebar(yield* rerootSession(id), version);
								return [id];
							}),
						),
					{ publish: false },
				)
				.pipe(Effect.ensuring(Effect.orDie(sql`PRAGMA foreign_keys = ON`)));
		});

	// Parents can form cycles, so this collects instead of recursing.
	const subtree = (id: string): string[] => {
		const found = new Set([id]);
		for (const at of found)
			for (const [child, parent] of parents)
				if (parent === at) found.add(child);
		return [...found];
	};

	/** The events for a command, or undefined when the model rejects it. */
	const plan = (command: Command) => {
		const exists = "id" in command && parents.has(command.id);
		const run = Effect.asVoid;
		switch (command.kind) {
			case "create": {
				const { id, parent } = command;
				// The parent must exist (a foreign key), but may close a cycle.
				if (parent !== undefined && !parents.has(parent)) return undefined;
				const message = `${id}-m${messages++}`;
				parents.set(id, parent ?? parents.get(id));
				return run(
					commit([
						event("session.created", id, {
							sessionId: id,
							title: `Session ${id}`,
							provider: "claude",
							...(parent === undefined ? {} : { parentId: parent }),
							...(command.fork && parent !== undefined
								? { forkPointEvent: message }
								: {}),
							...(command.side && parent !== undefined
								? { sideThread: true }
								: {}),
						}),
					]),
				);
			}
			case "fork": {
				const { id, parent } = command;
				if (!exists || !parents.has(parent)) return undefined;
				parents.set(id, parent);
				return run(
					commit([
						event("session.forked", id, {
							sessionId: id,
							parentId: parent,
							forkPointEvent: `${id}-fork`,
						}),
					]),
				);
			}
			case "orphan": {
				const { id, parent } = command;
				if (!exists || parents.has(parent)) return undefined;
				parents.set(id, parent);
				return run(orphan(id, parent));
			}
			case "delete": {
				if (!exists) return undefined;
				for (const gone of subtree(command.id)) {
					parents.delete(gone);
					for (let index = pending.length - 1; index >= 0; index--)
						if (pending[index]?.sessionId === gone) pending.splice(index, 1);
				}
				return run(
					commit([
						event("session.deleted", command.id, {
							sessionId: command.id,
						}),
					]),
				);
			}
			case "status":
				if (!exists) return undefined;
				return run(
					commit([
						event("session.status", command.id, {
							sessionId: command.id,
							status: command.status,
						}),
					]),
				);
			case "chunk": {
				if (!exists) return undefined;
				const messageId = `${command.id}-m${messages++}`;
				lastMessage.set(command.id, messageId);
				return run(
					commit([
						event("message.created", command.id, {
							messageId,
							role: "assistant",
							sessionId: command.id,
						}),
						event("text.delta", command.id, {
							messageId,
							partId: `${messageId}-text`,
							text: "streamed",
						}),
					]),
				);
			}
			case "turn": {
				if (!exists) return undefined;
				const known = lastMessage.get(command.id);
				const messageId = known ?? `${command.id}-m${messages++}`;
				lastMessage.set(command.id, messageId);
				return run(
					commit([
						...(known === undefined
							? [
									event("message.created", command.id, {
										messageId,
										role: "assistant",
										sessionId: command.id,
									}),
								]
							: []),
						command.error
							? event("turn.error", command.id, {
									messageId,
									error: "failed",
								})
							: event("turn.completed", command.id, { messageId }),
					]),
				);
			}
			case "ask": {
				if (!exists) return undefined;
				const id = `approval-${approvals++}`;
				pending.push({
					id,
					sessionId: command.id,
					question: command.question,
				});
				return run(
					commit([
						command.question
							? event("question.asked", command.id, {
									id,
									sessionId: command.id,
									questions: [],
								})
							: event("permission.asked", command.id, {
									id,
									sessionId: command.id,
									toolName: "Bash",
									input: {},
								}),
					]),
				);
			}
			case "answer": {
				const [answered] = pending.splice(command.pick % pending.length, 1);
				if (answered === undefined) return undefined;
				return run(
					commit([
						answered.question
							? event("question.resolved", answered.sessionId, {
									id: answered.id,
									answers: {},
								})
							: event("permission.resolved", answered.sessionId, {
									id: answered.id,
									decision: "once",
								}),
					]),
				);
			}
			case "seen":
				if (!exists) return undefined;
				return run(markSeen(command.id, Number.MAX_SAFE_INTEGER));
			case "unread":
				if (!exists) return undefined;
				return run(markUnread(command.id));
			case "rename":
				if (!exists) return undefined;
				return run(
					commit([
						event("session.renamed", command.id, {
							sessionId: command.id,
							title: `Renamed ${messages++}`,
						}),
					]),
				);
			case "background":
				if (!exists) return undefined;
				if (command.work === undefined) background.delete(command.id);
				else
					background.set(command.id, {
						work: command.work,
						tasks: [
							{
								id: `${command.id}-task`,
								type: "local_bash",
								description: "watch",
								firstSeenAt: 1,
							},
						],
					});
				return run(announceBackgroundWork(command.id));
		}
	};

	const read = Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const sidebar = yield* readQuery.readSessionList({ backgroundOf });
		const oracle = yield* readQuery.listSessionInfos({
			roots: true,
			backgroundOf,
		});
		// The range interface: a delta from the last read names exactly the
		// rows whose version moved past it.
		const delta = yield* readQuery.readSessionList({
			after: readVersion,
			backgroundOf,
		});
		return { sidebar, oracle, delta };
	});

	/** Check the sidebar against the full computation and the last read. */
	const check = (command: Command | undefined) =>
		Effect.gen(function* () {
			const { sidebar, oracle, delta } = yield* read;
			expect(byId(sidebar.rows.map(({ item }) => visible(item)))).toEqual(
				byId(oracle.map(visible)),
			);
			const oracleUpdatedAt = new Map(
				oracle.map((item) => [item.id, item.updatedAt]),
			);
			const next = new Map(
				sidebar.rows.map(({ item, version }) => [
					item.id,
					{ item: visible(item), updatedAt: item.updatedAt, version },
				]),
			);
			for (const [id, now] of next) {
				const before = shown.get(id);
				if (before === undefined) {
					expect(now.version).toBeGreaterThan(readVersion);
					continue;
				}
				const changed =
					JSON.stringify(byId([before.item])) !==
					JSON.stringify(byId([now.item]));
				if (changed) {
					expect(now.version, `${id} changed`).toBeGreaterThan(before.version);
					expect(now.updatedAt).toBe(oracleUpdatedAt.get(id));
				} else if (command !== undefined && QUIET.has(command.kind)) {
					expect(now.version, `${id} unchanged`).toBe(before.version);
					expect(now.updatedAt).toBe(before.updatedAt);
				}
			}
			expect(
				delta.rows.map(({ item }) => item.id).sort(),
				"a delta names the moved rows",
			).toEqual(
				[...next]
					.filter(([, now]) => now.version > readVersion)
					.map(([id]) => id)
					.sort(),
			);
			shown = next;
			readVersion = sidebar.version;
			return next;
		});

	const apply = (command: Command) =>
		store.runPromise(
			Effect.gen(function* () {
				const step = plan(command);
				if (step === undefined) return shown;
				yield* step;
				return yield* check(command);
			}),
		);

	/** Replay every event from scratch, as a rebuild after a restart. */
	const rebuild = () =>
		store.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* sql`DELETE FROM sessions`;
				yield* sql`DELETE FROM pending_approvals`;
				yield* sql`UPDATE projector_cursors SET last_applied_seq = 0`;
				yield* runner.recover();
				shown = new Map();
				readVersion = -1;
				return yield* check(undefined);
			}),
		);

	/** Run the migration's backfill again: it must agree with the upkeep. */
	const backfill = () =>
		store.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const roots = sql<{ id: string; root_id: string | null }>`
					SELECT id, root_id FROM sessions ORDER BY id`;
				const kept = yield* roots;
				yield* sql`DROP TABLE session_sidebar`;
				yield* sql`DROP INDEX idx_sessions_root`;
				yield* sql`ALTER TABLE sessions DROP COLUMN root_id`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 38`;
				yield* makeEffectSqlMigrator();
				expect(yield* roots, "backfilled roots").toEqual(kept);
				shown = new Map();
				readVersion = -1;
				return yield* check(undefined);
			}),
		);

	return { apply, rebuild, backfill, shown: () => shown };
};

const ids = ["a", "b", "c", "d", "e"] as const;
const id = fc.constantFrom(...ids);
const command: fc.Arbitrary<Command> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("create" as const),
			id,
			// Half are roots, or few sessions would ever exist.
			parent: fc.option(id, { nil: undefined, freq: 2 }),
			side: fc.boolean(),
			fork: fc.boolean(),
		}),
	},
	fc.record({ kind: fc.constant("fork" as const), id, parent: id }),
	fc.record({ kind: fc.constant("orphan" as const), id, parent: id }),
	fc.record({ kind: fc.constant("delete" as const), id }),
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("status" as const),
			id,
			status: fc.constantFrom("idle", "busy", "retry", "error"),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({ kind: fc.constant("chunk" as const), id }),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("turn" as const),
			id,
			error: fc.boolean(),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("ask" as const),
			id,
			question: fc.boolean(),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("answer" as const),
			pick: fc.nat(),
		}),
	},
	fc.record({ kind: fc.constant("seen" as const), id }),
	fc.record({ kind: fc.constant("unread" as const), id }),
	fc.record({ kind: fc.constant("rename" as const), id }),
	fc.record({
		kind: fc.constant("background" as const),
		id,
		work: fc.option(fc.constantFrom("working", "monitoring"), {
			nil: undefined,
		}),
	}),
);

const run = async (
	commands: readonly Command[],
	options: { readonly backfill?: boolean; readonly rebuild?: boolean } = {},
) => {
	const store = openStore(":memory:");
	try {
		const sidebar = scenario(store);
		for (const next of commands) await sidebar.apply(next);
		if (options.backfill) await sidebar.backfill();
		if (options.rebuild) await sidebar.rebuild();
		return sidebar.shown();
	} finally {
		await store.dispose();
	}
};

const root = (id: string): Command => ({
	kind: "create",
	id,
	side: false,
	fork: false,
});
const child = (
	id: string,
	parent: string,
	options: { readonly side?: boolean; readonly fork?: boolean } = {},
): Command => ({
	kind: "create",
	id,
	parent,
	side: options.side ?? false,
	fork: options.fork ?? false,
});

describe("sidebar table against the full computation", () => {
	it("matches it, and moves versions only on visible changes, for any command sequence", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(command, { minLength: 10, maxLength: 40 }),
				async (commands) => {
					await run(commands, { backfill: true, rebuild: true });
				},
			),
			{ numRuns: 60 },
		);
	}, 120_000);

	it("shows no orphan or parent cycle, as the full list does not, and backfills them alike", async () => {
		const shown = await run(
			[
				root("a"),
				child("b", "a"),
				child("c", "b"),
				{ kind: "status", id: "c", status: "busy" },
				// b and c close a cycle and leave a's family.
				{ kind: "fork", id: "b", parent: "c" },
				child("d", "a"),
				{ kind: "orphan", id: "d", parent: "e" },
				{ kind: "ask", id: "d", question: true },
			],
			{ backfill: true },
		);
		expect([...shown.keys()]).toEqual(["a"]);
		expect(shown.get("a")?.item.attention).toBe("idle");
		// The missing parent arriving adopts the orphan.
		const adopted = await run([
			root("a"),
			{ kind: "orphan", id: "a", parent: "e" },
			{ kind: "ask", id: "a", question: true },
			root("e"),
		]);
		expect([...adopted.keys()]).toEqual(["e"]);
		expect(adopted.get("e")?.item.attention).toBe("needs-reply");
	});

	it("refreshes both families when a child moves, and drops a root that gains a parent", async () => {
		const shown = await run([
			root("a"),
			root("b"),
			child("c", "a"),
			{ kind: "status", id: "c", status: "busy" },
			{ kind: "fork", id: "c", parent: "b" },
			{ kind: "fork", id: "b", parent: "a" },
		]);
		expect([...shown.keys()]).toEqual(["a"]);
		expect(shown.get("a")?.item.processing).toBe(true);
	});

	it("drops a deleted member from the roll-up and a deleted root from the table", async () => {
		const shown = await run([
			root("a"),
			root("b"),
			child("c", "a"),
			{ kind: "ask", id: "c", question: true },
			{ kind: "delete", id: "c" },
			{ kind: "delete", id: "b" },
		]);
		expect([...shown.keys()]).toEqual(["a"]);
		expect(shown.get("a")?.item.pendingQuestionCount).toBeUndefined();
	});

	it("keeps side-thread activity off the root but lets its prompts through", async () => {
		const shown = await run([
			root("a"),
			child("s", "a", { side: true, fork: true }),
			child("t", "s"),
			{ kind: "status", id: "t", status: "busy" },
			{ kind: "ask", id: "t", question: false },
		]);
		expect(shown.get("a")?.item.processing).toBeUndefined();
		expect(shown.get("a")?.item.pendingPermissionCount).toBe(1);
		expect(shown.has("s")).toBe(false);
	});

	it("clears a pending count in the commit that answers it", async () => {
		const shown = await run([
			root("a"),
			child("b", "a"),
			{ kind: "ask", id: "b", question: true },
			{ kind: "ask", id: "a", question: false },
			{ kind: "answer", pick: 0 },
			{ kind: "answer", pick: 0 },
		]);
		expect(shown.get("a")?.item.attention).toBe("idle");
	});

	it("rolls a forked child's unread up and clears it through the seen writer", async () => {
		const marked = await run([
			root("a"),
			child("f", "a", { fork: true }),
			{ kind: "turn", id: "f", error: false },
			{ kind: "unread", id: "f" },
		]);
		expect(marked.get("a")?.item.attention).toBe("done-unread");
		const seen = await run([
			root("a"),
			child("f", "a", { fork: true }),
			{ kind: "turn", id: "f", error: false },
			{ kind: "seen", id: "f" },
		]);
		expect(seen.get("a")?.item.attention).toBe("idle");
	});

	it("moves the root for a change deep in a descendant", async () => {
		const shown = await run([
			root("a"),
			child("b", "a"),
			child("c", "b"),
			child("d", "c"),
			{ kind: "status", id: "d", status: "retry" },
		]);
		expect(shown.get("a")?.item.attention).toBe("working");
	});

	it("keeps the version for a chunk and moves it for a status change or turn end", async () => {
		// The per-step checks assert the versions; this only drives the steps.
		await run([
			root("a"),
			{ kind: "chunk", id: "a" },
			{ kind: "status", id: "a", status: "busy" },
			{ kind: "chunk", id: "a" },
			{ kind: "chunk", id: "a" },
			{ kind: "turn", id: "a", error: false },
			{ kind: "status", id: "a", status: "idle" },
		]);
	});

	it("applies background work at read time and moves the row when it is announced", async () => {
		const shown = await run([
			root("a"),
			child("b", "a"),
			{ kind: "background", id: "b", work: "monitoring" },
		]);
		expect(shown.get("a")?.item.attention).toBe("monitoring");
		expect(shown.get("a")?.item.backgroundWork).toBeUndefined();
	});

	it("brings a family back when it is re-created after removal", async () => {
		const shown = await run([
			root("a"),
			child("b", "a"),
			{ kind: "delete", id: "a" },
			root("a"),
			child("b", "a"),
		]);
		expect([...shown.keys()]).toEqual(["a"]);
	});

	it("rebuilds the table when projections are replayed", async () => {
		await run(
			[
				root("a"),
				child("b", "a", { fork: true }),
				{ kind: "ask", id: "b", question: true },
				{ kind: "status", id: "a", status: "busy" },
			],
			{ rebuild: true },
		);
	});
});

describe("sidebar table on the 10k-session fixture", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-sidebar-"));
		const filename = join(dir, "events.db");
		await seedSessionLoadFixture(filename, { heavyTurns: 2 });
		store = openStore(filename);
	}, 120_000);

	afterAll(async () => {
		await store?.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	const compare = Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const sidebar = yield* readQuery.readSessionList();
		const oracle = yield* readQuery.listSessionInfos({ roots: true });
		expect(sidebar.rows).toHaveLength(2501);
		expect(byId(sidebar.rows.map(({ item }) => visible(item)))).toEqual(
			byId(oracle.map(visible)),
		);
	});

	it("reads a delta in under 5 ms", async () => {
		const samples = await store.runPromise(
			Effect.gen(function* () {
				const readQuery = yield* ReadQueryEffectTag;
				const commitAndSignal = yield* makeCommitAndSignal;
				const timings: number[] = [];
				let after = (yield* readQuery.readSessionList({
					after: Number.MAX_SAFE_INTEGER,
				})).version;
				for (let index = 0; index < 21; index++) {
					yield* commitAndSignal(
						[
							canonicalEvent(
								"session.status",
								`load-f${index}`,
								{
									sessionId: `load-f${index}`,
									status: "busy",
								},
								{ provider: "claude" },
							),
						],
						{ publish: false },
					);
					const started = performance.now();
					const delta = yield* readQuery.readSessionList({ after });
					timings.push(performance.now() - started);
					expect(delta.rows.map(({ item }) => item.id)).toEqual([
						`load-f${index}`,
					]);
					after = delta.version;
				}
				return timings.sort((a, b) => a - b);
			}),
		);
		const median = samples[Math.floor(samples.length / 2)] ?? Infinity;
		console.info(`sidebar delta read median ${median.toFixed(2)} ms`);
		expect(median).toBeLessThan(5);
	});

	it("backfills an existing store in well under a second", async () => {
		const ms = await store.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Back to the store as the previous release left it.
				yield* sql`DROP TABLE session_sidebar`;
				yield* sql`DROP INDEX idx_sessions_root`;
				yield* sql`ALTER TABLE sessions DROP COLUMN root_id`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 38`;
				const started = performance.now();
				yield* makeEffectSqlMigrator();
				return performance.now() - started;
			}),
		);
		console.info(`sidebar backfill ${ms.toFixed(0)} ms`);
		expect(ms).toBeLessThan(1000);
		await store.runPromise(compare);
	}, 30_000);
});

describe("sidebar upkeep in a large family", () => {
	// Counts, not timings. Upkeep reads the whole family, so it has to happen
	// once per commit: once per event makes a commit cost events x family size,
	// all of it inside the write transaction.
	const FAMILY = 1500;
	const FAMILY_READ = /FROM sessions\s+WHERE root_id IN/;

	/** Records the text of every SQL statement run under it. */
	const recordQueries = (queries: string[]): Tracer.Tracer =>
		Tracer.make({
			span: (name, parent, context, links, startTime, kind) => ({
				_tag: "Span",
				name,
				spanId: "query",
				traceId: "query",
				parent,
				context,
				status: { _tag: "Started", startTime },
				attributes: new Map(),
				links,
				sampled: true,
				kind,
				end: () => {},
				attribute: (key, value) => {
					if (key === "db.query.text" && typeof value === "string")
						queries.push(value);
				},
				event: () => {},
				addLinks: () => {},
			}),
			context: (f) => f(),
		});

	it("reads the family once per commit, however many events it holds", async () => {
		const store = openStore(":memory:");
		const event = <T extends CanonicalEventType>(
			type: T,
			sessionId: string,
			data: EventPayloadMap[T],
		) => canonicalEvent(type, sessionId, data, { provider: "claude" });
		const commit = (events: readonly CanonicalEvent[]) =>
			Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
				commitAndSignal(events, { publish: false }),
			);
		/** Family reads, each one of every member row, made by one write. */
		const familyReads = async <A, E>(
			write: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Context<Store>>,
		) => {
			const queries: string[] = [];
			await store.runPromise(
				write.pipe(Effect.withTracer(recordQueries(queries))),
			);
			return queries.filter((query) => FAMILY_READ.test(query)).length;
		};
		// A deep spine as well as a wide fan.
		const children = Array.from({ length: FAMILY - 1 }, (_, index) => ({
			id: `child-${index}`,
			parent: index < 2 || index % 2 === 0 ? "root" : `child-${index - 2}`,
		}));
		try {
			expect(
				await familyReads(
					commit([
						event("session.created", "root", {
							sessionId: "root",
							title: "root",
							provider: "claude",
						}),
						...children.map(({ id, parent }) =>
							event("session.created", id, {
								sessionId: id,
								title: id,
								provider: "claude",
								parentId: parent,
							}),
						),
					]),
				),
				"creating the family",
			).toBe(1);
			expect(
				await familyReads(
					commit(
						Array.from({ length: 100 }, (_, index) =>
							index % 4 === 0
								? event("question.asked", "child-9", {
										id: `q-${index}`,
										sessionId: "child-9",
										questions: [],
									})
								: index % 4 === 1
									? event("session.status", "child-9", {
											sessionId: "child-9",
											status: index % 8 === 1 ? "busy" : "idle",
										})
									: event("session.variant_changed", "child-9", {
											sessionId: "child-9",
											variant: `v${index}`,
										}),
						),
					),
				),
				"100 events on one child",
			).toBe(1);
			expect(await familyReads(markUnread("root")), "a direct stamp").toBe(1);
			const sidebar = await store.runPromise(
				Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
					readQuery.readSessionList(),
				),
			);
			expect(sidebar.rows.map(({ item }) => item.attention)).toEqual([
				"needs-reply",
			]);
		} finally {
			await store.dispose();
		}
	}, 60_000);
});
