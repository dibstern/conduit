// Failure modes: retained descendants contaminate processing/attention; changing
// registration leaves cached rows or versioned readers stale; history is lost.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeDaemonSharedStoreLayer } from "../../../src/lib/domain/daemon/Layers/daemon-shared-store-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	addWithoutRelay,
	has,
	makeProjectRegistryLive,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeSessionRows } from "../../../src/lib/domain/daemon/Services/session-rows.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	makePersistenceProjectLayer,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { SessionRollupProjects } from "../../../src/lib/persistence/effect/session-rollup-projects.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import type { SidebarRow } from "../../../src/lib/persistence/sidebar-row.js";
import type { StoredProject } from "../../../src/lib/types.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

describe("retained child sidebar roll-up", () => {
	it.each([
		"busy",
		"permission",
		"question",
	] as const)("counts a retained %s child only while its project is registered", async (state) => {
		const root = mkdtempSync(join(tmpdir(), "conduit-retained-child-"));
		const project = (slug: string): StoredProject => {
			const folder = join(root, "folders", slug);
			mkdirSync(folder, { recursive: true });
			return { slug, title: slug, folders: [folder] };
		};
		const alpha = project("alpha");
		const retained = project("retained");
		try {
			for (const owner of [alpha, retained]) {
				const filename = join(root, "projects", owner.slug, "events.db");
				mkdirSync(dirname(filename), { recursive: true });
				const source = ManagedRuntime.make(
					makePersistenceEffectLayer(filename, owner.slug),
				);
				try {
					await source.runPromise(
						Effect.gen(function* () {
							const store = yield* EventStoreEffectTag;
							const runner = yield* ProjectionRunnerEffectTag;
							yield* runner.recover();
							const events: CanonicalEvent[] = [
								canonicalEvent("session.created", "parent", {
									sessionId: "parent",
									title: "Idle registered family root",
									provider: "opencode",
								}),
							];
							if (owner === retained) {
								events.push(
									canonicalEvent("session.created", "child", {
										sessionId: "child",
										title: "Retained child",
										provider: "opencode",
										parentId: "parent",
									}),
									state === "busy"
										? canonicalEvent("session.status", "child", {
												sessionId: "child",
												status: "busy",
											})
										: canonicalEvent(`${state}.asked`, "child", {
												id: "child-approval",
												sessionId: "child",
												questions: [],
												toolName: "Bash",
												input: {},
											}),
								);
							}
							yield* runner.projectBatch(yield* store.appendBatch(events));
						}),
					);
				} finally {
					await source.dispose();
				}
			}
			const store = makeDaemonSharedStoreLayer(root, {
				...defaultDaemonConfig(),
				projects: [
					{
						slug: alpha.slug,
						title: alpha.title,
						folders: alpha.folders,
						path: alpha.folders[0],
						addedAt: 1,
					},
				],
			});
			const services = Layer.mergeAll(
				makePersistenceProjectLayer(alpha.slug).pipe(Layer.provideMerge(store)),
				makeProjectRegistryLive([alpha]),
				makeDaemonStateLive({ configDir: root }),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
				Layer.effect(SessionActivityTag, makeSessionActivity),
				Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
				Layer.succeed(RelayCacheTag)({
					get: () => Effect.fail(new Error("No relay needed")),
					peek: () => Effect.succeed(Option.none()),
					invalidate: () => Effect.void,
				}),
			);
			const runtime = ManagedRuntime.make(services);
			try {
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const events = yield* EventStoreEffectTag;
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.recover();
						const writeParentStatus = () =>
							Effect.gen(function* () {
								yield* runner.projectBatch(
									yield* events.appendBatch([
										canonicalEvent("session.status", "parent", {
											sessionId: "parent",
											status: "idle",
										}),
									]),
								);
							});
						const rows = yield* makeSessionRows(alpha);
						const check = (registered: boolean, after?: number) =>
							Effect.gen(function* () {
								const [cached] = yield* sql<{ row: string }>`
										SELECT row FROM session_sidebar WHERE session_id = 'parent'`;
								const sidebar: SidebarRow = JSON.parse(cached?.row ?? "null");
								const list = yield* rows.read();
								const parent = list.rows.find(
									({ item }) => item.id === "parent",
								);
								const full = yield* rows.list({ roots: true });
								const bounded = yield* rows.read({
									familyOf: "parent",
									viewed: "parent",
								});
								expect
									.soft(bounded.rows.map(({ item }) => item.id))
									.toEqual(["parent"]);
								for (const [label, session] of [
									["stored sidebar", sidebar.session],
									["readSessionList", parent?.item],
									["full session list", full.find(({ id }) => id === "parent")],
								] as const) {
									expect.soft(session, label).toBeDefined();
									expect.soft(session?.status, label).toBe("idle");
									expect
										.soft(session?.processing ?? false, label)
										.toBe(registered && state === "busy");
									expect
										.soft(session?.attention, label)
										.toBe(
											!registered
												? "idle"
												: state === "busy"
													? "working"
													: state === "permission"
														? "needs-approval"
														: "needs-reply",
										);
								}
								if (after !== undefined) {
									const delta = yield* rows.read({ after });
									expect
										.soft(delta.rows.map(({ item }) => item.id))
										.toContain("parent");
								}
								return list.version;
							});
						yield* check(false);
						// An ordinary write must keep the imported family scoped, too.
						yield* writeParentStatus();
						const projects = yield* SessionRollupProjects;
						const beforeFailure = yield* sql`SELECT row,
							(SELECT value FROM read_model_counter WHERE id = 1) AS version
							FROM session_sidebar WHERE session_id = 'parent'`;
						yield* sql`CREATE TEMP TRIGGER fail_rollup BEFORE UPDATE ON session_sidebar
							BEGIN SELECT RAISE(ABORT, 'rollup failure'); END`;
						const failed = yield* Effect.exit(addWithoutRelay(retained));
						yield* sql`DROP TRIGGER fail_rollup`;
						expect(failed._tag).toBe("Failure");
						expect
							.soft(projects ? yield* Ref.get(projects) : undefined)
							.toEqual(["alpha"]);
						expect(
							yield* sql`SELECT row,
							(SELECT value FROM read_model_counter WHERE id = 1) AS version
							FROM session_sidebar WHERE session_id = 'parent'`,
						).toEqual(beforeFailure);
						expect
							.soft(
								yield* has(retained.slug),
								"failed registration rolls back registry",
							)
							.toBe(false);
						const retriedRegistration = yield* Effect.exit(
							addWithoutRelay(retained),
						);
						expect
							.soft(retriedRegistration._tag, "registration retry succeeds")
							.toBe("Success");
						yield* check(true);
						yield* remove(retained.slug);
						const initial = yield* check(false);
						yield* addWithoutRelay(retained);
						yield* check(true, initial);
						yield* writeParentStatus();
						const registered = yield* check(true);
						const beforeRemovalFailure = yield* sql`SELECT row,
							(SELECT value FROM read_model_counter WHERE id = 1) AS version
							FROM session_sidebar WHERE session_id = 'parent'`;
						yield* sql`CREATE TEMP TRIGGER fail_rollup BEFORE UPDATE ON session_sidebar
							BEGIN SELECT RAISE(ABORT, 'rollup failure'); END`;
						const failedRemoval = yield* Effect.exit(remove(retained.slug));
						yield* sql`DROP TRIGGER fail_rollup`;
						expect(failedRemoval._tag).toBe("Failure");
						expect
							.soft(
								yield* has(retained.slug),
								"failed removal restores registry",
							)
							.toBe(true);
						expect(projects ? yield* Ref.get(projects) : undefined).toContain(
							retained.slug,
						);
						expect(
							yield* sql`SELECT row,
							(SELECT value FROM read_model_counter WHERE id = 1) AS version
							FROM session_sidebar WHERE session_id = 'parent'`,
						).toEqual(beforeRemovalFailure);
						yield* remove(retained.slug);
						expect(yield* has(retained.slug)).toBe(false);
						expect
							.soft(
								projects ? yield* Ref.get(projects) : undefined,
								"removal retry updates roll-up scope",
							)
							.not.toContain(retained.slug);
						yield* check(false, registered);
						yield* writeParentStatus();
						yield* check(false);
						expect(
							yield* sql`SELECT id, project_id, parent_id FROM sessions ORDER BY id`,
						).toEqual([
							{ id: "child", project_id: "retained", parent_id: "parent" },
							{ id: "parent", project_id: "alpha", parent_id: null },
						]);
						// Leave a cached active family behind. The persisted config still
						// registers only alpha, so the next startup must repair that cache.
						yield* addWithoutRelay(retained);
						yield* check(true);
					}),
				);
			} finally {
				await runtime.dispose();
			}
			const restarted = ManagedRuntime.make(services);
			try {
				await restarted.runPromise(
					Effect.gen(function* () {
						const rows = yield* makeSessionRows(alpha);
						const parent = (yield* rows.read()).rows.find(
							({ item }) => item.id === "parent",
						)?.item;
						expect(parent?.processing ?? false).toBe(false);
						expect(parent?.attention).toBe("idle");
						const events = yield* EventStoreEffectTag;
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.recover();
						yield* runner.projectBatch(
							yield* events.appendBatch([
								canonicalEvent("session.created", "grandchild", {
									sessionId: "grandchild",
									title: "Registered grandchild",
									provider: "opencode",
									parentId: "child",
								}),
								state === "busy"
									? canonicalEvent("session.status", "grandchild", {
											sessionId: "grandchild",
											status: "busy",
										})
									: canonicalEvent(`${state}.asked`, "grandchild", {
											id: "grandchild-approval",
											sessionId: "grandchild",
											questions: [],
											toolName: "Bash",
											input: {},
										}),
							]),
						);
						const checkGrandchild = (active: boolean) =>
							Effect.gen(function* () {
								const cached = (yield* rows.read()).rows.find(
									({ item }) => item.id === "parent",
								)?.item;
								const listed = (yield* rows.list({ roots: true })).find(
									({ id }) => id === "parent",
								);
								for (const [label, root] of [
									["cached ancestry", cached],
									["listed ancestry", listed],
								] as const) {
									expect
										.soft(root?.processing ?? false, label)
										.toBe(active && state === "busy");
									expect
										.soft(root?.attention, label)
										.toBe(
											active
												? state === "busy"
													? "working"
													: state === "permission"
														? "needs-approval"
														: "needs-reply"
												: "idle",
										);
									expect
										.soft(root?.pendingPermissionCount ?? 0, label)
										.toBe(active && state === "permission" ? 1 : 0);
									expect
										.soft(root?.pendingQuestionCount ?? 0, label)
										.toBe(active && state === "question" ? 1 : 0);
								}
							});
						yield* checkGrandchild(true);
						yield* runner.projectBatch(
							yield* events.appendBatch([
								state === "busy"
									? canonicalEvent("session.status", "grandchild", {
											sessionId: "grandchild",
											status: "idle",
										})
									: state === "permission"
										? canonicalEvent("permission.resolved", "grandchild", {
												id: "grandchild-approval",
												decision: "once",
											})
										: canonicalEvent("question.resolved", "grandchild", {
												id: "grandchild-approval",
												answers: {},
											}),
							]),
						);
						yield* checkGrandchild(false);
					}),
				);
			} finally {
				await restarted.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
