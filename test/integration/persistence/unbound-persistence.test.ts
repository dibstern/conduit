// Failure modes: a captured project stamps another project's events, creation
// silently chooses a project, a mixed batch partly commits, native receipts or
// child sessions inherit the wrong project, or direct writes announce one owner.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { UnboundClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeUnboundCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { UnboundEventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceDaemonLayer,
	makePersistenceStoreLayer,
} from "../../../src/lib/persistence/effect/live.js";
import { UnboundProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const evidence: { multiProject?: unknown; typedFailures?: unknown } = {};

afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn-10-2-unbound-persistence.json",
		JSON.stringify(
			{
				bead: "conduit-test-82tn.10.2",
				passed:
					evidence.multiProject !== undefined &&
					evidence.typedFailures !== undefined,
				...evidence,
			},
			null,
			2,
		),
	);
});

describe("unbound daemon persistence", () => {
	it("routes writes, receipts, child sessions and advances by session ownership", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-unbound-persistence-"));
		const runtime = ManagedRuntime.make(
			Layer.merge(
				makePersistenceDaemonLayer({
					sessionEventBusLayer: SessionEventBusLive,
				}),
				SessionEventBusLive,
			).pipe(
				Layer.provideMerge(makePersistenceStoreLayer(join(root, "events.db"))),
			),
		);
		try {
			evidence.multiProject = await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* UnboundEventStoreEffectTag;
						const claude = yield* UnboundClaudeEventPersistEffectTag;
						const state = yield* UnboundProviderStateEffectTag;
						const sql = yield* SqlClient.SqlClient;
						const write = yield* makeUnboundCommitAndSignal;
						for (const projectId of ["alpha", "beta"]) {
							yield* write(
								[
									canonicalEvent("session.created", projectId, {
										sessionId: projectId,
										title: projectId,
										provider: "claude",
									}),
								],
								{ projectId },
							);
							yield* sql`UPDATE sessions SET model_id = 'sonnet', model_provider = 'claude', variant = '', context_window = '' WHERE id = ${projectId}`;
						}
						const single = yield* store.append(
							canonicalEvent("session.renamed", "alpha", {
								sessionId: "alpha",
								title: "Alpha",
							}),
						);
						expect(single.projectId).toBe("alpha");
						const mixed = yield* store.appendBatch(
							["alpha", "beta"].map((sessionId) =>
								canonicalEvent("session.renamed", sessionId, {
									sessionId,
									title: sessionId,
								}),
							),
						);
						expect(mixed.map((event) => event.projectId)).toEqual([
							"alpha",
							"beta",
						]);
						yield* claude.persistEvents(
							["alpha", "beta"].map((sessionId) =>
								canonicalEvent("session.renamed", sessionId, {
									sessionId,
									title: `Updated ${sessionId}`,
								}),
							),
						);
						for (const projectId of ["alpha", "beta"]) {
							yield* claude.persistUserMessage(
								projectId,
								`Hello ${projectId}`,
								{ messageId: `${projectId}-message` },
							);
							yield* state.saveUpdates(projectId, [
								{
									key: "nativeThread:claude",
									value: JSON.stringify({
										resumeSessionId: `${projectId}-native`,
										firstSequence: 0,
										deliveredThrough: 0,
									}),
								},
							]);
							expect(
								(yield* state.nativeThread(projectId, "claude"))?.projectId,
							).toBe(projectId);
							if (projectId === "beta")
								yield* sql`INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
									VALUES ('beta-child', 'claude', 'beta-child-native', 'Unstamped child', 'idle', 'beta', 1, 1)`;
							yield* claude.ensureClaudeSubagentSession({
								childSessionId: `${projectId}-child`,
								parentSessionId: projectId,
								providerSessionId: `${projectId}-child-native`,
								title: "Child",
							});
						}
						const advances =
							yield* (yield* SessionEventBusTag).subscribeAdvances();
						yield* write.write((_project, stamp) =>
							stamp((version) =>
								sql<{
									id: string;
								}>`UPDATE sessions SET title = 'Stamped', version = ${version} WHERE id IN ('alpha', 'beta') RETURNING id`.pipe(
									Effect.map((rows) => rows.map((row) => row.id)),
								),
							),
						);
						const [advance] = yield* advances.pipe(
							Stream.take(1),
							Stream.runCollect,
						);
						expect(advance && [...advance.projectIds].sort()).toEqual([
							"alpha",
							"beta",
						]);
						const sessions = yield* sql<{
							id: string;
							project_id: string;
						}>`SELECT id, project_id FROM sessions ORDER BY id`;
						expect(sessions).toEqual([
							{ id: "alpha", project_id: "alpha" },
							{ id: "alpha-child", project_id: "alpha" },
							{ id: "beta", project_id: "beta" },
							{ id: "beta-child", project_id: "beta" },
						]);
						const stamps = yield* sql<{
							session_id: string;
							project_id: string;
						}>`SELECT DISTINCT session_id, project_id FROM events ORDER BY session_id`;
						expect(stamps).toEqual(
							sessions.map((row) => ({
								session_id: row.id,
								project_id: row.project_id,
							})),
						);
						return {
							sessions,
							eventProjects: stamps,
							directWriteAdvance: advance,
						};
					}),
				),
			);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails unknown ownership through the typed channel and rolls back a mixed batch", async () => {
		const runtime = ManagedRuntime.make(
			makePersistenceDaemonLayer().pipe(
				Layer.provideMerge(makePersistenceStoreLayer(":memory:")),
			),
		);
		try {
			evidence.typedFailures = await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* UnboundEventStoreEffectTag;
					const write = yield* makeUnboundCommitAndSignal;
					const created = (sessionId: string) =>
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: sessionId,
							provider: "claude",
						});
					// result handles typed failures, but a missing Context service defect
					// or an accidental SQL default still fails this assertion.
					const missing = yield* Effect.result(
						store.append(created("unknown")),
					);
					expect(missing).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "EventStoreError",
							operation: "appendOwnership",
							sessionId: "unknown",
						},
					});
					yield* write([created("alpha")], { projectId: "alpha" });
					const before = yield* store.readFromSequence(0);
					const mixed = yield* Effect.result(
						store.appendBatch([
							canonicalEvent("session.renamed", "alpha", {
								sessionId: "alpha",
								title: "Should roll back",
							}),
							created("unknown"),
						]),
					);
					expect(mixed).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "EventStoreError", sessionId: "unknown" },
					});
					const foreign = yield* Effect.result(
						store.append(created("alpha"), "beta"),
					);
					expect(foreign).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "EventStoreError",
							projectId: "beta",
							ownerProjectId: "alpha",
						},
					});
					expect(yield* store.readFromSequence(0)).toEqual(before);
					return {
						unknownSession: missing,
						mixedBatch: mixed,
						foreignOwner: foreign,
						unchangedEventCount: before.length,
					};
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
