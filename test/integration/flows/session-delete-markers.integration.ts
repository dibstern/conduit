import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("cascaded session deletion markers", () => {
	let harness: RelayHarness;
	let db: Database.Database;
	const evidence: Record<string, unknown> = {};

	afterEach(async () => {
		vi.restoreAllMocks();
		db?.close();
		await harness?.stop();
		mkdirSync("test-results/session-delete-markers", { recursive: true });
		writeFileSync(
			"test-results/session-delete-markers/flows.json",
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
	});

	async function setup() {
		harness = await createRelayHarness();
		db = new Database(harness.eventsDbPath, { readonly: true });
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const source = await client.createSession("Source", {
			providerId: "opencode",
		});
		const services = await harness.stack.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				return {
					commit: yield* makeCommitAndSignal,
					bus: Option.getOrThrow(
						yield* Effect.serviceOption(SessionEventBusTag),
					),
					reads: yield* ReadQueryEffectTag,
					manager: yield* SessionManagerServiceTag,
					sql: yield* SqlClient.SqlClient,
				};
			}),
		);
		return { client, root: String(source["id"]), ...services };
	}

	const created = (sessionId: string, parentId: string, sideThread = false) =>
		canonicalEvent("session.created", sessionId, {
			sessionId,
			parentId,
			title: sessionId,
			provider: "opencode",
			...(sideThread ? { sideThread: true } : {}),
		});

	async function verifyDeletion(
		name: string,
		root: string,
		removedIds: string[],
		published: MockInstance<SessionEventBus["publish"]>,
		advances: MockInstance<SessionEventBus["publishAdvance"]>,
	) {
		await vi.waitFor(() => {
			for (const id of removedIds)
				expect(
					db.prepare("SELECT id FROM sessions WHERE id = ?").get(id),
				).toBeUndefined();
			expect(
				published.mock.calls.some(([events]) =>
					events.some(
						(event) =>
							event.type === "session.deleted" && event.sessionId === root,
					),
				),
			).toBe(true);
		});
		const markers = db
			.prepare(
				`SELECT sequence, session_id, data FROM events WHERE type = 'session.deleted'
			AND session_id IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
			)
			.all(JSON.stringify(removedIds)) as {
			sequence: number;
			session_id: string;
			data: string;
		}[];
		expect(markers.map((marker) => marker.session_id).sort()).toEqual(
			[...removedIds].sort(),
		);
		const first = markers[0];
		if (!first) throw new Error("No deletion markers committed");
		expect(markers.map((marker) => marker.sequence)).toEqual(
			removedIds.map((_, index) => first.sequence + index),
		);
		for (const marker of markers)
			if (marker.session_id !== root)
				expect(JSON.parse(marker.data)).toEqual({
					sessionId: marker.session_id,
				});
		const commits = published.mock.calls
			.map(([events]) =>
				events.filter(
					(event) =>
						event.type === "session.deleted" &&
						removedIds.includes(event.sessionId),
				),
			)
			.filter((events) => events.length > 0);
		expect(commits).toHaveLength(1);
		expect(commits[0]?.map((event) => event.sequence)).toEqual(
			markers.map((marker) => marker.sequence),
		);
		const removals = advances.mock.calls
			.map(([advance]) =>
				advance.removedSessionIds.filter((id) => removedIds.includes(id)),
			)
			.filter((ids) => ids.length > 0);
		expect(removals).toHaveLength(1);
		expect([...(removals[0] ?? [])].sort()).toEqual([...removedIds].sort());
		const parity = await harness.checkReplayParity();
		expect(parity.diffs).toEqual([]);
		expect(parity.danglingPartPointers).toEqual([]);
		evidence[name] = {
			root,
			markers,
			commitSequences: commits.map((events) =>
				events.map((event) => event.sequence),
			),
			removals,
			parity,
		};
	}

	// Failure cases: the cascade erases children without log markers, the early
	// lineage misses a late child, an ingress writer bypasses expansion, duplicate
	// markers announce removal twice, or replay resurrects deleted history.
	it("deletes a Source, subagent, grandchild and Side Thread in one commit", async () => {
		const { client, root, commit, bus } = await setup();
		const child = "ses_delete_child";
		const grandchild = "ses_delete_grandchild";
		const side = "ses_delete_side";
		await harness.stack.effectRuntime.runtime.runPromise(
			commit([
				created(child, root),
				created(grandchild, child),
				created(side, root, true),
			]),
		);
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		await client.deleteSession(root);
		await verifyDeletion(
			"command",
			root,
			[root, child, grandchild, side],
			published,
			advances,
		);
	});

	it("marks a child added after the command's early lineage snapshot", async () => {
		const { root, commit, reads, manager, bus } = await setup();
		const child = "ses_delete_late_child";
		const getLineage = reads.getSessionLineage;
		let snapshotIds: string[] = [];
		vi.spyOn(reads, "getSessionLineage").mockImplementationOnce((options) =>
			getLineage(options).pipe(
				Effect.tap((snapshot) => {
					snapshotIds = snapshot.rows.map((row) => row.id);
					// Commit after reading the snapshot, before deleteSession can enter
					// its write transaction. No timing or background ingress is involved.
					return commit([created(child, root)]).pipe(Effect.orDie);
				}),
			),
		);
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		await harness.stack.effectRuntime.runtime.runPromise(
			manager.deleteSession(root),
		);
		expect(snapshotIds).toContain(root);
		expect(snapshotIds).not.toContain(child);
		await verifyDeletion(
			"late-child",
			root,
			[root, child],
			published,
			advances,
		);
	});

	it("marks a child when OpenCode deletes its parent upstream", async () => {
		const { root, commit, bus } = await setup();
		const child = "ses_delete_upstream_child";
		await harness.stack.effectRuntime.runtime.runPromise(
			commit([created(child, root)]),
		);
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		harness.mock.emitTestEvent("session.deleted", { info: { id: root } });
		await verifyDeletion("upstream", root, [root, child], published, advances);
	});

	it("includes children created earlier in the same commit", async () => {
		const { root, commit, bus } = await setup();
		const child = "ses_delete_batch_child";
		const grandchild = "ses_delete_batch_grandchild";
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		await harness.stack.effectRuntime.runtime.runPromise(
			commit([
				created(child, root),
				created(grandchild, child),
				canonicalEvent("session.deleted", root, { sessionId: root }),
			]),
		);
		await verifyDeletion(
			"same-batch-child",
			root,
			[root, child, grandchild],
			published,
			advances,
		);
	});

	it("rolls back descendant markers with the root and projection", async () => {
		const { client, root, commit, bus, sql } = await setup();
		const child = "ses_delete_rollback_child";
		await harness.stack.effectRuntime.runtime.runPromise(
			commit([created(child, root)]),
		);
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		const result = await harness.stack.effectRuntime.runtime.runPromise(
			Effect.result(
				commit([canonicalEvent("session.deleted", root, { sessionId: root })], {
					beforeCommit: sql
						.unsafe("INSERT INTO missing_delete_probe VALUES (1)")
						.pipe(Effect.asVoid),
				}),
			),
		);
		expect(result._tag).toBe("Failure");
		for (const id of [root, child]) {
			expect(
				db.prepare("SELECT id FROM sessions WHERE id = ?").get(id),
			).toEqual({ id });
			expect(
				db
					.prepare(
						"SELECT sequence FROM events WHERE session_id = ? AND type = 'session.deleted'",
					)
					.all(id),
			).toEqual([]);
		}
		expect(published).not.toHaveBeenCalled();
		expect(advances).not.toHaveBeenCalled();
		await client.deleteSession(root);
		await verifyDeletion(
			"rollback-and-retry",
			root,
			[root, child],
			published,
			advances,
		);
	});

	it.each([
		"root-first",
		"child-first",
	])("projects explicit markers in %s order without duplicates", async (order) => {
		const { root, commit, bus } = await setup();
		const child = "ses_delete_order_child";
		await harness.stack.effectRuntime.runtime.runPromise(
			commit([created(child, root)]),
		);
		const published = vi.spyOn(bus, "publish");
		const advances = vi.spyOn(bus, "publishAdvance");
		const ids = order === "root-first" ? [root, child] : [child, root];
		await harness.stack.effectRuntime.runtime.runPromise(
			commit(
				ids.map((sessionId) =>
					canonicalEvent("session.deleted", sessionId, { sessionId }),
				),
			),
		);
		await verifyDeletion(order, root, [root, child], published, advances);
	});
});
